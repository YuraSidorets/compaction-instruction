#!/usr/bin/env node
// Value coverage of one run (EXPERIMENT-V04.md "Measurements" and "Interfaces"): for each final question with a text
// answer, is every expected value in the last host compaction summary, and in the last returned state block?
// Plain Node built-ins. The pure part is buildCoverage; the file part reads the raw streams of the last attempt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastAttemptDir, parseStream, turnFacts, turnLabel } from "./retrieval.mjs";
import { cmp } from "./util.mjs";

export const COVERAGE_SCHEMA = 1;
/** The same tags as runner/overlay/state-block.mjs (EXPERIMENT-V04.md "Interfaces"). */
export const STATE_OPEN = "[committed-state]";
export const STATE_CLOSE = "[/committed-state]";
/** The first words of the host compaction summary (a user message in the compact turn). */
export const SUMMARY_PREFIX = "This session is being continued";
const STATUS_TOOL = "ctx_clock_status";

// ---------- stream facts ----------

function userTextsOf(line) {
  const c = line?.message?.content;
  if (typeof c === "string") return [c];
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
}

/** The last user message of the stream that starts with the summary prefix, or null. */
export function lastSummary(lines) {
  let out = null;
  for (const l of lines) {
    if (l?.type !== "user") continue;
    for (const t of userTextsOf(l)) if (t.trimStart().startsWith(SUMMARY_PREFIX)) out = t;
  }
  return out;
}

/** The text that a hook_response line gave to the model: hookSpecificOutput.additionalContext of a JSON output, else the raw output. */
function hookOutputText(line) {
  const raw = typeof line.output === "string" && line.output !== "" ? line.output : typeof line.stdout === "string" ? line.stdout : "";
  const s = raw.trim();
  if (s.startsWith("{")) {
    try {
      const v = JSON.parse(s);
      const ctx = v?.hookSpecificOutput?.additionalContext;
      if (typeof ctx === "string") return ctx;
    } catch { /* not JSON: use the raw text */ }
  }
  return raw;
}

/** The text between the last open tag and its close tag in `text`, or null. */
export function lastBlockIn(text) {
  const open = text.lastIndexOf(STATE_OPEN);
  if (open < 0) return null;
  const start = open + STATE_OPEN.length;
  const close = text.indexOf(STATE_CLOSE, start);
  return close < 0 ? null : text.slice(start, close);
}

/** The last state block in the SessionStart hook_response lines of the stream, or null. */
export function lastStateBlock(lines) {
  let out = null;
  for (const l of lines) {
    if (l?.type !== "system" || l.subtype !== "hook_response" || l.hook_event !== "SessionStart") continue;
    const b = lastBlockIn(hookOutputText(l));
    if (b !== null) out = b;
  }
  return out;
}

/** The expected values of a key answer: a string, or a list of strings. Null for any other answer. */
export function textValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) return [...value];
  return null;
}

function statusCallsIn(lines) {
  if (lines === null) return 0;
  return turnFacts(lines).calls.filter((c) => c.name === STATUS_TOOL || c.name.endsWith("__" + STATUS_TOOL)).length;
}

// ---------- state correctness (EXPERIMENT-V05.md "Measurements") ----------

/** The separator of the elements of a history line ("a, then b"). */
const HISTORY_SEP = ", then ";
const HISTORY_SUFFIX = " history";

/**
 * Pure. The checked lines of a reference state text. The first line ("state after stage N") is skipped. A line
 * "name: value" is a history line when the name ends with " history": each element between ", then " is one value.
 * Else it is a current-value line: each comma-separated element is one value.
 * @returns {{ current: Array<{ name: string, values: string[] }>, history: Array<{ name: string, values: string[] }> }}
 */
export function referenceLines(text) {
  const current = [];
  const history = [];
  for (const raw of String(text ?? "").split("\n").slice(1)) {
    const line = raw.trim();
    const at = line.indexOf(": ");
    if (at <= 0) continue;
    const name = line.slice(0, at);
    const value = line.slice(at + 2).trim();
    if (value === "") continue;
    const isHistory = name.endsWith(HISTORY_SUFFIX);
    const values = value.split(isHistory ? HISTORY_SEP : ",").map((v) => v.trim()).filter((v) => v !== "");
    (isHistory ? history : current).push({ name, values });
  }
  return { current, history };
}

/** The number of lines whose every value is an exact substring of `text` (0 when text is null). */
function linesFound(lines, text) {
  if (text === null) return 0;
  return lines.filter((l) => l.values.every((v) => text.includes(v))).length;
}

/** The reference state text with this afterStage, or null. */
function referenceTextAt(ref, afterStage) {
  const states = Array.isArray(ref?.states) ? ref.states : [];
  const s = states.find((x) => x?.afterStage === afterStage && typeof x.text === "string");
  return s === undefined ? null : s.text;
}

/**
 * Pure. One entry for each compaction: the saved state block and the host summary of compact-N against the
 * reference state with afterStage N. Counts are null when the task has no reference state for that stage.
 * @param {Array<{ afterStage: number|null, lines: object[] }>} compactions
 * @param {object|null} reference the parsed reference/<taskId>.state.json
 */
