// Tests for the v0.8 analysis (EXPERIMENT-V08.md): modes U and Q, runs with denied attempts and the old-rule tables,
// cost per added call, the periodic reminder and the decision helper. A batch with another suite has no v08 block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { analyze } from "../../analysis/analyze.mjs";
import { comparisonsOf, computeSummary, isV08Batch, MODE_NAMES } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { BATCH, Q_TEXT, runId, writeV08Fixture } from "./fixture-v08.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function analyzed(fn, opts) {
  const { root } = writeV08Fixture(opts);
  try {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")), md: readFileSync(join(dir, "report.md"), "utf8") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("v0.8 modes get labels; comparisons come from the suite, else the v0.8 defaults", () => {
  assert.deepEqual([MODE_NAMES.U, MODE_NAMES.Q], ["periodic reminder", "stronger summarizer instruction"]);
  assert.deepEqual(comparisonsOf({}, null, ["B", "N", "Q", "U"]).map((c) => c.id), ["N-B", "U-B", "Q-B", "U-N", "Q-N"]);
  const suites = { suites: { "v08-smoke": { comparisons: ["U-N", "Q-N"] } } };
  assert.deepEqual(comparisonsOf({ suite: "v08-smoke" }, suites, ["B", "N", "Q", "U"]).map((c) => c.id), ["U-N", "Q-N"]);
  assert.deepEqual([isV08Batch({ suite: "v08-full" }), isV08Batch({ suite: "v07-full" }), isV08Batch(null)], [true, false, false]);
  analyzed(({ summary: s, md }) => {
    assert.deepEqual(s.comparisons.map((c) => c.id), ["N-B", "U-B", "Q-B", "U-N", "Q-N"]);
    assert.ok(md.includes("| Metric | B silent | N standing instruction | Q stronger summarizer instruction | U periodic reminder |"));
  });
});

test("Q counts as a PreCompact arm in the trigger records", () => {
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.modes.Q.triggers.precompact, { runs: 2, deliveries: 6, compactions: 6, perCompaction: 1 });
    assert.deepEqual(s.modes.Q.triggers.precompactStream, { compactions: 6, compactionsWithHookLine: 6, responses: 6, success: 6, meanBytes: Buffer.byteLength(Q_TEXT) });
    assert.deepEqual(s.modes.Q.facts.current.summary.counts.correct, 18, "Q keeps the reason and the condition");
  });
});

test("runs with denied attempts stay in the primary tables; the old rule gives a second set", () => {
  analyzed(({ summary: s, md }) => {
    const v = s.v08;
    assert.deepEqual(v.deniedRuns.perMode, { B: 0, N: 1, Q: 0, U: 0 });
    assert.deepEqual(v.deniedRuns.runs, [{ runId: runId("R8-beta", "N"), mode: "N", taskId: "R8-beta", rep: 1, violations: 1, deniedCalls: 1, guardDenied: 1 }]);
    assert.equal(s.modes.N.includedRuns, 2, "the denied run counts under the new rule");
    assert.deepEqual([s.paired["U-N"].pairs, s.paired["U-N"].meanDiff], [2, -0.125]);
    assert.deepEqual([v.oldRule.modes.N.includedRuns, v.oldRule.modes.N.invalid, v.oldRule.modes.N.meanScore], [1, 1, 1]);
    assert.deepEqual([v.oldRule.paired["U-N"].pairs, v.oldRule.paired["U-N"].droppedPairs, v.oldRule.paired["U-N"].meanDiff], [1, 1, 0]);
    assert.deepEqual([v.oldRule.modes.B.invalid, s.modes.B.includedRuns], [1, 1], "a violation that was not denied is invalid under both rules");
    for (const h of ["## Runs with denied attempts", "## Accuracy and paired comparison under the old rule", "## Cost per added call", "## Periodic reminder", "## Decision helper"]) assert.ok(md.includes(h), h);
    assert.ok(md.includes("| runs valid with denied attempts | 0 | 1 | 0 | 0 |"));
    assert.ok(md.includes("| U minus N (periodic reminder against the standing instruction) | 1 | 1 | 1.000 | 1.000 | 0.000 |"));
  });
});

