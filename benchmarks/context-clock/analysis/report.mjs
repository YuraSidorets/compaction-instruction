// report.md from a summary. Pure and deterministic: no clock time, sorted lists, fixed number formats.
import { FACT_STATUSES_V06, NOT_ASSIGNED } from "./facts.mjs";
import { CATEGORIES, COST_FIELDS, COVERAGE_CELLS, FACT_RECORDS, REMINDER_BUCKETS, SINCE_WRITE_BUCKETS, TOKEN_KINDS, ERROR_CLASSES, MODE_NAMES, OVERHEAD_FIELDS, SHIM_CHANNELS, SHIM_KINDS, SIZE_GROUPS, STATUSES } from "./metrics.mjs";
import { cmp, fmtNum, fmtPct, fmtSigned } from "./util.mjs";

export const CHART_FILES = Object.freeze([
  ["success-rate.svg", "Task success rate by mode"],
  ["score-by-category.svg", "Mean score by mode and task category"],
  ["paired-diff-primary.svg", "Paired score difference per task, primary comparison"],
  ["token-overhead.svg", "Mean total tokens per run by mode"],
]);

/** One table cell: one line, pipes escaped. Values from runs and keys are untrusted text. */
function cell(v) {
  if (v === null || v === undefined) return "n/a";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || c === 0x7f ? " " : ch === "|" ? "\\|" : ch;
  }
  return out;
}

function table(head, rows) {
  return [
    "| " + head.join(" | ") + " |",
    "|" + head.map(() => "---").join("|") + "|",
    ...rows.map((r) => "| " + r.map(cell).join(" | ") + " |"),
  ].join("\n");
}

function modeHead(modes) {
  return modes.map((m) => m + " " + (MODE_NAMES[m] ?? ""));
}

function flatten(obj, prefix, out) {
  for (const k of Object.keys(obj).sort(cmp)) {
    const v = obj[k];
    const name = prefix === "" ? k : prefix + "." + k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, name, out);
    else out.push([name, Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : v]);
  }
  return out;
}

function accCell(a) {
  if (a === undefined || a.runs === 0) return "n/a";
  return fmtNum(a.meanScore, 3) + " (" + fmtPct(a.successRate, 0) + ", n=" + a.runs + ")";
}

function ratioCell(r) {
  return r.questions === 0 ? "n/a" : fmtPct(r.accuracy) + " (" + r.correct + "/" + r.questions + ")";
}

const COST_LABEL = {
  inputTokens: "input tokens", outputTokens: "output tokens", cacheReadTokens: "cache read tokens",
  cacheCreationTokens: "cache creation tokens", totalTokens: "total tokens", toolCalls: "tool calls",
  durationMs: "duration (ms)", compactions: "confirmed compactions", unconfirmedCompactions: "unconfirmed compactions",
  guardDenied: "guard denials", clockFeedbackCount: "clock feedback count",
  clockFeedbackBytes: "clock feedback bytes", commitCalls: "clock commit calls", statusCalls: "clock status calls",
  searchCalls: "search calls",
  feedbackToolReplyCount: "clock feedback count: tool reply", feedbackToolReplyBytes: "clock feedback bytes: tool reply",
  feedbackHookContextCount: "clock feedback count: hook context", feedbackHookContextBytes: "clock feedback bytes: hook context",
  feedbackSessionStartCount: "clock feedback count: session start", feedbackSessionStartBytes: "clock feedback bytes: session start",
};
for (const ch of SHIM_CHANNELS) for (const k of SHIM_KINDS) COST_LABEL["shim_" + ch + "_" + k] = "shim " + ch + ": " + (k === "bytes" ? "delivered bytes" : k + " deliveries");

function pairedTable(summary, key) {
  return table(["Comparison", "Pairs", "Dropped", "Mean first", "Mean second", "Mean difference", "Relative", "95% interval", "Win / tie / loss"],
    summary.comparisons.map((c) => {
      const r = summary[key][c.id];
      return [
        r.label, r.pairs, r.droppedPairs, fmtNum(r.meanX, 3), fmtNum(r.meanY, 3), fmtSigned(r.meanDiff, 3),
        r.relativeDiff === null ? "n/a" : fmtSigned(r.relativeDiff * 100, 1) + "%",
        r.ci95 === null ? "n/a (fewer than 2 tasks)" : "[" + fmtSigned(r.ci95[0], 3) + ", " + fmtSigned(r.ci95[1], 3) + "]",
        r.wins + " / " + r.ties + " / " + r.losses,
      ];
    }));
}

function regressionsTable(summary, key) {
  const rows = summary.comparisons.flatMap((c) => summary[key][c.id].regressions.map((p) => [c.id, p.taskId, p.rep, fmtNum(p.x, 3), fmtNum(p.y, 3), fmtSigned(p.diff, 3)]));
  return rows.length === 0 ? "No regression." : table(["Comparison", "Task", "Rep", "First", "Second", "Difference"], rows);
}

function retrievalCell(r) {
  if (r === null || r === undefined) return "no retrieval record";
  const list = (xs) => (xs.length === 0 ? "-" : xs.join(" "));
  return [
    "class " + (r.errorClass ?? "n/a"),
    "needed " + list(r.needed),
    "before " + list(r.visibleBefore),
    "after " + list(r.visibleAfter),
    "never " + list(r.neverVisible),
    "cut " + list(r.cutChunks),
    "follow-up " + (r.followUp.length === 0 ? "-" : r.followUp.map((f) => (f ? "yes" : "no")).join(" ")),
    "gap noted " + (r.agentNotedGap ? "yes" : "no"),
  ].join("; ");
}

const CELL_LABEL = Object.freeze({
  summaryAndBlock: "in summary, in block",
  summaryOnly: "in summary, not in block",
  blockOnly: "not in summary, in block",
  neither: "not in summary, not in block",
});

function countCell(v) {
  return v === null || v === undefined ? "n/a" : String(v);
}

