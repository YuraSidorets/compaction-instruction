#!/usr/bin/env node
// Context Clock v0.3 hook shim (EXPERIMENT-V03.md, "Plugin overlay"). Claude Code runs it in place of the real
// context-mode hook.mjs. Usage: node hook-shim.mjs <real hook.mjs> [args...]
//
// It runs the real hook with the same arguments, stdin and environment, and keeps its stdout, stderr and exit code.
// Modes B and C (CCB_FEEDBACK is not "placebo"): stdout passes unchanged. Mode D: for PostToolUse and
// PostToolUseFailure replies, a real snapshot in hookSpecificOutput.additionalContext gets the placebo. A SessionStart
// reply never changes. Fail closed in mode D: if a real snapshot could still pass, the shim removes the clock text
// and logs { error }. Log lines (CCB_SHIM_LOG) never hold the text. Node built-ins only. Owner: overlay worker.
//
// v0.5 adds CCB_RETURN_STATE "file" (arm H): the same path as "reference", with the agent's clock-state.md.
// v0.4 (EXPERIMENT-V04.md, "Returned state"): when CCB_RETURN_STATE is "committed" or "reference" and the input is a
// SessionStart with source "compact", the shim appends a [committed-state] block (state-block.mjs) after the product
// text and logs one state_block line. A failure sends the product reply unchanged and logs { error }.
// v0.7 (EXPERIMENT-V07.md, "Arms"): CCB_STANDING_FILE (arm N), CCB_REMIND_FILE with CCB_REMIND_THRESHOLD (arm T)
// and CCB_PRECOMPACT_FILE (arm P) start the triggers in triggers.mjs. v0.8 adds CCB_PERIODIC_FILE (arm U). Without these variables the output is as before.
// Without a product hook path in argv (the PreCompact entry that build.mjs adds), the shim runs no product hook.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substitutePlacebo, hasResidualClockText, hasClockFeedback } from "./placebo.mjs";
import { stripClock } from "./server-shim.mjs";

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;
const PLACEBO_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);

function readAll(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

function payloadOf(input) {
  try {
    const p = JSON.parse(input.toString("utf8"));
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

/** committed: arm F (v0.4). reference: arm G (v0.4). file: arm H (v0.5), the agent's own clock-state.md. */
const STATE_ARMS = new Set(["committed", "reference", "file"]);
/** At most this many bytes of a state file are read. The block keeps 2000 at most, so the rest is never needed. */
const STATE_FILE_READ_BYTES = 65536;

/**
 * The text of a state file for arms reference and file, or "" when the file is missing. Reads at most
 * STATE_FILE_READ_BYTES; truncated is true when the file is longer.
 */
async function readStateFile(file) {
  const { openSync, readSync, closeSync, existsSync } = await import("node:fs");
  if (!existsSync(file)) return { text: "", truncated: false };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(STATE_FILE_READ_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const truncated = n > STATE_FILE_READ_BYTES;
    return { text: buf.subarray(0, Math.min(n, STATE_FILE_READ_BYTES)).toString("utf8"), truncated };
  } finally {
    closeSync(fd);
  }
}

/** Arm F or G of v0.4 applies to this hook call: a SessionStart after a compaction, with CCB_RETURN_STATE set. */
export function stateArmOf(env, payload) {
  const arm = env.CCB_RETURN_STATE;
  return STATE_ARMS.has(arm) && payload.hook_event_name === "SessionStart" && payload.source === "compact" ? arm : null;
}

/**
 * The SessionStart reply with the block appended after the product text. Pure.
 * JSON reply: the block goes to hookSpecificOutput.additionalContext (after a newline when text is there already).
 * Empty reply: a new JSON reply that holds the block. Plain text reply (Claude Code adds it as context): the block
 * follows the text after a newline.
 */
export function appendToSessionStart(out, block) {
  const s = out.toString("utf8");
  if (s.trim() === "") {
    return Buffer.from(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } }));
  }
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return Buffer.from(s.replace(/\s+$/, "") + "\n" + block);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SessionStart reply is not a JSON object");
  const hso = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object" ? parsed.hookSpecificOutput : {};
  if (typeof hso.hookEventName !== "string") hso.hookEventName = "SessionStart";
  const prev = typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  hso.additionalContext = prev === "" ? block : prev + "\n" + block;
  parsed.hookSpecificOutput = hso;
  return Buffer.from(JSON.stringify(parsed));
}

