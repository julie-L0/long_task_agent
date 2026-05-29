#!/usr/bin/env node
/**
 * 工具层冒烟测试
 * 用法：node scripts/test-tools.js [local|bitable]
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  try {
    const content = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

const arg = process.argv[2];
if (arg === "local" || arg === "bitable") process.env.STORAGE_BACKEND = arg;

const backend = process.env.STORAGE_BACKEND || "local";
console.log(`\n工具层冒烟测试 — backend: ${backend}\n`);

const { executeTool } = await import(resolve(ROOT, "src/tools/index.js"));
const storage = await import(resolve(ROOT, "src/storage/index.js"));

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const cleanup = []; // { collection, id }

async function test(name, fn) {
  process.stdout.write(`  ${name}...`);
  try {
    await fn();
    console.log(" ✅");
    passed++;
  } catch (e) {
    console.log(` ❌\n    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

async function cleanupAll() {
  for (const { collection, id } of cleanup) {
    try { await storage.deleteItem(collection, id); } catch {}
  }
}

const s = Date.now().toString(36);

// ── 1. get_current_time ───────────────────────────────────────────────────────

console.log("── get_current_time ──");

await test("返回时间和时区", async () => {
  const r = await executeTool("get_current_time", {});
  assert(r.current_time, "current_time 缺失");
  assert(r.timezone, "timezone 缺失");
});

// ── 2. task CRUD ──────────────────────────────────────────────────────────────

console.log("\n── tasks ──");

let taskId;

await test("create_task", async () => {
  const r = await executeTool("create_task", {
    title: `[TEST] 工具测试任务 ${s}`,
    category: "work",
    importance: "low",
    urgency: "low",
    notes: "自动测试",
  });
  assert(r.id, "返回无 id");
  assert(r.status === "pending", `status=${r.status}`);
  assert(r.importance === "low", `importance=${r.importance}`);
  taskId = r.id;
  cleanup.push({ collection: "tasks", id: taskId });
});

await test("list_tasks（无 filter）", async () => {
  const r = await executeTool("list_tasks", {});
  assert(Array.isArray(r), "返回非数组");
  assert(r.find((t) => t.id === taskId), "找不到刚创建的任务");
});

await test("list_tasks（filter status=pending）", async () => {
  const r = await executeTool("list_tasks", { status: "pending" });
  assert(Array.isArray(r), "返回非数组");
  assert(r.find((t) => t.id === taskId), "filter pending 找不到任务");
  assert(!r.find((t) => t.status !== "pending"), "filter 混入非 pending 任务");
});

await test("update_task status→in_progress", async () => {
  const r = await executeTool("update_task", { id: taskId, status: "in_progress" });
  assert(!r.error, r.error);
  assert(r.status === "in_progress", `status=${r.status}`);
  assert(r.last_touched_at, "last_touched_at 未更新");
});

await test("update_task notes", async () => {
  const r = await executeTool("update_task", { id: taskId, notes: "已更新备注" });
  assert(!r.error, r.error);
  assert(r.notes === "已更新备注", `notes=${r.notes}`);
});

await test("update_task 不存在的 id", async () => {
  const r = await executeTool("update_task", { id: `nonexistent-${s}`, status: "completed" });
  assert(r.error, "应返回 error");
});

await test("delete_task", async () => {
  const r = await executeTool("delete_task", { id: taskId });
  assert(r.success === true, JSON.stringify(r));
  cleanup.splice(cleanup.findIndex((c) => c.id === taskId), 1);
});

await test("delete_task 不存在的 id", async () => {
  const r = await executeTool("delete_task", { id: `nonexistent-${s}` });
  assert(r.error, "应返回 error");
});

// ── 3. reminders ─────────────────────────────────────────────────────────────

console.log("\n── reminders ──");

let reminderId;

await test("create_reminder", async () => {
  const r = await executeTool("create_reminder", {
    trigger_at: "2099-01-01T09:00:00+08:00",
    message: `[TEST] 测试提醒 ${s}`,
    type: "user_rule",
  });
  assert(r.id, "返回无 id");
  assert(r.status === "pending", `status=${r.status}`);
  reminderId = r.id;
  cleanup.push({ collection: "reminders", id: reminderId });
});

await test("cancel_reminder", async () => {
  const r = await executeTool("cancel_reminder", { id: reminderId });
  assert(!r.error, r.error);
  assert(r.status === "dismissed", `status=${r.status}`);
});

await test("cancel_reminder 不存在的 id", async () => {
  const r = await executeTool("cancel_reminder", { id: `nonexistent-${s}` });
  assert(r.error, "应返回 error");
});

// ── 4. timeline ───────────────────────────────────────────────────────────────

console.log("\n── timeline ──");

let timelineId;

await test("log_timeline", async () => {
  const r = await executeTool("log_timeline", {
    start_time: new Date().toISOString(),
    activity_type: "work",
    source: "user_input",
  });
  assert(r.id, "返回无 id");
  assert(r.activity_type === "work", `activity_type=${r.activity_type}`);
  timelineId = r.id;
  cleanup.push({ collection: "timeline", id: timelineId });
});

// ── 5. projects ───────────────────────────────────────────────────────────────

console.log("\n── projects ──");

await test("create_project 无 confirmed_new → 拒绝", async () => {
  const r = await executeTool("create_project", {
    name: `[TEST] 未确认项目 ${s}`,
    progress_type: "percentage",
    confirmed_new: false,
  });
  assert(r.error, "应拒绝创建");
});

// percentage 项目
let projPercentId;
await test("create_project（percentage）", async () => {
  const r = await executeTool("create_project", {
    name: `[TEST] 百分比项目 ${s}`,
    progress_type: "percentage",
    progress_total: 100,
    progress_unit: "页",
    confirmed_new: true,
  });
  assert(r.id, "返回无 id");
  assert(r.progress_type === "percentage", `progress_type=${r.progress_type}`);
  assert(r.progress_percent === 0, `初始 progress_percent=${r.progress_percent}`);
  projPercentId = r.id;
  cleanup.push({ collection: "projects", id: projPercentId });
});

await test("match_existing_project 能找到", async () => {
  const r = await executeTool("match_existing_project", { keyword: "百分比项目" });
  assert(Array.isArray(r.matches), "matches 非数组");
  assert(r.matches.find((p) => p.id === projPercentId), "找不到刚创建的项目");
});

await test("match_existing_project 无匹配", async () => {
  const r = await executeTool("match_existing_project", { keyword: `不存在关键词${s}` });
  assert(r.matches.length === 0, "应返回空 matches");
});

await test("update_project_progress（percentage +30）", async () => {
  const r = await executeTool("update_project_progress", {
    id: projPercentId,
    delta: 30,
    note: "测试进度",
  });
  assert(!r.error, r.error);
  assert(r.progress_done === 30, `progress_done=${r.progress_done}`);
  assert(r.progress_percent === 30, `progress_percent=${r.progress_percent}`);
});

await test("update_project_progress（percentage +80，上限100%）", async () => {
  const r = await executeTool("update_project_progress", { id: projPercentId, delta: 80 });
  assert(r.progress_percent === 100, `percent 应为100，实为 ${r.progress_percent}`);
});

// streak 项目
let projStreakId;
await test("create_project（streak）", async () => {
  const r = await executeTool("create_project", {
    name: `[TEST] 连击项目 ${s}`,
    progress_type: "streak",
    streak_goal: 30,
    confirmed_new: true,
  });
  assert(r.id, "返回无 id");
  projStreakId = r.id;
  cleanup.push({ collection: "projects", id: projStreakId });
});

await test("update_project_progress（streak checkin x2）", async () => {
  await executeTool("update_project_progress", { id: projStreakId, streak_action: "checkin" });
  const r = await executeTool("update_project_progress", { id: projStreakId, streak_action: "checkin" });
  assert(r.streak_current === 2, `streak_current=${r.streak_current}`);
  assert(r.streak_longest === 2, `streak_longest=${r.streak_longest}`);
  assert(r.streak_total === 2, `streak_total=${r.streak_total}`);
});

await test("update_project_progress（streak break）", async () => {
  const r = await executeTool("update_project_progress", { id: projStreakId, streak_action: "break" });
  assert(r.streak_current === 0, `streak_current 应重置为0，实为 ${r.streak_current}`);
  assert(r.streak_longest === 2, `streak_longest 应保留2，实为 ${r.streak_longest}`);
});

// stage 项目
let projStageId;
await test("create_project（stage）", async () => {
  const r = await executeTool("create_project", {
    name: `[TEST] 阶段项目 ${s}`,
    progress_type: "stage",
    progress_stages: "调研,设计,开发,上线",
    confirmed_new: true,
  });
  assert(r.id, "返回无 id");
  projStageId = r.id;
  cleanup.push({ collection: "projects", id: projStageId });
});

await test("update_project_progress（stage → 第2阶段）", async () => {
  const r = await executeTool("update_project_progress", { id: projStageId, advance_to_stage: 2 });
  assert(r.progress_current_stage === 2, `current_stage=${r.progress_current_stage}`);
  assert(r.progress_percent === 50, `percent 应为50，实为 ${r.progress_percent}`);
});

// checklist 项目
let projCheckId;
await test("create_project（checklist）", async () => {
  const r = await executeTool("create_project", {
    name: `[TEST] 清单项目 ${s}`,
    progress_type: "checklist",
    progress_items: "需求,设计,开发,测试",
    confirmed_new: true,
  });
  assert(r.id, "返回无 id");
  projCheckId = r.id;
  cleanup.push({ collection: "projects", id: projCheckId });
});

await test("update_project_progress（checklist 完成两项）", async () => {
  await executeTool("update_project_progress", { id: projCheckId, check_item: "需求" });
  const r = await executeTool("update_project_progress", { id: projCheckId, check_item: "设计" });
  assert(r.progress_percent === 50, `percent 应为50，实为 ${r.progress_percent}`);
  assert(r.progress_items_done.includes("需求"), "需求未标完成");
  assert(r.progress_items_done.includes("设计"), "设计未标完成");
});

await test("list_projects 只返回 active/paused", async () => {
  const r = await executeTool("list_projects", {});
  assert(Array.isArray(r), "返回非数组");
  assert(!r.find((p) => p.status === "archived"), "archived 项目不应出现");
  assert(r.find((p) => p.id === projPercentId), "active 项目未出现");
});

// ── 6. archive_confirmed ─────────────────────────────────────────────────────

console.log("\n── archive_confirmed ──");

let archiveTaskId;
await test("准备：创建关联任务", async () => {
  // 先创建一个带项目名的任务，后面测试归档时会级联取消
  const proj = await storage.getItem("projects", projPercentId);
  const r = await executeTool("create_task", {
    title: `[TEST] 归档测试关联任务 ${s}`,
    project: proj?.name,
  });
  assert(r.id, "创建失败");
  archiveTaskId = r.id;
  cleanup.push({ collection: "tasks", id: archiveTaskId });
});

await test("archive_confirmed 归档项目（级联取消任务）", async () => {
  const r = await executeTool("archive_confirmed", { project_ids: projPercentId });
  assert(Array.isArray(r.archived), "archived 非数组");
  assert(r.archived.length > 0, "没有归档任何项目");
  assert(r.context_reset === true, "context_reset 应为 true");
  // 确认关联任务被取消
  const task = await storage.getItem("tasks", archiveTaskId);
  assert(task?.status === "cancelled", `任务应被取消，实为 ${task?.status}`);
  cleanup.splice(cleanup.findIndex((c) => c.id === projPercentId), 1);
});

await test("archive_confirmed 归档单个任务", async () => {
  const tmpTask = await executeTool("create_task", {
    title: `[TEST] 直接归档任务 ${s}`,
    category: "life",
  });
  const r = await executeTool("archive_confirmed", { task_ids: tmpTask.id });
  assert(r.archived.length > 0, "没有归档");
  const t = await storage.getItem("tasks", tmpTask.id);
  assert(t?.status === "completed", `status 应为 completed，实为 ${t?.status}`);
  cleanup.push({ collection: "tasks", id: tmpTask.id });
});

// ── 清理 & 汇总 ──────────────────────────────────────────────────────────────

process.stdout.write("\n清理测试数据...");
await cleanupAll();
console.log(" ✅");

console.log(`\n结果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
