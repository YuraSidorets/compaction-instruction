// v0.5 file mode of the state block (EXPERIMENT-V05.md, arm H): CCB_RETURN_STATE=file and CCB_STATE_FILE pointing to
// the agent's <workspace>/clock-state.md. Also the guard rule for that file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, FULL_BLOCK, tempDir, writeScript } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const S = await import(pathToFileURL(path.join(OVERLAY_DIR, "state-block.mjs")).href);
const G = await import(pathToFileURL(path.join(OVERLAY_DIR, "guard.mjs")).href);
const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const dir = tempDir("ccb-state-file-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const ARGS = ["--agent", "claude-code"];
const WS = path.join(dir, "ws");
mkdirSync(WS, { recursive: true });
const STATE = path.join(WS, "clock-state.md");

const PRODUCT = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "product rules\n" + FULL_BLOCK } });
const payload = (source) => JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", ...(source === null ? {} : { source }) });

function envFor(extra) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: PRODUCT, CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", ...extra };
  for (const k of ["CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"]) if (!(k in extra)) delete env[k];
  return env;
}
const shim = (extra, source = "compact") => run([SHIM, HOOK, ...ARGS], { env: envFor({ CCB_RETURN_STATE: "file", CCB_STATE_FILE: STATE, ...extra }), pieces: [payload(source)] });
const stateLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.channel === "state_block") : []);
const ctxOf = (r) => JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;

test("arm file: the agent's state file is appended after the product text; log has no text", async () => {
  const log = path.join(dir, "deliver.jsonl");
  const text = "summary: deploy on step 3\nfinding 1 (reported claim, not verified): owner ops-7\n";
  writeFileSync(STATE, text);
  const r = await shim({ CCB_SHIM_LOG: log });
  assert.equal(r.code, 0);
  const w = S.wrapStateText(text);
  assert.equal(ctxOf(r), "product rules\n" + FULL_BLOCK + "\n" + w.text);
  const [l] = stateLines(log);
  assert.deepEqual({ ...l, t: 0 }, { t: 0, channel: "state_block", event: "SessionStart", arm: "file", delivered: true, bytes: w.bytes, findings: 0, cut: false });
  assert.ok(!readFileSync(log, "utf8").includes("ops-7"));
});

test("arm file: missing, empty or unreadable file appends nothing and keeps the product reply", async () => {
  const log = path.join(dir, "missing.jsonl");
  const missing = path.join(WS, "no-such", "clock-state.md");
  const empty = path.join(dir, "empty-state.md");
  writeFileSync(empty, " \n\n");
  const folder = path.join(dir, "folder-state.md");
  mkdirSync(folder, { recursive: true });
  for (const f of [missing, empty, folder]) {
    const r = await shim({ CCB_STATE_FILE: f, CCB_SHIM_LOG: log });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), PRODUCT);
  }
  const lines = stateLines(log);
  assert.deepEqual(lines.map((l) => [l.arm, l.delivered, l.bytes, l.error]), [["file", false, 0, undefined], ["file", false, 0, undefined], ["file", false, 0, undefined]]);
  assert.equal(typeof lines[2].readError, "string", "an unreadable file logs its code, not a shim error");
});

test("arm file: a long file is cut at a line end inside 2000 bytes", async () => {
  const log = path.join(dir, "cut.jsonl");
  const lines = Array.from({ length: 300 }, (_, i) => `item${i}: value ${i} ü`);
  writeFileSync(STATE, lines.join("\n"));
  const r = await shim({ CCB_SHIM_LOG: log });
  const ctx = ctxOf(r);
  const block = ctx.slice(ctx.indexOf("\n[committed-state]\n") + 1);
  assert.ok(Buffer.byteLength(block) <= 2000);
  assert.ok(block.endsWith("\n[/committed-state]"));
  const body = block.split("\n").slice(1, -1);
  body.forEach((l, i) => assert.equal(l, lines[i]), "whole lines only");
  const [l] = stateLines(log);
  assert.equal(l.cut, true);
  assert.equal(l.bytes, Buffer.byteLength(block));
  // a file far past the read cap is still cut, and still marked cut
  writeFileSync(STATE, "a: b\n" + "x".repeat(200_000));
  const r2 = await shim({ CCB_SHIM_LOG: log });
  assert.ok(ctxOf(r2).endsWith("\n[committed-state]\na: b\n[/committed-state]"));
  assert.equal(stateLines(log)[1].cut, true);
});

test("arm file: a SessionStart with another source stays unchanged", async () => {
  const log = path.join(dir, "other.jsonl");
  writeFileSync(STATE, "stage: 2\n");
  for (const source of ["startup", "resume", "clear", null]) {
    const r = await shim({ CCB_SHIM_LOG: log }, source);
    assert.equal(r.stdout.toString("utf8"), PRODUCT);
  }
  assert.deepEqual(stateLines(log), []);
});

test("arm file: CCB_STATE_FILE unset is a shim error; the product reply still goes out", async () => {
  const log = path.join(dir, "unset.jsonl");
  const env = envFor({ CCB_RETURN_STATE: "file", CCB_SHIM_LOG: log });
  const r = await run([SHIM, HOOK, ...ARGS], { env, pieces: [payload("compact")] });
  assert.equal(r.stdout.toString("utf8"), PRODUCT);
  const [l] = stateLines(log);
  assert.equal(l.delivered, false);
  assert.equal(typeof l.error, "string");
});

// ---------- guard ----------

for (const ctx of [
  { workspace: "C:\\Temp\\ccb-run-1\\ws", overlayDir: "C:\\Temp\\ccb-run-1\\overlay", home: "C:\\Users\\tester", temp: "C:\\Temp", platform: "win32", other: "C:\\Temp\\ccb-run-2\\ws\\clock-state.md", home2: "C:\\Users\\tester\\clock-state.md" },
  { workspace: "/tmp/ccb-run-1/ws", overlayDir: "/tmp/ccb-run-1/overlay", home: "/home/tester", temp: "/tmp", platform: "linux", other: "/tmp/ccb-run-2/ws/clock-state.md", home2: "/home/tester/clock-state.md" },
]) {
  test(`guard (${ctx.platform}): clock-state.md is writable in the workspace and denied outside it`, () => {
    const ok = (tool, input) => G.guardDecision({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }, ctx).allow;
    const inside = ctx.platform === "win32" ? ctx.workspace + "\\clock-state.md" : ctx.workspace + "/clock-state.md";
    for (const p of ["clock-state.md", "./clock-state.md", inside]) {
      assert.equal(ok("Write", { file_path: p, content: "summary: x\n" }), true, `Write ${p}`);
      assert.equal(ok("Edit", { file_path: p, old_string: "a", new_string: "b" }), true, `Edit ${p}`);
      assert.equal(ok("Read", { file_path: p }), true, `Read ${p}`);
    }
    assert.equal(ok("Bash", { command: "cat clock-state.md" }), true);
    for (const p of [ctx.other, ctx.home2, "../clock-state.md", "~/clock-state.md"]) {
      assert.equal(ok("Write", { file_path: p, content: "x" }), false, `Write ${p}`);
      assert.equal(ok("Edit", { file_path: p, old_string: "a", new_string: "b" }), false, `Edit ${p}`);
    }
    assert.equal(ok("Bash", { command: "echo x > ../clock-state.md" }), false);
  });
}
