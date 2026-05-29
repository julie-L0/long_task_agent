import cron from "node-cron";
import dayjs from "dayjs";
import * as storage from "../storage/index.js";
import { isInterruptible, autoExpire } from "./interruptibility.js";

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
  autoExpire(); // reset dnd_until_time if expired

  const now = dayjs();
  const reminders = (await storage.listItems("reminders")).filter(r => r.status === "pending");

  for (const reminder of reminders) {
    const triggerAt = dayjs(reminder.trigger_at);
    if (now.isAfter(triggerAt) || now.isSame(triggerAt)) {
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

// Parse "daily:HH:mm" or "weekly:mon,wed,fri:HH:mm"
function shouldTriggerRule(rule, now) {
  const today = now.format("YYYY-MM-DD");
  const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const todayName = dayNames[now.day()];

  const parts = rule.trigger_condition.split(":");
  const type = parts[0]; // "daily" or "weekly"

  let triggerTime; // "HH:mm"
  if (type === "daily") {
    triggerTime = parts[1]; // e.g. "23:00"
  } else if (type === "weekly") {
    const days = parts[1].split(","); // e.g. ["mon","wed","fri"]
    if (!days.includes(todayName)) return false;
    triggerTime = parts[2]; // e.g. "09:00"
  } else {
    return false;
  }

  const [hh, mm] = triggerTime.split(":").map(Number);
  const triggerMoment = now.startOf("day").add(hh, "hour").add(mm || 0, "minute");
  if (now.isBefore(triggerMoment)) return false; // time hasn't come yet

  // New day: hasn't triggered today
  if (rule.last_triggered_date !== today) return true;

  // Same day + persistence: repeat if interval passed and not confirmed today
  if (rule.persistence && rule.stop_condition === "user_confirms") {
    const confirmedToday = rule.confirmed_at && rule.confirmed_at.startsWith(today);
    if (confirmedToday) return false;
    const lastFired = rule.last_fired_at ? dayjs(rule.last_fired_at) : null;
    if (!lastFired) return true;
    return now.diff(lastFired, "minute") >= (rule.repeat_interval_min ?? 15);
  }

  return false; // once type, already triggered today
}

async function checkUserRules() {
  const now = dayjs();
  const today = now.format("YYYY-MM-DD");
  const rules = (await storage.listItems("user_rules")).filter((r) => r.status === "active" && r.trigger_condition !== "persona");

  for (const rule of rules) {
    if (!shouldTriggerRule(rule, now)) continue;

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
      });
    }
  }
}

let lastSilenceCheckAt = null;
const SILENCE_CHECK_COOLDOWN_MIN = 30;

async function checkSilence() {
  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  const lastMsg = getLastMessageAt();
  if (!lastMsg) return;

  const silentMin = now.diff(dayjs(lastMsg), "minute");
  const threshold = getSilenceThresholdMin();
  if (silentMin < threshold) return;

  if (lastSilenceCheckAt && now.diff(dayjs(lastSilenceCheckAt), "minute") < SILENCE_CHECK_COOLDOWN_MIN) return;
  lastSilenceCheckAt = now.toISOString();

  const state = isInterruptible();
  const prompt = state
    ? `用户已经 ${silentMin} 分钟没有消息。请用一句话问用户在干嘛，根据回答调用 log_timeline 记录当前活动，并根据活动类型调用 set_interruptibility（work/meeting→dnd_until_user_confirms，rest/entertainment→open）。`
    : `用户已经 ${silentMin} 分钟没有消息，且当前处于免打扰状态。请问用户"还在忙吗？"，如果用户说结束了，调用 set_interruptibility(open)；如果还在忙，不做任何操作。`;

  if (onReminderFired) {
    onReminderFired({ id: "silence-check", type: "silence_check", message: prompt });
  }
}

async function checkExpectedNextAction() {
  if (!isInterruptible()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  const all = await storage.listItems("timeline");
  const openWithNext = all.filter(
    (e) => !e.end_time && e.expected_next_action
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
    await storage.updateItem("timeline", event.id, { expected_next_action: null });
  }
}

let lastDeferrableCheckAt = null;
const DEFERRABLE_CHECK_COOLDOWN_MIN = 90;

async function checkDeferrableOpportunity() {
  if (!isInterruptible()) return;

  const now = dayjs();
  const hour = now.hour();
  if (hour < 8 || hour >= 23) return;

  if (lastDeferrableCheckAt && now.diff(dayjs(lastDeferrableCheckAt), "minute") < DEFERRABLE_CHECK_COOLDOWN_MIN) return;

  const endOfWeek = now.endOf("week");
  const tasks = (await storage.listItems("tasks")).filter(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
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

  lastDeferrableCheckAt = now.toISOString();
  const isToday = (task) => task.hard_deadline && dayjs(task.hard_deadline).isSame(now, "day") ? 1 : 0;
  tasks.sort((a, b) => (isToday(b) - isToday(a)) || (priorityScore(b) - priorityScore(a)));
  const top = tasks[0];
  const rest = tasks.length > 1 ? `（还有 ${tasks.length - 1} 项本周要做）` : "";
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
  if (!isInterruptible()) return;

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
    (t) => t.status === "pending" || t.status === "in_progress"
  );
  const staleTasks = [];
  const expiringTasks = [];
  for (const task of tasks) {
    const lastTouched = dayjs(task.last_touched_at || task.created_at);
    if (task.hard_deadline && dayjs(task.hard_deadline).isSame(now, "day") && hour >= 20) {
      expiringTasks.push(task);
      continue;
    }
    if (now.diff(lastTouched, "hour") >= 24) {
      staleTasks.push(task);
    }
  }

  if (expiringTasks.length) {
    expiringTasks.sort((a, b) => priorityScore(b) - priorityScore(a));
    const list = expiringTasks.map((t) => `「${t.title}」`).join("、");
    if (onReminderFired) {
      onReminderFired({
        id: "expiring-nudge",
        type: "project_nudge",
        message: `${list} 今天截止，现在已经晚上了。现在做还是挪到明天？`,
      });
    }
  }

  if (!staleProjects.length && !staleTasks.length) return;

  lastStaleCheckAt = now.toISOString();

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
  if (!isInterruptible()) return;

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

async function checkStreakBreaks() {
  const now = dayjs();
  const yesterday = now.subtract(1, "day").format("YYYY-MM-DD");
  const projects = (await storage.listItems("projects")).filter(
    (p) => p.status === "active" && p.progress_type === "streak" && (p.streak_current || 0) > 0
  );
  for (const p of projects) {
    if (!p.last_progress_at) continue;
    const lastDate = dayjs(p.last_progress_at).format("YYYY-MM-DD");
    // If last checkin was before yesterday, streak is broken
    if (lastDate < yesterday) {
      await storage.updateItem("projects", p.id, { streak_current: 0, daily_done: 0, daily_reset_date: null });
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
  cron.schedule("0 * * * *", checkStaleProjects);
  cron.schedule("0 * * * *", checkExpectedNextAction);
  cron.schedule("1 0 * * *", checkStreakBreaks);  // daily at 00:01
  console.log("[scheduler] 已启动，每分钟检查提醒/规则/沉默，每小时检查长期任务和下一步动作");
}
