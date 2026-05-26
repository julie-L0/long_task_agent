import { config } from "../core/config.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion({ messages, tools, toolChoice }) {
  const url = new URL("/v1/chat/completions", config.llm.baseUrl).toString();

  const body = {
    model: config.llm.model,
    messages,
    temperature: 0.7,
  };

  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
        if (response.status >= 500) continue;
        throw lastError;
      }

      const data = await response.json();
      const msg = data.choices[0].message;
      if (msg.content) {
        msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
      }
      return msg;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (e.name === "AbortError") {
        lastError = new Error("LLM 请求超时，请稍后重试");
      }
      if (attempt < MAX_RETRIES) continue;
    }
  }

  throw lastError;
}
