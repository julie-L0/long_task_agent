#!/usr/bin/env node
/**
 * 微信 iLink Bot 登录脚本
 *
 * 运行：node scripts/weixin-login.js
 *
 * 完成后自动把 WEIXIN_* 变量写入项目根目录的 .env 文件。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env");
const BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const QR_POLL_TIMEOUT_MS = 35_000;
const QR_TOTAL_TIMEOUT_MS = 480_000; // 8 min
const QR_MAX_REFRESHES = 3;

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

async function apiFetch(path, { method = "GET", body, timeoutMs = QR_POLL_TIMEOUT_MS + 5_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/${path}`, {
      method,
      headers: { "iLink-App-ClientVersion": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getQrCode() {
  return apiFetch(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
    method: "POST",
    body: { local_token_list: [] },
  });
}

async function pollQrStatus(qrcode, verifyCode) {
  let path = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) path += `&verify_code=${encodeURIComponent(verifyCode)}`;
  return apiFetch(path, { timeoutMs: QR_POLL_TIMEOUT_MS + 5_000 });
}

async function login() {
  console.log("====================================================");
  console.log("小柳 Agent — 微信 iLink Bot 登录");
  console.log("====================================================\n");

  const deadline = Date.now() + QR_TOTAL_TIMEOUT_MS;
  let refreshCount = 0;

  while (refreshCount <= QR_MAX_REFRESHES) {
    // Get QR code
    process.stdout.write(`获取二维码${refreshCount > 0 ? "（刷新）" : ""}...`);
    let qrData;
    try {
      qrData = await getQrCode();
    } catch (e) {
      console.error("\n❌ 获取二维码失败:", e.message);
      process.exit(1);
    }

    if (!qrData.qrcode) {
      console.error("\n❌ 响应中未找到 qrcode:", JSON.stringify(qrData));
      process.exit(1);
    }

    console.log(" ✅");
    console.log("\n请用微信扫描以下二维码：");
    console.log(`\n  ${qrData.qrcode_img_content}\n`);
    console.log("（在浏览器中打开上方链接，用微信扫码）\n");

    // Poll for status
    let scanned = false;
    let pendingVerifyCode;
    while (Date.now() < deadline) {
      let statusData;
      try {
        statusData = await pollQrStatus(qrData.qrcode, pendingVerifyCode);
      } catch (e) {
        if (e.name === "AbortError") continue;
        console.error("[poll error]", e.message);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const status = statusData.status;

      if (status === "wait") {
        process.stdout.write(".");
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (status === "scaned") {
        if (pendingVerifyCode) pendingVerifyCode = undefined;
        if (!scanned) {
          process.stdout.write("\n✅ 已扫码，等待确认...");
          scanned = true;
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (status === "need_verifycode") {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        pendingVerifyCode = await new Promise((resolve) => {
          rl.question(
            pendingVerifyCode ? "\n❌ 验证码不匹配，请重新输入：\n> " : "\n请输入手机微信显示的数字：\n> ",
            (ans) => { rl.close(); resolve(ans.trim()); }
          );
        });
        continue;
      }

      if (status === "confirmed") {
        console.log("\n✅ 登录成功！\n");
        const { bot_token, ilink_bot_id, baseurl, ilink_user_id } = statusData;

        // Prompt for allowed user IDs
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n你的微信用户 ID（ilink_user_id）：${ilink_user_id}`);
        console.log("直接回车使用上方 ID，或输入其他 ID（多个用逗号分隔）：");
        const allowedIds = await new Promise((resolve) => {
          rl.question("> ", (ans) => {
            rl.close();
            resolve(ans.trim() || ilink_user_id || "");
          });
        });

        writeEnvVars({
          CHANNEL: "weixin",
          WEIXIN_BOT_TOKEN: bot_token,
          WEIXIN_BOT_ID: ilink_bot_id || "",
          WEIXIN_BASE_URL: baseurl || BASE_URL,
          WEIXIN_USER_ID: ilink_user_id || "",
          WEIXIN_ALLOWED_USER_IDS: allowedIds,
        });

        console.log("\n====================================================");
        console.log("登录信息已写入 .env");
        console.log(`Bot ID：${ilink_bot_id}`);
        if (allowedIds) console.log(`允许用户：${allowedIds}`);
        console.log("\n现在可以运行：npm start");
        console.log("====================================================");
        return;
      }

      if (status === "expired") {
        console.log("\n⏰ 二维码已过期，重新获取...\n");
        refreshCount++;
        break;
      }
    }

    if (Date.now() >= deadline) {
      console.error("\n❌ 登录超时（8分钟）");
      process.exit(1);
    }
  }

  console.error("❌ 二维码刷新次数已达上限，请重新运行脚本。");
  process.exit(1);
}

login().catch((err) => {
  console.error("\n❌ 登录失败:", err.message || err);
  process.exit(1);
});
