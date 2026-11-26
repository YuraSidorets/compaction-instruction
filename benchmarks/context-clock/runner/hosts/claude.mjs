// Claude Code host adapter (CONTRACT.md "Host adapter"). One turn = one `claude -p` process with the prompt on stdin,
// `--output-format stream-json --verbose`, and `--resume <id>` after the first turn. A compaction is the prompt
// `/compact` through `claude -p --resume <id>`; it is confirmed only by a `system` line with subtype `compact_boundary`.
// Stream fields checked live with Claude Code 2.1.330 (tests/runner/fixtures/streams/claude-*.jsonl).
import { compactPrompt } from "../v05.mjs";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { quickOutput, runProcess, startProcess } from "../proc.mjs";
import { EMPTY_USAGE, addBlocks, channelTotal, emptyChannels, isContextModeTool, isLimitText, jsonLines } from "../stream.mjs";

export const HOST = "claude";
export const CLI = "claude";
export const COMPACT_MECHANISM = "/compact through claude -p --resume";
export const PERSISTENT_COMPACT_MECHANISM = "/compact as a user message on the stdin of one claude -p --input-format stream-json process";
export const SESSION_MODES = Object.freeze(["persistent", "resume"]);

let cachedVersion = null;
export function hostInfo() {
  if (cachedVersion === null) cachedVersion = (/^([\d.]+)/.exec(quickOutput(CLI, ["--version"])) ?? [null, "unknown"])[1];
  return { host: HOST, cliVersion: cachedVersion, canCompact: true, compactMechanism: COMPACT_MECHANISM, sessionModes: [...SESSION_MODES], defaultSessionMode: "persistent" };
}

/** Overlay arguments (EXPERIMENT-V03.md): the overlay plugin folder, and a settings file that disables the installed plugin. */
export function overlayArgs({ pluginDir, settingsPath, isolation = null } = {}) {
  const args = [];
  // v12 mode Z: pluginDir can be a list (the benchmark plugin and the standalone plugin), one --plugin-dir each.
  for (const d of [pluginDir].flat()) if (d) args.push("--plugin-dir", d);
  if (settingsPath) args.push("--settings", settingsPath);
  // EXPERIMENT-V11.md (plain arms O and I): no user settings and no MCP server outside --mcp-config (there is none).
  if (isolation?.settingSources) args.push("--setting-sources", isolation.settingSources);
  if (isolation?.strictMcpConfig) args.push("--strict-mcp-config");
  // v12 mode Z: the host debug log, the only host record of a PreCompact hook run at an automatic compaction.
  if (isolation?.debugFile) args.push("--debug-file", isolation.debugFile);
  return args;
}

export function buildArgs({ sessionId, model, allowedTools, disallowedTools, maxTurns, pluginDir, settingsPath, isolation = null }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...overlayArgs({ pluginDir, settingsPath, isolation })];
  if (model) args.push("--model", model);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (allowedTools && allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools && disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

function usageOf(u) {
  if (!u || typeof u !== "object") return { ...EMPTY_USAGE };
  const n = (v) => (typeof v === "number" ? v : null);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens),
  };
}

/** The snapshot channel of a hook event name ("SessionStart", "SessionStart:resume", "PostToolUse", ...). */
export function hookChannel(event) {
  const n = String(event ?? "");
  if (/^SessionStart/.test(n)) return "session_start";
  if (/^PostToolUse/.test(n)) return "hook_context";
  return "other";
}

/** The text a hook line delivers: hookSpecificOutput.additionalContext (and systemMessage) of its JSON output. */
function hookText(e) {
  const out = [];
  for (const raw of [e.output, e.stdout]) {
    if (typeof raw !== "string" || raw === "") continue;
    try {
      const j = JSON.parse(raw);
      const parts = [j?.hookSpecificOutput?.additionalContext, j?.systemMessage].filter((x) => typeof x === "string");
      out.push(parts.length > 0 ? parts.join(String.fromCharCode(10)) : raw);
    } catch {
      out.push(raw);
    }
    break; // output and stdout carry the same reply
  }
  return out;
}