export function buildStateCorrectness(compactions, reference) {
  return compactions.map((c) => {
    const block = lastStateBlock(c.lines);
    const summary = lastSummary(c.lines);
    const text = c.afterStage === null ? null : referenceTextAt(reference, c.afterStage);
    const ref = text === null ? null : referenceLines(text);
    return {
      afterStage: c.afterStage,
      blockFound: block !== null,
      summaryPresent: summary !== null,
      lines: ref === null ? null : ref.current.length,
      found: ref === null ? null : linesFound(ref.current, block),
      historyLines: ref === null ? null : ref.history.length,
      historyFound: ref === null ? null : linesFound(ref.history, block),
      summaryFound: ref === null ? null : linesFound(ref.current, summary),
      summaryHistoryFound: ref === null ? null : linesFound(ref.history, summary),
    };
  });
}

// ---------- the coverage record ----------

/**
 * Pure. The coverage record of a run.
 * @param {{ key: object, run: object, grade: object|null, compact: { label: string, lines: object[] }|null,
 *           turns: Array<{ kind: string, lines: object[]|null }>, reference?: string|null,
 *           stateCorrectness?: object[]|null }} input
 * `reference` is the reference state text of the last compaction (adds inReference). `stateCorrectness` is the
 * list from buildStateCorrectness (added as is).
 */
export function buildCoverage({ key, run, grade, compact, turns, reference = null, stateCorrectness = null }) {
  const summary = compact === null ? null : lastSummary(compact.lines);
  const block = compact === null ? null : lastStateBlock(compact.lines);
  const completed = run.status === "completed";
  const gq = new Map((grade?.questions ?? []).map((q) => [q.id, q]));
  const questions = [];
  for (const id of Object.keys(key?.answers ?? {}).sort(cmp)) {
    const values = textValues(key.answers[id]?.value);
    if (values === null) continue;
    questions.push({
      id,
      values: values.length,
      inSummary: summary !== null && values.every((v) => summary.includes(v)),
      inBlock: block !== null && values.every((v) => block.includes(v)),
      ...(reference === null ? {} : { inReference: values.every((v) => reference.includes(v)) }),
      correct: completed && gq.get(id)?.correct === true,
    });
  }
  const sumKind = (kind) => turns.filter((t) => t.kind === kind).reduce((n, t) => n + statusCallsIn(t.lines), 0);
  return {
    schema: COVERAGE_SCHEMA,
    runId: run.runId ?? null,
    compactTurn: compact === null ? null : compact.label,
    summaryFound: summary !== null,
    summaryBytes: summary === null ? null : Buffer.byteLength(summary, "utf8"),
    blockFound: block !== null,
    blockBytes: block === null ? null : Buffer.byteLength(block, "utf8"),
    questions,
    statusCalls: { checkpoint: sumKind("checkpoint"), final: sumKind("final") },
    ...(stateCorrectness === null ? {} : { stateCorrectness }),
  };
}

// ---------- file access ----------

const compactStage = (name) => Number(name.slice("compact-".length, -".jsonl".length));

/** The compact turns in order: from run.json turns, else the compact-N.jsonl files by N. */
export function compactTurns(dir, run) {
  const fromRun = (run.turns ?? []).filter((t) => t.kind === "compact");
  if (fromRun.length > 0) return fromRun.map((t) => ({ label: turnLabel(t), afterStage: Number.isInteger(t.stage) ? t.stage : null }));
  const files = readdirSync(dir).filter((f) => f.startsWith("compact-") && f.endsWith(".jsonl") && Number.isInteger(compactStage(f)));
  files.sort((a, b) => compactStage(a) - compactStage(b));
  return files.map((f) => ({ label: f.slice(0, -".jsonl".length), afterStage: compactStage(f) }));
}

function readLines(path) {
  return existsSync(path) ? parseStream(readFileSync(path, "utf8")) : null;
}

/** The reference state text of the last compaction of a task (reference/<taskId>.state.json), or null. */
export function lastReferenceText(ref) {
  const states = Array.isArray(ref?.states) ? ref.states.filter((s) => Number.isInteger(s?.afterStage) && typeof s.text === "string") : [];
  if (states.length === 0) return null;
  return states.reduce((a, b) => (b.afterStage > a.afterStage ? b : a)).text;
}

/**
 * The coverage record of one run, or null when no raw stream of the run exists. `reference` is the parsed
 * reference/<taskId>.state.json or null. A compact turn without a stream file has no stateCorrectness entry.
 */
export function coverageForRun({ key, run, grade, rawRunDir, reference = null }) {
  const dir = lastAttemptDir(rawRunDir);
  if (dir === null) return null;
  const compacts = compactTurns(dir, run).map((c) => ({ ...c, lines: readLines(join(dir, c.label + ".jsonl")) }));
  const last = compacts.length === 0 ? null : compacts[compacts.length - 1];
  const turns = (run.turns ?? []).map((t) => ({ kind: t.kind, lines: readLines(join(dir, turnLabel(t) + ".jsonl")) }));
  return buildCoverage({
    key, run, grade, turns,
    compact: last === null || last.lines === null ? null : { label: last.label, lines: last.lines },
    reference: lastReferenceText(reference),
    stateCorrectness: buildStateCorrectness(compacts.filter((c) => c.lines !== null), reference),
  });
}

// CLI: writes coverage.json for every run of a batch (the same step that analyze.mjs runs).
if (process.argv[1] !== undefined && process.argv[1].endsWith("coverage.mjs")) {
  const { writeDerived, parseArgs } = await import("./analyze.mjs");
  try {
    const n = writeDerived(parseArgs(process.argv.slice(2)));
    process.stdout.write("coverage: " + n.coverage + " coverage.json written, " + n.withoutStreams + " runs without raw streams\n");
  } catch (err) {
    process.stderr.write("coverage: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}
