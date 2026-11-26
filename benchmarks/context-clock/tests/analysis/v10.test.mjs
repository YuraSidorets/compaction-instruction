// Tests for the v0.10 analysis (EXPERIMENT-V10.md): mode V and the comparisons V-R, V-Q, R-Q; the V rows of the
// decision helper; host summaries with a history line; the pooled comparison with --pool or batch.json poolBatches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { analyze, parseArgs, poolNamesOf } from "../../analysis/analyze.mjs";
import { HISTORY_LINE } from "../../analysis/facts.mjs";
import { comparisonsOf, MODE_NAMES } from "../../analysis/metrics.mjs";
import { BATCH, HOST_VERSION, PLUGIN_BUILD, POOL, runId, writeV10Fixture } from "./fixture-v10.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function analyzed(fn, { fixture = {}, pool = null } = {}) {
  const { root } = writeV10Fixture(fixture);
  try {
    analyze({ root, batch: BATCH, pool });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")), md: readFileSync(join(dir, "report.md"), "utf8") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("mode V: label and the v10 comparisons, V-R primary", () => {
  assert.equal(MODE_NAMES.V, "general summarizer instruction with line format");
  const ids = (batch, modes) => comparisonsOf(batch, null, modes).map((c) => c.id);
  assert.deepEqual(ids({ suite: "v10-full" }, ["Q", "R", "V"]), ["V-R", "V-Q", "R-Q"]);
  assert.deepEqual(ids({}, ["Q", "R", "V"]), ["V-R", "V-Q", "R-Q"], "mode V without a suite");
  assert.deepEqual(ids({ suite: "v10-smoke" }, ["V"]), []);
  assert.deepEqual(ids({ suite: "v09-full" }, ["B", "N", "Q", "R"]), ["N-B", "Q-B", "R-B", "R-N", "R-Q"], "v0.9 unchanged");
  assert.match(comparisonsOf({ suite: "v10-full" }, null, ["Q", "R", "V"])[0].label, /^V minus R \(line format against the general summarizer instruction, primary\)$/);
});

test("HISTORY_LINE: a line with 'history: ' and a value", () => {
  assert.equal(HISTORY_LINE.test("intro\nAPI gateway history: kong-gw, then envoy-gw\nend"), true);
  assert.equal(HISTORY_LINE.test("- geo-index: team-pricing; history: team-safety (e001)"), true);
  assert.equal(HISTORY_LINE.test("history:\nno value on the line"), false);
  assert.equal(HISTORY_LINE.test("the history of the gateway"), false);
});

test("v10 summary: paired and per-shape tables, summary length, decision rows V-R and V-Q, history lines", () => analyzed(({ summary, md }) => {
  assert.deepEqual(summary.comparisons.map((c) => c.id), ["V-R", "V-Q", "R-Q"]);
  assert.deepEqual([summary.paired["V-R"].pairs, summary.paired["V-R"].meanDiff], [2, 0.125]);
  assert.deepEqual(summary.v09.byShape.old.paired["V-R"].meanDiff, 0.25);
  assert.deepEqual(summary.v09.byShape.worklog.paired["V-Q"].meanDiff, 0);
  assert.ok(summary.v09.summaryBytes.V.meanBytes > summary.v09.summaryBytes.R.meanBytes, "V summaries hold the history line");
  const d = summary.v08.decision;
  assert.deepEqual(Object.keys(d).sort(), ["R-Q", "V-Q", "V-R"]);
  assert.ok(!("summaryHistoryCoverage" in d["R-Q"]), "only the V rows get the added fields");
  for (const id of ["V-R", "V-Q"]) {
    for (const k of ["summaryHistoryCoverage", "summaryHistoryCoverageDiffPoints", "summaryMeanBytes", "summaryBytesRatio", "byShape"]) assert.ok(k in d[id], id + " " + k);
    assert.deepEqual(Object.keys(d[id].byShape), ["old", "worklog"]);
  }
  assert.ok(d["V-R"].summaryBytesRatio > 1);
  assert.equal(d["V-R"].summaryBytesRatio, Number((summary.v09.summaryBytes.V.meanBytes / summary.v09.summaryBytes.R.meanBytes).toFixed(4)));
  const h = summary.v10.historyLines;
  assert.deepEqual(h.perMode.V, { runs: 2, summaries: 6, withHistoryLine: 4, runsWithHistoryLine: 2 });
  assert.deepEqual(h.perMode.R, { runs: 2, summaries: 6, withHistoryLine: 0, runsWithHistoryLine: 0 });
  assert.deepEqual(h.runs.find((r) => r.runId === runId("R8-alpha", "V")), { runId: runId("R8-alpha", "V"), mode: "V", included: true, summaries: 3, withHistoryLine: 2, unknown: 0 });
  assert.equal(summary.pooled, undefined, "no pool batch");
  for (const s of ["### Line format (arm V)", "## Summaries with a history line"]) assert.ok(md.includes("\n" + s + "\n"), s);
  assert.match(md, /\| V general summarizer instruction with line format \|/);
  assert.match(md, /\| summaries with a history line \| 0 \| 0 \| 4 \|/);
  assert.ok(!md.includes("## Pooled comparison"));
}));

