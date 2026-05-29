#!/usr/bin/env node
/**
 * 小柳数据分析脚本 — 柳比歇夫时间法视角
 * 用法：node scripts/analyze.js [--export]
 * --export: 同时导出 CSV 到 data/export/
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import { config as loadDotenv } from "dotenv";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });
dayjs.extend(duration);

const EXPORT = process.argv.includes("--export");
const EXPORT_DIR = resolve(__dirname, "../data/export");

// Load storage backend
const { listItems } = await import("../src/storage/index.js");

async function load() {
  const [timeline, tasks, projects, progressLogs] = await Promise.all([
    listItems("timeline"),
    listItems("tasks"),
    listItems("projects"),
    listItems("progress_logs"),
  ]);
  return { timeline, tasks, projects, progressLogs };
}

function fmtMin(min) {
  if (min < 60) return `${Math.round(min)}min`;
  return `${Math.floor(min / 60)}h${Math.round(min % 60)}min`;
}

// ── 1. 每日各类活动时长分布 ──────────────────────────────────────
function analyzeTimeByActivity(timeline) {
  const byDate = {};
  for (const e of timeline) {
    if (!e.start_time || !e.end_time) continue;
    const date = dayjs(e.start_time).format("YYYY-MM-DD");
    const min = dayjs(e.end_time).diff(dayjs(e.start_time), "minute");
    if (min <= 0 || min > 720) continue; // skip bogus entries
    if (!byDate[date]) byDate[date] = {};
    const type = e.activity_type || "other";
    byDate[date][type] = (byDate[date][type] || 0) + min;
  }
  return byDate;
}

// ── 2. 深度工作时长趋势（study/work，未被打断）──────────────────
function analyzeFocusTime(timeline) {
  const byDate = {};
  for (const e of timeline) {
    if (!e.start_time || !e.end_time) continue;
    if (!["study", "work"].includes(e.activity_type)) continue;
    if (e.checkin_status === "interrupted") continue;
    const date = dayjs(e.start_time).format("YYYY-MM-DD");
    const min = dayjs(e.end_time).diff(dayjs(e.start_time), "minute");
    if (min <= 0 || min > 720) continue;
    byDate[date] = (byDate[date] || 0) + min;
  }
  return byDate;
}

// ── 3. 任务拖延分析 ──────────────────────────────────────────────
function analyzeTaskDelay(tasks) {
  const delayed = tasks
    .filter(t => t.status === "completed" && t.hard_deadline && t.updated_at)
    .map(t => {
      const deadline = dayjs(t.hard_deadline);
      const completed = dayjs(t.updated_at);
      const delayDays = completed.diff(deadline, "day");
      return { title: t.title, category: t.category, delayDays, deadline: deadline.format("MM-DD"), completed: completed.format("MM-DD") };
    })
    .sort((a, b) => b.delayDays - a.delayDays);
  return delayed;
}

// ── 4. 项目进度速率 ──────────────────────────────────────────────
function analyzeProjectVelocity(progressLogs, projects) {
  const projectMap = Object.fromEntries(projects.map(p => [p.id, p]));
  const byProject = {};
  for (const log of progressLogs) {
    if (!byProject[log.project_id]) byProject[log.project_id] = [];
    byProject[log.project_id].push(log);
  }
  return Object.entries(byProject).map(([pid, logs]) => {
    const p = projectMap[pid];
    const sorted = logs.sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
    const days = sorted.length > 1
      ? dayjs(sorted.at(-1).logged_at).diff(dayjs(sorted[0].logged_at), "day") || 1
      : 1;
    return {
      name: p?.name || pid,
      logCount: logs.length,
      spanDays: days,
      avgPerDay: (logs.length / days).toFixed(2),
      lastLog: sorted.at(-1)?.logged_at?.slice(0, 10),
    };
  });
}

// ── 5. 最高效时段 ────────────────────────────────────────────────
function analyzeProductiveHours(timeline) {
  const byHour = Array(24).fill(0);
  const countByHour = Array(24).fill(0);
  for (const e of timeline) {
    if (!e.start_time || !e.end_time) continue;
    if (!["study", "work"].includes(e.activity_type)) continue;
    const hour = dayjs(e.start_time).hour();
    const min = dayjs(e.end_time).diff(dayjs(e.start_time), "minute");
    if (min <= 0 || min > 720) continue;
    byHour[hour] += min;
    countByHour[hour]++;
  }
  return byHour.map((min, h) => ({ hour: h, totalMin: min, sessions: countByHour[h] }))
    .filter(h => h.sessions > 0)
    .sort((a, b) => b.totalMin - a.totalMin);
}

// ── 6. 打断模式 ──────────────────────────────────────────────────
function analyzeInterruptions(timeline) {
  const reasons = {};
  let total = 0;
  for (const e of timeline) {
    if (e.checkin_status !== "interrupted") continue;
    total++;
    const r = e.interruption_reason || "未说明";
    reasons[r] = (reasons[r] || 0) + 1;
  }
  return { total, reasons };
}

// ── Print & Export ───────────────────────────────────────────────
function printSection(title, lines) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(50));
  for (const l of lines) console.log(l);
}

function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(h => JSON.stringify(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function exportCsv(name, rows, headers) {
  if (!EXPORT) return;
  if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(resolve(EXPORT_DIR, `${name}.csv`), toCsv(rows, headers), "utf8");
  console.log(`  → exported: data/export/${name}.csv`);
}

// ── Main ─────────────────────────────────────────────────────────
const { timeline, tasks, projects, progressLogs } = await load();

// 1. Activity distribution
const activityByDate = analyzeTimeByActivity(timeline);
const dates = Object.keys(activityByDate).sort();
printSection("每日活动时长分布（最近7天）", []);
for (const date of dates.slice(-7)) {
  const types = activityByDate[date];
  const parts = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, m]) => `${t}:${fmtMin(m)}`);
  console.log(`  ${date}  ${parts.join("  ")}`);
}
const activityRows = dates.flatMap(date =>
  Object.entries(activityByDate[date]).map(([type, min]) => ({ date, type, minutes: Math.round(min) }))
);
exportCsv("activity_by_date", activityRows, ["date", "type", "minutes"]);

// 2. Focus time trend
const focusByDate = analyzeFocusTime(timeline);
const focusDates = Object.keys(focusByDate).sort();
printSection("深度工作时长趋势（最近14天）", []);
for (const date of focusDates.slice(-14)) {
  const min = focusByDate[date];
  const bar = "█".repeat(Math.round(min / 30));
  console.log(`  ${date}  ${fmtMin(min).padEnd(10)} ${bar}`);
}
const weeklyFocus = {};
for (const [date, min] of Object.entries(focusByDate)) {
  const week = dayjs(date).startOf("week").format("YYYY-MM-DD");
  weeklyFocus[week] = (weeklyFocus[week] || 0) + min;
}
console.log("\n  周汇总：");
for (const [week, min] of Object.entries(weeklyFocus).sort()) {
  console.log(`  ${week} 周  ${fmtMin(min)}`);
}
exportCsv("focus_time", focusDates.map(d => ({ date: d, minutes: Math.round(focusByDate[d]) })), ["date", "minutes"]);

// 3. Task delay
const delayed = analyzeTaskDelay(tasks);
printSection("任务拖延分析（已完成任务）", []);
if (!delayed.length) {
  console.log("  暂无已完成且有截止日的任务");
} else {
  for (const t of delayed.slice(0, 10)) {
    const tag = t.delayDays > 0 ? `⚠️ 拖延${t.delayDays}天` : t.delayDays === 0 ? "✓ 准时" : `✓ 提前${-t.delayDays}天`;
    console.log(`  ${tag.padEnd(12)} ${t.title} (ddl:${t.deadline} 完成:${t.completed})`);
  }
}
exportCsv("task_delay", delayed, ["title", "category", "delayDays", "deadline", "completed"]);

// 4. Project velocity
const velocity = analyzeProjectVelocity(progressLogs, projects);
printSection("项目进度速率", []);
for (const v of velocity) {
  console.log(`  ${v.name.padEnd(20)} ${v.logCount}次记录 / ${v.spanDays}天  均${v.avgPerDay}次/天  最近:${v.lastLog}`);
}
exportCsv("project_velocity", velocity, ["name", "logCount", "spanDays", "avgPerDay", "lastLog"]);

// 5. Productive hours
const hours = analyzeProductiveHours(timeline);
printSection("最高效时段（深度工作累计时长）", []);
for (const h of hours.slice(0, 6)) {
  const bar = "█".repeat(Math.round(h.totalMin / 30));
  console.log(`  ${String(h.hour).padStart(2)}:00  ${fmtMin(h.totalMin).padEnd(10)} ${bar}  (${h.sessions}次)`);
}
exportCsv("productive_hours", hours, ["hour", "totalMin", "sessions"]);

// 6. Interruptions
const interruptions = analyzeInterruptions(timeline);
printSection("打断模式", []);
console.log(`  总打断次数：${interruptions.total}`);
for (const [reason, count] of Object.entries(interruptions.reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}次  ${reason}`);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`  数据范围：${timeline.length} 条时间线 / ${tasks.length} 个任务 / ${projects.length} 个项目`);
if (EXPORT) console.log(`  CSV 已导出到 data/export/`);
console.log("─".repeat(50));
