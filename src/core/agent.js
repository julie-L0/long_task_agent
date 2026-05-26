import { readFileSync } from "fs";
import { resolve } from "path";
import dayjs from "dayjs";
import { config } from "./config.js";
import { chatCompletion } from "../llm/provider.js";
import { toolDefinitions, executeTool } from "../tools/index.js";
import * as storage from "../storage/local.js";

function loadActiveContext() {
  const tasks = storage.listItems("tasks").filter(
    (t) => ["pending", "in_progress", "paused"].includes(t.status)
  );
  const projects = storage.listItems("projects").filter(
    (p) => ["active", "paused"].includes(p.status)
  );
  const reminders = storage.listItems("reminders").filter(
    (r) => r.status === "pending"
  );

  const todayCompleted = storage.listItems("tasks").filter((t) => {
    if (t.status !== "completed") return false;
    const updated = dayjs(t.updated_at);
    return updated.isAfter(dayjs().startOf("day"));
  });

  let contextBlock = "\n\n## 当前活跃状态（从 source 加载，每轮刷新）\n";

  if (projects.length) {
    contextBlock += "\n### 活跃项目\n";
    for (const p of projects) {
      contextBlock += `- 【${p.name}】${p.status} | 进度 ${p.progress_percent || 0}% | ${p.progress_type || "无"} | 上次推进 ${p.last_progress_at || "从未"}\n`;
    }
  }

  if (tasks.length) {
    contextBlock += "\n### 待办任务\n";
    for (const t of tasks) {
      const deadline = t.hard_deadline || t.flexible_deadline || "";
      contextBlock += `- [${t.status}] ${t.title}${t.project ? " (" + t.project + ")" : ""}${deadline ? " ddl:" + dayjs(deadline).format("MM-DD HH:mm") : ""}${t.start_time ? " start:" + dayjs(t.start_time).format("HH:mm") : ""}\n`;
    }
  }

  if (todayCompleted.length) {
    contextBlock += "\n### 今日已完成\n";
    for (const t of todayCompleted) {
      contextBlock += `- ✓ ${t.title}\n`;
    }
  }

  if (reminders.length) {
    contextBlock += "\n### 待触发提醒\n";
    for (const r of reminders) {
      contextBlock += `- ${dayjs(r.trigger_at).format("MM-DD HH:mm")} | ${r.message}\n`;
    }
  }

  if (!projects.length && !tasks.length && !reminders.length) {
    contextBlock += "\n（当前无活跃项目、任务或提醒）\n";
  }

  return contextBlock;
}

function loadSystemPrompt() {
  const template = readFileSync(resolve(config.templateDir, "system-prompt.md"), "utf8");
  const now = dayjs().format("YYYY-MM-DD HH:mm:ss (dddd)");
  const activeContext = loadActiveContext();

  return template
    .replace("{{AGENT_NAME}}", config.agentName)
    .replace("{{CURRENT_TIME}}", now)
    + activeContext;
}

const MAX_TOOL_ROUNDS = 8;

export async function runAgent(userMessage, conversationHistory = []) {
  const systemPrompt = loadSystemPrompt();
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
      const args = JSON.parse(toolCall.function.arguments || "{}");
      const result = executeTool(toolCall.function.name, args);

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
