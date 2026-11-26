// Context Clock benchmark: the deterministic grader (CONTRACT.md, "Grade record").
// gradeRun(task, key, run) is pure: no clock time, no randomness, no model call, no file access. It never throws:
// a malformed input gives an invalid grade with a reason. The command grades every run of one batch.
//
//   node benchmarks/context-clock/graders/grade.mjs --batch <name> [--root <benchmarks/context-clock folder>] [--raw-dir <dir>]
//
// Validity: a run with no integrity violation is valid. For a batch whose suite name starts with "v08"
// (EXPERIMENT-V08.md "Change of the validity rule"), a run whose violations were all denied by the guard also stays
// valid; see deniedViolations for the exact rule. Older batches keep the old rule and the same grade bytes.
//
// Node built-in modules only. Nothing here imports from src/.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchPaths, resolveTasksDir } from "../paths.mjs";

export const GRADE_SCHEMA = 1;
// EXPERIMENT-V03.md "Grading": limit_exceeded counts as score 0, as timeout does (only a completed run is scored).
export const RUN_STATUSES = Object.freeze(["completed", "agent_failed", "timeout", "infra_failed", "limit_exceeded"]);
export const QUESTION_TYPES = Object.freeze(["choice", "set", "int", "bool"]);
export const ERROR_CATEGORIES = Object.freeze([
  "forgotten_requirement", "obsolete_decision", "wrong_relationship", "invalid_transition",
  "contradiction", "lost_progress", "repeated_work",
]);
/** Why a question is wrong. Recorded per question as `reason`. */
export const WRONG_REASONS = Object.freeze(["missing", "malformed", "clock_text", "not_an_option", "stale", "wrong_value"]);

const CLOCK_MARKER = "[context-clock]";
/** Suite name prefix of the first batches that use the v0.8 validity rule. Later suites ("v09", "v10") use it too. */
export const DENIED_RULE_SUITE_PREFIX = "v08";
/** Version number of DENIED_RULE_SUITE_PREFIX. */
const DENIED_RULE_FIRST_VERSION = 8;
/** The reason text of the guard (runner/overlay/guard.mjs DENY_REASON), in the error result of a denied call. */
export const GUARD_DENY_TEXT = "This path is outside the task workspace and is not available.";
const GIVEN_MAX_CHARS = 200;

// ---------- small helpers ----------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s) => s.trim().toLowerCase();

/** A JSON-safe, bounded copy of the given answer for the grade record. */
function shownGiven(v) {
  if (v === undefined) return null;
  if (typeof v === "string") return v.length > GIVEN_MAX_CHARS ? v.slice(0, GIVEN_MAX_CHARS) + "..." : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => (Array.isArray(x) || isObject(x) ? "[object]" : shownGiven(x)));
  return "[object]";
}

/**
 * Clock text in place of a value: a "[context-clock]" block, or a tick reference such as "tick=17", "tick: 17"
 * or "tick 17". Such text is never correct content (CONTRACT.md: the grader never credits clock text).
 */
