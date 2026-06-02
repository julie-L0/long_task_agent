#!/usr/bin/env node
import { execFileSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { closeSync, openSync } from "fs";
import { tmpdir } from "os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logFile = resolve(tmpdir(), "xiaoliu.log");
const out = openSync(logFile, "a");

function commandOutput(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function normalizePath(path) {
  return path.replace(/\/+$/, "");
}

function listAgentPids() {
  const rows = commandOutput("lsof", ["-c", "node", "-Fn"]);
  const agents = [];
  let current = null;

  for (const row of rows.split("\n")) {
    if (row.startsWith("p")) {
      if (current) agents.push(current);
      current = { pid: Number(row.slice(1)), paths: [] };
    } else if (current && row.startsWith("n")) {
      current.paths.push(row.slice(1));
    }
  }
  if (current) agents.push(current);

  return agents
    .filter((agent) => Number.isInteger(agent.pid) && agent.pid > 0 && agent.pid !== process.pid)
    .filter((agent) => agent.paths.some((path) => normalizePath(path) === normalizePath(ROOT)))
    .filter((agent) => agent.paths.some((path) => path.endsWith("/xiaoliu.log")))
    .map((agent) => agent.pid);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !processExists(pid);
}

async function stopExistingAgents() {
  const pids = listAgentPids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  for (const pid of pids) {
    if (!(await waitUntilGone(pid, 1500))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await waitUntilGone(pid, 500);
    }
    console.log(`[guard] stopped old agent pid ${pid}`);
  }
}

await stopExistingAgents();

const child = spawn(process.execPath, [resolve(ROOT, "src/index.js")], {
  cwd: ROOT,
  stdio: ["ignore", out, out],
  detached: true,
  env: { ...process.env },
});

child.unref();
closeSync(out);
console.log(`PID: ${child.pid}`);
console.log(`Log: ${logFile}`);
