import { readFileSync } from "fs";
import { resolve } from "path";
import dayjs from "dayjs";
import { config } from "./config.js";
import { chatCompletion } from "../llm/provider.js";
import { toolDefinitions, executeTool } from "../tools/index.js";
import * as storage from "../storage/index.js";
import { getState } from "./interruptibility.js";
import { buildDashboard } from "./dashboard.js";
import { normalizeOpenTimelineEvents, OPEN_TIMELINE_MAX_MIN } from "./timeline.js";
import { formatRuleSchedule, isDailyRule, ruleOccurrencesInRange } from "./rules.js";

function isDashboardRequest(message) {
  return /^(面板|状态|dashboard|看看今天|今天怎么样|今日待办|今天有什么|本周待办|这周有什么)\s*$/i.test(message.trim());
}

function isRulesRequest(message) {
  return /^(\/rules|看规则|我的规则|规则列表|查看规则|规则面板)\s*$/i.test(message.trim());
}

async function buildRulesPanel() {
  const rules = await storage.listItems("user_rules");
  const active = rules.filter((r) => r.status === "active");
  const rulebook = active.filter((r) => r.trigger_condition === "rulebook");
  if (!rulebook.length) return '当前没有行为规则。\n说"加一条规则：..."可以新增。';
  const lines = ["📋 行为规则"];
  rulebook.forEach((r, i) => {
    lines.push(`${i + 1}. 【${r.name}】${r.message}  (id:${r.id})`);
  });
  lines.push('\n说"修改规则N：..."或"删掉规则N"可以更新。');
  return lines.join("\n");
}

function claimsWriteSuccess(reply) {
  return /✅|已记录|已修正|已写入|已取消|已归档|已完成|记下了|设好了|改好了/.test(reply);
}

const RECENT_WRITE_TTL_MS = 6 * 60 * 60 * 1000;
const recentWrites = [];

function cleanupRecentWrites() {
  const cutoff = Date.now() - RECENT_WRITE_TTL_MS;
  while (recentWrites.length && recentWrites[0].at < cutoff) {
    recentWrites.shift();
  }
}

function titleOf(result) {
  return result.title || result.message || result.name || result.current_active_task || result.id || "未命名";
}

function summarizeWrite(toolName, result) {
  if (!result || typeof result !== "object" || result.error) return null;

  const parts = [toolName, titleOf(result)];
  if (result.id) parts.push(`id:${result.id}`);
  if (result.status) parts.push(`status:${result.status}`);
  if (result.trigger_at) parts.push(`trigger:${dayjs(result.trigger_at).format("MM-DD HH:mm")}`);
  if (result.start_time) parts.push(`start:${dayjs(result.start_time).format("MM-DD HH:mm")}`);
  if (result.hard_deadline) parts.push(`deadline:${dayjs(result.hard_deadline).format("MM-DD HH:mm")}`);
  if (result.trigger_condition) parts.push(`rule:${result.trigger_condition}`);
  if (result.task_id) parts.push(`task_id:${result.task_id}`);
  return parts.join(" | ");
}

function recordRecentWrite(toolName, result) {
  const summary = summarizeWrite(toolName, result);
  if (!summary) return;
  recentWrites.push({ at: Date.now(), summary });
  cleanupRecentWrites();
  while (recentWrites.length > 30) recentWrites.shift();
}

function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function projectProgressSummary(project) {
  if (project.progress_type === "stage") {
    const stages = splitList(project.progress_stages);
    const current = Number(project.progress_current_stage || 0);
    const currentName = stages[current - 1] ? `「${stages[current - 1]}」` : "";
    return `阶段 ${current}/${stages.length || "?"}${currentName}`;
  }

  if (project.progress_type === "checklist") {
    const items = splitList(project.progress_items);
    const done = splitList(project.progress_items_done);
    return `清单 ${done.length}/${items.length || "?"}${done.length ? ` 已完成:${done.join("、")}` : ""}`;
  }

  if (project.progress_type === "streak") {
    if (project.daily_quota) {
      const today = dayjs().format("YYYY-MM-DD");
      const dailyDone = project.daily_reset_date === today ? (project.daily_done || 0) : 0;
      return `每日配额 ${dailyDone}/${project.daily_quota} | 连续 ${project.streak_current || 0} 天`;
    }
    return `连续 ${project.streak_current || 0} 天 | 总计 ${project.streak_total || 0}`;
  }

  return `${project.progress_percent || 0}% | 已完成 ${project.progress_done || 0}${project.progress_unit || ""}/${project.progress_total || "?"}${project.progress_unit || ""}`;
}

