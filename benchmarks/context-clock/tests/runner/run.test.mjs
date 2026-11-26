// End-to-end runner tests with the mock host only. No model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { EXIT, isFinal, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { listFilesRel } from "../../runner/workspace.mjs";
import { BENCH, TASKS, cleanup, readJson, tmp } from "./helpers.mjs";

const RUN_KEYS = ["schema", "runId", "batch", "host", "taskId", "mode", "rep", "profile", "order", "status", "failure", "attempts", "startedAt", "durationMs", "cli", "env", "sessionId", "turns", "compactions", "answers", "telemetry", "integrity", "sessionMode", "overlay", "limits", "limitHit", "session"];
const TURN_KEYS = ["kind", "stage", "exitCode", "timedOut", "durationMs", "usage", "toolCalls", "clockSnapshots", "compactBoundary", "clockSnapshotsByChannel"];
const TELEMETRY_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "toolCalls", "toolCallsByName", "clockFeedbackCount", "clockFeedbackBytes", "clockFeedbackByChannel", "clock", "searchCalls", "clockHooks", "shim", "guard", "stateBlock", "commits", "stateFile", "triggers", "costUsd"];

function setup(extraArgs = [], configPatch = null) {
  const results = tmp("res");
  const work = tmp("work");
  const opts = { ...parseArgs(["--batch", "t", "--suite", "smoke", "--mock", ...extraArgs]), tasksDir: TASKS, resultsDir: results, workRoot: work };
  const configs = loadConfigs();
  if (configPatch) Object.assign(configs.hosts.mock, configPatch);
  return { results, work, opts, configs, done: () => cleanup(results, work) };
}

const quiet = () => {};
const runs = (results) => readdirSync(join(results, "t", "runs")).map((id) => readJson(join(results, "t", "runs", id, "run.json")));

function failTurn(extra) {
  return {
    exitCode: 1, timedOut: false, durationMs: 1, sessionId: null, resultText: "",
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    toolCalls: [], compactBoundary: false, clockSnapshots: { count: 0, bytes: 0 }, isError: true, rateLimited: false, errorText: "boom", ...extra,
  };
}

test("mock smoke batch: every run completes and run.json follows the contract schema", async () => {
  const s = setup();
  try {
    const r = await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    assert.equal(r.exitCode, EXIT.ok);
    assert.equal(r.done, 6);
    for (const rec of runs(s.results)) {
      assert.deepEqual(Object.keys(rec), RUN_KEYS);
      assert.equal(rec.status, "completed");
      assert.deepEqual(rec.attempts.map((a) => [a.attempt, a.status]), [[1, "completed"]]);
      assert.match(rec.runId, /^claude__T[12]-runner-(long|compaction)__[ABC]__r1$/);
      // EXPERIMENT-V05.md: a compact turn also records whether the compaction instruction was sent.
      for (const t of rec.turns) assert.deepEqual(Object.keys(t), t.kind === "compact" ? [...TURN_KEYS, "compactInstruction", "costUsd", "contextTokens"] : [...TURN_KEYS, "costUsd", "contextTokens"]);
      assert.deepEqual(Object.keys(rec.telemetry), TELEMETRY_KEYS);
      assert.deepEqual(Object.keys(rec.telemetry.clock), ["events", "maxTick", "stateRevision", "statusCalls", "commitCalls"]);
      assert.deepEqual(rec.integrity, { violations: [] });
      const kinds = rec.turns.map((t) => (t.stage ? `${t.kind}-${t.stage}` : t.kind));
      if (rec.profile === "long") {
        assert.deepEqual(kinds, ["intro", "stage-1", "stage-2", "final"]);
        assert.deepEqual(rec.compactions, []);
        assert.equal(rec.answers.checkpoint, null);
      } else {
        assert.deepEqual(kinds, ["intro", "stage-1", "stage-2", "checkpoint-2", "compact-2", "stage-3", "final"]);
        assert.deepEqual(rec.compactions.map((c) => [c.afterStage, c.confirmed]), [[2, true]]);
        assert.deepEqual(rec.answers.checkpoint, { c1: 0 });
      }
      assert.equal(rec.answers.finalParseError, null);
      assert.equal(Object.keys(rec.answers.final).length, 5);
      const env = { A: { CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }, B: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }, C: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null } }[rec.mode];
      assert.deepEqual(rec.env, env);
      const ch = rec.telemetry.clockFeedbackByChannel;
      assert.equal(ch.tool_reply.count > 0, rec.mode === "C", "only mode C gets tool reply snapshots in the mock");
      assert.equal(ch.session_start.count > 0, rec.mode !== "A" && rec.profile === "compaction", "the compaction SessionStart block reaches modes B and C");
      assert.equal(ch.hook_context.count, 0);
      assert.equal(rec.telemetry.clockFeedbackCount, ch.tool_reply.count + ch.hook_context.count + ch.session_start.count + ch.other.count);
      assert.equal(rec.sessionMode, "persistent");
      assert.ok(rec.telemetry.searchCalls >= 1);
      assert.ok(existsSync(join(s.results, "t", "raw", rec.runId, "a1", "final.jsonl")));
    }
    const batch = readJson(join(s.results, "t", "batch.json"));
    assert.equal(batch.mock, true);
    assert.equal(batch.runOrder.length, 6);
    assert.equal("invocations" in batch, false, "wall times stay out of batch.json");
    assert.equal(readJson(join(s.results, "t", "invocations.json")).invocations.length, 1);
    assert.deepEqual(batch.taskSeeds, { "T1-runner-long": 101, "T2-runner-compaction": 202 });
    for (const k of ["benchmarkCommit", "node", "os", "cli", "model", "seed"]) assert.ok(k in batch, k);
    assert.deepEqual(readdirSync(s.work), [], "every workspace and data folder is removed");
  } finally {
    s.done();
  }
});

