// Pure metrics of one benchmark batch (CONTRACT.md "Analysis", EXPERIMENT-V03.md "Instrumentation and analysis",
// EXPERIMENT-V04.md "Measurements"). No file access, no clock time.
// Input: tasks and keys by taskId, and one record { run, grade, retrieval, coverage } per run.
import { FACT_STATUSES, FACT_STATUSES_V06, NOT_ASSIGNED } from "./facts.mjs";
import { taskChunks } from "./retrieval.mjs";
import { cmp, mean, round, seededRandom, sum } from "./util.mjs";

export const MODES = Object.freeze(["A", "B", "C"]);
export const MODE_NAMES = Object.freeze({
  A: "baseline", B: "silent", C: "active", D: "placebo",
  E: "commit prompt", F: "commit and returned state", G: "reference state",
  H: "state file", S: "compaction instruction",
  J: "state file, no return", K: "sparse state file, return", L: "sparse state file, no return",
  N: "standing instruction", T: "threshold reminder", P: "summarizer instruction",
  U: "periodic reminder", Q: "stronger summarizer instruction",
  R: "general summarizer instruction",
  V: "general summarizer instruction with line format",
  M: "product PreCompact instruction",
  O: "plain host", I: "plain host with summarizer instruction",
  Y: "clock on, instruction off",
  Z: "plain host with the standalone plugin",
  W: "plain host with the text in CLAUDE.md",
});
/** Modes that replace the v0.2 A, B, C default when a batch has no mode list. */
const NEWER_MODES = Object.freeze(["D", "E", "F", "G", "H", "S", "J", "K", "L", "N", "T", "P", "U", "Q", "R", "V", "M", "O", "I", "Y", "Z", "W"]);
export const CATEGORIES = Object.freeze(["A", "B", "C", "D", "E", "W", "X", "T", "K", "L"]);
export const SIZE_GROUPS = Object.freeze(["small", "medium", "large"]);
export const STATUSES = Object.freeze(["completed", "agent_failed", "timeout", "limit_exceeded", "infra_failed"]);
/** Statuses that stay in the accuracy numbers with score 0. */
export const ZERO_STATUSES = Object.freeze(["agent_failed", "timeout", "limit_exceeded"]);
export const ERROR_CLASSES = Object.freeze(["tool_or_infrastructure", "retrieval", "compaction_recovery", "state_tracking", "reasoning", "indeterminate"]);
export const SHIM_CHANNELS = Object.freeze(["mcp_reply", "hook_context", "session_start"]);
export const SHIM_KINDS = Object.freeze(["real", "placebo", "none", "bytes"]);
/** Default comparisons. A batch with mode D uses the placebo list; a batch with mode A keeps the v0.2 list. */
export const DEFAULT_COMPARISONS_ABC = Object.freeze(["C-B", "C-A", "B-A"]);
export const DEFAULT_COMPARISONS_BCD = Object.freeze(["C-D", "D-B", "C-B"]);
/** v0.4 (EXPERIMENT-V04.md "Arms"): F minus E is the primary comparison. */
export const DEFAULT_COMPARISONS_BEFG = Object.freeze(["F-E", "G-B", "E-B", "F-B"]);
/** v0.5 (EXPERIMENT-V05.md "Arms"): H minus F is the primary comparison. */
export const DEFAULT_COMPARISONS_BFHS = Object.freeze(["H-F", "H-B", "S-B", "F-B"]);
/** v0.6 (EXPERIMENT-V06.md): Experiment A J-B, H-J, H-B; Experiment B K-H or L-J. Suites normally give the list. */
export const DEFAULT_COMPARISONS_V06 = Object.freeze(["J-B", "H-J", "H-B", "K-H", "L-J"]);
/** v0.7 (EXPERIMENT-V07.md "Arms"): each product trigger against B and against L. Suites normally give the list. */
export const DEFAULT_COMPARISONS_V07 = Object.freeze(["N-B", "T-B", "P-B", "L-B", "N-L", "T-L", "P-L"]);
/** v0.8 (EXPERIMENT-V08.md "Arms"): U and Q against B and against N. Suites normally give the list. */
export const DEFAULT_COMPARISONS_V08 = Object.freeze(["N-B", "U-B", "Q-B", "U-N", "Q-N"]);
/** v0.9 (EXPERIMENT-V09.md "Arms"): R against B, N and Q. A v09 suite or a batch with mode R uses this list only. */
export const DEFAULT_COMPARISONS_V09 = Object.freeze(["N-B", "Q-B", "R-B", "R-N", "R-Q"]);
/** v0.10 (EXPERIMENT-V10.md "Runs and limits"): V-R is primary. A v10 suite or a batch with mode V uses this list only. */
export const DEFAULT_COMPARISONS_V10 = Object.freeze(["V-R", "V-Q", "R-Q"]);
/** Standalone plugin (PLAN-standalone.md): Z-O is primary. A batch with mode Z or W and no list uses this list only. */
export const DEFAULT_COMPARISONS_STANDALONE = Object.freeze(["Z-O", "W-O", "W-Z", "Z-I"]);
const COMPARISON_NOTES = Object.freeze({
  "C-B": "effect of feedback", "C-A": "total effect", "B-A": "effect of silent recording",
  "C-D": "real feedback against placebo", "D-B": "placebo against no feedback",
  "F-E": "effect of the returned state", "G-B": "ceiling of the channel", "E-B": "effect of the commit step",
  "F-B": "total effect of the candidate",
  "H-F": "state file against the commit step", "H-B": "total effect of the state file",
  "S-B": "effect of the compaction instruction",
  "J-B": "preparation", "H-J": "restoration", "K-H": "sparse against frequent save, with return",
  "L-J": "sparse against frequent save, no return",
  "N-B": "standing instruction against baseline", "T-B": "threshold reminder against baseline",
  "P-B": "summarizer instruction against baseline", "L-B": "perfect reminder against baseline",
  "N-L": "standing instruction against the perfect reminder", "T-L": "threshold reminder against the perfect reminder",
  "P-L": "summarizer instruction against the perfect reminder",
  "U-B": "periodic reminder against baseline", "Q-B": "stronger summarizer instruction against baseline",
  "U-N": "periodic reminder against the standing instruction", "Q-N": "stronger summarizer instruction against the standing instruction",
  "R-B": "general summarizer instruction against baseline", "R-N": "general summarizer instruction against the standing instruction",
  "R-Q": "general summarizer instruction against the stronger summarizer instruction",
  "V-R": "line format against the general summarizer instruction",
  "V-Q": "line format against the stronger summarizer instruction",
  "Z-O": "standalone plugin against the plain host",
  "W-O": "text in CLAUDE.md against the plain host",
  "W-Z": "text in CLAUDE.md against the standalone plugin",
  "Z-I": "standalone plugin against the summarizer instruction of the plain host",
});
/** v0.2 comparison list with labels, kept for callers of the earlier API. */
export const COMPARISONS = Object.freeze(DEFAULT_COMPARISONS_ABC.map((id, i) => comparisonDef(id, i)));
export const BOOTSTRAP_SEED = 20261122;
export const BOOTSTRAP_ITERATIONS = 10000;
/** Equal scores within this distance are a tie. */
const TIE_EPS = 1e-9;
/** Characters per estimated token for clock feedback text. An estimate, not a tokenizer count. */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

const shimField = (ch, k) => "shim_" + ch + "_" + k;
export const SHIM_FIELDS = Object.freeze(SHIM_CHANNELS.flatMap((ch) => SHIM_KINDS.map((k) => shimField(ch, k))));
export const COST_FIELDS = Object.freeze([
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens",
  "toolCalls", "durationMs", "compactions", "unconfirmedCompactions", "guardDenied", "clockFeedbackCount", "clockFeedbackBytes",
  "commitCalls", "statusCalls", "searchCalls",
  "feedbackToolReplyCount", "feedbackToolReplyBytes", "feedbackHookContextCount", "feedbackHookContextBytes",
  "feedbackSessionStartCount", "feedbackSessionStartBytes",
  ...SHIM_FIELDS,
]);
export const OVERHEAD_FIELDS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens", "toolCalls", "durationMs"]);

function comparisonDef(id, index) {
  const [x, y] = id.split("-");
  const note = COMPARISON_NOTES[id] ?? (MODE_NAMES[x] ?? x) + " against " + (MODE_NAMES[y] ?? y);
  return Object.freeze({ id, x, y, label: x + " minus " + y + " (" + note + (index === 0 ? ", primary" : "") + ")" });
}

// ---------- record classification ----------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** run.json "attempts" is the list of attempt records (a number in early records). */
function attemptsOf(run) {
  return Array.isArray(run.attempts) ? run.attempts.length : num(run.attempts);
}

/**
 * Why a record is outside the accuracy numbers, or null when it is inside.
 * infra_failed after all retries, an invalid grade and a missing grade are outside. agent_failed, timeout and
 * limit_exceeded are inside with score 0.
 */
export function exclusionOf(rec) {
  if (rec.run.status === "infra_failed") return "infra_failed";
  if (rec.grade === null || rec.grade === undefined) return "ungraded";
  if (rec.grade.valid === false) return "invalid";
  return null;
}

/** Score and success of an included record. A run that did not complete scores 0 (CONTRACT grade rules). */
function scoreOf(rec) {
  if (rec.run.status !== "completed") return 0;
  return num(rec.grade.score) ?? 0;
}

function successOf(rec) {
  return rec.run.status === "completed" && rec.grade.success === true;
}

/**
 * The probe questions of a grade that count: `checkpoint.asked` when the grader wrote it (probes after automatic
 * compactions, EXPERIMENT-V09.md part 2), else `checkpoint.questions`.
 */
export function probeQuestionsOf(grade) {
  return num(grade?.checkpoint?.asked) ?? num(grade?.checkpoint?.questions) ?? 0;
}

/** Probe (checkpoint) accuracy of one run over its asked questions. null with none. A run that did not complete scores 0. */
function checkpointOf(rec) {
  const q = probeQuestionsOf(rec.grade);
  if (q === 0) return null;
  return rec.run.status === "completed" ? (num(rec.grade.checkpoint?.correct) ?? 0) / q : 0;
}

/** Post-compaction continuity accuracy of one run: final questions with preCompaction true. null with none. */
function postCompactionOf(rec) {
  const q = num(rec.grade.preCompaction?.questions) ?? 0;
  if (q === 0) return null;
  return rec.run.status === "completed" ? (num(rec.grade.preCompaction?.correct) ?? 0) / q : 0;
}

function pairKeyOf(run) {
  return [run.host ?? "", run.taskId, String(run.rep)].join("\u0000");
}

/** Review and report id of a (taskId, rep) pair. The host is a prefix only when the batch has more than one host. */
function caseIdOf(run, multiHost) {
  return (multiHost ? run.host + "__" : "") + run.taskId + "__r" + run.rep;
}

// ---------- modes and comparisons ----------

/** The modes of a batch: batch.json modes plus every mode with a run. Without batch.json modes, A, B, C are kept. */
export function modesOf(batch, records) {
  const fromRuns = records.map((r) => r.run.mode).filter((m) => typeof m === "string");
  const declared = Array.isArray(batch?.modes) ? batch.modes.filter((m) => typeof m === "string") : null;
  const base = declared ?? (fromRuns.some((m) => NEWER_MODES.includes(m)) ? [] : [...MODES]);
  return [...new Set([...base, ...fromRuns])].sort(cmp);
}

