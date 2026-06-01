import { randomUUID } from "crypto";

const CHANNEL_VERSION = "1.0.0";
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const MAX_CHUNK = 3800;
const POLL_RETRY_DELAY_MS = 3_000;

function getBaseUrl() {
  return (process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com").trim().replace(/\/$/, "");
}

function getAllowedUsers() {
  return (process.env.WEIXIN_ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function makeHeaders(token) {
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(randomUUID()).toString("base64"),
    Authorization: `Bearer ${token}`,
  };
}

async function apiPost(endpoint, body, token, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getBaseUrl()}/${endpoint}`, {
      method: "POST",
      headers: makeHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Split text at paragraph / sentence boundaries, max MAX_CHUNK chars each
function chunkText(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK) {
    let cut = MAX_CHUNK;
    const para = remaining.lastIndexOf("\n", MAX_CHUNK);
    const sent = remaining.lastIndexOf("。", MAX_CHUNK);
    if (para > MAX_CHUNK * 0.5) cut = para + 1;
    else if (sent > MAX_CHUNK * 0.5) cut = sent + 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function createWeixinChannel({ onMessage }) {
  const token = process.env.WEIXIN_BOT_TOKEN?.trim();
  if (!token) throw new Error("Missing WEIXIN_BOT_TOKEN — run: node scripts/weixin-login.js");

  const allowedUsers = getAllowedUsers();
  // context_token per userId (must be echoed back when replying)
  const contextTokens = {};
  const seenMsgIds = new Set(); // dedup by msg_id
  const recentMsgKeys = new Map(); // dedup by content (iLink re-delivers with new msg_id on reconnect)
  const CONTENT_DEDUP_MS = 5 * 60_000; // 5 minutes
  let syncBuffer = "";
  let stopped = false;

  const pendingSends = []; // messages that failed to send, retry on next successful poll
  let consecutiveErrors = 0;

  async function sendText(userId, text) {
    const ctxToken = contextTokens[userId] || "";
    const parts = chunkText(text);
    for (const chunk of parts) {
      try {
        await apiPost(
          "ilink/bot/sendmessage",
          {
            msg: {
              from_user_id: "",
              to_user_id: userId,
              client_id: `xly-${randomUUID()}`,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: chunk } }],
              context_token: ctxToken,
            },
            base_info: { channel_version: CHANNEL_VERSION },
          },
          token
        );
      } catch (e) {
        console.error("[weixin] send failed, queued for retry:", e.message);
        pendingSends.push({ userId, text: chunk });
      }
    }
  }

  async function flushPendingSends() {
    while (pendingSends.length) {
      const { userId, text } = pendingSends.shift();
      try {
        await sendText(userId, text);
      } catch {
        pendingSends.unshift({ userId, text });
        break;
      }
    }
  }

  function processMsg(msg) {
    const senderId = msg.from_user_id || msg.sender_id;
    if (!senderId) return;
    if (allowedUsers.length && !allowedUsers.includes(senderId)) return;

    const msgId = msg.msg_id || msg.client_id;
    if (msgId) {
      if (seenMsgIds.has(msgId)) return;
      seenMsgIds.add(msgId);
      if (seenMsgIds.size > 500) {
        const first = seenMsgIds.values().next().value;
        seenMsgIds.delete(first);
      }
    }

    if (msg.context_token) contextTokens[senderId] = msg.context_token;

    const items = msg.item_list || [];
    const text = items
      .filter((i) => i.type === 1)
      .map((i) => i.text_item?.text || "")
      .join("\n")
      .trim();
    if (!text) return;

    // content-based dedup: iLink re-delivers with new msg_id after reconnect
    const contentKey = `${senderId}:${text}`;
    const now = Date.now();
    if (recentMsgKeys.has(contentKey) && now - recentMsgKeys.get(contentKey) < CONTENT_DEDUP_MS) return;
    recentMsgKeys.set(contentKey, now);
    if (recentMsgKeys.size > 200) {
      for (const [k, t] of recentMsgKeys) {
        if (now - t > CONTENT_DEDUP_MS) recentMsgKeys.delete(k);
      }
    }

    onMessage(text, senderId);
  }

  let pollAbort = new AbortController();

  async function pollLoop() {
    while (!stopped) {
      pollAbort = new AbortController();
      const timer = setTimeout(() => pollAbort.abort(), LONG_POLL_TIMEOUT_MS + 5_000);
      try {
        const res = await fetch(`${getBaseUrl()}/ilink/bot/getupdates`, {
          method: "POST",
          headers: makeHeaders(token),
          body: JSON.stringify({ get_updates_buf: syncBuffer, base_info: { channel_version: CHANNEL_VERSION } }),
          signal: pollAbort.signal,
        });
        clearTimeout(timer);
        const data = await res.json();
        if (data.get_updates_buf) syncBuffer = data.get_updates_buf;
        // Reconnected after errors — flush queued messages
        if (consecutiveErrors > 0) {
          console.log(`[weixin] reconnected after ${consecutiveErrors} errors, flushing ${pendingSends.length} queued messages`);
          flushPendingSends();
        }
        consecutiveErrors = 0;
        for (const msg of data.msgs || []) processMsg(msg);
      } catch (e) {
        clearTimeout(timer);
        if (e.name === "AbortError" || stopped) continue;
        consecutiveErrors++;
        const causeCode = e.cause?.code || "";
        const causeMsg = e.cause?.message || e.cause || "";
        if (causeCode === "ECONNRESET" || String(causeMsg).includes("ECONNRESET")) continue;
        if (consecutiveErrors >= 5 && consecutiveErrors % 5 === 0) {
          console.error(`[weixin] ${consecutiveErrors} consecutive poll errors — connection may be down`);
        }
        console.error("[weixin] poll error:", e.message, causeMsg ? `(${causeMsg})` : "");
        await new Promise((r) => setTimeout(r, POLL_RETRY_DELAY_MS));
      }
    }
  }

  function stop() {
    stopped = true;
    pollAbort.abort(); // immediately cancel in-flight poll
  }

  function display(text, userId) {
    console.log(`[weixin] display(${text.length}chars): "${text.slice(0, 50).replace(/\n/g, "↵")}..."`);
    const targets = userId ? [userId] : allowedUsers;
    if (!targets.length) {
      console.warn("[weixin] no target users — set WEIXIN_ALLOWED_USER_IDS");
      return;
    }
    for (const uid of targets) {
      sendText(uid, text).catch((e) => console.error("[weixin] send error:", e.message));
    }
  }

  pollLoop();
  console.log("[weixin] channel started, polling for messages...");
  return { display, stop };
}
