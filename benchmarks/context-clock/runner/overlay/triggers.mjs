// Context Clock v0.7 product triggers (EXPERIMENT-V07.md, "Arms"). The hook shim loads this file only when one of
// the variables below is set, so the v0.3 to v0.6 paths stay as they were.
//
// Arm N, CCB_STANDING_FILE: the text of the file goes after the product text of every SessionStart reply.
// Arm T, CCB_REMIND_FILE + CCB_REMIND_THRESHOLD: after a PostToolUse, the shim estimates the context size from the
//   usage of the last assistant record in the transcript. At or above the threshold, the text of the file goes after
//   the product text, one time between two compactions. The state is a marker file in CCB_DATA_DIR. A SessionStart
//   with source "compact" arms the reminder again.
// Arm P, CCB_PRECOMPACT_FILE: the text of the file goes to stdout of the PreCompact hook, after the product output.
// v0.8 arm U, CCB_PERIODIC_FILE (+ CCB_PERIODIC_EVERY, CCB_PERIODIC_OFFSET): the UserPromptSubmit hook counts each
//   prompt of the run in a counter file in CCB_DATA_DIR. On prompt n with n > offset and (n - offset) % every == 0,
//   the text of the file goes after the product text.
//
// Each function returns the reply to send and one log record. A failure sends the product reply unchanged and the
// record holds { error }. Log records never hold the text. Node built-ins only. Owner: overlay worker.
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;
const errText = (e) => String(e?.message ?? e).slice(0, 200);
const PLAIN_CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

/** At most this many bytes of a trigger text file are read. */
export const TEXT_FILE_MAX_BYTES = 65536;
/**
 * Claude Code caps additionalContext, plain stdout and PreCompact stdout at 10 000 characters for each hook
 * (hooks reference, code.claude.com/docs/en/hooks). A longer trigger text is refused, so that no text is cut silently.
 */
export const TEXT_MAX_CHARS = 10000;
export const PERIODIC_COUNTER = "ccb-periodic.json";
/** The transcript tail is read in windows of these sizes until a usage record is found. */
export const TAIL_WINDOWS = Object.freeze([256 * 1024, 1024 * 1024, 4 * 1024 * 1024]);
export const REMIND_MARKER = "ccb-reminder.json";

/** Reads a runner-written text file. Throws when it is not set, missing, a folder, empty or too long. */
export function readTriggerText(file, name) {
  if (typeof file !== "string" || file === "") throw new Error(`${name} is not set`);
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > TEXT_FILE_MAX_BYTES) throw new Error(`${name} is longer than ${TEXT_FILE_MAX_BYTES} bytes`);
    const buf = Buffer.alloc(size);
    const n = size === 0 ? 0 : readSync(fd, buf, 0, size, 0);
    const text = buf.subarray(0, n).toString("utf8").replace(/\s+$/, "");
    if (text.trim() === "") throw new Error(`${name} is empty`);
    if (text.length > TEXT_MAX_CHARS) throw new Error(`${name} has more than ${TEXT_MAX_CHARS} characters`);
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The reply with text added to hookSpecificOutput.additionalContext of a JSON reply, after a newline when context is
 * there already. An empty reply becomes a new JSON reply. Pure.
 * A plain text reply: SessionStart and UserPromptSubmit add plain stdout to the context, so the text follows after a
 * newline. For other
 * events plain stdout is not context, and the function throws (the caller keeps the product reply).
 */
