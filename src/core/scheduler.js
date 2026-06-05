import cron from "node-cron";
import dayjs from "dayjs";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as storage from "../storage/index.js";
import { isInterruptible, autoExpire, canSendProactiveNudge, hasOpenFocusEvent } from "./interruptibility.js";
import { normalizeOpenTimelineEvents } from "./timeline.js";
import { shouldTriggerUserRule } from "./rules.js";
import { config } from "./config.js";

let onReminderFired = null;
let getLastMessageAt = () => null;
let getSilenceThresholdMin = () => 60;

export function setReminderHandler(handler) {
  onReminderFired = handler;
}

export function setSilenceDetectionSource(getLastMsg, getThreshold) {
  getLastMessageAt = getLastMsg;
  getSilenceThresholdMin = getThreshold;
}

async function checkReminders() {
  autoExpire();
  const manualDND = !isInterruptible();
  const focusActive = !manualDND && await hasOpenFocusEvent();
  if (manualDND && !focusActive) return; // fully suppressed

  const now = dayjs();
  const reminders = (await storage.listItems("reminders")).filter(r => r.status === "pending");
  let tasks = null;
  if (focusActive) tasks = await storage.listItems("tasks");

  for (const reminder of reminders) {
    const triggerAt = dayjs(reminder.trigger_at);
    if (now.isAfter(triggerAt) || now.isSame(triggerAt)) {
      if (focusActive) {
        const task = reminder.task_id ? (tasks || []).find(t => t.id === reminder.task_id) : null;
        if (!task || task.urgency !== "high") continue; // only high-urgency penetrates focus
      }
      if (reminder.repeat_until_confirmed) {
        const lastFired = reminder.last_fired_at ? dayjs(reminder.last_fired_at) : null;
        if (lastFired && now.diff(lastFired, "minute") < 5) continue;
        await storage.updateItem("reminders", reminder.id, { last_fired_at: now.toISOString() });
      } else {
        await storage.updateItem("reminders", reminder.id, { status: "fired" });
      }
      console.log(`[scheduler] reminder fired: "${reminder.message}" (${reminder.id})`);
      if (onReminderFired) onReminderFired(reminder);
    }
  }
}

// urgency × importance priority score (higher = more urgent)
function priorityScore(task) {
  const u = task.urgency === "high" ? 2 : task.urgency === "medium" ? 1 : 0;
  const i = task.importance === "high" ? 2 : task.importance === "medium" ? 1 : 0;
  return u * 3 + i; // urgency slightly weighted higher
}

async function checkUserRules() {
  autoExpire();
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const today = now.format("YYYY-MM-DD");
  const rules = (await storage.listItems("user_rules")).filter((r) => r.status === "active" && r.trigger_condition !== "persona");

  for (const rule of rules) {
    if (!shouldTriggerUserRule(rule, now)) continue;

    await storage.updateItem("user_rules", rule.id, {
      last_triggered_date: today,
      last_fired_at: now.toISOString(),
    });

    if (onReminderFired) {
      onReminderFired({
        id: rule.id,
        type: "user_rule",
        message: rule.message,
        rule_name: rule.name,
        persistence: rule.persistence,
        stop_condition: rule.stop_condition,
      });
    }
  }
}

let lastSilenceCheckAt = null;
const SILENCE_CHECK_COOLDOWN_MIN = 30;

const NUDGE_HISTORY_FILE = resolve(config.dataDir, "nudge-history.json");

function loadNudgeHistory() {
  if (!existsSync(NUDGE_HISTORY_FILE)) return {};
  try { return JSON.parse(readFileSync(NUDGE_HISTORY_FILE, "utf8")); }
  catch { return {}; }
}

// Map 兼容接口，reads/writes 直接持久化到文件
const nudgeMemory = {
  _cache: null,
  _data() { if (!this._cache) this._cache = loadNudgeHistory(); return this._cache; },
  get(key) { return this._data()[key]; },
  set(key, value) { this._data()[key] = value; writeFileSync(NUDGE_HISTORY_FILE, JSON.stringify(this._data(), null, 2), "utf8"); },
};

