// Tests for analysis/coverage.mjs and the v0.4 analysis paths (modes B, E, F, G).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildCoverage, lastBlockIn, lastReferenceText, lastStateBlock, lastSummary, textValues } from "../../analysis/coverage.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { comparisonsOf, computeSummary, modesOf } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { BATCH, key, runId, streams, TASKS, writeV04Fixture } from "./fixture-v04.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const T1 = TASKS[0][0];

function withFixture(opts, fn) {
  const fx = writeV04Fixture(opts);
  try {
    return fn(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

function analyzed(fn, opts = {}) {
  return withFixture(opts, ({ root }) => {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")) });
  });
}

// ---------- stream helpers ----------

test("textValues keeps strings and lists of strings only", () => {
  assert.deepEqual(textValues("a"), ["a"]);
  assert.deepEqual(textValues(["a", "b"]), ["a", "b"]);
  assert.equal(textValues(42), null);
  assert.equal(textValues(["a", 1]), null);
  assert.equal(textValues([]), null);
  assert.equal(textValues(true), null);
});

test("lastSummary takes the last user message that starts the continued session", () => {
  const lines = [
    { type: "user", message: { content: "This session is being continued. first" } },
    { type: "user", message: { content: "<local-command-stdout>Compacted</local-command-stdout>" } },
    { type: "user", message: { content: [{ type: "text", text: "This session is being continued. second" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "This session is being continued. not a user" }] } },
  ];
  assert.equal(lastSummary(lines), "This session is being continued. second");
  assert.equal(lastSummary([]), null);
});

test("lastBlockIn takes the last complete block", () => {
  assert.equal(lastBlockIn("x [committed-state]a[/committed-state] y [committed-state]b[/committed-state]"), "b");
  assert.equal(lastBlockIn("[committed-state]open only"), null);
  assert.equal(lastBlockIn("no block"), null);
});

test("lastStateBlock reads JSON and raw SessionStart hook outputs", () => {
  assert.equal(lastStateBlock(streams("F")["compact-2"]), "\nsummary: work\nfinding 1: beta gamma\nfinding 2: delta\n");
  assert.ok(lastStateBlock(streams("G")["compact-2"]).includes("store: delta"));
  assert.equal(lastStateBlock(streams("B")["compact-2"]), null);
  const other = [{ type: "system", subtype: "hook_response", hook_event: "PostToolUse", output: "[committed-state]x[/committed-state]" }];
  assert.equal(lastStateBlock(other), null, "only SessionStart replies count");
});

// ---------- the coverage record ----------

test("buildCoverage marks summary and block coverage for text answers only", () => {
  const run = { runId: "r", status: "completed" };
  const grade = { questions: [{ id: "q1", correct: true }, { id: "q2", correct: false }, { id: "q4", correct: true }] };
  const lines = streams("F")["compact-2"];
  const cov = buildCoverage({ key: key(T1), run, grade, compact: { label: "compact-2", lines }, turns: [] });
  assert.deepEqual(cov.questions, [
    { id: "q1", values: 1, inSummary: true, inBlock: false, correct: true },
    { id: "q2", values: 2, inSummary: false, inBlock: true, correct: false },
    { id: "q4", values: 1, inSummary: false, inBlock: true, correct: true },
  ]);
  assert.deepEqual([cov.summaryFound, cov.blockFound, cov.compactTurn], [true, true, "compact-2"]);
});

test("buildCoverage without a compact stream gives false, and a failed run is not correct", () => {
  const cov = buildCoverage({ key: key(T1), run: { status: "timeout" }, grade: { questions: [{ id: "q1", correct: true }] }, compact: null, turns: [] });
  assert.deepEqual(cov.questions[0], { id: "q1", values: 1, inSummary: false, inBlock: false, correct: false });
  assert.deepEqual([cov.summaryFound, cov.blockFound, cov.summaryBytes, cov.blockBytes], [false, false, null, null]);
});

test("coverage.json uses the last compact turn and counts status calls in probe and final turns", () => {
  analyzed(({ dir }) => {
    const f = readJson(join(dir, "runs", runId(T1, "F"), "coverage.json"));
    assert.equal(f.compactTurn, "compact-2");
    assert.deepEqual(f.questions.map((q) => [q.id, q.inSummary, q.inBlock]), [["q1", true, false], ["q2", false, true], ["q4", false, true]]);
    const g = readJson(join(dir, "runs", runId(T1, "G"), "coverage.json"));
    assert.deepEqual(g.statusCalls, { checkpoint: 1, final: 0 });
    assert.deepEqual(g.questions.map((q) => q.inBlock), [true, true, true]);
    const e = readJson(join(dir, "runs", runId(T1, "E"), "coverage.json"));
    assert.deepEqual(e.statusCalls, { checkpoint: 0, final: 2 });
    assert.equal(e.blockFound, false);
  });
});

// ---------- v0.4 summary ----------

test("v0.4 modes get labels and the F-E, G-B, E-B, F-B comparisons", () => {
  const modes = modesOf({}, [{ run: { mode: "B" } }, { run: { mode: "F" } }]);
  assert.deepEqual(modes, ["B", "F"]);
  assert.deepEqual(comparisonsOf({}, null, ["B", "E", "F", "G"]).map((c) => c.id), ["F-E", "G-B", "E-B", "F-B"]);
  const labels = comparisonsOf({}, null, ["B", "E", "F", "G"]).map((c) => c.label);
  assert.equal(labels[0], "F minus E (effect of the returned state, primary)");
});

test("the v0.4 summary has comparisons, baseline B, commits, state block and coverage cells", () => {
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.modeList, ["B", "E", "F", "G"]);
    assert.deepEqual(s.comparisons.map((c) => c.id), ["F-E", "G-B", "E-B", "F-B"]);
    assert.equal(s.baseline, "B");
    assert.deepEqual(Object.keys(s.overhead), ["E", "F", "G"]);
    assert.deepEqual(s.overhead.F.fields.toolCalls, { diff: 2, mean: 6, meanA: 4, percent: 50 });
    assert.deepEqual(s.runs, { tasks: 2, total: 8, withCoverage: 8, withRetrieval: 8 });
    assert.deepEqual(["F-E", "G-B", "E-B", "F-B"].map((id) => s.paired[id].meanDiff), [0.25, 0.5, 0, 0.25]);

    assert.deepEqual(s.modes.E.commits, { calls: 6, compliance: 0.5, ok: 4, rejected: { STALE_REVISION: 2 }, rejectedTotal: 2, runs: 2, stages: 4, stagesWithCommit: 2 });
    assert.deepEqual(s.modes.F.commits.compliance, 1);
    assert.deepEqual(s.modes.B.commits, { calls: null, compliance: null, ok: null, rejected: {}, rejectedTotal: null, runs: 0, stages: null, stagesWithCommit: null });
    assert.deepEqual(s.modes.F.stateBlock, { bytes: 600, bytesPerDelivery: 150, cuts: 2, deliveries: 4, findings: 6, missing: 0, runs: 2 });
    assert.equal(s.modes.B.stateBlock.deliveries, null);

    const cells = (m) => Object.fromEntries(Object.entries(s.modes[m].coverage.cells).map(([k, v]) => [k, v.correct + "/" + v.questions]));
    assert.deepEqual(cells("B"), { blockOnly: "0/0", neither: "0/4", summaryAndBlock: "0/0", summaryOnly: "2/2" });
    assert.deepEqual(cells("F"), { blockOnly: "4/4", neither: "0/0", summaryAndBlock: "0/0", summaryOnly: "2/2" });
    assert.deepEqual(cells("G"), { blockOnly: "4/4", neither: "0/0", summaryAndBlock: "2/2", summaryOnly: "0/0" });
    assert.deepEqual([s.modes.F.coverage.questions, s.modes.F.coverage.inSummary, s.modes.F.coverage.inBlock], [6, 2, 4]);
    assert.deepEqual(s.modes.E.coverage.statusCalls, { checkpoint: 0, final: 4 });
  });
});

