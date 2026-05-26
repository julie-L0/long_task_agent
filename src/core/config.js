import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "../..");

loadDotenv({ path: resolve(ROOT_DIR, ".env") });

const required = ["LLM_API_BASE_URL", "LLM_API_KEY", "LLM_MODEL"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}. Copy .env.example to .env and fill in values.`);
    process.exit(1);
  }
}

export const config = {
  llm: {
    baseUrl: process.env.LLM_API_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  },
  agentName: process.env.AGENT_NAME || "小柳",
  timezone: process.env.TIMEZONE || "Asia/Shanghai",
  dataDir: resolve(ROOT_DIR, "data"),
  templateDir: resolve(ROOT_DIR, "templates"),
  rootDir: ROOT_DIR,
};
