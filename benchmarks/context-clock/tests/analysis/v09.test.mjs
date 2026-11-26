// Tests for the v0.9 analysis (EXPERIMENT-V09.md "Measurements"): the matcher repair with the heading of a section
// and the "not assigned" status, mode R and its comparisons, tables per task shape, host summary length and the
// compactions that the host marked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { analyze } from "../../analysis/analyze.mjs";
import { FACT_STATUSES, FACT_STATUSES_V06, headingsOf, NOT_ASSIGNED, recordStatus, summaryStatus } from "../../analysis/facts.mjs";
import { comparisonsOf, factStatusesOf, isV08Batch, MODE_NAMES, shapeOf, suiteVersionOf } from "../../analysis/metrics.mjs";
import { B11_FACTS, BATCH, runId, SUMMARY_R1, SUMMARY_R2, writeV09Fixture } from "./fixture-v09.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const NAMES = B11_FACTS.map((f) => f.name);

function analyzed(fn, opts) {
  const { root } = writeV09Fixture(opts);
  try {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")), md: readFileSync(join(dir, "report.md"), "utf8") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("headingsOf: a colon heading, a heading with a colon in parentheses, a markdown heading", () => {
  assert.deepEqual(headingsOf(SUMMARY_R1.split("\n")).filter((_, i) => [1, 7].includes(i)), ["Owners", "Direct dependencies"]);
  const r2 = headingsOf(SUMMARY_R2.split("\n"));
  assert.deepEqual([r2[0], r2[2], r2[6]], ["Tracked state", "Owning team", "Direct dependencies"]);
  assert.deepEqual(headingsOf(["## Owners", "geo-index: team-pricing"]), ["Owners", "Owners"]);
  // A sentence before a list is not a heading; a list item never is.
  assert.deepEqual(headingsOf(["The changes are listed below.", "- geo-index: x", "- Owners", "- a: b"]), [null, null, null, null]);
  assert.deepEqual(headingsOf([]), []);
});

test("summaryStatus: the heading resolves a bare service line in both shapes of the B11 trace", () => {
  for (const text of [SUMMARY_R1, SUMMARY_R2]) {
    for (const f of B11_FACTS) assert.equal(summaryStatus(text, f, NAMES).status, "correct", f.name);
  }
});

test("summaryStatus: a tie that the heading cannot resolve is not assigned, not missing", () => {
  const bare = "geo-index: team-pricing\ngeo-index: heatmap-svc";
  for (const f of B11_FACTS.slice(0, 2)) {
    const s = summaryStatus(bare, f, NAMES);
    assert.equal(s.status, NOT_ASSIGNED, f.name);
    assert.deepEqual(s.reasons, ["a name ties with another fact"]);
  }
  // The history part: the owner history has no reading either.
  assert.equal(summaryStatus(bare, B11_FACTS[0], NAMES).history, NOT_ASSIGNED);
  // A fact with no line at all stays missing.
  assert.equal(summaryStatus(bare, B11_FACTS[2], NAMES).status, "missing");
  // A heading that names another fact does not assign the line.
  assert.equal(summaryStatus("On-call engineer:\ngeo-index: fumiko", B11_FACTS[0], [...NAMES, "on-call engineer for geo-index"]).status, "missing");
});

test("recordStatus: a tied line name gives not assigned; an assigned line keeps its status", () => {
  const lines = [{ name: "geo-index", history: false, value: "team-pricing" }];
  assert.deepEqual(recordStatus(lines, B11_FACTS[0], NAMES), { status: NOT_ASSIGNED, history: NOT_ASSIGNED, reasons: ["a line name ties with another fact"] });
  assert.equal(recordStatus([{ name: "geo-index owner", history: false, value: "team-pricing" }], B11_FACTS[0], NAMES).status, "correct");
  assert.equal(recordStatus([], B11_FACTS[0], NAMES).status, "missing");
});

