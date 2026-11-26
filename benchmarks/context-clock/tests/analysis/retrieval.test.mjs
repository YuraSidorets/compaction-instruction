// Tests for analysis/retrieval.mjs and the v0.3 analysis paths (modes B, C, D, placebo, limits, error classes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildRetrieval, eventTags, parseStream, taskChunks, turnFacts, turnLabel, retrievalForRun } from "../../analysis/retrieval.mjs";
import { analyze, loadBatch, parseArgs } from "../../analysis/analyze.mjs";
import { comparisonsOf, modesOf, baselineOf } from "../../analysis/metrics.mjs";
import { BATCH, HOST, TASK_ID, TASK2_ID, key, streams, task, writeV03Fixture } from "./fixture-v03.mjs";

const runId = (t, m, r) => HOST + "__" + t + "__" + m + "__r" + r;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function withFixture(opts, fn) {
  const fx = writeV03Fixture(opts);
  try {
    return fn(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

// ---------- stream helpers ----------

test("eventTags finds tags with three or more digits, once each, in order", () => {
  assert.deepEqual(eventTags("x [e010] y [e2] [e0300] [e010] [eabc] [e040]"), ["e010", "e0300", "e040"]);
});

test("parseStream skips blank and cut lines", () => {
  assert.deepEqual(parseStream('{"a":1}\n\n{"b":\n{"c":3}\n'), [{ a: 1 }, { c: 3 }]);
});

test("turnLabel names stage turns with their stage", () => {
  assert.equal(turnLabel({ kind: "stage", stage: 3 }), "stage-3");
  assert.equal(turnLabel({ kind: "final" }), "final");
});

test("turnFacts pairs tool results with their calls and marks a compaction", () => {
  const f = turnFacts(streams("C")["stage-1"]);
  assert.deepEqual(f.calls.map((c) => [c.name.split("__").pop(), c.results.length]), [["Read", 1], ["Bash", 1], ["ctx_search", 1]]);
  assert.equal(f.assistantTexts.length, 2);
  assert.equal(f.compactBoundary, false);
  const c = turnFacts(streams("B")["compact-2"]);
  assert.equal(c.compactBoundary, true);
  assert.deepEqual(c.userTexts.map(eventTags), [["e030"]]);
});

// ---------- chunks ----------

test("taskChunks uses the v0.3 chunk list when present", () => {
  const cs = taskChunks(task());
  assert.deepEqual(cs.map((c) => [c.chunkId, c.stage, c.kind, c.bytes]), [
    ["s1-file-a", 1, "file", 120], ["s1-feed-big", 1, "feed", 9000], ["s2-file-b", 2, "file", 100], ["s3-feed-log", 3, "feed", 800],
  ]);
});

test("taskChunks derives chunks from staged files and feeds of an old task", () => {
  const old = { stages: [{ stage: 2, files: [{ path: "inbox/s2/n.md", content: "- [e201] queue é" }], feeds: [{ name: "s2-audit", content: "[e202]\n[e203]" }] }] };
  assert.deepEqual(taskChunks(old), [
    { chunkId: "s2:file:inbox/s2/n.md", stage: 2, kind: "file", name: "inbox/s2/n.md", bytes: 17, events: ["e201"] },
    { chunkId: "s2:feed:s2-audit", stage: 2, kind: "feed", name: "s2-audit", bytes: 13, events: ["e202", "e203"] },
  ]);
});

// ---------- the retrieval record ----------

test("the retrieval record has one known case per errorClass", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const r = readJson(join(root, "results", BATCH, "runs", runId(TASK_ID, "C", 1), "retrieval.json"));
    assert.equal(r.schema, 1);
    assert.deepEqual(r.compactionTurns, ["compact-2"]);
    assert.equal(r.streamsFound, 7);
    assert.equal(r.streamsExpected, 7);
    const byId = Object.fromEntries(r.questions.map((q) => [q.id, q]));
    assert.equal(byId.q1.errorClass, "compaction_recovery");
    assert.deepEqual([byId.q1.visibleBefore, byId.q1.visibleAfter], [["e010"], []]);
    assert.equal(byId.q2.errorClass, "retrieval");
    assert.deepEqual(byId.q2.neverVisible, ["e020"]);
    assert.equal(byId.q3.errorClass, "state_tracking");
    assert.equal(byId.q4.errorClass, "reasoning");
    assert.deepEqual([byId.q4.visibleBefore, byId.q4.visibleAfter], [["e030"], ["e030"]], "the compaction summary counts as after");
    assert.equal(byId.q5.errorClass, "indeterminate");
    assert.equal(byId.c1.scope, "probe");
    assert.equal(byId.c1.errorClass, null);
  });
});

