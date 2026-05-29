#!/usr/bin/env node
/**
 * 飞书多维表格初始化脚本（幂等，可重复运行）
 *
 * 运行：node scripts/setup-bitable.js
 *
 * 前置条件（一次性）：
 *   1. lark-cli 已安装并完成应用配置（lark-cli config init）
 *   2. 飞书开发者后台 → 权限管理 → 搜索 "base" → 开通所有 base:* 权限
 *   3. 发布新版本使权限生效
 *
 * 完成后会自动把 BITABLE_* 变量写入项目根目录的 .env 文件。
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const LARK = "/opt/homebrew/bin/lark-cli";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env");
const BASE_NAME = "小柳数据";

// ── 所有 base:* 权限（一次性在开发者后台开通，之后无需重复）────────────────
const REQUIRED_SCOPES = [
  "base:app",
  "base:app:create",
  "base:app:readonly",
  "base:field",
  "base:field:create",
  "base:field:read",
  "base:field:update",
  "base:record",
  "base:record:create",
  "base:record:delete",
  "base:record:update",
  "base:table",
  "base:table:create",
  "base:table:delete",
  "base:table:read",
  "base:table:update",
];

// ── 表结构 ────────────────────────────────────────────────────────────────────
const TABLES = [
  {
    name: "tasks",
    titleField: "title",   // 第一个字段（更新默认首列）
    fields: [
      { type: "text", name: "title" },
      { type: "text", name: "id" },
      { type: "text", name: "project" },
      { type: "select", name: "category", options: [{ name: "work" }, { name: "study" }, { name: "life" }, { name: "health" }] },
      { type: "select", name: "status", options: [{ name: "pending" }, { name: "in_progress" }, { name: "paused" }, { name: "completed" }, { name: "cancelled" }] },
      { type: "select", name: "importance", options: [{ name: "high" }, { name: "medium" }, { name: "low" }] },
      { type: "select", name: "urgency", options: [{ name: "high" }, { name: "medium" }, { name: "low" }] },
      { type: "number", name: "estimated_duration_min" },
      { type: "text", name: "hard_deadline" },
      { type: "text", name: "flexible_deadline" },
      { type: "text", name: "start_time" },
      { type: "text", name: "end_time" },
      { type: "text", name: "execution_mode" },
      { type: "text", name: "recurrence_rule" },
      { type: "text", name: "notes" },
      { type: "text", name: "created_at" },
      { type: "text", name: "updated_at" },
      { type: "text", name: "last_touched_at" },
    ],
  },
  {
    name: "projects",
    titleField: "name",
    fields: [
      { type: "text", name: "name" },
      { type: "text", name: "id" },
      { type: "text", name: "description" },
      { type: "select", name: "status", options: [{ name: "active" }, { name: "paused" }, { name: "archived" }] },
      { type: "select", name: "progress_type", options: [{ name: "percentage" }, { name: "streak" }, { name: "stage" }, { name: "checklist" }] },
      { type: "number", name: "progress_total" },
      { type: "text", name: "progress_unit" },
      { type: "number", name: "progress_done" },
      { type: "number", name: "progress_percent" },
      { type: "text", name: "progress_stages" },
      { type: "number", name: "progress_current_stage" },
      { type: "text", name: "progress_items" },
      { type: "text", name: "progress_items_done" },
      { type: "number", name: "streak_goal" },
      { type: "number", name: "daily_quota" },
      { type: "number", name: "daily_done" },
      { type: "text", name: "daily_reset_date" },
      { type: "number", name: "streak_current" },
      { type: "number", name: "streak_longest" },
      { type: "number", name: "streak_total" },
      { type: "text", name: "last_progress_at" },
      { type: "text", name: "created_at" },
    ],
  },
  {
    name: "reminders",
    titleField: "message",
    fields: [
      { type: "text", name: "message" },
      { type: "text", name: "id" },
      { type: "text", name: "task_id" },
      { type: "text", name: "trigger_at" },
      { type: "text", name: "type" },
      { type: "select", name: "status", options: [{ name: "pending" }, { name: "fired" }, { name: "dismissed" }] },
      { type: "checkbox", name: "repeat_until_confirmed" },
      { type: "text", name: "last_fired_at" },
      { type: "text", name: "created_at" },
    ],
  },
  {
    name: "timeline",
    titleField: "activity_type",
    fields: [
      { type: "text", name: "activity_type" },
      { type: "text", name: "id" },
      { type: "text", name: "start_time" },
      { type: "text", name: "end_time" },
      { type: "text", name: "related_task_id" },
      { type: "text", name: "current_active_task" },
      { type: "text", name: "expected_next_action" },
      { type: "text", name: "checkin_status" },
      { type: "text", name: "interruption_reason" },
      { type: "text", name: "source" },
    ],
  },
  {
    name: "progress_logs",
    titleField: "project_name",
    fields: [
      { type: "text", name: "project_name" },
      { type: "text", name: "id" },
      { type: "text", name: "project_id" },
      { type: "text", name: "logged_at" },
      { type: "text", name: "delta" },
      { type: "number", name: "progress_after" },
      { type: "text", name: "note" },
    ],
  },
  {
    name: "user_rules",
    titleField: "name",
    fields: [
      { type: "text", name: "name" },
      { type: "text", name: "id" },
      { type: "text", name: "trigger_condition" },
      { type: "text", name: "message" },
      { type: "checkbox", name: "persistence" },
      { type: "number", name: "repeat_interval_min" },
      { type: "text", name: "stop_condition" },
      { type: "select", name: "status", options: [{ name: "active" }, { name: "paused" }] },
      { type: "text", name: "last_triggered_date" },
      { type: "text", name: "last_fired_at" },
      { type: "text", name: "confirmed_at" },
      { type: "text", name: "created_at" },
    ],
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

async function lark(args) {
  const { stdout } = await execFileAsync(LARK, args, {
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ""}` },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function larkSafe(args) {
  try {
    return await lark(args);
  } catch (e) {
    const msg = e.stderr || e.message || "";
    let errObj = null;
    try { errObj = JSON.parse(msg); } catch {}
    return { ok: false, _raw_error: errObj?.error || msg };
  }
}

function envValue(key) {
  const content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

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

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("====================================================");
  console.log("小柳 Agent — 飞书多维表格初始化");
  console.log("====================================================\n");

  // 0. 权限提示
  console.log("前置：确认飞书应用已开通以下所有权限（搜索 base 一次性全选）");
  for (const s of REQUIRED_SCOPES) console.log(`  • ${s}`);
  console.log("");

  // 1. 查找或创建 Base
  let baseToken = envValue("BITABLE_APP_TOKEN");
  let baseUrl = "";

  if (baseToken) {
    process.stdout.write(`Base token 已存在（${baseToken}），验证...`);
    const r = await larkSafe(["base", "+base-get", "--base-token", baseToken, "--as", "bot"]);
    if (r.ok !== false) {
      baseUrl = (r.data ?? r).base?.url || "";
      console.log(` ✅ ${baseUrl || baseToken}`);
    } else {
      console.log(" ❌ 无效，将重新创建");
      baseToken = null;
    }
  }

  if (!baseToken) {
    process.stdout.write(`创建 Base「${BASE_NAME}」...`);
    const r = await lark(["base", "+base-create", "--name", BASE_NAME, "--time-zone", "Asia/Shanghai", "--as", "bot"]);
    const d = r.data ?? r;
    baseToken = d.base?.base_token ?? d.base?.app_token;
    baseUrl = d.base?.url || "";
    if (!baseToken) throw new Error(`创建 Base 失败: ${JSON.stringify(r)}`);
    console.log(` ✅ ${baseUrl}`);
  }

  // 2. 获取已有表
  const listR = await lark(["base", "+table-list", "--base-token", baseToken, "--as", "bot"]);
  const existingTables = Object.fromEntries(
    ((listR.data ?? listR).tables ?? []).map((t) => [t.name, t.id])
  );

  // 3. 为每张表：创建 or 补字段
  const tableIds = {};

  for (const table of TABLES) {
    process.stdout.write(`\n表「${table.name}」`);

    let tableId = existingTables[table.name];

    if (!tableId) {
      // 创建新表（--fields 第一元素更新默认首列，其余新增）
      process.stdout.write("：新建...");
      const r = await lark([
        "base", "+table-create",
        "--base-token", baseToken,
        "--name", table.name,
        "--fields", JSON.stringify(table.fields),
        "--as", "bot",
      ]);
      const d = r.data ?? r;
      tableId = d.table?.id ?? d.table?.table_id;
      if (!tableId) throw new Error(`创建表「${table.name}」失败: ${JSON.stringify(r)}`);
      console.log(` ✅ ${tableId}`);
    } else {
      // 表已存在，补建缺失字段
      process.stdout.write(` 已存在（${tableId}），检查字段...`);
      const fr = await lark(["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "--as", "bot"]);
      const existingFields = new Set(
        ((fr.data ?? fr).fields ?? []).map((f) => f.name)
      );

      const missing = table.fields.filter((f) => !existingFields.has(f.name));
      if (missing.length === 0) {
        console.log(" 全部就绪 ✅");
      } else {
        console.log(`\n  缺少 ${missing.length} 个字段，补建：`);
        for (const field of missing) {
          process.stdout.write(`    +${field.name}...`);
          await lark([
            "base", "+field-create",
            "--base-token", baseToken,
            "--table-id", tableId,
            "--json", JSON.stringify(field),
            "--as", "bot",
          ]);
          console.log(" ✅");
        }
      }
    }

    tableIds[table.name] = tableId;
  }

  // 4. 写入 .env
  console.log("\n写入 .env...");
  writeEnvVars({
    STORAGE_BACKEND: "bitable",
    BITABLE_APP_TOKEN: baseToken,
    BITABLE_TABLE_TASKS: tableIds.tasks,
    BITABLE_TABLE_PROJECTS: tableIds.projects,
    BITABLE_TABLE_REMINDERS: tableIds.reminders,
    BITABLE_TABLE_TIMELINE: tableIds.timeline,
    BITABLE_TABLE_PROGRESS_LOGS: tableIds.progress_logs,
    BITABLE_TABLE_USER_RULES: tableIds.user_rules,
  });
  console.log("✅");

  // 5. 完成
  console.log("\n====================================================");
  console.log("初始化完成！");
  if (baseUrl) console.log(`Base 地址：${baseUrl}`);
  console.log("现在可以运行：npm start");
  console.log("====================================================");
}

main().catch((err) => {
  console.error("\n❌ 初始化失败:", err.message || err);
  process.exit(1);
});