/** Comparison ids: batch.json comparisons, else the suite's comparisons, else the defaults for the modes. */
export function comparisonsOf(batch, suites, modes) {
  const valid = (list) => list.filter((id) => typeof id === "string" && id.split("-").length === 2 && id.split("-").every((m) => modes.includes(m)));
  const suite = typeof batch?.suite === "string" ? suites?.suites?.[batch.suite] : null;
  const given = Array.isArray(batch?.comparisons) ? batch.comparisons : Array.isArray(suite?.comparisons) ? suite.comparisons : null;
  let ids;
  if (given !== null) ids = valid(given);
  else if (["Z", "W"].some((m) => modes.includes(m))) ids = valid([...DEFAULT_COMPARISONS_STANDALONE]);
  else if (suiteVersionOf(batch) === 10 || modes.includes("V")) ids = valid([...DEFAULT_COMPARISONS_V10]);
  else if (suiteVersionOf(batch) === 9 || modes.includes("R")) ids = valid([...DEFAULT_COMPARISONS_V09]);
  else {
    ids = [];
    if (["U", "Q"].some((m) => modes.includes(m))) ids.push(...valid([...DEFAULT_COMPARISONS_V08]));
    if (["N", "T", "P"].some((m) => modes.includes(m)) || (modes.includes("L") && modes.includes("B"))) ids.push(...valid([...DEFAULT_COMPARISONS_V07]));
    if (["J", "K", "L"].some((m) => modes.includes(m))) ids.push(...valid([...DEFAULT_COMPARISONS_V06]));
    if (["H", "S"].some((m) => modes.includes(m))) ids.push(...valid([...DEFAULT_COMPARISONS_BFHS]));
    if (["E", "F", "G"].some((m) => modes.includes(m))) ids.push(...valid([...DEFAULT_COMPARISONS_BEFG]));
    if (modes.includes("D")) ids.push(...valid([...DEFAULT_COMPARISONS_BCD]));
    if (modes.includes("A")) ids.push(...valid([...DEFAULT_COMPARISONS_ABC]));
    if (ids.length === 0) ids.push(...valid([...DEFAULT_COMPARISONS_ABC]));
  }
  return [...new Set(ids)].map((id, i) => comparisonDef(id, i));
}

/** Overhead baseline: A when the batch has it, else B, else the first mode. */
export function baselineOf(modes) {
  return modes.includes("A") ? "A" : modes.includes("B") ? "B" : modes[0] ?? null;
}

// ---------- per-run telemetry ----------

function costOf(run) {
  const t = run.telemetry ?? {};
  const clock = t.clock ?? {};
  const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"].map((k) => num(t[k]));
  const comps = Array.isArray(run.compactions) ? run.compactions.filter(isObject) : [];
  const out = {
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    cacheReadTokens: tokens[2],
    cacheCreationTokens: tokens[3],
    totalTokens: tokens.every((x) => x === null) ? null : sum(tokens),
    toolCalls: num(t.toolCalls),
    durationMs: num(run.durationMs),
    compactions: comps.filter((c) => c.confirmed === true).length,
    unconfirmedCompactions: comps.filter((c) => c.confirmed === false).length,
    guardDenied: isObject(t.guard) ? num(t.guard.denied) : null,
    clockFeedbackCount: num(t.clockFeedbackCount),
    clockFeedbackBytes: num(t.clockFeedbackBytes),
    commitCalls: num(clock.commitCalls),
    statusCalls: num(clock.statusCalls),
    searchCalls: num(t.searchCalls),
    // telemetry.clockFeedbackByChannel (runner extra field): null for a run record without it.
    feedbackToolReplyCount: channelOf(t, "tool_reply", "count"),
    feedbackToolReplyBytes: channelOf(t, "tool_reply", "bytes"),
    feedbackHookContextCount: channelOf(t, "hook_context", "count"),
    feedbackHookContextBytes: channelOf(t, "hook_context", "bytes"),
    feedbackSessionStartCount: channelOf(t, "session_start", "count"),
    feedbackSessionStartBytes: channelOf(t, "session_start", "bytes"),
  };
  // telemetry.shim.byChannel.<channel>.{real,placebo,none,bytes} (v0.3 runner): null for a run record without it.
  const by = isObject(t.shim) && isObject(t.shim.byChannel) ? t.shim.byChannel : null;
  for (const ch of SHIM_CHANNELS) for (const k of SHIM_KINDS) out[shimField(ch, k)] = by && isObject(by[ch]) ? num(by[ch][k]) : null;
  return out;
}

function channelOf(t, channel, field) {
  const c = t.clockFeedbackByChannel;
  return c && typeof c === "object" && c[channel] ? num(c[channel][field]) : null;
}

// ---------- size groups ----------

/** Three groups of equal task count by params.approxBytes (ties by taskId). Tasks without a size are "unknown". */
export function sizeGroupsOf(taskIds, tasks) {
  const sized = [...taskIds]
    .map((id) => ({ id, bytes: num(tasks.get(id)?.params?.approxBytes) }))
    .filter((x) => x.bytes !== null)
    .sort((a, b) => a.bytes - b.bytes || cmp(a.id, b.id));
  const byTask = new Map();
  const groups = SIZE_GROUPS.map((g) => ({ group: g, minBytes: null, maxBytes: null, tasks: [] }));
  sized.forEach((x, i) => {
    const g = groups[Math.floor((i * SIZE_GROUPS.length) / sized.length)];
    g.tasks.push(x.id);
    g.minBytes = g.minBytes === null ? x.bytes : Math.min(g.minBytes, x.bytes);
    g.maxBytes = g.maxBytes === null ? x.bytes : Math.max(g.maxBytes, x.bytes);
    byTask.set(x.id, g.group);
  });
  for (const id of taskIds) if (!byTask.has(id)) byTask.set(id, "unknown");
  return { groups, byTask };
}

// ---------- accuracy ----------

function accuracyOf(recs) {
  return {
    runs: recs.length,
    successRate: round(mean(recs.map((r) => (successOf(r) ? 1 : 0)))),
    meanScore: round(mean(recs.map(scoreOf))),
  };
}

function ratio(questions, correct) {
  return { questions, correct, accuracy: questions > 0 ? round(correct / questions) : null };
}

function splitBy(recs, keyOf, keys) {
  const out = {};
  const seen = new Set(keys);
  for (const r of recs) seen.add(keyOf(r));
  for (const k of [...seen].sort(cmp)) {
    const sub = recs.filter((r) => keyOf(r) === k);
    if (sub.length > 0 || keys.includes(k)) out[k] = accuracyOf(sub);
  }
  return out;
}

function errorClassesOf(inc) {
  const counts = Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0]));
  const probeCounts = Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0]));
  let runs = 0, finals = 0, wrong = 0, gapOnWrong = 0, chunks = 0, cut = 0, cutFollowUp = 0;
  for (const r of inc) {
    const rt = r.retrieval;
    if (!isObject(rt) || !Array.isArray(rt.questions)) continue;
    runs++;
    for (const q of rt.questions) {
      if (q.scope === "final") finals++;
      if (q.correct === true || typeof q.errorClass !== "string") continue;
      const target = q.scope === "probe" ? probeCounts : counts;
      target[q.errorClass] = (target[q.errorClass] ?? 0) + 1;
      if (q.scope === "final") {
        wrong++;
        if (q.agentNotedGap === true) gapOnWrong++;
      }
    }
    for (const c of rt.chunks ?? []) {
      chunks++;
      if (c.cut === true) { cut++; if (c.followUp === true) cutFollowUp++; }
    }
  }
  return {
    runsWithRetrieval: runs,
    finalQuestions: finals,
    wrongFinal: wrong,
    errorClasses: counts,
    probeErrorClasses: probeCounts,
    retrievalFailureRate: finals > 0 ? round(counts.retrieval / finals) : null,
    retrievalShareOfErrors: wrong > 0 ? round(counts.retrieval / wrong) : null,
    agentNotedGapOnWrong: gapOnWrong,
    chunks,
    cutChunks: cut,
    cutChunksWithFollowUp: cutFollowUp,
  };
}

// ---------- v0.4 facts (EXPERIMENT-V04.md "Measurements") ----------

/** Commit compliance from run.json telemetry.commits. Counts are null when no run has the field (older batches). */
function commitsOf(inc) {
  const rows = inc.map((r) => r.run.telemetry?.commits).filter(isObject);
  const total = (f) => (rows.length === 0 ? null : sum(rows.map((c) => num(c[f]) ?? 0)));
  const rejected = {};
  for (const c of rows) {
    if (!isObject(c.rejected)) continue;
    for (const [code, n] of Object.entries(c.rejected)) if (num(n) !== null) rejected[code] = (rejected[code] ?? 0) + n;
  }
  const stages = total("stages");
  const withCommit = total("stagesWithCommit");
  return {
    runs: rows.length,
    calls: total("calls"),
    ok: total("ok"),
    rejected,
    rejectedTotal: rows.length === 0 ? null : sum(Object.values(rejected)),
    stagesWithCommit: withCommit,
    stages,
    compliance: stages !== null && stages > 0 ? round(withCommit / stages) : null,
  };
}

/** State block facts from run.json telemetry.stateBlock. Counts are null when no run has the field. */
function stateBlockOf(inc) {
  const rows = inc.map((r) => r.run.telemetry?.stateBlock).filter(isObject);
  const total = (f) => (rows.length === 0 ? null : sum(rows.map((c) => num(c[f]) ?? 0)));
  const deliveries = total("deliveries");
  const bytes = total("bytes");
  return {
    runs: rows.length,
    deliveries,
    missing: total("missing"),
    bytes,
    bytesPerDelivery: deliveries !== null && deliveries > 0 ? round(bytes / deliveries, 2) : null,
    findings: total("findings"),
    cuts: total("cuts"),
  };
}

// ---------- v0.5 facts (EXPERIMENT-V05.md "Measurements") ----------

/** State saves from run.json telemetry.stateFile (arm H). Counts are null when no run has the field. */
function stateFileOf(inc) {
  const rows = inc.map((r) => r.run.telemetry?.stateFile).filter(isObject);
  const total = (f) => (rows.length === 0 ? null : sum(rows.map((c) => num(c[f]) ?? 0)));
  const stages = total("stages");
  const withWrite = total("stagesWithWrite");
  const readRows = rows.map((c) => c.reads).filter(isObject);
  const reads = (f) => (readRows.length === 0 ? null : sum(readRows.map((c) => num(c[f]) ?? 0)));
  return {
    runs: rows.length,
    readsTotal: reads("total"),
    readsAfterCompaction: reads("afterCompaction"),
    writes: total("writes"),
    stagesWithWrite: withWrite,
    stages,
    compliance: stages !== null && stages > 0 ? round(withWrite / stages) : null,
  };
}

const shareOf = (found, lines) => (lines > 0 ? round(found / lines) : null);

/**
 * State correctness from coverage.json stateCorrectness. Lines are pooled over the compactions that have a
 * reference state. Counts are null when no run has the list (older batches).
 */
function stateCorrectnessOf(inc) {
  const t = { runs: 0, compactions: 0, withReference: 0, withBlock: 0, withSummary: 0, lines: 0, found: 0, historyLines: 0,
    historyFound: 0, blockLines: 0, blockFound: 0, summaryFound: 0, summaryHistoryFound: 0 };
  for (const r of inc) {
    const list = r.coverage?.stateCorrectness;
    if (!Array.isArray(list)) continue;
    t.runs++;
    for (const e of list) {
      if (!isObject(e)) continue;
      t.compactions++;
      if (e.blockFound === true) t.withBlock++;
      if (e.summaryPresent === true) t.withSummary++;
      if (num(e.lines) === null) continue;
      t.withReference++;
      t.lines += e.lines;
      t.found += num(e.found) ?? 0;
      t.historyLines += num(e.historyLines) ?? 0;
      t.historyFound += num(e.historyFound) ?? 0;
      t.summaryFound += num(e.summaryFound) ?? 0;
      t.summaryHistoryFound += num(e.summaryHistoryFound) ?? 0;
      if (e.blockFound === true) {
        t.blockLines += e.lines;
        t.blockFound += num(e.found) ?? 0;
      }
    }
  }
  const n = (v) => (t.runs === 0 ? null : v);
  return {
    runs: t.runs,
    compactions: n(t.compactions),
    compactionsWithReference: n(t.withReference),
    compactionsWithBlock: n(t.withBlock),
    compactionsWithSummary: n(t.withSummary),
    lines: n(t.lines),
    found: n(t.found),
    historyLines: n(t.historyLines),
    historyFound: n(t.historyFound),
    summaryFound: n(t.summaryFound),
    summaryHistoryFound: n(t.summaryHistoryFound),
    foundShare: shareOf(t.found, t.lines),
    foundShareWithBlock: shareOf(t.blockFound, t.blockLines),
    historyFoundShare: shareOf(t.historyFound, t.historyLines),
    summaryFoundShare: shareOf(t.summaryFound, t.lines),
    summaryHistoryFoundShare: shareOf(t.summaryHistoryFound, t.historyLines),
  };
}