test("saved records hold no home path and no workspace path", async () => {
  const s = setup();
  try {
    await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    const home = homedir();
    for (const id of readdirSync(join(s.results, "t", "runs"))) {
      for (const f of ["run.json"]) {
        const text = readFileSync(join(s.results, "t", "runs", id, f), "utf8");
        for (const p of [home, home.split("\\").join("/"), home.split("\\").join("\\\\"), s.work, "ccbench-test-work"]) {
          assert.equal(text.toLowerCase().includes(p.toLowerCase()), false, `${id}/${f} holds ${p}`);
        }
      }
    }
    const batch = readFileSync(join(s.results, "t", "batch.json"), "utf8");
    assert.equal(batch.toLowerCase().includes(home.toLowerCase().split("\\").join("\\\\")), false);
  } finally {
    s.done();
  }
});

test("resume skips final runs, reruns a missing one, and rejects a different run list", async () => {
  const s = setup();
  try {
    await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    const again = await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    assert.deepEqual([again.done, again.skipped, again.exitCode], [0, 6, EXIT.ok]);
    const victim = readdirSync(join(s.results, "t", "runs"))[0];
    rmSync(join(s.results, "t", "runs", victim, "run.json"));
    const third = await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    assert.deepEqual([third.done, third.skipped], [1, 5]);
    assert.equal(third.records[0].runId, victim);
    assert.equal(readJson(join(s.results, "t", "invocations.json")).invocations.length, 3);
    await assert.rejects(runBatch({ ...s.opts, seed: 99 }, { host: createMockHost(), configs: s.configs, log: quiet }), /different run list/);
  } finally {
    s.done();
  }
});

test("stage material is present during its stage turn only; each mode reaches the host environment", async () => {
  const s = setup();
  const seen = [];
  const host = createMockHost({
    behave: ({ workspace, label, env }) => {
      seen.push({ label, files: listFilesRel(workspace).filter((f) => f !== "feed.mjs" && f !== "package.json"), clock: env.CTX_CLOCK ?? null, fb: env.CTX_CLOCK_FEEDBACK ?? null, data: env.CONTEXT_MODE_DATA_DIR });
      return null;
    },
  });
  try {
    await runBatch({ ...s.opts, tasks: ["T1-runner-long"], modes: ["A", "B", "C"] }, { host, configs: s.configs, log: quiet });
    const byLabel = (l) => seen.filter((x) => x.label === l);
    for (const x of byLabel("intro")) assert.deepEqual(x.files, []);
    for (const x of byLabel("stage-1")) assert.deepEqual(x.files, [".feed/log1.txt", "conf/app.ini"]);
    for (const x of byLabel("stage-2")) assert.deepEqual(x.files, ["conf/override.ini"]);
    for (const x of byLabel("final")) assert.deepEqual(x.files, []);
    const modes = new Set(seen.map((x) => `${x.clock}/${x.fb}`));
    assert.deepEqual([...modes].sort(), ["1/null", "1/off", "null/null"]);
    assert.equal(new Set(seen.map((x) => x.data)).size, 3, "one data folder per run");
    for (const x of seen) assert.ok(x.data.startsWith(s.work));
  } finally {
    s.done();
  }
});