test("fact status lists: v0.6 list for old suites, the list with not assigned for v08 and later", () => {
  assert.deepEqual(FACT_STATUSES, ["correct", "formatted", "stale", "incorrect", "missing", "not assigned", "absent"]);
  assert.deepEqual(FACT_STATUSES_V06, ["correct", "formatted", "stale", "incorrect", "missing", "absent"]);
  assert.equal(factStatusesOf({ suite: "v07-full" }, []), FACT_STATUSES_V06);
  assert.equal(factStatusesOf({ suite: "v08-full" }, []), FACT_STATUSES);
  const tied = [{ facts: { compactions: [{ facts: [{ summary: NOT_ASSIGNED }] }] } }];
  assert.equal(factStatusesOf({ suite: "v07-full" }, tied), FACT_STATUSES, "an old batch with the status shows its row");
  assert.deepEqual([suiteVersionOf({ suite: "v09-full" }), suiteVersionOf({ suite: "v10" }), suiteVersionOf({ suite: "full" }), suiteVersionOf(null)], [9, 10, null, null]);
  assert.deepEqual([isV08Batch({ suite: "v09-auto" }), isV08Batch({ suite: "v07-full" })], [true, false]);
});

test("mode R: label, v09 comparisons from the suite name or from mode R", () => {
  assert.equal(MODE_NAMES.R, "general summarizer instruction");
  const ids = (batch, modes) => comparisonsOf(batch, null, modes).map((c) => c.id);
  assert.deepEqual(ids({ suite: "v09-full" }, ["B", "N", "Q", "R"]), ["N-B", "Q-B", "R-B", "R-N", "R-Q"]);
  assert.deepEqual(ids({}, ["B", "R"]), ["R-B"], "v09-auto: B and R only");
  assert.deepEqual(ids({ suite: "v09-calib" }, ["B"]), []);
  assert.deepEqual(ids({ suite: "v08-full" }, ["B", "N", "Q", "U"]), ["N-B", "U-B", "Q-B", "U-N", "Q-N"], "v0.8 unchanged");
  assert.match(comparisonsOf({ suite: "v09-full" }, null, ["B", "N", "Q", "R"])[0].label, /^N minus B \(standing instruction against baseline, primary\)$/);
  assert.deepEqual([shapeOf({ shape: "worklog" }), shapeOf({}), shapeOf(null), shapeOf({ shape: "" })], ["worklog", "old", "old", "old"]);
});

test("v09 summary: shapes, accuracy and pairs per shape, coverage with both denominators, summary length", () => analyzed(({ summary }) => {
  const v = summary.v09;
  assert.deepEqual(summary.comparisons.map((c) => c.id), ["N-B", "Q-B", "R-B", "R-N", "R-Q"]);
  assert.deepEqual(v.shapes, ["old", "worklog"]);
  assert.deepEqual(v.byShape.old.tasks, ["R8-alpha"]);
  assert.deepEqual(v.byShape.worklog.tasks, ["R8-beta"]);
  // R8-alpha scores: B 0.5, N 1, Q 0.75, R 0.75 (R copies Q). R8-beta: B invalid, N 0.75, Q 0.75, R 0.75.
  assert.deepEqual(["B", "N", "Q", "R"].map((m) => v.byShape.old.modes[m].meanScore), [0.5, 1, 0.75, 0.75]);
  assert.deepEqual([v.byShape.worklog.modes.B.includedRuns, v.byShape.worklog.modes.B.invalid], [0, 1]);
  assert.deepEqual([v.byShape.old.paired["R-N"].pairs, v.byShape.old.paired["R-N"].meanDiff], [1, -0.25]);
  assert.deepEqual([v.byShape.worklog.paired["R-B"].pairs, v.byShape.worklog.paired["R-Q"].meanDiff], [0, 0]);
  assert.deepEqual(v.byShape.old.modes.R.checkpoint, { questions: 2, correct: 1, accuracy: 0.5 });
  // The fact tables per shape and per mode have the not assigned row and the coverage with both denominators.
  const t = summary.modes.Q.facts.current.summary;
  assert.ok(NOT_ASSIGNED in t.counts);
  assert.deepEqual(Object.keys(t.coverage).sort(), ["assigned", "held", "n", "share", "shareAssigned"]);
  assert.equal(t.coverage.assigned, t.n - t.counts[NOT_ASSIGNED]);
  assert.ok(NOT_ASSIGNED in v.byShape.worklog.modes.Q.facts.current.summary.counts);
  // Host summary length: every compaction of a run in the accuracy numbers has a summary.
  assert.deepEqual([v.summaryBytes.R.summaries, v.summaryBytes.B.summaries], [6, 3]);
  assert.ok(v.summaryBytes.R.meanBytes > v.summaryBytes.B.meanBytes, "Q and R summaries hold more facts");
  assert.deepEqual(Object.keys(v.summaryBytes.N.byShape), ["old", "worklog"]);
  // The decision helper has R-N and R-Q with the coverage over assigned facts.
  assert.deepEqual(Object.keys(summary.v08.decision).sort(), ["Q-N", "R-N", "R-Q"]);
  assert.ok("summaryCoverageAssigned" in summary.v08.decision["R-N"]);
}));

