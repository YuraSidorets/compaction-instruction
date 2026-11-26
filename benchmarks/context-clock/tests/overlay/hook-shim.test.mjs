import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { OVERLAY_DIR, FULL_BLOCK, LINE_FORM, tempDir, writeScript, bytesOf } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const dir = tempDir("ccb-hook-shim-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const ARGS = ["--agent", "claude-code"];

const payload = (event) => JSON.stringify({ hook_event_name: event, session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
const reply = (event, ctx, extra = {}) => JSON.stringify({ ...extra, hookSpecificOutput: { hookEventName: event, additionalContext: ctx } });

function envFor(mode, stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, FAKE_MARK: "m1", ...extra };
  delete env.CCB_FEEDBACK;
  if (mode === "D") env.CCB_FEEDBACK = "placebo";
  return env;
}
const logLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const CASES = [
  ["PostToolUse", reply("PostToolUse", "indexed.\n" + FULL_BLOCK, { decision: undefined })],
  ["PostToolUseFailure", reply("PostToolUseFailure", LINE_FORM)],
  ["SessionStart", reply("SessionStart", "rules\n" + FULL_BLOCK)],
  ["PreToolUse", ""],
  ["PostToolUse", "not json output\n  with spaces  "],
  ["PostToolUse", "{\n  \"hookSpecificOutput\" : { \"hookEventName\": \"PostToolUse\" }\n}\n"],
];

for (const mode of ["B", "C"]) {
  test(`mode ${mode}: byte-transparent (stdout, stderr, exit code, args, env)`, async () => {
    const log = path.join(dir, `log-${mode}.jsonl`);
    for (const [event, out] of CASES) {
      for (const exit of ["0", "2"]) {
        const extra = { FAKE_HOOK_EXIT: exit, CTX_CLOCK: "1", ...(mode === "B" ? { CTX_CLOCK_FEEDBACK: "off" } : {}) };
        const direct = await run([HOOK, ...ARGS], { env: envFor(mode, out, extra), pieces: [payload(event)] });
        const shim = await run([SHIM, HOOK, ...ARGS], { env: envFor(mode, out, { ...extra, CCB_SHIM_LOG: log }), pieces: [payload(event)] });
        assert.ok(shim.stdout.equals(direct.stdout), `${event} stdout identical`);
        assert.equal(shim.stderr, direct.stderr, `${event} stderr identical`);
        assert.equal(shim.code, Number(exit), `${event} exit code kept`);
        assert.ok(shim.stderr.includes('argv=["--agent","claude-code"]') && shim.stderr.includes("mark=m1"));
      }
    }
    const lines = logLines(log);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => l.mode !== "placebo"));
    assert.ok(lines.some((l) => l.channel === "session_start" && l.mode === "real"));
    assert.ok(lines.some((l) => l.channel === "hook_context" && l.mode === "real" && l.event === "PostToolUse"));
    assert.ok(!lines.some((l) => l.event === "PreToolUse"), "only delivery events are logged");
    assert.ok(!readFileSync(log, "utf8").includes("indexed."));
  });
}

