#!/usr/bin/env node
/**
 * 存储层冒烟测试
 * 用法：node scripts/test-storage.js [local|bitable]
 * 默认读取 .env 中的 STORAGE_BACKEND
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 手动加载 .env，避免依赖 dotenv 模块路径问题
function loadEnv() {
  try {
    const content = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

// 允许命令行覆盖 backend
const arg = process.argv[2];
if (arg === "local" || arg === "bitable") {
  process.env.STORAGE_BACKEND = arg;
}

const backend = process.env.STORAGE_BACKEND || "local";
console.log(`\n存储层冒烟测试 — backend: ${backend}\n`);

// 动态导入路由层
const storage = await import(resolve(ROOT, "src/storage/index.js"));

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name}...`);
  try {
    await fn();
    console.log(" ✅");
    passed++;
  } catch (e) {
    console.log(` ❌\n    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

// ── 测试数据（带随机后缀避免和真实数据冲突）──────────────────────────────────

const suffix = Date.now().toString(36);
const TEST_TASK = {
  id: `test-task-${suffix}`,
  title: `[TEST] 冒烟测试任务 ${suffix}`,
  project: null,
  category: "work",
  status: "pending",
  importance: "low",
  urgency: "low",
  estimated_duration_min: 30,
  hard_deadline: null,
  flexible_deadline: null,
  start_time: null,
  end_time: null,
  execution_mode: "focused",
  recurrence_rule: null,
  notes: "自动测试，可删除",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_touched_at: new Date().toISOString(),
};

// ── tasks 表测试 ──────────────────────────────────────────────────────────────

console.log("── tasks ──");

await test("create", async () => {
  const result = await storage.createItem("tasks", TEST_TASK);
  assert(result, "createItem 返回 null");
});

await test("getItem", async () => {
  const item = await storage.getItem("tasks", TEST_TASK.id);
  assert(item, "getItem 返回 null");
  assert(item.id === TEST_TASK.id, `id 不匹配: ${item.id}`);
  assert(item.title === TEST_TASK.title, `title 不匹配: ${item.title}`);
  assert(item.status === "pending", `status 不匹配: ${item.status}`);
});

await test("listItems（无 filter）", async () => {
  const items = await storage.listItems("tasks");
  assert(Array.isArray(items), "返回值不是数组");
  const found = items.find((i) => i.id === TEST_TASK.id);
  assert(found, "listItems 中找不到刚创建的记录");
});

await test("listItems（filter by status）", async () => {
  const items = await storage.listItems("tasks", { status: "pending" });
  assert(Array.isArray(items), "返回值不是数组");
  const found = items.find((i) => i.id === TEST_TASK.id);
  assert(found, "filter status=pending 时找不到记录");
  const wrongStatus = items.find((i) => i.status !== "pending");
  assert(!wrongStatus, `filter 未生效，混入 status=${wrongStatus?.status} 的记录`);
});

await test("updateItem", async () => {
  const updated = await storage.updateItem("tasks", TEST_TASK.id, {
    status: "in_progress",
    notes: "已更新",
  });
  assert(updated, "updateItem 返回 null");
  assert(updated.status === "in_progress", `status 未更新: ${updated.status}`);
});

await test("getItem after update", async () => {
  const item = await storage.getItem("tasks", TEST_TASK.id);
  assert(item.status === "in_progress", `更新后 status 仍为 ${item.status}`);
});

await test("deleteItem", async () => {
  const result = await storage.deleteItem("tasks", TEST_TASK.id);
  assert(result === true, "deleteItem 返回 false");
});

await test("getItem after delete", async () => {
  const item = await storage.getItem("tasks", TEST_TASK.id);
  assert(item === null, "删除后 getItem 仍返回数据");
});

await test("deleteItem 不存在的 id", async () => {
  const result = await storage.deleteItem("tasks", `nonexistent-${suffix}`);
  assert(result === false, "删除不存在的 id 应返回 false");
});

// ── projects 表基础读写 ───────────────────────────────────────────────────────

console.log("\n── projects ──");

const TEST_PROJECT = {
  id: `test-proj-${suffix}`,
  name: `[TEST] 冒烟项目 ${suffix}`,
  description: "自动测试",
  status: "active",
  progress_type: "percentage",
  progress_total: 100,
  progress_unit: "%",
  progress_done: 0,
  progress_percent: 0,
  created_at: new Date().toISOString(),
};

await test("create + get + delete", async () => {
  await storage.createItem("projects", TEST_PROJECT);
  const item = await storage.getItem("projects", TEST_PROJECT.id);
  assert(item?.id === TEST_PROJECT.id, "create/get 失败");
  const del = await storage.deleteItem("projects", TEST_PROJECT.id);
  assert(del === true, "delete 失败");
  const gone = await storage.getItem("projects", TEST_PROJECT.id);
  assert(gone === null, "delete 后仍可读取");
});

// ── 汇总 ──────────────────────────────────────────────────────────────────────

console.log(`\n结果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