/** The v0.4 sections. A batch without the telemetry fields shows n/a. */
function v04Sections(summary, modes, p) {
  p("## Commit compliance per mode");
  p("From `run.json` `telemetry.commits`. Compliance is the stages with a commit divided by all stages. A batch without this field shows n/a.");
  const codes = [...new Set(modes.flatMap((m) => Object.keys(summary.modes[m].commits?.rejected ?? {})))].sort(cmp);
  p(table(["Metric", ...modeHead(modes)], [
    ["runs with commit telemetry", ...modes.map((m) => summary.modes[m].commits?.runs ?? 0)],
    ["commit calls", ...modes.map((m) => countCell(summary.modes[m].commits?.calls))],
    ["accepted commits", ...modes.map((m) => countCell(summary.modes[m].commits?.ok))],
    ["rejected commits", ...modes.map((m) => countCell(summary.modes[m].commits?.rejectedTotal))],
    ...codes.map((code) => ["rejected: " + code, ...modes.map((m) => summary.modes[m].commits?.runs > 0 ? summary.modes[m].commits.rejected[code] ?? 0 : "n/a")]),
    ["stages with a commit / stages", ...modes.map((m) => {
      const c = summary.modes[m].commits;
      return c === undefined || c.stages === null ? "n/a" : c.stagesWithCommit + " / " + c.stages;
    })],
    ["commit compliance", ...modes.map((m) => fmtPct(summary.modes[m].commits?.compliance ?? null))],
    ["status calls in probe turns (from the stream)", ...modes.map((m) => countCell(summary.modes[m].coverage?.statusCalls.checkpoint))],
    ["status calls in final turns (from the stream)", ...modes.map((m) => countCell(summary.modes[m].coverage?.statusCalls.final))],
  ]));

  p("## State saves per mode");
  p("From `run.json` `telemetry.stateFile` (arm H: writes of `clock-state.md`). Compliance is the stages with a write divided by all stages. A batch without this field shows n/a.");
  p(table(["Metric", ...modeHead(modes)], [
    ["runs with state file telemetry", ...modes.map((m) => summary.modes[m].stateFile?.runs ?? 0)],
    ["state file writes", ...modes.map((m) => countCell(summary.modes[m].stateFile?.writes))],
    ["stages with a write / stages", ...modes.map((m) => {
      const c = summary.modes[m].stateFile;
      return c === undefined || c.stages === null ? "n/a" : c.stagesWithWrite + " / " + c.stages;
    })],
    ["state save compliance", ...modes.map((m) => fmtPct(summary.modes[m].stateFile?.compliance ?? null))],
  ]));

  p("## State block facts per mode");
  p("From `run.json` `telemetry.stateBlock` (the shim log). A batch without this field shows n/a.");
  p(table(["Metric", ...modeHead(modes)], [
    ["runs with state block telemetry", ...modes.map((m) => summary.modes[m].stateBlock?.runs ?? 0)],
    ["deliveries", ...modes.map((m) => countCell(summary.modes[m].stateBlock?.deliveries))],
    ["missing (no committed state)", ...modes.map((m) => countCell(summary.modes[m].stateBlock?.missing))],
    ["bytes (total)", ...modes.map((m) => countCell(summary.modes[m].stateBlock?.bytes))],
    ["bytes per delivery", ...modes.map((m) => fmtNum(summary.modes[m].stateBlock?.bytesPerDelivery ?? null, 1))],
    ["findings (total)", ...modes.map((m) => countCell(summary.modes[m].stateBlock?.findings))],
    ["cuts", ...modes.map((m) => countCell(summary.modes[m].stateBlock?.cuts))],
  ]));

  p("## Value coverage: host summary and returned block");
  p("From `coverage.json`, for each final question with a text answer. \"In summary\" means that every expected value is an exact substring of the last host compaction summary. \"In block\" is the same for the last `[committed-state]` block in the `SessionStart` hook output of that compaction turn. Each cell: accuracy (correct / questions). A real effect of the returned state shows in the cell \"not in summary, in block\".");
  p(table(["Cell", ...modeHead(modes)], [
    ["runs with a coverage record", ...modes.map((m) => summary.modes[m].coverage?.runs ?? 0)],
    ["runs with a summary found", ...modes.map((m) => summary.modes[m].coverage?.runsWithSummary ?? 0)],
    ["runs with a block found", ...modes.map((m) => summary.modes[m].coverage?.runsWithBlock ?? 0)],
    ["text questions", ...modes.map((m) => summary.modes[m].coverage?.questions ?? 0)],
    ...COVERAGE_CELLS.map((c) => [CELL_LABEL[c], ...modes.map((m) => {
      const r = summary.modes[m].coverage?.cells[c];
      return r === undefined ? "n/a" : ratioCell(r);
    })]),
  ]));
  if (modes.some((m) => (summary.modes[m].coverage?.inReference ?? 0) > 0)) {
    p("The same table for the questions that a block can answer: every expected value is in the reference state of the last compaction of the task. A value that changes after the last compaction is not in this table.");
    p(table(["Cell", ...modeHead(modes)], [
      ["text questions in the reference state", ...modes.map((m) => summary.modes[m].coverage?.inReference ?? 0)],
      ...COVERAGE_CELLS.map((c) => [CELL_LABEL[c], ...modes.map((m) => {
        const r = summary.modes[m].coverage?.referenceCells?.[c];
        return r === undefined ? "n/a" : ratioCell(r);
      })]),
    ]));
  }

  p("## State correctness at each compaction");
  p("From `coverage.json` `stateCorrectness`. For compaction N, the analysis compares the returned `[committed-state]` block and the host summary of `compact-N` with the reference state after stage N. A line `name: value` counts as found when every value is an exact substring: each comma-separated element of a current value, and each element between \", then \" of a history line. Lines are pooled over the compactions with a reference state. A compaction without a block counts its lines as not found. A batch without this list shows n/a.");
  const sc = (m) => summary.modes[m].stateCorrectness;
  const ofLines = (found, lines, share) => (lines === null || lines === undefined || lines === 0 ? "n/a" : fmtPct(share) + " (" + found + "/" + lines + ")");
  p(table(["Metric", ...modeHead(modes)], [
    ["compactions", ...modes.map((m) => countCell(sc(m)?.compactions))],
    ["compactions with a reference state", ...modes.map((m) => countCell(sc(m)?.compactionsWithReference))],
    ["compactions with a block", ...modes.map((m) => countCell(sc(m)?.compactionsWithBlock))],
    ["compactions with a host summary", ...modes.map((m) => countCell(sc(m)?.compactionsWithSummary))],
    ["block: current-value lines found", ...modes.map((m) => ofLines(sc(m)?.found, sc(m)?.lines, sc(m)?.foundShare))],
    ["block: current-value lines found, compactions with a block only", ...modes.map((m) => fmtPct(sc(m)?.foundShareWithBlock ?? null))],
    ["block: history lines found", ...modes.map((m) => ofLines(sc(m)?.historyFound, sc(m)?.historyLines, sc(m)?.historyFoundShare))],
    ["summary: current-value lines found", ...modes.map((m) => ofLines(sc(m)?.summaryFound, sc(m)?.lines, sc(m)?.summaryFoundShare))],
    ["summary: history lines found", ...modes.map((m) => ofLines(sc(m)?.summaryHistoryFound, sc(m)?.historyLines, sc(m)?.summaryHistoryFoundShare))],
  ]));
}

const RECORD_LABEL = Object.freeze({ stateFile: "state file", summary: "summary", block: "block" });
const KIND_LABEL = Object.freeze({
  inputTokens: "input", cacheReadTokens: "cached input (cache read)", cacheCreationTokens: "cache creation", outputTokens: "output", totalTokens: "total",
});
/** Below this task count the report states that the task bootstrap interval is coarse. */
const COARSE_TASKS = 6;

function shareCell(t, st) {
  if (t === undefined || t === null || t.n === 0) return "n/a";
  return fmtPct(t.shares[st]) + " (" + t.counts[st] + "/" + t.n + ")";
}

/** The fact statuses of the tables: the keys of the counts in the summary, else the v0.6 list. */
function statusesOf(summary, modes) {
  const counts = modes.map((m) => summary.modes[m]?.facts?.current?.summary?.counts).find((c) => c !== undefined && c !== null);
  return counts === undefined ? FACT_STATUSES_V06 : Object.keys(counts);
}

function coverageCell(t, assigned) {
  const c = t?.coverage;
  if (c === undefined || c === null) return "n/a";
  return assigned ? fmtPct(c.shareAssigned) + " (" + c.held + "/" + c.assigned + ")" : fmtPct(c.share) + " (" + c.held + "/" + c.n + ")";
}

/** The fact status rows of one table: each record and status, then the coverage rows when the summary has them. */
function factStatusRows(fxOf, modes, statuses, part, suffix) {
  return FACT_RECORDS.flatMap((rec) => [
    ...statuses.map((st) => [RECORD_LABEL[rec] + suffix + ": " + st, ...modes.map((m) => shareCell(fxOf(m)?.[part]?.[rec], st))]),
    ...(statuses.includes(NOT_ASSIGNED) ? [
      [RECORD_LABEL[rec] + suffix + ": held, over all facts", ...modes.map((m) => coverageCell(fxOf(m)?.[part]?.[rec], false))],
      [RECORD_LABEL[rec] + suffix + ": held, over assigned facts", ...modes.map((m) => coverageCell(fxOf(m)?.[part]?.[rec], true))],
    ] : []),
  ]);
}