test("--concurrency runs use separate workspaces and data folders; mode A never gets the parent's clock variables", async () => {
  const s = setup(["--concurrency", "3"]);
  const seen = new Map();
  const saved = { a: process.env.CTX_CLOCK, b: process.env.CTX_CLOCK_FEEDBACK };
  process.env.CTX_CLOCK = "1";
  process.env.CTX_CLOCK_FEEDBACK = "off";
  let active = 0;
  let peak = 0;
  const host = createMockHost({
    delayMs: 0,
    behave: ({ workspace, env, label, mock }) => {
      if (label === "intro") seen.set(`${mock.taskId}/${mock.mode}`, { workspace, data: env.CONTEXT_MODE_DATA_DIR, clock: env.CTX_CLOCK, fb: env.CTX_CLOCK_FEEDBACK, mode: mock.mode });
      return null;
    },
  });
  const delayed = (fn) => async (a) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); try { return await fn(a); } finally { active--; } };
  // Persistent mode (the claude default) sends turns through the session object, resume mode through runTurn.
  const slow = { ...host, runTurn: delayed(host.runTurn), openSession: (o) => { const x = host.openSession(o); return x && { ...x, runTurn: delayed(x.runTurn) }; } };
  try {
    const r = await runBatch(s.opts, { host: slow, configs: s.configs, log: quiet });
    assert.equal(r.exitCode, EXIT.ok);
    assert.ok(peak > 1, "runs overlap");
    const v = [...seen.values()];
    assert.equal(v.length, 6);
    assert.equal(new Set(v.map((x) => x.workspace)).size, 6);
    assert.equal(new Set(v.map((x) => x.data)).size, 6);
    for (const x of v) assert.equal(v.filter((y) => y.workspace === x.data || y.data === x.workspace).length, 0);
    for (const x of v.filter((y) => y.mode === "A")) assert.deepEqual([x.clock, x.fb], [undefined, undefined]);
    for (const x of v.filter((y) => y.mode === "C")) assert.deepEqual([x.clock, x.fb], ["1", undefined]);
  } finally {
    for (const [k, val] of [["CTX_CLOCK", saved.a], ["CTX_CLOCK_FEEDBACK", saved.b]]) if (val === undefined) delete process.env[k]; else process.env[k] = val;
    s.done();
  }
});