/** Total tokens of one run.json turn (the four usage fields), or null without usage. */
function turnTokensOf(turn) {
  const u = turn?.usage;
  if (!isObject(u)) return null;
  const vals = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"].map((k) => num(u[k]));
  return vals.every((v) => v === null) ? null : sum(vals);
}

/** Token cost of a stage turn and of a run. Means are null without data. */
function stageCostOf(inc) {
  const stage = [];
  for (const r of inc) {
    for (const t of Array.isArray(r.run.turns) ? r.run.turns : []) {
      if (t?.kind !== "stage") continue;
      const v = turnTokensOf(t);
      if (v !== null) stage.push(v);
    }
  }
  const runs = inc.map((r) => costOf(r.run).totalTokens).filter((v) => v !== null);
  return {
    stageTurns: stage.length,
    meanTokensPerStageTurn: round(mean(stage), 2),
    runs: runs.length,
    meanTokensPerRun: round(mean(runs), 2),
  };
}

// ---------- v0.6 facts (EXPERIMENT-V06.md "Fact-level analysis", "Metrics") ----------

export const FACT_RECORDS = Object.freeze(["stateFile", "summary", "block"]);
const HISTORY_FIELD = Object.freeze({ stateFile: "historyStateFile", summary: "historySummary", block: "historyBlock" });

function statusTable(statuses) {
  return Object.fromEntries(statuses.map((st) => [st, 0]));
}

/**
 * Counts and shares of the statuses. With the "not assigned" status (v0.9), also `coverage`: the facts held (correct
 * or formatted) over all facts (`share`) and over the facts that the matcher assigned (`shareAssigned`).
 */
function sharesOf(counts, statuses) {
  const n = sum(Object.values(counts));
  const out = { n, counts, shares: Object.fromEntries(statuses.map((st) => [st, n > 0 ? round(counts[st] / n) : null])) };
  if (statuses.includes(NOT_ASSIGNED)) {
    const held = counts.correct + counts.formatted;
    const assigned = n - counts[NOT_ASSIGNED];
    out.coverage = { held, n, share: n > 0 ? round(held / n) : null, assigned, shareAssigned: assigned > 0 ? round(held / assigned) : null };
  }
  return out;
}

/** Version number of the suite of a batch ("v09-full" is 9), or null. */
export function suiteVersionOf(batch) {
  const m = /^v(\d{2,})/.exec(typeof batch?.suite === "string" ? batch.suite : "");
  return m === null ? null : Number(m[1]);
}

const FACT_FIELDS = Object.freeze(["stateFile", "summary", "block", "historyStateFile", "historySummary", "historyBlock"]);

/**
 * The fact statuses of the tables of a batch: with "not assigned" for a v08 or later suite, or when a facts.json has
 * that status. Else the v0.6 list, so that older summaries keep their bytes.
 */
export function factStatusesOf(batch, records) {
  if ((suiteVersionOf(batch) ?? 0) >= 8) return FACT_STATUSES;
  const used = records.some((r) => (Array.isArray(r.facts?.compactions) ? r.facts.compactions : []).some((c) => (c?.facts ?? []).some((f) => FACT_FIELDS.some((k) => f?.[k] === NOT_ASSIGNED))));
  return used ? FACT_STATUSES : FACT_STATUSES_V06;
}

/** The question join key: state file status, summary status, block present. */
export function joinKeyOf(q) {
  return (q.stateFile ?? "n/a") + " | " + (q.summary ?? "n/a") + " | " + (q.block === null || q.block === undefined ? "n/a" : q.block === "absent" ? "no block" : "block");
}

/** Fact status shares, the question join and the state file facts of the stream, from facts.json. */
function factsOf(inc, statuses = FACT_STATUSES_V06) {
  const current = Object.fromEntries(FACT_RECORDS.map((r) => [r, statusTable(statuses)]));
  const history = Object.fromEntries(FACT_RECORDS.map((r) => [r, statusTable(statuses)]));
  const join = {};
  let runs = 0, compactions = 0, facts = 0, ambiguous = 0, questions = 0, anchoring = 0;
  let finalWrong = 0, earlyWrong = 0, earlyKnown = 0, earlyField = false, anchoringFinal = 0;
  let reads = 0, readsAfter = 0, copies = 0, copyBytes = 0, maxBytes = null;
  const runsWithReadAfter = [];
  for (const r of inc) {
    const fx = r.facts;
    if (!isObject(fx) || !Array.isArray(fx.compactions)) continue;
    runs++;
    for (const c of fx.compactions) {
      compactions++;
      if (c.stateFile?.present === true) {
        copies++;
        copyBytes += num(c.stateFile.bytes) ?? 0;
        maxBytes = Math.max(maxBytes ?? 0, num(c.stateFile.bytes) ?? 0);
      }
      for (const f of c.facts ?? []) {
        facts++;
        if (f.ambiguous === true) ambiguous++;
        for (const rec of FACT_RECORDS) {
          if (statuses.includes(f[rec])) current[rec][f[rec]]++;
          if (statuses.includes(f[HISTORY_FIELD[rec]])) history[rec][f[HISTORY_FIELD[rec]]]++;
        }
      }
    }
    const completed = r.run.status === "completed";
    for (const q of fx.questions ?? []) {
      questions++;
      if (q.anchoringCandidate === true) anchoring++;
      if ("earlyWrong" in q) earlyField = true;
      if (q.scope === "final" && completed && q.correct !== true) {
        finalWrong++;
        if (q.anchoringCandidate === true) anchoringFinal++;
        if (q.earlyWrong === true || q.earlyWrong === false) earlyKnown++;
        if (q.earlyWrong === true) earlyWrong++;
      }
      const k = joinKeyOf(q);
      join[k] = join[k] ?? { q: 0, c: 0 };
      join[k].q++;
      if (q.correct === true) join[k].c++;
    }
    const rd = Array.isArray(fx.stateFileReads) ? fx.stateFileReads : [];
    reads += rd.length;
    const after = rd.filter((x) => x.afterCompaction === true).length;
    readsAfter += after;
    if (after > 0) runsWithReadAfter.push(r.run.runId);
  }
  const n = (v) => (runs === 0 ? null : v);
  return {
    runs,
    compactions: n(compactions),
    facts: n(facts),
    ambiguous: n(ambiguous),
    current: Object.fromEntries(FACT_RECORDS.map((rec) => [rec, sharesOf(current[rec], statuses)])),
    history: Object.fromEntries(FACT_RECORDS.map((rec) => [rec, sharesOf(history[rec], statuses)])),
    questions: n(questions),
    anchoringCandidates: n(anchoring),
    // Wrong final answers of completed runs whose key names a fact; early wrong readings among them (null for a
    // facts.json without the field).
    wrongFinalWithFact: n(finalWrong),
    anchoringCandidatesFinal: n(anchoringFinal),
    earlyWrong: earlyField ? earlyWrong : null,
    earlyWrongKnown: earlyField ? earlyKnown : null,
    join: Object.fromEntries(Object.keys(join).sort(cmp).map((k) => [k, ratio(join[k].q, join[k].c)])),
    stateFileCopies: n(copies),
    stateFileBytesPerCopy: copies > 0 ? round(copyBytes / copies, 2) : null,
    stateFileMaxBytes: maxBytes,
    streamReads: n(reads),
    streamReadsAfterCompaction: n(readsAfter),
    runsWithReadAfterCompaction: runsWithReadAfter.sort(cmp),
  };
}

// ---------- v0.7 freshness and triggers (EXPERIMENT-V07.md "Measurements") ----------

export const SINCE_WRITE_BUCKETS = Object.freeze(["0", "1", "2+", "none"]);
const HELD = Object.freeze(["correct", "formatted"]);
const sinceBucket = (v) => (v === null || v === undefined ? "none" : v === 0 ? "0" : v === 1 ? "1" : "2+");
const writeStagesOfRun = (run) => (Array.isArray(run.telemetry?.stateFile?.writeStages) ? run.telemetry.stateFile.writeStages.filter((x) => Number.isInteger(x)) : null);

/**
 * Freshness of the state file at each compaction, from facts.json and run.json telemetry.stateFile.writeStages.
 * Only runs with writeStages count in the stagesSinceWrite split; the share with a state file counts every run
 * with facts.json. A fact is held when the state file status is correct or formatted.
 */
function freshnessOf(inc) {
  let runs = 0, compactions = 0, withFile = 0, writeRuns = 0, writeCompactions = 0, writes = 0, stages = 0;
  const dist = Object.fromEntries(SINCE_WRITE_BUCKETS.map((b) => [b, 0]));
  const held = Object.fromEntries(SINCE_WRITE_BUCKETS.map((b) => [b, { facts: 0, held: 0 }]));
  const lastWrites = [];
  for (const r of inc) {
    const fx = r.facts;
    if (!isObject(fx) || !Array.isArray(fx.compactions)) continue;
    runs++;
    const ws = writeStagesOfRun(r.run);
    if (ws !== null) {
      writeRuns++;
      writes += ws.length;
      stages += num(r.run.telemetry?.stateFile?.stages) ?? 0;
      lastWrites.push({ runId: r.run.runId, lastWriteStage: ws.length === 0 ? null : Math.max(...ws), writeStages: [...ws].sort((a, b) => a - b) });
    }
    for (const c of fx.compactions) {
      compactions++;
      if (c.stateFile?.present === true) withFile++;
      if (ws === null) continue;
      writeCompactions++;
      const b = sinceBucket(num(c.stagesSinceWrite));
      dist[b]++;
      for (const f of c.facts ?? []) {
        held[b].facts++;
        if (HELD.includes(f.stateFile)) held[b].held++;
      }
    }
  }
  return {
    runs,
    compactions: runs === 0 ? null : compactions,
    compactionsWithStateFile: runs === 0 ? null : withFile,
    stateFileShare: compactions > 0 ? round(withFile / compactions) : null,
    runsWithWriteStages: writeRuns,
    compactionsWithWriteStages: writeRuns === 0 ? null : writeCompactions,
    stagesSinceWrite: writeRuns === 0 ? null : dist,
    heldBySinceWrite: writeRuns === 0 ? null : Object.fromEntries(SINCE_WRITE_BUCKETS.map((b) => [b, { facts: held[b].facts, held: held[b].held, share: held[b].facts > 0 ? round(held[b].held / held[b].facts) : null }])),
    writesPerStage: stages > 0 ? round(writes / stages) : null,
    lastWrites: lastWrites.sort((a, b) => cmp(a.runId ?? "", b.runId ?? "")),
  };
}

/** A count field that is a number or a list of deliveries. */
const countOf = (v) => (Array.isArray(v) ? v.length : num(v));

/** The stage of a run.json turn given by index, by label ("stage-3") or by a turn object with a stage. */
function stageOfTurn(run, turn) {
  const turns = Array.isArray(run.turns) ? run.turns : [];
  if (Number.isInteger(turn)) return num(turns[turn]?.stage);
  if (typeof turn === "string") {
    const m = /(\d+)$/.exec(turn);
    return m === null ? null : Number(m[1]);
  }
  return null;
}

/** Confirmed compactions of a run with stage and preTokens (run.json, else facts.json), sorted by stage. */
function compactionPointsOf(r) {
  const fromFacts = new Map((r.facts?.compactions ?? []).map((c) => [c.afterStage, num(c.preTokens)]));
  const list = (Array.isArray(r.run.compactions) ? r.run.compactions : [])
    .filter((c) => isObject(c) && c.confirmed !== false && Number.isInteger(c.afterStage))
    .map((c) => ({ afterStage: c.afterStage, preTokens: num(c.preTokens) ?? fromFacts.get(c.afterStage) ?? null }));
  if (list.length === 0) for (const [st, pre] of fromFacts) if (Number.isInteger(st)) list.push({ afterStage: st, preTokens: pre });
  return list.sort((a, b) => a.afterStage - b.afterStage);
}