/**
 * Parse one turn's stream-json text.
 * usage: the `result` line's usage, which is the sum over the turn. Without a result line: the sum of the assistant
 * messages, one count per message id (a message can span several lines).
 */
export function parseStream(text) {
  const { events } = jsonLines(text);
  let sessionId = null;
  let model = null;
  let result = null;
  let compactBoundary = false;
  let limitEvent = null;
  const calls = [];
  const byId = new Map();
  const perMessage = new Map();
  const channels = emptyChannels();
  // A hook_progress line repeats the text of the hook_response line with the same hook_id: count it only alone.
  const responded = new Set(events.filter((e) => e.type === "system" && e.subtype === "hook_response" && e.hook_id).map((e) => e.hook_id));
  for (const e of events) {
    if (typeof e.session_id === "string" && e.session_id !== "") sessionId = e.session_id;
    if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") model = e.model;
    if (e.type === "system" && e.subtype === "compact_boundary") compactBoundary = true;
    if (e.type === "rate_limit_event") {
      const st = String(e.rate_limit_info?.status ?? "");
      if (st !== "" && !st.startsWith("allowed")) limitEvent = st;
      continue;
    }
    if (e.type === "result") {
      result = e;
      continue;
    }
    if (e.type === "assistant") {
      const m = e.message ?? {};
      if (m.id && m.usage) perMessage.set(m.id, m.usage);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "tool_use") {
          const c = { name: String(b.name), isError: false, id: b.id ?? null, input: b.input ?? null };
          calls.push(c);
          if (b.id) byId.set(b.id, c);
        }
      }
      continue; // the model's own text is not a snapshot delivery
    }
    if (e.type === "system" && /^hook_/.test(String(e.subtype ?? ""))) {
      if (e.subtype !== "hook_response" && responded.has(e.hook_id)) continue;
      addBlocks(channels, hookChannel(e.hook_event ?? e.hook_name), hookText(e));
      continue;
    }
    if (e.type === "user") {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : [content]) {
        if (b && b.type === "tool_result") {
          const call = byId.get(b.tool_use_id);
          if (b.is_error === true && call) call.isError = true;
          addBlocks(channels, call && isContextModeTool(call.name) ? "tool_reply" : "other", b.content);
        } else {
          addBlocks(channels, "other", b);
        }
      }
      continue;
    }
    if (e.type === "system" && (e.subtype === "init" || e.subtype === "compact_boundary")) continue;
    addBlocks(channels, "other", e);
  }
  let usage;
  if (result?.usage) usage = usageOf(result.usage);
  else {
    usage = { ...EMPTY_USAGE };
    for (const u of perMessage.values()) {
      const x = usageOf(u);
      for (const k of Object.keys(usage)) usage[k] = usage[k] == null && x[k] == null ? null : (usage[k] ?? 0) + (x[k] ?? 0);
    }
  }
  const resultText = typeof result?.result === "string" ? result.result : "";
  const isError = result ? result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error")) : true;
  return {
    sessionId,
    model,
    resultText,
    usage,
    toolCalls: calls.map((c) => ({ name: c.name, isError: c.isError })),
    toolInputs: calls.map((c) => ({ name: c.name, input: c.input })),
    compactBoundary,
    clockSnapshots: channelTotal(channels),
    clockChannels: channels,
    hasResult: result !== null,
    isError,
    limitEvent,
    resultSubtype: result?.subtype ?? null,
  };
}

/** Tool inputs of a saved stream, for the integrity scan. */
export function toolInputs(text) {
  return parseStream(text).toolInputs;
}

function classify(proc, parsed) {
  const text = [proc.stderr, parsed.isError ? parsed.resultText : "", proc.spawnError ?? ""].join("\n");
  const rateLimited = parsed.limitEvent !== null || ((proc.exitCode !== 0 || parsed.isError) && isLimitText(text));
  return { rateLimited, errorText: (proc.spawnError ?? (parsed.isError ? parsed.resultText : proc.stderr) ?? "").slice(0, 500) };
}

