// Tests for analysis/facts.mjs and the v0.6 analysis paths (modes B, J, H; EXPERIMENT-V06.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assignName, buildFacts, factKey, historyStatus, keysOf, nameTokensOf, norm, parseRecord, rawTokens, recordStatus, setElements, summaryStatus, summaryUnits, valueStatus } from "../../analysis/facts.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { comparisonsOf, computeSummary } from "../../analysis/metrics.mjs";
import { renderReport } from "../../analysis/report.mjs";
import { BATCH, FACTS1, FACTS2, FILE1, runId, TASKS, writeV06Fixture } from "./fixture-v06.mjs";
import { SMOKE_BLOCK_PROSE, SMOKE_FACTS, SMOKE_FILE, SMOKE_NAMES, SMOKE_SUMMARY_COPY } from "./fixture-v06-smoke.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const [T1, T2] = TASKS.map((t) => t[0]);
const [LIMIT1, SHIPPER1, METRICS1] = FACTS1;
const [LIMIT2, SHIPPER2] = FACTS2;

function analyzed(fn) {
  const { root } = writeV06Fixture();
  try {
    analyze({ root, batch: BATCH });
    const dir = join(root, "results", BATCH);
    return fn({ dir, summary: readJson(join(dir, "summary.json")) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- normalization and record lines ----------

test("norm folds case, backticks, quotes, bold and spaces; setElements sorts and drops separators", () => {
  assert.equal(norm(" `Upload  Limit` "), "upload limit");
  assert.equal(norm("\"5 MB\"."), "5 mb");
  assert.deepEqual(setElements("Filebeat; vector-dev"), ["filebeat", "vector-dev"]);
  assert.deepEqual(setElements("vector-dev and filebeat"), ["filebeat", "vector-dev"]);
  assert.deepEqual(setElements("(none)"), []);
});

test("parseRecord reads name: value lines, list and bold marks, and history lines", () => {
  assert.deepEqual(parseRecord("# state\n- **Log Shipper**: filebeat\nupload limit history: 100 MB, then 5 MB\nno colon"), [
    { name: "Log Shipper", history: false, value: "filebeat" },
    { name: "upload limit", history: true, value: "100 MB, then 5 MB" },
  ]);
});

test("valueStatus: correct, formatted, stale, incorrect", () => {
  assert.equal(valueStatus("5 MB", LIMIT1), "correct");
  assert.equal(valueStatus("`5 mb`", LIMIT1), "formatted");
  assert.equal(valueStatus("100 MB", LIMIT1), "stale");
  assert.equal(valueStatus("7 MB", LIMIT1), "incorrect");
  assert.equal(valueStatus("vector-dev, filebeat", SHIPPER1), "correct");
  assert.equal(valueStatus("filebeat, vector-dev", SHIPPER1), "correct", "set order does not matter");
  assert.equal(valueStatus("`Filebeat`, vector-dev", SHIPPER1), "formatted", "case and backticks");
  assert.equal(valueStatus("vector-dev, filebeat", SHIPPER2), "stale", "an earlier set");
});

test("historyStatus compares with the earlier values, with or without the current value", () => {
  assert.equal(historyStatus("100 MB, then 5 MB", LIMIT2), "correct");
  assert.equal(historyStatus("100 MB, then 5 MB, then 10 MB", LIMIT2), "correct");
  assert.equal(historyStatus("100 mb -> 5 mb", LIMIT2), "formatted");
  assert.equal(historyStatus("100 MB", LIMIT2), "stale", "only the first earlier values");
  assert.equal(historyStatus("5 MB, then 100 MB", LIMIT2), "incorrect");
  assert.equal(historyStatus("x", SHIPPER1), null, "no earlier value");
});

test("recordStatus: absent record, missing line, token rule, a tie between two facts is ambiguous", () => {
  assert.deepEqual(recordStatus(null, LIMIT1), { status: "absent", history: "absent", reasons: [] });
  assert.deepEqual(recordStatus(parseRecord("other: 1"), LIMIT1), { status: "missing", history: "missing", reasons: [] });
  assert.deepEqual(recordStatus(parseRecord(FILE1), LIMIT1), { status: "correct", history: "correct", reasons: [] });
  const names = FACTS1.map((f) => f.name);
  assert.deepEqual(recordStatus(parseRecord("store: mimir-store"), METRICS1, names), { status: "correct", history: "missing", reasons: [] }, "all tokens of the shorter side");
  assert.equal(recordStatus(parseRecord("metrics: mimir-store"), METRICS1, names).status, "correct", "metrics is a token of the name");
  const flag = recordStatus(parseRecord("upload limit: 5 MB\nlimit: 100 MB"), LIMIT1, names);
  assert.equal(flag.status, "correct", "the best fit wins");
  const rc = { name: "replica count", kind: "scalar", value: "3", history: null };
  const two = recordStatus(parseRecord("count: 3"), rc, ["replica count", "worker count"]);
  assert.deepEqual([two.status, two.reasons], ["not assigned", ["a line name ties with another fact"]], "count fits both facts: not assigned (v0.9), not missing");
  const both = recordStatus(parseRecord("count worker replica: 3"), rc, ["replica count", "worker count"]);
  assert.deepEqual([both.status, both.reasons], ["not assigned", ["a line name ties with another fact"]]);
});

// ---------- summary ----------

test("summaryUnits splits lines and sentences", () => {
  assert.deepEqual(summaryUnits("A is 1. B is 2.\nC: 3"), ["A is 1.", "B is 2.", "C: 3"]);
});

test("summaryStatus: correct, stale, missing, absent and ambiguous", () => {
  assert.equal(summaryStatus("upload limit: 5 MB.", LIMIT1).status, "correct");
  assert.equal(summaryStatus("Upload limit is 5 MB.", LIMIT1).status, "correct", "case and words between");
  assert.equal(summaryStatus("upload limit: 100 MB. Other: 5 MB.", LIMIT1).status, "stale");
  assert.equal(summaryStatus("Nothing about it.", LIMIT1).status, "missing");
  assert.equal(summaryStatus("upload limit is under review.", LIMIT1).status, "missing", "name with no known value");
  assert.deepEqual(summaryStatus(null, LIMIT1), { status: "absent", history: "absent", reasons: [] });
  const both = summaryStatus("Metrics store moved from thanos to mimir-store.", METRICS1);
  assert.deepEqual([both.status, both.history, both.reasons], ["correct", "correct", ["current and earlier value in the same unit"]]);
  assert.equal(summaryStatus("upload limit: 10 MB, earlier 5 MB.", LIMIT2).history, "incorrect", "a later earlier value without the first one");
});

// ---------- the facts record ----------

test("buildFacts joins questions with the last compaction before them and marks anchoring", () => {
  const run = { runId: "r", status: "completed", compactions: [{ afterStage: 1, preTokens: 7 }] };
  const key = {
    answers: { q1: { lastChangedStage: 2, fact: { name: "upload limit", part: "current" } }, q2: { fact: null } },
    checkpointAnswers: { c1: { lastChangedStage: 1, fact: { name: "upload limit", part: "history" } } },
  };
  const task = { checkpoint: { afterStage: 1, questions: [{ id: "c1" }] } };
  const grade = { questions: [{ id: "q1", correct: false }], checkpointItems: [{ id: "c1", correct: true }] };
  const lines = [{ type: "user", message: { content: "This session is being continued. upload limit: 10 MB." } }];
  const fx = buildFacts({
    run, task, key, grade, reference: { states: [{ afterStage: 1, facts: [LIMIT1] }, { afterStage: 2, facts: [LIMIT2] }] },
    compactions: [{ afterStage: 1, lines, stateFile: "upload limit: 5 MB" }, { afterStage: 2, lines, stateFile: "upload limit: 5 MB" }],
    turns: [{ label: "compact-1", kind: "compact", lines: [] }, { label: "final", kind: "final", lines: [{ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Grep", input: { path: "clock-state.md" } }] } }] }],
  });
  assert.deepEqual(fx.compactions.map((c) => [c.afterStage, c.preTokens, c.stateFile.present, c.block.present]), [[1, 7, true, false], [2, null, true, false]]);
  assert.deepEqual(fx.questions, [
    { id: "q1", scope: "final", fact: "upload limit", part: "current", compactionStage: 2, changedAfterLastCompaction: false,
      stateFile: "stale", summary: "correct", block: "absent", correct: false, anchoringCandidate: true, earlyWrong: true },
    { id: "c1", scope: "probe", fact: "upload limit", part: "history", compactionStage: 1, changedAfterLastCompaction: false,
      stateFile: "missing", summary: "missing", block: "absent", correct: true, anchoringCandidate: false, earlyWrong: null },
  ]);
  assert.deepEqual(fx.stateFileReads, [{ turn: "final", tool: "Grep", afterCompaction: true }]);
  const text = JSON.stringify(fx);
  assert.ok(!text.includes("10 MB") && !text.includes("5 MB"), "no summary or state file text in the record");
});

test("facts.json per run from the raw streams and the state file copies", () => {
  analyzed(({ dir }) => {
    const h = readJson(join(dir, "runs", runId(T1, "H"), "facts.json"));
    assert.deepEqual(h.compactions.map((c) => [c.afterStage, c.preTokens, c.stateFile.present, c.block.present]), [[1, 500, true, true], [2, 1000, true, true]]);
    assert.deepEqual(h.compactions[1].facts.map((f) => [f.name, f.stateFile, f.summary, f.block]),
      [["upload limit", "stale", "correct", "stale"], ["log shipper", "stale", "correct", "stale"], ["metrics store", "stale", "missing", "stale"]]);
    assert.deepEqual(h.questions.filter((q) => q.anchoringCandidate).map((q) => q.id), ["q1"]);
    const j = readJson(join(dir, "runs", runId(T1, "J"), "facts.json"));
    assert.deepEqual(j.compactions.map((c) => c.preTokens), [1000, 2000], "preTokens from the stream");
    assert.deepEqual(j.stateFileReads, [{ afterCompaction: false, tool: "Bash", turn: "stage-1" }, { afterCompaction: true, tool: "Read", turn: "final" }]);
    const q2 = j.questions.find((q) => q.id === "q2");
    assert.equal(q2.changedAfterLastCompaction, true);
    const h2 = readJson(join(dir, "runs", runId(T2, "H"), "facts.json"));
    assert.equal(h2.questions.some((q) => q.anchoringCandidate), false, "a run at a limit has no anchoring candidate");
  });
});

// ---------- summary and report ----------

test("v0.6 modes get labels; comparisons come from the batch or the suite", () => {
  assert.deepEqual(comparisonsOf({}, null, ["B", "J", "H"]).map((c) => c.id), ["J-B", "H-J", "H-B"]);
  assert.deepEqual(comparisonsOf({}, null, ["H", "K"]).map((c) => c.id), ["K-H"]);
  assert.deepEqual(comparisonsOf({}, null, ["J", "L"]).map((c) => c.id), ["L-J"]);
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.comparisons.map((c) => c.id), ["J-B", "H-J", "H-B"]);
    assert.equal(s.comparisons[1].label, "H minus J (restoration)");
    assert.deepEqual([s.modes.J.name, s.modes.H.name], ["state file, no return", "state file"]);
  });
});

test("the summary has fact status shares, the question join and the lists", () => {
  analyzed(({ summary: s }) => {
    const h = s.modes.H.facts;
    assert.deepEqual([h.runs, h.compactions, h.facts, h.ambiguous], [2, 4, 12, 2]);
    assert.deepEqual(h.current.stateFile.counts, { absent: 0, correct: 6, formatted: 0, incorrect: 0, missing: 0, stale: 6 }, "set order gives correct");
    assert.equal(h.current.stateFile.shares.stale, 0.5);
    assert.equal(s.modes.B.facts.current.block.shares.absent, 1);
    assert.deepEqual(h.join["stale | correct | block"], { accuracy: 0.25, correct: 1, questions: 4 });
    assert.deepEqual(s.anchoringCandidates.map((a) => [a.runId, a.question]), [[runId(T1, "H"), "q1"]]);
    assert.equal(s.ambiguousFacts.length, 6, "the compact-1 summary of each run: current and earlier value in one sentence");
    assert.deepEqual([...new Set(s.ambiguousFacts.map((a) => [a.afterStage, a.fact, a.reasons.join()].join(" | ")))], ["1 | metrics store | summary: current and earlier value in the same unit"]);
    assert.deepEqual(s.modes.J.facts.runsWithReadAfterCompaction, [runId(T1, "J"), runId(T2, "J")]);
    assert.deepEqual([s.modes.J.stateFile.readsTotal, s.modes.J.stateFile.readsAfterCompaction], [2, 2]);
    assert.equal(s.modes.H.facts.stateFileBytesPerCopy, 116.5);
  });
});

test("tokens by kind, cost, compaction stages and the completed-only table", () => {
  analyzed(({ summary: s }) => {
    assert.deepEqual(s.modes.J.tokensByKind, { costUsdRuns: 2, mean: { cacheCreationTokens: 42, cacheReadTokens: 294, inputTokens: 42, outputTokens: 42, totalTokens: 420 }, meanCostUsd: 1.5, runs: 2 });
    assert.equal(s.modes.B.tokensByKind.meanCostUsd, null);
    assert.deepEqual(s.overhead.J.tokensByKind.totalTokens, { diff: 200, mean: 420, meanA: 220, percent: 90.91 });
    assert.deepEqual(s.modes.H.compactionStages, [{ afterStage: 1, count: 2, meanPreTokens: 500, preTokensRuns: 2 }, { afterStage: 2, count: 2, meanPreTokens: 1000, preTokensRuns: 2 }]);
    assert.equal(s.modes.B.compactionStages[0].meanPreTokens, null);
    assert.deepEqual(s.compactionStageMismatch, []);
    assert.deepEqual([s.paired["H-J"].pairs, s.paired["H-J"].meanDiff], [2, -0.625]);
    assert.deepEqual([s.pairedCompleted["H-J"].pairs, s.pairedCompleted["H-J"].meanDiff], [1, -0.25]);
  });
});

test("the report has the v0.6 sections", () => {
  analyzed(({ dir }) => {
    const md = readFileSync(join(dir, "report.md"), "utf8");
    for (const h of ["## Fact status per mode", "## Question join", "## Anchoring candidates", "## Ambiguous matches",
      "## State file writes, reads and size", "## Tokens by kind", "## Compactions: stage and context size"]) assert.ok(md.includes(h), h);
    assert.ok(md.includes("With 2 tasks the bootstrap interval over tasks is coarse."));
    assert.ok(md.includes("Completed runs only."));
    assert.ok(md.includes("Difference for each pair:"));
    assert.ok(md.includes("| state file: stale | 0.0% (0/12) | 50.0% (6/12) | 0.0% (0/12) |"));
    assert.ok(md.includes("| " + runId(T1, "H") + " | H | q1 | upload limit | current | 2 | stale | correct | stale |"));
    assert.ok(md.includes("| total | 220 | 620 | 420 |"));
  });
});

test("v0.6 output is byte-equal across two runs", () => {
  const { root } = writeV06Fixture();
  try {
    const dir = join(root, "results", BATCH);
    const files = ["summary.json", "report.md", join("runs", runId(T1, "H"), "facts.json")];
    analyze({ root, batch: BATCH });
    const first = files.map((f) => readFileSync(join(dir, f), "utf8"));
    analyze({ root, batch: BATCH });
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf8")), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old batch without facts.json or the v0.6 fields shows n/a", () => {
  const s = computeSummary({ batchName: "old", batch: null, tasks: new Map(), keys: new Map(), review: null, records: [
    { run: { runId: "a", taskId: "t", mode: "B", rep: 1, status: "completed", telemetry: {} }, grade: { valid: true, score: 1, success: true, questions: [] } },
  ] });
  assert.deepEqual([s.modes.B.facts.runs, s.modes.B.facts.compactions, s.modes.B.tokensByKind.runs], [0, null, 0]);
  assert.deepEqual([s.anchoringCandidates, s.ambiguousFacts, s.compactionStageMismatch], [[], [], []]);
  const md = renderReport(s, null);
  assert.ok(md.includes("| compactions | n/a |"));
  assert.ok(md.includes("| state file: correct | n/a |"));
  assert.ok(md.includes("No anchoring candidate."));
});

test("no facts.json without a schema 2 reference", () => {
  const { root } = writeV06Fixture();
  try {
    for (const [id] of TASKS) rmSync(join(root, "tasks", "v06", "reference", id + ".state.json"));
    analyze({ root, batch: BATCH });
    assert.equal(existsSync(join(root, "results", BATCH, "runs", runId(T1, "H"), "facts.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- live smoke shapes (synthetic texts with the shapes of v06-smoke-01, task C9) ----------

const smoke = (name) => SMOKE_FACTS.find((f) => f.name === name);
const fileStatus = (name) => recordStatus(parseRecord(SMOKE_FILE), smoke(name), SMOKE_NAMES);
const sumStatus = (text, name) => summaryStatus(text, smoke(name), SMOKE_NAMES);

test("name tokens: lower case, split, stop words, synonyms, optional flag and migration", () => {
  const t = (s) => nameTokensOf(rawTokens(s)).map((x) => x.t);
  assert.deepEqual(t("Owner of parcel-track"), ["owner", "parcel", "track"]);
  assert.deepEqual(t("owning team"), ["owner"], "team next to owner is dropped");
  assert.deepEqual(t("dependencies of geo-fence"), ["deps", "geo", "fence"]);
  assert.deepEqual(t("on call engineer"), ["oncall"]);
  assert.deepEqual(t("time-series database"), ["time", "series", "db"]);
  assert.deepEqual(t("link lifetime in hrs"), ["link", "lifetime", "hours"]);
  assert.deepEqual(t("supported locales"), ["supported", "locale"], "plural folded");
  assert.deepEqual(factKey("owner of parcel-track").entity, ["parcel", "track"]);
  assert.deepEqual(factKey("migration m1").core, ["m1"], "migration is optional");
  assert.deepEqual(factKey("flag usage-metering").core, ["usage", "metering"], "flag is optional");
});

test("smoke state file: short names give correct, with no ambiguous mark", () => {
  for (const f of SMOKE_FACTS) {
    const r = fileStatus(f.name);
    assert.equal(r.status, "correct", f.name);
    assert.deepEqual(r.reasons, [], f.name);
  }
  assert.equal(fileStatus("migration m1").history, "correct");
  assert.equal(fileStatus("ledger replica count").history, "correct", "a value that comes back: 3, then 5, then 7, then 5");
  assert.equal(fileStatus("flag tax-engine").history, null, "no history in the reference");
});

test("a fact with only a history line takes its last element as the current value", () => {
  const m3 = smoke("migration m3");
  assert.deepEqual(recordStatus(parseRecord("m3 history: pending, then failed, then applied"), m3, SMOKE_NAMES), { status: "correct", history: "correct", reasons: [] });
  assert.equal(recordStatus(parseRecord("m3 history: pending, then failed"), m3, SMOKE_NAMES).status, "stale");
  assert.equal(recordStatus(parseRecord("usage-metering flag: ON"), smoke("flag usage-metering"), SMOKE_NAMES).status, "correct", "first word moved to the end");
});

test("smoke summary that copies the file in a code block gives correct for every fact", () => {
  for (const f of SMOKE_FACTS) {
    const r = sumStatus(SMOKE_SUMMARY_COPY, f.name);
    assert.deepEqual([f.name, r.status, r.reasons], [f.name, "correct", []]);
  }
  assert.equal(sumStatus(SMOKE_SUMMARY_COPY, "migration m1").history, "correct");
});

test("B-arm prose summaries give correct", () => {
  assert.equal(sumStatus("Flag usage-metering is ON (e122).", "flag usage-metering").status, "correct");
  assert.equal(sumStatus("- Migration m1: applied", "migration m1").status, "correct");
  for (const f of SMOKE_FACTS) assert.equal(sumStatus(SMOKE_BLOCK_PROSE, f.name).status, "correct", f.name);
  const r = sumStatus(SMOKE_BLOCK_PROSE, "flag usage-metering");
  assert.deepEqual(r.reasons, [], "a list of facts reads the value after each name");
});

test("summary: whole tokens, numbers as numbers, ordered prose, stale only without the current value", () => {
  assert.equal(sumStatus("m10: applied. team-m1: applied.", "migration m1").status, "missing", "m1 is not m10 or team-m1");
  assert.equal(sumStatus("ledger replica count: 15.", "ledger replica count").status, "missing", "5 is not 15");
  assert.equal(sumStatus("ledger replica count: 7.", "ledger replica count").status, "stale");
  const prose = sumStatus("m1 failed in stage 1 and applied in stage 3.", "migration m1");
  assert.deepEqual([prose.status, prose.reasons], ["correct", ["current and earlier value in the same unit"]]);
  assert.equal(sumStatus("m1 failed in stage 1. m1 applied in stage 3.", "migration m1").reasons.length, 0, "two units can be ordered");
  assert.equal(sumStatus("Checkpoint: usage-metering OFF, tax-engine ON.", "flag usage-metering").status, "stale", "the value after the name, not the value of the next fact");
  assert.equal(sumStatus("m1 history: pending, then failed, then applied", "migration m1").status, "correct", "only a history line: its last element");
  const back = sumStatus("Stage 5: replica count `7` (e194), then e208 restored replica count `5`.", "ledger replica count");
  assert.deepEqual([back.status, back.reasons], ["correct", []], "each occurrence of the name reads up to the next one");
});

test("summary: a set matches across a wrapped list after its name", () => {
  const set = { name: "services of team-a", kind: "set", value: ["api", "billing", "ledger"], history: null };
  const text = "Services of team-a:\n- api\n- billing\n- ledger\n\nOther text.";
  assert.equal(summaryStatus(text, set, [set.name]).status, "correct");
  assert.equal(summaryStatus("Services of team-a: api, billing.", set, [set.name]).status, "missing");
});

// ---------- live shapes of v06-a-01 (synthetic lines of exactly these shapes) ----------

const LIVE_FACTS = [
  { name: "API gateway", kind: "scalar", value: "kong-gw", history: ["envoy-gw"] },
  { name: "time-series database", kind: "scalar", value: "timescaledb", history: null },
  { name: "request body limit in KB", kind: "scalar", value: "512", history: null },
  { name: "supported locales", kind: "set", value: ["fa-IR", "en-IN", "fr-CA"], history: [[], ["fa-IR"], ["fa-IR", "en-IN"]] },
  { name: "owner of parcel-track", kind: "scalar", value: "team-customs", history: null },
  { name: "owner of geo-fence", kind: "scalar", value: "team-routing", history: null },
  { name: "dependencies of geo-fence", kind: "set", value: ["manifest-gen"], history: null },
  { name: "dependencies of carrier-hub", kind: "set", value: ["parcel-track", "depot-svc"], history: [[], ["parcel-track"]] },
  { name: "dependencies of slot-booking", kind: "set", value: [], history: null },
  { name: "on-call engineer of geo-fence", kind: "scalar", value: "rosa", history: null },
  { name: "acceptance criteria", kind: "set", value: ["ac-a", "ac-b"], history: null },
  { name: "link lifetime in hours", kind: "scalar", value: "6", history: ["24"] },
  { name: "migration m1", kind: "scalar", value: "applied", history: null },
  { name: "flag usage-metering", kind: "scalar", value: "ON", history: ["OFF"] },
];
const LIVE_NAMES = LIVE_FACTS.map((f) => f.name);
const live = (name) => LIVE_FACTS.find((f) => f.name === name);
const liveFile = (text, name) => recordStatus(parseRecord(text), live(name), LIVE_NAMES);

test("live state file lines of the lead's shapes give correct", () => {
  const cases = [
    ["api-gateway: kong-gw", "API gateway"],
    ["time-series-db: timescaledb", "time-series database"],
    ["request-body-limit-kb: 512", "request body limit in KB"],
    ["supported-locales: fa-IR, en-IN, fr-CA", "supported locales"],
    ["supported-locales: fr-CA, fa-IR, en-IN", "supported locales"],
    ["owner(parcel-track): team-customs", "owner of parcel-track"],
    ["deps(geo-fence): [manifest-gen]", "dependencies of geo-fence"],
    ["oncall(geo-fence): rosa", "on-call engineer of geo-fence"],
    ["acceptance-criteria: ac-a, ac-b", "acceptance criteria"],
    ["acceptance-criteria: ac-b and ac-a", "acceptance criteria"],
    ["link-lifetime-hours: 6", "link lifetime in hours"],
    ["deps(slot-booking): []", "dependencies of slot-booking"],
    ["deps(slot-booking): none", "dependencies of slot-booking"],
    ["deps(slot-booking): (none)", "dependencies of slot-booking"],
    ["deps(slot-booking): -", "dependencies of slot-booking"],
  ];
  for (const [line, name] of cases) assert.equal(liveFile(line, name).status, "correct", line);
  assert.equal(liveFile("owner(parcel-track): team-customs", "owner of geo-fence").status, "missing", "the entity is required");
  assert.equal(liveFile("deps(geo-fence): []", "dependencies of geo-fence").status, "incorrect", "an empty set is a value");
});

test("live history lines with brackets, none and and", () => {
  const text = "deps(carrier-hub): [parcel-track, depot-svc]\ndeps(carrier-hub) history: none, then [parcel-track], then [parcel-track, depot-svc]";
  assert.deepEqual(liveFile(text, "dependencies of carrier-hub"), { status: "correct", history: "correct", reasons: [] });
  const loc = "supported-locales: fa-IR, en-IN, fr-CA\nsupported-locales history: none, then fa-IR, then fa-IR and en-IN";
  assert.deepEqual(liveFile(loc, "supported locales"), { status: "correct", history: "correct", reasons: [] });
  assert.equal(liveFile("supported-locales history: none, then fa-IR", "supported locales").status, "stale", "only a history line: its last element");
});

test("membership lines state a set fact that has no line of its own", () => {
  const text = "locale fa-IR: supported\nlocale en-IN: supported\nlocale fr-CA: supported\nlocale en-AU: not supported";
  assert.equal(liveFile(text, "supported locales").status, "correct");
  assert.equal(liveFile("locale fa-IR: supported\nlocale en-AU: not supported", "supported locales").status, "stale", "an earlier set");
});

test("the best fit wins: a checkpoint line with an extra token does not hide the current line", () => {
  const f = live("flag usage-metering");
  assert.equal(recordStatus(parseRecord("usage-metering: ON\nsnap-c9 usage-metering: OFF"), f, LIVE_NAMES).status, "correct");
  assert.equal(recordStatus(parseRecord("snap-c9 usage-metering: OFF\nusage-metering: ON"), f, LIVE_NAMES).status, "correct", "order does not matter");
});

test("a tie between two facts is ambiguous; a compound split does not match", () => {
  const keys = keysOf(["owner of geo-fence", "owner of parcel-track"]);
  assert.deepEqual(assignName("owner", keys), { fact: null, ambiguous: [], extra: null }, "no entity: the entity is required, so no fact");
  const k2 = keysOf(["replica count", "worker count"]);
  assert.deepEqual(assignName("count", k2).ambiguous, ["replica count", "worker count"]);
  assert.equal(assignName("team-m1", keysOf(LIVE_NAMES)).fact, null, "m1 inside team-m1 does not match migration m1");
  assert.equal(assignName("m10", keysOf(LIVE_NAMES)).fact, null);
  assert.equal(assignName("m1", keysOf(LIVE_NAMES)).fact, "migration m1");
});

test("live summary lines: the same token rule per line, code-block lines count", () => {
  const sum = (text, name) => summaryStatus(text, live(name), LIVE_NAMES).status;
  assert.equal(sum("```\napi-gateway: kong-gw\noncall(geo-fence): rosa\n```", "API gateway"), "correct");
  assert.equal(sum("```\napi-gateway: kong-gw\noncall(geo-fence): rosa\n```", "on-call engineer of geo-fence"), "correct");
  assert.equal(sum("- deps(geo-fence): [manifest-gen]", "dependencies of geo-fence"), "correct");
  assert.equal(sum("- deps(slot-booking): none", "dependencies of slot-booking"), "correct");
  assert.equal(sum("Owners: parcel-track = team-customs; geo-fence = team-routing", "owner of geo-fence"), "correct", "a grouped line");
  assert.equal(sum("Owners: parcel-track = team-customs; geo-fence = team-routing", "owner of parcel-track"), "correct");
  assert.equal(sum("The link lifetime is 6 hours.", "link lifetime in hours"), "correct");
  assert.equal(sum("supported-locales: en-IN, fr-CA, fa-IR", "supported locales"), "correct", "set order");
});
