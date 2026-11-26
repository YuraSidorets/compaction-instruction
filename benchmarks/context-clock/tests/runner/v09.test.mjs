// v0.9 runner (EXPERIMENT-V09.md): mode R, the five suites, task selection by prefixes, the automatic compaction
// mode (no /compact, detection in the turn stream, probes after a detected compaction), contextTokens of each turn,
// and telemetry.triggers.precompactByTrigger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { selectTasks, validateTask } from "../../runner/plan.mjs";
import { buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { stageToolsOf } from "../../runner/v05.mjs";
import { triggerTelemetry } from "../../runner/v07.mjs";
import {
  AUTO_COMPACT_MECHANISM, PRECOMPACT_GENERAL_INSTRUCTION_FILE, autoCompactionEntries, compactBoundariesOf, contextTokensOf, v09Records,
} from "../../runner/v09.mjs";
import { MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { capture } from "./v06-capture.mjs";
import { LONG_STAGES, V09_LONG_ID, V09_TASKS, v09TaskDir } from "./v09-fixture.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const line = (o) => JSON.stringify(o);

async function runSuite(suite, { hostOpts = null, args = [] } = {}) {
  const tasksDir = v09TaskDir();
  const results = tmp("v09-res");
  const work = tmp("v09-work");
  try {
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", "--concurrency", "2", ...args]), tasksDir, resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { log: () => {}, ...(hostOpts ? { host: createMockHost({ mockDir: null, ...hostOpts }) } : {}) });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch };
  } finally {
    cleanup(tasksDir, results, work);
  }
}

// ---------------------------------------------------------------- mode R

test("v09: mode R is mode Q with the general PreCompact text", async () => {
  assert.deepEqual(MODE_ENV.R, MODE_ENV.B);
  const b = modeEnv("B", "d", {}, "w");
  const e = modeEnv("R", "d", {}, "w");
  assert.deepEqual(Object.keys({ ...e, ...b }).filter((k) => e[k] !== b[k]), ["CCB_PRECOMPACT_FILE"]);
  assert.equal(e.CCB_PRECOMPACT_FILE, PRECOMPACT_GENERAL_INSTRUCTION_FILE);
  assert.ok(isAbsolute(e.CCB_PRECOMPACT_FILE) && e.CCB_PRECOMPACT_FILE.endsWith("precompact-general-instruction.txt"));
  assert.deepEqual(stageToolsOf(["Read"], "R"), stageToolsOf(["Read"], "B"));
  assert.deepEqual(v09Records(["B", "Q"]), { precompactGeneralInstruction: null });
  assert.deepEqual(v09Records(["R"]).precompactGeneralInstruction, { file: "configs/precompact-general-instruction.txt", sha256: sha(readFileSync(PRECOMPACT_GENERAL_INSTRUCTION_FILE, "utf8").trim()) });
  const tasksDir = v09TaskDir();
  try {
    const out = await capture({ tasksDir, taskId: V09_TASKS[2].id, modes: ["B", "Q", "R"], suite: "v09-full", extraArgs: ["--reps", "1"] });
    assert.deepEqual(out.R.turns, out.B.turns);
    assert.deepEqual(out.R.compacts, ["/compact", "/compact", "/compact"]);
    assert.deepEqual(out.R.tools, out.B.tools);
    assert.equal(out.R.env.CCB_PRECOMPACT_FILE.endsWith("precompact-general-instruction.txt"), true);
    assert.equal(out.Q.env.CCB_PRECOMPACT_FILE.endsWith("precompact-strong-instruction.txt"), true);
  } finally {
    cleanup(tasksDir);
  }
});

// ---------------------------------------------------------------- suites and task selection

test("v09: selectTasks takes a list of prefixes in list order", () => {
  const all = ["A12-a", "D12-a", "W12-a", "W12-b", "X12-a", "X12-b", "A13-long"].map((taskId) => ({ taskId }));
  const ids = (suite) => selectTasks(all, suite, null).map((t) => t.taskId);
  assert.deepEqual(ids({ taskPrefixes: ["W12", "X12"], count: 4 }), ["W12-a", "W12-b", "X12-a", "X12-b"]);
  assert.deepEqual(ids({ taskPrefixes: ["A12", "D12", "W12", "X12"], count: 6 }), ["A12-a", "D12-a", "W12-a", "W12-b", "X12-a", "X12-b"]);
  assert.deepEqual(ids({ taskPrefix: "W12", count: 1 }), ["W12-a"]);
  assert.deepEqual(ids({ taskPrefixes: ["A1", "A12"] }), ["A12-a", "A13-long"], "no task twice");
  assert.throws(() => ids({ taskPrefixes: ["W12", "Z12"] }), /no task id starts with Z12/);
});

test("v09: the five suites, their tasks and run limits", () => {
  const configs = loadConfigs();
  const s = configs.suites;
  const part1 = { tasksDir: "tasks/v09", order: "block", overlay: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  const part2 = { tasksDir: "tasks/v09", order: "block", overlay: true, autoCompact: true, autoCompactWindow: 100000, runWallTimeMs: 5400000, runToolCalls: 400, runTotalTokens: 20000000 };
  assert.deepEqual(s["v09-calib"], { tasks: [], taskPrefixes: ["W12", "X12"], pick: "all", count: 4, modes: ["B"], reps: 1, ...part1, batchTokens: 6000000 });
  assert.deepEqual(s["v09-smoke"], { tasks: [], taskPrefix: "W12", pick: "all", count: 1, modes: ["R"], reps: 1, ...part1, batchTokens: 4000000 });
  assert.deepEqual(s["v09-full"], { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6, modes: ["B", "N", "Q", "R"], reps: 2, ...part1, comparisons: ["N-B", "Q-B", "R-B", "R-N", "R-Q"], batchTokens: 80000000 });
  assert.deepEqual(s["v09-auto-smoke"], { tasks: [], taskPrefix: "A13", pick: "all", count: 1, modes: ["R"], reps: 1, ...part2, batchTokens: 20000000 });
  assert.deepEqual(s["v09-auto"], { tasks: [], taskPrefix: "A13", pick: "all", count: 1, modes: ["B", "R"], reps: 2, ...part2, comparisons: ["R-B"], batchTokens: 60000000 });
  const tasksDir = v09TaskDir();
  try {
    const plan = (suite, more = []) => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock", ...more]), tasksDir }, configs);
    assert.deepEqual(plan("v09-calib").tasks.map((t) => t.taskId), ["W12-fixture-log-1", "W12-fixture-log-2", "X12-fixture-dec-1", "X12-fixture-dec-2"]);
    assert.deepEqual(plan("v09-smoke").tasks.map((t) => t.taskId), ["W12-fixture-log-1"]);
    assert.deepEqual(plan("v09-full").tasks.map((t) => t.taskId), V09_TASKS.map((t) => t.id));
    assert.equal(plan("v09-full").runs.length, 48);
    assert.equal(plan("v09-full").autoCompact, false);
    const auto = plan("v09-auto");
    assert.deepEqual(auto.tasks.map((t) => t.taskId), [V09_LONG_ID]);
    assert.equal(auto.runs.length, 4);
    assert.equal(auto.autoCompact, true);
    assert.deepEqual([auto.limits.run.wallTimeMs, auto.limits.run.toolCalls, auto.limits.run.totalTokens], [5400000, 400, 20000000]);
    assert.equal(auto.limits.batch.totalTokens, 60000000);
    assert.equal(plan("v09-full").limits.run.totalTokens, configs.limits.run.totalTokens);
    // The long task has no compaction stage: a suite without autoCompact rejects it.
    assert.throws(() => plan("v09-full", ["--tasks", V09_LONG_ID]), /no compaction stage: it needs a suite with autoCompact true/);
    assert.throws(() => plan("v09-smoke", ["--overlay", "off"]), /mode R needs the overlay/);
    assert.throws(() => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v09-auto", "--mock"]), tasksDir }, { ...configs, suites: { ...s, "v09-auto": { ...s["v09-auto"], autoCompact: "yes" } } }), /autoCompact must be true or false/);
    assert.doesNotThrow(() => parseArgs(["--batch", "x", "--suite", "v09-auto-smoke", "--modes", "R"]));
  } finally {
    cleanup(tasksDir);
  }
});

test("v09: a task with no compaction stage may name any stage in its probes", () => {
  const dir = v09TaskDir();
  try {
    const long = JSON.parse(readFileSync(join(dir, `${V09_LONG_ID}.task.json`), "utf8"));
    assert.equal(long.stages.length, LONG_STAGES);
    assert.deepEqual(validateTask(long), []);
    // With a compaction plan, a probe after a stage without a compaction stays an error.
    const old = JSON.parse(readFileSync(join(dir, `${V09_TASKS[0].id}.task.json`), "utf8"));
    old.checkpoint.probes[0].afterStage = 2;
    assert.match(validateTask(old).join(";"), /is not a compaction stage/);
    // A compaction task with neither a compaction stage nor probes stays an error.
    const bare = { ...long, checkpoint: { ...long.checkpoint, probes: undefined, timing: "after_stage" } };
    assert.match(validateTask(bare).join(";"), /profile compaction has no compactAfter stage/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- stream readers

test("v09: compactBoundariesOf, contextTokensOf and autoCompactionEntries read a turn stream", () => {
  const s = [
    line({ type: "system", subtype: "init", session_id: "s" }),
    line({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 2000, output_tokens: 300 } } }),
    line({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 160123 } }),
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { usage: { input_tokens: 999999 } } }),
    line({ type: "assistant", message: { usage: { input_tokens: 3, cache_read_input_tokens: 12000, cache_creation_input_tokens: 500, output_tokens: 40 } } }),
    line({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } }),
    line({ type: "result", subtype: "success" }),
  ].join("\n");
  assert.deepEqual(compactBoundariesOf(s), [{ trigger: "auto", preTokens: 160123 }, { trigger: "manual", preTokens: null }]);
  assert.equal(contextTokensOf(s), 12543, "the last assistant message of the main chain");
  assert.equal(contextTokensOf(""), null);
  assert.deepEqual(autoCompactionEntries(s, { afterStage: 7, turn: "stage-7" }), [
    { afterStage: 7, turn: "stage-7", confirmed: true, mechanism: AUTO_COMPACT_MECHANISM, preTokens: 160123, trigger: "auto", hostTrigger: "auto" },
    { afterStage: 7, turn: "stage-7", confirmed: true, mechanism: AUTO_COMPACT_MECHANISM, preTokens: null, trigger: "auto", hostTrigger: "manual" },
  ]);
  assert.deepEqual(compactBoundariesOf("not json\n"), []);
});

test("v09: precompactByTrigger counts the precompact deliveries by trigger kind", () => {
  const dir = tmp("v09-shim");
  try {
    const file = join(dir, "shim.jsonl");
    const pc = (trigger, delivered = true) => ({ channel: "precompact", event: "PreCompact", ...(trigger === undefined ? {} : { trigger }), delivered, bytes: 10 });
    writeFileSync(file, [pc("manual"), pc("auto"), pc("auto"), pc(null), pc(undefined), pc("auto", false)].map(line).join("\n") + "\n");
    const t = triggerTelemetry(file, []);
    assert.equal(t.precompact.deliveries, 5);
    assert.deepEqual(t.precompactByTrigger, { manual: 1, auto: 2, unknown: 2 });
    assert.deepEqual(triggerTelemetry(null, []).precompactByTrigger, { manual: 0, auto: 0, unknown: 0 });
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- automatic compaction mode

test("v09: automatic mode detects host compactions, asks the probe of that boundary, and sends no /compact", async () => {
  const { r, batch } = await runSuite("v09-auto-smoke", { hostOpts: { autoCompactAt: 100000, contextPerTurn: 20000, contextAfterCompact: 10000 } });
  assert.equal(r.exitCode, 0);
  assert.equal(batch.autoCompact, true);
  assert.equal(batch.precompactGeneralInstruction.file, "configs/precompact-general-instruction.txt");
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.turns.filter((t) => t.kind === "compact").length, 0, "no /compact");
  // Context: intro 20k, stage-1 40k, ... stage-4 reaches 100k and compacts to 10k; then every 4 turns (probe + 3 stages).
  assert.deepEqual(rec.compactions.map((c) => c.turn), ["stage-4", "stage-8", "stage-12", "stage-16", "stage-20", "stage-24"]);
  for (const c of rec.compactions) {
    assert.equal(c.trigger, "auto");
    assert.equal(c.hostTrigger, "auto");
    assert.equal(c.confirmed, true);
    assert.equal(c.mechanism, AUTO_COMPACT_MECHANISM);
    assert.equal(c.afterStage, Number(c.turn.slice("stage-".length)));
    assert.ok(c.preTokens >= 100000);
    assert.equal(c.stateFileCopied, undefined, "no copy before an automatic compaction");
  }
  // A probe after each boundary with a compaction (the long task has no probe after its last stage).
  assert.deepEqual(rec.turns.filter((t) => t.kind === "checkpoint").map((t) => t.stage), [4, 8, 12, 16, 20]);
  const labels = rec.turns.map((t, i) => `${t.kind}-${t.stage ?? ""}`);
  assert.equal(labels[labels.indexOf("stage-4") + 1], "checkpoint-4");
  // The context size after each turn.
  const stages = rec.turns.filter((t) => t.kind === "stage");
  assert.deepEqual(stages.slice(0, 5).map((t) => t.contextTokens), [40000, 60000, 80000, 10000, 50000]);
  assert.ok(rec.turns.every((t) => Number.isInteger(t.contextTokens)));
  assert.deepEqual(rec.telemetry.triggers.precompactByTrigger, { manual: 0, auto: 6, unknown: 0 });
  assert.equal(rec.telemetry.triggers.precompact.deliveries, 6);
});

test("v09: automatic mode with no compaction of the host gives zero compactions and no probe", async () => {
  const { r } = await runSuite("v09-auto");
  assert.equal(r.exitCode, 0);
  assert.equal(r.records.length, 4);
  for (const rec of r.records) {
    assert.equal(rec.status, "completed");
    assert.deepEqual(rec.compactions, []);
    assert.equal(rec.turns.filter((t) => t.kind === "checkpoint" || t.kind === "compact").length, 0);
    assert.equal(rec.turns.filter((t) => t.kind === "stage").length, LONG_STAGES);
    assert.deepEqual(rec.telemetry.triggers.precompactByTrigger, { manual: 0, auto: 0, unknown: 0 });
  }
});

test("v09: manual compactions carry trigger manual; part 1 suites complete with --mock", async () => {
  for (const suite of ["v09-calib", "v09-smoke", "v09-full"]) {
    const { r, batch } = await runSuite(suite);
    assert.equal(r.exitCode, 0, suite);
    assert.ok(r.records.every((x) => x.status === "completed"), suite);
    assert.equal(batch.autoCompact, false);
    assert.equal(batch.precompactGeneralInstruction?.file ?? null, batch.modes.includes("R") ? "configs/precompact-general-instruction.txt" : null);
    assert.equal(batch.precompactStrongInstruction?.file ?? null, batch.modes.includes("Q") ? "configs/precompact-strong-instruction.txt" : null);
    for (const rec of r.records) {
      assert.deepEqual(rec.compactions.map((c) => [c.afterStage, c.trigger]), [[3, "manual"], [5, "manual"], [7, "manual"]], rec.runId);
      const want = ["Q", "R"].includes(rec.mode) ? 3 : 0;
      assert.deepEqual(rec.telemetry.triggers.precompactByTrigger, { manual: want, auto: 0, unknown: 0 }, rec.runId);
      assert.ok(rec.turns.filter((t) => t.kind === "compact").every((t) => t.contextTokens === null), "a compaction stream has no assistant usage");
    }
  }
});