function recentlyNudged(key, now = dayjs(), cooldownMin = 240) {
  const last = nudgeMemory.get(key);
  if (!last) return false;
  return now.diff(dayjs(last), "minute") < cooldownMin;
}

function markNudged(key, now = dayjs()) {
  nudgeMemory.set(key, now.toISOString());
}

export function isTaskAvailableForNudge(task, now = dayjs()) {
  if (!task.start_time || !dayjs(task.start_time).isValid()) return true;
  return !dayjs(task.start_time).isAfter(now);
}

async function hasActiveTimer() {
  const timeline = await normalizeOpenTimelineEvents(await storage.listItems("timeline"));
  return timeline.some((e) => !e.end_time && e.related_task_id);
}

async function checkSilence() {
  autoExpire();
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  if (await hasActiveTimer()) return; // user is in a timed session, don't interrupt

  const lastMsg = getLastMessageAt();
  if (!lastMsg) return;

  const silentMin = now.diff(dayjs(lastMsg), "minute");
  const threshold = getSilenceThresholdMin();
  if (silentMin < threshold) return;

  if (lastSilenceCheckAt && now.diff(dayjs(lastSilenceCheckAt), "minute") < SILENCE_CHECK_COOLDOWN_MIN) return;
  lastSilenceCheckAt = now.toISOString();

  const prompt = `用户已经 ${silentMin} 分钟没有消息。请用一句话问用户在忙什么；用户回答后只调用 log_timeline 记录当前活动。不要根据 activity_type 自动设置免打扰，不要追问结束时间；只有用户明确要求免打扰、计时或提醒时，才调用 set_interruptibility 或 create_reminder。`;

  if (onReminderFired) {
    onReminderFired({ id: "silence-check", type: "silence_check", message: prompt });
  }
}

async function checkExpectedNextAction() {
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  const all = await normalizeOpenTimelineEvents(await storage.listItems("timeline"));
  // work/commute 类活动持续时间本来就长，不适合用 90 分钟阈值来追问
  const LONG_ACTIVITY_TYPES = new Set(["work", "commute", "travel"]);

  const openWithNext = all.filter(
    (e) => !e.end_time && e.expected_next_action && !e.next_action_notified
      && !LONG_ACTIVITY_TYPES.has(e.activity_type)
  );

  for (const event of openWithNext) {
    const start = dayjs(event.start_time);
    const elapsed = now.diff(start, "minute");
    // Only nudge if event has been open for more than 30 min past any estimated duration
    // or simply open for > 90 min with no end
    if (elapsed < 90) continue;

    if (onReminderFired) {
      onReminderFired({
        id: `next-action-${event.id}`,
        type: "project_nudge",
        message: `你之前说做完「${event.current_active_task || event.activity_type}」后要：${event.expected_next_action}。现在做了吗？`,
      });
    }
    // Mark as notified to avoid repeat (store end_time won't work, use a flag)
    await storage.updateItem("timeline", event.id, { next_action_notified: true });
  }
}

let lastDeferrableCheckAt = null;
const DEFERRABLE_CHECK_COOLDOWN_MIN = 90;

