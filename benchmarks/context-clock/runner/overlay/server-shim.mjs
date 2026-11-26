#!/usr/bin/env node
// Context Clock v0.3 MCP server shim (EXPERIMENT-V03.md, "Plugin overlay"). A stdio proxy between Claude Code and the
// real context-mode server.mjs. Usage: node server-shim.mjs <real server.mjs> [args...]
//
// Modes: CCB_FEEDBACK=placebo is mode D. Any other value is modes B and C: every byte passes through unchanged, and a
// copy of the server output is parsed only to write the log. In mode D, each text block of a tools/call result that
// holds a real snapshot gets the placebo. If a real snapshot could still pass, the shim drops the feedback instead and
// logs { error } (fail closed). Log lines (CCB_SHIM_LOG) never hold the text. Node built-ins only. Owner: overlay worker.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substitutePlacebo, hasResidualClockText, hasClockFeedback } from "./placebo.mjs";

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;

/** Splits a byte stream into lines. The callback gets each complete line without its "\n" (a Buffer). */
export function lineSplitter(onLine) {
  let pending = [];
  return {
    push(chunk) {
      let at = 0;
      for (;;) {
        const nl = chunk.indexOf(10, at);
        if (nl < 0) break;
        pending.push(chunk.subarray(at, nl));
        onLine(Buffer.concat(pending));
        pending = [];
        at = nl + 1;
      }
      if (at < chunk.length) pending.push(chunk.subarray(at));
    },
    /** The bytes after the last "\n", or null. */
    rest() {
      if (pending.length === 0) return null;
      const b = Buffer.concat(pending);
      pending = [];
      return b;
    },
  };
}

function textBlocks(msg) {
  const content = msg?.result?.content;
  return Array.isArray(content) ? content.filter((b) => b && b.type === "text" && typeof b.text === "string") : [];
}

/**
 * Applies mode D to one tools/call response message (parsed JSON). Mutates and returns a log record.
 * Fail closed: when substitution leaves clock text, every block that still holds it loses its clock text by removal
 * of the whole block (when it is not the first block) or by blanking of the residual tag lines.
 */
export function placeboMessage(msg) {
  let originalBytes = 0;
  let deliveredBytes = 0;
  let replaced = 0;
  let error = null;
  const content = msg?.result?.content;
  if (!Array.isArray(content)) return { originalBytes, deliveredBytes, replaced, error, feedback: false };
  let feedback = false;
  const keep = [];
  content.forEach((b, i) => {
    if (!(b && b.type === "text" && typeof b.text === "string")) { keep.push(b); return; }
    let r;
    try {
      r = substitutePlacebo(b.text);
    } catch (e) {
      r = null;
      error = "substitution failed";
    }
    if (r && r.replaced > 0) {
      feedback = true;
      replaced += r.replaced;
      originalBytes += r.originalBytes;
      deliveredBytes += r.placeboBytes;
      b.text = r.text;
    }
    const residual = r === null ? hasResidualClockText(b.text) : hasResidualClockText(r.text);
    if (residual) {
      feedback = true;
      error = error ?? "residual clock text";
      if (i > 0) return; // a feedback block: drop it
      b.text = stripClock(b.text);
    }
    keep.push(b);
  });
  msg.result.content = keep;
  return { originalBytes, deliveredBytes, replaced, error, feedback };
}

/** Removes every line that holds a clock tag and every line between an open and a close line. */
export function stripClock(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.includes("[context-clock]")) { inBlock = !line.includes(" | model delivery not confirmed"); continue; }
    if (line.includes("[/context-clock]")) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

/** Removes clock text from every string inside a parsed JSON value (fail-closed path). */
export function scrubDeep(v) {
  if (typeof v === "string") {
    if (!hasResidualClockText(v)) return v;
    return stripClock(v).split("[context-clock]").join("").split("[/context-clock]").join("");
  }
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x); return o; }
  return v;
}

function logLine(env, rec) {
  if (!env.CCB_SHIM_LOG) return;
  try {
    appendFileSync(env.CCB_SHIM_LOG, JSON.stringify(rec) + "\n");
  } catch {
    // a log failure never breaks the session
  }
}