/** The v0.6 sections (EXPERIMENT-V06.md "Interfaces"). A batch without facts.json or the new fields shows n/a. */
function v06Sections(summary, modes, p) {
  const fx = (m) => summary.modes[m].facts;
  const statuses = statusesOf(summary, modes);
  p("## Fact status per mode");
  p("From `facts.json`. Each row counts the reference facts of every compaction in one record: the state file copy before `/compact`, the host summary, and the returned block. `absent` means that the record does not exist. Each cell: share (count / facts). A batch without `facts.json` shows n/a.");
  p(table(["Record and status", ...modeHead(modes)], [
    ["runs with facts.json", ...modes.map((m) => fx(m)?.runs ?? 0)],
    ["compactions", ...modes.map((m) => countCell(fx(m)?.compactions))],
    ["facts (compaction x fact)", ...modes.map((m) => countCell(fx(m)?.facts))],
    ["facts with an ambiguous match", ...modes.map((m) => countCell(fx(m)?.ambiguous))],
    ...factStatusRows(fx, modes, statuses, "current", ""),
  ]));
  if (statuses.includes(NOT_ASSIGNED)) p("`not assigned`: the matcher found a line or a phrase for the fact, but its name ties with another fact and nothing else gives a reading. It does not count as missing. Held: correct or formatted. The two held rows give the share over all facts and over the facts that the matcher assigned (all facts minus `not assigned`).");
  p("History status: the same rules against the reference history, for the facts that have earlier values.");
  p(table(["Record and status", ...modeHead(modes)],
    factStatusRows(fx, modes, statuses, "history", " history")));

  p("## Question join");
  p("For each final and probe question whose key names a fact: the status of that fact (current or history part) in the last state file, summary and block before the question. Key: state file status | summary status | block present. Each cell: answer accuracy (correct / questions).");
  const keys = [...new Set(modes.flatMap((m) => Object.keys(fx(m)?.join ?? {})))].sort(cmp);
  if (keys.length === 0) p("No question with a fact.");
  else p(table(["State file | summary | block", ...modeHead(modes)], keys.map((k) => [k, ...modes.map((m) => {
    const r = fx(m)?.join?.[k];
    return r === undefined ? "-" : ratioCell(r);
  })])));

  p("## Anchoring candidates");
  p("A candidate: the answer is wrong, the returned block or the state file is `stale` or `incorrect` for its fact, and the summary is `correct` or `formatted`. The lead reads each candidate in the trace. A trace shows what the agent wrote and did, not the internal reasoning of the model.");
  const anch = summary.anchoringCandidates ?? [];
  if (anch.length === 0) p("No anchoring candidate.");
  else p(table(["Run", "Mode", "Question", "Fact", "Part", "Compaction stage", "State file", "Summary", "Block"],
    anch.map((a) => [a.runId, a.mode, a.question, a.fact, a.part, a.compactionStage, a.stateFile, a.summary, a.block])));

  p("## Ambiguous matches");
  p("Facts whose name matched only by substring, or whose summary unit holds the current value and an earlier value so that the rule cannot order them. The lead reads these cases.");
  const amb = summary.ambiguousFacts ?? [];
  if (amb.length === 0) p("No ambiguous match.");
  else p(table(["Run", "Mode", "Stage", "Fact", "Reason"], amb.map((a) => [a.runId, a.mode, a.afterStage, a.fact, a.reasons.join("; ")])));

  p("## State file writes, reads and size");
  p("Writes and reads from `run.json` `telemetry.stateFile`. Stream reads: each Read, Grep or Bash call that names `clock-state.md`, from the raw streams (`facts.json`). Size: the copies `state-file-<N>.md` before each compaction.");
  const sf = (m) => summary.modes[m].stateFile;
  p(table(["Metric", ...modeHead(modes)], [
    ["writes (telemetry)", ...modes.map((m) => countCell(sf(m)?.writes))],
    ["reads (telemetry)", ...modes.map((m) => countCell(sf(m)?.readsTotal))],
    ["reads after a compaction (telemetry)", ...modes.map((m) => countCell(sf(m)?.readsAfterCompaction))],
    ["reads (stream)", ...modes.map((m) => countCell(fx(m)?.streamReads))],
    ["reads after a compaction (stream)", ...modes.map((m) => countCell(fx(m)?.streamReadsAfterCompaction))],
    ["runs with a read after a compaction (stream)", ...modes.map((m) => fx(m)?.runs > 0 ? fx(m).runsWithReadAfterCompaction.length : "n/a")],
    ["state file copies", ...modes.map((m) => countCell(fx(m)?.stateFileCopies))],
    ["bytes per copy (mean)", ...modes.map((m) => fmtNum(fx(m)?.stateFileBytesPerCopy ?? null, 1))],
    ["bytes of the largest copy", ...modes.map((m) => countCell(fx(m)?.stateFileMaxBytes))],
  ]));
  const readRuns = modes.flatMap((m) => (fx(m)?.runsWithReadAfterCompaction ?? []).map((id) => [id, m]));
  if (readRuns.length > 0) p("Runs with a read of the state file after a compaction (they stay in the primary analysis):", "", table(["Run", "Mode"], readRuns));

  p("## Tokens by kind");
  p("Sums of the usage of each turn in `run.json`, mean per run. `costUsd` is the sum of the turn costs where the stream gives them.");
  const tk = (m) => summary.modes[m].tokensByKind;
  p(table(["Kind", ...modeHead(modes)], [
    ["runs with turn usage", ...modes.map((m) => tk(m)?.runs ?? 0)],
    ...[...TOKEN_KINDS, "totalTokens"].map((k) => [KIND_LABEL[k], ...modes.map((m) => fmtNum(tk(m)?.mean?.[k] ?? null, 0))]),
    ["cost in USD per run", ...modes.map((m) => fmtNum(tk(m)?.meanCostUsd ?? null, 4))],
  ]));
  const ovModes = Object.keys(summary.overhead);
  if (ovModes.length > 0 && ovModes.some((m) => summary.overhead[m].tokensByKind !== undefined)) {
    p("Added tokens against " + summary.baseline + " (mean per run):");
    p(table(["Kind", ...ovModes.map((m) => m + " minus " + summary.baseline), ...ovModes.map((m) => m + " against " + summary.baseline + " (%)")],
      [...TOKEN_KINDS, "totalTokens"].map((k) => [KIND_LABEL[k],
        ...ovModes.map((m) => fmtSigned(summary.overhead[m].tokensByKind?.[k]?.diff ?? null, 0)),
        ...ovModes.map((m) => {
          const v = summary.overhead[m].tokensByKind?.[k]?.percent ?? null;
          return v === null ? "n/a" : fmtSigned(v, 1) + "%";
        })])));
  }

  p("## Compactions: stage and context size");
  p("`preTokens` is the context size before the compaction, from `run.json` or from the `compact_metadata` of the host stream.");
  const stages = [...new Set(modes.flatMap((m) => (summary.modes[m].compactionStages ?? []).map((c) => c.afterStage)))].sort((a, b) => a - b);
  if (stages.length === 0) p("No compaction.");
  else p(table(["After stage", ...modes.map((m) => m + " compactions"), ...modes.map((m) => m + " mean preTokens")], stages.map((st) => {
    const at = (m) => (summary.modes[m].compactionStages ?? []).find((c) => c.afterStage === st);
    return [st, ...modes.map((m) => at(m)?.count ?? 0), ...modes.map((m) => fmtNum(at(m)?.meanPreTokens ?? null, 0))];
  })));
  const mism = summary.compactionStageMismatch ?? [];
  if (mism.length === 0) p("In each task and repetition block, every mode compacted after the same stages.");
  else p("Blocks whose modes compacted after different stages:", "", table(["Task", "Rep", "Stages by mode"], mism.map((e) => [e.taskId, e.rep, Object.keys(e.stages).sort(cmp).map((m) => m + ": " + (e.stages[m].join(", ") || "none")).join("; ")])));
}

const SINCE_LABEL = Object.freeze({ 0: "0 stages since the last write", 1: "1 stage since the last write", "2+": "2 or more stages since the last write", none: "no write before the compaction" });
const REMINDER_LABEL = Object.freeze({ 0: "no reminder", 1: "one reminder", more: "more than one reminder" });

