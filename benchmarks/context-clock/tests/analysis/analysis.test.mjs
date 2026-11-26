// Analysis worker tests (CONTRACT.md "Analysis"). The fixture numbers are in fixture.mjs; the expected values
// below are worked out by hand from that table.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { analyze, loadBatch } from "../../analysis/analyze.mjs";
import { bootstrapCi, computeSummary, sizeGroupsOf } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { renderCharts } from "../../analysis/charts.mjs";
import { seededRandom, stableStringify } from "../../analysis/util.mjs";
import { BATCH, HOST, writeFixture } from "./fixture.mjs";

const roots = [];
function fixture(opts) {
  const r = writeFixture(opts);
  roots.push(r);
  return r;
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function summaryOf(opts) {
  return computeSummary(loadBatch(fixture(opts), BATCH));
}

const rid = (taskId, mode, rep) => HOST + "__" + taskId + "__" + mode + "__r" + rep;

describe("per-mode metrics on the fixture batch", () => {
  const s = summaryOf();

  test("status counts and runs in accuracy", () => {
    assert.deepEqual(s.modes.A.statusCounts, { completed: 5, agent_failed: 1, timeout: 0, limit_exceeded: 0, infra_failed: 0, invalid: 0, ungraded: 0 });
    assert.deepEqual(s.modes.B.statusCounts, { completed: 5, agent_failed: 0, timeout: 1, limit_exceeded: 0, infra_failed: 0, invalid: 0, ungraded: 0 });
    assert.deepEqual(s.modes.C.statusCounts, { completed: 5, agent_failed: 0, timeout: 0, limit_exceeded: 0, infra_failed: 1, invalid: 1, ungraded: 0 });
    assert.equal(s.modes.A.includedRuns, 6);
    assert.equal(s.modes.B.includedRuns, 6);
    assert.equal(s.modes.C.includedRuns, 4);
    assert.deepEqual(s.modes.A.scoredZero, { agent_failed: 1, timeout: 0, limit_exceeded: 0 });
    assert.deepEqual(s.modes.B.scoredZero, { agent_failed: 0, timeout: 1, limit_exceeded: 0 });
  });

  test("success rate, mean score and continuity errors", () => {
    assert.equal(s.modes.A.successRate, 0.3333);
    assert.equal(s.modes.A.meanScore, 0.5833);
    assert.equal(s.modes.B.successRate, 0.3333);
    assert.equal(s.modes.B.meanScore, 0.625);
    assert.equal(s.modes.C.successRate, 0.75);
    assert.equal(s.modes.C.meanScore, 0.9375);
    assert.equal(s.modes.A.meanContinuityErrors, 1);
    assert.deepEqual(s.modes.A.errorCounts, { lost_progress: 3, obsolete_decision: 1, wrong_relationship: 2 });
    assert.equal(s.modes.B.meanContinuityErrors, 0.8333);
    assert.deepEqual(s.modes.B.errorCounts, { lost_progress: 3, wrong_relationship: 2 });
  });

  test("splits by category, size and profile", () => {
    assert.deepEqual(s.modes.A.byCategory.A, { runs: 2, successRate: 0.5, meanScore: 0.75 });
    assert.deepEqual(s.modes.A.byCategory.B, { runs: 2, successRate: 0, meanScore: 0.125 });
    assert.deepEqual(s.modes.C.byCategory.B, { runs: 1, successRate: 0, meanScore: 0.75 });
    assert.deepEqual(s.modes.A.byCategory.D, { runs: 0, successRate: null, meanScore: null });
    assert.deepEqual(s.method.sizeGroups.map((g) => [g.group, g.tasks]), [["small", ["A1-x"]], ["medium", ["B1-y"]], ["large", ["C1-z"]]]);
    assert.deepEqual(s.modes.B.bySize.large, { runs: 2, successRate: 0.5, meanScore: 0.5 });
    assert.deepEqual(s.modes.A.byProfile.compaction, { runs: 2, successRate: 0, meanScore: 0.125 });
    assert.deepEqual(s.modes.A.byProfile.long, { runs: 4, successRate: 0.5, meanScore: 0.8125 });
  });

  test("pre-compaction and checkpoint accuracy", () => {
    assert.deepEqual(s.modes.A.postCompactionContinuity, { questions: 4, correct: 1, accuracy: 0.25 });
    assert.deepEqual(s.modes.B.postCompactionContinuity, { questions: 4, correct: 4, accuracy: 1 });
    assert.deepEqual(s.modes.C.postCompactionContinuity, { questions: 2, correct: 2, accuracy: 1 });
    assert.deepEqual(s.modes.A.checkpoint, { questions: 4, correct: 1, accuracy: 0.25 });
    assert.deepEqual(s.modes.C.checkpoint, { questions: 2, correct: 2, accuracy: 1 });
  });

  test("cost and overhead", () => {
    assert.equal(s.modes.C.cost.inputTokens.mean, 1300);
    assert.equal(s.modes.C.cost.totalTokens.mean, 1400);
    assert.equal(s.modes.C.cost.compactions.mean, 0.25);
    assert.equal(s.modes.A.cost.compactions.mean, 0.33);
    assert.equal(s.modes.C.cost.clockFeedbackBytes.mean, 400);
    assert.equal(s.modes.C.cost.commitCalls.total, 4);
    assert.deepEqual(s.overhead.C.fields.totalTokens, { meanA: 1100, mean: 1400, diff: 300, percent: 27.27 });
    assert.deepEqual(s.overhead.C.fields.durationMs, { meanA: 1000, mean: 1500, diff: 500, percent: 50 });
    assert.deepEqual(s.overhead.B.fields.totalTokens, { meanA: 1100, mean: 1200, diff: 100, percent: 9.09 });
    assert.equal(s.overhead.C.estimatedFeedbackTokensPerRun, 100);
    assert.equal(s.overhead.B.estimatedFeedbackTokensPerRun, 0);
  });
});

describe("paired comparison", () => {
  const s = summaryOf();

  test("C minus B drops pairs with an excluded C run", () => {
    const c = s.paired["C-B"];
    assert.equal(c.pairs, 4);
    assert.equal(c.droppedPairs, 2);
    assert.deepEqual(c.dropped.map((d) => [d.taskId, d.rep, d.missingOrExcluded]), [["B1-y", 2, ["C"]], ["C1-z", 2, ["C"]]]);
    assert.equal(c.meanDiff, 0.375);
    assert.equal(c.meanY, 0.5625);
    assert.equal(c.relativeDiff, 0.6667);
    assert.deepEqual([c.wins, c.ties, c.losses], [3, 1, 0]);
  });

  test("C minus A and B minus A", () => {
    const ca = s.paired["C-A"];
    assert.deepEqual([ca.pairs, ca.droppedPairs, ca.meanDiff, ca.wins, ca.ties, ca.losses], [4, 2, 0.3125, 3, 1, 0]);
    const ba = s.paired["B-A"];
    assert.deepEqual([ba.pairs, ba.droppedPairs, ba.meanDiff, ba.wins, ba.ties, ba.losses], [6, 0, 0.0417, 3, 2, 1]);
  });

  test("per-task means feed the C minus B chart", () => {
    assert.deepEqual(s.paired["C-B"].perTask, [
      { taskId: "A1-x", meanDiff: 0.125, pairs: 2 },
      { taskId: "B1-y", meanDiff: 0.25, pairs: 1 },
      { taskId: "C1-z", meanDiff: 1, pairs: 1 },
    ]);
  });

  test("a missing run directory drops the pair and is counted", () => {
    const m = summaryOf({ skipRuns: [rid("A1-x", "B", 1)] });
    assert.equal(m.paired["C-B"].pairs, 3);
    assert.equal(m.paired["C-B"].droppedPairs, 3);
    assert.ok(m.paired["C-B"].dropped.some((d) => d.taskId === "A1-x" && d.rep === 1 && d.missingOrExcluded.join() === "B"));
    assert.equal(m.paired["B-A"].pairs, 5);
  });

  test("a mode with no run gives no pair and no crash", () => {
    const only = summaryOf({ rows: [["A1-x", 1, "A", "completed", [1, 1, 1, 1]]] });
    assert.equal(only.paired["C-B"].pairs, 0);
    assert.equal(only.paired["C-B"].meanDiff, null);
    assert.equal(only.paired["C-B"].ci95, null);
    assert.equal(only.modes.C.includedRuns, 0);
  });
});

describe("bootstrap", () => {
  const pairs = [
    { host: "h", taskId: "t1", rep: 1, diff: 0.5 }, { host: "h", taskId: "t1", rep: 2, diff: 0.25 },
    { host: "h", taskId: "t2", rep: 1, diff: -0.25 }, { host: "h", taskId: "t2", rep: 2, diff: 0 },
    { host: "h", taskId: "t3", rep: 1, diff: 1 }, { host: "h", taskId: "t3", rep: 2, diff: 0.75 },
  ];

  test("same pairs and seed give the same interval", () => {
    assert.deepEqual(bootstrapCi(pairs), bootstrapCi(pairs.map((p) => ({ ...p }))));
    assert.deepEqual(bootstrapCi(pairs, 7, 2000), bootstrapCi(pairs, 7, 2000));
  });

  test("the interval lies within the task means and contains the sample mean", () => {
    const [lo, hi] = bootstrapCi(pairs);
    // Task means: t1 .375, t2 -.125, t3 .875; the overall mean is .375.
    assert.ok(lo >= -0.125 && hi <= 0.875, lo + " " + hi);
    assert.ok(lo <= 0.375 && hi >= 0.375);
  });

  test("resamples tasks, not runs: identical repetitions inside a task give only task-mean values", () => {
    const tied = [
      { host: "h", taskId: "a", rep: 1, diff: 1 }, { host: "h", taskId: "a", rep: 2, diff: 1 },
      { host: "h", taskId: "b", rep: 1, diff: 0 }, { host: "h", taskId: "b", rep: 2, diff: 0 },
    ];
    const [lo, hi] = bootstrapCi(tied, 1, 500);
    assert.ok([0, 0.5, 1].includes(lo) && [0, 0.5, 1].includes(hi));
  });

  test("fewer than two tasks gives no interval", () => {
    assert.equal(bootstrapCi(pairs.slice(0, 2)), null);
  });

  test("the seeded generator is deterministic", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
  });

  test("the fixture interval is stable", () => {
    const s1 = summaryOf();
    const s2 = summaryOf();
    assert.deepEqual(s1.paired["B-A"].ci95, s2.paired["B-A"].ci95);
    assert.ok(Array.isArray(s1.paired["B-A"].ci95));
  });
});