export function appendContext(out, text, eventName) {
  const s = out.toString("utf8");
  if (s.trim() === "") {
    return Buffer.from(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }));
  }
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    if (PLAIN_CONTEXT_EVENTS.has(eventName)) return Buffer.from(s.replace(/\s+$/, "") + "\n" + text);
    throw new Error(`${eventName} reply is plain text`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${eventName} reply is not a JSON object`);
  const hso = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object" ? parsed.hookSpecificOutput : {};
  if (typeof hso.hookEventName !== "string") hso.hookEventName = eventName;
  else if (hso.hookEventName !== eventName) throw new Error(`reply names event ${hso.hookEventName}`);
  const prev = typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  hso.additionalContext = prev === "" ? text : prev + "\n" + text;
  parsed.hookSpecificOutput = hso;
  return Buffer.from(JSON.stringify(parsed));
}

// ---------- arm N ----------

/** Arm N. Every SessionStart reply gets the standing instruction after the product text. */
export function withStanding(out, env, payload, code) {
  const source = typeof payload.source === "string" ? payload.source : null;
  const rec = { channel: "standing", event: "SessionStart", source, delivered: false, bytes: 0 };
  if (code !== 0) return { out, record: { ...rec, hookExit: code } }; // Claude Code reads no context from a failed hook
  try {
    const text = readTriggerText(env.CCB_STANDING_FILE, "CCB_STANDING_FILE");
    return { out: appendContext(out, text, "SessionStart"), record: { ...rec, delivered: true, bytes: bytesOf(text) } };
  } catch (e) {
    return { out, record: { ...rec, error: errText(e) } };
  }
}

// ---------- arm T ----------

function usageSum(u) {
  if (!u || typeof u !== "object") return null;
  const n = (k) => (Number.isFinite(u[k]) && u[k] >= 0 ? u[k] : 0);
  const sum = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  return sum > 0 ? sum : null;
}

/** The usage estimate of the last main-chain assistant record in the given text lines, or null. Pure. */
export function lastUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "" || !line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a cut or broken line
    }
    if (!r || r.type !== "assistant" || r.isSidechain === true) continue;
    const msg = r.message;
    if (!msg || msg.model === "<synthetic>") continue;
    const estimate = usageSum(msg.usage);
    if (estimate === null) continue;
    return { estimate, timestamp: typeof r.timestamp === "string" ? r.timestamp : null };
  }
  return null;
}

/**
 * The context estimate from the tail of a transcript: { estimate, timestamp } or { reason }. Reads at most the last
 * TAIL_WINDOWS bytes. The first line of a window that does not start at the file start can be cut, so it is dropped.
 */
export function estimateContext(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return { reason: "no transcript_path" };
  if (!existsSync(transcriptPath)) return { reason: "transcript missing" };
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch (e) {
    return { reason: `transcript unreadable: ${e?.code ?? "open_failed"}` };
  }
  try {
    const size = fstatSync(fd).size;
    for (const win of TAIL_WINDOWS) {
      const len = Math.min(win, size);
      const buf = Buffer.alloc(len);
      const n = len === 0 ? 0 : readSync(fd, buf, 0, len, size - len);
      const lines = buf.subarray(0, n).toString("utf8").split("\n");
      if (size > len) lines.shift();
      const u = lastUsage(lines);
      if (u) return u;
      if (len === size) break;
    }
    return { reason: "no usage record" };
  } catch (e) {
    return { reason: `transcript unreadable: ${e?.code ?? "read_failed"}` };
  } finally {
    closeSync(fd);
  }
}

function markerPath(env) {
  const dir = env.CCB_DATA_DIR;
  if (typeof dir !== "string" || dir === "") throw new Error("CCB_DATA_DIR is not set");
  return path.join(dir, REMIND_MARKER);
}

function readMarker(file) {
  if (!existsSync(file)) return {};
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = JSON.parse(buf.subarray(0, n).toString("utf8"));
    return m && typeof m === "object" ? m : {};
  } finally {
    closeSync(fd);
  }
}

function writeMarker(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  renameSync(tmp, file);
}

/** The remind threshold in tokens. Throws when it is not a positive integer. */
export function thresholdOf(env) {
  const s = String(env.CCB_REMIND_THRESHOLD ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(s)) throw new Error("CCB_REMIND_THRESHOLD is not a positive integer");
  return Number(s);
}

/**
 * Arm T, SessionStart with source "compact": arms the reminder again. The marker keeps the time of the compaction, so
 * that a usage record written before it can never fire the reminder. Returns an error record or null.
 */
export function rearmReminder(env, now = new Date()) {
  try {
    writeMarker(markerPath(env), { fired: false, compactAt: now.toISOString() });
    return null;
  } catch (e) {
    return { channel: "reminder", event: "SessionStart", fired: false, error: errText(e) };
  }
}

/**
 * Arm T, PostToolUse. Returns { out, record }; record is null when nothing is to be logged (below the threshold, or
 * the reminder already fired since the last compaction).
 */
export function withReminder(out, env, payload, code, now = new Date()) {
  const rec = { channel: "reminder", event: "PostToolUse", fired: false, estimate: null, threshold: null };
  try {
    rec.threshold = thresholdOf(env);
    const file = markerPath(env);
    const marker = readMarker(file);
    if (marker.fired === true) return { out, record: null };
    const est = estimateContext(payload.transcript_path);
    if (!est.estimate) return { out, record: { ...rec, reason: est.reason } };
    rec.estimate = est.estimate;
    if (est.estimate < rec.threshold) return { out, record: null };
    // the last usage record is older than the last compaction: it measures the context before it
    if (typeof marker.compactAt === "string" && est.timestamp !== null && Date.parse(est.timestamp) <= Date.parse(marker.compactAt)) {
      return { out, record: null };
    }
    if (code !== 0) return { out, record: { ...rec, reason: "hook exit", hookExit: code } };
    const text = readTriggerText(env.CCB_REMIND_FILE, "CCB_REMIND_FILE");
    const next = appendContext(out, text, "PostToolUse");
    writeMarker(file, { ...marker, fired: true, firedAt: now.toISOString(), estimate: est.estimate });
    return { out: next, record: { ...rec, fired: true, tool: typeof payload.tool_name === "string" ? payload.tool_name : null, bytes: bytesOf(text) } };
  } catch (e) {
    return { out, record: { ...rec, error: errText(e) } };
  }
}

// ---------- arm P ----------

/**
 * Arm P. The PreCompact stdout: the product output first, then the instruction text after a newline. A failed product
 * hook (for example exit 2, which blocks the compaction) keeps its output and exit code.
 */
export function withPreCompact(out, env, payload, code) {
  const trigger = typeof payload.trigger === "string" ? payload.trigger : null;
  const rec = { channel: "precompact", event: "PreCompact", trigger, delivered: false, bytes: 0 };
  if (code !== 0) return { out, code, record: { ...rec, hookExit: code } };
  try {
    const text = readTriggerText(env.CCB_PRECOMPACT_FILE, "CCB_PRECOMPACT_FILE");
    const prev = out.toString("utf8").replace(/\s+$/, "");
    const next = Buffer.from(prev === "" ? text : prev + "\n" + text);
    return { out: next, code: 0, record: { ...rec, delivered: true, bytes: bytesOf(text) } };
  } catch (e) {
    return { out, code, record: { ...rec, error: errText(e) } };
  }
}

// ---------- arm U (v0.8) ----------

function intOf(env, key, dflt, min) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === "") return dflt;
  const s = String(raw).trim();
  if (!/^-?[0-9]+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) < min) throw new Error(`${key} is not an integer >= ${min}`);
  return Number(s);
}

/** The period of arm U: { every, offset }. every >= 1 (default 2), offset >= 0 (default 0). Throws on a bad value. */
export function periodOf(env) {
  return { every: intOf(env, "CCB_PERIODIC_EVERY", 2, 1), offset: intOf(env, "CCB_PERIODIC_OFFSET", 0, 0) };
}

/** True when prompt n gets the reminder. Pure. */
export function periodicFires(n, { every, offset }) {
  return n > offset && (n - offset) % every === 0;
}

/** The name of a slash command at the start of a prompt ("compact" for "/compact keep x"), or null. No other text. */
export function commandOf(prompt) {
  const m = typeof prompt === "string" ? /^\s*\/([A-Za-z0-9][\w:-]{0,63})(?=\s|$)/.exec(prompt) : null;
  return m ? m[1] : null;
}

/** Adds 1 to the prompt counter of the run and returns the new count. */
function nextCount(env) {
  const dir = env.CCB_DATA_DIR;
  if (typeof dir !== "string" || dir === "") throw new Error("CCB_DATA_DIR is not set");
  const file = path.join(dir, PERIODIC_COUNTER);
  const prev = readMarker(file);
  const n = (Number.isSafeInteger(prev.n) && prev.n >= 0 ? prev.n : 0) + 1;
  writeMarker(file, { n });
  return n;
}

/**
 * Arm U, UserPromptSubmit. Every prompt that reaches the hook counts, also one whose product hook fails. Returns
 * { out, record } with one record for each prompt.
 */
export function withPeriodic(out, env, payload, code) {
  const rec = { channel: "periodic", event: "UserPromptSubmit", n: null, fired: false, bytes: 0 };
  const command = commandOf(payload.prompt);
  if (command !== null) rec.command = command;
  try {
    rec.n = nextCount(env);
  } catch (e) {
    return { out, record: { ...rec, error: errText(e) } };
  }
  try {
    if (!periodicFires(rec.n, periodOf(env))) return { out, record: rec };
    if (code !== 0) return { out, record: { ...rec, hookExit: code } }; // exit 2 blocks the prompt: no context
    const text = readTriggerText(env.CCB_PERIODIC_FILE, "CCB_PERIODIC_FILE");
    return { out: appendContext(out, text, "UserPromptSubmit"), record: { ...rec, fired: true, bytes: bytesOf(text) } };
  } catch (e) {
    return { out, record: { ...rec, error: errText(e) } };
  }
}
