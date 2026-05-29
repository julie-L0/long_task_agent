#!/usr/bin/env node
/**
 * 小柳 Agent 安装引导
 * 运行：node scripts/setup.js
 *
 * 每一步完成后输出 [STEP n/N: DONE] 供 AI 工具解析进度。
 * 安装完成后输出 [SETUP COMPLETE]。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env");
const TOTAL_STEPS = 5;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const askDefault = (q, def) => ask(`${q} [${def}]: `).then((a) => a || def);

function writeEnvVars(vars) {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  if (content && !content.endsWith("\n")) content += "\n";
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_FILE, content, "utf8");
}

function readEnvVar(key) {
  if (!existsSync(ENV_FILE)) return "";
  const match = readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function step(n, label) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`[STEP ${n}/${TOTAL_STEPS}] ${label}`);
  console.log("─".repeat(50));
}

function done(n, summary) {
  console.log(`\n[STEP ${n}/${TOTAL_STEPS}: DONE] ${summary}`);
}

function findLarkCli() {
  for (const p of ["/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli", "lark-cli"]) {
    try { execSync(`${p} --version`, { stdio: "ignore" }); return p; } catch {}
  }
  return null;
}

console.log("\n╔══════════════════════════════════════════════╗");
console.log("║        小柳 Agent — 安装引导                  ║");
console.log("╚══════════════════════════════════════════════╝");
console.log("\n每一步完成后输出 [STEP n/N: DONE]，AI 工具可据此判断进度。\n");

// ── Step 1: 环境检查 ──────────────────────────────────────────────────────────
step(1, "检查运行环境");
const nodeVer = process.versions.node.split(".").map(Number);
if (nodeVer[0] < 22) {
  console.error(`❌ 需要 Node.js >= 22，当前版本 ${process.versions.node}`);
  console.error("   请升级：https://nodejs.org");
  process.exit(1);
}
console.log(`✅ Node.js ${process.versions.node}`);

if (!existsSync(resolve(ROOT, "node_modules"))) {
  console.log("📦 未检测到 node_modules，正在运行 npm install...");
  try {
    execSync("npm install", { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("❌ npm install 失败，请手动运行后重试");
    process.exit(1);
  }
}
console.log("✅ 依赖已安装");
done(1, "环境检查通过");

// ── Step 2: LLM 配置 ──────────────────────────────────────────────────────────
step(2, "配置 LLM API");
console.log("需要一个兼容 OpenAI 格式的 LLM API。");
console.log("推荐：MiniMax / DeepSeek / OpenAI / 任意兼容接口\n");

const existingKey = readEnvVar("LLM_API_KEY");
let skipLlmInput = false;
if (existingKey && existingKey !== "your-api-key-here") {
  const keep = await ask("检测到已有 LLM 配置，是否保留？(y/n) [y]: ");
  if (!keep || keep.toLowerCase() === "y") {
    skipLlmInput = true;
    done(2, `LLM 配置已保留（model: ${readEnvVar("LLM_MODEL")}）`);
  }
}

if (!skipLlmInput) {
  const apiBase = await askDefault("API 地址", "https://api.minimax.chat/v1");
  const apiKey = await ask("API Key: ");
  if (!apiKey) { console.error("❌ API Key 不能为空"); process.exit(1); }
  const model = await askDefault("模型名称", "MiniMax-M2.7");
  const agentName = await askDefault("Agent 名字", "小柳");
  writeEnvVars({ LLM_API_BASE_URL: apiBase, LLM_API_KEY: apiKey, LLM_MODEL: model, AGENT_NAME: agentName, TIMEZONE: "Asia/Shanghai" });
  done(2, `LLM 已配置（${apiBase}，model: ${model}）`);
}

// ── Step 3: 存储方式 ──────────────────────────────────────────────────────────
step(3, "选择存储方式");
console.log("  local   — 数据存本地 JSON，无需额外配置（推荐新手）");
console.log("  bitable — 数据同步到飞书多维表格，手机可查看\n");

const storageChoice = (await ask("选择存储方式 (local/bitable) [local]: ")).toLowerCase();

if (storageChoice === "bitable") {
  console.log("\n前置条件：");
  console.log("  1. 安装 lark-cli");
  console.log("     macOS:    brew install lark-cli");
  console.log("     其他系统: https://github.com/larksuite/lark-cli");
  console.log("  2. 运行 lark-cli config init 完成应用配置");
  console.log("  3. 飞书开发者后台 → 权限管理 → 开通所有 base:* 权限 → 发布新版本\n");

  const larkCli = findLarkCli();
  if (!larkCli) {
    console.log("⚠️  未检测到 lark-cli，请安装后重新运行此脚本。");
    writeEnvVars({ STORAGE_BACKEND: "local" });
    done(3, "存储：local（lark-cli 未安装，已降级）");
  } else {
    console.log(`✅ 检测到 lark-cli：${larkCli}`);
    console.log("\n正在初始化飞书多维表格...");
    try {
      execSync("node scripts/setup-bitable.js", { cwd: ROOT, stdio: "inherit" });
      done(3, "存储：bitable（飞书多维表格已初始化）");
    } catch {
      console.error("❌ 飞书初始化失败，已切换为 local 存储");
      writeEnvVars({ STORAGE_BACKEND: "local" });
      done(3, "存储：local（bitable 初始化失败，已降级）");
    }
  }
} else {
  writeEnvVars({ STORAGE_BACKEND: "local" });
  done(3, "存储：local（数据保存在 data/ 目录）");
}

// ── Step 4: 消息通道 ──────────────────────────────────────────────────────────
step(4, "选择消息通道");
console.log("  cli    — 命令行交互，适合本地使用和调试");
console.log("  weixin — 微信 iLink Bot，在手机微信里和小柳对话\n");
console.log("注意：微信通道需要向腾讯申请 iLink Bot 权限");
console.log("申请地址：https://ilinkai.weixin.qq.com\n");

const channelChoice = (await ask("选择通道 (cli/weixin) [cli]: ")).toLowerCase();

if (channelChoice === "weixin") {
  console.log("\n微信登录流程：");
  console.log("  1. 脚本会获取一个二维码链接");
  console.log("  2. 在浏览器打开链接，用微信扫码");
  console.log("  3. 手机微信会显示一串数字，在终端输入");
  console.log("  4. 登录成功，凭证自动写入 .env\n");

  const cont = await ask("准备好了吗？(y/跳过) [y]: ");
  if (!cont || cont.toLowerCase() === "y") {
    try {
      execSync("node scripts/weixin-login.js", { cwd: ROOT, stdio: "inherit" });
      done(4, "通道：weixin（微信登录成功）");
    } catch {
      console.error("❌ 微信登录失败，已切换为 cli 通道");
      writeEnvVars({ CHANNEL: "cli" });
      done(4, "通道：cli（微信登录失败，已降级）");
    }
  } else {
    writeEnvVars({ CHANNEL: "cli" });
    done(4, "通道：cli（微信跳过，之后可运行 npm run weixin-login）");
  }
} else {
  writeEnvVars({ CHANNEL: "cli" });
  done(4, "通道：cli");
}

// ── Step 5: 验证 & 汇总 ───────────────────────────────────────────────────────
step(5, "验证配置");

const finalKey = readEnvVar("LLM_API_KEY");
const finalBase = readEnvVar("LLM_API_BASE_URL");
const finalModel = readEnvVar("LLM_MODEL");

const missing = [];
if (!finalKey || finalKey === "your-api-key-here") missing.push("LLM_API_KEY");
if (!finalBase) missing.push("LLM_API_BASE_URL");
if (!finalModel) missing.push("LLM_MODEL");

if (missing.length) {
  console.error(`❌ 以下必填项未配置：${missing.join(", ")}`);
  console.error("   请编辑 .env 文件手动填写，然后运行 npm start");
  process.exit(1);
}

console.log("\n配置摘要：");
console.log(`  LLM API : ${finalBase}`);
console.log(`  模型    : ${finalModel}`);
console.log(`  存储    : ${readEnvVar("STORAGE_BACKEND") || "local"}`);
console.log(`  通道    : ${readEnvVar("CHANNEL") || "cli"}`);
console.log(`  Agent   : ${readEnvVar("AGENT_NAME") || "小柳"}`);

done(5, "配置验证通过");
rl.close();

console.log("\n╔══════════════════════════════════════════════╗");
console.log("║  [SETUP COMPLETE] 安装完成                    ║");
console.log("╚══════════════════════════════════════════════╝");
console.log("\n启动命令：");
console.log("  npm start          前台运行");
console.log("  npm run start:bg   后台运行（日志：tail -f /tmp/xiaoliu.log）\n");