/** The v0.7 sections (EXPERIMENT-V07.md "Measurements"). A batch without the new fields shows n/a. */
function v07Sections(summary, modes, p) {
  const fr = (m) => summary.modes[m].freshness;
  const tg = (m) => summary.modes[m].triggers;
  const fx = (m) => summary.modes[m].facts;

  p("## State file freshness at each compaction");
  p("From `facts.json` and `run.json` `telemetry.stateFile.writeStages`. Stages since the last write: the compaction stage minus the last stage with a write of `clock-state.md` at or before it. A fact is held when its state file status is `correct` or `formatted`. Only runs with `writeStages` count in the split. A batch without the field shows n/a.");
  const dist = (m, b) => {
    const f = fr(m);
    if (f?.stagesSinceWrite === null || f?.stagesSinceWrite === undefined) return "n/a";
    const n = f.compactionsWithWriteStages;
    return n > 0 ? fmtPct(f.stagesSinceWrite[b] / n) + " (" + f.stagesSinceWrite[b] + "/" + n + ")" : "n/a";
  };
  const heldCell = (m, b) => {
    const h = fr(m)?.heldBySinceWrite?.[b];
    return h === undefined || h === null || h.facts === 0 ? "n/a" : fmtPct(h.share) + " (" + h.held + "/" + h.facts + ")";
  };
  p(table(["Metric", ...modeHead(modes)], [
    ["compactions with a state file", ...modes.map((m) => (fr(m)?.compactions ? fmtPct(fr(m).stateFileShare) + " (" + fr(m).compactionsWithStateFile + "/" + fr(m).compactions + ")" : "n/a"))],
    ["runs with writeStages", ...modes.map((m) => fr(m)?.runsWithWriteStages ?? 0)],
    ["writes per stage", ...modes.map((m) => fmtNum(fr(m)?.writesPerStage ?? null, 2))],
    ...SINCE_WRITE_BUCKETS.map((b) => ["compactions: " + SINCE_LABEL[b], ...modes.map((m) => dist(m, b))]),
    ...SINCE_WRITE_BUCKETS.map((b) => ["facts held: " + SINCE_LABEL[b], ...modes.map((m) => heldCell(m, b))]),
  ]));
  const last = modes.flatMap((m) => (fr(m)?.lastWrites ?? []).map((w) => [w.runId, m, w.lastWriteStage, w.writeStages.join(", ") || "none"]));
  if (last.length > 0) p("Write stages of each run:", "", table(["Run", "Mode", "Last write stage", "Write stages"], last));

  p("## Trigger records");
  p("From `run.json` `telemetry.triggers`. Standing: deliveries of the `SessionStart` instruction. Reminder: each `PostToolUse` reminder with its context estimate, and the true `preTokens` of the next compaction. PreCompact: deliveries of the summarizer instruction, and the `hook_response` lines with `hook_event` PreCompact in the raw compact streams. A batch without the field shows n/a.");
  const t = (m, f) => f(tg(m));
  const dash = (o, f) => (o === null || o === undefined ? "n/a" : f(o));
  p(table(["Metric", ...modeHead(modes)], [
    ["standing: runs", ...modes.map((m) => t(m, (x) => dash(x?.standing, (s) => s.runs)))],
    ["standing: deliveries per run (mean)", ...modes.map((m) => t(m, (x) => dash(x?.standing, (s) => fmtNum(s.meanPerRun, 2))))],
    ["reminder: runs", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => s.runs)))],
    ["reminder: fired", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => s.fired)))],
    ...REMINDER_BUCKETS.map((b) => ["reminder: compactions with " + REMINDER_LABEL[b] + " before them", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => s.perCompaction[b])))]),
    ["reminder: fired after the last compaction", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => s.afterLastCompaction)))],
    ["reminder: unreadable transcripts", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => countCell(s.unreadable))))],
    ["reminder: estimate minus preTokens (mean)", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => fmtSigned(s.meanDifference, 0))))],
    ["reminder: absolute difference (mean)", ...modes.map((m) => t(m, (x) => dash(x?.reminder, (s) => fmtNum(s.meanAbsDifference, 0))))],
    ["precompact: deliveries", ...modes.map((m) => t(m, (x) => dash(x?.precompact, (s) => s.deliveries)))],
    ["precompact: deliveries per compaction", ...modes.map((m) => t(m, (x) => dash(x?.precompact, (s) => fmtNum(s.perCompaction, 2))))],
    ["stream: compactions with a PreCompact hook line", ...modes.map((m) => t(m, (x) => dash(x?.precompactStream, (s) => s.compactionsWithHookLine + "/" + s.compactions)))],
    ["stream: PreCompact responses (success)", ...modes.map((m) => t(m, (x) => dash(x?.precompactStream, (s) => s.responses + " (" + s.success + ")")))],
    ["stream: PreCompact output bytes (mean)", ...modes.map((m) => t(m, (x) => dash(x?.precompactStream, (s) => fmtNum(s.meanBytes, 1))))],
  ]));
  const fired = modes.flatMap((m) => (tg(m)?.reminder?.list ?? []).map((f) => [f.runId, m, f.turn, f.stage, f.estimate, f.threshold, f.nextCompactionStage, f.nextPreTokens, f.difference === null ? null : fmtSigned(f.difference, 0)]));
  if (fired.length > 0) p("Each reminder:", "", table(["Run", "Mode", "Turn", "Stage", "Estimate", "Threshold", "Next compaction stage", "Next preTokens", "Difference"], fired));

  p("## Early wrong readings");
  p("A wrong final answer of a completed run whose fact was already `stale` or `incorrect` in the state file or in the host summary at the first compaction, or, for a fact that changed later, at the first compaction at or after the stage that last changed it. Anchoring candidates are listed above. A `facts.json` without the field shows n/a.");
  p(table(["Metric", ...modeHead(modes)], [
    ["wrong final answers (retrieval)", ...modes.map((m) => summary.modes[m].errors.wrongFinal)],
    ["wrong final answers with a fact", ...modes.map((m) => countCell(fx(m)?.wrongFinalWithFact))],
    ["early wrong readings", ...modes.map((m) => countCell(fx(m)?.earlyWrong ?? null))],
    ["wrong answers with a status at that compaction", ...modes.map((m) => countCell(fx(m)?.earlyWrongKnown ?? null))],
    ["anchoring candidates among the wrong final answers", ...modes.map((m) => countCell(fx(m)?.anchoringCandidatesFinal ?? null))],
  ]));

  const cal = summary.calibration;
  if (cal !== null && cal !== undefined) {
    p("## Calibration: B and L per task");
    p("Mean score per task. The lead makes the tasks harder when L is at 1.00 in " + cal.ceilingRule + " or more tasks.");
    p(table(["Task", "B", "L", "L at 1.00"], cal.tasks.map((x) => [x.taskId, fmtNum(x.B, 3), fmtNum(x.L, 3), x.lAtCeiling ? "yes" : "no"])));
    p("Tasks with L at 1.00: " + cal.tasksWithLAtCeiling + " of " + cal.tasks.length + ". Harder tasks needed: " + (cal.harderTasksNeeded ? "yes" : "no") + ".");
  }
}