describe("exclusion rules", () => {
  test("infra_failed, invalid and ungraded runs are listed and outside accuracy; agent_failed and timeout count as 0", () => {
    const s = summaryOf({ ungraded: [rid("A1-x", "A", 2)] });
    const byId = new Map(s.listedRuns.map((r) => [r.runId, r]));
    assert.equal(byId.get(rid("B1-y", "C", 2)).excludedAs, "infra_failed");
    assert.equal(byId.get(rid("B1-y", "C", 2)).attempts, 3);
    assert.equal(byId.get(rid("B1-y", "C", 2)).failure, "rate limit");
    assert.equal(byId.get(rid("C1-z", "C", 2)).excludedAs, "invalid");
    assert.equal(byId.get(rid("C1-z", "C", 2)).violations, 1);
    assert.equal(byId.get(rid("A1-x", "A", 2)).excludedAs, "ungraded");
    assert.equal(byId.get(rid("B1-y", "A", 2)).inAccuracy, true);
    assert.equal(byId.get(rid("C1-z", "B", 1)).inAccuracy, true);
    assert.equal(s.modes.A.includedRuns, 5);
    assert.equal(s.modes.A.statusCounts.ungraded, 1);
    assert.equal(s.listedRuns.length, 5);
  });

  test("a non-completed run scores 0 even if its grade says otherwise", () => {
    const root = fixture();
    const data = loadBatch(root, BATCH);
    const rec = data.records.find((r) => r.run.runId === rid("C1-z", "B", 1));
    rec.grade.score = 1;
    rec.grade.success = true;
    const s = computeSummary(data);
    assert.equal(s.modes.B.meanScore, 0.625);
    assert.equal(s.modes.B.successRate, 0.3333);
  });
});

