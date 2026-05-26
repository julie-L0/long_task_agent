import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { config } from "./core/config.js";
import { runAgent } from "./core/agent.js";
import { startScheduler, setReminderHandler } from "./core/scheduler.js";
import { createCLI } from "./channel/cli.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("zh-cn");
dayjs.tz.setDefault(config.timezone);

let conversationHistory = [];
const MAX_HISTORY = 20;

let cli;

function trimHistory() {
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }
}

async function handleMessage(input) {
  try {
    const { reply, shouldResetContext } = await runAgent(input, conversationHistory);

    if (shouldResetContext) {
      conversationHistory = [];
      cli.display(`${reply}\n\n[上下文已刷新，从 source 重新加载]`);
      return;
    }

    conversationHistory.push({ role: "user", content: input });
    if (reply) {
      conversationHistory.push({ role: "assistant", content: reply });
    }
    trimHistory();

    if (reply) {
      cli.display(reply);
    }
  } catch (err) {
    cli.display(`[错误] ${err.message}`);
  }
}

function handleReminder(reminder) {
  cli.display(`[提醒] ${reminder.message}`);
}

console.log(`\n${"═".repeat(40)}`);
console.log(`  ${config.agentName}已启动 ✓`);
console.log(`  ${dayjs().format("YYYY-MM-DD HH:mm (dddd)")}`);
console.log(`  输入任务或问题，/quit 退出`);
console.log(`${"═".repeat(40)}`);

setReminderHandler(handleReminder);
startScheduler();

cli = createCLI({ onMessage: handleMessage });
cli.prompt();
