// Tests for the v0.7 analysis (EXPERIMENT-V07.md "Measurements"): modes N, T, P, freshness, trigger records, early
// wrong readings, reason and link facts, three compactions, and the calibration view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseRecord, precompactHookOf, recordStatus, stagesSinceWrite, summaryStatus, valueStatus, writeStagesOf } from "../../analysis/facts.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { comparisonsOf, computeSummary, MODE_NAMES } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { BATCH, FACTS3, FACTS5, PRECOMPACT_TEXT, runId, writeV07Fixture } from "./fixture-v07.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function analyzed(fn) {
  const { root } = writeV07Fixture();
  try {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- modes and comparisons ----------

test("v0.7 modes get labels; comparisons come from the suite, else the v0.7 defaults", () => {
  assert.deepEqual([MODE_NAMES.N, MODE_NAMES.T, MODE_NAMES.P], ["standing instruction", "threshold reminder", "summarizer instruction"]);
  assert.deepEqual(comparisonsOf({}, null, ["B", "L", "N", "P", "T"]).map((c) => c.id), ["N-B", "T-B", "P-B", "L-B", "N-L", "T-L", "P-L"]);
  const suites = { suites: { "v07-smoke": { comparisons: ["N-B", "T-B"] } } };
  assert.deepEqual(comparisonsOf({ suite: "v07-smoke" }, suites, ["B", "N", "T"]).map((c) => c.id), ["N-B", "T-B"]);
  assert.deepEqual(comparisonsOf({}, null, ["B", "L"]).map((c) => c.id), ["L-B"], "the calibration batch");
  assert.deepEqual(comparisonsOf({}, null, ["J", "L"]).map((c) => c.id), ["L-J"], "v0.6 unchanged");
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.comparisons.map((c) => c.id), ["N-B", "T-B", "P-B", "L-B", "N-L", "T-L", "P-L"]);
    assert.equal(s.comparisons[0].label, "N minus B (standing instruction against baseline, primary)");
  });
});

// ---------- reason and link facts ----------

test("reason and condition facts match by the same token rule", () => {
  const names = ["API gateway", "reason for api-gateway", "condition of feature-x", "condition of feature-y"];
  const [, reason, cond] = FACTS3;
  assert.deepEqual(recordStatus(parseRecord("reason(api-gateway): cost"), reason, names), { status: "correct", history: null, reasons: [] });
  assert.equal(recordStatus(parseRecord("api-gateway reason: cost"), reason, names).status, "correct");
  assert.equal(recordStatus(parseRecord("api-gateway: kong-gw"), reason, names).status, "missing", "the reason token is needed");
  assert.equal(recordStatus(parseRecord("condition of feature-x: only while region is eu"), cond, names).status, "correct");
  assert.equal(recordStatus(parseRecord("condition(feature-x): Only while region = EU"), cond, names).status, "formatted", "same content words");
  assert.equal(recordStatus(parseRecord("condition of feature-y: only while region is eu"), cond, names).status, "missing", "the entity is required");
  assert.equal(recordStatus(parseRecord("condition of feature-x: only while region is us"), cond, names).status, "incorrect");
  assert.equal(valueStatus("cost", FACTS5[1]), "stale");
  assert.equal(summaryStatus("- reason(api-gateway): latency", FACTS5[1], names).status, "correct");
  assert.equal(summaryStatus("```\ncondition of feature-x: only while region is eu\n```", cond, names).status, "correct");
});

// ---------- freshness, hooks and early wrong readings in facts.json ----------

test("stagesSinceWrite, writeStages and the PreCompact hook lines", () => {
  assert.equal(stagesSinceWrite([1, 2, 3, 6], 5), 2);
  assert.equal(stagesSinceWrite([1, 2, 3, 6], 7), 1);
  assert.equal(stagesSinceWrite([3, 5, 7], 3), 0);
  assert.equal(stagesSinceWrite([6], 5), null, "no write at or before the compaction");
  assert.equal(stagesSinceWrite(null, 5), null);
  assert.deepEqual(writeStagesOf({ telemetry: { stateFile: { writeStages: [3, 5] } } }), [3, 5]);
  assert.equal(writeStagesOf({ telemetry: { stateFile: { writes: 2 } } }), null);
  assert.equal(precompactHookOf([{ type: "system", subtype: "hook_response", hook_event: "SessionStart", stdout: "x" }]), null);
  assert.deepEqual(precompactHookOf([{ type: "system", subtype: "hook_response", hook_event: "PreCompact", stdout: "abc", outcome: "success" }]), { responses: 1, bytes: 3, success: 1 });
});