async function loadActiveContext() {
  const collections = ["tasks", "projects", "reminders", "timeline", "user_rules", "progress_logs"];
  const results = await Promise.all(collections.map(async (collection) => {
    try {
      return await storage.listItems(collection);
    } catch (e) {
      e.message = `读取 ${collection} 失败：${e.message}`;
      throw e;
    }
  }));
  const [allTasks, projects, reminders, allTimeline, rules, allProgressLogs] = results;

  const cutoff = dayjs().subtract(30, "day").toISOString();
  const progressLogs = allProgressLogs.filter((l) => l.logged_at >= cutoff);
  const normalizedTimeline = await normalizeOpenTimelineEvents(allTimeline).catch(() => allTimeline);

  const tasks = allTasks.filter((t) => ["pending", "in_progress", "paused"].includes(t.status));
  const todayCompleted = allTasks.filter((t) => {
    if (t.status !== "completed") return false;
    return dayjs(t.updated_at).isAfter(dayjs().startOf("day"));
  });
  const openEvent = normalizedTimeline
    .filter((e) => !e.end_time)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))[0] || null;
  const activeProjects = projects.filter((p) => ["active", "paused"].includes(p.status));
  const pendingReminders = reminders.filter((r) => r.status === "pending");
  const activeRules = rules.filter((r) => r.status === "active");

  let contextBlock = "\n\n## 当前活跃状态（从 source 加载，每轮刷新）\n";
  cleanupRecentWrites();
  if (recentWrites.length) {
    contextBlock += "\n### 最近写入缓存（用于飞书读取延迟兜底）\n";
    for (const item of recentWrites.slice(-12)) {
      contextBlock += `- ${dayjs(item.at).format("HH:mm")} ${item.summary}\n`;
    }
  }

  const personaRule = activeRules.find((r) => r.trigger_condition === "persona");
  if (personaRule) {
    contextBlock += `\n### 用户沟通偏好\n${personaRule.message}\n`;
  }

  const rulebookRules = activeRules.filter((r) => r.trigger_condition === "rulebook");
  if (rulebookRules.length) {
    contextBlock += "\n### 用户行为规则（严格遵守）\n";
    rulebookRules.forEach((r, i) => {
      contextBlock += `${i + 1}. 【${r.name}】${r.message}\n`;
    });
  }

  if (activeRules.filter((r) => r.trigger_condition !== "persona" && r.trigger_condition !== "rulebook").length) {
    contextBlock += "\n### 活跃用户规则\n";
    for (const r of activeRules.filter((r) => r.trigger_condition !== "persona" && r.trigger_condition !== "rulebook")) {
      const confirmedToday = r.confirmed_at && dayjs(r.confirmed_at).isSame(dayjs(), "day");
      const tag = confirmedToday ? "✓已确认" : r.persistence ? "持续中" : "单次";
      contextBlock += `- [${tag}] 「${r.name}」${r.trigger_condition} | ${r.message.slice(0, 30)}${r.message.length > 30 ? "…" : ""}\n`;
    }
  }

  if (activeProjects.length) {
    contextBlock += "\n### 活跃项目\n";
    for (const p of activeProjects) {
      contextBlock += `- 【${p.name}】id:${p.id} ${p.status} | ${p.progress_type || "无"} | ${projectProgressSummary(p)} | 上次推进 ${p.last_progress_at || "从未"}\n`;
      if (p.description) contextBlock += `  · 描述：${p.description}\n`;
      const stages = splitList(p.progress_stages);
      if (stages.length) contextBlock += `  · 阶段列表：${stages.map((name, index) => `${index + 1}.${name}`).join("、")}\n`;
      const checklist = splitList(p.progress_items);
      if (checklist.length) {
        const done = new Set(splitList(p.progress_items_done));
        contextBlock += `  · 清单：${checklist.map((item) => `${done.has(item) ? "✓" : "□"}${item}`).join("、")}\n`;
      }
      // Show last 3 progress logs for this project
      const logs = progressLogs
        .filter((l) => l.project_id === p.id)
        .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at))
        .slice(0, 3);
      for (const l of logs) {
        contextBlock += `  · ${dayjs(l.logged_at).format("MM-DD")} +${l.delta}${p.progress_unit || ""} → ${l.progress_after}${p.progress_unit || ""} ${l.note ? "(" + l.note + ")" : ""}\n`;
      }
    }
  }

  if (tasks.length) {
    contextBlock += "\n### 待办任务\n";
    for (const t of tasks) {
      const dur = t.estimated_duration_min ? ` (${t.estimated_duration_min}min)` : "";
      const hardDdl = t.hard_deadline ? ` hard_ddl:${dayjs(t.hard_deadline).format("MM-DD HH:mm")}` : "";
      const flexDdl = t.flexible_deadline ? ` flex_ddl:${dayjs(t.flexible_deadline).format("MM-DD HH:mm")}` : "";
      const startT = t.start_time ? ` start:${dayjs(t.start_time).format("HH:mm")}` : "";
      const urgency = t.urgency ? ` urgency:${t.urgency}` : "";
      const mode = t.execution_mode ? ` mode:${t.execution_mode}` : "";
      contextBlock += `- [${t.status}] ${t.title}${t.project ? " (" + t.project + ")" : ""}${dur}${urgency}${mode}${hardDdl}${flexDdl}${startT}\n`;
    }
  }

  if (todayCompleted.length) {
    contextBlock += "\n### 今日已完成\n";
    for (const t of todayCompleted) {
      contextBlock += `- ✓ ${t.title}\n`;
    }
  }

  if (pendingReminders.length) {
    contextBlock += "\n### 待触发提醒\n";
    for (const r of pendingReminders.sort((a, b) => new Date(a.trigger_at) - new Date(b.trigger_at))) {
      const taskLink = r.task_id ? `task_id:${r.task_id}` : "task_id:无";
      contextBlock += `- ${dayjs(r.trigger_at).format("MM-DD HH:mm")} | ${r.message} | ${taskLink} | id:${r.id}\n`;
    }
  }

  contextBlock += "\n### 面板候选项（输出面板时必须覆盖）\n";
  const now = dayjs();
  const startOfWeek = now.startOf("day").subtract((now.day() || 7) - 1, "day");
  const endOfWeek = startOfWeek.add(6, "day").endOf("day");
  const taskDate = (t) => t.start_time || t.hard_deadline || t.flexible_deadline || null;
  const activeTasks = allTasks.filter((t) => ["pending", "in_progress"].includes(t.status));
  const todayDashboard = [];
  const weekDashboard = [];
  const recurringDashboard = [];

  if (openEvent) {
    const elapsed = Math.min(Math.max(dayjs().diff(dayjs(openEvent.start_time), "minute"), 0), OPEN_TIMELINE_MAX_MIN);
    todayDashboard.push(`▶ ${dayjs(openEvent.start_time).format("HH:mm")} ${openEvent.current_active_task || openEvent.activity_type}（进行中 ${elapsed}min）`);
  }

  for (const t of activeTasks) {
    const date = taskDate(t);
    if (t.status === "in_progress" || (date && dayjs(date).isSame(now, "day"))) {
      todayDashboard.push(`任务 ${date ? dayjs(date).format("HH:mm") : "--:--"} ${t.title} id:${t.id}`);
    } else if (date && dayjs(date).isAfter(startOfWeek) && dayjs(date).isBefore(endOfWeek) && !dayjs(date).isSame(now, "day")) {
      weekDashboard.push(`任务 ${dayjs(date).format("MM-DD HH:mm")} ${t.title} id:${t.id}`);
    }
  }

  const activeTaskIds = new Set(activeTasks.map((t) => t.id));
  for (const r of pendingReminders.filter((r) => !r.task_id || !activeTaskIds.has(r.task_id))) {
    if (!r.trigger_at) continue;
    const triggerAt = dayjs(r.trigger_at);
    if (triggerAt.isSame(now, "day")) {
      todayDashboard.push(`提醒 ${triggerAt.format("HH:mm")} ${r.message} id:${r.id}${r.task_id ? ` task_id:${r.task_id}` : ""}`);
    } else if (triggerAt.isAfter(startOfWeek) && triggerAt.isBefore(endOfWeek)) {
      weekDashboard.push(`提醒 ${triggerAt.format("MM-DD HH:mm")} ${r.message} id:${r.id}${r.task_id ? ` task_id:${r.task_id}` : ""}`);
    }
  }

  const ruleOccurrences = activeRules
    .filter((rule) => {
      if (!isDailyRule(rule)) return true;
      const schedule = formatRuleSchedule(rule);
      if (schedule && rule.trigger_condition !== "persona") {
        recurringDashboard.push(`重复规则 ${schedule} ${rule.message || rule.name} id:${rule.id}`);
      }
      return false;
    })
    .flatMap((rule) => ruleOccurrencesInRange(rule, startOfWeek, endOfWeek, now))
    .sort((a, b) => new Date(a.trigger_at) - new Date(b.trigger_at));
  for (const occurrence of ruleOccurrences) {
    const triggerAt = dayjs(occurrence.trigger_at);
    const line = `规则提醒 ${triggerAt.format("MM-DD HH:mm")} ${occurrence.rule.message} id:${occurrence.rule.id}`;
    if (triggerAt.isSame(now, "day")) {
      todayDashboard.push(line);
    } else {
      weekDashboard.push(line);
    }
  }

  contextBlock += todayDashboard.length ? `- 今日：${todayDashboard.join("；")}\n` : "- 今日：无\n";
  contextBlock += weekDashboard.length ? `- 本周：${weekDashboard.join("；")}\n` : "- 本周：无\n";
  contextBlock += recurringDashboard.length ? `- 重复提醒：${[...new Set(recurringDashboard)].join("；")}\n` : "- 重复提醒：无\n";

  if (!activeProjects.length && !tasks.length && !pendingReminders.length) {
    contextBlock += "\n（当前无活跃项目、任务或提醒）\n";
  }

  if (openEvent) {
    const elapsed = Math.min(Math.max(dayjs().diff(dayjs(openEvent.start_time), "minute"), 0), OPEN_TIMELINE_MAX_MIN);
    contextBlock += "\n### 进行中的计时事件\n";
    contextBlock += `- [${openEvent.activity_type}] ${openEvent.current_active_task || "未命名"} | 已进行 ${elapsed} 分钟 | 开始于 ${dayjs(openEvent.start_time).format("HH:mm")} | id:${openEvent.id}`;
    if (openEvent.expected_next_action) {
      contextBlock += ` | 下一步：${openEvent.expected_next_action}`;
    }
    contextBlock += "\n";
  }

  // interruptibility state
  const dnd = getState();
  contextBlock += "\n### 当前可打扰状态\n";
  if (dnd.status === "open") {
    contextBlock += "- 状态：可打扰\n";
  } else if (dnd.status === "dnd_until_time") {
    const until = dnd.until ? dayjs(dnd.until).format("MM-DD HH:mm") : "未知";
    contextBlock += `- 状态：勿扰（原因：${dnd.reason || "未说明"}，${until} 前）\n`;
  } else if (dnd.status === "dnd_until_user_confirms") {
    contextBlock += `- 状态：勿扰（原因：${dnd.reason || "未说明"}，等待用户说恢复）\n`;
  }

  const isNewUser = !activeRules.some((r) => r.trigger_condition === "persona");
  return { contextBlock, isNewUser };
}