/** The v0.8 sections (EXPERIMENT-V08.md). Only a batch whose suite starts with "v08" has summary.v08. */
function v08Sections(summary, modes, p) {
  const v = summary.v08;
  p("## Runs with denied attempts");
  p("Validity rule of v0.8: " + v.validityRule + ". A violation counts as denied when the raw stream of its turn holds at least one call of the same tool whose input matches the violation excerpt, and every such call got the guard error result. The guard log must also hold at least as many denials as denied calls. A run with one violation that was not denied is invalid. These runs stay in the primary tables.");
  p("Repair of v0.9: an excerpt that is a part of a regular expression literal (an escape letter with the closing slash and flags, or a counted quantifier) is not a path and needs no denial. A run of slashes in the call input counts as one slash, so that a path in a string literal of code matches its excerpt.");
  p(table(["Metric", ...modeHead(modes)], [["runs valid with denied attempts", ...modes.map((m) => v.deniedRuns.perMode[m] ?? 0)]]));
  if (v.deniedRuns.runs.length > 0) p(table(["Run", "Mode", "Violations", "Denied calls", "Guard denials"], v.deniedRuns.runs.map((r) => [r.runId, r.mode, r.violations, r.deniedCalls, r.guardDenied])));

  p("## Accuracy and paired comparison under the old rule");
  p("The old rule: a run with any integrity violation is invalid and outside the accuracy numbers. This table is for comparison only.");
  const om = (m) => v.oldRule.modes[m];
  p(table(["Metric", ...modeHead(modes)], [
    ["runs in accuracy", ...modes.map((m) => om(m)?.includedRuns ?? "n/a")],
    ["invalid runs", ...modes.map((m) => om(m)?.invalid ?? "n/a")],
    ["final accuracy (mean score)", ...modes.map((m) => fmtNum(om(m)?.meanScore ?? null, 3))],
    ["task success rate", ...modes.map((m) => fmtPct(om(m)?.successRate ?? null))],
  ]));
  if (summary.comparisons.length > 0) p(pairedTable({ comparisons: summary.comparisons, oldPaired: v.oldRule.paired }, "oldPaired"));

  p("## Cost per added call");
  p("Means per run over the runs in the accuracy numbers. Tool calls and tokens come from `run.json` `telemetry`. Added values are against B. Added tokens for each added call: added tokens divided by added tool calls, n/a when the mode adds no call. Saves: `telemetry.stateFile.writeStages` (else `writes`). Cost in dollars: `telemetry.costUsd` as the host reports it, n/a when null.");
  const c = (m) => v.cost[m];
  p(table(["Metric", ...modeHead(modes)], [
    ["tool calls per run", ...modes.map((m) => fmtNum(c(m)?.toolCallsPerRun ?? null, 2))],
    ["added tool calls per run", ...modes.map((m) => fmtSigned(c(m)?.addedToolCallsPerRun ?? null, 2))],
    ["tokens per run", ...modes.map((m) => fmtNum(c(m)?.tokensPerRun ?? null, 0))],
    ["added tokens per run", ...modes.map((m) => fmtSigned(c(m)?.addedTokensPerRun ?? null, 0))],
    ["added tokens per added call", ...modes.map((m) => fmtNum(c(m)?.addedTokensPerAddedCall ?? null, 0))],
    ["saves per run", ...modes.map((m) => fmtNum(c(m)?.savesPerRun ?? null, 2))],
    ["cost in USD per run", ...modes.map((m) => fmtNum(c(m)?.costUsdPerRun ?? null, 4))],
    ["cost in USD, all runs", ...modes.map((m) => fmtNum(c(m)?.costUsdTotal ?? null, 4))],
  ]));

  p("## Periodic reminder");
  p("From `run.json` `telemetry.triggers.periodic`: each user message that held the reminder (its number `n` and its turn, with the stage of that turn), and the stage of each save (`telemetry.stateFile.writeStages`). The freshness rows repeat the section above: the stages between the last save and each compaction.");
  const per = v.periodic.perMode;
  p(table(["Metric", ...modeHead(modes)], [
    ["runs with periodic reminders", ...modes.map((m) => per[m]?.runs ?? "n/a")],
    ["reminders", ...modes.map((m) => per[m]?.fired ?? "n/a")],
    ["reminders per run", ...modes.map((m) => fmtNum(per[m]?.firedPerRun ?? null, 2))],
    ["user messages per run", ...modes.map((m) => fmtNum(per[m]?.promptsPerRun ?? null, 2))],
    ...SINCE_WRITE_BUCKETS.map((b) => {
      const label = "compactions: " + SINCE_LABEL[b];
      return [label, ...modes.map((m) => {
        const f = summary.modes[m].freshness;
        const n = f?.compactionsWithWriteStages;
        return f?.stagesSinceWrite === null || f?.stagesSinceWrite === undefined || !(n > 0) ? "n/a" : fmtPct(f.stagesSinceWrite[b] / n) + " (" + f.stagesSinceWrite[b] + "/" + n + ")";
      })];
    }),
  ]));
  if (v.periodic.runs.length > 0) p(table(["Run", "Mode", "User messages", "Reminders (n, turn, stage)", "Save stages"], v.periodic.runs.map((r) => [
    r.runId, r.mode, r.prompts, r.fired.map((f) => f.n + " " + (f.turn ?? "n/a") + " stage " + (f.stage ?? "n/a")).join("; ") || "none", r.saveStages === null ? "n/a" : r.saveStages.join(", ") || "none",
  ])));

  p("## Decision helper");
  p("EXPERIMENT-V08.md and EXPERIMENT-V09.md \"Decision rules\". Paired mean difference of the final score with its interval over tasks, the summary coverage (share of reference facts with summary status `correct` or `formatted`) and its difference in points, and the added tokens per run against B, with the ratio of the first mode to the second. With the `not assigned` status, the coverage over the assigned facts follows in its own column. The report states the numbers and makes no significance claim.");
  const ids = Object.keys(v.decision).sort(cmp);
  const assigned = ids.some((id) => v.decision[id].summaryCoverageAssigned !== undefined);
  if (ids.length === 0) p("No U-N, Q-N, R-N or R-Q comparison in this batch.");
  else p(table(["Comparison", "Pairs", "Mean difference", "95% interval", "Summary coverage (first, second)", ...(assigned ? ["Coverage over assigned facts (first, second)"] : []), "Coverage difference (points)", "Added tokens per run (first, second)", "Added tokens ratio"], ids.map((id) => {
    const d = v.decision[id];
    const [x, y] = id.split("-");
    return [id, d.pairs, fmtSigned(d.meanDiff, 3), d.ci95 === null ? "n/a" : "[" + fmtSigned(d.ci95[0], 3) + ", " + fmtSigned(d.ci95[1], 3) + "]",
      fmtPct(d.summaryCoverage[x]) + ", " + fmtPct(d.summaryCoverage[y]),
      ...(assigned ? [d.summaryCoverageAssigned === undefined ? "n/a" : fmtPct(d.summaryCoverageAssigned[x]) + ", " + fmtPct(d.summaryCoverageAssigned[y])] : []),
      fmtSigned(d.summaryCoverageDiffPoints, 1),
      fmtSigned(d.addedTokensPerRun[x], 0) + ", " + fmtSigned(d.addedTokensPerRun[y], 0), fmtNum(d.addedTokensRatio, 3)];
  })));
  const vIds = ids.filter((id) => v.decision[id].summaryHistoryCoverage !== undefined);
  if (vIds.length > 0) {
    p("### Line format (arm V)");
    p("EXPERIMENT-V10.md \"Decision rules\". Summary coverage of the current values (summary status `correct` or `formatted`) and of the earlier values (summary history status `correct` or `formatted`, over the facts that have earlier values), and the mean length in bytes of the host summaries with the ratio of the first mode to the second.");
    const pair = (o, x, y, f) => f(o?.[x]) + ", " + f(o?.[y]);
    p(table(["Comparison", "Coverage, current values (first, second)", "Coverage, earlier values (first, second)", "Earlier values difference (points)", "Mean summary bytes (first, second)", "Length ratio"], vIds.map((id) => {
      const d = v.decision[id];
      const [x, y] = id.split("-");
      return [id, pair(d.summaryCoverage, x, y, fmtPct), pair(d.summaryHistoryCoverage, x, y, fmtPct), fmtSigned(d.summaryHistoryCoverageDiffPoints, 1), pair(d.summaryMeanBytes, x, y, (b) => fmtNum(b ?? null, 1)), fmtNum(d.summaryBytesRatio, 3)];
    })));
    p(table(["Comparison", "Shape", "Coverage, current values (first, second)", "Coverage, earlier values (first, second)"], vIds.flatMap((id) => {
      const d = v.decision[id];
      const [x, y] = id.split("-");
      return Object.keys(d.byShape).map((shape) => [id, SHAPE_LABEL[shape] ?? shape, pair(d.byShape[shape].summaryCoverage, x, y, fmtPct), pair(d.byShape[shape].summaryHistoryCoverage, x, y, fmtPct)]);
    })));
  }
}

/** The v0.10 sections (EXPERIMENT-V10.md "Stop rules"): host summaries with a history line. */
function v10Sections(summary, modes, p) {
  const h = summary.v10.historyLines;
  p("## Summaries with a history line");
  p("A host summary counts when it holds a line that matches `" + h.pattern + "`, from `facts.json` `compactions[].summary.historyLine`. The stop rule of the smoke batch needs at least one such summary in the run.");
  p(table(["Metric", ...modeHead(modes)], [
    ["runs", ...modes.map((m) => h.perMode[m]?.runs ?? "n/a")],
    ["host summaries", ...modes.map((m) => h.perMode[m]?.summaries ?? "n/a")],
    ["summaries with a history line", ...modes.map((m) => h.perMode[m]?.withHistoryLine ?? "n/a")],
    ["runs with at least one", ...modes.map((m) => h.perMode[m]?.runsWithHistoryLine ?? "n/a")],
  ]));
  if (h.runs.length > 0) p(table(["Run", "Mode", "Host summaries", "With a history line", "Without the field"], h.runs.map((r) => [r.runId, r.mode, r.summaries, r.withHistoryLine, r.unknown])));
}

/** The pooled comparison (EXPERIMENT-V10.md "Measurements", secondary). */
function pooledSections(summary, p) {
  const pl = summary.pooled;
  p("## Pooled comparison");
  p("Secondary table. The pairs of this batch and of the pool batches, with the pair key batch, task and rep. The bootstrap resamples tasks. Only a comparison whose two modes have runs in every batch is shown.");
  p(pl.pointerOnly
    ? "Pointer only: the host version or the plugin build differs between the batches, or one of them is not known."
    : "The batches share the host version and the plugin build.");
  p(table(["Batch", "Suite", "Host version", "Plugin build", "Runs"], pl.batches.map((b) => [b.batch, b.suite ?? "n/a", b.hostVersion ?? "n/a", b.pluginBuild ?? "n/a", b.runs])));
  if (pl.comparisons.length === 0) p("No comparison has both modes in every batch.");
  else {
    p("Final score:");
    p(pairedTable({ comparisons: pl.comparisons, pp: pl.paired }, "pp"));
    p("Probe accuracy (per run):");
    p(pairedTable({ comparisons: pl.comparisons, pp: pl.pairedCheckpoint }, "pp"));
  }
}

