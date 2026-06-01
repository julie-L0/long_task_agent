import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { config } from "./core/config.js";
import { runAgent } from "./core/agent.js";
import { startScheduler, setReminderHandler, setSilenceDetectionSource } from "./core/scheduler.js";
import { createCLI } from "./channel/cli.js";
import { createWeixinChannel } from "./channel/weixin.js";

// Only allow running as a direct script, not via node -e or --input-type
if (!process.argv[1]?.endsWith("index.js")) {
  console.error("[guard] index.js must be run directly: node src/index.js");
  process.exit(1);
}

// Single-instance guard: kill previous process and wait for it to exit
const PID_FILE = new URL("../data/agent.pid", import.meta.url).pathname;
if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, "SIGTERM");
      console.log(`[guard] killed previous instance (pid ${oldPid}), waiting...`);
      // Poll until old process is gone (max 3s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { process.kill(oldPid, 0); } catch { break; } // process gone
      }
    } catch {}
  }
}
writeFileSync(PID_FILE, String(process.pid), "utf8");
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { unlinkSync(PID_FILE); } catch {}
    if (channel?.stop) channel.stop();
    process.exit(0);
  });
}
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("zh-cn");
dayjs.tz.setDefault(config.timezone);

const CHANNEL = process.env.CHANNEL || "cli";
const SILENCE_THRESHOLD_MIN = Number(process.env.SILENCE_THRESHOLD_MIN) || 60;

let conversationHistory = [];
const MAX_HISTORY = 20;

// Serialize message handling: iLink may deliver the same message multiple times concurrently
let processingPromise = Promise.resolve();
const pendingKeys = new Set(); // dedup: skip if same text already queued/processing

// userId is populated when using weixin channel; pre-fill from env for proactive reminders
let currentUserId = CHANNEL === "weixin"
  ? (process.env.WEIXIN_ALLOWED_USER_IDS || "").split(",")[0].trim() || null
  : null;
let channel;
let lastMessageAt = null; // tracks last user message time for silence detection

export function getLastMessageAt() { return lastMessageAt; }
export function getSilenceThresholdMin() { return SILENCE_THRESHOLD_MIN; }

function trimHistory() {
  // Remove oldest user+assistant pair to avoid orphaned tool messages
  while (conversationHistory.length > MAX_HISTORY * 2) {
    // Find first user message and remove it plus everything until the next user message
    const nextUserIdx = conversationHistory.findIndex((m, i) => i > 0 && m.role === "user");
    if (nextUserIdx === -1) { conversationHistory.shift(); break; }
    conversationHistory.splice(0, nextUserIdx);
  }
}

async function handleMessage(input, userId, source = "user") {
  const key = `${userId || ""}:${input}`;
  console.log(`[index] handleMessage(${source}): "${input.slice(0, 40)}" pending=${pendingKeys.has(key)}`);
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);

  processingPromise = processingPromise.then(async () => {
    if (userId) currentUserId = userId;
    lastMessageAt = Date.now();
    try {
      // /new: ask agent to verify nothing is unsaved, then reset context
      const actualInput = input.trim() === "/new"
        ? `[系统指令] 用户发起 /new 上下文重置。请检查当前对话历史中是否有提到但尚未写入存储的任务、进度、提醒或规则。如果有遗漏，先补写入，然后回复用户"已确认数据完整，上下文已清空"并调用 archive_confirmed({}) 触发重置。如果没有遗漏，直接回复并调用 archive_confirmed({})。`
        : input;

      const { reply, shouldResetContext } = await runAgent(actualInput, conversationHistory);

      if (shouldResetContext) {
        conversationHistory = [];
        channel.display(`${reply}\n\n[上下文已刷新，从 source 重新加载]`, currentUserId);
        return;
      }

      conversationHistory.push({ role: "user", content: input });
      if (reply) {
        conversationHistory.push({ role: "assistant", content: reply });
      }
      trimHistory();

      if (reply) {
        channel.display(reply, currentUserId);
      }
    } catch (err) {
      channel.display(`[错误] ${err.message}`, currentUserId);
    } finally {
      pendingKeys.delete(key); // delete only after processing completes
    }
  });
}

function handleReminder(reminder) {
  const interactive = reminder.type === "user_rule" || reminder.type === "task_checkin" || reminder.type === "silence_check" || reminder.type === "project_nudge";
  console.log(`[reminder] type=${reminder.type} interactive=${interactive} userId=${currentUserId} msg="${reminder.message}"`);

  if (interactive) {
    let tag;
    if (reminder.type === "user_rule") {
      tag = `[系统触发] 用户规则「${reminder.rule_name || reminder.id}」已触发，提醒内容：${reminder.message}。请向用户展示，并在用户回应时调用 confirm_user_rule(id="${reminder.id}")。`;
    } else if (reminder.type === "silence_check") {
      tag = `[系统触发] ${reminder.message}`;
    } else if (reminder.type === "project_nudge") {
      tag = `[系统触发] ${reminder.message} 请用自然语言向用户展示，根据用户回应决定下一步（推进任务、挪期或忽略）。`;
    } else {
      tag = `[系统触发] check-in 提醒触发 (reminder_id:${reminder.id})。提醒内容：${reminder.message || "任务完成了吗？"}。请用自然语言询问用户，完成后执行 fixed_duration 闭环收尾（get_open_timeline → update_timeline → update_task → set_interruptibility open）。`;
    }
    handleMessage(tag, currentUserId, "scheduler");
  } else {
    channel.display(`[提醒] ${reminder.message}`, currentUserId);
  }
}

console.log(`\n${"═".repeat(40)}`);
console.log(`  ${config.agentName}已启动 ✓`);
console.log(`  ${dayjs().format("YYYY-MM-DD HH:mm (dddd)")}`);
console.log(`  通道：${CHANNEL}`);
console.log(`${"═".repeat(40)}`);

setReminderHandler(handleReminder);
setSilenceDetectionSource(getLastMessageAt, getSilenceThresholdMin);
startScheduler();

if (CHANNEL === "weixin") {
  channel = createWeixinChannel({ onMessage: handleMessage });
} else {
  channel = createCLI({ onMessage: handleMessage });
  channel.prompt();
}