test("v09 compactions table: trigger, preTokens, probe accuracy after; a run with no compaction", () => analyzed(({ summary }) => {
  const c = summary.v09.compactions;
  const alphaR = c.rows.filter((r) => r.runId === runId("R8-alpha", "R"));
  assert.deepEqual(alphaR.map((r) => [r.n, r.afterStage, r.trigger, r.preTokens]), [[1, 3, "auto", 150000], [2, 5, "manual", 150001], [3, 7, "manual", 150002]]);
  assert.deepEqual(alphaR.map((r) => r.probe), [{ questions: 2, correct: 1, accuracy: 0.5 }, null, null]);
  assert.equal(c.rows.find((r) => r.runId === runId("R8-alpha", "N")).trigger, null, "no trigger field");
  assert.deepEqual(c.runs.find((r) => r.runId === runId("R8-beta", "B")), { runId: runId("R8-beta", "B"), mode: "B", taskId: "R8-beta", included: false, compactions: 0 });
  assert.equal(c.rows.filter((r) => r.runId === runId("R8-beta", "B")).length, 0);
  assert.deepEqual(c.triggers, { auto: 1, manual: 2, unknown: 18 });
}));

test("v09 report: sections and rows; the same input gives the same bytes", () => {
  const a = analyzed(({ md }) => md);
  const b = analyzed(({ md }) => md);
  assert.equal(a, b);
  for (const h of ["## Tables per task shape", "### Shape: old", "### Shape: work log", "## Host summary length", "## Compactions marked by the host"]) assert.ok(a.includes("\n" + h + "\n"), h);
  assert.match(a, /\| summary: not assigned \|/);
  assert.match(a, /\| summary: held, over assigned facts \|/);
  assert.match(a, /\| R general summarizer instruction \|/);
  assert.match(a, /Marked compactions by trigger: auto 1, manual 2, unknown 18\./);
  assert.match(a, /Runs with no marked compaction: claude__R8-beta__B__r1\./);
  assert.match(a, /\| claude__R8-alpha__R__r1 \| R \| yes \| 1 \| 3 \| auto \| 150000 \| 50\.0% \(1\/2\) \|/);
  assert.match(a, /Coverage over assigned facts \(first, second\)/);
});

test("an older suite has no v09 block, and its fact table keeps the v0.6 rows", () => analyzed(({ summary, md }) => {
  assert.equal(summary.v09, undefined);
  assert.equal(summary.v08, undefined);
  assert.ok(!md.includes("## Tables per task shape"));
  assert.ok(!(NOT_ASSIGNED in summary.modes.B.facts.current.summary.counts) || Object.values(summary.modes).some((m) => m.facts.current.summary.counts[NOT_ASSIGNED] > 0));
}, { suite: "v07-full" }));