/**
 * v0.4 arms F and G. Returns the reply to send and the state_block log record. On any failure the product reply goes
 * out unchanged and the record holds { error }: the runner then marks the run infra_failed.
 */
export async function withStateBlock(arm, out, env, code) {
  const rec = { channel: "state_block", event: "SessionStart", arm, delivered: false, bytes: 0, findings: 0, cut: false };
  if (code !== 0) return { out, record: { ...rec, hookExit: code } }; // Claude Code reads no context from a failed hook
  try {
    const S = await import("./state-block.mjs");
    let block;
    if (arm === "committed") {
      const state = S.readCommittedState(env.CCB_DATA_DIR);
      if (state === null) return { out, record: rec };
      const b = S.formatStateBlock(state);
      block = { text: b.text, bytes: b.bytes, findings: b.findings, cut: b.cut };
    } else {
      // reference (runner-written) and file (agent-written) share this path
      const file = env.CCB_STATE_FILE;
      if (typeof file !== "string" || file === "") throw new Error("CCB_STATE_FILE is not set");
      let read;
      try {
        read = await readStateFile(file);
      } catch (e) {
        // In arm file the agent owns the file (it may, for example, make a folder of that name). An unreadable file
        // is then a result of the run, not a shim failure: no block, no error, the code is logged.
        if (arm === "file") return { out, record: { ...rec, readError: String(e?.code ?? "read_failed") } };
        throw e;
      }
      if (read.text.trim() === "") return { out, record: rec };
      const b = S.wrapStateText(read.text);
      block = { text: b.text, bytes: b.bytes, findings: 0, cut: b.cut || read.truncated };
    }
    const next = appendToSessionStart(out, block.text);
    return { out: next, record: { ...rec, delivered: true, bytes: block.bytes, findings: block.findings, cut: block.cut } };
  } catch (e) {
    return { out, record: { ...rec, error: String(e?.message ?? e).slice(0, 200) } };
  }
}

/** Removes clock text from a string with no snapshot structure left (fail-closed path). */
function scrub(s) {
  return stripClock(s).split("[context-clock]").join("").split("[/context-clock]").join("");
}

/**
 * The stdout to deliver and the log record for one hook reply. Pure.
 * @param {string} event hook_event_name of the input
 * @param {Buffer} out stdout of the real hook
 * @param {boolean} placebo mode D
 */
