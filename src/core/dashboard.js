import dayjs from "dayjs";
import * as storage from "../storage/index.js";
import { normalizeOpenTimelineEvents, OPEN_TIMELINE_MAX_MIN } from "./timeline.js";
import { formatRuleSchedule, isDailyRule, ruleOccurrencesInRange } from "./rules.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfWeek(date) {
  const d = dayjs(date).startOf("day");
  const day = d.day() || 7;
  return d.subtract(day - 1, "day");
}

function isToday(value, now = dayjs()) {
  return value && dayjs(value).isValid() && dayjs(value).isSame(now, "day");
}

function isThisWeekNotToday(value, now = dayjs()) {
  if (!value || !dayjs(value).isValid() || isToday(value, now)) return false;
  const start = startOfWeek(now);
  const end = start.add(6, "day").endOf("day");
  const d = dayjs(value);
  return (d.isAfter(start) || d.isSame(start)) && (d.isBefore(end) || d.isSame(end));
}

function dayLabel(value) {
  const d = dayjs(value);
  return `${d.format("M月D日")} ${WEEKDAYS[d.day()]}`;
}

function timeLabel(value) {
  return value && dayjs(value).isValid() ? dayjs(value).format("HH:mm") : null;
}

function priorityIcon(task) {
  if (task.status === "completed") return "✓";
  if (task.status === "in_progress") return "▶";
  if (task.urgency === "high") return "🔴";
  if (task.urgency === "low") return "⚪";
  return "🟡";
}

function taskDate(task) {
  return task.hard_deadline || task.start_time || task.flexible_deadline || null;
}

function taskLine(task, date, withDate = false) {
  const parts = [];
  if (withDate && date) parts.push(dayLabel(date));
  parts.push(priorityIcon(task));
  const t = timeLabel(task.start_time || date);
  if (t) parts.push(t);
  parts.push(task.title);
  if (task.estimated_duration_min) parts.push(`(${task.estimated_duration_min}min)`);
  if (task.flexible_deadline && !task.hard_deadline) parts.push("[弹性]");
  return parts.join(" ");
}

function reminderLine(reminder, withDate = false) {
  const parts = [];
  if (withDate) parts.push(dayLabel(reminder.trigger_at));
  parts.push("⏰");
  const t = timeLabel(reminder.trigger_at);
  if (t) parts.push(t);
  parts.push(reminder.message);
  return parts.join(" ");
}

function ruleLine(occurrence, withDate = false) {
  const parts = [];
  if (withDate) parts.push(dayLabel(occurrence.trigger_at));
  parts.push("⏰");
  const t = timeLabel(occurrence.trigger_at);
  if (t) parts.push(t);
  parts.push(occurrence.rule.message || occurrence.rule.name);
  return parts.join(" ");
}

function recurringRuleLine(rule) {
  const schedule = formatRuleSchedule(rule);
  if (!schedule) return null;
  return `🔁 ${schedule} ${rule.message || rule.name}`;
}

function eventLine(event) {
  const startedAt = dayjs(event.start_time);
  const elapsed = Math.max(0, Math.min(dayjs().diff(startedAt, "minute"), OPEN_TIMELINE_MAX_MIN));
  const title = event.current_active_task || event.activity_type || "当前事件";
  return `▶ ${startedAt.format("HH:mm")} ${title}（进行中 ${elapsed}min）`;
}

function sortByDate(a, b) {
  return new Date(a.date || 0) - new Date(b.date || 0);
}