export const REMINDER_BUCKETS = Object.freeze(["0", "1", "more"]);

/**
 * Trigger records from run.json telemetry.triggers: standing deliveries per run; each reminder with its turn,
 * stage, estimate, threshold, the preTokens of the next compaction and the difference (estimate minus preTokens);
 * reminders per compaction; PreCompact deliveries per compaction; and the PreCompact hook lines of the compact
 * streams (facts.json). Every part is null when no run has its field.
 */
function triggersOf(inc) {
  const standing = [];
  const fired = [];
  const perCompaction = Object.fromEntries(REMINDER_BUCKETS.map((b) => [b, 0]));
  let reminderRuns = 0, unreadable = 0, unreadableRuns = 0, afterLast = 0;
  let preRuns = 0, preDeliveries = 0, preCompactions = 0;
  let hookCompactions = 0, hookSeen = 0, hookResponses = 0, hookBytes = 0, hookSuccess = 0, factsRuns = 0;
  for (const r of inc) {
    const tr = r.run.telemetry?.triggers;
    const points = compactionPointsOf(r);
    if (isObject(tr?.standing)) {
      const d = countOf(tr.standing.deliveries);
      if (d !== null) standing.push({ runId: r.run.runId, deliveries: d });
    }
    if (isObject(tr?.reminder)) {
      reminderRuns++;
      const u = countOf(tr.reminder.unreadable);
      if (u !== null) { unreadable += u; unreadableRuns++; }
      const rows = (Array.isArray(tr.reminder.fired) ? tr.reminder.fired : []).filter(isObject).map((f) => {
        const stage = num(f.stage) ?? stageOfTurn(r.run, f.turn);
        const next = stage === null ? null : points.find((c) => c.afterStage >= stage) ?? null;
        const estimate = num(f.estimate);
        const pre = next?.preTokens ?? null;
        return {
          runId: r.run.runId, turn: f.turn ?? null, stage, estimate, threshold: num(f.threshold),
          nextCompactionStage: next?.afterStage ?? null, nextPreTokens: pre,
          difference: estimate !== null && pre !== null ? estimate - pre : null,
        };
      });
      fired.push(...rows);
      let prev = -Infinity;
      for (const c of points) {
        const n = rows.filter((x) => x.stage !== null && x.stage > prev && x.stage <= c.afterStage).length;
        perCompaction[n === 0 ? "0" : n === 1 ? "1" : "more"]++;
        prev = c.afterStage;
      }
      afterLast += rows.filter((x) => x.stage !== null && x.stage > prev).length;
    }
    if (isObject(tr?.precompact)) {
      const d = countOf(tr.precompact.deliveries);
      if (d !== null) { preRuns++; preDeliveries += d; preCompactions += points.length; }
    }
    if (Array.isArray(r.facts?.compactions)) {
      factsRuns++;
      for (const c of r.facts.compactions) {
        hookCompactions++;
        if (!isObject(c.precompactHook)) continue;
        hookSeen++;
        hookResponses += num(c.precompactHook.responses) ?? 0;
        hookBytes += num(c.precompactHook.bytes) ?? 0;
        hookSuccess += num(c.precompactHook.success) ?? 0;
      }
    }
  }
  const diffs = fired.map((f) => f.difference).filter((v) => v !== null);
  return {
    standing: standing.length === 0 ? null : {
      runs: standing.length, deliveries: sum(standing.map((s) => s.deliveries)), meanPerRun: round(mean(standing.map((s) => s.deliveries)), 2),
      perRun: standing.sort((a, b) => cmp(a.runId ?? "", b.runId ?? "")),
    },
    reminder: reminderRuns === 0 ? null : {
      runs: reminderRuns, fired: fired.length, unreadable: unreadableRuns === 0 ? null : unreadable,
      perCompaction, afterLastCompaction: afterLast,
      meanDifference: round(mean(diffs), 2), meanAbsDifference: round(mean(diffs.map(Math.abs)), 2),
      list: fired.sort((a, b) => cmp(a.runId ?? "", b.runId ?? "") || (a.stage ?? 0) - (b.stage ?? 0)),
    },
    precompact: preRuns === 0 ? null : {
      runs: preRuns, deliveries: preDeliveries, compactions: preCompactions, perCompaction: preCompactions > 0 ? round(preDeliveries / preCompactions, 2) : null,
    },
    precompactStream: factsRuns === 0 ? null : {
      compactions: hookCompactions, compactionsWithHookLine: hookSeen, responses: hookResponses, success: hookSuccess,
      meanBytes: hookSeen > 0 ? round(hookBytes / hookSeen, 1) : null,
    },
  };
}

export const TOKEN_KINDS = Object.freeze(["inputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens"]);

/** Tokens by kind from the usage of each turn, summed per run; and costUsd of the turns when the runner gives it. */
function tokensByKindOf(inc) {
  const per = { totalTokens: [] };
  for (const k of TOKEN_KINDS) per[k] = [];
  const costs = [];
  for (const r of inc) {
    const turns = (Array.isArray(r.run.turns) ? r.run.turns : []).filter(isObject);
    const usages = turns.map((t) => t.usage).filter(isObject);
    if (usages.length > 0) {
      let total = 0;
      for (const k of TOKEN_KINDS) {
        const v = sum(usages.map((u) => num(u[k]) ?? 0));
        per[k].push(v);
        total += v;
      }
      per.totalTokens.push(total);
    }
    const c = turns.map((t) => num(t.costUsd)).filter((v) => v !== null);
    if (c.length > 0) costs.push(sum(c));
  }
  return {
    runs: per.totalTokens.length,
    mean: Object.fromEntries([...TOKEN_KINDS, "totalTokens"].map((k) => [k, round(mean(per[k]), 2)])),
    costUsdRuns: costs.length,
    meanCostUsd: round(mean(costs), 6),
  };
}

/** Compactions by stage: count and mean preTokens (run.json compactions, else facts.json). */
function compactionStagesOf(inc) {
  const by = new Map();
  for (const r of inc) {
    const fromFacts = new Map((r.facts?.compactions ?? []).map((c) => [c.afterStage, num(c.preTokens)]));
    for (const c of Array.isArray(r.run.compactions) ? r.run.compactions : []) {
      if (!isObject(c) || !Number.isInteger(c.afterStage)) continue;
      const e = by.get(c.afterStage) ?? { count: 0, pre: [] };
      e.count++;
      const pre = num(c.preTokens) ?? fromFacts.get(c.afterStage) ?? null;
      if (pre !== null) e.pre.push(pre);
      by.set(c.afterStage, e);
    }
  }
  return [...by.keys()].sort((a, b) => a - b).map((st) => ({
    afterStage: st, count: by.get(st).count, preTokensRuns: by.get(st).pre.length, meanPreTokens: round(mean(by.get(st).pre), 2),
  }));
}

export const COVERAGE_CELLS = Object.freeze(["summaryAndBlock", "summaryOnly", "blockOnly", "neither"]);

function cellOf(q) {
  if (q.inSummary === true) return q.inBlock === true ? "summaryAndBlock" : "summaryOnly";
  return q.inBlock === true ? "blockOnly" : "neither";
}

/** The four-cell table (value in the host summary x value in the returned block) from coverage.json. */
function coverageOf(inc) {
  const cells = Object.fromEntries(COVERAGE_CELLS.map((c) => [c, { q: 0, c: 0 }]));
  const refCells = Object.fromEntries(COVERAGE_CELLS.map((c) => [c, { q: 0, c: 0 }]));
  let inReference = 0;
  let runs = 0, questions = 0, inSummary = 0, inBlock = 0, summaryFound = 0, blockFound = 0;
  const statusCalls = { checkpoint: 0, final: 0 };
  for (const r of inc) {
    const cv = r.coverage;
    if (!isObject(cv) || !Array.isArray(cv.questions)) continue;
    runs++;
    if (cv.summaryFound === true) summaryFound++;
    if (cv.blockFound === true) blockFound++;
    statusCalls.checkpoint += num(cv.statusCalls?.checkpoint) ?? 0;
    statusCalls.final += num(cv.statusCalls?.final) ?? 0;
    for (const q of cv.questions) {
      questions++;
      if (q.inSummary === true) inSummary++;
      if (q.inBlock === true) inBlock++;
      const cell = cells[cellOf(q)];
      cell.q++;
      if (q.correct === true) cell.c++;
      if (q.inReference === true) {
        inReference++;
        const rc = refCells[cellOf(q)];
        rc.q++;
        if (q.correct === true) rc.c++;
      }
    }
  }
  return {
    runs,
    runsWithSummary: summaryFound,
    runsWithBlock: blockFound,
    questions,
    inSummary,
    inBlock,
    cells: Object.fromEntries(COVERAGE_CELLS.map((c) => [c, ratio(cells[c].q, cells[c].c)])),
    inReference,
    referenceCells: Object.fromEntries(COVERAGE_CELLS.map((c) => [c, ratio(refCells[c].q, refCells[c].c)])),
    statusCalls: runs === 0 ? { checkpoint: null, final: null } : statusCalls,
  };
}

function modeMetrics(mode, all, tasks, sizeOf, statuses = FACT_STATUSES_V06) {
  const recs = all.filter((r) => r.run.mode === mode);
  const statusCounts = { invalid: 0, ungraded: 0 };
  for (const s of STATUSES) statusCounts[s] = 0;
  for (const r of recs) {
    const s = STATUSES.includes(r.run.status) ? r.run.status : "other";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    const ex = exclusionOf(r);
    if (ex === "invalid" || ex === "ungraded") statusCounts[ex] += 1;
  }
  const inc = recs.filter((r) => exclusionOf(r) === null);
  const errorCounts = {};
  for (const r of inc) {
    for (const [cat, n] of Object.entries(r.grade.continuityErrors ?? {})) {
      if (num(n) !== null) errorCounts[cat] = (errorCounts[cat] ?? 0) + n;
    }
  }
  const pre = { q: 0, c: 0 };
  const chk = { q: 0, c: 0 };
  for (const r of inc) {
    pre.q += num(r.grade.preCompaction?.questions) ?? 0;
    pre.c += r.run.status === "completed" ? num(r.grade.preCompaction?.correct) ?? 0 : 0;
    chk.q += probeQuestionsOf(r.grade);
    chk.c += r.run.status === "completed" ? num(r.grade.checkpoint?.correct) ?? 0 : 0;
  }
  const costs = inc.map((r) => costOf(r.run));
  const cost = {};
  for (const f of COST_FIELDS) {
    const vals = costs.map((c) => c[f]).filter((v) => v !== null);
    cost[f] = { mean: round(mean(vals), 2), total: vals.length === 0 ? null : round(sum(vals), 2), runs: vals.length };
  }
  const limitHits = {};
  for (const r of inc) if (typeof r.run.limitHit === "string") limitHits[r.run.limitHit] = (limitHits[r.run.limitHit] ?? 0) + 1;
  const mentions = { runs: 0, messages: 0, clock: 0, placebo: 0 };
  for (const r of inc) {
    const m = r.retrieval?.assistantMentions;
    if (!isObject(m)) continue;
    mentions.runs++;
    mentions.messages += num(m.messages) ?? 0;
    mentions.clock += num(m.clock) ?? 0;
    mentions.placebo += num(m.placebo) ?? 0;
  }
  return {
    mode,
    name: MODE_NAMES[mode] ?? mode,
    statusCounts,
    includedRuns: inc.length,
    scoredZero: Object.fromEntries(ZERO_STATUSES.map((s) => [s, inc.filter((r) => r.run.status === s).length])),
    perfectRuns: inc.filter(successOf).length,
    successRate: round(mean(inc.map((r) => (successOf(r) ? 1 : 0)))),
    meanScore: round(mean(inc.map(scoreOf))),
    meanContinuityErrors: round(mean(inc.map((r) => sum(Object.values(r.grade.continuityErrors ?? {}))))),
    errorCounts,
    errors: errorClassesOf(inc),
    byCategory: splitBy(inc, (r) => tasks.get(r.run.taskId)?.category ?? "unknown", CATEGORIES),
    bySize: splitBy(inc, (r) => sizeOf.get(r.run.taskId) ?? "unknown", SIZE_GROUPS),
    byProfile: splitBy(inc, (r) => r.run.profile ?? tasks.get(r.run.taskId)?.profile ?? "unknown", ["compaction", "long"]),
    postCompactionContinuity: ratio(pre.q, pre.c),
    checkpoint: ratio(chk.q, chk.c),
    limitHits,
    assistantMentions: mentions,
    commits: commitsOf(inc),
    stateBlock: stateBlockOf(inc),
    coverage: coverageOf(inc),
    stateFile: stateFileOf(inc),
    stateCorrectness: stateCorrectnessOf(inc),
    stageCost: stageCostOf(inc),
    facts: factsOf(inc, statuses),
    freshness: freshnessOf(inc),
    triggers: triggersOf(inc),
    tokensByKind: tokensByKindOf(inc),
    compactionStages: compactionStagesOf(inc),
    cost,
  };
}