const SHAPE_LABEL = Object.freeze({ old: "old", worklog: "work log", decision: "decision record" });

/** The v0.9 sections (EXPERIMENT-V09.md "Measurements"): tables per task shape, host summary length, marked compactions. */
function v09Sections(summary, modes, p) {
  const v = summary.v09;
  const statuses = statusesOf(summary, modes);
  p("## Tables per task shape");
  p("The shape comes from the task field `shape`. A task without the field has the shape `old`. Each shape repeats the accuracy table, the paired comparisons of the batch and the fact status tables, over the tasks of that shape only. A shape with few tasks gives a pointer, not a measurement.");
  for (const shape of v.shapes) {
    const s = v.byShape[shape];
    const sm = (m) => s.modes[m];
    p("### Shape: " + (SHAPE_LABEL[shape] ?? shape));
    p("Tasks: " + (s.tasks.length === 0 ? "none" : s.tasks.join(", ")) + ".");
    p(table(["Metric", ...modeHead(modes)], [
      ["runs in accuracy", ...modes.map((m) => sm(m)?.includedRuns ?? "n/a")],
      ["invalid runs", ...modes.map((m) => sm(m)?.invalid ?? "n/a")],
      ["final accuracy (mean score)", ...modes.map((m) => fmtNum(sm(m)?.meanScore ?? null, 3))],
      ["task success rate", ...modes.map((m) => fmtPct(sm(m)?.successRate ?? null))],
      ["post-compaction continuity", ...modes.map((m) => (sm(m) === undefined ? "n/a" : ratioCell(sm(m).postCompactionContinuity)))],
      ["probe accuracy", ...modes.map((m) => (sm(m) === undefined ? "n/a" : ratioCell(sm(m).checkpoint)))],
    ]));
    if (summary.comparisons.length > 0) p(pairedTable({ comparisons: summary.comparisons, shapePaired: s.paired }, "shapePaired"));
    p(table(["Record and status", ...modeHead(modes)], [
      ["facts (compaction x fact)", ...modes.map((m) => countCell(sm(m)?.facts?.facts))],
      ...factStatusRows((m) => sm(m)?.facts, modes, statuses, "current", ""),
    ]));
    p(table(["Record and status", ...modeHead(modes)], factStatusRows((m) => sm(m)?.facts, modes, statuses, "history", " history")));
  }

  p("## Host summary length");
  p("Length in bytes of each host summary, from `facts.json` `compactions[].summary.bytes`, over the runs in the accuracy numbers. A compaction with no summary is not counted.");
  const sb = (m) => v.summaryBytes[m];
  p(table(["Metric", ...modeHead(modes)], [
    ["host summaries", ...modes.map((m) => sb(m)?.summaries ?? "n/a")],
    ["mean bytes", ...modes.map((m) => fmtNum(sb(m)?.meanBytes ?? null, 1))],
    ["minimum bytes", ...modes.map((m) => fmtNum(sb(m)?.minBytes ?? null, 0))],
    ["maximum bytes", ...modes.map((m) => fmtNum(sb(m)?.maxBytes ?? null, 0))],
    ...v.shapes.map((shape) => ["mean bytes, shape " + (SHAPE_LABEL[shape] ?? shape), ...modes.map((m) => {
      const x = sb(m)?.byShape?.[shape];
      return x === undefined || x.summaries === 0 ? "n/a" : fmtNum(x.meanBytes, 1) + " (n=" + x.summaries + ")";
    })]),
  ]));

  p("## Compactions marked by the host");
  p("One row for each compaction in `run.json` `compactions[]` with `confirmed` true. Trigger: the runner field `trigger` (manual or auto), n/a when the record has no such field. Context before: `preTokens`. Probe result after: correct / asked, over the probe questions whose stage is at or after the stage of the compaction and before the stage of the next marked compaction. Only the questions that the runner asked count. An asked question with no parsed answer counts as wrong. A run that did not complete counts its probe answers as wrong.");
  const ct = v.compactions;
  p("Marked compactions by trigger: " + (Object.keys(ct.triggers).length === 0 ? "none" : Object.entries(ct.triggers).map(([k, n]) => k + " " + n).join(", ")) + ".");
  if (ct.rows.length === 0) p("No run has a marked compaction.");
  else p(table(["Run", "Mode", "In accuracy", "Compaction", "After stage", "Trigger", "Context before (tokens)", "Probe result after (correct / asked)"], ct.rows.map((r) => [
    r.runId, r.mode, r.included ? "yes" : "no", r.n, r.afterStage ?? "n/a", r.trigger ?? "n/a", r.preTokens ?? "n/a", r.probe === null ? "n/a" : ratioCell(r.probe),
  ])));
  const none = ct.runs.filter((r) => r.compactions === 0);
  p("Runs with no marked compaction: " + (none.length === 0 ? "none" : none.map((r) => r.runId).join(", ")) + ".");
  const pm = (m) => ct.perMode?.[m];
  if (ct.perMode !== undefined) p(table(["Metric", ...modeHead(modes)], [
    ["runs in accuracy", ...modes.map((m) => pm(m)?.runs ?? "n/a")],
    ["marked compactions per run", ...modes.map((m) => fmtNum(pm(m)?.compactionsPerRun ?? null, 2))],
    ["mean context before (tokens)", ...modes.map((m) => fmtNum(pm(m)?.meanPreTokens ?? null, 0))],
    ["probe accuracy over asked questions", ...modes.map((m) => (pm(m) === undefined ? "n/a" : ratioCell(pm(m).probe)))],
  ]));
}