test("chunks record request, cut and follow-up from the streams", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const r = readJson(join(root, "results", BATCH, "runs", runId(TASK_ID, "C", 1), "retrieval.json"));
    const big = r.chunks.find((c) => c.chunkId === "s1-feed-big");
    assert.deepEqual([big.requested, big.cut, big.followUp, big.eventsTotal, big.eventsVisible], [true, true, true, 2, 1]);
    const file = r.chunks.find((c) => c.chunkId === "s1-file-a");
    assert.deepEqual([file.requested, file.cut, file.followUp], [true, false, false]);
    const q2 = r.questions.find((q) => q.id === "q2");
    assert.equal(q2.agentNotedGap, true, "the stage-1 text says the output was truncated");
  });
});

test("assistant mentions count the clock in C and the placebo tag in D", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH, "runs");
    const c = readJson(join(dir, runId(TASK_ID, "C", 1), "retrieval.json")).assistantMentions;
    const d = readJson(join(dir, runId(TASK_ID, "D", 1), "retrieval.json")).assistantMentions;
    const b = readJson(join(dir, runId(TASK_ID, "B", 1), "retrieval.json")).assistantMentions;
    assert.deepEqual([c.clock, c.placebo, c.messages], [1, 0, 5]);
    assert.deepEqual([d.clock, d.placebo, d.messages], [0, 1, 5]);
    assert.deepEqual([b.clock, b.placebo, b.messages], [0, 0, 4]);
  });
});

test("only the last attempt counts", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const r = readJson(join(root, "results", BATCH, "runs", runId(TASK_ID, "D", 1), "retrieval.json"));
    const q2 = r.questions.find((q) => q.id === "q2");
    assert.deepEqual([q2.errorClass, q2.neverVisible], ["retrieval", ["e020"]]);
  });
});

test("a run that did not complete is tool_or_infrastructure", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const r = readJson(join(root, "results", BATCH, "runs", runId(TASK_ID, "B", 2), "retrieval.json"));
    assert.deepEqual([...new Set(r.questions.map((q) => q.errorClass))], ["tool_or_infrastructure"]);
  });
});

test("stage-0 events never decide the retrieval class", () => {
  const t = task();
  const k = key();
  k.answers.q1.establishedBy = ["e001"];
  const run = { status: "completed", compactions: [{ afterStage: 2, confirmed: true }], turns: [{ kind: "stage", stage: 1 }, { kind: "final" }] };
  const grade = { questions: [{ id: "q1", correct: false, given: "other", reason: "wrong_value" }], checkpointItems: [] };
  const turns = [{ label: "stage-1", kind: "stage", stage: 1, lines: [] }, { label: "final", kind: "final", stage: null, lines: [] }];
  const r = buildRetrieval({ task: t, key: k, run, grade, turns });
  assert.deepEqual(r.questions.map((q) => [q.id, q.errorClass]), [["q1", "reasoning"]]);
});

test("without a confirmed compaction the before and after lists are empty", () => {
  const run = { status: "completed", compactions: [{ afterStage: 2, confirmed: false }], turns: [] };
  const grade = { questions: [{ id: "q1", correct: false, given: "other", reason: "wrong_value" }], checkpointItems: [] };
  const lines = streams("B");
  const turns = Object.entries(lines).map(([label, ls]) => ({ label, kind: label.split("-")[0], stage: null, lines: ls }));
  const r = buildRetrieval({ task: task(), key: key(), run, grade, turns });
  assert.deepEqual(r.compactionTurns, []);
  assert.deepEqual([r.questions[0].visibleBefore, r.questions[0].visibleAfter, r.questions[0].errorClass], [[], [], "reasoning"]);
});