// ---------- paired comparison ----------

/**
 * Percentile bootstrap of the mean pair difference. Resamples tasks (clusters), so the repetitions of one task
 * stay together. Same pairs and seed give the same interval.
 */
export function bootstrapCi(pairs, seed = BOOTSTRAP_SEED, iterations = BOOTSTRAP_ITERATIONS) {
  const byTask = new Map();
  for (const p of pairs) {
    const k = p.host + "\u0000" + p.taskId;
    const c = byTask.get(k) ?? { sum: 0, n: 0 };
    c.sum += p.diff;
    c.n += 1;
    byTask.set(k, c);
  }
  const clusters = [...byTask.keys()].sort(cmp).map((k) => byTask.get(k));
  if (clusters.length < 2) return null;
  const rnd = seededRandom(seed);
  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    let n = 0;
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[Math.floor(rnd() * clusters.length)];
      s += c.sum;
      n += c.n;
    }
    samples[i] = s / n;
  }
  samples.sort();
  const at = (p) => samples[Math.round(p * (iterations - 1))];
  return [round(at(0.025)), round(at(0.975))];
}

/** Leave-one-task-out: the mean difference without each task in turn, and the largest change. */
export function sensitivityOf(pairs) {
  const full = mean(pairs.map((p) => p.diff));
  const taskIds = [...new Set(pairs.map((p) => p.taskId))].sort(cmp);
  const rows = taskIds.map((t) => {
    const rest = pairs.filter((p) => p.taskId !== t);
    const m = mean(rest.map((p) => p.diff));
    return { taskId: t, meanDiffWithout: round(m), change: m === null || full === null ? null : round(m - full) };
  });
  let largest = null;
  for (const r of rows) if (r.change !== null && (largest === null || Math.abs(r.change) > Math.abs(largest.change))) largest = r;
  return { meanDiff: round(full), rows, largest: largest === null ? null : { taskId: largest.taskId, change: largest.change, meanDiffWithout: largest.meanDiffWithout } };
}

function compare(cmpDef, includedByMode, allKeys, keyInfo, valueOf) {
  const xs = includedByMode.get(cmpDef.x) ?? new Map();
  const ys = includedByMode.get(cmpDef.y) ?? new Map();
  const pairs = [];
  const dropped = [];
  for (const k of allKeys) {
    const a = xs.get(k);
    const b = ys.get(k);
    const info = keyInfo.get(k);
    const x = a === undefined ? null : valueOf(a);
    const y = b === undefined ? null : valueOf(b);
    if (x === null || y === null) {
      const missing = [];
      if (a === undefined) missing.push(cmpDef.x);
      if (b === undefined) missing.push(cmpDef.y);
      // A pair whose runs have no value for the metric (no post-compaction question) is not a dropped pair.
      if (missing.length > 0) dropped.push({ host: info.host, taskId: info.taskId, rep: info.rep, missingOrExcluded: missing });
      continue;
    }
    pairs.push({ host: info.host, taskId: info.taskId, rep: info.rep, x, y, diff: x - y });
  }
  const meanX = mean(pairs.map((p) => p.x));
  const meanY = mean(pairs.map((p) => p.y));
  const meanDiff = mean(pairs.map((p) => p.diff));
  const perTask = new Map();
  for (const p of pairs) perTask.set(p.taskId, [...(perTask.get(p.taskId) ?? []), p.diff]);
  const rp = (p) => ({ host: p.host, taskId: p.taskId, rep: p.rep, x: round(p.x), y: round(p.y), diff: round(p.diff) });
  return {
    id: cmpDef.id,
    label: cmpDef.label,
    x: cmpDef.x,
    y: cmpDef.y,
    pairs: pairs.length,
    droppedPairs: dropped.length,
    dropped,
    meanX: round(meanX),
    meanY: round(meanY),
    meanDiff: round(meanDiff),
    relativeDiff: meanDiff !== null && meanY !== null && meanY > 0 ? round(meanDiff / meanY) : null,
    ci95: bootstrapCi(pairs),
    wins: pairs.filter((p) => p.diff > TIE_EPS).length,
    ties: pairs.filter((p) => Math.abs(p.diff) <= TIE_EPS).length,
    losses: pairs.filter((p) => p.diff < -TIE_EPS).length,
    regressions: pairs.filter((p) => p.diff < -TIE_EPS).map(rp),
    perTask: [...perTask.keys()].sort(cmp).map((t) => ({ taskId: t, meanDiff: round(mean(perTask.get(t))), pairs: perTask.get(t).length })),
    perPair: pairs.map(rp),
    sensitivity: sensitivityOf(pairs),
  };
}

// ---------- overhead ----------

function overheadOf(modes, baseline) {
  const base = modes[baseline];
  const out = {};
  if (base === undefined) return out;
  for (const m of Object.keys(modes).sort(cmp)) {
    if (m === baseline) continue;
    const cur = modes[m];
    const fields = {};
    for (const f of OVERHEAD_FIELDS) {
      const a = base.cost[f].mean;
      const b = cur.cost[f].mean;
      const diff = a === null || b === null ? null : b - a;
      fields[f] = { meanA: a, mean: b, diff: round(diff, 2), percent: diff !== null && a !== null && a > 0 ? round((diff / a) * 100, 2) : null };
    }
    const sa = base.stageCost.meanTokensPerStageTurn;
    const sb = cur.stageCost.meanTokensPerStageTurn;
    const sd = sa === null || sb === null ? null : sb - sa;
    const fbBytes = cur.cost.clockFeedbackBytes.mean;
    out[m] = {
      baseline,
      fields,
      tokensByKind: Object.fromEntries([...TOKEN_KINDS, "totalTokens"].map((k) => {
        const a = base.tokensByKind.mean[k];
        const b = cur.tokensByKind.mean[k];
        const d = a === null || b === null ? null : b - a;
        return [k, { meanA: a, mean: b, diff: round(d, 2), percent: d !== null && a > 0 ? round((d / a) * 100, 2) : null }];
      })),
      stageTurnTokens: { meanA: sa, mean: sb, diff: round(sd, 2), percent: sd !== null && sa > 0 ? round((sd / sa) * 100, 2) : null },
      feedbackBytesPerRun: fbBytes,
      estimatedFeedbackTokensPerRun: fbBytes === null ? null : round(fbBytes / BYTES_PER_TOKEN_ESTIMATE, 2),
      estimateNote: "feedback bytes divided by " + BYTES_PER_TOKEN_ESTIMATE + "; an estimate, not a tokenizer count",
    };
  }
  return out;
}

// ---------- v0.8 (EXPERIMENT-V08.md "Change of the validity rule", "Measurements", "Decision rules") ----------

/** Suite name prefix of the first batches with the v0.8 summary block and validity rule. Later suites ("v09") have them too. */
export const V08_SUITE_PREFIX = "v08";
export const isV08Batch = (batch) => (suiteVersionOf(batch) ?? 0) >= 8;
const violationsOf = (run) => (Array.isArray(run.integrity?.violations) ? run.integrity.violations.length : 0);

/** Runs that stay valid only because the guard denied every attempt (grade.valid with violations), per mode. */
function deniedRunsOf(records, modeIds) {
  const list = records.filter((r) => r.grade?.valid === true && violationsOf(r.run) > 0).map((r) => ({
    runId: r.run.runId, mode: r.run.mode, taskId: r.run.taskId, rep: r.run.rep, violations: violationsOf(r.run),
    deniedCalls: num(r.grade.deniedAttempts?.calls), guardDenied: isObject(r.run.telemetry?.guard) ? num(r.run.telemetry.guard.denied) : null,
  }));
  return { perMode: Object.fromEntries(modeIds.map((m) => [m, list.filter((x) => x.mode === m).length])), runs: list };
}

/** The accuracy and paired tables under the old rule: a run with any integrity violation is invalid. */
function oldRuleOf(records, modeIds, comparisons) {
  const old = records.map((r) => (violationsOf(r.run) > 0 && r.grade !== null && r.grade !== undefined ? { ...r, grade: { ...r.grade, valid: false } } : r));
  const modes = {};
  for (const m of modeIds) {
    const inc = old.filter((r) => r.run.mode === m && exclusionOf(r) === null);
    modes[m] = { includedRuns: inc.length, invalid: old.filter((r) => r.run.mode === m && exclusionOf(r) === "invalid").length, ...accuracyOf(inc) };
  }
  const keyInfo = new Map();
  const byMode = new Map(modeIds.map((m) => [m, new Map()]));
  for (const r of old) {
    const k = pairKeyOf(r.run);
    if (!keyInfo.has(k)) keyInfo.set(k, { host: r.run.host ?? "", taskId: r.run.taskId, rep: r.run.rep });
    if (exclusionOf(r) === null) byMode.get(r.run.mode)?.set(k, r);
  }
  const keys = [...keyInfo.keys()].sort(cmp);
  return { modes, paired: Object.fromEntries(comparisons.map((c) => [c.id, compare(c, byMode, keys, keyInfo, scoreOf)])) };
}

const meanOf = (inc, f) => {
  const v = inc.map(f).filter((x) => x !== null);
  return v.length === 0 ? null : round(mean(v), 2);
};
const savesOf = (run) => {
  const sf = run.telemetry?.stateFile;
  if (!isObject(sf)) return null;
  return Array.isArray(sf.writeStages) ? sf.writeStages.length : num(sf.writes);
};
const costUsdOf = (run) => num(run.telemetry?.costUsd);
const totalTokensOf = (run) => costOf(run).totalTokens;

/**
 * Cost per mode: mean tool calls, tokens and saves per run; added calls and tokens against B; added tokens for each
 * added call (null when the mode adds no call); cost in dollars from telemetry.costUsd (null when no run has it).
 */
function v08CostOf(records, modeIds) {
  const inc = (m) => records.filter((r) => r.run.mode === m && exclusionOf(r) === null);
  const base = modeIds.includes("B") ? inc("B") : null;
  const bCalls = base === null ? null : meanOf(base, (r) => costOf(r.run).toolCalls);
  const bTokens = base === null ? null : meanOf(base, (r) => totalTokensOf(r.run));
  return Object.fromEntries(modeIds.map((m) => {
    const rs = inc(m);
    const calls = meanOf(rs, (r) => costOf(r.run).toolCalls);
    const tokens = meanOf(rs, (r) => totalTokensOf(r.run));
    const addedCalls = calls === null || bCalls === null ? null : round(calls - bCalls, 2);
    const addedTokens = tokens === null || bTokens === null ? null : round(tokens - bTokens, 2);
    const usd = rs.map((r) => costUsdOf(r.run)).filter((v) => v !== null);
    return [m, {
      runs: rs.length,
      toolCallsPerRun: calls,
      addedToolCallsPerRun: addedCalls,
      tokensPerRun: tokens,
      addedTokensPerRun: addedTokens,
      addedTokensPerAddedCall: addedCalls !== null && addedTokens !== null && addedCalls > 0 ? round(addedTokens / addedCalls, 2) : null,
      savesPerRun: meanOf(rs, (r) => savesOf(r.run)),
      costUsdRuns: usd.length,
      costUsdPerRun: usd.length === 0 ? null : round(mean(usd), 6),
      costUsdTotal: usd.length === 0 ? null : round(sum(usd), 6),
    }];
  }));
}