export function holdsClockText(v) {
  const strings = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  for (const s of strings) {
    const low = s.toLowerCase();
    if (low.includes(CLOCK_MARKER)) return true;
    if (/\btick\s*[=:]?\s*#?\d+/.test(low)) return true;
  }
  return false;
}

/** int: a JavaScript integer, or a string that holds only an optional sign and digits. */
function parseInt10(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** bool: true or false, or the strings "true" and "false" (case and surrounding space ignored). */
function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = norm(v);
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
}

/**
 * Normalizes a value of one question type. Returns { ok: true, value } or { ok: false, reason }.
 * choice: a string. set: a list of strings (a string instead of a list is malformed). Normalization: trim + lowercase.
 */
function normalize(type, v) {
  if (v === undefined || v === null) return { ok: false, reason: "missing" };
  switch (type) {
    case "choice":
      return typeof v === "string" ? { ok: true, value: norm(v) } : { ok: false, reason: "malformed" };
    case "set": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { ok: false, reason: "malformed" };
      return { ok: true, value: [...new Set(v.map(norm))].sort() };
    }
    case "int": {
      const n = parseInt10(v);
      return n === null ? { ok: false, reason: "malformed" } : { ok: true, value: n };
    }
    case "bool": {
      const b = parseBool(v);
      return b === null ? { ok: false, reason: "malformed" } : { ok: true, value: b };
    }
  }
  return { ok: false, reason: "malformed" };
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A wrong given value that was true earlier (staleValues). For a set: a stale member that is not in the value. */
function isStale(type, given, keyValue, staleValues) {
  if (!Array.isArray(staleValues)) return false;
  for (const s of staleValues) {
    if (type === "set") {
      if (Array.isArray(s)) {
        const st = normalize("set", s);
        if (st.ok && sameSet(st.value, given)) return true;
      } else if (typeof s === "string") {
        const m = norm(s);
        if (given.includes(m) && !keyValue.includes(m)) return true;
      }
    } else {
      const st = normalize(type, s);
      if (st.ok && st.value === given) return true;
    }
  }
  return false;
}

/**
 * Grades one answer. Returns { correct, reason } where reason is null when correct, else one of WRONG_REASONS.
 * `question` is the task question ({ id, type, options? }); `answerKey` is the key entry ({ value, staleValues? }).
 */
export function gradeAnswer(question, answerKey, given) {
  const type = question.type;
  if (given !== undefined && given !== null && holdsClockText(given)) return { correct: false, reason: "clock_text" };
  const g = normalize(type, given);
  if (!g.ok) return { correct: false, reason: g.reason };
  const k = normalize(type, answerKey.value);
  if (!k.ok) return { correct: false, reason: "malformed" }; // unreachable for a valid key (checked earlier)
  if (type === "choice" || type === "set") {
    const options = Array.isArray(question.options) ? question.options.filter((o) => typeof o === "string").map(norm) : [];
    const members = type === "choice" ? [g.value] : g.value;
    if (members.some((m) => !options.includes(m))) {
      return { correct: false, reason: isStale(type, g.value, k.value, answerKey.staleValues) ? "stale" : "not_an_option" };
    }
  }
  const correct = type === "set" ? sameSet(g.value, k.value) : g.value === k.value;
  if (correct) return { correct: true, reason: null };
  return { correct: false, reason: isStale(type, g.value, k.value, answerKey.staleValues) ? "stale" : "wrong_value" };
}

// ---------- input checks ----------

function checkQuestions(list, where) {
  if (!Array.isArray(list)) return where + " questions is not a list";
  const ids = new Set();
  for (const q of list) {
    if (!isObject(q) || typeof q.id !== "string") return where + " question without a string id";
    if (ids.has(q.id)) return where + " question id " + q.id + " is repeated";
    ids.add(q.id);
    if (!QUESTION_TYPES.includes(q.type)) return where + " question " + q.id + " has an unknown type";
  }
  return null;
}

function checkKeyEntries(questions, answers, where) {
  if (!isObject(answers)) return where + " answers is not an object";
  for (const q of questions) {
    const a = answers[q.id];
    if (!isObject(a) || !("value" in a)) return where + " has no answer for " + q.id;
    if (!normalize(q.type, a.value).ok) return where + " answer for " + q.id + " does not fit type " + q.type;
  }
  return null;
}

/** The reason a (task, key, run) triple cannot be graded, or null. */
function inputProblem(task, key, run) {
  if (!isObject(run)) return "run record is not an object";
  if (run.schema !== 1) return "run record schema is not 1";
  if (typeof run.runId !== "string" || run.runId === "") return "run record has no runId";
  if (!RUN_STATUSES.includes(run.status)) return "run status is not one of " + RUN_STATUSES.join(", ");
  if (!isObject(task)) return "task is missing or not an object";
  if (!isObject(key)) return "key is missing or not an object";
  if (typeof task.taskId !== "string" || task.taskId !== key.taskId) return "task and key have different taskId";
  if (run.taskId !== task.taskId) return "run taskId does not match the task";
  if (!isObject(task.final)) return "task has no final block";
  const fq = checkQuestions(task.final.questions, "task final");
  if (fq !== null) return fq;
  const fk = checkKeyEntries(task.final.questions, key.answers, "key");
  if (fk !== null) return fk;
  if (task.checkpoint !== null && task.checkpoint !== undefined) {
    if (!isObject(task.checkpoint)) return "task checkpoint is not an object";
    const cq = checkQuestions(task.checkpoint.questions, "task checkpoint");
    if (cq !== null) return cq;
    const ck = checkKeyEntries(task.checkpoint.questions, key.checkpointAnswers, "key checkpoint");
    if (ck !== null) return ck;
  }
  if (!isObject(run.answers)) return "run answers is not an object";
  if (run.answers.final !== null && run.answers.final !== undefined && !isObject(run.answers.final)) return "run final answers is not an object";
  if (run.answers.checkpoint !== null && run.answers.checkpoint !== undefined && !isObject(run.answers.checkpoint)) return "run checkpoint answers is not an object";
  if (run.compactions !== undefined && run.compactions !== null && !Array.isArray(run.compactions)) return "run compactions is not a list";
  if (!isObject(run.integrity) || !Array.isArray(run.integrity.violations)) return "run integrity.violations is missing";
  return null;
}

// ---------- denied attempts (v0.8 validity rule) ----------

/**
 * Backslashes folded to "/" after the unescape step of the integrity scan (runner/telemetry.mjs), and a run of
 * slashes folded to one: a Windows path written in a string literal of code ("C:\\\\Users") is "C:/Users", the same
 * as the excerpt that the scan made from it.
 */
const slashes = (t) => String(t).replace(/\\\\/g, "\\").replace(/\\/g, "/").replace(/\/{2,}/g, "/");

/**
 * True when a violation is a path inside the agent's own workspace. On Windows the runner scan (runner/telemetry.mjs
 * integrityScan) compares a Git Bash path ("/c/Users/.../ws-...") with the Windows form of the workspace and records
 * it as outside, but the redaction of run.json turns that path into "<workspace>". So the stored excerpt shows it:
 * the reason is "path outside the workspace" and the excerpt is "<workspace>" alone or "<workspace>/<part>", with no
 * ".." part. Such a record is not a violation. A real outside path in the same form ("/c/Windows", "/c/Users/x")
 * never gets the "<workspace>" token at its start.
 */
export function isWorkspaceExcerpt(v) {
  if (!isObject(v) || v.reason !== "path outside the workspace" || typeof v.excerpt !== "string") return false;
  const m = /^<workspace>(?:\/(.*))?$/s.exec(slashes(v.excerpt).replace(/\/$/, ""));
  return m !== null && (m[1] === undefined || !m[1].split("/").includes(".."));
}

/** The integrity violations of a run without the records of paths inside the workspace (isWorkspaceExcerpt). */
export function violationsOf(run) {
  const list = Array.isArray(run?.integrity?.violations) ? run.integrity.violations : [];
  return list.filter((v) => !isWorkspaceExcerpt(v));
}

/**
 * True when an excerpt is a part of a regular expression literal, not a path. Two shapes only: an escape letter with
 * the closing slash and flags of the literal ("\\n/g,", from `.replace(/\\n/g, " ")`), and a counted quantifier
 * ("]{0,160}(openvpn-udp"). No path holds either shape.
 */
export function isRegexLiteralExcerpt(excerpt) {
  const t = String(excerpt ?? "");
  return /^\\+[dDwWsSnrtbBfv]\/[dgimsuyv]*[,;)\]\s]*$/.test(t) || /\{\d+(?:,\d*)?\}/.test(t);
}