test("the paired probe accuracy uses the task bootstrap", () => {
  analyzed(({ summary: s }) => {
    const g = s.pairedCheckpoint["G-B"];
    assert.deepEqual([g.pairs, g.meanDiff, g.ci95, g.wins], [2, 1, [1, 1], 2]);
    const fe = s.pairedCheckpoint["F-E"];
    assert.deepEqual([fe.pairs, fe.meanDiff, fe.ties], [2, 0, 2]);
  });
});

test("differing cases focus on E and F and carry coverage facts", () => {
  analyzed(({ summary: s }) => {
    assert.equal(s.differingCaseRule, "modes E and F differ");
    assert.deepEqual(s.differingCases.map((c) => c.judgedModes), [["E", "F"], ["E", "F"]]);
    const q2 = s.differingCases[0].modes.E.wrongQuestions.find((q) => q.id === "q2");
    assert.deepEqual(q2.coverage, { inSummary: false, inBlock: false });
    const q3 = s.differingCases[0].modes.F.wrongQuestions.find((q) => q.id === "q3");
    assert.equal(q3.coverage, null, "a number answer has no coverage");
  });
});

test("the report has the v0.4 sections", () => {
  analyzed(({ dir }) => {
    const md = readFileSync(join(dir, "report.md"), "utf8");
    for (const h of ["## Commit compliance per mode", "## State block facts per mode", "## Value coverage: host summary and returned block",
      "## Paired comparison: probe (checkpoint) accuracy", "## Overhead against B"]) assert.ok(md.includes(h), h);
    assert.ok(md.includes("| commit compliance | n/a | 50.0% | 100.0% | n/a |"));
    assert.ok(md.includes("| rejected: STALE_REVISION | n/a | 2 | 0 | n/a |"));
    assert.ok(md.includes("| not in summary, in block | n/a | n/a | 100.0% (4/4) | 100.0% (4/4) |"));
    assert.ok(md.includes("| F minus E (effect of the returned state, primary) |"));
  });
});