export function transformHookOutput(event, out, placebo) {
  const channel = event === "SessionStart" ? "session_start" : "hook_context";
  const s = out.toString("utf8");
  let parsed = null;
  try {
    parsed = s.trim() === "" ? null : JSON.parse(s);
  } catch {
    parsed = null;
  }
  const ctx = parsed?.hookSpecificOutput?.additionalContext;
  const ctxText = typeof ctx === "string" ? ctx : null;

  if (!placebo || !PLACEBO_EVENTS.has(event)) {
    const real = ctxText !== null && hasClockFeedback(ctxText);
    const n = ctxText !== null && real ? bytesOf(ctxText) : 0;
    return { out, record: { channel, mode: real ? "real" : "none", originalBytes: n, deliveredBytes: n, replaced: 0 } };
  }

  // mode D, PostToolUse or PostToolUseFailure
  if (parsed === null) {
    if (!hasResidualClockText(s)) return { out, record: { channel, mode: "none", originalBytes: 0, deliveredBytes: 0, replaced: 0 } };
    return { out: Buffer.alloc(0), record: { channel, mode: "placebo", originalBytes: 0, deliveredBytes: 0, replaced: 0, error: "unparseable reply with clock text" } };
  }
  if (ctxText === null) {
    if (!hasResidualClockText(s)) return { out, record: { channel, mode: "none", originalBytes: 0, deliveredBytes: 0, replaced: 0 } };
    return { out: Buffer.from(JSON.stringify(scrubValue(parsed))), record: { channel, mode: "placebo", originalBytes: 0, deliveredBytes: 0, replaced: 0, error: "clock text outside additionalContext" } };
  }
  let r;
  try {
    r = substitutePlacebo(ctxText);
  } catch {
    r = null;
  }
  if (r === null || hasResidualClockText(r.text)) {
    const kept = scrub(ctxText);
    if (kept.trim() === "") delete parsed.hookSpecificOutput.additionalContext;
    else parsed.hookSpecificOutput.additionalContext = kept;
    const safe = scrubValue(parsed);
    return { out: Buffer.from(JSON.stringify(safe)), record: { channel, mode: "placebo", originalBytes: r ? r.originalBytes : 0, deliveredBytes: 0, replaced: 0, error: "residual clock text" } };
  }
  if (r.replaced === 0 && !hasResidualClockText(s)) return { out, record: { channel, mode: "none", originalBytes: 0, deliveredBytes: 0, replaced: 0 } };
  parsed.hookSpecificOutput.additionalContext = r.text;
  const json = JSON.stringify(parsed);
  if (hasResidualClockText(json)) {
    return { out: Buffer.from(JSON.stringify(scrubValue(parsed))), record: { channel, mode: "placebo", originalBytes: r.originalBytes, deliveredBytes: 0, replaced: r.replaced, error: "clock text outside additionalContext" } };
  }
  return { out: Buffer.from(json), record: { channel, mode: "placebo", originalBytes: r.originalBytes, deliveredBytes: r.placeboBytes, replaced: r.replaced } };
}

function scrubValue(v) {
  if (typeof v === "string") return hasResidualClockText(v) ? scrub(v) : v;
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubValue(x); return o; }
  return v;
}