test("cost per added call and cost in dollars", () => {
  analyzed(({ summary: s, md }) => {
    const c = s.v08.cost;
    assert.deepEqual(c.N, { runs: 2, toolCallsPerRun: 18, addedToolCallsPerRun: 8, tokensPerRun: 1800, addedTokensPerRun: 800, addedTokensPerAddedCall: 100, savesPerRun: 8, costUsdRuns: 2, costUsdPerRun: 0.2, costUsdTotal: 0.4 });
    assert.deepEqual([c.U.addedToolCallsPerRun, c.U.addedTokensPerRun, c.U.addedTokensPerAddedCall, c.U.savesPerRun], [4, 400, 100, 4]);
    assert.deepEqual([c.Q.addedTokensPerAddedCall, c.Q.costUsdPerRun, c.B.savesPerRun], [null, null, null], "no added call, no cost, no state file");
    assert.ok(md.includes("| added tokens per added call | n/a | 100 | n/a | 100 |"));
    assert.ok(md.includes("| cost in USD per run | 0.1000 | 0.2000 | n/a | 0.1500 |"));
  });
});

test("periodic reminder: prompts with turn and stage, save stages and freshness one stage old", () => {
  analyzed(({ summary: s, md }) => {
    const p = s.v08.periodic;
    assert.deepEqual(p.perMode, { U: { runs: 2, fired: 8, firedPerRun: 4, promptsPerRun: 9 } });
    assert.deepEqual(p.runs[0], { runId: runId("R8-alpha", "U"), mode: "U", prompts: 9, saveStages: [2, 4, 6, 8],
      fired: [2, 4, 6, 8].map((n) => ({ n, turn: "stage-" + n, stage: n })) });
    assert.deepEqual(s.modes.U.freshness.stagesSinceWrite, { 0: 0, 1: 6, "2+": 0, none: 0 });
    assert.ok(md.includes("| compactions: 1 stage since the last write | n/a | 0.0% (0/6) | n/a | 100.0% (6/6) |"));
  });
});

test("decision helper: U-N and Q-N with mean difference, coverage points and added tokens ratio", () => {
  analyzed(({ summary: s, md }) => {
    assert.deepEqual(s.v08.decision, {
      "U-N": { pairs: 2, meanDiff: -0.125, ci95: [-0.25, 0], summaryCoverage: { U: 0.3333, N: 0.3333 }, summaryCoverageAssigned: { U: 0.3333, N: 0.3333 }, summaryCoverageDiffPoints: 0, addedTokensPerRun: { U: 400, N: 800 }, addedTokensRatio: 0.5 },
      "Q-N": { pairs: 2, meanDiff: -0.125, ci95: [-0.25, 0], summaryCoverage: { Q: 1, N: 0.3333 }, summaryCoverageAssigned: { Q: 1, N: 0.3333 }, summaryCoverageDiffPoints: 66.67, addedTokensPerRun: { Q: 0, N: 800 }, addedTokensRatio: 0 },
    });
    assert.ok(md.includes("| U-N | 2 | -0.125 | [-0.250, 0.000] | 33.3%, 33.3% | 33.3%, 33.3% | 0.0 | +400, +800 | 0.500 |"));
  });
});

test("a batch whose suite is not v08 has no v08 block and no v08 section", () => {
  analyzed(({ summary: s, md }) => {
    assert.equal("v08" in s, false);
    assert.ok(!md.includes("## Runs with denied attempts"));
    assert.ok(!md.includes("## Decision helper"));
  }, { suite: "v07-full" });
  const old = computeSummary({ batchName: "old", batch: null, tasks: new Map(), keys: new Map(), review: null, records: [
    { run: { runId: "a", taskId: "t", mode: "B", rep: 1, status: "completed", telemetry: {} }, grade: { valid: true, score: 1, success: true, questions: [] } },
  ] });
  assert.equal("v08" in old, false);
  assert.ok(!renderReport(old, null).includes("## Cost per added call"));
});

test("v0.8 output is byte-equal across two runs", () => {
  const { root } = writeV08Fixture();
  try {
    const dir = join(root, "results", BATCH);
    analyze({ root, batch: BATCH });
    const first = ["summary.json", "report.md"].map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    assert.deepEqual(["summary.json", "report.md"].map((f) => readFileSync(join(dir, f), "utf8")), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