/** The placeholders of the runner redaction (runner/telemetry.mjs redactionPairs, and "<repo>"). */
export const REDACTION_TOKEN = /<(?:repo|workspace|data|overlay|work-root|home)>/;

/** A matcher for a violation excerpt: each redaction placeholder (REDACTION_TOKEN) matches any text, the rest literally. */
function excerptMatcher(excerpt) {
  const parts = slashes(excerpt).split(new RegExp(REDACTION_TOKEN.source, "g")).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(".*?"), "s");
}

const resultText = (b) => (typeof b?.content === "string" ? b.content : Array.isArray(b?.content) ? b.content.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ") : "");

/**
 * The tool calls of one turn from its raw stream, or null when the stream is missing. Each call is
 * { id, tool, raw (the input object), input (its JSON text with slashes folded), denied }. Returns a function of the
 * turn label that keeps its results.
 */
function turnCalls(streams) {
  const byTurn = new Map();
  return (turn) => {
    if (byTurn.has(turn)) return byTurn.get(turn);
    const lines = isObject(streams) && Array.isArray(streams[turn]) ? streams[turn] : null;
    let calls = null;
    if (lines !== null) {
      const uses = [];
      const results = new Map();
      for (const l of lines) {
        const content = Array.isArray(l?.message?.content) ? l.message.content : [];
        for (const b of content) {
          if (b?.type === "tool_use") uses.push(b);
          else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") results.set(b.tool_use_id, b);
        }
      }
      calls = uses.map((u) => {
        const r = results.get(u.id) ?? null;
        return { id: u.id, tool: u.name, raw: u.input, input: slashes(JSON.stringify(u.input ?? "")), denied: r !== null && r.is_error === true && resultText(r).includes(GUARD_DENY_TEXT) };
      });
    }
    byTurn.set(turn, calls);
    return calls;
  };
}

/** Tools that write a file: only the target path decides, the written text is code. */
export const WRITE_TOOLS = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const TARGET_KEYS = Object.freeze(["file_path", "notebook_path", "path"]);

/** Every string value of a tool input, at any depth. */
function stringsOf(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

/**
 * Pure. Finds the false "path outside the workspace" records of the runner scan from the raw stream of their turn.
 * The scan (runner/telemetry.mjs integrityScan) reads the JSON text of the whole tool input, so two record kinds are
 * false:
 * 1. codeText: a record of a write tool (WRITE_TOOLS) whose excerpt matches the input of a call of that tool in its
 *    turn, but no target path (file_path, notebook_path, path) of such a call. The excerpt then comes from the written
 *    code (content, old_string, new_string, edits): a relative import ("../config/a.json") or a regular expression.
 *    A target path outside the workspace gives its own record, which matches the target path and stays.
 * 2. quoteEscape: a record of another tool whose excerpt is one letter, a colon and a backslash ("v:\"), when no
 *    string of the matching calls holds that letter, a colon and a slash or backslash. The backslash is then the JSON
 *    escape of a quote in code text such as {v:"1"}, not a drive path. A real "C:\" stays a record.
 * A record with no stream or no matching call stays (strict).
 * @returns {{ kept: object[], codeText: number, quoteEscape: number }}
 */
export function falseRecordsOf(violations, streams) {
  const list = Array.isArray(violations) ? violations : [];
  const callsOf = turnCalls(streams);
  const kept = [];
  let codeText = 0;
  let quoteEscape = 0;
  for (const v of list) {
    const calls = isObject(v) && v.reason === "path outside the workspace" && typeof v.excerpt === "string" ? callsOf(v.turn) : null;
    const re = calls === null ? null : excerptMatcher(v.excerpt);
    const matching = calls === null ? [] : calls.filter((c) => c.tool === v.tool && re.test(c.input));
    if (matching.length > 0 && WRITE_TOOLS.includes(v.tool)) {
      const inTarget = matching.some((c) => isObject(c.raw) && TARGET_KEYS.some((k) => typeof c.raw[k] === "string" && re.test(slashes(JSON.stringify(c.raw[k])))));
      if (!inTarget) {
        codeText++;
        continue;
      }
    } else if (matching.length > 0 && /^[A-Za-z]:\\$/.test(v.excerpt)) {
      const drive = new RegExp("(?<![A-Za-z0-9])" + v.excerpt[0] + ":[\\\\/]");
      if (!matching.some((c) => stringsOf(c.raw).some((t) => drive.test(t)))) {
        quoteEscape++;
        continue;
      }
    }
    kept.push(v);
  }
  return { kept, codeText, quoteEscape };
}

/**
 * Pure. Decides for each integrity violation whether the guard denied it, from the raw stream of its turn.
 * `streams` maps a turn label ("stage-6") to the parsed lines of that turn's raw stream, or null when it is missing.
 * Exact rule:
 * 1. A violation whose excerpt is a regular expression literal (isRegexLiteralExcerpt) is not a path. It counts in
 *    `notPaths` and needs no denial.
 * 2. Each other violation { turn, tool, excerpt } belongs to every call of the same tool in the stream of its turn
 *    whose input matches the excerpt (a redaction placeholder such as "<home>", "<workspace>" or "<work-root>" matches any text, backslashes count as "/", a run of
 *    slashes counts as one). The violations are thus grouped by call: one call can hold several excerpts.
 * 3. A call is denied when its tool result has is_error true and its text holds GUARD_DENY_TEXT.
 * 4. A violation is denied when it belongs to at least one call and every call that it belongs to is denied. A
 *    violation with no stream or no matching call is not denied.
 * allDenied is true when there is at least one violation and each violation is denied or not a path. `calls` is the
 * number of distinct denied calls that hold a violation.
 * @returns {{ violations: number, notPaths: number, denied: number, calls: number, allDenied: boolean, firstNotDenied: object|null }}
 */
export function deniedViolations(violations, streams) {
  const list = Array.isArray(violations) ? violations : [];
  const callsOf = turnCalls(streams);
  let denied = 0;
  let notPaths = 0;
  let firstNotDenied = null;
  const deniedCalls = new Set();
  for (const v of list) {
    if (isObject(v) && isRegexLiteralExcerpt(v.excerpt)) {
      notPaths++;
      continue;
    }
    const calls = isObject(v) ? callsOf(v.turn) : null;
    const re = isObject(v) ? excerptMatcher(v.excerpt ?? "") : null;
    const matching = calls === null ? [] : calls.filter((c) => c.tool === v.tool && re.test(c.input));
    const ok = matching.length > 0 && matching.every((c) => c.denied);
    if (ok) {
      denied++;
      for (const c of matching) deniedCalls.add(v.turn + "\u0000" + c.id);
    } else if (firstNotDenied === null) firstNotDenied = v;
  }
  return { violations: list.length, notPaths, denied, calls: deniedCalls.size, allDenied: list.length > 0 && denied + notPaths === list.length, firstNotDenied };
}

// ---------- grading ----------

/** The stage of the first confirmed compaction in run order, or null. An unconfirmed compaction never counts. */
export function firstConfirmedCompactionStage(run) {
  if (!isObject(run) || !Array.isArray(run.compactions)) return null;
  for (const c of run.compactions) {
    if (isObject(c) && c.confirmed === true && Number.isInteger(c.afterStage)) return c.afterStage;
  }
  return null;
}

function emptyGrade(runId, status, reason) {
  return {
    schema: GRADE_SCHEMA,
    runId,
    status,
    valid: false,
    invalidReason: reason,
    success: false,
    score: 0,
    questions: [],
    continuityErrors: {},
    preCompaction: { questions: 0, correct: 0 },
    checkpoint: null,
    checkpointItems: null,
  };
}

function sortedCounts(map) {
  const out = {};
  for (const k of [...map.keys()].sort()) out[k] = map.get(k);
  return out;
}

/** The exact fraction (CONTRACT.md: "score is the fraction of correct final questions"). JSON number output is deterministic. */
const fraction = (n, d) => (d === 0 ? 0 : n / d);

/**
 * Pure and deterministic. Returns the grade record of CONTRACT.md plus `status`, a `reason` and `type` per question,
 * and `checkpointItems` (one entry per checkpoint question; `checkpoint` keeps the contract shape). Never throws.
 */
export function gradeRun(task, key, run, options = {}) {
  try {
    return gradeRunUnsafe(task, key, run, options);
  } catch (err) {
    const runId = isObject(run) && typeof run.runId === "string" ? run.runId : null;
    const status = isObject(run) && typeof run.status === "string" ? run.status : null;
    return emptyGrade(runId, status, "grader could not read the input: " + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * `options.rule` "v08" with `options.denial` (the result of deniedViolations for this run) applies the v0.8
 * validity rule. Without it, a run with any violation is invalid.
 */
function gradeRunUnsafe(task, key, run, options = {}) {
  const problem = inputProblem(task, key, run);
  if (problem !== null) {
    const runId = isObject(run) && typeof run.runId === "string" ? run.runId : null;
    const status = isObject(run) && typeof run.status === "string" ? run.status : null;
    return emptyGrade(runId, status, problem);
  }

  const long = task.profile === "long" || run.profile === "long";
  const compactStage = long ? null : firstConfirmedCompactionStage(run);
  const finalAnswers = isObject(run.answers.final) ? run.answers.final : {};
  const completed = run.status === "completed";
  const inside = violationsOf(run);
  const insideWorkspace = run.integrity.violations.length - inside.length;
  // options.records: the result of falseRecordsOf for this run (the batch command, from the raw streams).
  const records = isObject(options?.records) && Array.isArray(options.records.kept) ? options.records : null;
  const violations = records === null ? inside : records.kept;
  const falseRecords = records === null ? {} : { ...(records.codeText > 0 ? { codeText: records.codeText } : {}), ...(records.quoteEscape > 0 ? { quoteEscape: records.quoteEscape } : {}) };
  const v08 = options?.rule === "v08";
  const denial = v08 && violations.length > 0 ? (isObject(options.denial) ? options.denial : deniedViolations(violations, null)) : null;
  // The guard log is a second check: it must hold at least as many denials as the denied calls of the streams.
  const guardDenied = typeof run.telemetry?.guard?.denied === "number" ? run.telemetry.guard.denied : null;
  const guardAgrees = denial === null || guardDenied === null || guardDenied >= denial.calls;
  const valid = violations.length === 0 || (denial?.allDenied === true && guardAgrees);
  const counted = valid && completed; // continuity errors and score count only for a valid completed run

  const questions = [];
  const errors = new Map();
  let correctCount = 0;
  let preQ = 0;
  let preOk = 0;
  for (const q of task.final.questions) {
    const k = key.answers[q.id];
    const given = finalAnswers[q.id];
    const r = gradeAnswer(q, k, given);
    const category = r.correct ? null : r.reason === "stale" ? "obsolete_decision" : typeof k.errorCategory === "string" ? k.errorCategory : null;
    const pre = compactStage !== null && Number.isInteger(k.firstEstablishedStage) && k.firstEstablishedStage <= compactStage;
    if (r.correct) correctCount++;
    if (pre) {
      preQ++;
      if (r.correct) preOk++;
    }
    if (category !== null && counted) errors.set(category, (errors.get(category) ?? 0) + 1);
    questions.push({
      id: q.id,
      type: q.type,
      correct: r.correct,
      given: shownGiven(given),
      reason: r.reason,
      aspect: typeof k.aspect === "string" ? k.aspect : null,
      errorCategory: category,
      preCompaction: pre,
      establishedBy: Array.isArray(k.establishedBy) ? k.establishedBy.filter((e) => typeof e === "string") : [],
    });
  }

  let checkpoint = null;
  let checkpointItems = null;
  if (isObject(task.checkpoint)) {
    const given = isObject(run.answers.checkpoint) ? run.answers.checkpoint : {};
    const asked = askedProbeIds(task, run);
    const items = task.checkpoint.questions.map((q) => {
      const r = gradeAnswer(q, key.checkpointAnswers[q.id], given[q.id]);
      return { id: q.id, type: q.type, correct: r.correct, given: shownGiven(given[q.id]), reason: r.reason, ...(asked === null ? {} : { asked: asked.has(q.id) }) };
    });
    // An unasked probe has no answer, so it is never correct: `correct` counts asked questions only.
    checkpoint = asked === null
      ? { questions: items.length, correct: items.filter((i) => i.correct).length }
      : { questions: items.length, asked: items.filter((i) => i.asked).length, correct: items.filter((i) => i.asked && i.correct).length };
    checkpointItems = items;
  }

  const total = task.final.questions.length;
  const allCorrect = total > 0 && correctCount === total;
  return {
    schema: GRADE_SCHEMA,
    runId: run.runId,
    status: run.status,
    valid,
    invalidReason: valid ? null : denial !== null
      ? "integrity: " + violations.length + " violation(s), " + (violations.length - denial.denied - denial.notPaths) + " not denied by the guard, first not denied: " + violationText(denial.firstNotDenied)
      : "integrity: " + violations.length + " violation(s), first: " + violationText(violations[0]),
    success: counted && allCorrect,
    score: counted ? fraction(correctCount, total) : 0,
    questions,
    continuityErrors: sortedCounts(errors),
    preCompaction: { questions: preQ, correct: preOk },
    checkpoint,
    checkpointItems,
    // v0.8 only, so that older grades keep their bytes.
    ...(v08 ? { validityRule: "v08", deniedAttempts: { violations: violations.length, notPaths: denial === null ? 0 : denial.notPaths, denied: denial === null ? 0 : denial.denied, calls: denial === null ? 0 : denial.calls, allDenied: denial !== null && denial.allDenied, ...(insideWorkspace > 0 ? { insideWorkspace } : {}), ...falseRecords } } : {}),
    // Only when a record was dropped, so that other grades keep their bytes.
    ...(!v08 && insideWorkspace > 0 ? { insideWorkspace } : {}),
  };
}

function violationText(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 160 ? s.slice(0, 160) + "..." : s;
}

/** The exact bytes of grade.json. */
export function gradeJson(grade) {
  return JSON.stringify(grade, null, 2) + "\n";
}

// ---------- command ----------

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: existsSync(path) ? "is not valid JSON" : "is missing" };
  }
}

/**
 * Grades every results/<batch>/runs/<runId>/run.json under `root` and writes grade.json next to it.
 * A grade file with the same bytes is not rewritten. Returns the counts for the summary line.
 */
/** The parsed lines of every <turn>.jsonl in the last attempt folder (a1, a2, ...) of a run, or null. */
function rawStreamsOf(rawRunDir) {
  if (!existsSync(rawRunDir)) return null;
  const attempts = readdirSync(rawRunDir).filter((d) => /^a\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (attempts.length === 0) return null;
  const dir = join(rawRunDir, attempts[attempts.length - 1]);
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    out[f.slice(0, -".jsonl".length)] = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }
  return out;
}

/** Checkpoint timing of EXPERIMENT-V09.md part 2: the runner asks a probe only after an automatic compaction. */
export const AUTO_PROBE_TIMING = "after_auto_compaction";

/**
 * The ids of the probe questions that the runner asked, or null when the task checkpoint does not have the timing
 * AUTO_PROBE_TIMING with a `probes` list. A probe { afterStage, questionIds } is asked when the run has a turn with
 * kind "checkpoint" and that stage (runner/plan.mjs checkpointsOf). Tasks with planned probes return null, so their
 * grades keep their bytes.
 */
export function askedProbeIds(task, run) {
  const cp = task?.checkpoint;
  if (!isObject(cp) || cp.timing !== AUTO_PROBE_TIMING || !Array.isArray(cp.probes)) return null;
  const stages = new Set((Array.isArray(run?.turns) ? run.turns : []).filter((t) => isObject(t) && t.kind === "checkpoint" && Number.isInteger(t.stage)).map((t) => t.stage));
  const ids = new Set();
  for (const p of cp.probes) if (isObject(p) && stages.has(p.afterStage) && Array.isArray(p.questionIds)) for (const id of p.questionIds) ids.add(id);
  return ids;
}

/** True when the batch uses the v0.8 validity rule: batch.json suite starts with "v" and a version of 08 or more ("v08", "v09"). */
export function usesDeniedRule(batchDoc) {
  if (!isObject(batchDoc) || typeof batchDoc.suite !== "string") return false;
  const m = /^v(\d{2,})/.exec(batchDoc.suite);
  return m !== null && Number(m[1]) >= DENIED_RULE_FIRST_VERSION;
}

export function gradeBatch(root, batch, opts = {}) {
  const paths = benchPaths({ root });
  const runsDir = join(paths.resultsDir, batch, "runs");
  if (!existsSync(runsDir)) throw new Error("no runs folder: " + runsDir);
  const tasks = new Map();
  // The task and key folder of the batch (batch.json tasksDir, for example tasks/v03), as the analysis resolves it.
  const batchFile = join(paths.resultsDir, batch, "batch.json");
  let batchDoc = null;
  try {
    batchDoc = existsSync(batchFile) ? JSON.parse(readFileSync(batchFile, "utf8")) : null;
  } catch {
    batchDoc = null;
  }
  const tasksRoot = resolveTasksDir({ root, batch: batchDoc });
  const v08 = usesDeniedRule(batchDoc);
  const rawRoot = opts.rawDir ? resolve(opts.rawDir) : join(paths.resultsDir, batch, "raw");
  const load = (kind, taskId) => {
    const file = kind === "task" ? join(tasksRoot, "generated", taskId + ".task.json") : join(tasksRoot, "keys", taskId + ".key.json");
    const cacheKey = kind + ":" + taskId;
    if (!tasks.has(cacheKey)) tasks.set(cacheKey, readJson(file));
    return tasks.get(cacheKey);
  };
  const counts = { runs: 0, valid: 0, invalid: 0, success: 0, scoreSum: 0, scored: 0, written: 0, unchanged: 0 };
  const dirs = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of dirs) {
    const runPath = join(runsDir, name, "run.json");
    if (!existsSync(runPath)) continue;
    counts.runs++;
    const r = readJson(runPath);
    let grade;
    if (!r.ok) {
      grade = emptyGrade(name, null, "run.json " + r.error);
    } else {
      const taskId = isObject(r.value) && typeof r.value.taskId === "string" ? r.value.taskId : null;
      const t = taskId === null ? { ok: false, error: "is unknown (run has no taskId)" } : load("task", taskId);
      const k = taskId === null ? { ok: false, error: "is unknown (run has no taskId)" } : load("key", taskId);
      if (!t.ok) grade = emptyGrade(r.value?.runId ?? name, r.value?.status ?? null, "task file " + t.error);
      else if (!k.ok) grade = emptyGrade(r.value?.runId ?? name, r.value?.status ?? null, "key file " + k.error);
      else if (v08) {
        const vs = violationsOf(r.value);
        const streams = vs.length === 0 ? null : rawStreamsOf(join(rawRoot, name));
        const records = vs.length === 0 ? null : falseRecordsOf(vs, streams);
        const denial = records === null || records.kept.length === 0 ? null : deniedViolations(records.kept, streams);
        grade = gradeRun(t.value, k.value, r.value, { rule: "v08", denial, ...(records === null ? {} : { records }) });
      } else grade = gradeRun(t.value, k.value, r.value);
    }
    if (grade.valid) counts.valid++;
    else counts.invalid++;
    if (grade.success) counts.success++;
    if (grade.valid && grade.status === "completed") {
      counts.scored++;
      counts.scoreSum += grade.score;
    }
    const out = join(runsDir, name, "grade.json");
    const bytes = gradeJson(grade);
    if (existsSync(out) && readFileSync(out, "utf8") === bytes) counts.unchanged++;
    else {
      writeFileSync(out, bytes);
      counts.written++;
    }
  }
  return counts;
}

export function summaryLine(batch, c) {
  const mean = c.scored === 0 ? "n/a" : (Math.round((c.scoreSum / c.scored) * 1000) / 1000).toFixed(3);
  return (
    "graded " + c.runs + " runs in batch " + batch + ": valid " + c.valid + ", invalid " + c.invalid + ", success " +
    c.success + ", mean score " + mean + " over " + c.scored + " valid completed runs (written " + c.written +
    ", unchanged " + c.unchanged + ")"
  );
}

function main(argv) {
  let batch = null;
  let root = null; // null: CCB_RESULTS_DIR and CCB_TASKS_DIR, else the benchmark folder
  let rawDir = null; // null: results/<batch>/raw
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--batch") batch = argv[++i] ?? null;
    else if (argv[i] === "--root") root = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--raw-dir") rawDir = resolve(argv[++i] ?? ".");
    else {
      process.stderr.write("grade.mjs: unknown argument " + argv[i] + "\n");
      return 2;
    }
  }
  if (batch === null || batch === "") {
    process.stderr.write("usage: node benchmarks/context-clock/graders/grade.mjs --batch <name> [--root <dir>] [--raw-dir <dir>]\n");
    return 2;
  }
  try {
    process.stdout.write(summaryLine(batch, gradeBatch(root, batch, { rawDir })) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write("grade.mjs: " + (err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
