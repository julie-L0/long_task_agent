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
import * as storage from "./storage/index.js";
import { setState, isInterruptible, canSendProactiveNudge } from "./core/interruptibility.js";
import { normalizeOpenTimelineEvents } from "./core/timeline.js";

// Only allow running as a direct script, not via node -e or --input-type
if (!process.argv[1]?.endsWith("index.js")) {
  console.error("[guard] index.js must be run directly: node src/index.js");
  process.exit(1);
}

// Single-instance guard: kill previous process and wait for it to exit
const PID_FILE = new URL("../data/agent.pid", import.meta.url).pathname;
function readPidFile() {
  try {
    return readFileSync(PID_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function removePidFileIfOwned() {
  if (readPidFile() === String(process.pid)) {
    try { unlinkSync(PID_FILE); } catch {}
  }
}

function removePidFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readPidFile(), 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      try {
        process.kill(oldPid, 0);
      } catch {
        console.log(`[guard] removed stale pid file (pid ${oldPid} not running)`);
        removePidFile();
      }
      if (existsSync(PID_FILE)) {
        process.kill(oldPid, "SIGTERM");
        console.log(`[guard] killed previous instance (pid ${oldPid}), waiting...`);
        // Poll until old process is gone (max 3s)
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 100));
          try { process.kill(oldPid, 0); } catch { break; } // process gone
        }
      }
    } catch {}
  }
}
writeFileSync(PID_FILE, String(process.pid), "utf8");
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    removePidFileIfOwned();
    if (channel?.stop) channel.stop();
    process.exit(0);
  });
}
process.on("exit", removePidFileIfOwned);

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("zh-cn");
dayjs.tz.setDefault(config.timezone);

