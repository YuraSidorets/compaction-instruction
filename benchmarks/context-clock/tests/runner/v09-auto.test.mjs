// v0.9 part 2 after the smoke batch v09-auto-smoke-01 (EXPERIMENT-V09.md "Part 2: automatic compaction"):
// - the suite field autoCompactWindow sets CLAUDE_CODE_AUTO_COMPACT_WINDOW for the runs of that suite only, and every
//   other run loses an inherited CLAUDE_CODE_AUTO_COMPACT_WINDOW or CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
// - fault fix: a task with checkpoint.timing "after_auto_compaction" and a top-level afterStage gets no plain probe. In
//   the automatic mode a probe comes only after a stage turn with a detected automatic compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { checkpointsOf, loadTasks, validateTask } from "../../runner/plan.mjs";
import { BENCH_ROOT, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { HOST_COMPACT_VARS, modeEnv } from "../../runner/workspace.mjs";
import { validateRun } from "../../fixtures/schema.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const V09_DIR = join(BENCH_ROOT, "tasks", "v09", "generated");
const longTask = () => loadTasks(V09_DIR).find((t) => t.taskId.startsWith("A13"));

/** Run a suite with --mock on tasks/v09; `hostOpts` go to the mock host, which also records the env of each turn. */
async function runV09(suite, { hostOpts = {}, args = [] } = {}) {
  const results = tmp("v09a-res");
  const work = tmp("v09a-work");
  const envs = [];
  try {
    const host = createMockHost({
      mockDir: null,
      ...hostOpts,
      behave: ({ env }) => {
        envs.push({ ...env });
        return null;
      },
    });
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch, envs };
  } finally {
    cleanup(results, work);
  }
}

// ---------------------------------------------------------------- the task layout of the fault

test("v09 auto: the long task layout (timing after_auto_compaction, top-level afterStage 1) has no plain probe", () => {
  const t = longTask();
  assert.ok(t, "tasks/v09 holds the long task");
  assert.equal(t.checkpoint.timing, "after_auto_compaction");
  assert.equal(t.checkpoint.afterStage, 1);
  assert.equal(t.profile, "long");
  assert.deepEqual(validateTask(t), []);
  const probes = checkpointsOf(t);
  assert.equal(probes.length, t.checkpoint.probes.length);
  assert.ok(probes.every((p) => p.afterCompaction === true), "each probe waits for a compaction");
  assert.deepEqual(probes.map((p) => p.afterStage), t.checkpoint.probes.map((p) => p.afterStage));
  // A broken probe list of this timing is still an error.
  const bad = structuredClone(t);
  bad.checkpoint.probes[0].questionIds = ["no-such-question"];
  assert.match(validateTask(bad).join(";"), /questionIds do not name checkpoint questions/);
});

test("v09 auto: zero automatic compactions give zero probe turns (fault of v09-auto-smoke-01)", async () => {
  const { r } = await runV09("v09-auto-smoke");
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.deepEqual(rec.compactions, []);
  assert.deepEqual(rec.turns.filter((t) => t.kind === "checkpoint"), [], "no checkpoint-1");
  assert.equal(rec.turns.filter((t) => t.kind === "compact").length, 0);
  assert.equal(rec.answers.checkpoint, null);
  assert.deepEqual(validateRun(rec), []);
});