test("facts.json: three compactions, stagesSinceWrite, precompactHook and earlyWrong", () => {
  analyzed(({ dir }) => {
    const n = readJson(join(dir, "runs", runId("N"), "facts.json"));
    assert.deepEqual(n.compactions.map((c) => [c.afterStage, c.preTokens, c.stagesSinceWrite, c.precompactHook]), [[3, 50000, 0, null], [5, 55000, 2, null], [7, 60000, 1, null]]);
    assert.deepEqual(n.compactions.map((c) => c.facts.map((f) => f.stateFile)), [["correct", "correct", "correct"], ["stale", "stale", "correct"], ["correct", "correct", "formatted"]]);
    assert.deepEqual(n.questions.map((q) => [q.id, q.compactionStage, q.correct, q.earlyWrong]), [["q1", 7, false, true], ["q2", 7, false, true], ["q3", 7, true, null]]);
    const b = readJson(join(dir, "runs", runId("B"), "facts.json"));
    assert.deepEqual(b.compactions.map((c) => c.stagesSinceWrite), [null, null, null]);
    assert.deepEqual(b.questions.find((q) => q.id === "q1").earlyWrong, false, "the summary at compaction 5 is right; it goes stale at 7");
    const p = readJson(join(dir, "runs", runId("P"), "facts.json"));
    assert.deepEqual(p.compactions.map((c) => c.precompactHook), [1, 2, 3].map(() => ({ responses: 1, bytes: Buffer.byteLength(PRECOMPACT_TEXT), success: 1 })));
  });
});

// ---------- summary ----------

test("summary: freshness per mode", () => {
  analyzed(({ summary: s }) => {
    const n = s.modes.N.freshness;
    assert.deepEqual([n.compactions, n.compactionsWithStateFile, n.stateFileShare, n.writesPerStage], [3, 3, 1, 0.5]);
    assert.deepEqual(n.stagesSinceWrite, { 0: 1, 1: 1, "2+": 1, none: 0 });
    assert.deepEqual(n.heldBySinceWrite["2+"], { facts: 3, held: 1, share: 0.3333 });
    assert.deepEqual(n.lastWrites, [{ runId: runId("N"), lastWriteStage: 6, writeStages: [1, 2, 3, 6] }]);
    assert.deepEqual(s.modes.L.freshness.stagesSinceWrite, { 0: 3, 1: 0, "2+": 0, none: 0 });
    const b = s.modes.B.freshness;
    assert.deepEqual([b.stateFileShare, b.stagesSinceWrite, b.heldBySinceWrite], [0, null, null], "no writeStages: n/a");
  });
});

test("summary: trigger records per mode", () => {
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.modes.N.triggers.standing, { runs: 1, deliveries: 4, meanPerRun: 4, perRun: [{ runId: runId("N"), deliveries: 4 }] });
    const r = s.modes.T.triggers.reminder;
    assert.deepEqual(r.list.map((f) => [f.turn, f.stage, f.estimate, f.nextCompactionStage, f.nextPreTokens, f.difference]),
      [[3, 3, 41000, 3, 50000, -9000], ["stage-6", 6, 45000, 7, 60000, -15000], ["stage-7", 7, 47000, 7, 60000, -13000]]);
    assert.deepEqual([r.perCompaction, r.afterLastCompaction, r.unreadable, r.meanDifference], [{ 0: 1, 1: 1, more: 1 }, 0, 0, -12333.33]);
    assert.deepEqual(s.modes.P.triggers.precompact, { runs: 1, deliveries: 3, compactions: 3, perCompaction: 1 });
    assert.deepEqual(s.modes.P.triggers.precompactStream, { compactions: 3, compactionsWithHookLine: 3, responses: 3, success: 3, meanBytes: Buffer.byteLength(PRECOMPACT_TEXT) });
    assert.equal(s.modes.B.triggers.precompactStream.compactionsWithHookLine, 0);
    assert.deepEqual([s.modes.B.triggers.standing, s.modes.B.triggers.reminder, s.modes.B.triggers.precompact], [null, null, null]);
  });
});