/** One agent turn. Never throws for a host failure. */
export async function runTurn({ workspace, prompt, sessionId, env, model, allowedTools, disallowedTools, maxTurns, timeoutMs, rawDir, label, pluginDir, settingsPath, isolation = null, onLine, signal }) {
  const streamPath = join(rawDir, `${label}.jsonl`);
  const proc = await runProcess({
    cmd: CLI, args: buildArgs({ sessionId, model, allowedTools, disallowedTools, maxTurns, pluginDir, settingsPath, isolation }), cwd: workspace, env, input: prompt, timeoutMs,
    stdoutPath: streamPath, stderrPath: join(rawDir, `${label}.stderr.txt`), onLine, signal,
  });
  const parsed = parseStream(proc.stdout);
  const c = classify(proc, parsed);
  return {
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    aborted: proc.aborted === true,
    durationMs: proc.durationMs,
    sessionId: parsed.sessionId ?? sessionId ?? null,
    model: parsed.model,
    resultText: parsed.resultText,
    usage: parsed.usage,
    toolCalls: parsed.toolCalls,
    streamPath,
    compactBoundary: parsed.compactBoundary,
    clockSnapshots: parsed.clockSnapshots,
    clockChannels: parsed.clockChannels,
    isError: parsed.isError || proc.exitCode !== 0,
    hasResult: parsed.hasResult,
    resultSubtype: parsed.resultSubtype,
    rateLimited: c.rateLimited,
    errorText: c.errorText,
  };
}

/** A real host compaction: `/compact` on the resumed session. confirmed only with a compact_boundary line. */
export async function compact({ workspace, sessionId, env, model, timeoutMs, rawDir, label = "compact", pluginDir, settingsPath, isolation = null, onLine, signal, instruction = null }) {
  // EXPERIMENT-V05.md: mode S sends "/compact <instruction>"; every other mode sends the plain "/compact".
  const r = await runTurn({ workspace, prompt: compactPrompt(instruction), sessionId, env, model, allowedTools: [], maxTurns: 1, timeoutMs, rawDir, label, pluginDir, settingsPath, isolation, onLine, signal });
  return {
    confirmed: r.compactBoundary === true && !r.timedOut,
    mechanism: COMPACT_MECHANISM,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    streamPath: r.streamPath,
    timedOut: r.timedOut,
    aborted: r.aborted,
    usage: r.usage,
    clockSnapshots: r.clockSnapshots,
    clockChannels: r.clockChannels,
    sessionId: r.sessionId,
    rateLimited: r.rateLimited,
    errorText: r.errorText,
  };
}

// ---------- persistent session ----------
// One `claude -p --input-format stream-json --output-format stream-json --verbose` process for the whole run. Each turn
// is one user message line on stdin; the next turn starts only after the `result` line of the previous one. The
// SessionStart hook fires once at startup (and again after a compaction), as in a real long session.
// Limits of this mode: one process has one tool permission set (the stage tools) and no per-turn --max-turns, so the
// intro, checkpoint and final turns rely on the prompt "Do not call any tool"; their tool calls are recorded.

export function buildPersistentArgs({ model, allowedTools, pluginDir, settingsPath, isolation = null }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...overlayArgs({ pluginDir, settingsPath, isolation })];
  if (model) args.push("--model", model);
  if (allowedTools && allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
  return args;
}

