// Tests for the analysis of probes after automatic compactions (EXPERIMENT-V09.md part 2): probe accuracy, the paired
// probe comparison and the probe error classes use the asked questions only; the compactions table gives the probe
// result of each boundary (correct / asked) and the numbers per mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { analyze } from "../../analysis/analyze.mjs";
import { probeQuestionsOf } from "../../analysis/metrics.mjs";
import { BATCH, runId, writeV09Fixture } from "./fixture-v09.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

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

test("probeQuestionsOf: asked when present, else questions", () => {
  assert.equal(probeQuestionsOf({ checkpoint: { questions: 116, asked: 58, correct: 52 } }), 58);
  assert.equal(probeQuestionsOf({ checkpoint: { questions: 16, correct: 9 } }), 16);
  assert.equal(probeQuestionsOf({ checkpoint: { questions: 4, asked: 0, correct: 0 } }), 0);
  assert.equal(probeQuestionsOf(null), 0);
});

test("probe accuracy, paired probe comparison and error classes use the asked questions only", () => analyzed(({ dir, summary }) => {
  // R of R8-alpha: c1 asked and correct, c2 not asked. Before the repair the share was 1 of 2.
  assert.deepEqual(summary.modes.R.checkpoint, { accuracy: 1, correct: 1, questions: 1 });
  // The paired probe comparison is per run: R8-alpha R scores 1/1, Q scores n/a (no probe question in its grade).
  const p = summary.pairedCheckpoint["R-Q"];
  assert.equal(p.pairs, 0, "Q has no probe question, so no pair");
  assert.equal(summary.v09.byShape.old.modes.R.checkpoint.questions, 1);
  // The error classes count probes of asked questions only: c1 is correct, so R has no probe with an error class.
  const ret = readJson(join(dir, "runs", runId("R8-alpha", "R"), "retrieval.json"));
  assert.deepEqual(ret.questions.filter((q) => q.scope === "probe").map((q) => q.id), ["c1"]);
  // The facts join leaves out the unasked probe.
  const fx = readJson(join(dir, "runs", runId("R8-alpha", "R"), "facts.json"));
  assert.ok(!fx.questions.some((q) => q.scope === "probe" && q.id === "c2"));
}, { auto: true }));

test("compactions table: probe result per boundary over asked questions, and numbers per mode", () => analyzed(({ summary, md }) => {
  const c = summary.v09.compactions;
  const rows = c.rows.filter((r) => r.runId === runId("R8-alpha", "R"));
  assert.deepEqual(rows.map((r) => r.probe), [{ accuracy: 1, correct: 1, questions: 1 }, null, null], "stage 5: c2 was not asked");
  assert.deepEqual(c.perMode.R, { compactions: 6, compactionsPerRun: 3, meanPreTokens: 150001, probe: { accuracy: 1, correct: 1, questions: 1 }, runs: 2 });
  assert.equal(c.perMode.B.runs, 1, "the invalid B run of R8-beta is outside");
  assert.equal(c.perMode.B.meanPreTokens, null, "no preTokens field");
  assert.match(md, /\| claude__R8-alpha__R__r1 \| R \| yes \| 1 \| 3 \| auto \| 150000 \| 100\.0% \(1\/1\) \|/);
  assert.match(md, /\| probe accuracy over asked questions \| /);
  assert.match(md, /\| marked compactions per run \| /);
  assert.match(md, /Probe result after \(correct \/ asked\)/);
}, { auto: true }));

test("planned probes: the probe numbers stay as before", () => analyzed(({ summary }) => {
  assert.deepEqual(summary.modes.R.checkpoint, { accuracy: 0.5, correct: 1, questions: 2 });
  assert.deepEqual(summary.v09.compactions.perMode.R.probe, { accuracy: 0.5, correct: 1, questions: 2 });
}));