test("retrievalForRun returns null without a raw stream", () => {
  assert.equal(retrievalForRun({ task: task(), key: key(), run: { turns: [] }, grade: null, rawRunDir: join("no", "such", "dir") }), null);
});

// ---------- v0.3 summary ----------

test("modes, comparisons and baseline come from batch.json and the suite", () => {
  assert.deepEqual(modesOf({ modes: ["B", "C", "D"] }, []), ["B", "C", "D"]);
  assert.deepEqual(modesOf({}, [{ run: { mode: "A" } }]), ["A", "B", "C"]);
  assert.deepEqual(comparisonsOf({}, null, ["B", "C", "D"]).map((c) => c.id), ["C-D", "D-B", "C-B"]);
  assert.deepEqual(comparisonsOf({}, null, ["A", "B", "C"]).map((c) => c.id), ["C-B", "C-A", "B-A"]);
  assert.deepEqual(comparisonsOf({ comparisons: ["D-B"] }, null, ["B", "C", "D"]).map((c) => c.id), ["D-B"]);
  assert.equal(baselineOf(["B", "C", "D"]), "B");
  assert.equal(baselineOf(["A", "B", "C"]), "A");
});

test("the v0.3 summary has placebo modes, error classes, limits and channel counts", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const s = readJson(join(root, "results", BATCH, "summary.json"));
    assert.deepEqual(s.modeList, ["B", "C", "D"]);
    assert.deepEqual(s.comparisons.map((c) => c.id), ["C-D", "D-B", "C-B"]);
    assert.equal(s.baseline, "B");
    assert.deepEqual(s.runs, { tasks: 2, total: 9, withCoverage: 9, withRetrieval: 9 });
    assert.equal(s.differingCaseRule, "modes C and D differ");

    const B = s.modes.B, C = s.modes.C, D = s.modes.D;
    assert.equal(B.statusCounts.limit_exceeded, 1);
    assert.deepEqual(B.limitHits, { wallTime: 1 });
    assert.deepEqual(C.errors.errorClasses, { compaction_recovery: 1, indeterminate: 1, reasoning: 1, retrieval: 1, state_tracking: 1, tool_or_infrastructure: 0 });
    assert.deepEqual([D.errors.errorClasses.retrieval, D.errors.wrongFinal, D.errors.retrievalFailureRate], [2, 2, 0.1333]);
    assert.equal(B.errors.errorClasses.tool_or_infrastructure, 5);
    assert.deepEqual([C.assistantMentions.clock, D.assistantMentions.placebo], [3, 3]);
    assert.deepEqual(C.postCompactionContinuity, { accuracy: 0.6667, correct: 4, questions: 6 });

    assert.equal(C.cost.shim_mcp_reply_real.mean, 3);
    assert.equal(D.cost.shim_mcp_reply_placebo.mean, 3);
    assert.equal(D.cost.shim_hook_context_placebo.mean, 1);
    assert.equal(B.cost.unconfirmedCompactions.mean, 0.33);
    assert.equal(B.cost.guardDenied.mean, 0.33);

    assert.equal(s.overhead.C.baseline, "B");
    assert.deepEqual(s.overhead.C.fields.toolCalls, { diff: 1, mean: 6, meanA: 5, percent: 20 });
    assert.deepEqual(Object.keys(s.paired).sort(), ["C-B", "C-D", "D-B"]);
    assert.deepEqual([s.paired["C-D"].pairs, s.paired["C-D"].meanDiff], [3, -0.2]);
    assert.ok(s.pairedPostCompaction["C-D"]);
    assert.ok(Array.isArray(s.paired["C-D"].sensitivity.rows));
    assert.equal(s.paired["C-D"].sensitivity.rows.length, 2);
  });
});