export function renderReport(summary, batch) {
  const modes = summary.modeList ?? Object.keys(summary.modes);
  const base = summary.baseline;
  const out = [];
  const p = (...lines) => out.push(...lines, "");

  p("# Context Clock benchmark: " + cell(summary.batch));
  p("This report is generated by `benchmarks/context-clock/analysis/analyze.mjs`. The same inputs give the same bytes.");

  p("## Batch facts");
  if (batch !== null && typeof batch === "object") p(table(["Field", "Value"], flatten(batch, "", [])));
  else p("No `batch.json` was found for this batch.");
  p(table(["Fact", "Value"], [
    ["hosts", summary.hosts.join(", ")],
    ["modes", modes.join(", ")],
    ["comparisons", summary.comparisons.map((c) => c.id).join(", ")],
    ["overhead baseline", base ?? "n/a"],
    ["runs", summary.runs.total],
    ["runs with a retrieval record", summary.runs.withRetrieval],
    ["runs with a coverage record", summary.runs.withCoverage ?? 0],
    ["tasks", summary.runs.tasks],
    ["bootstrap", "seed " + summary.method.bootstrap.seed + ", " + summary.method.bootstrap.iterations + " iterations, resample unit " + summary.method.bootstrap.resampleUnit],
  ]));

  p("## Runs by status");
  p("`infra_failed`, `invalid` and `ungraded` runs are outside the accuracy numbers. `agent_failed`, `timeout` and `limit_exceeded` runs count as score 0.");
  const statusRows = [...STATUSES, "invalid", "ungraded"].map((s) => [s, ...modes.map((m) => summary.modes[m].statusCounts[s] ?? 0)]);
  statusRows.push(["in accuracy numbers", ...modes.map((m) => summary.modes[m].includedRuns)]);
  p(table(["Status", ...modeHead(modes)], statusRows));

  p("## Accuracy per mode");
  p(table(["Metric", ...modeHead(modes)], [
    ["runs in accuracy", ...modes.map((m) => summary.modes[m].includedRuns)],
    ["final accuracy (mean score)", ...modes.map((m) => fmtNum(summary.modes[m].meanScore, 3))],
    ["task success rate", ...modes.map((m) => fmtPct(summary.modes[m].successRate))],
    ["perfect runs", ...modes.map((m) => summary.modes[m].perfectRuns)],
    ["post-compaction continuity accuracy (final questions with preCompaction true)", ...modes.map((m) => ratioCell(summary.modes[m].postCompactionContinuity))],
    ["probe (checkpoint) accuracy", ...modes.map((m) => ratioCell(summary.modes[m].checkpoint))],
    ["mean continuity errors per run", ...modes.map((m) => fmtNum(summary.modes[m].meanContinuityErrors, 2))],
    ...["agent_failed", "timeout", "limit_exceeded"].map((s) => ["scored 0: " + s, ...modes.map((m) => summary.modes[m].scoredZero[s] ?? 0)]),
  ]));

  p("## Errors per mode");
  p("Error classes come from `retrieval.json` (first match wins: run not completed, a needed event never visible, every needed event visible but one only before the last compaction, a stale value, another wrong value, no parsed answer). `agentNotedGap` is a text heuristic on the assistant messages of the stages that hold a needed event.");
  p(table(["Metric", ...modeHead(modes)], [
    ["runs with a retrieval record", ...modes.map((m) => summary.modes[m].errors.runsWithRetrieval)],
    ["wrong final answers", ...modes.map((m) => summary.modes[m].errors.wrongFinal)],
    ...ERROR_CLASSES.map((c) => ["class " + c, ...modes.map((m) => summary.modes[m].errors.errorClasses[c] ?? 0)]),
    ["retrieval failure rate (retrieval errors / final questions)", ...modes.map((m) => fmtPct(summary.modes[m].errors.retrievalFailureRate))],
    ["retrieval share of wrong answers", ...modes.map((m) => fmtPct(summary.modes[m].errors.retrievalShareOfErrors))],
    ["wrong answers with a gap noted (heuristic)", ...modes.map((m) => summary.modes[m].errors.agentNotedGapOnWrong)],
    ["cut chunks", ...modes.map((m) => summary.modes[m].errors.cutChunks)],
    ["cut chunks with a follow-up", ...modes.map((m) => summary.modes[m].errors.cutChunksWithFollowUp)],
    ...ERROR_CLASSES.map((c) => ["probe class " + c, ...modes.map((m) => summary.modes[m].errors.probeErrorClasses[c] ?? 0)]),
  ]));

  p("## Continuity errors by category");
  const cats = [...new Set(modes.flatMap((m) => Object.keys(summary.modes[m].errorCounts)))].sort(cmp);
  if (cats.length === 0) p("No continuity error was recorded.");
  else p(table(["Error category", ...modeHead(modes)], cats.map((c) => [c, ...modes.map((m) => summary.modes[m].errorCounts[c] ?? 0)])));

  p("## Accuracy by task category");
  p("Each cell: mean score (task success rate, number of runs).");
  const catKeys = [...new Set([...CATEGORIES, ...modes.flatMap((m) => Object.keys(summary.modes[m].byCategory))])].sort(cmp);
  p(table(["Category", ...modeHead(modes)], catKeys.map((c) => [c, ...modes.map((m) => accCell(summary.modes[m].byCategory[c]))])));

  p("## Accuracy per task");
  p("Each cell: mean score (task success rate, number of runs), then the post-compaction continuity accuracy.");
  p(table(["Task", "Category", "Profile", ...modeHead(modes)], summary.perTask.map((t) => [
    t.taskId, t.category, t.profile,
    ...modes.map((m) => accCell(t.modes[m]) + (t.modes[m]?.postCompaction === null || t.modes[m] === undefined ? "" : "; post " + fmtNum(t.modes[m].postCompaction, 2))),
  ])));

  p("## Accuracy by context size");
  p("Three groups of equal task count by `params.approxBytes`.");
  p(table(["Group", "Bytes", "Tasks"], summary.method.sizeGroups.map((g) => [g.group, g.minBytes === null ? "n/a" : g.minBytes + " to " + g.maxBytes, g.tasks.length])));
  const sizeKeys = [...new Set([...SIZE_GROUPS, ...modes.flatMap((m) => Object.keys(summary.modes[m].bySize))])];
  p(table(["Size", ...modeHead(modes)], sizeKeys.map((s) => [s, ...modes.map((m) => accCell(summary.modes[m].bySize[s]))])));

  p("## Accuracy by profile");
  const profKeys = [...new Set(modes.flatMap((m) => Object.keys(summary.modes[m].byProfile)))].sort(cmp);
  p(table(["Profile", ...modeHead(modes)], profKeys.map((k) => [k, ...modes.map((m) => accCell(summary.modes[m].byProfile[k]))])));

  p("## Paired comparison: final score");
  p("Pairs are `(taskId, rep)`. The difference is the score of the first mode minus the score of the second mode. The interval is a percentile bootstrap that resamples tasks, so the repetitions of a task stay together. A pair with a missing or excluded run is dropped and counted.");
  p(pairedTable(summary, "paired"));
  if (summary.runs.tasks < COARSE_TASKS) p("With " + summary.runs.tasks + " tasks the bootstrap interval over tasks is coarse. An interval that includes zero is not evidence that two arms are equal.");
  if (summary.pairedCompleted !== undefined) {
    p("Completed runs only. The primary table above counts a valid run that did not complete (for example at a limit) as score 0. This table drops each pair with such a run.");
    p(pairedTable(summary, "pairedCompleted"));
  }
  const perPairRows = summary.comparisons.flatMap((c) => (summary.paired[c.id].perPair ?? []).map((q) => [c.id, q.taskId, q.rep, fmtNum(q.x, 3), fmtNum(q.y, 3), fmtSigned(q.diff, 3)]));
  if (perPairRows.length > 0) p("Difference for each pair:", "", table(["Comparison", "Task", "Rep", "First", "Second", "Difference"], perPairRows));
  p("Regressions (pairs where the first mode scored lower):", "", regressionsTable(summary, "paired"));
  const droppedRows = summary.comparisons.flatMap((c) => summary.paired[c.id].dropped.map((d) => [c.id, d.taskId, d.rep, d.missingOrExcluded.join(", ")]));
  if (droppedRows.length > 0) p("Dropped pairs:", "", table(["Comparison", "Task", "Rep", "Missing or excluded mode"], droppedRows));

  p("## Paired comparison: post-compaction continuity accuracy");
  p("The per-run value is the share of correct final questions with `preCompaction` true. Pairs whose runs have no such question are left out.");
  p(pairedTable(summary, "pairedPostCompaction"));
  p("Regressions:", "", regressionsTable(summary, "pairedPostCompaction"));

  if (summary.pairedCheckpoint !== undefined) {
    p("## Paired comparison: probe (checkpoint) accuracy");
    p("The per-run value is the share of correct probe questions. A run that did not complete scores 0. Pairs whose runs have no probe question are left out. The interval uses the same task bootstrap as the final score.");
    p(pairedTable(summary, "pairedCheckpoint"));
    p("Regressions:", "", regressionsTable(summary, "pairedCheckpoint"));
  }

  p("## Sensitivity: leave one task out");
  p("For each comparison of the final score, the mean difference with each task left out in turn. The largest change shows how much one task moves the result.");
  p(table(["Comparison", "Mean difference", "Largest change", "Task", "Mean without that task"], summary.comparisons.map((c) => {
    const s = summary.paired[c.id].sensitivity;
    return [c.id, fmtSigned(s.meanDiff, 3), s.largest === null ? "n/a" : fmtSigned(s.largest.change, 3), s.largest?.taskId ?? "n/a", s.largest === null ? "n/a" : fmtSigned(s.largest.meanDiffWithout, 3)];
  })));
  const sensRows = summary.comparisons.flatMap((c) => summary.paired[c.id].sensitivity.rows.map((r) => [c.id, r.taskId, fmtSigned(r.meanDiffWithout, 3), fmtSigned(r.change, 3)]));
  if (sensRows.length > 0) p(table(["Comparison", "Task left out", "Mean difference without it", "Change"], sensRows));

  p("## Cost per mode");
  p("Mean per run over the runs in the accuracy numbers. A missing value in a run record is left out of its mean; a field that no run records shows n/a.");
  p(table(["Metric", ...modeHead(modes)], COST_FIELDS.filter((f) => modes.some((m) => summary.modes[m].cost[f].runs > 0)).map((f) => [COST_LABEL[f] ?? f, ...modes.map((m) => fmtNum(summary.modes[m].cost[f].mean, 1))])));

  p("## Feedback and placebo deliveries by channel");
  const shimRows = [];
  for (const ch of SHIM_CHANNELS) for (const k of SHIM_KINDS) {
    const f = "shim_" + ch + "_" + k;
    if (!modes.some((m) => summary.modes[m].cost[f].runs > 0)) continue;
    shimRows.push([COST_LABEL[f], ...modes.map((m) => fmtNum(summary.modes[m].cost[f].total, 0)), ...modes.map((m) => fmtNum(summary.modes[m].cost[f].mean, 1))]);
  }
  if (shimRows.length === 0) p("No run of this batch has shim telemetry (`telemetry.shim`).");
  else p(table(["Delivery", ...modes.map((m) => m + " total"), ...modes.map((m) => m + " per run")], shimRows));

  p("## Run facts");
  p(table(["Fact", ...modeHead(modes)], [
    ["confirmed compactions (total)", ...modes.map((m) => fmtNum(summary.modes[m].cost.compactions.total, 0))],
    ["unconfirmed compactions (total)", ...modes.map((m) => fmtNum(summary.modes[m].cost.unconfirmedCompactions.total, 0))],
    ["guard denials (total)", ...modes.map((m) => fmtNum(summary.modes[m].cost.guardDenied.total, 0))],
    ["limit hits", ...modes.map((m) => Object.keys(summary.modes[m].limitHits).sort(cmp).map((k) => k + " " + summary.modes[m].limitHits[k]).join(", ") || "0")],
    ["assistant messages that mention the clock (plain text count)", ...modes.map((m) => summary.modes[m].assistantMentions.clock)],
    ["assistant messages that mention the placebo tag (plain text count)", ...modes.map((m) => summary.modes[m].assistantMentions.placebo)],
  ]));
  if (summary.unconfirmedCompactions.length > 0) p("Unconfirmed compactions:", "", table(["Run", "After stage", "Mechanism"], summary.unconfirmedCompactions.map((u) => [u.runId, u.afterStage, u.mechanism])));

  v04Sections(summary, modes, p);
  v06Sections(summary, modes, p);
  v07Sections(summary, modes, p);
  if (summary.v08 !== undefined && summary.v08 !== null) v08Sections(summary, modes, p);
  if (summary.v09 !== undefined && summary.v09 !== null) v09Sections(summary, modes, p);
  if (summary.v10 !== undefined && summary.v10 !== null) v10Sections(summary, modes, p);
  if (summary.pooled !== undefined && summary.pooled !== null) pooledSections(summary, p);

  p("## Overhead against " + (base ?? "the baseline"));
  const ovModes = Object.keys(summary.overhead);
  if (ovModes.length === 0) p("No overhead: the baseline or the compared mode has no run.");
  else {
    p(table(["Metric", ...ovModes.map((m) => m + " minus " + base + " (per run)"), ...ovModes.map((m) => m + " against " + base + " (%)")],
      OVERHEAD_FIELDS.map((f) => [COST_LABEL[f], ...ovModes.map((m) => fmtSigned(summary.overhead[m].fields[f].diff, 1)), ...ovModes.map((m) => summary.overhead[m].fields[f].percent === null ? "n/a" : fmtSigned(summary.overhead[m].fields[f].percent, 1) + "%")])));
    p("Token cost of a stage turn: the four usage fields of each `stage` turn in `run.json`. A run without turn usage shows n/a.");
    p(table(["Token cost", ...modeHead(modes)], [
      ["stage turns with usage", ...modes.map((m) => summary.modes[m].stageCost?.stageTurns ?? 0)],
      ["mean total tokens per stage turn", ...modes.map((m) => fmtNum(summary.modes[m].stageCost?.meanTokensPerStageTurn ?? null, 0))],
      ["mean total tokens per run", ...modes.map((m) => fmtNum(summary.modes[m].stageCost?.meanTokensPerRun ?? null, 0))],
    ]));
    p(table(["Stage turn tokens", ...ovModes.map((m) => m + " minus " + base)], [
      ["mean total tokens per stage turn", ...ovModes.map((m) => fmtSigned(summary.overhead[m].stageTurnTokens?.diff ?? null, 0))],
      ["relative", ...ovModes.map((m) => {
        const v = summary.overhead[m].stageTurnTokens?.percent ?? null;
        return v === null ? "n/a" : fmtSigned(v, 1) + "%";
      })],
    ]));
    p(table(["Clock feedback", ...ovModes], [
      ["feedback bytes per run", ...ovModes.map((m) => fmtNum(summary.overhead[m].feedbackBytesPerRun, 1))],
      ["estimated feedback tokens per run (bytes / 4, an estimate)", ...ovModes.map((m) => fmtNum(summary.overhead[m].estimatedFeedbackTokensPerRun, 1))],
    ]));
  }

  p("## Charts");
  for (const [file, title] of CHART_FILES) p("![" + title + "](charts/" + file + ")");

  p("## Failed, timed out, limited, invalid and excluded runs");
  if (summary.listedRuns.length === 0) p("Every run completed with a valid grade.");
  else p(table(["Run", "Status", "Excluded as", "In accuracy", "Attempts", "Failure", "Limit", "Invalid reason", "Violations"],
    summary.listedRuns.map((r) => [r.runId, r.status, r.excludedAs ?? "-", r.inAccuracy ? "yes, score 0" : "no", r.attempts, r.failure, r.limitHit ?? "-", r.invalidReason, r.violations])));

  p("## Differing cases");
  p("Rule: " + summary.differingCaseRule + " in at least one final question, among runs in the accuracy numbers. The classification comes from `review.json`; `unreviewed` means that the lead did not classify the case yet. Mention counts are plain text counts of assistant messages, not a measure of use.");
  if (summary.differingCases.length === 0) p("No differing case.");
  for (const c of summary.differingCases) {
    p("### " + cell(c.id));
    const scores = Object.keys(c.modes).map((m) => m + " " + fmtNum(c.modes[m].score, 3)).join(", ");
    p(table(["Field", "Value"], [
      ["category", c.category], ["profile", c.profile], ["scores", scores], ["compared modes", c.judgedModes.join(", ")],
      ["classification", c.classification], ["note", c.note ?? "-"],
    ]));
    p(table(["Mode", "Run", "Status", "Feedback count", "Feedback bytes", "Commits", "Status calls", "Compactions", "Unconfirmed", "Guard denials", "Clock mentions", "Placebo mentions"],
      Object.keys(c.modes).map((m) => {
        const x = c.modes[m];
        return [m, x.runId, x.status, x.telemetry.clockFeedbackCount, x.telemetry.clockFeedbackBytes, x.telemetry.commitCalls, x.telemetry.statusCalls,
          x.telemetry.compactions, x.telemetry.unconfirmedCompactions, x.telemetry.guardDenied, x.assistantMentions?.clock ?? null, x.assistantMentions?.placebo ?? null];
      })));
    const wrong = Object.keys(c.modes).flatMap((m) => c.modes[m].wrongQuestions.map((q) => [
      m, q.id, q.given, q.expected, q.aspect, q.errorCategory, q.preCompaction ? "yes" : "no",
      q.establishedBy.map((e) => e.id + " (stage " + (e.stage ?? "?") + ": " + (e.summary ?? "?") + ")").join("; "),
      retrievalCell(q.retrieval),
      q.coverage === null || q.coverage === undefined ? "n/a" : "summary " + (q.coverage.inSummary ? "yes" : "no") + ", block " + (q.coverage.inBlock ? "yes" : "no"),
    ]));
    if (wrong.length === 0) p("No wrong question in any mode.");
    else p(table(["Mode", "Question", "Given", "Expected", "Aspect", "Error category", "Pre-compaction", "Established by", "Retrieval facts", "Coverage"], wrong));
  }
  if (summary.review.unmatchedKeys.length > 0) p("Review keys with no differing case: " + summary.review.unmatchedKeys.map(cell).join(", ") + ".");

  p("## Limits");
  p(
    "- The sample is exploratory: a small task set with few repetitions per task. The report makes no significance claim, and the intervals describe this sample only.",
    "- A task category or size group holds few runs, so the split tables can change with one answer.",
    "- Runs that ended `infra_failed` after all retries, invalid runs and ungraded runs are outside the accuracy numbers. They are listed above.",
    "- Clock telemetry counts `[context-clock]` text that was `returned_to_host`. It is not proof that the text reached the model or that the model used it.",
    "- Event visibility comes from `[eNNN]` tags in tool results, user messages and the task prompts. A paraphrase without its tag, for example in a compaction summary, does not count as visible.",
    "- `agentNotedGap` and the mention counts are text heuristics.",
    "- Value coverage is an exact substring match. A value that the summary or the block paraphrases counts as absent.",
    "- Estimated feedback tokens are bytes divided by 4, not a tokenizer count.",
  );

  p("## Recommendation");
  p(summary.review.recommendation ?? "Lead to complete.");
  return out.join("\n").trimEnd() + "\n";
}