test("summary: early wrong readings next to wrong final answers and anchoring candidates", () => {
  analyzed(({ summary: s }) => {
    const row = (m) => [s.modes[m].facts.wrongFinalWithFact, s.modes[m].facts.earlyWrong, s.modes[m].facts.earlyWrongKnown, s.modes[m].facts.anchoringCandidatesFinal];
    assert.deepEqual(row("N"), [2, 2, 2, 0]);
    assert.deepEqual(row("B"), [1, 0, 1, 0]);
    assert.deepEqual(row("L"), [0, 0, 0, 0]);
    assert.deepEqual(s.modes.N.compactionStages.map((c) => c.afterStage), [3, 5, 7], "three compactions");
  });
});

// ---------- report ----------

test("the report has the v0.7 sections", () => {
  analyzed(({ dir }) => {
    const md = readFileSync(join(dir, "report.md"), "utf8");
    for (const h of ["## State file freshness at each compaction", "## Trigger records", "## Early wrong readings"]) assert.ok(md.includes(h), h);
    assert.ok(!md.includes("## Calibration"), "not a calibration batch");
    assert.ok(md.includes("| compactions: 2 or more stages since the last write | n/a | 0.0% (0/3) | 33.3% (1/3) | n/a | 0.0% (0/3) |"));
    assert.ok(md.includes("| facts held: 2 or more stages since the last write | n/a | n/a | 33.3% (1/3) | n/a | n/a |"));
    assert.ok(md.includes("| " + runId("T") + " | T | stage-6 | 6 | 45000 | 40000 | 7 | 60000 | -15000 |"));
    assert.ok(md.includes("| early wrong readings | 0 | 0 | 2 | 0 | 0 |"));
    assert.ok(md.includes("| stream: compactions with a PreCompact hook line | 0/3 | 0/3 | 0/3 | 3/3 | 0/3 |"));
    assert.ok(md.includes("| 7 | 1 | 1 | 1 | 1 | 1 |"), "the compaction table has a row for stage 7");
  });
});

test("v0.7 output is byte-equal across two runs", () => {
  const { root } = writeV07Fixture();
  try {
    const dir = join(root, "results", BATCH);
    const files = ["summary.json", "report.md", join("runs", runId("N"), "facts.json")];
    analyze({ root, batch: BATCH });
    const first = files.map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf8")), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- calibration and old batches ----------

const rec = (taskId, mode, score) => ({
  run: { runId: taskId + "__" + mode, taskId, mode, rep: 1, status: "completed", telemetry: {} },
  grade: { valid: true, score, success: score === 1, questions: [] },
});

test("calibration view: B and L per task, with a flag where L is at 1.00", () => {
  const records = [rec("t1", "B", 0.5), rec("t1", "L", 1), rec("t2", "B", 0.25), rec("t2", "L", 0.75)];
  const s = computeSummary({ batchName: "cal", batch: { modes: ["B", "L"] }, tasks: new Map(), keys: new Map(), review: null, records });
  assert.deepEqual(s.calibration, {
    tasks: [{ taskId: "t1", B: 0.5, L: 1, lAtCeiling: true }, { taskId: "t2", B: 0.25, L: 0.75, lAtCeiling: false }],
    tasksWithLAtCeiling: 1, ceilingRule: 5, harderTasksNeeded: false,
  });
  const md = renderReport(s, null);
  assert.ok(md.includes("## Calibration: B and L per task"));
  assert.ok(md.includes("| t1 | 0.500 | 1.000 | yes |"));
  assert.ok(md.includes("Tasks with L at 1.00: 1 of 2. Harder tasks needed: no."));
  const other = computeSummary({ batchName: "x", batch: { modes: ["B", "L", "N"] }, tasks: new Map(), keys: new Map(), review: null, records });
  assert.equal(other.calibration, null);
});

test("an old batch without the v0.7 fields shows n/a", () => {
  const s = computeSummary({ batchName: "old", batch: null, tasks: new Map(), keys: new Map(), review: null, records: [rec("t1", "B", 1)] });
  const m = s.modes.B;
  assert.deepEqual([m.freshness.runs, m.freshness.stateFileShare, m.freshness.stagesSinceWrite], [0, null, null]);
  assert.deepEqual(m.triggers, { standing: null, reminder: null, precompact: null, precompactStream: null });
  assert.deepEqual([m.facts.earlyWrong, m.facts.wrongFinalWithFact], [null, null]);
  const md = renderReport(s, null);
  assert.ok(md.includes("| compactions with a state file | n/a |"));
  assert.ok(md.includes("| reminder: fired | n/a |"));
  assert.ok(md.includes("| early wrong readings | n/a |"));
});
