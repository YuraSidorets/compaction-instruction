// Tests for the v0.5 analysis: modes H and S, state correctness, state saves, stage turn cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildStateCorrectness, referenceLines } from "../../analysis/coverage.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { comparisonsOf, computeSummary, modesOf } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { BATCH, REF2, reference, runId, streams, TASKS, writeV05Fixture } from "./fixture-v05.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const T1 = TASKS[0][0];

function analyzed(fn) {
  const { root } = writeV05Fixture();
  try {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ root, dir, summary: readJson(join(dir, "summary.json")) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("referenceLines skips the first line and splits current and history values", () => {
  assert.deepEqual(referenceLines(REF2), {
    current: [
      { name: "owner of api", values: ["team-b"] },
      { name: "deps of api", values: ["db", "cache"] },
      { name: "deps of db", values: ["(none)"] },
    ],
    history: [{ name: "owner of api history", values: ["team-x", "team-a", "team-b"] }],
  });
  assert.deepEqual(referenceLines("state after stage 1\nno colon here\nx: \n"), { current: [], history: [] });
  assert.deepEqual(referenceLines(null), { current: [], history: [] });
});

test("buildStateCorrectness compares the block and the summary of each compaction with its reference", () => {
  const s = streams("F");
  const list = buildStateCorrectness([{ afterStage: 1, lines: s["compact-1"] }, { afterStage: 2, lines: s["compact-2"] }, { afterStage: 3, lines: s["compact-2"] }], reference(T1));
  assert.deepEqual(list, [
    { afterStage: 1, blockFound: true, summaryPresent: true, lines: 2, found: 2, historyLines: 1, historyFound: 1, summaryFound: 1, summaryHistoryFound: 0 },
    { afterStage: 2, blockFound: true, summaryPresent: true, lines: 3, found: 2, historyLines: 1, historyFound: 0, summaryFound: 1, summaryHistoryFound: 0 },
    { afterStage: 3, blockFound: true, summaryPresent: true, lines: null, found: null, historyLines: null, historyFound: null, summaryFound: null, summaryHistoryFound: null },
  ]);
  const h = buildStateCorrectness([{ afterStage: 1, lines: streams("H")["compact-1"] }], reference(T1));
  assert.deepEqual([h[0].blockFound, h[0].found, h[0].lines], [false, 0, 2], "no block: no line found");
});

test("coverage.json has one stateCorrectness entry for each compaction", () => {
  analyzed(({ dir }) => {
    const h = readJson(join(dir, "runs", runId(T1, "H"), "coverage.json"));
    assert.deepEqual(h.stateCorrectness.map((e) => [e.afterStage, e.blockFound, e.found, e.lines, e.historyFound]), [[1, false, 0, 2, 0], [2, true, 3, 3, 1]]);
    const s = readJson(join(dir, "runs", runId(T1, "S"), "coverage.json"));
    assert.deepEqual(s.stateCorrectness.map((e) => [e.summaryFound, e.summaryHistoryFound]), [[1, 0], [3, 1]]);
  });
});

test("modes H and S get labels and the H-F, H-B, S-B, F-B comparisons", () => {
  assert.deepEqual(modesOf({}, [{ run: { mode: "B" } }, { run: { mode: "S" } }]), ["B", "S"]);
  const list = comparisonsOf({}, null, ["B", "F", "H", "S"]);
  assert.deepEqual(list.map((c) => c.id), ["H-F", "H-B", "S-B", "F-B"]);
  assert.equal(list[0].label, "H minus F (state file against the commit step, primary)");
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.comparisons.map((c) => c.id), ["H-F", "H-B", "S-B", "F-B"]);
    assert.equal(s.baseline, "B");
    assert.deepEqual([s.modes.H.name, s.modes.S.name], ["state file", "compaction instruction"]);
    assert.equal(s.differingCaseRule, "modes F and H differ");
  });
});