describe("differing cases and review merge", () => {
  test("every (taskId, rep) with a different per-question result is listed", () => {
    const s = summaryOf();
    assert.deepEqual(s.differingCases.map((c) => c.id), ["A1-x__r1", "B1-y__r1", "B1-y__r2", "C1-z__r1"]);
    assert.ok(s.differingCases.every((c) => c.classification === "unreviewed" && c.note === null));
  });

  test("a case holds wrong questions, expected values, events and telemetry per mode", () => {
    const c = summaryOf().differingCases.find((x) => x.id === "B1-y__r1");
    assert.deepEqual(Object.keys(c.modes), ["A", "B", "C"]);
    assert.equal(c.category, "B");
    assert.equal(c.profile, "compaction");
    const q2 = c.modes.A.wrongQuestions.find((q) => q.id === "q2");
    assert.deepEqual(q2, {
      id: "q2", given: "wrong", expected: "B1-y-q2-value", aspect: "current_state", errorCategory: "obsolete_decision",
      preCompaction: true, establishedBy: [{ id: "e002", stage: 2, summary: "event for q2 | pipe" }], retrieval: null, coverage: null,
    });
    assert.deepEqual(c.modes.C.wrongQuestions.map((q) => q.id), ["q4"]);
    assert.deepEqual(c.modes.C.telemetry, { clockFeedbackCount: 2, clockFeedbackBytes: 400, commitCalls: 1, statusCalls: 1, compactions: 1, unconfirmedCompactions: 0, guardDenied: null });
    assert.equal(c.modes.C.score, 0.75);
  });

  test("excluded runs are not part of a case; an agent_failed run shows every question wrong", () => {
    const c = summaryOf().differingCases.find((x) => x.id === "B1-y__r2");
    assert.deepEqual(Object.keys(c.modes), ["A", "B"]);
    assert.equal(c.modes.A.status, "agent_failed");
    assert.equal(c.modes.A.wrongQuestions.length, 4);
    assert.equal(c.modes.A.wrongQuestions[0].given, null);
  });

  test("review.json fills classification, note and recommendation; unknown keys are reported", () => {
    const review = {
      "A1-x__r1": { classification: "feedback_helped", note: "C reread the clock block before answering" },
      "Z9-none__r1": { classification: "x" },
      recommendation: "Keep feedback on for the next batch.",
    };
    const root = fixture({ review });
    const { summary } = analyze({ root, batch: BATCH });
    const c = summary.differingCases.find((x) => x.id === "A1-x__r1");
    assert.equal(c.classification, "feedback_helped");
    assert.equal(c.note, "C reread the clock block before answering");
    assert.deepEqual(summary.review.unmatchedKeys, ["Z9-none__r1"]);
    const report = readFileSync(join(root, "results", BATCH, "report.md"), "utf8");
    assert.ok(report.includes("## Recommendation\n\nKeep feedback on for the next batch.\n"));
    assert.ok(report.includes("feedback_helped"));
    assert.ok(report.includes("Z9-none__r1"));
  });
});