const CHANNEL = process.env.CHANNEL || "cli";
const SILENCE_THRESHOLD_MIN = Number(process.env.SILENCE_THRESHOLD_MIN) || 60;
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}`;

export function isCurrentInstance() {
  return readPidFile() === String(process.pid);
}

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
const pendingUserRules = new Map();
const PENDING_RULE_TTL_MS = 6 * 60 * 60 * 1000;

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

function isUserRuleConfirmation(input) {
  return /好了|知道了|完成了|写完了|处理了|弄完了|搞定了|睡了|晚安|到家了|到了|回来了|\b(done|ok)\b/i.test(input.trim());
}

function isPureUserRuleConfirmation(input) {
  const text = input.trim();
  return /^(好了|好啦|知道了|完成了|写完了|处理了|弄完了|搞定了|睡了|晚安|到家了|到了|回来了|done|ok)$/i.test(text);
}

function cleanupPendingUserRules() {
  const now = Date.now();
  for (const [id, rule] of pendingUserRules) {
    if (now - rule.at > PENDING_RULE_TTL_MS) pendingUserRules.delete(id);
  }
}

function normalizeRuleText(text) {
  return String(text)
    .replace(/提醒/g, "")
    .replace(/[吗嘛呢了呀啊？?！!，。,.；;、\s]/g, "");
}

function matchRuleText(rule, text) {
  const normalizedText = normalizeRuleText(text);
  const normalizedRule = normalizeRuleText(`${rule.name || ""}${rule.message || ""}`);
  const parts = [rule.name, rule.message]
    .filter(Boolean)
    .flatMap((s) => normalizeRuleText(s).split(/[：:]/))
    .filter((s) => s.length >= 2);
  const actionKeywords = ["到家", "回家", "下班", "睡", "日报"];
  return parts.some((part) => normalizedText.includes(part))
    || actionKeywords.some((keyword) => normalizedText.includes(keyword) && normalizedRule.includes(keyword));
}

async function pickPendingUserRule(input, { allowFallback = false } = {}) {
  cleanupPendingUserRules();
  const rules = [...pendingUserRules.values()].sort((a, b) => b.at - a.at);

  const text = input.trim();
  const matched = rules.find((rule) => matchRuleText(rule, text));
  if (matched || (allowFallback && rules.length)) return matched || rules[0];

  const activeRules = await storage.listItems("user_rules").catch(() => []);
  const candidates = activeRules
    .filter((rule) => rule.status === "active" && rule.persistence && rule.stop_condition === "user_confirms")
    .sort((a, b) => new Date(b.last_fired_at || b.created_at || 0) - new Date(a.last_fired_at || a.created_at || 0));
  return candidates.find((rule) => matchRuleText(rule, text)) || (allowFallback ? candidates[0] : null) || null;
}

function parseDoNotAskUntil(input) {
  const explicitQuiet = /(别问|不要问|别提醒|不要提醒|别打扰|不要打扰)/.test(input);
  const impliedQuietUntil = !/(提醒我|叫我|通知我)/.test(input) && /(到家|回家|在路上|路上|下班)/.test(input);
  if (!explicitQuiet && !impliedQuietUntil) return null;

  const match = input.match(/([零一二两三四五六七八九十\d]{1,3})\s*点(?:半|([0-5]?\d)\s*分?)?(?:[^，。！？,.!?；;]{0,12})?前/)
    || (/(这个|那|此)?之前/.test(input)
      ? input.match(/([零一二两三四五六七八九十\d]{1,3})\s*点(?:半|([0-5]?\d)\s*分?)?/)
      : impliedQuietUntil
        ? input.match(/([零一二两三四五六七八九十\d]{1,3})\s*点(?:半|([0-5]?\d)\s*分?)?/)
      : null);
  if (!match) return null;

  const chinese = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let hour;
  if (/^\d+$/.test(match[1])) {
    hour = Number(match[1]);
  } else if (match[1].includes("十")) {
    const [tens, ones] = match[1].split("十");
    hour = (tens ? chinese[tens] : 1) * 10 + (ones ? chinese[ones] : 0);
  } else {
    hour = chinese[match[1]];
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;

  if (hour >= 1 && hour <= 11 && /下午|晚上|夜里|今晚|下班|回家/.test(input)) hour += 12;
  const minute = input.includes("点半") ? 30 : Number(match[2] || 0);
  let until = dayjs().hour(hour).minute(minute).second(0).millisecond(0);
  if (until.isBefore(dayjs())) until = until.add(1, "day");
  return until.toISOString();
}

async function handleMessage(input, userId, source = "user") {
  if (!isCurrentInstance()) {
    console.warn(`[index] stale instance ignored message pid=${process.pid} instance=${INSTANCE_ID}`);
    if (channel?.stop) channel.stop();
    return;
  }

  const key = `${userId || ""}:${input}`;
  console.log(`[index] handleMessage(${source}) pid=${process.pid} instance=${INSTANCE_ID}: "${input.slice(0, 40)}" pending=${pendingKeys.has(key)}`);
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);

  processingPromise = processingPromise.then(async () => {
    if (userId) currentUserId = userId;
    lastMessageAt = Date.now();
    try {
      // 调度器触发的消息在 dnd 状态下直接丢弃，不走 LLM（避免 LLM 回"好。"被发给用户）
      if (source === "scheduler" && !await canSendProactiveNudge()) {
        console.log(`[index] scheduler trigger suppressed (dnd/focus): "${input.slice(0, 60)}"`);
        return;
      }

      if (source === "user") {
        const dndUntil = parseDoNotAskUntil(input);
        if (dndUntil) {
          setState("dnd_until_time", { until: dndUntil, reason: input, set_by: "user" });
        } else if (/别问|不要问|别提醒|不要提醒|别打扰|不要打扰|不打扰|安静一下|让我静静/.test(input)) {
          // 没有具体时间，设为"等用户主动确认才恢复"
          setState("dnd_until_user_confirms", { reason: input, set_by: "user" });
        }
      }

      if (source === "user" && isUserRuleConfirmation(input)) {
        const pureConfirmation = isPureUserRuleConfirmation(input);
        const pendingRule = await pickPendingUserRule(input, { allowFallback: pureConfirmation });
        if (pendingRule) {
          const rule = await storage.updateItem("user_rules", pendingRule.id, {
            confirmed_at: new Date().toISOString(),
          });
          if (rule) {
            pendingUserRules.delete(pendingRule.id);
            if (pureConfirmation) {
              channel.display("已确认，今天不再重复提醒。", currentUserId);
              return;
            }
          } else {
            channel.display("这次没有写成功，存储里没找到这条规则。", currentUserId);
            return;
          }
        }
      }

      // /new: ask agent to verify nothing is unsaved, then reset context
      const isNew = input.trim() === "/new";
      const actualInput = isNew
        ? `[系统指令] 用户发起 /new 上下文重置。请检查当前对话历史中是否有提到但尚未写入存储的任务、进度、提醒或规则。如果有遗漏，先补调工具写入，再告知用户写了什么。如果没有遗漏，直接告知用户上下文已清空。`
        : input;

      const { reply, shouldResetContext } = await runAgent(actualInput, conversationHistory);
      if (isNew || shouldResetContext) {
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

async function handleReminder(reminder) {
  if (reminder.type === "user_rule") {
    if (!await canSendProactiveNudge()) {
      console.log(`[reminder] type=user_rule skipped (dnd/focus) msg="${reminder.message}"`);
      return;
    }
    console.log(`[reminder] type=user_rule direct=true userId=${currentUserId} msg="${reminder.message}"`);
    if (reminder.persistence && reminder.stop_condition === "user_confirms") {
      pendingUserRules.set(reminder.id, {
        id: reminder.id,
        name: reminder.rule_name || reminder.id,
        message: reminder.message,
        at: Date.now(),
      });
    }
    channel.display(reminder.message, currentUserId);
    return;
  }

  const interactive = reminder.type === "task_checkin" || reminder.type === "silence_check" || reminder.type === "project_nudge" || reminder.type === "focus_exit";
  console.log(`[reminder] type=${reminder.type} interactive=${interactive} userId=${currentUserId} msg="${reminder.message}"`);

  if (interactive) {
    let tag;
    if (reminder.type === "silence_check") {
      tag = `[系统触发] ${reminder.message}`;
    } else if (reminder.type === "focus_exit") {
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
console.log(`  PID：${process.pid} instance=${INSTANCE_ID}`);
console.log(`${"═".repeat(40)}`);

setReminderHandler(handleReminder);
setSilenceDetectionSource(getLastMessageAt, getSilenceThresholdMin);
await normalizeOpenTimelineEvents().catch((err) => console.error("[timeline] normalize failed:", err.message));

if (CHANNEL === "weixin") {
  channel = createWeixinChannel({ onMessage: handleMessage, isCurrentInstance });
} else {
  channel = createCLI({ onMessage: handleMessage });
  channel.prompt();
}

startScheduler();
