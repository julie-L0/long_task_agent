import cron from "node-cron";
import dayjs from "dayjs";
import * as storage from "../storage/local.js";

let onReminderFired = null;

export function setReminderHandler(handler) {
  onReminderFired = handler;
}

function checkReminders() {
  const now = dayjs();
  const reminders = storage.listItems("reminders", { status: "pending" });

  for (const reminder of reminders) {
    const triggerAt = dayjs(reminder.trigger_at);
    if (now.isAfter(triggerAt) || now.isSame(triggerAt)) {
      if (reminder.repeat_until_confirmed) {
        // 持续提醒：不改状态，下次还会触发，但间隔至少5分钟
        const lastFired = reminder.last_fired_at ? dayjs(reminder.last_fired_at) : null;
        if (lastFired && now.diff(lastFired, "minute") < 5) continue;
        storage.updateItem("reminders", reminder.id, { last_fired_at: now.toISOString() });
      } else {
        storage.updateItem("reminders", reminder.id, { status: "fired" });
      }
      if (onReminderFired) {
        onReminderFired(reminder);
      }
    }
  }
}

function checkStaleProjects() {
  const now = dayjs();

  // 检查长期未推进的项目
  const projects = storage.listItems("projects").filter(
    (p) => p.status === "active"
  );
  const staleProjects = [];
  for (const p of projects) {
    const lastProgress = dayjs(p.last_progress_at || p.created_at);
    if (now.diff(lastProgress, "hour") >= 24) {
      staleProjects.push(p);
    }
  }

  // 检查长期未推进的任务
  const tasks = storage.listItems("tasks").filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  );
  const staleTasks = [];
  for (const task of tasks) {
    const lastTouched = dayjs(task.last_touched_at || task.created_at);
    if (now.diff(lastTouched, "hour") >= 24) {
      staleTasks.push(task);
    }
  }

  const parts = [];
  if (staleProjects.length) {
    parts.push(`项目：${staleProjects.map((p) => `「${p.name}」(${p.progress_percent}%)`).join("、")}`);
  }
  if (staleTasks.length) {
    parts.push(`任务：${staleTasks.map((t) => `「${t.title}」`).join("、")}`);
  }

  if (parts.length > 0 && onReminderFired) {
    onReminderFired({
      id: "system-nudge",
      type: "project_nudge",
      message: `以下超过24小时没推进了：\n${parts.join("\n")}\n今天有空处理吗？`,
    });
  }
}

export function startScheduler() {
  cron.schedule("* * * * *", checkReminders);
  cron.schedule("0 9 * * *", checkStaleProjects);
  console.log("[scheduler] 已启动，每分钟检查提醒，每天 9:00 检查长期任务");
}
