import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

function findLarkCli() {
  if (process.env.LARK_CLI_PATH && existsSync(process.env.LARK_CLI_PATH)) return process.env.LARK_CLI_PATH;
  const candidates = process.platform === "win32"
    ? ["lark-cli.exe", `${process.env.LOCALAPPDATA || ""}\\lark-cli\\lark-cli.exe`]
    : ["/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli"];
  for (const p of candidates) { if (p && existsSync(p)) return p; }
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["lark-cli"], { encoding: "utf8" }).trim().split("\n")[0];
  } catch { return "lark-cli"; }
}

const LARK_CLI = findLarkCli();

function baseToken() {
  const t = process.env.BITABLE_APP_TOKEN;
  if (!t) throw new Error("Missing env: BITABLE_APP_TOKEN");
  return t;
}

function tableId(collection) {
  const key = `BITABLE_TABLE_${collection.toUpperCase()}`;
  const id = process.env[key];
  if (!id) throw new Error(`Missing env: ${key}`);
  return id;
}

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

async function lark(args) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout } = await execFileAsync(LARK_CLI, args, {
        env: { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });
      const result = JSON.parse(stdout);
      if (result.ok === false) {
        const msg = result.error?.message || "unknown";
        if (attempt < MAX_RETRIES && /timed out|ECONNRESET|ETIMEDOUT|5\d\d/.test(msg)) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`飞书接口错误: ${result.error?.hint || msg}`);
      }
      return result;
    } catch (e) {
      if (attempt < MAX_RETRIES && /timed out|ECONNRESET|ETIMEDOUT|killed/.test(e.message)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      // Sanitize error for user-facing display
      const clean = e.message.replace(/https?:\/\/[^\s"]+/g, "[飞书API]").replace(/\d+\.\d+\.\d+\.\d+:\d+/g, "[addr]");
      throw new Error(`飞书暂时连不上（${clean.slice(0, 80)}）`);
    }
  }
}

// +record-list --format json returns tabular data, not {record_id, fields} objects.
// Normalise a single cell value to a plain JS primitive.
function normalise(value) {
  if (value === null || value === undefined) return null;
  // Single/multi select comes back as an array of option names; unwrap single.
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return value[0];
    return value; // multi-select stays as array
  }
  return value;
}

function fromRecord(record) {
  const item = {};
  for (const [key, value] of Object.entries(record.fields || {})) {
    item[key] = normalise(value);
  }
  item._record_id = record.record_id;
  return item;
}

// Parse the tabular response from +record-list --format json into our item format.
function parseTabular(result) {
  const d = result.data ?? result;
  const fields = d.fields ?? [];
  const rows = d.data ?? [];
  const recordIds = d.record_id_list ?? [];

  return rows.map((row, i) => {
    const item = { _record_id: recordIds[i] ?? null };
    fields.forEach((name, j) => {
      item[name] = normalise(row[j]);
    });
    return item;
  });
}

function toCellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  return String(value);
}

async function allRecords(collection) {
  const base = baseToken();
  const tbl = tableId(collection);
  const PAGE = 200;
  const items = [];
  let offset = 0;

  while (true) {
    const result = await lark([
      "base", "+record-list",
      "--base-token", base,
      "--table-id", tbl,
      "--limit", String(PAGE),
      "--offset", String(offset),
      "--format", "json",
      "--as", "bot",
    ]);
    const page = parseTabular(result);
    items.push(...page);
    const hasMore = (result.data ?? result).has_more;
    if (!hasMore || page.length < PAGE) break;
    offset += PAGE;
  }
  return items;
}

async function findRecordId(collection, id) {
  const items = await allRecords(collection);
  const found = items.find((item) => item.id === id);
  return found?._record_id ?? null;
}

export async function listItems(collection, filter = {}) {
  let items = await allRecords(collection);

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      items = items.filter((item) => value.includes(item[key]));
    } else {
      items = items.filter((item) => item[key] === value);
    }
  }
  return items;
}

export async function getItem(collection, id) {
  const items = await allRecords(collection);
  return items.find((item) => item.id === id) ?? null;
}

export async function createItem(collection, item) {
  const fields = Object.keys(item).filter((k) => !k.startsWith("_"));
  const row = fields.map((f) => toCellValue(item[f]));

  await lark([
    "base", "+record-batch-create",
    "--base-token", baseToken(),
    "--table-id", tableId(collection),
    "--json", JSON.stringify({ fields, rows: [row] }),
    "--as", "bot",
  ]);
  return item;
}

export async function updateItem(collection, id, updates) {
  const items = await allRecords(collection);
  const existing = items.find((item) => item.id === id);
  if (!existing) return null;

  const patch = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith("_")) continue;
    patch[key] = toCellValue(value);
  }

  await lark([
    "base", "+record-batch-update",
    "--base-token", baseToken(),
    "--table-id", tableId(collection),
    "--json", JSON.stringify({ record_id_list: [existing._record_id], patch }),
    "--as", "bot",
  ]);

  // Return merged result — avoids re-reading tabular format which may omit zero-value columns
  const result = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (!key.startsWith("_")) result[key] = value;
  }
  return result;
}

export async function deleteItem(collection, id) {
  const recordId = await findRecordId(collection, id);
  if (!recordId) return false;

  await lark([
    "base", "+record-delete",
    "--base-token", baseToken(),
    "--table-id", tableId(collection),
    "--record-id", recordId,
    "--yes",
    "--as", "bot",
  ]);
  return true;
}