test("a batch without raw streams and v0.4 telemetry shows n/a and does not break", () => {
  analyzed(({ summary: s }) => {
    assert.equal(s.runs.withCoverage, 0);
    assert.equal(s.modes.F.coverage.runs, 0);
    assert.deepEqual(s.modes.F.coverage.statusCalls, { checkpoint: null, final: null });
  }, { noStreams: true });
  const s = computeSummary({ batchName: "old", batch: null, tasks: new Map(), keys: new Map(), review: null, records: [
    { run: { runId: "a", taskId: "t", mode: "B", rep: 1, status: "completed", telemetry: {} }, grade: { valid: true, score: 1, success: true, questions: [] } },
  ] });
  assert.equal(s.modes.B.commits.compliance, null);
  assert.ok(renderReport(s, null).includes("| commit compliance | n/a |"));
});

test("v0.4 output is byte-equal across two runs", () => {
  withFixture({}, ({ root }) => {
    const dir = join(root, "results", BATCH);
    const files = ["summary.json", "report.md", join("runs", runId(T1, "F"), "coverage.json")];
    analyze({ root, batch: BATCH });
    const first = files.map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf8")), first);
  });
});

test("buildCoverage adds inReference when a reference state text is given", () => {
  const key = { answers: { q1: { value: "alpha" }, q2: { value: ["alpha", "beta"] }, q3: { value: 3 } } };
  const cov = buildCoverage({ key, run: { status: "completed" }, grade: null, compact: null, turns: [], reference: "item: alpha" });
  assert.deepEqual(cov.questions.map((q) => [q.id, q.inReference]), [["q1", true], ["q2", false]]);
  assert.equal(lastReferenceText({ states: [{ afterStage: 4, text: "a" }, { afterStage: 6, text: "b" }] }), "b");
  assert.equal(lastReferenceText(null), null);
});
