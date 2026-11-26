// Mock host (CONTRACT.md "Host adapter", fixtures/README.md "Mock host convention"). It makes no model call.
//
// Replay: when <mockDir>/<taskId>__<mode>__r<rep>.json exists (mockDir = CCB_MOCK_DIR or fixtures/mock/runs), each
// runTurn/compact call returns the recorded `result` of the matching turn (intro, stage N, checkpoint, compact after
// stage N, final) with the recorded durationMs. A turn's optional `stream` events go to the turn's stream file, so the
// runner's integrity scan sees them. Every retry attempt replays the same file. The runner passes the run identity in
// the `mock` option of each call; no other host reads it.
//
// Synthetic: without a transcript, each turn writes a synthetic stream in the Claude Code stream-json format and parses
// it with the Claude parser, so the parse path is the real one.
// - a stage prompt: one Read per listed file and one `node feed.mjs <name>` Bash call per listed output; a call is an
//   error when the material is not in the workspace at that moment. A feed above 6000 bytes adds a ctx_search call.
// - with CTX_CLOCK=1 and feedback on (mode C), the ctx_search result holds one [context-clock] block.
// - a question prompt: one fenced json block; choice = first option, set = [first option], int = 0, bool = false.
// - compact(): a synthetic compact_boundary line. A mock compaction is a test double, never a host result.
// - v0.4 (EXPERIMENT-V04.md): a stage prompt that names ctx_clock_commit (modes E and F) adds one ctx_clock_status call
//   and one ctx_clock_commit call with the current revision. opts.commitRejectStages (stage numbers) rejects that commit
//   with opts.commitRejectCode (default REVISION_CONFLICT). With CCB_RETURN_STATE set, compact() sends a state block in
//   the SessionStart:compact reply and writes one state_block line to the shim log: arm committed (F) delivers the
//   last mock commit of the session, arm reference (G) delivers the text of CCB_STATE_FILE.
// - v0.5 (EXPERIMENT-V05.md): a stage prompt that names clock-state.md (mode H) adds one Write call that writes
//   <workspace>/clock-state.md (opts.stateFileSkipStages: stage numbers without the call). Arm file (H) delivers the
//   text of CCB_STATE_FILE like arm reference. compact() takes `instruction` (mode S) and reports each compaction to
//   opts.onCompact({ label, instruction, prompt }).
// - v0.6 (EXPERIMENT-V06.md): the stage prompts of modes J, K and L name clock-state.md where the paragraph applies, so
//   the same Write call runs. Each result line carries total_cost_usd as the running total of the mock session (as
//   Claude Code reports it): 0.001 for each turn, 0.0005 for each compaction (opts.noCost: no total). The
//   compact_boundary line carries compact_metadata.pre_tokens = 1000 * tick of the session (opts.noPreTokens: none).
// - v0.7 (EXPERIMENT-V07.md): the mock of the trigger hooks writes their shim log lines.
//   Mode N (CCB_STANDING_FILE): one "standing" line at the first turn of a session and one at each compaction. The
//   agent writes clock-state.md in each stage turn with an odd stage number.
//   Mode T (CCB_REMIND_FILE, CCB_REMIND_THRESHOLD): the context estimate is MOCK_ESTIMATE_PER_TURN times the turns since
//   the session start or the last compaction. In the first stage turn where it reaches the threshold, one "reminder"
//   line, and the agent writes clock-state.md in that turn. It arms again after the next compaction.
//   Mode P (CCB_PRECOMPACT_FILE): one "precompact" line at each compaction (the runner sends the plain /compact).
//   opts.stateFileSkipStages applies to these writes too.
// - v0.8 (EXPERIMENT-V08.md): mode U (CCB_PERIODIC_FILE, CCB_PERIODIC_EVERY, CCB_PERIODIC_OFFSET): the mock hook counts
//   the user messages of the session (a compaction too with opts.periodicCountsCompact) and writes one "periodic" line
//   for each one, fired for n > offset with (n - offset) % every == 0. In a fired stage turn the agent writes
//   clock-state.md. Mode Q writes the "precompact" line of mode P.
// - v0.9 (EXPERIMENT-V09.md): the "precompact" line has trigger "manual" in compact(). With opts.autoCompactAt (tokens)
//   the mock simulates the automatic compaction of the host: the context of a session grows by opts.contextPerTurn
//   (default 20000) with each turn; in the turn where it reaches autoCompactAt, the stream gets a compact_boundary line
//   with trigger "auto" and pre_tokens, the hooks log a "precompact" line with trigger "auto" (CCB_PRECOMPACT_FILE) and a
//   "standing" line (CCB_STANDING_FILE), and the context drops to opts.contextAfterCompact (default 10000). The last
//   assistant message of each turn then reports the context in its usage (input_tokens).
// Durations are fixed numbers, never clock time, so mock records give the same grade, summary and report every time.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchPaths } from "../../paths.mjs";
import { parseStream } from "./claude.mjs";
import { CLOCK_STATE_FILE_NAME, compactPrompt } from "../v05.mjs";
import { CONFIGS_DIR, PRODUCT_COMPACT_TEXT_FILE } from "../workspace.mjs";
import { plainPreCompact } from "../plain/precompact-hook.mjs";

