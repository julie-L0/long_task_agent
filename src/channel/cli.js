import { createInterface } from "readline";
import { config } from "../core/config.js";

export function createCLI({ onMessage }) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\n> ",
  });

  let processing = false;

  function display(text) {
    if (processing) {
      process.stdout.write("\r\x1b[K");
      processing = false;
    }
    process.stdout.write(`\n${config.agentName}：${text}\n`);
    rl.prompt();
  }

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "/quit" || input === "/exit") {
      console.log(`\n${config.agentName}：再见，有事随时找我。`);
      process.exit(0);
    }

    processing = true;
    process.stdout.write(`\n${config.agentName} 思考中...`);

    await onMessage(input);
  });

  rl.on("close", () => {
    process.exit(0);
  });

  return { display, prompt: () => rl.prompt() };
}