test("v09 auto: one detected automatic compaction in a stage turn gives exactly one probe turn for that boundary", async () => {
  const t = longTask();
  // Context: intro 20k, stage-1 40k, stage-2 60k, stage-3 80k; stage-4 reaches 100k and compacts to 10k; with 2k per
  // turn after it, the context does not reach 100k again in this task.
  const { r } = await runV09("v09-auto-smoke", { hostOpts: { autoCompactAt: 100000, contextPerTurn: 20000, contextAfterCompact: 10000 } });
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  const auto = rec.compactions;
  assert.ok(auto.length >= 1);
  assert.deepEqual(auto[0], { afterStage: 4, turn: "stage-4", confirmed: true, mechanism: auto[0].mechanism, preTokens: 100000, trigger: "auto", hostTrigger: "auto" });
  for (const c of auto) {
    assert.equal(c.trigger, "auto");
    assert.ok(Number.isInteger(c.preTokens) && c.preTokens >= 100000);
  }
  // Exactly one probe turn after each boundary with a compaction, directly after its stage turn, none elsewhere.
  const cps = rec.turns.filter((x) => x.kind === "checkpoint");
  const withProbe = auto.map((c) => c.afterStage).filter((s) => t.checkpoint.probes.some((p) => p.afterStage === s));
  assert.deepEqual(cps.map((x) => x.stage), withProbe);
  const kinds = rec.turns.map((x) => `${x.kind}-${x.stage ?? ""}`);
  for (const s of withProbe) assert.equal(kinds[kinds.indexOf(`stage-${s}`) + 1], `checkpoint-${s}`);
  // The probe asks only the questions of its boundary.
  const p4 = t.checkpoint.probes.find((p) => p.afterStage === 4);
  for (const id of p4.questionIds) assert.ok(id in rec.answers.checkpoint, id);
  assert.deepEqual(validateRun(rec), [], "profile long with automatic compactions is a valid run");
});

test("v09 auto: a suite without autoCompact rejects a task with probes after automatic compactions", () => {
  const configs = loadConfigs();
  assert.throws(
    () => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v09-smoke", "--mock", "--tasks", longTask().taskId]) }, configs),
    /probes after automatic compactions: it needs a suite with autoCompact true/,
  );
});

// ---------------------------------------------------------------- autoCompactWindow

test("v09 auto: modeEnv removes inherited compaction variables and sets the window only when asked", () => {
  const parent = { PATH: "x", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000", claude_autocompact_pct_override: "50", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" };
  for (const m of ["B", "N", "R", "H"]) {
    const e = modeEnv(m, "d", parent, "w");
    for (const k of Object.keys(e)) assert.ok(!HOST_COMPACT_VARS.some((v) => v.toLowerCase() === k.toLowerCase()), `${m} inherits ${k}`);
  }
  assert.equal(modeEnv("R", "d", parent, "w", { autoCompactWindow: 100000 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "100000");
  assert.equal(modeEnv("R", "d", parent, "w", { autoCompactWindow: 100000 }).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.throws(() => modeEnv("R", "d", {}, "w", { autoCompactWindow: 99999 }), /autoCompactWindow must be an integer >= 100000/);
});

test("v09 auto: the two automatic suites set CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 for their runs and record it", async () => {
  const configs = loadConfigs();
  for (const name of ["v09-auto-smoke", "v09-auto"]) assert.equal(configs.suites[name].autoCompactWindow, 100000, name);
  for (const name of ["v09-calib", "v09-smoke", "v09-full"]) assert.equal(configs.suites[name].autoCompactWindow, undefined, name);
  assert.throws(
    () => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v09-auto", "--mock"]) }, { ...configs, suites: { ...configs.suites, "v09-auto": { ...configs.suites["v09-auto"], autoCompactWindow: 50000 } } }),
    /autoCompactWindow must be an integer >= 100000/,
  );
  const saved = { w: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, p: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "777777";
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "40";
  try {
    const auto = await runV09("v09-auto", { args: ["--reps", "1"] });
    assert.equal(auto.batch.autoCompactWindow, 100000);
    assert.ok(auto.envs.length > 0);
    for (const e of auto.envs) {
      assert.equal(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "100000");
      assert.equal(e.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
    }
    for (const rec of auto.r.records) assert.equal(rec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "100000", rec.runId);
    // A suite without the field: the variables of the calling shell never reach a run.
    const plain = await runV09("v09-smoke");
    assert.equal(plain.batch.autoCompactWindow, null);
    for (const e of plain.envs) {
      assert.equal(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
      assert.equal(e.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
    }
    for (const rec of plain.r.records) assert.equal(rec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  } finally {
    for (const [k, v] of [["CLAUDE_CODE_AUTO_COMPACT_WINDOW", saved.w], ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", saved.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