/**
 * EXPERIMENT-V11.md: the parts of the init line. A plain run (CCB_PLAIN) has only the benchmark plugin and no MCP
 * server; any other run has the Context Mode plugin and its MCP server.
 */
/**
 * v12 mode Z: the plugins of the folders after the first one (the benchmark plugin is the first --plugin-dir):
 * [{ name, dir, preCompact: [command] }].
 */
function extraPlugins(pluginDir) {
  const out = [];
  for (const dir of [pluginDir].flat().slice(1)) {
    if (!dir) continue;
    let manifest = null;
    let hooks = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      hooks = JSON.parse(readFileSync(join(dir, typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json"), "utf8"));
    } catch {
      // a folder without a manifest or hooks file adds no plugin
    }
    if (!manifest?.name) continue;
    const preCompact = (hooks?.hooks?.PreCompact ?? []).flatMap((e) => (e?.hooks ?? []).map((h) => h.command)).filter((c) => typeof c === "string");
    out.push({ name: manifest.name, dir, preCompact });
  }
  return out;
}

/**
 * v12 mode Z: run the PreCompact commands of the extra plugins as the host does (CLAUDE_PLUGIN_ROOT set, the run
 * environment) and build the user message that Claude Code 2.1.331 writes after a manual compaction:
 * "<local-command-stdout>Compacted PreCompact [<command>] completed successfully: <stdout></local-command-stdout>".
 */
function compactedMessage(plugins, env, workspace, sessionId) {
  const parts = [];
  for (const p of plugins) {
    for (const command of p.preCompact) {
      const r = spawnSync(command.split("${CLAUDE_PLUGIN_ROOT}").join(p.dir), { shell: true, cwd: workspace ?? undefined, env: { ...(env ?? process.env), CLAUDE_PLUGIN_ROOT: p.dir }, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreCompact", trigger: "manual" }) });
      const out = String(r.stdout ?? "");
      if (r.status === 0 && out !== "") parts.push(`PreCompact [${command}] completed successfully: ${out}`);
    }
  }
  return { type: "user", message: { role: "user", content: `<local-command-stdout>Compacted ${parts.join("\n")}</local-command-stdout>` }, session_id: sessionId };
}

/** v12: the line that Claude Code 2.1.331 writes to its debug log (--debug-file) for each PreCompact hook run. */
function debugRuns(isolation, plugins, trigger) {
  if (!isolation?.debugFile) return;
  for (const p of plugins) for (const command of p.preCompact) appendFileSync(isolation.debugFile, `2026-01-01T00:00:00.000Z [DEBUG] PreCompact:${trigger} [${command}] completed with status 0\n`);
}

function initParts(env, extra = null, plugins = []) {
  // The host always lists its built-in plugins (cc-plugin-*). opts.initExtra adds { plugins, mcp_servers } (tests).
  const builtin = [{ name: "cc-plugin-telemetry", path: "<builtin>" }];
  const more = (k) => (Array.isArray(extra?.[k]) ? extra[k] : []);
  const loaded = plugins.map((p) => ({ name: p.name, path: "<plugin>" }));
  if (env?.CCB_PLAIN) return { tools: ["Bash", "Read", "ToolSearch"], mcp_servers: [...more("mcp_servers")], plugins: [{ name: "ccb-plain", path: "<plain>" }, ...loaded, ...builtin, ...more("plugins")], skills: [], slash_commands: ["compact"] };
  return {
    tools: ["Bash", "Read", "ToolSearch", "mcp__plugin_context-mode_context-mode__ctx_execute"], mcp_servers: [{ name: "plugin:context-mode:context-mode", status: "connected" }, ...more("mcp_servers")],
    plugins: [{ name: "context-mode", path: "<overlay>" }, ...builtin, ...more("plugins")], skills: ["context-mode:context-mode"], slash_commands: ["compact", "context-mode:ctx-stats"],
  };
}

/** The PreCompact log line of the overlay (CCB_PRECOMPACT_FILE), or of the plain hook of arm I (CCB_PLAIN). */
function preCompactLine(env, trigger, bytesOf) {
  if (!env?.CCB_PRECOMPACT_FILE) return null;
  if (env.CCB_PLAIN) return plainPreCompact(env.CCB_PRECOMPACT_FILE, JSON.stringify({ trigger })).record;
  return { channel: "precompact", event: "PreCompact", trigger, delivered: true, bytes: bytesOf(env.CCB_PRECOMPACT_FILE) };
}

const PREFIX = "mcp__plugin_context-mode_context-mode__";
export const MOCK_STATE_OPEN = "[committed-state]";
export const MOCK_STATE_CLOSE = "[/committed-state]";
const STATE_ARMS = Object.freeze({ committed: "committed", reference: "reference", file: "file" });
export const MOCK_MECHANISM = "mock: synthetic compact_boundary line, no host";
const EMPTY = Object.freeze({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });
/** v0.7 mock of the mode T context estimate: tokens added for each turn since the session start or the last compaction. */
export const MOCK_ESTIMATE_PER_TURN = 18000;

function fileBytes(file) {
  try {
    return file && existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

function sid(seed) {
  return "mock-" + createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function questionsOf(prompt) {
  const qs = [];
  for (const line of prompt.split("\n")) {
    const m = /^- (\S+) \[(choice|set|int|bool)\] (.*?)(?: Options: (.*))?$/.exec(line);
    if (m) qs.push({ id: m[1], type: m[2], options: m[4] ? m[4].split(" | ") : [] });
  }
  return qs;
}

function answerOf(q) {
  if (q.type === "set") return q.options.length > 0 ? [q.options[0]] : [];
  if (q.type === "int") return 0;
  if (q.type === "bool") return false;
  return q.options[0] ?? "";
}

/** "intro" | "stage-2" | "checkpoint-2" | "compact-2" | "final" -> { kind, stage } */
function parseLabel(label) {
  const m = /^(intro|stage|checkpoint|compact|final)(?:-(\d+)(?:-\d+)?)?$/.exec(String(label));
  return m ? { kind: m[1], stage: m[2] ? Number(m[2]) : null } : { kind: null, stage: null };
}

/** Claude-format stream text from transcript events [{ type: "tool_use", name, input }, ...]. */
function streamText(events, sessionId) {
  const content = [];
  const results = [];
  events.forEach((e, i) => {
    if (e?.type !== "tool_use") return;
    const id = `toolu_fixture_${i}`;
    content.push({ type: "tool_use", id, name: e.name, input: e.input ?? {} });
    results.push({ type: "tool_result", tool_use_id: id, is_error: e.isError === true, content: e.output ?? "" });
  });
  const lines = [{ type: "system", subtype: "init", session_id: sessionId, model: "mock-model" }];
  if (content.length > 0) {
    lines.push({ type: "assistant", message: { id: "msg_fixture", role: "assistant", content }, session_id: sessionId });
    lines.push({ type: "user", message: { role: "user", content: results }, session_id: sessionId });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** A placebo of the same byte length per line (EXPERIMENT-V03.md shape; the real one is runner/overlay/placebo.mjs). */
export function mockPlacebo(text) {
  return text.split("\n").map((line) => {
    const open = line.startsWith("[/") ? "[/context-note]" : "[context-note]";
    const base = line.startsWith("[") ? open : "pad:";
    return (base + " ref:" + "0".repeat(Math.max(0, line.length))).slice(0, line.length).padEnd(line.length, "0");
  }).join("\n");
}

/** Append one JSON line to a log file named by an environment variable (the overlay log format). */
function logLine(file, obj) {
  if (!file) return;
  appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
}

/** Emit stream lines to onLine; stop at the first line after which the signal is aborted. Returns the lines kept. */
function emit(lines, onLine, signal) {
  const kept = [];
  for (const l of lines) {
    if (signal?.aborted) break;
    kept.push(l);
    onLine?.(JSON.stringify(l));
  }
  return kept;
}

export function createMockHost(opts = {}) {
  const delayMs = opts.delayMs ?? 0;
  const counters = new Map();
  const behave = opts.behave ?? (() => null);
  const mockDir = opts.mockDir === undefined ? benchPaths().mockDir : opts.mockDir;
  const cache = new Map();
  // v0.4: per mock session, the revision and the last committed state ({ summary, findings: [text] }).
  const commits = new Map();
  // v0.6: per mock session, the running cost total (Claude Code reports total_cost_usd as a session total).
  const costTotals = new Map();
  // v0.7: per mock session, the trigger state ({ started, sinceCompact, fired }).
  const triggerStates = new Map();
  // v0.9: per mock session, the simulated context size (only with opts.autoCompactAt).
  const contextSizes = new Map();
  const triggerState = (id) => {
    if (!triggerStates.has(id)) triggerStates.set(id, { started: false, sinceCompact: 0, fired: false, messages: 0 });
    return triggerStates.get(id);
  };
  const addCost = (id, usd) => {
    const t = Math.round(((costTotals.get(id) ?? 0) + usd) * 1e6) / 1e6;
    costTotals.set(id, t);
    return opts.noCost ? {} : { total_cost_usd: t };
  };

  // v0.8 mode U: one user message seen by the UserPromptSubmit hook. Returns true when the reminder fired.
  function periodicHook(env, trig) {
    if (!env?.CCB_PERIODIC_FILE) return false;
    trig.messages++;
    const n = trig.messages;
    const every = Number(env.CCB_PERIODIC_EVERY ?? 2);
    const offset = Number(env.CCB_PERIODIC_OFFSET ?? 0);
    const fired = n > offset && (n - offset) % every === 0;
    logLine(env?.CCB_SHIM_LOG, { channel: "periodic", event: "UserPromptSubmit", n, fired, bytes: fired ? fileBytes(env.CCB_PERIODIC_FILE) : 0 });
    return fired;
  }

  function transcript(mock) {
    if (!mockDir || !mock?.taskId) return null;
    const file = join(mockDir, `${mock.taskId}__${mock.mode}__r${mock.rep}.json`);
    if (!cache.has(file)) cache.set(file, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
    return cache.get(file);
  }

  function recordedTurn(tr, label) {
    const { kind, stage } = parseLabel(label);
    return tr.turns.find((t) => t.kind === kind && (kind === "stage" ? t.stage === stage : kind === "compact" ? t.afterStage === stage : true)) ?? null;
  }

  function replayTurn(tr, { label, rawDir, sessionId }) {
    const t = recordedTurn(tr, label);
    if (!t) {
      return { exitCode: 1, timedOut: false, durationMs: 0, sessionId: sessionId ?? null, resultText: "", usage: { ...EMPTY }, toolCalls: [], streamPath: null, compactBoundary: false, clockSnapshots: { count: 0, bytes: 0 }, isError: true, rateLimited: false, errorText: `mock transcript has no turn ${label}` };
    }
    const r = { ...t.result };
    let streamPath = null;
    if (Array.isArray(t.stream) && t.stream.length > 0 && rawDir) {
      streamPath = join(rawDir, `${label}.jsonl`);
      writeFileSync(streamPath, streamText(t.stream, r.sessionId ?? sessionId ?? "mock"));
    }
    return {
      exitCode: 0, timedOut: false, sessionId: sessionId ?? null, resultText: "", usage: { ...EMPTY }, toolCalls: [],
      compactBoundary: false, clockSnapshots: { count: 0, bytes: 0 }, isError: false, rateLimited: false, errorText: "",
      ...r,
      durationMs: t.durationMs ?? r.durationMs ?? 0,
      streamPath,
    };
  }

  async function runTurn({ workspace, prompt, sessionId, env, rawDir, label, timeoutMs, mock, onLine, signal, pluginDir, isolation }) {
    const override = behave({ workspace, prompt, sessionId, env, label, rawDir, mock });
    if (override) return { streamPath: null, durationMs: 0, ...override };
    const tr = transcript(mock);
    if (tr) return replayTurn(tr, { label, rawDir, sessionId });
    if (delayMs > 0) {
      const wait = Math.min(delayMs, timeoutMs ?? delayMs);
      await new Promise((r) => setTimeout(r, wait));
      if (timeoutMs !== undefined && delayMs >= timeoutMs) {
        return { exitCode: null, timedOut: true, durationMs: timeoutMs, sessionId, resultText: "", usage: { ...EMPTY }, toolCalls: [], streamPath: null, compactBoundary: false, clockSnapshots: { count: 0, bytes: 0 }, isError: true, rateLimited: false, errorText: "mock timeout" };
      }
    }
    const id = sessionId ?? sid(mock ? `${mock.taskId}|${mock.mode}|${mock.rep}|${mock.attempt}` : workspace);
    const feedbackOn = env?.CTX_CLOCK === "1" && env?.CTX_CLOCK_FEEDBACK === undefined;
    const placebo = env?.CCB_FEEDBACK === "placebo";
    const clockOn = env?.CTX_CLOCK === "1";
    if (opts.shimError && env?.CCB_SHIM_LOG && label === "intro") logLine(env.CCB_SHIM_LOG, { error: "mock shim error" });
    if (opts.guardDenials && env?.CCB_GUARD_LOG && label === "stage-1") {
      for (let i = 0; i < opts.guardDenials; i++) logLine(env.CCB_GUARD_LOG, { tool: i % 2 === 0 ? "Read" : "Bash", reason: "This path is outside the task workspace and is not available." });
    }
    const tick = (counters.get(id) ?? 0) + 1;
    counters.set(id, tick);
    const lines = [{ type: "system", subtype: "init", session_id: id, model: "mock-model", cwd: "<workspace>", ...initParts(env, opts.initExtra ?? null, extraPlugins(pluginDir)) }];
    // v12 mode W: the host loads CLAUDE.md of the workspace at the session start and lists it in an "instructions"
    // attachment of its transcript (opts.claudeMdNotLoaded: the attachment lists no file).
    const claudeMdPath = workspace ? join(workspace, "CLAUDE.md") : null;
    if (tick === 1 && rawDir && claudeMdPath && existsSync(claudeMdPath)) {
      const files = opts.claudeMdNotLoaded ? [] : [{ path: claudeMdPath, type: "Project", content: readFileSync(claudeMdPath, "utf8") }];
      appendFileSync(join(rawDir, "transcript.jsonl"), JSON.stringify({ type: "attachment", attachment: { type: "instructions", files }, sessionId: id }) + "\n");
    }
    const content = [];
    const results = [];
    let n = 0;
    const call = (name, input, ok, text) => {
      const tid = `toolu_mock_${tick}_${n++}`;
      content.push({ type: "tool_use", id: tid, name, input });
      results.push({ type: "tool_result", tool_use_id: tid, is_error: !ok, content: text });
    };
    for (const line of prompt.split("\n")) {
      let m = /^- file: (.+)$/.exec(line);
      if (m) {
        const p = join(workspace, m[1]);
        call("Read", { file_path: p }, existsSync(p), existsSync(p) ? "file content" : "File does not exist.");
        continue;
      }
      m = /^- output: node feed\.mjs (\S+)$/.exec(line);
      if (m) {
        const p = join(workspace, ".feed", m[1] + ".txt");
        const ok = existsSync(p);
        call("Bash", { command: `node feed.mjs ${m[1]}` }, ok, ok ? "feed text" : "no output named " + m[1]);
        if (ok && statSync(p).size > 6000) {
          const real = feedbackOn ? `[context-clock] tick=${tick} seq=${tick}\n[/context-clock]` : "";
          const snap = real && placebo ? mockPlacebo(real) : real;
          call(PREFIX + "ctx_search", { queries: [m[1]] }, true, [{ type: "text", text: "search hits" }, ...(snap ? [{ type: "text", text: snap }] : [])]);
          if (clockOn) {
            const bytes = Buffer.byteLength(real);
            logLine(env?.CCB_SHIM_LOG, { channel: "mcp_reply", event: "tools/call", mode: !real ? "none" : placebo ? "placebo" : "real", originalBytes: bytes, deliveredBytes: Buffer.byteLength(snap), replaced: real && placebo ? 1 : 0 });
          }
        }
      }
    }
    // v0.4 commit paragraph (modes E and F): status, then a commit with the status revision and one event id.
    const { kind, stage } = parseLabel(label);
    if (clockOn && kind === "stage" && prompt.includes("ctx_clock_commit")) {
      const st = commits.get(id) ?? { revision: 0, summary: null, findings: [] };
      const evt = `evt-mock-${tick}`;
      call(PREFIX + "ctx_clock_status", {}, true, [{ type: "text", text: `ctx_clock_status: tick=${tick} events=${tick} state_rev=${st.revision}\nrecent events (cite an id as evidence in ctx_clock_commit):\n- ${evt}` }]);
      const input = { summary: `mock state after stage ${stage}`, findings: [{ text: `mock-item-${stage}: value-${stage}`, evidence: [evt] }], expectedRevision: st.revision };
      if ((opts.commitRejectStages ?? []).includes(stage)) {
        const code = opts.commitRejectCode ?? "REVISION_CONFLICT";
        call(PREFIX + "ctx_clock_commit", input, false, [{ type: "text", text: `ctx_clock_commit: ${code}: mock rejection. Nothing was committed.` }]);
      } else {
        commits.set(id, { revision: st.revision + 1, summary: input.summary, findings: input.findings.map((f) => f.text) });
        call(PREFIX + "ctx_clock_commit", input, true, [{ type: "text", text: `ctx_clock_commit: state_rev=${st.revision + 1} (was ${st.revision}) agent=main tick=${tick} events=${tick}` }]);
      }
    }
    // v0.7 trigger hooks: the standing instruction at the session start (N) and the reminder above the threshold (T).
    const trig = triggerState(id);
    trig.sinceCompact++;
    if (env?.CCB_STANDING_FILE && !trig.started) logLine(env?.CCB_SHIM_LOG, { channel: "standing", event: "SessionStart", source: "startup", delivered: true, bytes: fileBytes(env.CCB_STANDING_FILE) });
    trig.started = true;
    let reminded = false;
    if (env?.CCB_REMIND_FILE && kind === "stage" && !trig.fired) {
      const estimate = MOCK_ESTIMATE_PER_TURN * trig.sinceCompact;
      const threshold = Number(env.CCB_REMIND_THRESHOLD);
      if (estimate >= threshold) {
        logLine(env?.CCB_SHIM_LOG, { channel: "reminder", event: "PostToolUse", fired: true, estimate, threshold, bytes: fileBytes(env.CCB_REMIND_FILE) });
        trig.fired = true;
        reminded = true;
      }
    }
    const periodicFired = periodicHook(env, trig);
    const triggerWrite = (env?.CCB_STANDING_FILE && stage % 2 === 1) || reminded || periodicFired;
    // v0.5 state file paragraph (mode H): one Write call that replaces clock-state.md in the workspace (v0.7: N and T).
    if (kind === "stage" && (prompt.includes(CLOCK_STATE_FILE_NAME) || triggerWrite) && !(opts.stateFileSkipStages ?? []).includes(stage)) {
      const file = join(workspace, CLOCK_STATE_FILE_NAME);
      const rows = [];
      for (let k = 1; k <= stage; k++) rows.push(`mock-item-${k}: value-${k}`);
      if (stage > 1) rows.push(`mock-item-1 history: value-0, then value-1`);
      const text = rows.join("\n") + "\n";
      writeFileSync(file, text);
      call("Write", { file_path: file, content: text }, true, `File created successfully at: ${file}`);
    }
    if (content.length > 0) {
      lines.push({ type: "assistant", message: { id: `msg_mock_${tick}_a`, role: "assistant", content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }, session_id: id });
      lines.push({ type: "user", message: { role: "user", content: results }, session_id: id });
    }
    let finalUsage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
    if (opts.autoCompactAt) {
      let ctx = (contextSizes.get(id) ?? 0) + (opts.contextPerTurn ?? 20000);
      if (ctx >= opts.autoCompactAt) {
        productPreCompact(env, "auto");
        // v12 mode Z: the host debug log line of each PreCompact hook run (no "Compacted" message for an automatic one).
        debugRuns(isolation, extraPlugins(pluginDir), "auto");
        if (env?.CCB_PRECOMPACT_FILE) logLine(env?.CCB_SHIM_LOG, preCompactLine(env, "auto", fileBytes));
        lines.push({ type: "system", subtype: "compact_boundary", session_id: id, compact_metadata: { trigger: "auto", pre_tokens: ctx } });
        if (env?.CCB_STANDING_FILE) logLine(env?.CCB_SHIM_LOG, { channel: "standing", event: "SessionStart", source: "compact", delivered: true, bytes: fileBytes(env.CCB_STANDING_FILE) });
        ctx = opts.contextAfterCompact ?? 10000;
      }
      contextSizes.set(id, ctx);
      finalUsage = { input_tokens: ctx, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    }
    const qs = questionsOf(prompt);
    const text = qs.length > 0 ? "```json\n" + JSON.stringify({ answers: Object.fromEntries(qs.map((q) => [q.id, answerOf(q)])) }) + "\n```" : "OK";
    lines.push({ type: "assistant", message: { id: `msg_mock_${tick}_b`, role: "assistant", content: [{ type: "text", text }], usage: finalUsage }, session_id: id });
    lines.push({ type: "result", subtype: "success", is_error: false, result: text, session_id: id, usage: { input_tokens: 20, output_tokens: 25, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, ...addCost(id, 0.001) });
    // Live counting: the runner sees each line and can abort the turn (a run limit); the kept lines stay in the raw file.
    const kept = emit(lines, onLine, signal);
    const aborted = kept.length < lines.length || signal?.aborted === true;
    const stream = kept.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const streamPath = rawDir ? join(rawDir, `${label}.jsonl`) : null;
    if (streamPath) writeFileSync(streamPath, stream);
    const parsed = parseStream(stream);
    return {
      exitCode: aborted ? null : 0, timedOut: false, aborted, durationMs: 1000 + 500 * parsed.toolCalls.length, sessionId: parsed.sessionId ?? id, model: parsed.model,
      resultText: parsed.resultText, usage: parsed.usage, toolCalls: parsed.toolCalls, streamPath,
      compactBoundary: parsed.compactBoundary, clockSnapshots: parsed.clockSnapshots, clockChannels: parsed.clockChannels,
      isError: aborted, hasResult: parsed.hasResult, rateLimited: false, errorText: aborted ? "stopped by a run limit" : "",
    };
  }

  /**
   * Context Clock v0.3: the product PreCompact hook (opts.productPreCompact, default true). With the clock on and
   * CTX_CLOCK_COMPACT not off, it prints the text of PRODUCT_COMPACT_TEXT_FILE; the shim logs one "precompact_product"
   * line for each call, in every mode.
   */
  function productPreCompact(env, trigger) {
    // A plain run (EXPERIMENT-V11.md) has no Context Mode plugin, so no product hook.
    if (opts.productPreCompact === false || !env?.CCB_SHIM_LOG || env.CCB_PLAIN) return;
    const on = env.CTX_CLOCK === "1" && !["0", "false", "off"].includes(String(env.CTX_CLOCK_COMPACT ?? "").toLowerCase());
    const text = on ? readFileSync(join(CONFIGS_DIR, PRODUCT_COMPACT_TEXT_FILE), "utf8") : "";
    const trimmed = text.trim();
    logLine(env.CCB_SHIM_LOG, { channel: "precompact_product", event: "PreCompact", trigger, bytes: Buffer.byteLength(text),
      sha256: trimmed === "" ? null : createHash("sha256").update(trimmed, "utf8").digest("hex"), exitCode: 0 });
  }

  async function compact({ sessionId, rawDir, label = "compact", mock, env, onLine, signal, instruction = null, pluginDir, workspace, isolation }) {
    opts.onCompact?.({ label, instruction, prompt: compactPrompt(instruction) });
    const tr = transcript(mock);
    if (tr) {
      const t = recordedTurn(tr, label);
      if (!t) return { confirmed: false, mechanism: MOCK_MECHANISM, exitCode: 1, durationMs: 0, streamPath: null, sessionId, errorText: `mock transcript has no turn ${label}` };
      return { confirmed: false, exitCode: 0, streamPath: null, sessionId, ...t.result, durationMs: t.durationMs ?? t.result?.durationMs ?? 0 };
    }
    // v0.7 trigger hooks: PreCompact (P) before the compaction, the standing instruction (N) at SessionStart:compact.
    productPreCompact(env, "manual");
    if (env?.CCB_PRECOMPACT_FILE) logLine(env?.CCB_SHIM_LOG, preCompactLine(env, "manual", fileBytes));
    if (env?.CCB_STANDING_FILE) logLine(env?.CCB_SHIM_LOG, { channel: "standing", event: "SessionStart", source: "compact", delivered: true, bytes: fileBytes(env.CCB_STANDING_FILE) });
    if (sessionId) {
      const trig = triggerState(sessionId);
      if (opts.periodicCountsCompact) periodicHook(env, trig);
      Object.assign(trig, { sinceCompact: 0, fired: false });
    }
    // With the clock on (modes B and C), the SessionStart:compact hook sends the state block, as the product does.
    const clockOn = env?.CTX_CLOCK === "1";
    if (clockOn) logLine(env?.CCB_SHIM_LOG, { channel: "session_start", event: "SessionStart", mode: "real", originalBytes: 52, deliveredBytes: 52, replaced: 0 });
    let extra = "";
    const arm = STATE_ARMS[env?.CCB_RETURN_STATE];
    if (clockOn && arm) {
      // The mock of the overlay state block (the real one is runner/overlay/state-block.mjs and the hook shim).
      let body = null;
      let findings = 0;
      if (arm === "committed") {
        const st = commits.get(sessionId);
        if (st && st.revision > 0) {
          body = [`summary: ${st.summary}`, ...st.findings.map((f, i) => `finding ${i + 1}: ${f} (reported claim, not verified)`)].join("\n");
          findings = st.findings.length;
        }
      } else if (env.CCB_STATE_FILE && existsSync(env.CCB_STATE_FILE)) {
        body = readFileSync(env.CCB_STATE_FILE, "utf8").replace(/\s+$/, "");
      }
      if (body !== null) extra = "\n" + MOCK_STATE_OPEN + "\n" + body + "\n" + MOCK_STATE_CLOSE;
      logLine(env?.CCB_SHIM_LOG, { channel: "state_block", event: "SessionStart", arm, delivered: body !== null, bytes: Buffer.byteLength(extra.slice(1)), findings, cut: false });
    }
    const hook = clockOn ? [{ type: "system", subtype: "hook_response", hook_id: `mock-${label}`, hook_name: "SessionStart:compact", hook_event: "SessionStart", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[context-clock] tick=0 seq=1 state_rev=0 [/context-clock]" + extra } }) }] : [];
    // v12 mode Z: the "Compacted" message with the PreCompact outputs of the extra plugins (not for the other modes).
    const plugins = extraPlugins(pluginDir);
    debugRuns(isolation, plugins, "manual");
    const compacted = plugins.length > 0 && !opts.noCompactedMessage ? [compactedMessage(plugins, env, workspace, sessionId)] : [];
    const all = [
      ...hook,
      { type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "manual", ...(opts.noPreTokens ? {} : { pre_tokens: 1000 * (counters.get(sessionId) ?? 0) }) } },
      ...compacted,
      { type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...addCost(sessionId, 0.0005) },
    ];
    const stream = emit(all, onLine, signal).map((l) => JSON.stringify(l)).join("\n") + "\n";
    const streamPath = rawDir ? join(rawDir, `${label}.jsonl`) : null;
    if (streamPath) writeFileSync(streamPath, stream);
    const parsed = parseStream(stream);
    return { confirmed: parsed.compactBoundary && (opts.compactConfirmed ?? true), mechanism: MOCK_MECHANISM, exitCode: 0, durationMs: 1000, streamPath, usage: parsed.usage, clockSnapshots: parsed.clockSnapshots, clockChannels: parsed.clockChannels, sessionId };
  }

  function hostInfo() {
    return { host: opts.host ?? "mock", cliVersion: "mock-1", canCompact: opts.canCompact ?? true, compactMechanism: MOCK_MECHANISM, deterministic: true, sessionModes: ["persistent", "resume"] };
  }

  /** Persistent mode: one session object per attempt that sends every turn through this host (opts.onSession sees it). */
  function openSession({ sessionMode = "persistent", workspace, mock } = {}) {
    if (sessionMode !== "persistent") return null;
    const s = { sessionMode, workspace, mock, turns: 0, closed: false };
    opts.onSession?.(s);
    return {
      sessionMode,
      runTurn: (a) => {
        if (s.closed) throw new Error("mock session is closed");
        s.turns++;
        return runTurn(a);
      },
      compact: (a) => {
        s.turns++;
        return compact(a);
      },
      close: async () => {
        s.closed = true;
        return { exitCode: 0, spawnError: null };
      },
    };
  }

  return { runTurn, compact, hostInfo, openSession, toolInputs: (text) => parseStream(text).toolInputs };
}

const defaultHost = createMockHost();
export const runTurn = defaultHost.runTurn;
export const compact = defaultHost.compact;
export const hostInfo = defaultHost.hostInfo;
export const toolInputs = defaultHost.toolInputs;
export const openSession = defaultHost.openSession;
