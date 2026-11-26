// The turn timeout kills the whole process tree of a fake slow host.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runProcess } from "../../runner/proc.mjs";
import { cleanup, tmp } from "./helpers.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("a fake slow host and its child are killed at the timeout", async () => {
  const dir = tmp("proc");
  try {
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "slow-host.mjs");
    writeFileSync(script, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      'process.stdout.write("started\\n");',
      "setTimeout(() => {}, 120000);",
    ].join("\n"));
    const t0 = Date.now();
    const r = await runProcess({ cmd: process.execPath, args: [script], cwd: dir, env: process.env, timeoutMs: 1500, stdoutPath: join(dir, "out.txt"), stderrPath: join(dir, "err.txt") });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 15000, "the runner does not wait for the host");
    assert.match(r.stdout, /started/);
    assert.ok(existsSync(join(dir, "out.txt")));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await until(() => !alive(pid), 5000), `grandchild ${pid} is still alive`);
  } finally {
    cleanup(dir);
  }
});

test("a normal process returns its exit code, stdout and the stdin text", async () => {
  const r = await runProcess({ cmd: process.execPath, args: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.exit(3)})"], cwd: process.cwd(), env: process.env, input: "hello", timeoutMs: 20000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "HELLO");
});

test("a missing command gives a spawn error, not a throw", async () => {
  const r = await runProcess({ cmd: "ccbench-no-such-command-xyz", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
  assert.ok(r.spawnError);
  assert.notEqual(r.exitCode, 0);
});
