import { readFileSync } from "fs";
import { resolve } from "path";
import dayjs from "dayjs";
import { config } from "./config.js";
import { chatCompletion } from "../llm/provider.js";
import { toolDefinitions, executeTool } from "../tools/index.js";
import * as storage from "../storage/index.js";
import { getState } from "./interruptibility.js";

async function loadActiveContext() {
  const collections = ["tasks", "projects", "reminders", "timeline", "user_rules", "progress_logs"];
  const results = await Promise.all(
    collections.map((c) => storage.listItems(c).catch((e) => { console.error(`[agent] failed to load ${c}:`, e.message); return []; }))
  );
  const [allTasks, projects, reminders, allTimeline, rules, allProgressLogs] = results;

  const cutoff = dayjs().subtract(30, "day").toISOString();
  const progressLogs = allProgressLogs.filter((l) => l.logged_at >= cutoff);

  const tasks = allTasks.filter((t) => ["pending", "in_progress", "paused"].includes(t.status));
  const todayCompleted = allTasks.filter((t) => {
    if (t.status !== "completed") return false;
    return dayjs(t.updated_at).isAfter(dayjs().startOf("day"));
  });
  const openEvent = allTimeline
    .filter((e) => !e.end_time)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))[0] || null;
  const activeProjects = projects.filter((p) => ["active", "paused"].includes(p.status));
  const pendingReminders = reminders.filter((r) => r.status === "pending");
  const activeRules = rules.filter((r) => r.status === "active");

  let contextBlock = "\n\n## 当前活跃状态（从 source 加载，每轮刷新）\n";

  const personaRule = activeRules.find((r) => r.trigger_condition === "persona");
  if (personaRule) {
    contextBlock += `\n### 用户沟通偏好\n${personaRule.message}\n`;
  }

  if (activeRules.filter((r) => r.trigger_condition !== "persona").length) {
    contextBlock += "\n### 活跃用户规则\n";
    for (const r of activeRules.filter((r) => r.trigger_condition !== "persona")) {
      const today = dayjs().format("YYYY-MM-DD");
      const confirmedToday = r.confirmed_at && r.confirmed_at.startsWith(today);
      const tag = confirmedToday ? "✓已确认" : r.persistence ? "持续中" : "单次";
      contextBlock += `- [${tag}] 「${r.name}」${r.trigger_condition} | ${r.message.slice(0, 30)}${r.message.length > 30 ? "…" : ""}\n`;
    }
  }

  if (activeProjects.length) {
    contextBlock += "\n### 活跃项目\n";
    for (const p of activeProjects) {
      contextBlock += `- 【${p.name}】${p.status} | 进度 ${p.progress_percent || 0}% | ${p.progress_type || "无"} | 上次推进 ${p.last_progress_at || "从未"}`;
      if (p.daily_quota) {
        const today = dayjs().format("YYYY-MM-DD");
        const dailyDone = p.daily_reset_date === today ? (p.daily_done || 0) : 0;
        contextBlock += ` | 今日 ${dailyDone}/${p.daily_quota}`;
      }
      contextBlock += "\n";
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
    for (const r of pendingReminders) {
      contextBlock += `- ${dayjs(r.trigger_at).format("MM-DD HH:mm")} | ${r.message}\n`;
    }
  }

  if (!activeProjects.length && !tasks.length && !pendingReminders.length) {
    contextBlock += "\n（当前无活跃项目、任务或提醒）\n";
  }

  if (openEvent) {
    const elapsed = dayjs().diff(dayjs(openEvent.start_time), "minute");
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

  const isNewUser = !allTasks.length && !projects.length && !rules.length;
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
  const systemPrompt = await loadSystemPrompt();
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let round = 0;
  let shouldResetContext = false;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    const response = await chatCompletion({ messages, tools: toolDefinitions });

    if (!response.tool_calls?.length) {
      return {
        reply: response.content || "",
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
      const result = await executeTool(toolCall.function.name, args);

      if (toolCall.function.name === "archive_confirmed") {
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