/** The periodic reminder (telemetry.triggers.periodic): each prompt that held it with its turn and stage, and the save stages. */
function periodicOf(records) {
  const runs = [];
  for (const r of records.filter((x) => exclusionOf(x) === null)) {
    const pr = r.run.telemetry?.triggers?.periodic;
    if (!isObject(pr)) continue;
    const fired = (Array.isArray(pr.fired) ? pr.fired : []).filter(isObject).map((f) => ({ n: num(f.n), turn: f.turn ?? null, stage: num(f.stage) ?? stageOfTurn(r.run, f.turn) }));
    const ws = r.run.telemetry?.stateFile?.writeStages;
    runs.push({ runId: r.run.runId, mode: r.run.mode, prompts: num(pr.prompts), fired, saveStages: Array.isArray(ws) ? ws.filter((x) => Number.isInteger(x)).sort((a, b) => a - b) : null });
  }
  runs.sort((a, b) => cmp(a.runId ?? "", b.runId ?? ""));
  const modes = [...new Set(runs.map((x) => x.mode))].sort(cmp);
  return {
    perMode: Object.fromEntries(modes.map((m) => {
      const rs = runs.filter((x) => x.mode === m);
      const fired = rs.map((x) => x.fired.length);
      const prompts = rs.map((x) => x.prompts).filter((v) => v !== null);
      return [m, { runs: rs.length, fired: sum(fired), firedPerRun: round(mean(fired), 2), promptsPerRun: prompts.length === 0 ? null : round(mean(prompts), 2) }];
    })),
    runs,
  };
}

/** Share of reference facts whose summary status is correct or formatted, over all compactions of a mode. */
function summaryCoverageOf(mode) {
  const t = mode?.facts?.current?.summary;
  if (!isObject(t) || !(t.n > 0)) return null;
  return round((t.counts.correct + t.counts.formatted) / t.n);
}

/** The same share over the facts that the matcher assigned (all facts minus "not assigned"), or null. */
function summaryCoverageAssignedOf(mode) {
  return mode?.facts?.current?.summary?.coverage?.shareAssigned ?? null;
}

/**
 * Decision helper (EXPERIMENT-V08.md and EXPERIMENT-V09.md "Decision rules"): for U-N, Q-N, R-N and R-Q the paired
 * mean difference with its interval, the summary coverage difference in points, and the added tokens per run against
 * B of the first mode divided by those of the second. With the "not assigned" status, also the summary coverage over
 * the assigned facts. Numbers only, no verdict.
 */
function decisionOf(modes, paired, cost, ctx = null) {
  const out = {};
  for (const [x, y] of [["U", "N"], ["Q", "N"], ["R", "N"], ["R", "Q"], ["V", "R"], ["V", "Q"]]) {
    const id = x + "-" + y;
    if (modes[x] === undefined || modes[y] === undefined) continue;
    const p = paired[id] ?? null;
    const cx = summaryCoverageOf(modes[x]);
    const cy = summaryCoverageOf(modes[y]);
    const ax = cost[x]?.addedTokensPerRun ?? null;
    const ay = cost[y]?.addedTokensPerRun ?? null;
    out[id] = {
      pairs: p?.pairs ?? null,
      meanDiff: p?.meanDiff ?? null,
      ci95: p?.ci95 ?? null,
      summaryCoverage: { [x]: cx, [y]: cy },
      summaryCoverageDiffPoints: cx === null || cy === null ? null : round((cx - cy) * 100, 2),
      ...(modes[x]?.facts?.current?.summary?.coverage !== undefined ? { summaryCoverageAssigned: { [x]: summaryCoverageAssignedOf(modes[x]), [y]: summaryCoverageAssignedOf(modes[y]) } } : {}),
      addedTokensPerRun: { [x]: ax, [y]: ay },
      addedTokensRatio: ax === null || ay === null || ay <= 0 ? null : round(ax / ay, 4),
      ...(x === "V" && ctx !== null ? lineFormatOf(x, y, modes, ctx) : {}),
    };
  }
  return out;
}

/** Share of facts with a history whose summary history status is correct or formatted, from a facts block, or null. */
function historyCoverageOf(fx) {
  const t = fx?.history?.summary;
  if (!isObject(t) || !(t.n > 0)) return null;
  return round((t.counts.correct + t.counts.formatted) / t.n);
}

/**
 * The added fields of the V rows of the decision helper (EXPERIMENT-V10.md "Decision rules"): the summary coverage
 * of the earlier values (history status) with its difference in points, the mean host summary length of each mode
 * with the ratio of the first to the second, and for each task shape the coverage of current and earlier values.
 */
function lineFormatOf(x, y, modes, { records, tasks, statuses }) {
  const hx = historyCoverageOf(modes[x]?.facts);
  const hy = historyCoverageOf(modes[y]?.facts);
  const inc = (m) => records.filter((r) => r.run.mode === m && exclusionOf(r) === null);
  const bx = summaryBytesStatsOf(inc(x)).meanBytes;
  const by = summaryBytesStatsOf(inc(y)).meanBytes;
  const cur = (fx) => {
    const t = fx?.current?.summary;
    return isObject(t) && t.n > 0 ? round((t.counts.correct + t.counts.formatted) / t.n) : null;
  };
  const byShape = {};
  for (const shape of shapesOf(records, tasks)) {
    const of = (m) => factsOf(inc(m).filter((r) => shapeOf(tasks.get(r.run.taskId)) === shape), statuses);
    const fx = of(x), fy = of(y);
    byShape[shape] = { summaryCoverage: { [x]: cur(fx), [y]: cur(fy) }, summaryHistoryCoverage: { [x]: historyCoverageOf(fx), [y]: historyCoverageOf(fy) } };
  }
  return {
    summaryHistoryCoverage: { [x]: hx, [y]: hy },
    summaryHistoryCoverageDiffPoints: hx === null || hy === null ? null : round((hx - hy) * 100, 2),
    summaryMeanBytes: { [x]: bx, [y]: by },
    summaryBytesRatio: bx === null || by === null || by <= 0 ? null : round(bx / by, 4),
    byShape,
  };
}

// ---------- v0.10 (EXPERIMENT-V10.md "Stop rules", "Measurements") ----------

/**
 * Host summaries with a history line (facts.json compactions[].summary.historyLine), for each run and mode. A run
 * whose facts.json has no such field counts its summaries as unknown.
 */
function historyLinesOf(records, modeIds) {
  const runs = [];
  for (const r of records) {
    const comps = Array.isArray(r.facts?.compactions) ? r.facts.compactions : [];
    const sums = comps.filter((c) => c?.summary?.present === true);
    const known = sums.filter((c) => typeof c.summary.historyLine === "boolean");
    runs.push({ runId: r.run.runId, mode: r.run.mode, included: exclusionOf(r) === null, summaries: sums.length, withHistoryLine: known.filter((c) => c.summary.historyLine).length, unknown: sums.length - known.length });
  }
  runs.sort((a, b) => cmp(a.runId ?? "", b.runId ?? ""));
  return {
    pattern: "/^.*history: .+/m",
    perMode: Object.fromEntries(modeIds.map((m) => {
      const rs = runs.filter((x) => x.mode === m);
      return [m, { runs: rs.length, summaries: sum(rs.map((x) => x.summaries)), withHistoryLine: sum(rs.map((x) => x.withHistoryLine)), runsWithHistoryLine: rs.filter((x) => x.withHistoryLine > 0).length }];
    })),
    runs,
  };
}

/** The host version (batch.json cli.version) and the plugin build (batch.json overlay.sourceSha) of a batch. */
function buildOf(batch) {
  return {
    hostVersion: typeof batch?.cli?.version === "string" ? batch.cli.version : null,
    pluginBuild: typeof batch?.overlay?.sourceSha === "string" ? batch.overlay.sourceSha : null,
  };
}

/**
 * Pooled comparison (EXPERIMENT-V10.md "Measurements", secondary): the comparisons of the batch whose two modes have
 * runs in this batch and in each pool batch, over the pairs of all batches. The pair key is batch, task and rep; the
 * `host` field of a pair holds its batch name. The bootstrap resamples tasks. `pointerOnly` is true when the host
 * version or the plugin build differs between the batches or is unknown.
 */
function pooledOf(input, records, comparisons) {
  const all = [{ batchName: input.batchName, batch: input.batch, records }, ...input.pool.map((p) => ({ ...p, records: p.records.map((r) => ({ retrieval: null, coverage: null, facts: null, ...r })) }))];
  const batches = all.map((b) => ({ batch: b.batchName, suite: typeof b.batch?.suite === "string" ? b.batch.suite : null, ...buildOf(b.batch), runs: b.records.length }));
  const same = (k) => batches.every((b) => b[k] !== null && b[k] === batches[0][k]);
  const modesIn = (b) => new Set(b.records.map((r) => r.run.mode));
  const cmps = comparisons.filter((c) => all.every((b) => modesIn(b).has(c.x) && modesIn(b).has(c.y)));
  const modeIds = [...new Set(all.flatMap((b) => [...modesIn(b)]))].sort(cmp);
  const keyInfo = new Map();
  const byMode = new Map(modeIds.map((m) => [m, new Map()]));
  for (const b of all) for (const r of b.records) {
    const k = [b.batchName, r.run.taskId, String(r.run.rep)].join("\u0000");
    if (!keyInfo.has(k)) keyInfo.set(k, { host: b.batchName, taskId: r.run.taskId, rep: r.run.rep });
    if (exclusionOf(r) === null) byMode.get(r.run.mode)?.set(k, r);
  }
  const keys = [...keyInfo.keys()].sort(cmp);
  return {
    batches,
    sameHostVersion: same("hostVersion"),
    samePluginBuild: same("pluginBuild"),
    pointerOnly: !(same("hostVersion") && same("pluginBuild")),
    comparisons: cmps.map((c) => ({ id: c.id, x: c.x, y: c.y, label: c.label })),
    paired: Object.fromEntries(cmps.map((c) => [c.id, compare(c, byMode, keys, keyInfo, scoreOf)])),
    pairedCheckpoint: Object.fromEntries(cmps.map((c) => [c.id, compare(c, byMode, keys, keyInfo, checkpointOf)])),
  };
}

// ---------- v0.9 (EXPERIMENT-V09.md "Measurements") ----------

/** Task shapes of v0.9 in report order. A task without the `shape` field is "old". */
export const TASK_SHAPES = Object.freeze(["old", "worklog", "decision", "incident", "work", "rules"]);
export const shapeOf = (task) => (typeof task?.shape === "string" && task.shape !== "" ? task.shape : "old");

/** The shapes of the tasks of a batch: TASK_SHAPES order first, then other names in sort order. */
function shapesOf(records, tasks) {
  const seen = new Set(records.map((r) => shapeOf(tasks.get(r.run.taskId))));
  return [...TASK_SHAPES.filter((s) => seen.has(s)), ...[...seen].filter((s) => !TASK_SHAPES.includes(s)).sort(cmp)];
}

/** Included records by mode and pair key, and the sorted pair keys, of a record list. */
function pairsOf(records, modeIds) {
  const keyInfo = new Map();
  const byMode = new Map(modeIds.map((m) => [m, new Map()]));
  for (const r of records) {
    const k = pairKeyOf(r.run);
    if (!keyInfo.has(k)) keyInfo.set(k, { host: r.run.host ?? "", taskId: r.run.taskId, rep: r.run.rep });
    if (exclusionOf(r) === null) byMode.get(r.run.mode)?.set(k, r);
  }
  return { keyInfo, byMode, keys: [...keyInfo.keys()].sort(cmp) };
}

/**
 * For each task shape: the tasks, per mode the accuracy (runs, invalid runs, mean score, success rate, probe and
 * post-compaction accuracy) and the fact status tables, and the paired comparisons of the batch over the tasks of
 * that shape.
 */
