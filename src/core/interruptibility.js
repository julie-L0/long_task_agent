import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import dayjs from "dayjs";
import { config } from "./config.js";

const STATE_FILE = resolve(config.dataDir, "interruptibility.json");

const DEFAULT_STATE = {
  status: "open", // open | dnd_until_time | dnd_until_user_confirms
  until: null,    // ISO8601, only for dnd_until_time
  reason: null,   // what user is doing
  set_by: "system", // user | system
  updated_at: null,
};

export function getState() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function setState(status, { until = null, reason = null, set_by = "system" } = {}) {
  const state = {
    status,
    until: status === "dnd_until_time" ? until : null,
    reason: reason || null,
    set_by,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  return state;
}

const DND_MAX_HOURS = 4;

export function autoExpire() {
  const state = getState();
  if (state.status === "dnd_until_time" && state.until) {
    if (dayjs().isAfter(dayjs(state.until))) {
      return setState("open", { set_by: "system", reason: null });
    }
  }
  if (state.status === "dnd_until_user_confirms" && state.updated_at) {
    if (dayjs().diff(dayjs(state.updated_at), "hour") >= DND_MAX_HOURS) {
      return setState("open", { set_by: "system", reason: null });
    }
  }
  return state;
}

// No hardcoded mapping — agent decides based on user-defined rules.
export function inferFromActivity(_activityType) {
  return getState();
}

export function isInterruptible() {
  return getState().status === "open";
}