test("a limit_exceeded run scores zero and counts in the paired comparison", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const s = readJson(join(root, "results", BATCH, "summary.json"));
    const pair = s.paired["C-B"].perPair.find((p) => p.taskId === TASK_ID && p.rep === 2);
    assert.deepEqual([pair.x, pair.y], [1, 0]);
  });
});

test("differing cases focus on C and D and carry retrieval facts and mentions", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const s = readJson(join(root, "results", BATCH, "summary.json"));
    assert.deepEqual(s.differingCases.map((c) => c.id), [TASK_ID + "__r1", TASK2_ID + "__r1"]);
    const c = s.differingCases[0];
    assert.deepEqual(c.judgedModes, ["C", "D"]);
    assert.deepEqual(c.modes.C.assistantMentions, { clock: 1, messages: 5, placebo: 0 });
    assert.equal(c.modes.B.telemetry.guardDenied, 1);
    const q2 = c.modes.C.wrongQuestions.find((q) => q.id === "q2");
    assert.deepEqual([q2.retrieval.errorClass, q2.retrieval.cutChunks, q2.retrieval.followUp], ["retrieval", ["s1-feed-big"], [true]]);
  });
});

test("review.json classifies differing cases", () => {
  withFixture({ review: { [TASK_ID + "__r1"]: { classification: "noise", note: "x" }, recommendation: "hold" } }, ({ root }) => {
    analyze({ root, batch: BATCH });
    const s = readJson(join(root, "results", BATCH, "summary.json"));
    assert.equal(s.differingCases[0].classification, "noise");
    assert.equal(s.differingCases[1].classification, "unreviewed");
    assert.equal(s.review.recommendation, "hold");
  });
});

test("batch comparisons override the defaults", () => {
  withFixture({ batchExtra: { comparisons: ["C-B"] } }, ({ root }) => {
    analyze({ root, batch: BATCH });
    const s = readJson(join(root, "results", BATCH, "summary.json"));
    assert.deepEqual(s.comparisons.map((c) => c.id), ["C-B"]);
  });
});

test("the report has the v0.3 sections", () => {
  withFixture({}, ({ root }) => {
    analyze({ root, batch: BATCH });
    const md = readFileSync(join(root, "results", BATCH, "report.md"), "utf8");
    for (const h of [
      "## Errors per mode", "## Accuracy per task", "## Paired comparison: post-compaction continuity accuracy",
      "## Sensitivity: leave one task out", "## Feedback and placebo deliveries by channel", "## Overhead against B",
      "## Failed, timed out, limited, invalid and excluded runs",
    ]) assert.ok(md.includes(h), h);
    assert.ok(md.includes("class retrieval; needed e020"));
    assert.ok(existsSync(join(root, "results", BATCH, "charts", "paired-diff-primary.svg")));
  });
});

test("--raw-dir reads streams outside the batch folder", () => {
  withFixture({ rawElsewhere: true }, ({ root, rawRoot }) => {
    assert.deepEqual(parseArgs(["--batch", BATCH, "--raw-dir", rawRoot, "--root", root]), { batch: BATCH, rawDir: rawRoot, root });
    const loaded = loadBatch(root, BATCH, { rawDir: rawRoot });
    assert.equal(loaded.records.filter((r) => r.retrieval !== null).length, 9);
    const none = loadBatch(root, BATCH);
    assert.equal(none.records.filter((r) => r.retrieval !== null).length, 0);
  });
});

test("v0.3 output is byte-equal across two runs", () => {
  withFixture({}, ({ root }) => {
    const dir = join(root, "results", BATCH);
    analyze({ root, batch: BATCH });
    const first = ["summary.json", "report.md", join("runs", runId(TASK_ID, "C", 1), "retrieval.json")].map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    const second = ["summary.json", "report.md", join("runs", runId(TASK_ID, "C", 1), "retrieval.json")].map((f) => readFileSync(join(dir, f), "utf8"));
    assert.deepEqual(second, first);
  });
});
