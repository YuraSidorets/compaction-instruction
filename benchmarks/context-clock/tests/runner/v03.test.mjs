// v0.3 placebo experiment runner (EXPERIMENT-V03.md "Runner"): mode D, the overlay wiring, block order, probes after a
// compaction, live run limits, the batch budget and resume. The overlay module is a stub; the host is the mock.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateRun } from "../../fixtures/schema.mjs";
import { buildArgs, buildPersistentArgs, openSession } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { createLimitMonitor, effectiveBudget, budgetReason, priorUsage, usageTokens } from "../../runner/limits.mjs";
import { overlaySettings, prepareOverlay, readGuardLog, readShimLog, runOverlay } from "../../runner/overlay-run.mjs";
import { blocksOf, buildRunList, checkpointsOf, selectTasks, validateTask } from "../../runner/plan.mjs";
import { runProcess, startProcess } from "../../runner/proc.mjs";
import { EXIT, buildPlan, isFinal, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { HERE, cleanup, readJson, readTask, tmp } from "./helpers.mjs";

const FAKE = join(HERE, "fixtures", "fake-claude.mjs");

/** A v03-like task folder (tasks/v03/README.md schema): A5 (1 compaction, 1 probe) and A6 (2 compactions, a probe after each). */
function v03Tasks() {
  const dir = tmp("v03tasks");
  const t2 = readTask("T2-runner-compaction");
  const q = t2.checkpoint.questions[0];
  const t5 = { ...t2, taskId: "A5-runner-one", checkpoint: { afterStage: 2, timing: "after_compaction", questions: [{ ...q, id: "c1" }], probes: [{ afterStage: 2, questionIds: ["c1"] }] } };
  const t6 = {
    ...t2, taskId: "A6-runner-two",
    stages: t2.stages.map((s) => ({ ...s, compactAfter: s.stage === 1 || s.stage === 2 })),
    checkpoint: {
      afterStage: 1, timing: "after_compaction", questions: [{ ...q, id: "c1" }, { ...q, id: "c2" }, { ...q, id: "c3" }],
      probes: [{ afterStage: 1, questionIds: ["c1"] }, { afterStage: 2, questionIds: ["c2", "c3"] }],
    },
  };
  for (const t of [t5, t6, readTask("T1-runner-long")]) writeFileSync(join(dir, `${t.taskId}.task.json`), JSON.stringify(t));
  return dir;
}

/** A stub of runner/overlay/build.mjs (the contract interface). */
function stubOverlay(calls = []) {
  return {
    findInstalledPlugin: () => "C:/fake/installed/context-mode",
    buildOverlay: ({ sourceDir, destDir }) => {
      calls.push({ sourceDir, destDir });
      mkdirSync(destDir, { recursive: true });
      return { pluginDir: destDir, sourceSha: "sha-stub-1" };
    },
  };
}

function v03Opts(dirs, extra = []) {
  return { ...parseArgs(["--batch", "v", "--suite", "v03-smoke", "--mock", ...extra]), tasksDir: dirs.tasks, resultsDir: dirs.results, workRoot: dirs.work };
}

function configsWith(patch) {
  const c = loadConfigs();
  return { ...c, limits: { run: { ...c.limits.run, ...(patch.run ?? {}) }, batch: { ...c.limits.batch, ...(patch.batch ?? {}) } } };
}

function dirs() {
  return { tasks: v03Tasks(), results: tmp("v03res"), work: tmp("v03work") };
}

const quiet = () => {};

// ---------------------------------------------------------------- plan

test("block order: (task, rep) blocks shuffled by seed, the modes of a block next to each other in seeded order", () => {
  const tasks = ["T1", "T2", "T3"].map((taskId) => ({ taskId, profile: "compaction" }));
  const a = buildRunList({ host: "claude", tasks, modes: ["B", "C", "D"], reps: 3, seed: 7, order: "block" });
  assert.equal(a.length, 27);
  assert.deepEqual(a.map((r) => r.order), Array.from({ length: 27 }, (_, i) => i + 1));
  const blocks = blocksOf(a);
  assert.equal(blocks.length, 9);
  for (const b of blocks) assert.deepEqual([...b.modes].sort(), ["B", "C", "D"]);
  for (let i = 0; i < a.length; i += 3) assert.equal(new Set(a.slice(i, i + 3).map((r) => `${r.taskId}|${r.rep}`)).size, 1);
  assert.equal(new Set(blocks.map((b) => `${b.taskId}|${b.rep}`)).size, 9);
  assert.ok(new Set(blocks.map((b) => b.modes.join(""))).size > 1, "the mode order differs between blocks");
  assert.deepEqual(buildRunList({ host: "claude", tasks, modes: ["B", "C", "D"], reps: 3, seed: 7, order: "block" }), a, "same seed, same order");
  assert.notDeepEqual(buildRunList({ host: "claude", tasks, modes: ["B", "C", "D"], reps: 3, seed: 8, order: "block" }).map((r) => r.runId), a.map((r) => r.runId));
  const old = buildRunList({ host: "claude", tasks, modes: ["A", "B", "C"], reps: 1, seed: 1 });
  assert.equal(old[0].block, undefined, "the old suites keep the full shuffle");
});

test("v03-smoke picks one task with 1 compaction and one with 2; probes run after their compaction", () => {
  const d = v03Tasks();
  try {
    const p = buildPlan({ ...parseArgs(["--batch", "x", "--suite", "v03-smoke", "--mock"]), tasksDir: d });
    assert.deepEqual(p.tasks.map((t) => t.taskId).sort(), ["A5-runner-one", "A6-runner-two"]);
    assert.deepEqual(p.modes, ["B", "C", "D"]);
    assert.equal(p.order, "block");
    assert.equal(p.overlay, true);
    assert.equal(p.limits.run.toolCalls, 90);
    assert.equal(p.hostCfg.turnTimeoutMs <= 420000, true);
    const full = buildPlan({ ...parseArgs(["--batch", "x", "--suite", "v03-full", "--mock"]), tasksDir: d });
    assert.equal(full.reps, 3);
    const t6 = p.tasks.find((t) => t.taskId === "A6-runner-two");
    assert.deepEqual(checkpointsOf(t6).map((c) => [c.afterStage, c.afterCompaction, c.questions.length]), [[1, true, 1], [2, true, 2]]);
    assert.deepEqual(checkpointsOf(readTask("T2-runner-compaction")).map((c) => [c.afterStage, c.afterCompaction]), [[2, false]], "the legacy checkpoint stays before the compaction");
    assert.deepEqual(checkpointsOf(t6).map((c) => c.questions.map((x) => x.id)), [["c1"], ["c2", "c3"]]);
    assert.deepEqual(validateTask({ ...t6, checkpoint: { ...t6.checkpoint, probes: [{ afterStage: 3, questionIds: ["c9"] }] } }).filter((x) => x.startsWith("checkpoint.probes")).length, 2);
    assert.equal(selectTasks(p.tasks, { pick: "one-per-compaction-count", count: 2 }).length, 2);
  } finally {
    cleanup(d);
  }
});

test("plan guards: concurrency above 6, mode D without the overlay, the overlay off for the old suites", () => {
  const d = v03Tasks();
  try {
    const base = (args) => ({ ...parseArgs(["--batch", "x", ...args, "--mock"]), tasksDir: d });
    assert.throws(() => buildPlan(base(["--suite", "v03-smoke", "--concurrency", "7"])), /above the limit 6/);
    assert.doesNotThrow(() => buildPlan(base(["--suite", "v03-smoke", "--concurrency", "6"])));
    assert.throws(() => buildPlan(base(["--suite", "v03-smoke", "--overlay", "off"])), /mode D needs the overlay/);
    assert.equal(buildPlan(base(["--suite", "v03-smoke", "--overlay", "off", "--modes", "B,C"])).overlay, false);
    assert.equal(buildPlan(base(["--suite", "smoke"])).overlay, false);
    assert.equal(buildPlan(base(["--suite", "smoke", "--overlay", "on"])).overlay, true);
    assert.throws(() => parseArgs(["--batch", "x", "--suite", "smoke", "--overlay", "maybe"]), /--overlay must be on or off/);
    assert.throws(() => buildPlan({ ...base(["--suite", "v03-smoke"]), host: "codex" }), /needs --host claude/);
  } finally {
    cleanup(d);
  }
});

// ---------------------------------------------------------------- limits

const line = (o) => JSON.stringify(o);

test("limit monitor: live tool calls and tokens abort the turn; wall time counts recorded durations for the mock", () => {
  const m = createLimitMonitor({ limits: { toolCalls: 2, totalTokens: 1000, wallTimeMs: 5000 }, deterministic: true });
  const t = m.beginTurn();
  t.onLine(line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }], usage: { input_tokens: 10 } } }));
  t.onLine(line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "b" }], usage: { input_tokens: 10 } } }));
  assert.equal(t.signal.aborted, false, "2 distinct tool calls are not above 2");
  t.onLine(line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "c" }] } }));
  assert.equal(t.signal.aborted, true);
  assert.equal(m.hit, "toolCalls");

  const k = createLimitMonitor({ limits: { toolCalls: 90, totalTokens: 1000, wallTimeMs: 5000 }, deterministic: true });
  const kt = k.beginTurn();
  kt.onLine(line({ type: "assistant", message: { id: "x", content: [], usage: { input_tokens: 400, cache_read_input_tokens: 500 } } }));
  assert.equal(k.hit, null);
  kt.onLine(line({ type: "result", usage: { input_tokens: 600, output_tokens: 500 } }));
  assert.equal(k.hit, "totalTokens");

  const w = createLimitMonitor({ limits: { toolCalls: 90, totalTokens: 1e9, wallTimeMs: 2500 }, deterministic: true });
  w.beginTurn();
  assert.equal(w.endTurn({ toolCalls: {}, usage: {}, durationMs: 2000 }), null);
  assert.equal(w.beforeTurn(), null);
  w.beginTurn();
  assert.equal(w.endTurn({ toolCalls: { Read: 1 }, usage: { inputTokens: 1 }, durationMs: 1000 }), "wallTime");
  assert.deepEqual(w.counts(), { toolCalls: 1, tokens: 1, durationMs: 3000 });
  assert.equal(usageTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }), 10);
});

