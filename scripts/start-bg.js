#!/usr/bin/env node
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { closeSync, openSync } from "fs";
import { tmpdir } from "os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logFile = resolve(tmpdir(), "xiaoliu.log");
const out = openSync(logFile, "a");

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