/** Runs the real hook through the shim. Resolves with the exit code to use. */
export async function runHook({ argv, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  const placebo = env.CCB_FEEDBACK === "placebo";
  const input = await readAll(stdin);
  const payload = payloadOf(input);
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const [real, ...args] = argv;
  let out = Buffer.alloc(0);
  let code = 0;
  // v0.7: the PreCompact entry that build.mjs adds has no product hook. Then nothing runs: empty stdout, exit 0.
  if (real !== undefined) {
    const child = spawn(process.execPath, [real, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    // stderr is not part of the delivery: stream it through at once
    child.stderr.on("data", (c) => stderr.write(c));
    const outP = readAll(child.stdout);
    const errDone = new Promise((r) => child.stderr.on("end", r));
    code = await new Promise((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (c, sig) => resolve(c ?? (sig ? 1 : 0)));
    });
    out = await outP;
    await errDone;
  }
  // Context Clock v0.3: one line for each PreCompact call of the product hook, in every mode. bytes is the size of the
  // product stdout; sha256 is the hash of the trimmed stdout (null when it is empty).
  if (real !== undefined && event === "PreCompact" && env.CCB_SHIM_LOG) {
    const trimmed = out.toString("utf8").trim();
    const rec = { channel: "precompact_product", event, trigger: typeof payload.trigger === "string" ? payload.trigger : null, bytes: out.length,
      sha256: trimmed === "" ? null : createHash("sha256").update(trimmed, "utf8").digest("hex"), exitCode: code };
    try {
      appendFileSync(env.CCB_SHIM_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");
    } catch {
      // a log failure never breaks the hook
    }
  }
  let result;
  try {
    result = transformHookOutput(event, out, placebo);
  } catch {
    // never let an unchecked reply through in mode D
    result = placebo && PLACEBO_EVENTS.has(event) && hasResidualClockText(out.toString("utf8"))
      ? { out: Buffer.alloc(0), record: { channel: "hook_context", mode: "placebo", originalBytes: 0, deliveredBytes: 0, replaced: 0, error: "transform failed" } }
      : { out, record: { channel: event === "SessionStart" ? "session_start" : "hook_context", mode: "none", originalBytes: 0, deliveredBytes: 0, replaced: 0, error: "transform failed" } };
  }
  if (env.CCB_SHIM_LOG && (event === "SessionStart" || PLACEBO_EVENTS.has(event))) {
    try {
      appendFileSync(env.CCB_SHIM_LOG, JSON.stringify({ t: new Date().toISOString(), event, ...result.record }) + "\n");
    } catch {
      // a log failure never breaks the hook
    }
  }
  // v0.4: with CCB_RETURN_STATE unset, or for any other reply, nothing below runs and the output stays as above.
  const arm = stateArmOf(env, payload);
  if (arm !== null) {
    const s = await withStateBlock(arm, result.out, env, code);
    result = { ...result, out: s.out };
    if (env.CCB_SHIM_LOG) {
      try {
        appendFileSync(env.CCB_SHIM_LOG, JSON.stringify({ t: new Date().toISOString(), ...s.record }) + "\n");
      } catch {
        // a log failure never breaks the hook
      }
    }
  }
  // v0.7 and v0.8: with CCB_STANDING_FILE, CCB_REMIND_FILE, CCB_REMIND_THRESHOLD, CCB_PRECOMPACT_FILE and
  // CCB_PERIODIC_FILE unset, nothing below runs.
  let exit = code;
  const t = triggersFor(env, event, payload);
  if (t.length > 0) {
    const records = [];
    try {
      const T = await import("./triggers.mjs");
      for (const kind of t) {
        if (kind === "standing") {
          const s = T.withStanding(result.out, env, payload, code);
          result = { ...result, out: s.out };
          records.push(s.record);
        } else if (kind === "rearm") {
          const r = T.rearmReminder(env);
          if (r) records.push(r);
        } else if (kind === "reminder") {
          const s = T.withReminder(result.out, env, payload, code);
          result = { ...result, out: s.out };
          if (s.record) records.push(s.record);
        } else if (kind === "periodic") {
          const s = T.withPeriodic(result.out, env, payload, code);
          result = { ...result, out: s.out };
          records.push(s.record);
        } else if (kind === "precompact") {
          const s = T.withPreCompact(result.out, env, payload, code);
          result = { ...result, out: s.out };
          exit = s.code;
          records.push(s.record);
        }
      }
    } catch (e) {
      records.push({ channel: "triggers", event, error: String(e?.message ?? e).slice(0, 200) });
    }
    if (env.CCB_SHIM_LOG) {
      for (const rec of records) {
        try {
          appendFileSync(env.CCB_SHIM_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");
        } catch {
          // a log failure never breaks the hook
        }
      }
    }
  }
  if (result.out.length > 0) await new Promise((r) => stdout.write(result.out, r));
  return exit;
}

/** The v0.7 trigger steps for this hook call, in order. Empty when no v0.7 variable is set. Pure. */
export function triggersFor(env, event, payload) {
  const steps = [];
  const set = (k) => typeof env[k] === "string" && env[k] !== "";
  const remind = set("CCB_REMIND_FILE") || set("CCB_REMIND_THRESHOLD");
  if (event === "SessionStart") {
    if (set("CCB_STANDING_FILE")) steps.push("standing");
    if (remind && payload.source === "compact") steps.push("rearm");
  } else if (event === "PostToolUse") {
    if (remind) steps.push("reminder");
  } else if (event === "PreCompact") {
    if (set("CCB_PRECOMPACT_FILE")) steps.push("precompact");
  } else if (event === "UserPromptSubmit") {
    if (set("CCB_PERIODIC_FILE")) steps.push("periodic");
  }
  return steps;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook({ argv: process.argv.slice(2) }).then((code) => process.exit(code), () => process.exit(1));
}
