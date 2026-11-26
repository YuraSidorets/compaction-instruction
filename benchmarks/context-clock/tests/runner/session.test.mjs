// Persistent Claude session (one process, turns over stdin), snapshot channels, transcript hook counts, session modes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeProjectDir, hookChannel, hookTelemetry, openSession, parseStream, parseTranscriptHooks, userLine } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { startProcess } from "../../runner/proc.mjs";
import { EXIT, loadConfigs, parseArgs, runBatch, withHooks } from "../../runner/run.mjs";
import { HERE, TASKS, cleanup, readJson, readStream, tmp } from "./helpers.mjs";

const FAKE = join(HERE, "fixtures", "fake-claude.mjs");

function fakeSession(dir, extra = {}) {
  const launched = [];
  const start = (args, o) => {
    launched.push({ args, cwd: o.cwd, env: o.env });
    return startProcess({ cmd: process.execPath, args: [FAKE], ...o });
  };
  const env = { ...process.env, CTX_CLOCK: "1", CONTEXT_MODE_DATA_DIR: join(dir, "data") };
  delete env.NODE_TEST_CONTEXT;
  const s = openSession({ workspace: dir, env, model: "haiku", allowedTools: ["Read", "Bash"], rawDir: dir, start, ...extra });
  return { s, launched, env };
}