function byShapeOf(records, modeIds, comparisons, tasks, statuses) {
  return Object.fromEntries(shapesOf(records, tasks).map((shape) => {
    const recs = records.filter((r) => shapeOf(tasks.get(r.run.taskId)) === shape);
    const modes = {};
    for (const m of modeIds) {
      const all = recs.filter((r) => r.run.mode === m);
      const inc = all.filter((r) => exclusionOf(r) === null);
      const pre = { q: 0, c: 0 };
      const chk = { q: 0, c: 0 };
      for (const r of inc) {
        const done = r.run.status === "completed";
        pre.q += num(r.grade.preCompaction?.questions) ?? 0;
        pre.c += done ? num(r.grade.preCompaction?.correct) ?? 0 : 0;
        chk.q += probeQuestionsOf(r.grade);
        chk.c += done ? num(r.grade.checkpoint?.correct) ?? 0 : 0;
      }
      const fx = factsOf(inc, statuses);
      modes[m] = {
        includedRuns: inc.length,
        invalid: all.filter((r) => exclusionOf(r) === "invalid").length,
        ...accuracyOf(inc),
        postCompactionContinuity: ratio(pre.q, pre.c),
        checkpoint: ratio(chk.q, chk.c),
        facts: { runs: fx.runs, compactions: fx.compactions, facts: fx.facts, current: fx.current, history: fx.history },
      };
    }
    const { keyInfo, byMode, keys } = pairsOf(recs, modeIds);
    return [shape, {
      tasks: [...new Set(recs.map((r) => r.run.taskId))].sort(cmp),
      modes,
      paired: Object.fromEntries(comparisons.map((c) => [c.id, compare(c, byMode, keys, keyInfo, scoreOf)])),
    }];
  }));
}

/** Mean, minimum and maximum length in bytes of the host summaries (facts.json compactions[].summary.bytes) of runs. */
function summaryBytesStatsOf(inc) {
  const b = inc.flatMap((r) => (Array.isArray(r.facts?.compactions) ? r.facts.compactions : []))
    .filter((c) => c?.summary?.present === true && num(c.summary.bytes) !== null).map((c) => c.summary.bytes);
  return { summaries: b.length, meanBytes: b.length === 0 ? null : round(mean(b), 1), minBytes: b.length === 0 ? null : Math.min(...b), maxBytes: b.length === 0 ? null : Math.max(...b) };
}

/** Host summary length per mode over the runs in the accuracy numbers, overall and per task shape. */
function summaryBytesOf(records, modeIds, tasks) {
  const shapes = shapesOf(records, tasks);
  return Object.fromEntries(modeIds.map((m) => {
    const inc = records.filter((r) => r.run.mode === m && exclusionOf(r) === null);
    return [m, { ...summaryBytesStatsOf(inc), byShape: Object.fromEntries(shapes.map((s) => [s, summaryBytesStatsOf(inc.filter((r) => shapeOf(tasks.get(r.run.taskId)) === s))])) }];
  }));
}

/** The stage of each probe question of a task (checkpoint or checkpoints[] afterStage). */
function probeStagesOf(task) {
  const list = [...(Array.isArray(task?.checkpoints) ? task.checkpoints : []), ...(isObject(task?.checkpoint) ? [task.checkpoint] : [])];
  const out = new Map();
  for (const cp of list) {
    // A probe list (timing after_compaction or after_auto_compaction, runner/plan.mjs checkpointsOf) gives each
    // question the stage of its probe; the top-level afterStage is then not a probe stage.
    if (Array.isArray(cp?.probes) && ["after_compaction", "after_auto_compaction"].includes(cp.timing)) {
      for (const p of cp.probes) if (Number.isInteger(p?.afterStage) && Array.isArray(p.questionIds)) for (const id of p.questionIds) if (typeof id === "string") out.set(id, p.afterStage);
      continue;
    }
    if (Number.isInteger(cp?.afterStage) && Array.isArray(cp.questions)) for (const q of cp.questions) if (typeof q?.id === "string") out.set(q.id, cp.afterStage);
  }
  return out;
}

/**
 * Compactions that the host marked (run.json compactions[] with confirmed true), one row each, for every run: the
 * trigger kind (the runner field `trigger`, null when absent), the context size before it (`preTokens`), and the
 * probe accuracy after it: the probe questions whose stage is at or after its stage and before the stage of the next
 * marked compaction. A probe that the runner did not ask (grade item asked false) is left out; an asked probe with no
 * parsed answer counts as wrong. A run that did not complete has its probe answers counted as wrong. A run with no
 * marked compaction has a run row with 0 and no compaction row. `perMode` sums the rows of the runs in the accuracy
 * numbers.
 */
function compactionsTableOf(records, tasks) {
  const runs = [];
  const rows = [];
  const triggers = {};
  for (const r of records) {
    const marked = (Array.isArray(r.run.compactions) ? r.run.compactions : []).filter((c) => isObject(c) && c.confirmed === true);
    runs.push({ runId: r.run.runId, mode: r.run.mode, taskId: r.run.taskId, included: exclusionOf(r) === null, compactions: marked.length });
    const stages = probeStagesOf(tasks.get(r.run.taskId));
    // A probe that the runner did not ask (asked false) is not counted.
    const items = (Array.isArray(r.grade?.checkpointItems) ? r.grade.checkpointItems : []).filter((q) => q?.asked !== false);
    const done = r.run.status === "completed";
    marked.forEach((c, i) => {
      const at = Number.isInteger(c.afterStage) ? c.afterStage : null;
      const next = marked.slice(i + 1).map((x) => x.afterStage).find((s) => Number.isInteger(s) && at !== null && s > at) ?? null;
      const probes = at === null ? [] : items.filter((q) => { const s = stages.get(q?.id); return s !== undefined && s >= at && (next === null || s < next); });
      const trigger = typeof c.trigger === "string" && c.trigger !== "" ? c.trigger : null;
      triggers[trigger ?? "unknown"] = (triggers[trigger ?? "unknown"] ?? 0) + 1;
      rows.push({
        runId: r.run.runId, mode: r.run.mode, taskId: r.run.taskId, included: exclusionOf(r) === null, n: i + 1,
        afterStage: at, trigger, preTokens: num(c.preTokens),
        probe: probes.length === 0 ? null : ratio(probes.length, done ? probes.filter((q) => q.correct === true).length : 0),
      });
    });
  }
  const byRun = (a, b) => cmp(a.runId ?? "", b.runId ?? "");
  // Per mode, over the runs in the accuracy numbers: marked compactions per run, mean preTokens, probe accuracy over
  // the asked probe questions of the rows.
  const modes = [...new Set(runs.map((r) => r.mode))].sort(cmp);
  const perMode = Object.fromEntries(modes.map((m) => {
    const rs = runs.filter((r) => r.mode === m && r.included);
    const cs = rows.filter((r) => r.mode === m && r.included);
    const pre = cs.map((r) => r.preTokens).filter((v) => v !== null);
    const probes = cs.filter((r) => r.probe !== null);
    return [m, {
      runs: rs.length,
      compactions: cs.length,
      compactionsPerRun: rs.length === 0 ? null : round(cs.length / rs.length, 2),
      meanPreTokens: pre.length === 0 ? null : round(mean(pre), 1),
      probe: ratio(sum(probes.map((r) => r.probe.questions)), sum(probes.map((r) => r.probe.correct))),
    }];
  }));
  return { runs: runs.sort(byRun), rows: rows.sort((a, b) => byRun(a, b) || a.n - b.n), triggers: Object.fromEntries(Object.keys(triggers).sort(cmp).map((k) => [k, triggers[k]])), perMode };
}

function v09Of(records, modeIds, comparisons, tasks, statuses) {
  return {
    shapes: shapesOf(records, tasks),
    byShape: byShapeOf(records, modeIds, comparisons, tasks, statuses),
    summaryBytes: summaryBytesOf(records, modeIds, tasks),
    compactions: compactionsTableOf(records, tasks),
  };
}

// ---------- per task ----------

function perTaskOf(records, tasks, modes) {
  const inc = records.filter((r) => exclusionOf(r) === null);
  const taskIds = [...new Set(records.map((r) => r.run.taskId))].sort(cmp);
  return taskIds.map((t) => {
    const out = { taskId: t, category: tasks.get(t)?.category ?? null, profile: tasks.get(t)?.profile ?? null, modes: {} };
    for (const m of modes) {
      const sub = inc.filter((r) => r.run.taskId === t && r.run.mode === m);
      const post = sub.map(postCompactionOf).filter((v) => v !== null);
      out.modes[m] = { ...accuracyOf(sub), postCompaction: round(mean(post)) };
    }
    return out;
  });
}

/** Calibration view (EXPERIMENT-V07.md "Tasks"): for a batch with modes B and L only, both scores per task. */
export const CALIBRATION_CEILING_TASKS = 5;
function calibrationOf(perTask, modes) {
  if (modes.length !== 2 || !modes.includes("B") || !modes.includes("L")) return null;
  const tasks = perTask.map((t) => {
    const l = t.modes.L?.runs > 0 ? t.modes.L.meanScore : null;
    return { taskId: t.taskId, B: t.modes.B?.runs > 0 ? t.modes.B.meanScore : null, L: l, lAtCeiling: l !== null && l >= 1 - TIE_EPS };
  });
  const at = tasks.filter((t) => t.lAtCeiling).length;
  return { tasks, tasksWithLAtCeiling: at, ceilingRule: CALIBRATION_CEILING_TASKS, harderTasksNeeded: at >= CALIBRATION_CEILING_TASKS };
}

// ---------- differing cases ----------

function eventsOf(key, ids) {
  const byId = new Map((key?.events ?? []).map((e) => [e.id, e]));
  return [...(ids ?? [])].map((id) => {
    const e = byId.get(id);
    return { id, stage: e?.stage ?? null, summary: e?.summary ?? null };
  });
}

function questionIdsOf(rec, key) {
  const ids = new Set(Object.keys(key?.answers ?? {}));
  for (const q of rec.grade.questions ?? []) ids.add(q.id);
  return [...ids].sort(cmp);
}

function correctMap(rec, ids) {
  const byId = new Map((rec.grade.questions ?? []).map((q) => [q.id, q]));
  const out = {};
  for (const id of ids) out[id] = rec.run.status === "completed" && byId.get(id)?.correct === true;
  return out;
}

/** Retrieval facts of one wrong final question: the retrieval.json record plus the chunks that hold a needed event. */
function retrievalFactsOf(rec, qid, task) {
  const rt = rec.retrieval;
  if (!isObject(rt)) return null;
  const q = (rt.questions ?? []).find((x) => x.scope === "final" && x.id === qid);
  if (q === undefined) return null;
  const needed = new Set(q.needed ?? []);
  const holding = new Set(task ? taskChunks(task).filter((c) => c.events.some((e) => needed.has(e))).map((c) => c.chunkId) : []);
  const chunks = (rt.chunks ?? []).filter((c) => holding.has(c.chunkId));
  return {
    needed: [...(q.needed ?? [])],
    visibleBefore: [...(q.visibleBefore ?? [])],
    visibleAfter: [...(q.visibleAfter ?? [])],
    neverVisible: [...(q.neverVisible ?? [])],
    neededChunks: chunks.map((c) => c.chunkId),
    cutChunks: chunks.filter((c) => c.cut === true).map((c) => c.chunkId),
    followUp: chunks.filter((c) => c.cut === true).map((c) => c.followUp === true),
    agentNotedGap: q.agentNotedGap === true,
    errorClass: q.errorClass ?? null,
  };
}

/** inSummary and inBlock of one question from coverage.json, or null (no record, or not a text answer). */
function coverageFactOf(rec, qid) {
  const q = isObject(rec.coverage) && Array.isArray(rec.coverage.questions) ? rec.coverage.questions.find((x) => x.id === qid) : undefined;
  return q === undefined ? null : { inSummary: q.inSummary === true, inBlock: q.inBlock === true };
}