test("mode D: PostToolUse and PostToolUseFailure get the placebo; the text before it stays", async () => {
  const log = path.join(dir, "log-D.jsonl");
  const out1 = reply("PostToolUse", "indexed.\n" + FULL_BLOCK);
  const r1 = await run([SHIM, HOOK, ...ARGS], { env: envFor("D", out1, { CCB_SHIM_LOG: log }), pieces: [payload("PostToolUse")] });
  assert.equal(r1.code, 0);
  const j1 = JSON.parse(r1.stdout.toString("utf8"));
  const ctx = j1.hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith("indexed.\n[context-note]"));
  assert.equal(bytesOf(ctx), bytesOf("indexed.\n" + FULL_BLOCK));
  assert.equal(j1.hookSpecificOutput.hookEventName, "PostToolUse");

  const out2 = reply("PostToolUseFailure", LINE_FORM);
  const r2 = await run([SHIM, HOOK, ...ARGS], { env: envFor("D", out2, { CCB_SHIM_LOG: log, FAKE_HOOK_EXIT: "1" }), pieces: [payload("PostToolUseFailure")] });
  assert.equal(r2.code, 1);
  const ctx2 = JSON.parse(r2.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
  assert.equal(bytesOf(ctx2), bytesOf(LINE_FORM));
  assert.ok(!ctx2.includes("context-clock"));

  const lines = logLines(log);
  assert.deepEqual(lines.map((l) => [l.channel, l.event, l.mode, l.replaced]), [["hook_context", "PostToolUse", "placebo", 1], ["hook_context", "PostToolUseFailure", "placebo", 1]]);
  assert.equal(lines[0].originalBytes, bytesOf(FULL_BLOCK));
  assert.equal(lines[0].deliveredBytes, bytesOf(FULL_BLOCK));
  const text = readFileSync(log, "utf8");
  assert.ok(!text.includes("indexed.") && !text.includes("context-note"), "log holds no text");
});

test("mode D: SessionStart reply is never changed", async () => {
  const log = path.join(dir, "log-D-ss.jsonl");
  const out = reply("SessionStart", "rules\n" + FULL_BLOCK);
  const r = await run([SHIM, HOOK, ...ARGS], { env: envFor("D", out, { CCB_SHIM_LOG: log }), pieces: [payload("SessionStart")] });
  assert.equal(r.stdout.toString("utf8"), out);
  const [l] = logLines(log);
  assert.equal(l.channel, "session_start");
  assert.equal(l.mode, "real");
  assert.equal(l.replaced, 0);
});

test("mode D fails closed: no real snapshot passes, the error is logged", async () => {
  const log = path.join(dir, "log-D-fail.jsonl");
  const broken = FULL_BLOCK.split("\n").slice(0, -1).join("\n");
  const cases = [
    reply("PostToolUse", "keep me\n" + broken),
    reply("PostToolUse", broken),
    "garbage " + LINE_FORM,
    JSON.stringify({ systemMessage: LINE_FORM, hookSpecificOutput: { hookEventName: "PostToolUse" } }),
  ];
  const outs = [];
  for (const out of cases) {
    const r = await run([SHIM, HOOK, ...ARGS], { env: envFor("D", out, { CCB_SHIM_LOG: log }), pieces: [payload("PostToolUse")] });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.toString("utf8").includes("context-clock"));
    outs.push(r.stdout.toString("utf8"));
  }
  assert.equal(JSON.parse(outs[0]).hookSpecificOutput.additionalContext, "keep me");
  assert.equal(JSON.parse(outs[1]).hookSpecificOutput.additionalContext, undefined);
  assert.equal(outs[2], "");
  const lines = logLines(log);
  assert.equal(lines.length, 4);
  for (const l of lines) assert.ok(typeof l.error === "string");
  assert.ok(!readFileSync(log, "utf8").includes("keep me"));
});

test("latency: the shim adds well under the 5 s hook timeout", async () => {
  const out = reply("PostToolUse", "x\n" + FULL_BLOCK);
  // The shim costs one extra node start (about 0.3 to 0.6 s on a Windows host with a virus scanner). An absolute limit
  // fails when the whole suite runs in parallel and every node start is slow, so the test pairs each shim run with a
  // direct run under the same load and holds the median added time below the 5 s hook timeout, with 1 s left for
  // the hook itself. Measured on the Windows host: 0.4 to 0.6 s alone, 1.6 to 2.5 s while the full suite runs.
  const added = [];
  for (let i = 0; i < 5; i++) {
    const direct = await run([HOOK, ...ARGS], { env: envFor("D", out), pieces: [payload("PostToolUse")] });
    const shim = await run([SHIM, HOOK, ...ARGS], { env: envFor("D", out), pieces: [payload("PostToolUse")] });
    added.push(shim.ms - direct.ms);
  }
  added.sort((a, b) => a - b);
  assert.ok(added[2] < 4000,`median added time ${added[2]} ms (all: ${added.join(", ")})`);
});