async function checkDeferrableOpportunity() {
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  if (await hasActiveTimer()) return; // user is in a timed session

  if (lastDeferrableCheckAt && now.diff(dayjs(lastDeferrableCheckAt), "minute") < DEFERRABLE_CHECK_COOLDOWN_MIN) return;

  const endOfWeek = now.endOf("week");
  const tasks = (await storage.listItems("tasks")).filter(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      isTaskAvailableForNudge(t, now) &&
      t.execution_mode === "deferrable" &&
      (
        // 今天截止（hard）
        (t.hard_deadline && dayjs(t.hard_deadline).isSame(now, "day")) ||
        // 本周内截止（hard 或 flexible）
        (t.hard_deadline && dayjs(t.hard_deadline).isBefore(endOfWeek)) ||
        (t.flexible_deadline && dayjs(t.flexible_deadline).isBefore(endOfWeek))
      )
  );

  if (!tasks.length) return;

  const isToday = (task) => task.hard_deadline && dayjs(task.hard_deadline).isSame(now, "day") ? 1 : 0;
  tasks.sort((a, b) => (isToday(b) - isToday(a)) || (priorityScore(b) - priorityScore(a)));
  const top = tasks.find((task) => !recentlyNudged(`deferrable:${task.id}`, now, 240));
  if (!top) return;

  lastDeferrableCheckAt = now.toISOString();
  markNudged(`deferrable:${top.id}`, now);
  const restCount = tasks.filter((task) => task.id !== top.id).length;
  const rest = restCount ? `（还有 ${restCount} 项本周要做）` : "";
  const ddlTag = top.hard_deadline && dayjs(top.hard_deadline).isSame(now, "day") ? "今天截止，" : "";

  if (onReminderFired) {
    onReminderFired({
      id: "deferrable-nudge",
      type: "project_nudge",
      message: `你现在有空，「${top.title}」${ddlTag}现在处理吗？${rest}`,
    });
  }
}

let lastStaleCheckAt = null;
const STALE_CHECK_COOLDOWN_MIN = 240; // 4小时内不重复推同一批

async function checkStaleProjects() {
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  if (lastStaleCheckAt && now.diff(dayjs(lastStaleCheckAt), "minute") < STALE_CHECK_COOLDOWN_MIN) return;

  const projects = (await storage.listItems("projects")).filter(
    (p) => p.status === "active"
  );
  const staleProjects = [];
  for (const p of projects) {
    const lastProgress = dayjs(p.last_progress_at || p.created_at);
    if (now.diff(lastProgress, "hour") >= 24) {
      staleProjects.push(p);
    }
  }

  const tasks = (await storage.listItems("tasks")).filter(
    (t) => (t.status === "pending" || t.status === "in_progress") && isTaskAvailableForNudge(t, now)
  );
  const staleTasks = [];
  const expiringTasks = [];
  for (const task of tasks) {
    const lastTouched = dayjs(task.last_touched_at || task.created_at);
    if (
      task.hard_deadline &&
      dayjs(task.hard_deadline).isSame(now, "day") &&
      hour >= 20 &&
      !recentlyNudged(`expiring:${task.id}`, now, STALE_CHECK_COOLDOWN_MIN)
    ) {
      expiringTasks.push(task);
      continue;
    }
    if (now.diff(lastTouched, "hour") >= 24 && !recentlyNudged(`stale-task:${task.id}`, now, STALE_CHECK_COOLDOWN_MIN)) {
      staleTasks.push(task);
    }
  }

  if (expiringTasks.length) {
    expiringTasks.sort((a, b) => priorityScore(b) - priorityScore(a));
    const list = expiringTasks.map((t) => `「${t.title}」`).join("、");
    for (const task of expiringTasks) markNudged(`expiring:${task.id}`, now);
    lastStaleCheckAt = now.toISOString();
    if (onReminderFired) {
      onReminderFired({
        id: "expiring-nudge",
        type: "project_nudge",
        message: `${list} 今天截止，现在已经晚上了。现在做还是挪到明天？`,
      });
    }
    return;
  }

  if (!staleProjects.length && !staleTasks.length) return;

  lastStaleCheckAt = now.toISOString();
  for (const task of staleTasks) markNudged(`stale-task:${task.id}`, now);

  staleTasks.sort((a, b) => priorityScore(b) - priorityScore(a));

  const parts = [];
  if (staleTasks.length) {
    parts.push(
      `任务：${staleTasks
        .map((t) => {
          const score = priorityScore(t);
          const tag = score >= 5 ? "🔴" : score >= 3 ? "🟡" : "⚪";
          return `${tag}「${t.title}」`;
        })
        .join("、")}`
    );
  }
  if (staleProjects.length) {
    parts.push(`长期项目：${staleProjects.map((p) => `「${p.name}」(${p.progress_percent}%)`).join("、")}`);
  }

  if (onReminderFired) {
    onReminderFired({
      id: "system-nudge",
      type: "project_nudge",
      message: `以下超过24小时没推进了：\n${parts.join("\n")}\n现在有空处理吗？`,
    });
  }
}