test("pooled comparison: R minus Q over the pairs of both batches, pair key batch, task and rep", () => analyzed(({ summary, md }) => {
  const pl = summary.pooled;
  assert.deepEqual(pl.batches, [
    { batch: BATCH, suite: "v10-full", hostVersion: HOST_VERSION, pluginBuild: PLUGIN_BUILD, runs: 6 },
    { batch: POOL, suite: "v09-full", hostVersion: HOST_VERSION, pluginBuild: PLUGIN_BUILD, runs: 8 },
  ]);
  assert.equal(pl.pointerOnly, false);
  assert.deepEqual(pl.comparisons.map((c) => c.id), ["R-Q"], "V has no run in the pool batch");
  const p = pl.paired["R-Q"];
  assert.equal(p.pairs, 4, "two pairs from each batch");
  assert.deepEqual(p.perPair.map((x) => x.host).sort(), [BATCH, BATCH, POOL, POOL]);
  assert.deepEqual(p.perTask.map((t) => [t.taskId, t.pairs]), [["R8-alpha", 2], ["R8-beta", 2]], "the bootstrap unit is the task");
  assert.equal(pl.pairedCheckpoint["R-Q"].pairs, 0, "the Q grades of the fixture have no probe question, so no probe pair");
  assert.ok(md.includes("\n## Pooled comparison\n"));
  assert.match(md, /The batches share the host version and the plugin build\./);
  assert.match(md, new RegExp("\\| " + POOL + " \\| v09-full \\| " + HOST_VERSION.replace(/\./g, "\\.") + " \\| " + PLUGIN_BUILD + " \\| 8 \\|"));
}, { pool: [POOL] }));

test("pooled comparison: pointer only when the host version or the plugin build differs", () => {
  analyzed(({ summary, md }) => {
    assert.deepEqual([summary.pooled.sameHostVersion, summary.pooled.samePluginBuild, summary.pooled.pointerOnly], [false, true, true]);
    assert.match(md, /Pointer only: the host version or the plugin build differs between the batches, or one of them is not known\./);
  }, { fixture: { poolBuild: { hostVersion: "2.1.400" } }, pool: [POOL] });
  analyzed(({ summary }) => assert.deepEqual([summary.pooled.samePluginBuild, summary.pooled.pointerOnly], [false, true]), { fixture: { poolBuild: { pluginBuild: "other" } }, pool: [POOL] });
});

test("pool batches from batch.json poolBatches; the --pool flag takes priority", () => {
  analyzed(({ summary }) => assert.equal(summary.pooled.batches[1].batch, POOL), { fixture: { poolField: [POOL] } });
  assert.deepEqual(poolNamesOf("b", { poolBatches: ["x", "b", "x", "a"] }), ["a", "x"], "unique, sorted, without the batch itself");
  assert.deepEqual(poolNamesOf("b", { poolBatches: ["x"] }, ["y"]), ["y"]);
  assert.deepEqual(poolNamesOf("b", null), []);
  assert.deepEqual(parseArgs(["--batch", "v10-full-01", "--pool", "v09-full-01,v09-x", "--pool", "v09-y"]).pool, ["v09-full-01", "v09-x", "v09-y"]);
  assert.throws(() => parseArgs(["--batch", "b", "--pool"]), /--pool needs a value/);
});

test("an older suite has no v10 block", () => analyzed(({ summary, md }) => {
  assert.equal(summary.v10, undefined);
  assert.ok(!md.includes("## Summaries with a history line"));
}, { fixture: { suite: "v09-full" } }));