test("the summary has state correctness, state saves and stage turn cost per mode", () => {
  analyzed(({ summary: s }) => {
    const f = s.modes.F.stateCorrectness;
    assert.deepEqual([f.compactions, f.compactionsWithReference, f.compactionsWithBlock, f.lines, f.found, f.foundShare, f.historyFoundShare], [4, 4, 4, 10, 8, 0.8, 0.5]);
    const h = s.modes.H.stateCorrectness;
    assert.deepEqual([h.compactionsWithBlock, h.foundShare, h.foundShareWithBlock, h.historyFoundShare], [2, 0.6, 1, 0.5]);
    assert.deepEqual([s.modes.B.stateCorrectness.summaryFoundShare, s.modes.B.stateCorrectness.summaryHistoryFoundShare], [0.4, 0]);
    assert.deepEqual([s.modes.S.stateCorrectness.summaryFoundShare, s.modes.S.stateCorrectness.summaryHistoryFoundShare], [0.8, 0.5]);
    assert.equal(s.modes.B.stateCorrectness.foundShare, 0);

    assert.deepEqual(s.modes.H.stateFile, { compliance: 0.5, readsAfterCompaction: null, readsTotal: null, runs: 2, stages: 4, stagesWithWrite: 2, writes: 6 });
    assert.deepEqual(s.modes.F.stateFile, { compliance: null, readsAfterCompaction: null, readsTotal: null, runs: 0, stages: null, stagesWithWrite: null, writes: null });

    assert.deepEqual(s.modes.F.stageCost, { meanTokensPerRun: 620, meanTokensPerStageTurn: 300, runs: 2, stageTurns: 4 });
    assert.deepEqual(s.overhead.F.stageTurnTokens, { diff: 200, mean: 300, meanA: 100, percent: 200 });
    assert.deepEqual(s.overhead.H.stageTurnTokens.diff, 50);
    assert.deepEqual(s.overhead.S.stageTurnTokens.diff, 0);
  });
});

test("the report has the v0.5 sections", () => {
  analyzed(({ dir }) => {
    const md = readFileSync(join(dir, "report.md"), "utf8");
    for (const h of ["## State saves per mode", "## State correctness at each compaction", "## Overhead against B"]) assert.ok(md.includes(h), h);
    assert.ok(md.indexOf("## State saves per mode") > md.indexOf("## Commit compliance per mode"));
    assert.ok(md.includes("| state save compliance | n/a | n/a | 50.0% | n/a |"));
    assert.ok(md.includes("| block: current-value lines found | 0.0% (0/10) | 80.0% (8/10) | 60.0% (6/10) | 0.0% (0/10) |"));
    assert.ok(md.includes("| summary: current-value lines found | 40.0% (4/10) | 40.0% (4/10) | 40.0% (4/10) | 80.0% (8/10) |"));
    assert.ok(md.includes("| mean total tokens per stage turn | 100 | 300 | 150 | 100 |"));
    assert.ok(md.includes("| mean total tokens per stage turn | +200 | +50 | 0 |"));
  });
});

test("v0.5 output is byte-equal across two runs", () => {
  const { root } = writeV05Fixture();
  try {
    const dir = join(root, "results", BATCH);
    const files = ["summary.json", "report.md", join("runs", runId(T1, "H"), "coverage.json")];
    analyze({ root, batch: BATCH });
    const first = files.map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf8")), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old batch without the v0.5 fields shows n/a", () => {
  const s = computeSummary({ batchName: "old", batch: null, tasks: new Map(), keys: new Map(), review: null, records: [
    { run: { runId: "a", taskId: "t", mode: "B", rep: 1, status: "completed", telemetry: {} }, grade: { valid: true, score: 1, success: true, questions: [] },
      coverage: { questions: [], statusCalls: { checkpoint: 0, final: 0 } } },
  ] });
  assert.equal(s.modes.B.stateCorrectness.compactions, null);
  assert.equal(s.modes.B.stateCorrectness.foundShare, null);
  assert.equal(s.modes.B.stateFile.compliance, null);
  assert.equal(s.modes.B.stageCost.meanTokensPerStageTurn, null);
  const md = renderReport(s, null);
  assert.ok(md.includes("| state save compliance | n/a |"));
  assert.ok(md.includes("| block: current-value lines found | n/a |"));
  assert.ok(md.includes("| compactions | n/a |"));
});