export async function buildDashboard() {
  const [tasks, projects, reminders, rawTimeline, rules] = await Promise.all([
    storage.listItems("tasks"),
    storage.listItems("projects"),
    storage.listItems("reminders"),
    storage.listItems("timeline"),
    storage.listItems("user_rules"),
  ]);
  const timeline = await normalizeOpenTimelineEvents(rawTimeline).catch(() => rawTimeline);
  const now = dayjs();

  const todayItems = [];
  const weekItems = [];
  const recurringItems = [];
  const floatingItems = [];
  const activeTaskStatuses = new Set(["pending", "in_progress"]);
  // On weekends (sat/sun), show remainder of this weekend + next Mon-Fri
  // On weekdays, show Mon-Sun of current week
  const dow = now.day(); // 0=sun,6=sat
  const isWeekend = dow === 0 || dow === 6;
  let weekDisplayStart, weekDisplayEnd;
  if (isWeekend) {
    weekDisplayStart = now.startOf("day").add(1, "day"); // tomorrow
    if (dow === 6) weekDisplayEnd = now.startOf("day").add(6, "day").endOf("day"); // sat → next fri (sun+mon~fri)
    if (dow === 0) weekDisplayEnd = now.startOf("day").add(5, "day").endOf("day"); // sun → next fri (mon~fri)
  } else {
    weekDisplayStart = startOfWeek(now);
    weekDisplayEnd = weekDisplayStart.add(6, "day").endOf("day");
  }
  const weekStart = weekDisplayStart;
  const weekEnd = weekDisplayEnd;
  const weekLabel = isWeekend ? (dow === 6 ? "本周日+下周一至周五" : "下周一至周五") : "周一至周日";

  for (const event of timeline.filter((e) => e.start_time && !e.end_time)) {
    if (isToday(event.start_time, now)) {
      todayItems.push({ date: event.start_time, line: eventLine(event) });
    }
  }

  function isInWeekRange(value) {
    if (!value || !dayjs(value).isValid() || isToday(value, now)) return false;
    const d = dayjs(value);
    return (d.isSame(weekStart, "day") || d.isAfter(weekStart)) && (d.isSame(weekEnd, "day") || d.isBefore(weekEnd));
  }

  // Collect rule occurrences first so we can dedup against tasks by title
  const ruleOccurrencesToday = []; // { occurrence, rule }
  const ruleOccurrencesWeek = [];
  for (const rule of rules.filter((r) => r.status === "active" && r.trigger_condition !== "persona" && r.trigger_condition !== "rulebook")) {
    if (isDailyRule(rule)) {
      const line = recurringRuleLine(rule);
      if (line) recurringItems.push(line);
      continue;
    }
    for (const occurrence of ruleOccurrencesInRange(rule, weekStart, weekEnd, now)) {
      if (isToday(occurrence.trigger_at, now)) {
        ruleOccurrencesToday.push(occurrence);
      } else if (isInWeekRange(occurrence.trigger_at)) {
        ruleOccurrencesWeek.push(occurrence);
      }
    }
  }

  // Task titles that appear in today/week (to dedup rules with same name)

  const taskTitlesToday = new Set();
  const taskTitlesWeek = new Set();
  for (const task of tasks) {
    const date = taskDate(task);
    const active = activeTaskStatuses.has(task.status);
    if (active && (isToday(date, now) || task.status === "in_progress")) {
      taskTitlesToday.add(task.title);
      todayItems.push({ date: date || task.updated_at || now.toISOString(), line: taskLine(task, date || now.toISOString()) });
    } else if (active && isInWeekRange(date)) {
      taskTitlesWeek.add(task.title);
      weekItems.push({ date, line: taskLine(task, date, true) });
    } else if (active && !date) {
      floatingItems.push(taskLine(task, null));
    }
  }

  // Rule occurrences: skip if a task with same title already covers it
  for (const occurrence of ruleOccurrencesToday) {
    const title = occurrence.rule.message || occurrence.rule.name;
    if (!taskTitlesToday.has(title)) {
      todayItems.push({ date: occurrence.trigger_at, line: ruleLine(occurrence) });
    }
  }
  for (const occurrence of ruleOccurrencesWeek) {
    const title = occurrence.rule.message || occurrence.rule.name;
    if (!taskTitlesWeek.has(title)) {
      weekItems.push({ date: occurrence.trigger_at, line: ruleLine(occurrence, true) });
    }
  }

  const activeTaskIds = new Set(tasks.filter((t) => activeTaskStatuses.has(t.status)).map((t) => t.id));
  for (const reminder of reminders.filter((r) => r.status === "pending" && r.trigger_at && (!r.task_id || !activeTaskIds.has(r.task_id)))) {
    if (isToday(reminder.trigger_at, now)) {
      todayItems.push({ date: reminder.trigger_at, line: reminderLine(reminder) });
    } else if (isInWeekRange(reminder.trigger_at)) {
      weekItems.push({ date: reminder.trigger_at, line: reminderLine(reminder, true) });
    }
  }

  const weekLabel2 = isWeekend ? (dow === 6 ? "本周日+下周一至周五" : "下周一至周五") : "周一至周日";
  const lines = [`📅 ${now.format("M月D日")} ${WEEKDAYS[now.day()]}  ${now.format("HH:mm")}`];

  if (todayItems.length) {
    lines.push("", "📋 今日待办", ...todayItems.sort(sortByDate).map((item) => item.line));
  }

  if (weekItems.length) {
    lines.push("", `📋 本周待办（${weekLabel2}）`, ...weekItems.sort(sortByDate).map((item) => item.line));
  }

  if (recurringItems.length) {
    lines.push("", "🔁 重复提醒", ...[...new Set(recurringItems)].sort());
  }

  const checkinProjects = projects.filter((p) => p.status === "active" && p.progress_type === "streak");
  if (checkinProjects.length) {
    lines.push("", "💧 今日打卡");
    const today = now.format("YYYY-MM-DD");
    for (const p of checkinProjects) {
      if (p.daily_quota) {
        const done = p.daily_reset_date === today ? Number(p.daily_done || 0) : 0;
        const quota = Number(p.daily_quota || 0);
        const bar = quota > 0 ? `${"█".repeat(Math.min(done, quota))}${"░".repeat(Math.max(quota - done, 0))}` : "";
        lines.push(`${p.name}  ${bar}  ${done}/${quota}`);
      } else {
        lines.push(`${p.name}  ✓  连续 Day${p.streak_current || 0}`);
      }
    }
  }

  const activeProjects = projects.filter((p) => p.status === "active");
  if (activeProjects.length) {
    lines.push("", "📊 长期项目");
    for (const p of activeProjects.sort((a, b) => new Date(a.last_progress_at || a.created_at || 0) - new Date(b.last_progress_at || b.created_at || 0))) {
      const staleDays = p.last_progress_at ? now.diff(dayjs(p.last_progress_at), "day") : now.diff(dayjs(p.created_at), "day");
      let progress = `${p.progress_percent || 0}%`;
      if (p.progress_type === "stage") {
        const stages = String(p.progress_stages || "").split(",").filter(Boolean);
        const current = Number(p.progress_current_stage || 0);
        const currentName = stages[current - 1] ? `「${stages[current - 1]}」` : "";
        progress = `阶段 ${current}/${stages.length || "?"}${currentName}`;
      } else if (p.progress_type === "checklist") {
        const total = String(p.progress_items || "").split(",").filter(Boolean).length;
        const done = String(p.progress_items_done || "").split(",").filter(Boolean).length;
        progress = `清单 ${done}/${total || "?"}`;
      }
      lines.push(`${p.name}  ${progress}  已 ${Math.max(staleDays, 0)} 天未推进`);
    }
  }

  if (floatingItems.length) {
    lines.push("", "📋 其他待办", ...floatingItems);
  }

  const needs = tasks.filter((task) => activeTaskStatuses.has(task.status)).filter((task) => {
    if (task.hard_deadline && dayjs(task.hard_deadline).isBefore(now)) return true;
    const touchedAt = task.last_touched_at || task.updated_at || task.created_at;
    return touchedAt && now.diff(dayjs(touchedAt), "day") >= 7;
  });
  if (needs.length) {
    lines.push("", "⚠️ 需要处理");
    for (const task of needs) {
      if (task.hard_deadline && dayjs(task.hard_deadline).isBefore(now)) {
        lines.push(`「${task.title}」截止已过`);
      } else {
        lines.push(`「${task.title}」已 7 天未推进`);
      }
    }
  }

  if (lines.length === 1) {
    lines.push("", "当前没有待办、提醒或进行中事件。");
  }

  return lines.join("\n");
}