test("limit monitor: the real wall-time timer aborts a turn of a live host", async () => {
  const m = createLimitMonitor({ limits: { toolCalls: 90, totalTokens: 1e9, wallTimeMs: 50 } });
  const t = m.beginTurn();
  await new Promise((r) => t.signal.addEventListener("abort", r, { once: true }));
  assert.equal(m.hit, "wallTime");
  m.stop();
});

test("budget helpers: raises multiply the budget, prior invocations add up", () => {
  assert.deepEqual(effectiveBudget({ totalTokens: 100, wallTimeMs: 10 }, 2), { totalTokens: 300, wallTimeMs: 30 });
  assert.deepEqual(priorUsage([{ id: "a", tokens: 5, wallMs: 7 }, { id: "b", tokens: 1, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" }, { id: "c", tokens: 99 }], "c"), { tokens: 6, wallMs: 2007 });
  assert.match(budgetReason({ tokens: 100, wallMs: 0 }, { totalTokens: 100, wallTimeMs: 10 }), /total tokens/);
  assert.match(budgetReason({ tokens: 0, wallMs: 10 }, { totalTokens: 100, wallTimeMs: 10 }), /wall time/);
  assert.equal(budgetReason({ tokens: 1, wallMs: 1 }, { totalTokens: 100, wallTimeMs: 10 }), null);
});

test("runProcess: onLine sees each stdout line, the abort signal kills the tree and keeps the output", async () => {
  const seen = [];
  const ac = new AbortController();
  const code = "console.log('one'); console.log('two'); setTimeout(() => console.log('late'), 20000);";
  const r = await runProcess({ cmd: process.execPath, args: ["-e", code], timeoutMs: 30000, onLine: (l) => { seen.push(l); if (l === "two") ac.abort(); }, signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(seen, ["one", "two"]);
  assert.match(r.stdout, /two/);
});

// ---------------------------------------------------------------- overlay wiring and the Claude host

test("overlay wiring: settings file, per-run variables, shim and guard logs, the batch overlay through the interface", async () => {
  const d = tmp("ovl");
  try {
    const env = { CTX_CLOCK: "1", CCB_FEEDBACK: "placebo" };
    const ov = runOverlay({ overlay: { pluginDir: join(d, "overlay") }, env, workspace: join(d, "ws"), dataDir: join(d, "data") });
    assert.deepEqual(readJson(ov.settingsPath), overlaySettings());
    assert.deepEqual(overlaySettings(), { enabledPlugins: { "context-mode@context-mode": false } });
    assert.deepEqual([env.CCB_SHIM_LOG, env.CCB_GUARD_LOG, env.CCB_WORKSPACE, env.CCB_OVERLAY_DIR], [join(d, "data", "shim.jsonl"), join(d, "data", "guard.jsonl"), join(d, "ws"), join(d, "overlay")]);
    writeFileSync(ov.shimLog, [
      { t: "x", channel: "mcp_reply", event: "tools/call", mode: "placebo", originalBytes: 40, deliveredBytes: 40, replaced: 1 },
      { t: "x", channel: "session_start", event: "SessionStart", mode: "real", originalBytes: 50, deliveredBytes: 50, replaced: 0 },
      { t: "x", channel: "hook_context", event: "PostToolUse", mode: "none", originalBytes: 0, deliveredBytes: 0, replaced: 0 },
    ].map(line).join("\n") + "\n");
    const s = readShimLog(ov.shimLog);
    assert.deepEqual(s.byChannel.mcp_reply, { real: 0, placebo: 1, none: 0, bytes: 40 });
    assert.deepEqual(s.byChannel.session_start, { real: 1, placebo: 0, none: 0, bytes: 50 });
    assert.equal(s.byChannel.hook_context.none, 1);
    assert.equal(s.errors, 0);
    writeFileSync(ov.shimLog, line({ t: "x", error: "boom" }) + "\nnot json\n", { flag: "a" });
    assert.equal(readShimLog(ov.shimLog).errors, 2);
    writeFileSync(ov.guardLog, [{ t: "x", tool: "Read", reason: "r" }, { t: "x", tool: "Bash", reason: "r" }, { t: "x", tool: "Read", reason: "r" }].map(line).join("\n"));
    assert.deepEqual(readGuardLog(ov.guardLog), { denied: 3, byTool: { Bash: 1, Read: 2 } });
    assert.deepEqual(readShimLog(join(d, "missing")).errors, 0);
    const calls = [];
    const built = await prepareOverlay({ workRoot: d, batch: "b1", module: stubOverlay(calls) });
    assert.deepEqual(built, { pluginDir: join(d, "overlay", "b1"), sourceSha: "sha-stub-1" });
    assert.deepEqual(calls, [{ sourceDir: "C:/fake/installed/context-mode", destDir: join(d, "overlay", "b1") }]);
    assert.equal((await prepareOverlay({ workRoot: d, batch: "b2", mock: true })).sourceSha, "mock");
  } finally {
    cleanup(d);
  }
});

test("Claude host: --plugin-dir and --settings (a file) in both session modes; a run limit aborts a persistent turn", async () => {
  const o = { pluginDir: "C:\\work\\overlay\\b", settingsPath: "C:\\data\\claude-settings.json" };
  for (const args of [buildArgs({ model: "haiku", ...o }), buildPersistentArgs({ model: "haiku", ...o })]) {
    assert.deepEqual(args.slice(args.indexOf("--plugin-dir"), args.indexOf("--plugin-dir") + 4), ["--plugin-dir", o.pluginDir, "--settings", o.settingsPath]);
  }
  assert.equal(buildArgs({ model: "haiku" }).includes("--plugin-dir"), false, "no overlay, no overlay arguments");
  const dir = tmp("sess-lim");
  try {
    const launched = [];
    const start = (args, x) => {
      launched.push(args);
      return startProcess({ cmd: process.execPath, args: [FAKE], ...x });
    };
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const s = openSession({ workspace: dir, env, model: "haiku", allowedTools: ["Read"], rawDir: dir, start, ...o });
    assert.ok(launched[0].includes("--plugin-dir") && launched[0].includes("--settings"));
    const seen = [];
    const ok = await s.runTurn({ prompt: "first", label: "intro", timeoutMs: 20000, onLine: (l) => seen.push(l) });
    assert.equal(ok.hasResult, true);
    assert.ok(seen.some((l) => l.includes("tool_use")), "live lines reach the monitor");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await s.runTurn({ prompt: "HANG", label: "stage-1", timeoutMs: 20000, signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.match(r.errorText, /run limit/);
    assert.ok(existsSync(join(dir, "stage-1.jsonl")), "the stopped turn keeps its raw stream");
    await s.close({ graceMs: 2000 });
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- mock batches

test("v03-smoke on the mock: modes B, C, D in blocks, overlay telemetry, placebo in D, probes after each compaction", async () => {
  const x = dirs();
  const sessions = [];
  try {
    const r = await runBatch(v03Opts(x), { host: createMockHost({ onSession: (s) => sessions.push(s), guardDenials: 2 }), overlay: stubOverlay(), log: quiet });
    assert.equal(r.exitCode, EXIT.ok);
    assert.equal(r.records.length, 6);
    const batch = readJson(join(x.results, "v", "batch.json"));
    assert.equal(batch.order, "block");
    assert.equal(batch.blocks.length, 2);
    assert.deepEqual(batch.overlay, { pluginDir: "<overlay>", sourceSha: "sha-stub-1" });
    assert.equal(batch.limits.run.toolCalls, 90);
    for (let i = 0; i < 6; i += 3) assert.equal(new Set(batch.runOrder.slice(i, i + 3).map((id) => id.split("__")[1])).size, 1);
    const inv = readJson(join(x.results, "v", "invocations.json"));
    assert.equal(inv.budgetStopped, null);
    assert.equal(inv.budget.totalTokens, 150000000);
    assert.ok(inv.invocations[0].tokens > 0);
    for (const rec of r.records) {
      const disk = readJson(join(x.results, "v", "runs", rec.runId, "run.json"));
      assert.deepEqual(validateRun(disk), [], `${rec.runId} follows the schema`);
      assert.equal(disk.status, "completed");
      assert.deepEqual(disk.overlay, { sourceSha: "sha-stub-1" });
      assert.deepEqual(disk.limits, { wallTimeMs: 1200000, turnTimeoutMs: 60000, toolCalls: 90, totalTokens: 3000000 });
      assert.equal(disk.limitHit, null);
      assert.deepEqual(disk.telemetry.guard, { denied: 2, byTool: { Bash: 1, Read: 1 } });
      assert.equal(JSON.stringify(disk).includes(x.work), false, "no local path in run.json");
      const shim = disk.telemetry.shim;
      const ch = disk.telemetry.clockFeedbackByChannel;
      if (disk.mode === "D") {
        assert.equal(disk.env.CCB_FEEDBACK, "placebo");
        assert.ok(shim.byChannel.mcp_reply.placebo > 0);
        assert.equal(shim.byChannel.mcp_reply.real, 0);
        assert.equal(ch.tool_reply.count, 0, "no real snapshot reaches the model in mode D");
      } else if (disk.mode === "C") {
        assert.ok(shim.byChannel.mcp_reply.real > 0);
        assert.equal(shim.byChannel.mcp_reply.placebo, 0);
        assert.ok(ch.tool_reply.count > 0);
      } else {
        assert.equal(shim.byChannel.mcp_reply.real + shim.byChannel.mcp_reply.placebo, 0);
      }
      assert.ok(shim.byChannel.session_start.real > 0, "the session-start block is unchanged in every mode");
      assert.ok(existsSync(join(x.results, "v", "raw", rec.runId, "a1", "shim.jsonl")));
      const kinds = disk.turns.map((t) => (t.kind === "stage" || t.kind === "compact" || t.kind === "checkpoint" ? `${t.kind}${t.stage}` : t.kind));
      if (disk.taskId === "A6-runner-two") {
        assert.deepEqual(kinds, ["intro", "stage1", "compact1", "checkpoint1", "stage2", "compact2", "checkpoint2", "stage3", "final"]);
        assert.deepEqual(Object.keys(disk.answers.checkpoint).sort(), ["c1", "c2", "c3"]);
        assert.deepEqual(disk.compactions.map((c) => [c.afterStage, c.confirmed]), [[1, true], [2, true]]);
        assert.ok(existsSync(join(x.results, "v", "raw", rec.runId, "a1", "checkpoint-2.jsonl")));
      } else {
        assert.deepEqual(kinds, ["intro", "stage1", "stage2", "compact2", "checkpoint2", "stage3", "final"]);
      }
    }
    assert.equal(sessions.length, 6);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("an unconfirmed compaction is recorded as confirmed: false and the run goes on", async () => {
  const x = dirs();
  try {
    const r = await runBatch(v03Opts(x, ["--tasks", "A6-runner-two", "--modes", "C"]), { host: createMockHost({ compactConfirmed: false }), overlay: stubOverlay(), log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "completed");
    assert.deepEqual(rec.compactions.map((c) => c.confirmed), [false, false]);
    assert.equal(rec.turns.filter((t) => t.kind === "checkpoint").length, 2);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

for (const [name, patch, hit] of [
  ["tool calls", { toolCalls: 1 }, "toolCalls"],
  ["total tokens", { totalTokens: 300 }, "totalTokens"],
  ["wall time", { wallTimeMs: 2500 }, "wallTime"],
]) {
  test(`limit stop (${name}): status limit_exceeded, limitHit, raw stream kept, final, not retried, other runs go on`, async () => {
    const x = dirs();
    try {
      const opts = v03Opts(x, ["--tasks", "A5-runner-one", "--modes", "C,D"]);
      const r = await runBatch(opts, { host: createMockHost(), overlay: stubOverlay(), configs: configsWith({ run: patch }), log: quiet });
      assert.equal(r.exitCode, EXIT.ok, "limit_exceeded is a final status");
      assert.equal(r.records.length, 2);
      for (const rec of r.records) {
        assert.equal(rec.status, "limit_exceeded");
        assert.equal(rec.limitHit, hit);
        assert.equal(rec.failure.kind, "limit");
        assert.equal(rec.attempts.length, 1);
        assert.equal(isFinal(rec), true);
        assert.deepEqual(validateRun(rec), []);
        assert.ok(rec.turns.length >= 1);
        const last = rec.turns[rec.turns.length - 1];
        const label = last.stage ? `${last.kind}-${last.stage}` : last.kind;
        assert.ok(existsSync(join(x.results, "v", "raw", rec.runId, "a1", `${label}.jsonl`)), "the stopped turn keeps its raw stream");
      }
      // A second start skips the final runs.
      const again = await runBatch(opts, { host: createMockHost(), overlay: stubOverlay(), configs: configsWith({ run: patch }), log: quiet });
      assert.equal(again.done, 0);
      assert.equal(again.skipped, 2);
    } finally {
      cleanup(x.tasks, x.results, x.work);
    }
  });
}

test("a shim error makes the run infra_failed (kind shim_error), with retries", async () => {
  const x = dirs();
  try {
    const r = await runBatch(v03Opts(x, ["--tasks", "A5-runner-one", "--modes", "D"]), { host: createMockHost({ shimError: true }), overlay: stubOverlay(), log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "infra_failed");
    assert.equal(rec.failure.kind, "shim_error");
    assert.equal(rec.attempts.length, 3);
    assert.equal(rec.telemetry.shim.errors, 1);
    assert.deepEqual(validateRun(rec), []);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("batch budget: stop before a new run, budget_stopped mark, refuse without --raise-budget, resume with no repeated run", async () => {
  const x = dirs();
  const sessions = [];
  try {
    const host = () => createMockHost({ onSession: (s) => sessions.push(s.mock) });
    const configs = configsWith({ batch: { totalTokens: 1500 } });
    const base = ["--tasks", "A5-runner-one", "--modes", "B,C,D"];
    const first = await runBatch(v03Opts(x, base), { host: host(), overlay: stubOverlay(), configs, log: quiet });
    assert.equal(first.exitCode, EXIT.budgetStop);
    assert.equal(first.budgetStopped, true);
    assert.ok(first.done >= 1 && first.done < 3, `ran ${first.done}`);
    const inv = readJson(join(x.results, "v", "invocations.json"));
    assert.match(inv.budgetStopped.reason, /total tokens/);
    assert.equal(inv.invocations[0].budgetStopped, true);

    const refused = await runBatch(v03Opts(x, base), { host: host(), overlay: stubOverlay(), configs, log: quiet });
    assert.equal(refused.exitCode, EXIT.budgetStop);
    assert.equal(refused.done, 0);

    let total = first.done;
    for (let i = 0; i < 4 && total < 3; i++) {
      const more = await runBatch(v03Opts(x, [...base, "--raise-budget"]), { host: host(), overlay: stubOverlay(), configs, log: quiet });
      total += more.done;
    }
    assert.equal(total, 3);
    const ids = sessions.map((m) => `${m.mode}|${m.attempt}`);
    assert.equal(new Set(ids).size, ids.length, "no run started twice");
    assert.ok(readJson(join(x.results, "v", "invocations.json")).budget.raises >= 1);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("the old suites keep working without the overlay: mode A, no shim telemetry", async () => {
  const results = tmp("old");
  const work = tmp("oldw");
  try {
    const opts = { ...parseArgs(["--batch", "o", "--suite", "smoke", "--mock", "--tasks", "T2-runner-compaction"]), tasksDir: join(HERE, "fixtures", "task-files"), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host: createMockHost(), log: quiet });
    assert.equal(r.exitCode, EXIT.ok);
    const batch = readJson(join(results, "o", "batch.json"));
    assert.equal(batch.overlay, null);
    assert.equal(batch.order, "shuffle");
    for (const rec of r.records) {
      assert.deepEqual(validateRun(rec), []);
      assert.equal(rec.overlay, null);
      assert.equal(rec.telemetry.shim, null);
      assert.equal(rec.telemetry.guard, null);
      assert.equal("CCB_FEEDBACK" in rec.env, false);
    }
    assert.ok(r.records.some((x2) => x2.mode === "A"));
  } finally {
    cleanup(results, work);
  }
});

test("validator: limit_exceeded needs limitHit, mode D rejects a real tool reply snapshot", () => {
  const rec = JSON.parse(readFileSync(join(HERE, "..", "graders", "fixtures", "run-completed.json"), "utf8"));
  const base = { ...rec, mode: "D", runId: rec.runId.replace(/__[A-D]__/, "__D__"), env: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null, CCB_FEEDBACK: "placebo" } };
  const msgs = (r) => validateRun(r).join(" | ");
  const lim = { ...base, status: "limit_exceeded", failure: { kind: "limit", message: "x" }, attempts: [{ attempt: 1, status: "limit_exceeded", failure: { kind: "limit", message: "x" }, durationMs: 1 }] };
  assert.match(msgs({ ...lim, limitHit: null }), /limitHit/);
  assert.doesNotMatch(msgs({ ...lim, limitHit: "toolCalls" }), /limitHit/);
  assert.match(msgs({ ...base, limitHit: "toolCalls" }), /must be null unless/);
  assert.match(msgs({ ...base, env: { CTX_CLOCK: "1" } }), /CCB_FEEDBACK/);
  const ch = { tool_reply: { count: 1, bytes: 10 }, hook_context: { count: 0, bytes: 0 }, session_start: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } };
  assert.match(msgs({ ...base, telemetry: { ...base.telemetry, clockFeedbackCount: 1, clockFeedbackBytes: 10, clockFeedbackByChannel: ch } }), /mode D \(placebo\) gets no real tool_reply/);
});