describe("outputs", () => {
  test("analyze writes summary, report and four charts", () => {
    const root = fixture({ batchJson: { cli: { version: "2.1.330" }, model: "claude-haiku-5-5", commit: "abc123", seeds: { order: 1 } } });
    const { written } = analyze({ root, batch: BATCH });
    assert.deepEqual(written, ["summary.json", "report.md", "charts/paired-diff-primary.svg", "charts/score-by-category.svg", "charts/success-rate.svg", "charts/token-overhead.svg"]);
    const dir = join(root, "results", BATCH);
    assert.deepEqual(readdirSync(join(dir, "charts")).sort(), ["paired-diff-primary.svg", "score-by-category.svg", "success-rate.svg", "token-overhead.svg"]);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    for (const h of ["## Batch facts", "## Runs by status", "## Accuracy per mode", "## Paired comparison: final score", "## Overhead against A", "## Charts",
      "## Failed, timed out, limited, invalid and excluded runs", "## Differing cases", "## Limits", "## Recommendation"]) assert.ok(report.includes(h + "\n"), h);
    assert.ok(report.includes("| cli.version | 2.1.330 |"));
    assert.ok(report.includes("| commit | abc123 |"));
    assert.ok(report.includes("![Task success rate by mode](charts/success-rate.svg)"));
    assert.ok(report.includes("## Recommendation\n\nLead to complete.\n"));
    assert.ok(report.includes("not proof that the text reached the model"));
    assert.ok(report.includes("no significance claim"));
    assert.ok(report.includes("event for q2 \\| pipe"), "pipes in untrusted text are escaped");
    assert.ok(!report.includes("submitted_to_model"));
  });

  test("a second run gives byte-equal outputs", () => {
    const root = fixture({ review: { "C1-z__r1": { classification: "noise" } } });
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    const files = ["summary.json", "report.md", ...readdirSync(join(dir, "charts")).sort().map((f) => "charts/" + f)];
    const first = files.map((f) => readFileSync(join(dir, f)));
    analyze({ root, batch: BATCH });
    files.forEach((f, i) => assert.ok(first[i].equals(readFileSync(join(dir, f))), f));
    // A fresh copy of the same inputs in another folder gives the same bytes too.
    const root2 = fixture({ review: { "C1-z__r1": { classification: "noise" } } });
    analyze({ root: root2, batch: BATCH });
    files.forEach((f, i) => assert.ok(first[i].equals(readFileSync(join(root2, "results", BATCH, f))), f));
  });

  test("summary.json has sorted keys and no timestamp", () => {
    const root = fixture();
    analyze({ root, batch: BATCH });
    const text = readFileSync(join(root, "results", BATCH, "summary.json"), "utf8");
    assert.equal(text, stableStringify(JSON.parse(text)));
    assert.ok(!text.includes("2026-11-22T"));
  });

  test("charts are SVG with an explicit background and escaped text", () => {
    const s = summaryOf();
    const charts = renderCharts(s);
    for (const [name, svg] of Object.entries(charts)) {
      assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""), name);
      assert.ok(svg.includes("<rect x=\"0\" y=\"0\""), name);
      assert.ok(svg.includes("fill=\"#ffffff\""), name);
      assert.ok(!svg.includes("NaN") && !svg.includes("undefined"), name);
    }
    const evil = structuredClone(s);
    evil.paired["C-B"].perTask = [{ taskId: "<script>&", meanDiff: -0.5, pairs: 1 }];
    const svg = renderCharts(evil)["paired-diff-primary.svg"];
    assert.ok(svg.includes("&lt;script&gt;&amp;"));
    assert.ok(!svg.includes("<script>"));
  });

  test("report renders with no batch.json and an empty batch", () => {
    const s = computeSummary({ batchName: "empty", batch: null, review: null, tasks: new Map(), keys: new Map(), records: [] });
    const md = renderReport(s, null);
    assert.ok(md.includes("No `batch.json` was found"));
    assert.ok(md.includes("No differing case."));
    for (const svg of Object.values(renderCharts(s))) assert.ok(!svg.includes("NaN"));
  });

  test("CLI: missing batch folder fails with a message", () => {
    const root = fixture();
    assert.throws(() => analyze({ root, batch: "nope" }), /no runs folder/);
    assert.ok(existsSync(join(root, "results", BATCH, "runs")));
  });
});

describe("size groups", () => {
  test("equal task counts by approxBytes, ties by taskId, unknown size kept apart", () => {
    const tasks = new Map([
      ["t1", { params: { approxBytes: 5 } }], ["t2", { params: { approxBytes: 5 } }], ["t3", { params: { approxBytes: 9 } }],
      ["t4", { params: { approxBytes: 1 } }], ["t5", { params: { approxBytes: 30 } }], ["t6", { params: { approxBytes: 20 } }],
      ["t7", { params: {} }],
    ]);
    const g = sizeGroupsOf(["t1", "t2", "t3", "t4", "t5", "t6", "t7"], tasks);
    assert.deepEqual(g.groups.map((x) => x.tasks), [["t4", "t1"], ["t2", "t3"], ["t6", "t5"]]);
    assert.equal(g.byTask.get("t7"), "unknown");
    assert.deepEqual([g.groups[2].minBytes, g.groups[2].maxBytes], [20, 30]);
  });
});
