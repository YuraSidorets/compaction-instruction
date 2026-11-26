// Shared helpers of the runner tests. Every temporary folder is outside the repository.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = resolve(HERE, "..", "..");
export const TASKS = join(HERE, "fixtures", "task-files");
export const STREAMS = join(HERE, "fixtures", "streams");

export function tmp(prefix) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `ccbench-test-${prefix}-`)));
}

export function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

export function readTask(id) {
  return JSON.parse(readFileSync(join(TASKS, `${id}.task.json`), "utf8"));
}

export function readStream(name) {
  return readFileSync(join(STREAMS, name), "utf8");
}

export function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