let lastQuotaCheckAt = null;
const QUOTA_CHECK_COOLDOWN_MIN = 90;

async function checkDailyQuota() {
  if (!await canSendProactiveNudge()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  if (lastQuotaCheckAt && now.diff(dayjs(lastQuotaCheckAt), "minute") < QUOTA_CHECK_COOLDOWN_MIN) return;

  const today = now.format("YYYY-MM-DD");
  const projects = (await storage.listItems("projects")).filter(
    (p) => p.status === "active" && p.progress_type === "streak" && p.daily_quota
  );

  const pending = projects.filter((p) => {
    const dailyDone = p.daily_reset_date === today ? (p.daily_done || 0) : 0;
    return dailyDone < p.daily_quota;
  });

  if (!pending.length) return;

  lastQuotaCheckAt = now.toISOString();
  const top = pending[0];
  const today2 = top.daily_reset_date === today ? (top.daily_done || 0) : 0;

  if (onReminderFired) {
    onReminderFired({
      id: `quota-nudge-${top.id}`,
      type: "project_nudge",
      message: `「${top.name}」今天还差 ${top.daily_quota - today2} 次，现在来一个？（${today2}/${top.daily_quota}）`,
    });
  }
}

async function checkFocusExit() {
  if (!isInterruptible()) return; // manual DND, not focus mode

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  const items = await storage.listItems("timeline");
  const recentlyClosed = items.find(e =>
    e.focus_mode === true &&
    e.end_time &&
    !e.exit_summary_sent &&
    now.diff(dayjs(e.end_time), "minute") < 6
  );
  if (!recentlyClosed) return;

  await storage.updateItem("timeline", recentlyClosed.id, { exit_summary_sent: true });

  if (onReminderFired) {
    onReminderFired({
      id: `focus-exit-${recentlyClosed.id}`,
      type: "focus_exit",
      message: "[系统触发] 用户刚结束专注模式。请汇总当前待处理事项：今天截止的任务、高优先级待办、24小时未推进的项目、未完成的每日配额。用自然语言简洁呈现（不超过4条），结尾可问用户接下来打算做什么，不要逐条追问。",
    });
  }
}

async function checkStreakBreaks() {
  const now = dayjs();
  const yesterday = now.subtract(1, "day").format("YYYY-MM-DD");
  const projects = (await storage.listItems("projects")).filter(
    (p) => p.status === "active" && p.progress_type === "streak" && (p.streak_current || 0) > 0
  );
  for (const p of projects) {
    // For daily_quota projects: check daily_reset_date (more reliable than last_progress_at)
    if (p.daily_quota) {
      if (p.daily_reset_date && p.daily_reset_date >= yesterday) continue; // active yesterday or today
    }
    if (!p.last_progress_at) continue;
    const lastDate = dayjs(p.last_progress_at).format("YYYY-MM-DD");
    if (lastDate < yesterday) {
      await storage.updateItem("projects", p.id, { streak_current: 0 });
      console.log(`[scheduler] streak broken for project "${p.name}"`);
    }
  }
}

export function startScheduler() {
  cron.schedule("* * * * *", checkReminders);
  cron.schedule("* * * * *", checkUserRules);
  cron.schedule("* * * * *", checkSilence);   // every minute so threshold is accurate
  cron.schedule("*/5 * * * *", checkDeferrableOpportunity);
  cron.schedule("*/5 * * * *", checkDailyQuota);
  cron.schedule("*/5 * * * *", checkFocusExit);
  cron.schedule("0 * * * *", checkStaleProjects);
  cron.schedule("0 * * * *", checkExpectedNextAction);
  cron.schedule("1 0 * * *", checkStreakBreaks);  // daily at 00:01
  console.log("[scheduler] 已启动，每分钟检查提醒/规则/沉默，每小时检查长期任务和下一步动作");
}