async function loadSystemPrompt() {
  const template = readFileSync(resolve(config.templateDir, "system-prompt.md"), "utf8");
  const now = dayjs().format("YYYY-MM-DD HH:mm:ss (dddd)");
  const { contextBlock, isNewUser } = await loadActiveContext();

  let onboardingBlock = "";
  if (isNewUser) {
    try {
      onboardingBlock = "\n\n" + readFileSync(resolve(config.templateDir, "onboarding.md"), "utf8");
    } catch {}
  }

  return template
    .replace("{{AGENT_NAME}}", config.agentName)
    .replace("{{CURRENT_TIME}}", now)
    + onboardingBlock
    + contextBlock;
}

const MAX_TOOL_ROUNDS = 12;

export async function runAgent(userMessage, conversationHistory = []) {
  if (isDashboardRequest(userMessage)) {
    try {
      return { reply: await buildDashboard(), messages: [], shouldResetContext: false };
    } catch (err) {
      return { reply: `飞书存储暂时连不上，面板数据这次没读出来：${err.message}`, messages: [], shouldResetContext: false };
    }
  }

  if (isRulesRequest(userMessage)) {
    try {
      return { reply: await buildRulesPanel(), messages: [], shouldResetContext: false };
    } catch (err) {
      return { reply: `读取规则失败：${err.message}`, messages: [], shouldResetContext: false };
    }
  }

  let systemPrompt;
  try {
    systemPrompt = await loadSystemPrompt();
  } catch (err) {
    return {
      reply: `飞书存储暂时连不上，这次不能安全读写记忆：${err.message}`,
      messages: [],
      shouldResetContext: false,
    };
  }
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let round = 0;
  let shouldResetContext = false;
  const WRITE_TOOLS = new Set(["create_task", "create_reminder", "create_project", "update_task", "update_project", "update_project_progress", "create_user_rule", "update_user_rule", "confirm_user_rule", "log_timeline", "update_timeline", "set_interruptibility", "cancel_reminder"]);
  let hasWritten = false;
  let writeFailed = false;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    const response = await chatCompletion({ messages, tools: toolDefinitions });

    if (!response.tool_calls?.length) {
      const reply = response.content || "";
      if (claimsWriteSuccess(reply) && writeFailed && round < MAX_TOOL_ROUNDS) {
        messages.push(response);
        messages.push({ role: "user", content: "[系统校验] 本轮有写入工具失败或返回 error，不能回复已记录/已修正/已取消/已完成等成功措辞。请如实告诉用户这次没有写成功，并说明需要稍后重试。" });
        continue;
      }
      // Guard: if reply says ✅ 已记录 but no write tool was called, force a correction round
      if (claimsWriteSuccess(reply) && !hasWritten && round < MAX_TOOL_ROUNDS) {
        messages.push(response);
        messages.push({ role: "user", content: "[系统校验] 你回复了已记录/已修正等成功措辞，但本轮没有调用任何写入工具。请立刻调用对应工具完成写入，或者去掉成功措辞重新回复。" });
        continue;
      }
      return {
        reply,
        messages: [...messages, response],
        shouldResetContext,
      };
    }

    messages.push(response);

    for (const toolCall of response.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await executeTool(toolCall.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }

      if (WRITE_TOOLS.has(toolCall.function.name)) {
        if (result && typeof result === "object" && result.error) {
          writeFailed = true;
        } else {
          hasWritten = true;
          recordRecentWrite(toolCall.function.name, result);
        }
      }
      if (toolCall.function.name === "update_project" && result?.status === "completed") {
        shouldResetContext = true;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  return {
    reply: lastAssistant?.content || "(达到工具调用上限)",
    messages,
    shouldResetContext,
  };
}