test("persistent: one process, turns split at result lines, one raw file per turn, same session id", async () => {
  const dir = tmp("sess");
  try {
    const { s, launched, env } = fakeSession(dir);
    const t1 = await s.runTurn({ prompt: "first", label: "intro", timeoutMs: 20000 });
    const t2 = await s.runTurn({ prompt: "second", label: "stage-1", timeoutMs: 20000, sessionId: t1.sessionId });
    assert.equal(launched.length, 1, "one process for the whole session");
    assert.deepEqual(launched[0].args.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    assert.equal(launched[0].env, env, "the mode environment goes to the one process unchanged");
    for (const [t, n] of [[t1, 1], [t2, 2]]) {
      assert.equal(t.exitCode, 0);
      assert.equal(t.timedOut, false);
      assert.equal(t.hasResult, true);
      assert.equal(t.sessionId, "fake-session-1");
      assert.equal(t.resultText, `reply ${n}`);
      assert.deepEqual(t.usage, { inputTokens: 10 * n, outputTokens: n, cacheReadTokens: 100, cacheCreationTokens: 5 });
      assert.deepEqual(t.toolCalls.map((c) => c.name), ["mcp__plugin_context-mode_context-mode__ctx_search"]);
      assert.equal(t.clockChannels.tool_reply.count, 1);
    }
    const intro = readFileSync(join(dir, "intro.jsonl"), "utf8");
    assert.match(intro, /SessionStart:startup/, "startup lines belong to the first turn");
    assert.doesNotMatch(readFileSync(join(dir, "stage-1.jsonl"), "utf8"), /SessionStart:startup/);
    assert.equal(intro.trim().split("\n").filter((l) => JSON.parse(l).type === "result").length, 1);
    const c = await s.compact({ label: "compact-1", timeoutMs: 20000, sessionId: t2.sessionId });
    assert.equal(c.confirmed, true);
    assert.match(c.mechanism, /stdin/);
    assert.deepEqual([c.clockChannels.session_start.count, c.clockSnapshots.count], [1, 1], "hook_progress repeats hook_response: counted once");
    const t3 = await s.runTurn({ prompt: "third", label: "final", timeoutMs: 20000 });
    assert.equal(t3.resultText, "reply 4");
    const closed = await s.close();
    assert.deepEqual(closed, { exitCode: 0, spawnError: null }, "stdin closes and the process exits");
  } finally {
    cleanup(dir);
  }
});

test("persistent: a turn timeout kills the process tree; later turns fail fast", async () => {
  const dir = tmp("sess-to");
  try {
    const { s } = fakeSession(dir);
    await s.runTurn({ prompt: "warm up", label: "intro", timeoutMs: 20000 });
    const t0 = Date.now();
    const r = await s.runTurn({ prompt: "HANG please", label: "stage-1", timeoutMs: 800 });
    assert.equal(r.timedOut, true);
    assert.equal(r.isError, true);
    assert.ok(Date.now() - t0 < 10000);
    assert.ok(existsSync(join(dir, "stage-1.jsonl")));
    const after = await s.runTurn({ prompt: "x", label: "stage-2", timeoutMs: 20000 });
    assert.equal(after.hasResult, false);
    assert.equal(after.isError, true);
    await s.close({ graceMs: 2000 });
  } finally {
    cleanup(dir);
  }
});

test("persistent: the process ends before a result line gives an error result with its exit code", async () => {
  const dir = tmp("sess-die");
  try {
    const { s } = fakeSession(dir);
    const r = await s.runTurn({ prompt: "DIE now", label: "intro", timeoutMs: 20000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.hasResult, false);
    assert.equal(r.exitCode, 7);
    assert.match(r.errorText, /session process ended \(exit 7\)/);
    await s.close({ graceMs: 2000 });
  } finally {
    cleanup(dir);
  }
});

test("resume mode opens no session; a user line has the stream-json input shape", () => {
  assert.equal(openSession({ sessionMode: "resume" }), null);
  assert.deepEqual(JSON.parse(userLine("hi")), { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
});

test("channels: SessionStart hooks, PostToolUse hooks, Context Mode tool replies, other blocks", () => {
  assert.equal(hookChannel("SessionStart:resume"), "session_start");
  assert.equal(hookChannel("PostToolUse"), "hook_context");
  assert.equal(hookChannel("PostToolUseFailure"), "hook_context");
  assert.equal(hookChannel("UserPromptSubmit"), "other");
  const ctx = (t) => JSON.stringify({ hookSpecificOutput: { additionalContext: t } });
  const lines = [
    { type: "system", subtype: "hook_progress", hook_id: "a", hook_event: "SessionStart", stdout: ctx("[context-clock] s1") },
    { type: "system", subtype: "hook_response", hook_id: "a", hook_event: "SessionStart", output: ctx("[context-clock] s1"), stdout: ctx("[context-clock] s1") },
    { type: "system", subtype: "hook_progress", hook_id: "lonely", hook_event: "SessionStart", stdout: ctx("[context-clock] s2") },
    { type: "system", subtype: "hook_response", hook_id: "b", hook_event: "PostToolUse", output: ctx("[context-clock] h1") },
    { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_context-mode_context-mode__ctx_search", input: {} }, { type: "tool_use", id: "t2", name: "Read", input: {} }, { type: "text", text: "[context-clock] model text" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[context-clock] r1" }, { type: "tool_result", tool_use_id: "t2", content: "[context-clock] in a file" }] } },
    { type: "result", subtype: "success", is_error: false, result: "[context-clock] final text", usage: {} },
  ].map((l) => JSON.stringify(l)).join("\n");
  const p = parseStream(lines);
  assert.deepEqual(Object.fromEntries(Object.entries(p.clockChannels).map(([k, v]) => [k, v.count])), { tool_reply: 1, hook_context: 1, session_start: 2, other: 1 });
  assert.equal(p.clockSnapshots.count, 5);
});

test("channels on the live persistent compaction sample: one session_start block, boundary, same session", () => {
  const p = parseStream(readStream("claude-persistent-compact.jsonl"));
  assert.equal(p.compactBoundary, true);
  assert.equal(p.hasResult, true);
  assert.equal(p.clockChannels.session_start.count, 1);
  assert.equal(p.clockSnapshots.count, 1);
});

test("hook context comes from the session transcript (the stream has no PostToolUse hook line)", () => {
  const home = tmp("home");
  const raw = tmp("raw");
  try {
    const ws = "C:\\Temp\\ccbench\\ws-1";
    assert.equal(encodeProjectDir(ws), "C--Temp-ccbench-ws-1");
    const text = [
      { type: "attachment", attachment: { type: "hook_cancelled", hookName: "PostToolUse:Read", hookEvent: "PostToolUse" } },
      { type: "attachment", attachment: { type: "hook_success", hookName: "PostToolUse:Bash", hookEvent: "PostToolUse" } },
      { type: "attachment", attachment: { type: "hook_additional_context", hookName: "PostToolUse:Bash", hookEvent: "PostToolUse", content: ["[context-clock] tick=3 seq=14"] } },
      { type: "attachment", attachment: { type: "hook_additional_context", hookName: "SessionStart", hookEvent: "SessionStart", content: ["[context-clock] tick=0"] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    assert.deepEqual(parseTranscriptHooks(text), { hookContext: { count: 1, bytes: Buffer.byteLength("[context-clock] tick=3 seq=14") }, postToolUse: { succeeded: 1, cancelled: 1, withContext: 1 } });
    mkdirSync(join(home, ".claude", "projects", encodeProjectDir(ws)), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", encodeProjectDir(ws), "sid-1.jsonl"), text);
    const h = hookTelemetry({ workspace: ws, sessionId: "sid-1", rawDir: raw, home });
    assert.equal(h.source, "transcript");
    assert.equal(h.hookContext.count, 1);
    assert.ok(existsSync(join(raw, "transcript.jsonl")), "the transcript is kept with the raw streams");
    assert.equal(hookTelemetry({ workspace: ws, sessionId: "missing", rawDir: raw, home }).source, "unavailable");
    const tm = { clockFeedbackCount: 2, clockFeedbackBytes: 20, clockFeedbackByChannel: { tool_reply: { count: 2, bytes: 20 }, hook_context: { count: 0, bytes: 0 }, session_start: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } } };
    const merged = withHooks(tm, h);
    assert.equal(merged.clockFeedbackByChannel.hook_context.count, 1);
    assert.equal(merged.clockFeedbackCount, 3);
    assert.equal(merged.clockFeedbackBytes, 20 + h.hookContext.bytes);
    assert.deepEqual(merged.clockHooks, { source: "transcript", postToolUse: { succeeded: 1, cancelled: 1, withContext: 1 } });
    assert.deepEqual(withHooks(tm, null).clockHooks, { source: "stream", postToolUse: null });
  } finally {
    cleanup(home, raw);
  }
});

test("--session-mode: persistent is the claude default, one session per attempt, closed; resume opens none", async () => {
  assert.equal(parseArgs(["--batch", "b", "--suite", "smoke", "--session-mode", "resume"]).sessionMode, "resume");
  assert.throws(() => parseArgs(["--batch", "b", "--suite", "smoke", "--session-mode", "forever"]), /--session-mode/);
  assert.throws(() => parseArgs(["--batch", "b", "--suite", "smoke", "--host", "codex", "--session-mode", "persistent"]), /needs --host claude/);
  for (const mode of ["persistent", "resume"]) {
    const results = tmp("sm");
    const work = tmp("smw");
    const sessions = [];
    try {
      const args = ["--batch", "t", "--suite", "smoke", "--mock", "--tasks", "T2-runner-compaction", "--modes", "B"];
      if (mode === "resume") args.push("--session-mode", "resume");
      const opts = { ...parseArgs(args), tasksDir: TASKS, resultsDir: results, workRoot: work };
      const r = await runBatch(opts, { host: createMockHost({ onSession: (x) => sessions.push(x) }), configs: loadConfigs(), log: () => {} });
      assert.equal(r.exitCode, EXIT.ok);
      const [rec] = r.records;
      assert.equal(rec.sessionMode, mode);
      assert.equal(readJson(join(results, "t", "batch.json")).sessionMode, mode);
      if (mode === "persistent") {
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].turns, rec.turns.length, "every turn and the compaction go through the one session");
        assert.equal(sessions[0].closed, true);
        assert.equal(sessions[0].mock.mode, "B");
      } else {
        assert.equal(sessions.length, 0);
      }
    } finally {
      cleanup(results, work);
    }
  }
});

test("a host without persistent sessions is rejected before any run starts", async () => {
  const results = tmp("nos");
  try {
    const host = createMockHost();
    const noSession = { runTurn: host.runTurn, compact: host.compact, hostInfo: host.hostInfo, toolInputs: host.toolInputs };
    const opts = { ...parseArgs(["--batch", "t", "--suite", "smoke", "--mock"]), tasksDir: TASKS, resultsDir: results };
    await assert.rejects(runBatch(opts, { host: noSession, configs: loadConfigs(), log: () => {} }), /no persistent session mode/);
  } finally {
    cleanup(results);
  }
});
