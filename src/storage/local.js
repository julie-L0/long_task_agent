import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "../core/config.js";

function filePath(collection) {
  return resolve(config.dataDir, `${collection}.json`);
}

function readCollection(collection) {
  const fp = filePath(collection);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, "utf8");
  return JSON.parse(raw || "[]");
}

function writeCollection(collection, data) {
  writeFileSync(filePath(collection), JSON.stringify(data, null, 2), "utf8");
}

export function listItems(collection, filter = {}) {
  let items = readCollection(collection);
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

export function getItem(collection, id) {
  const items = readCollection(collection);
  return items.find((item) => item.id === id) || null;
}

export function createItem(collection, item) {
  const items = readCollection(collection);
  items.push(item);
  writeCollection(collection, items);
  return item;
}

export function updateItem(collection, id, updates) {
  const items = readCollection(collection);
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  items[index] = { ...items[index], ...updates, updated_at: new Date().toISOString() };
  writeCollection(collection, items);
  return items[index];
}

export function deleteItem(collection, id) {
  const items = readCollection(collection);
  const filtered = items.filter((item) => item.id !== id);
  if (filtered.length === items.length) return false;
  writeCollection(collection, filtered);
  return true;
}