/** Runs the proxy. Resolves with the exit code to use. */
export function runProxy({ argv, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  const placebo = env.CCB_FEEDBACK === "placebo";
  const [real, ...args] = argv;
  const child = spawn(process.execPath, [real, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const callIds = new Map(); // JSON-RPC id (as JSON text) -> tool name
  const t = () => new Date().toISOString();

  // client -> server: bytes pass unchanged; a copy is parsed to learn which ids are tools/call
  const inLines = lineSplitter((line) => {
    try {
      const m = JSON.parse(line.toString("utf8"));
      for (const x of Array.isArray(m) ? m : [m]) {
        if (x && x.method === "tools/call" && x.id !== undefined) callIds.set(JSON.stringify(x.id), x.params?.name ?? "");
      }
    } catch {
      // not JSON: forward only
    }
  });
  stdin.on("data", (c) => { inLines.push(c); child.stdin.write(c); });
  stdin.on("end", () => child.stdin.end());
  stdin.on("error", () => child.stdin.end());
  child.stdin.on("error", () => {}); // the child exited first; its exit decides the code

  const record = (event, mode, originalBytes, deliveredBytes, replaced, error) => {
    const rec = { t: t(), channel: "mcp_reply", event, mode, originalBytes, deliveredBytes, replaced };
    if (error) rec.error = error;
    logLine(env, rec);
  };

  /** Handles one complete server line in mode D. Returns the bytes to send (with "\n"), or null to drop it. */
  const handleD = (line) => {
    const s = line.toString("utf8");
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      if (hasResidualClockText(s)) { record("unparsed", "placebo", 0, 0, 0, "unparseable line with clock text"); return null; }
      return Buffer.concat([line, Buffer.from("\n")]);
    }
    const key = msg && msg.id !== undefined ? JSON.stringify(msg.id) : null;
    const tool = key !== null && callIds.has(key) ? callIds.get(key) : null;
    if (tool === null) {
      if (hasResidualClockText(s)) {
        // clock text outside a tools/call result: never let it through
        record("unmatched", "placebo", 0, 0, 0, "clock text outside a tools/call result");
        return Buffer.from(JSON.stringify(scrubDeep(msg)) + "\n");
      }
      return Buffer.concat([line, Buffer.from("\n")]);
    }
    callIds.delete(key);
    let r;
    try {
      r = placeboMessage(msg);
    } catch {
      r = null;
    }
    if (r === null) {
      record(tool, "placebo", 0, 0, 0, "placebo failed");
      if (msg?.result && Array.isArray(msg.result.content)) msg.result.content = msg.result.content.slice(0, 1);
      return Buffer.from(JSON.stringify(scrubDeep(msg)) + "\n");
    }
    const out = JSON.stringify(msg);
    if (hasResidualClockText(out)) {
      record(tool, "placebo", r.originalBytes, 0, r.replaced, "residual clock text after placebo");
      return Buffer.from(JSON.stringify(scrubDeep(msg)) + "\n");
    }
    record(tool, r.feedback ? "placebo" : "none", r.originalBytes, r.deliveredBytes, r.replaced, r.error);
    return Buffer.from(out + "\n");
  };

  /** Logs one server line in modes B and C. The bytes were already sent. */
  const observe = (line) => {
    let msg;
    try {
      msg = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const key = msg && msg.id !== undefined ? JSON.stringify(msg.id) : null;
    if (key === null || !callIds.has(key)) return;
    const tool = callIds.get(key);
    callIds.delete(key);
    const blocks = textBlocks(msg);
    const fb = blocks.filter((b) => hasClockFeedback(b.text));
    const bytes = fb.reduce((n, b) => n + bytesOf(b.text), 0);
    record(tool, fb.length > 0 ? "real" : "none", bytes, bytes, 0, null);
  };

  const outLines = lineSplitter((line) => {
    if (!placebo) { observe(line); return; }
    const b = handleD(line);
    if (b !== null) stdout.write(b);
  });
  child.stdout.on("data", (c) => {
    if (!placebo) stdout.write(c);
    outLines.push(c);
  });
  child.stderr.on("data", (c) => stderr.write(c));

  return new Promise((resolve) => {
    let code = null;
    let outDone = false;
    let errDone = false;
    let exited = false;
    const finish = () => {
      if (!(outDone && errDone && exited)) return;
      const rest = outLines.rest();
      if (rest !== null && placebo) {
        // a last line with no "\n": handle it the same way, without adding a newline
        const b = handleD(rest);
        if (b !== null) stdout.write(b.subarray(0, b.length - 1));
      }
      resolve(code);
    };
    child.stdout.on("end", () => { outDone = true; finish(); });
    child.stderr.on("end", () => { errDone = true; finish(); });
    child.on("error", () => { outDone = errDone = exited = true; code = 1; finish(); });
    child.on("exit", (c, sig) => { exited = true; code = c ?? (sig ? 1 : 0); finish(); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProxy({ argv: process.argv.slice(2) }).then((code) => {
    process.stdout.write("", () => process.exit(code));
  });
}