function differingCases(includedByMode, allKeys, keyInfo, tasks, keys, multiHost, review, focus) {
  const cases = [];
  for (const k of allKeys) {
    const present = [];
    for (const m of [...includedByMode.keys()].sort(cmp)) {
      const r = includedByMode.get(m).get(k);
      if (r !== undefined) present.push([m, r]);
    }
    const info = keyInfo.get(k);
    const key = keys.get(info.taskId) ?? null;
    // With a focus pair (C and D), a case is a difference between those two modes; else between any two modes.
    const judged = focus === null ? present : present.filter(([m]) => focus.includes(m));
    if (judged.length < 2) continue;
    const ids = [...new Set(present.flatMap(([, r]) => questionIdsOf(r, key)))].sort(cmp);
    const judgedMaps = judged.map(([, r]) => correctMap(r, ids));
    if (!ids.some((id) => judgedMaps.some((m) => m[id] !== judgedMaps[0][id]))) continue;
    const task = tasks.get(info.taskId);
    const modes = {};
    for (const [m, r] of present) {
      const map = correctMap(r, ids);
      const qById = new Map((r.grade.questions ?? []).map((q) => [q.id, q]));
      const wrong = ids.filter((id) => !map[id]).map((id) => {
        const q = qById.get(id) ?? {};
        const ans = key?.answers?.[id] ?? {};
        return {
          id,
          given: q.given === undefined ? null : q.given,
          expected: ans.value === undefined ? null : ans.value,
          aspect: q.aspect ?? ans.aspect ?? null,
          errorCategory: q.errorCategory ?? ans.errorCategory ?? null,
          preCompaction: q.preCompaction === true,
          establishedBy: eventsOf(key, q.establishedBy ?? ans.establishedBy),
          retrieval: retrievalFactsOf(r, id, task),
          coverage: coverageFactOf(r, id),
        };
      });
      const c = costOf(r.run);
      modes[m] = {
        runId: r.run.runId,
        status: r.run.status,
        score: round(scoreOf(r)),
        wrongQuestions: wrong,
        telemetry: {
          clockFeedbackCount: c.clockFeedbackCount,
          clockFeedbackBytes: c.clockFeedbackBytes,
          commitCalls: c.commitCalls,
          statusCalls: c.statusCalls,
          compactions: c.compactions,
          unconfirmedCompactions: c.unconfirmedCompactions,
          guardDenied: c.guardDenied,
        },
        assistantMentions: isObject(r.retrieval?.assistantMentions)
          ? { messages: r.retrieval.assistantMentions.messages ?? null, clock: r.retrieval.assistantMentions.clock ?? null, placebo: r.retrieval.assistantMentions.placebo ?? null }
          : null,
      };
    }
    const id = caseIdOf({ host: info.host, taskId: info.taskId, rep: info.rep }, multiHost);
    const rv = review?.[id];
    cases.push({
      id,
      host: info.host,
      taskId: info.taskId,
      rep: info.rep,
      category: task?.category ?? null,
      profile: task?.profile ?? null,
      judgedModes: judged.map(([m]) => m),
      modes,
      classification: typeof rv?.classification === "string" ? rv.classification : "unreviewed",
      note: typeof rv?.note === "string" ? rv.note : null,
    });
  }
  return cases;
}

// ---------- summary ----------

/**
 * @param {{ batchName: string, batch: object|null, suites?: object|null, tasks: Map<string, object>, keys: Map<string, object>,
 *           records: Array<{ run: object, grade: object|null, retrieval?: object|null }>, review: object|null }} input
 */
/** The anchoring candidates of all runs in the accuracy numbers, for the lead to read in the trace. */
function anchoringListOf(records) {
  return records.filter((r) => exclusionOf(r) === null && Array.isArray(r.facts?.questions)).flatMap((r) => r.facts.questions
    .filter((q) => q.anchoringCandidate === true)
    .map((q) => ({ runId: r.run.runId, mode: r.run.mode, taskId: r.run.taskId, rep: r.run.rep, question: q.id, scope: q.scope ?? null, fact: q.fact, part: q.part,
      compactionStage: q.compactionStage ?? null, stateFile: q.stateFile, summary: q.summary, block: q.block })));
}

/** The facts with an ambiguous match, with run, stage and fact name. */
function ambiguousListOf(records) {
  return records.filter((r) => Array.isArray(r.facts?.compactions)).flatMap((r) => r.facts.compactions.flatMap((c) => (c.facts ?? [])
    .filter((f) => f.ambiguous === true)
    .map((f) => ({ runId: r.run.runId, mode: r.run.mode, afterStage: c.afterStage, fact: f.name, reasons: Array.isArray(f.ambiguousReasons) ? f.ambiguousReasons : [] }))));
}

/** Blocks (host, task, rep) whose modes compacted after different stages. */
function stageMismatchOf(records, modeIds) {
  const byKey = new Map();
  for (const r of records) {
    if (!Array.isArray(r.run.compactions)) continue;
    const k = pairKeyOf(r.run);
    const stages = r.run.compactions.filter((c) => isObject(c) && c.confirmed !== false && Number.isInteger(c.afterStage)).map((c) => c.afterStage).sort((a, b) => a - b);
    const e = byKey.get(k) ?? { taskId: r.run.taskId, rep: r.run.rep, stages: {} };
    e.stages[r.run.mode] = stages;
    byKey.set(k, e);
  }
  return [...byKey.keys()].sort(cmp).map((k) => byKey.get(k)).filter((e) => {
    const sets = modeIds.filter((m) => e.stages[m] !== undefined).map((m) => e.stages[m].join(","));
    return new Set(sets).size > 1;
  });
}

function v08Of(records, modeIds, comparisons, modes, paired, ctx = null) {
  const cost = v08CostOf(records, modeIds);
  return {
    validityRule: "a run whose integrity violations were all denied by the guard stays valid (graders/grade.mjs deniedViolations)",
    deniedRuns: deniedRunsOf(records, modeIds),
    oldRule: oldRuleOf(records, modeIds, comparisons),
    cost,
    periodic: periodicOf(records),
    decision: decisionOf(modes, paired, cost, ctx),
  };
}

export function computeSummary(input) {
  const { tasks, keys } = input;
  const records = [...input.records].map((r) => ({ retrieval: null, coverage: null, facts: null, ...r })).sort((a, b) => cmp(a.run.runId ?? "", b.run.runId ?? ""));
  const hosts = [...new Set(records.map((r) => r.run.host ?? ""))].sort(cmp);
  const multiHost = hosts.length > 1;
  const taskIds = [...new Set(records.map((r) => r.run.taskId))].sort(cmp);
  const size = sizeGroupsOf(taskIds, tasks);
  const modeIds = modesOf(input.batch, records);
  const comparisons = comparisonsOf(input.batch, input.suites ?? null, modeIds);
  const baseline = baselineOf(modeIds);

  const modes = {};
  const statuses = factStatusesOf(input.batch, records);
  for (const m of modeIds) modes[m] = modeMetrics(m, records, tasks, size.byTask, statuses);
  const perTask = perTaskOf(records, tasks, modeIds);

  const keyInfo = new Map();
  const includedByMode = new Map(modeIds.map((m) => [m, new Map()]));
  for (const r of records) {
    const k = pairKeyOf(r.run);
    if (!keyInfo.has(k)) keyInfo.set(k, { host: r.run.host ?? "", taskId: r.run.taskId, rep: r.run.rep });
    if (exclusionOf(r) === null) includedByMode.get(r.run.mode)?.set(k, r);
  }
  const allKeys = [...keyInfo.keys()].sort(cmp);
  const paired = {};
  const pairedPostCompaction = {};
  const pairedCheckpoint = {};
  const pairedCompleted = {};
  for (const c of comparisons) {
    paired[c.id] = compare(c, includedByMode, allKeys, keyInfo, scoreOf);
    pairedPostCompaction[c.id] = compare(c, includedByMode, allKeys, keyInfo, postCompactionOf);
    pairedCheckpoint[c.id] = compare(c, includedByMode, allKeys, keyInfo, checkpointOf);
    pairedCompleted[c.id] = compare(c, includedByMode, allKeys, keyInfo, (r) => (r.run.status === "completed" ? scoreOf(r) : null));
  }

  const review = input.review && typeof input.review === "object" ? input.review : null;
  // A difference between the modes of the primary placebo, v0.4 or v0.5 comparison makes a case; else any two modes.
  const both = (x, y) => modeIds.includes(x) && modeIds.includes(y);
  const focus = both("C", "D") ? ["C", "D"] : both("E", "F") ? ["E", "F"] : both("F", "H") ? ["F", "H"] : null;
  const cases = differingCases(includedByMode, allKeys, keyInfo, tasks, keys, multiHost, review, focus);
  const caseIds = new Set(cases.map((c) => c.id));
  const unmatched = review === null ? [] : Object.keys(review).filter((k) => k !== "recommendation" && !caseIds.has(k)).sort(cmp);

  const listed = records
    .filter((r) => r.run.status !== "completed" || exclusionOf(r) !== null)
    .map((r) => ({
      runId: r.run.runId,
      mode: r.run.mode,
      taskId: r.run.taskId,
      rep: r.run.rep,
      status: r.run.status,
      excludedAs: exclusionOf(r),
      inAccuracy: exclusionOf(r) === null,
      failure: r.run.failure === undefined ? null : r.run.failure,
      limitHit: typeof r.run.limitHit === "string" ? r.run.limitHit : null,
      invalidReason: r.grade?.invalidReason ?? null,
      attempts: attemptsOf(r.run),
      violations: Array.isArray(r.run.integrity?.violations) ? r.run.integrity.violations.length : 0,
    }));

  const unconfirmed = records.flatMap((r) =>
    (Array.isArray(r.run.compactions) ? r.run.compactions : []).filter((c) => isObject(c) && c.confirmed === false).map((c) => ({ runId: r.run.runId, afterStage: c.afterStage ?? null, mechanism: c.mechanism ?? null })));

  return {
    schema: 1,
    batch: input.batchName,
    hosts,
    modeList: modeIds,
    comparisons: comparisons.map((c) => ({ id: c.id, x: c.x, y: c.y, label: c.label })),
    baseline,
    differingCaseRule: focus === null ? "any two modes differ" : "modes " + focus[0] + " and " + focus[1] + " differ",
    method: {
      bootstrap: { seed: BOOTSTRAP_SEED, iterations: BOOTSTRAP_ITERATIONS, resampleUnit: "task", interval: "percentile 95%" },
      sizeGroups: size.groups,
      feedbackTokenEstimate: "bytes / " + BYTES_PER_TOKEN_ESTIMATE,
      exclusions: "infra_failed after retries, invalid grade and missing grade are outside accuracy; agent_failed, timeout and limit_exceeded count as score 0",
    },
    runs: {
      total: records.length,
      tasks: taskIds.length,
      withRetrieval: records.filter((r) => isObject(r.retrieval)).length,
      withCoverage: records.filter((r) => isObject(r.coverage)).length,
    },
    modes,
    paired,
    pairedPostCompaction,
    pairedCheckpoint,
    pairedCompleted,
    anchoringCandidates: anchoringListOf(records),
    ambiguousFacts: ambiguousListOf(records),
    compactionStageMismatch: stageMismatchOf(records, modeIds),
    overhead: overheadOf(modes, baseline),
    perTask,
    calibration: calibrationOf(perTask, modeIds),
    // v0.8 and later only, so that older summaries keep their bytes.
    ...(isV08Batch(input.batch) ? { v08: v08Of(records, modeIds, comparisons, modes, paired, { records, tasks, statuses }) } : {}),
    ...(isV08Batch(input.batch) ? { v09: v09Of(records, modeIds, comparisons, tasks, statuses) } : {}),
    // v0.10 and later only.
    ...((suiteVersionOf(input.batch) ?? 0) >= 10 ? { v10: { historyLines: historyLinesOf(records, modeIds) } } : {}),
    // Only with pool batches (analyze.mjs --pool, or batch.json poolBatches).
    ...(Array.isArray(input.pool) && input.pool.length > 0 ? { pooled: pooledOf(input, records, comparisons) } : {}),
    differingCases: cases,
    listedRuns: listed,
    unconfirmedCompactions: unconfirmed,
    review: {
      present: review !== null,
      recommendation: typeof review?.recommendation === "string" ? review.recommendation : null,
      unmatchedKeys: unmatched,
    },
  };
}