test("a slow host times out; the runner retries twice in new workspaces, then records timeout", async () => {
  const s = setup(["--tasks", "T1-runner-long", "--modes", "A"], { turnTimeoutMs: 40 });
  try {
    const r = await runBatch(s.opts, { host: createMockHost({ delayMs: 400 }), configs: s.configs, log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "timeout");
    assert.equal(rec.failure.kind, "timeout");
    assert.deepEqual(rec.attempts.map((a) => [a.attempt, a.status, a.failure.kind]), [[1, "timeout", "timeout"], [2, "timeout", "timeout"], [3, "timeout", "timeout"]]);
    assert.equal(rec.turns[0].timedOut, true);
    assert.equal(isFinal(rec), true);
  } finally {
    s.done();
  }
});

test("an infra failure is retried in a new workspace and a new session", async () => {
  const s = setup(["--tasks", "T1-runner-long", "--modes", "B"]);
  const workspaces = [];
  const sessions = [];
  let failed = false;
  const host = createMockHost({
    behave: ({ workspace, label, sessionId }) => {
      if (label === "intro") { workspaces.push(workspace); sessions.push(sessionId); }
      if (label === "stage-2" && !failed) { failed = true; return failTurn({ sessionId: "x" }); }
      return null;
    },
  });
  try {
    const r = await runBatch(s.opts, { host, configs: s.configs, log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "completed");
    assert.equal(rec.attempts.length, 2);
    assert.equal(workspaces.length, 2);
    assert.notEqual(workspaces[0], workspaces[1]);
    assert.deepEqual(sessions, [null, null], "each attempt starts without a session id");
    assert.deepEqual(rec.attempts.map((a) => [a.attempt, a.status, a.failure?.kind ?? null]), [[1, "infra_failed", "cli_error"], [2, "completed", null]]);
  } finally {
    s.done();
  }
});

test("three rate-limit failures in a row stop the batch and leave it resumable", async () => {
  const s = setup();
  const msgs = [];
  const host = createMockHost({ behave: () => failTurn({ rateLimited: true, errorText: "Claude usage limit reached" }) });
  try {
    const r = await runBatch(s.opts, { host, configs: s.configs, log: (m) => msgs.push(m) });
    assert.equal(r.exitCode, EXIT.rateLimitStop);
    assert.equal(r.stopped, true);
    assert.equal(r.done, 3);
    assert.equal(r.pending, 6);
    for (const rec of r.records) {
      assert.equal(rec.status, "infra_failed");
      assert.equal(rec.failure.kind, "rate_limit");
      assert.equal(rec.attempts.length, 1, "a rate limit is not retried inside the run");
      assert.equal(isFinal(rec), false);
    }
    assert.ok(msgs.some((m) => /STOP: 3 runs in a row/.test(m)));
    const resumed = await runBatch(s.opts, { host: createMockHost(), configs: s.configs, log: quiet });
    assert.deepEqual([resumed.done, resumed.skipped, resumed.exitCode], [6, 0, EXIT.ok]);
  } finally {
    s.done();
  }
});

test("a host without compaction records the compaction profile as not executable, without turns", async () => {
  const s = setup();
  let compactionTurns = 0;
  const host = createMockHost({ canCompact: false, behave: ({ prompt }) => { if (/Stage \d of 3/.test(prompt)) compactionTurns++; return null; } });
  try {
    const r = await runBatch(s.opts, { host, configs: s.configs, log: quiet });
    assert.equal(r.exitCode, EXIT.ok);
    assert.equal(compactionTurns, 0, "no token is spent on a profile the host cannot execute");
    for (const rec of runs(s.results)) {
      if (rec.profile === "compaction") {
        assert.equal(rec.status, "infra_failed");
        assert.equal(rec.failure.kind, "profile_not_executable");
        assert.deepEqual(rec.attempts, []);
        assert.deepEqual(rec.turns, []);
        assert.deepEqual(rec.compactions.map((c) => c.confirmed), [false]);
        assert.equal(isFinal(rec), true);
      } else {
        assert.equal(rec.status, "completed");
      }
    }
  } finally {
    s.done();
  }
});

test("an unconfirmed compaction stays confirmed: false and the run goes on (CONTRACT.md: first confirmed compaction)", async () => {
  const s = setup(["--tasks", "T2-runner-compaction", "--modes", "C"]);
  try {
    const r = await runBatch(s.opts, { host: createMockHost({ compactConfirmed: false }), configs: s.configs, log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "completed");
    assert.equal(rec.attempts.length, 1);
    assert.deepEqual(rec.compactions.map((c) => [c.afterStage, c.confirmed]), [[2, false]]);
    const compact = rec.turns.find((t) => t.kind === "compact");
    assert.equal(compact.compactBoundary, false, "a compaction without a boundary is never reported as one");
    assert.equal(rec.turns.at(-1).kind, "final");
  } finally {
    s.done();
  }
});

test("no parsable final answer gives agent_failed without a retry", async () => {
  const s = setup(["--tasks", "T1-runner-long", "--modes", "A"]);
  const host = createMockHost({
    behave: ({ label, sessionId }) => (label === "final" ? { ...failTurn({ sessionId, resultText: "I do not know." }), exitCode: 0, isError: false, errorText: "" } : null),
  });
  try {
    const r = await runBatch(s.opts, { host, configs: s.configs, log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "agent_failed");
    assert.equal(rec.failure.kind, "no_final_answer");
    assert.deepEqual(rec.attempts.map((a) => a.status), ["agent_failed"]);
    assert.match(rec.answers.finalParseError, /no parsable/);
    assert.equal(rec.answers.final, null);
  } finally {
    s.done();
  }
});

test("the integrity scan flags a tool input that reads outside the workspace", async () => {
  const s = setup(["--tasks", "T1-runner-long", "--modes", "A"]);
  const host = createMockHost({
    behave: ({ label, sessionId, rawDir }) => {
      if (label !== "stage-2") return null;
      const stream = [
        { type: "system", subtype: "init", session_id: sessionId, model: "mock-model" },
        { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(BENCH, "graders", "key.json") } }] }, session_id: sessionId },
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } },
      ].map((l) => JSON.stringify(l)).join("\n");
      const streamPath = join(rawDir, `${label}.jsonl`);
      writeFileSync(streamPath, stream);
      return { ...failTurn({ sessionId, resultText: "ok" }), exitCode: 0, isError: false, errorText: "", streamPath, toolCalls: [{ name: "Read", isError: false }] };
    },
  });
  try {
    const r = await runBatch(s.opts, { host, configs: s.configs, log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "completed");
    const reasons = rec.integrity.violations.map((v) => v.reason);
    assert.ok(reasons.some((x) => /forbidden word/.test(x)));
    assert.ok(reasons.includes("path outside the workspace"));
    assert.ok(rec.integrity.violations.every((v) => v.turn === "stage-2"));
    assert.equal(JSON.stringify(rec).includes(homedir()), false);
  } finally {
    s.done();
  }
});

test("the command line: --mock --suite smoke runs against the test tasks", () => {
  const results = tmp("cli");
  const work = tmp("cliwork");
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const p = spawnSync(process.execPath, [join(BENCH, "runner", "run.mjs"), "--mock", "--suite", "smoke", "--batch", "selftest", "--tasks-dir", TASKS, "--results-dir", results, "--work-root", work], { encoding: "utf8", env });
    assert.equal(p.status, 0, p.stderr + p.stdout);
    assert.match(p.stdout, /ran 6 \(completed 6\)/);
    const bad = spawnSync(process.execPath, [join(BENCH, "runner", "run.mjs"), "--suite", "smoke"], { encoding: "utf8", env });
    assert.equal(bad.status, EXIT.usage);
    assert.match(bad.stderr, /--batch is required/);
  } finally {
    cleanup(results, work);
  }
});