/** One user message line of the stream-json input format. */
export function userLine(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

function isResultLine(line) {
  if (!line.includes("\"result\"")) return false;
  try {
    return JSON.parse(line).type === "result";
  } catch {
    return false;
  }
}

/**
 * Open a session. Returns null for sessionMode "resume" (the runner then calls runTurn/compact per turn).
 * `start` is injectable for tests: (args, { cwd, env, stderrPath }) -> a startProcess-like object.
 */
export function openSession({ workspace, env, model, allowedTools, rawDir, sessionMode = "persistent", start, pluginDir, settingsPath, isolation = null }) {
  if (sessionMode !== "persistent") return null;
  const launch = start ?? ((args, o) => startProcess({ cmd: CLI, args, ...o }));
  const proc = launch(buildPersistentArgs({ model, allowedTools, pluginDir, settingsPath, isolation }), { cwd: workspace, env, stderrPath: join(rawDir, "session.stderr.txt") });
  let pending = []; // lines since the last result line; startup lines go to the first turn
  let waiter = null;
  let dead = false;
  let exitInfo = null;
  let lineHook = null; // the onLine callback of the running turn (live limit counting)
  proc.onLine((line) => {
    pending.push(line);
    if (lineHook) {
      try {
        lineHook(line);
      } catch {
        // a monitor error must not break the session
      }
    }
    if (waiter && isResultLine(line)) {
      const w = waiter;
      waiter = null;
      const lines = pending;
      pending = [];
      w({ lines, result: true });
    }
  });
  proc.exited.then((x) => {
    exitInfo = x;
    dead = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      const lines = pending;
      pending = [];
      w({ lines, result: false, exited: x });
    }
  });

  async function exchange({ prompt, timeoutMs, onLine, signal }) {
    const started = Date.now();
    if (dead) {
      return { lines: [], result: false, exited: exitInfo ?? { exitCode: null, spawnError: "session process is not running" }, durationMs: 0, timedOut: false, aborted: false };
    }
    let timer;
    let onAbort;
    const got = new Promise((r) => (waiter = r));
    const timeout = new Promise((r) => (timer = setTimeout(() => r({ timeout: true }), timeoutMs ?? 600_000)));
    // A run limit aborts the turn: the runner stops this run's process tree only.
    const abort = new Promise((r) => {
      onAbort = () => r({ abort: true });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    lineHook = onLine ?? null;
    proc.write(userLine(prompt));
    const out = await Promise.race([got, timeout, abort]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    lineHook = null;
    if (out.timeout || out.abort) {
      waiter = null;
      dead = true;
      proc.kill();
      const lines = pending;
      pending = [];
      return { lines, result: false, timedOut: out.timeout === true, aborted: out.abort === true, durationMs: Date.now() - started };
    }
    return { ...out, timedOut: false, aborted: false, durationMs: Date.now() - started };
  }

  function toResult(x, label, sessionId) {
    const text = x.lines.join("\n") + (x.lines.length > 0 ? "\n" : "");
    const streamPath = join(rawDir, `${label}.jsonl`);
    writeFileSync(streamPath, text);
    const parsed = parseStream(text);
    const stderr = proc.stderrTail();
    const spawnError = x.exited?.spawnError ?? null;
    const exitCode = x.result ? (parsed.isError ? 1 : 0) : x.exited ? x.exited.exitCode : null;
    const isError = !x.result || parsed.isError;
    const errText = [stderr, parsed.isError ? parsed.resultText : "", spawnError ?? ""].join("\n");
    const rateLimited = parsed.limitEvent !== null || (isError && isLimitText(errText));
    let errorText = "";
    if (spawnError) errorText = spawnError;
    else if (x.timedOut) errorText = "turn timeout";
    else if (x.aborted) errorText = "stopped by a run limit";
    else if (!x.result) errorText = `session process ended (exit ${x.exited?.exitCode ?? "?"}) ${stderr.slice(-300)}`;
    else if (parsed.isError) errorText = parsed.resultText;
    return {
      exitCode, timedOut: x.timedOut, aborted: x.aborted === true, durationMs: x.durationMs, sessionId: parsed.sessionId ?? sessionId ?? null, model: parsed.model,
      resultText: parsed.resultText, usage: parsed.usage, toolCalls: parsed.toolCalls, streamPath,
      compactBoundary: parsed.compactBoundary, clockSnapshots: parsed.clockSnapshots, clockChannels: parsed.clockChannels,
      isError, hasResult: x.result, resultSubtype: parsed.resultSubtype, rateLimited, errorText: errorText.slice(0, 500),
    };
  }

  return {
    sessionMode: "persistent",
    pid: proc.pid,
    async runTurn({ prompt, label, timeoutMs, sessionId, onLine, signal }) {
      return toResult(await exchange({ prompt, timeoutMs, onLine, signal }), label, sessionId);
    },
    async compact({ label = "compact", timeoutMs, sessionId, onLine, signal, instruction = null }) {
      const r = toResult(await exchange({ prompt: compactPrompt(instruction), timeoutMs, onLine, signal }), label, sessionId);
      return {
        confirmed: r.compactBoundary === true && !r.timedOut, mechanism: PERSISTENT_COMPACT_MECHANISM, exitCode: r.exitCode, durationMs: r.durationMs,
        streamPath: r.streamPath, timedOut: r.timedOut, aborted: r.aborted, usage: r.usage, clockSnapshots: r.clockSnapshots, clockChannels: r.clockChannels,
        sessionId: r.sessionId, rateLimited: r.rateLimited, errorText: r.errorText,
      };
    },
    /** Close stdin and wait for the exit; kill the tree after graceMs. Lines after the last result go to session-tail.jsonl. */
    async close({ graceMs = 30_000 } = {}) {
      proc.endInput();
      if (!proc.isExited()) {
        let t;
        const ok = await Promise.race([proc.exited.then(() => true), new Promise((r) => (t = setTimeout(() => r(false), graceMs)))]);
        clearTimeout(t);
        if (!ok) proc.kill();
      }
      if (pending.length > 0) writeFileSync(join(rawDir, "session-tail.jsonl"), pending.join("\n") + "\n");
      return exitInfo;
    },
  };
}

// ---------- hook context from the session transcript ----------
// Checked live (Claude Code 2.1.330): the stream-json output shows SessionStart hook lines but no PostToolUse hook
// line. Claude Code writes every hook reply to its session transcript ~/.claude/projects/<encoded cwd>/<session>.jsonl
// as an attachment: { type: "hook_additional_context", hookEvent, content: [text] }, plus hook_success and
// hook_cancelled attachments. The hook_context channel is counted there.

/** The transcript folder name of a working folder: every character that is not a letter or digit becomes "-". */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Hook counts of a transcript text: hook_context snapshots and PostToolUse hook outcomes. */
export function parseTranscriptHooks(text) {
  const channels = emptyChannels();
  const postToolUse = { succeeded: 0, cancelled: 0, withContext: 0 };
  for (const e of jsonLines(text).events) {
    const a = e?.attachment;
    if (!a || typeof a.type !== "string") continue;
    const ev = String(a.hookEvent ?? a.hookName ?? "");
    if (!/^PostToolUse/.test(ev)) continue;
    if (a.type === "hook_success") postToolUse.succeeded += 1;
    if (a.type === "hook_cancelled") postToolUse.cancelled += 1;
    if (a.type === "hook_additional_context") {
      postToolUse.withContext += 1;
      addBlocks(channels, "hook_context", a.content);
    }
  }
  return { hookContext: channels.hook_context, postToolUse };
}

/**
 * Copy the session transcript to <rawDir>/transcript.jsonl and count the hook_context channel from it.
 * `home` is injectable for tests. source "unavailable" when the transcript is not found.
 */
export function hookTelemetry({ workspace, sessionId, rawDir, home = homedir() }) {
  const none = { source: "unavailable", hookContext: { count: 0, bytes: 0 }, postToolUse: { succeeded: 0, cancelled: 0, withContext: 0 } };
  if (!sessionId || !workspace) return none;
  const base = join(home, ".claude", "projects");
  let file = join(base, encodeProjectDir(workspace), `${sessionId}.jsonl`);
  if (!existsSync(file)) {
    const hit = existsSync(base) ? readdirSync(base).map((d) => join(base, d, `${sessionId}.jsonl`)).find((p) => existsSync(p)) : undefined;
    if (!hit) return none;
    file = hit;
  }
  try {
    const text = readFileSync(file, "utf8");
    if (rawDir) writeFileSync(join(rawDir, "transcript.jsonl"), text);
    return { source: "transcript", ...parseTranscriptHooks(text) };
  } catch {
    return none;
  }
}
