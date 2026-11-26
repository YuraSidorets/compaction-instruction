// Codex host adapter (CONTRACT.md "Host adapter"). One turn = one `codex exec --json` process with the prompt on stdin
// ("-"), and `codex exec ... resume <id> -` after the first turn. Codex 0.167.0 has no known controlled compaction
// command for `codex exec`, so compact() returns confirmed: false and the runner records a compaction-profile run as
// not executable. The event names below follow the `codex exec --json` stream; they are not checked against a live
// Codex run in this workstream (tests/runner/fixtures/streams/codex-turn.synthetic.jsonl is hand-written).
import { join } from "node:path";
import { quickOutput, runProcess } from "../proc.mjs";
import { EMPTY_USAGE, countSnapshots, isLimitText, jsonLines } from "../stream.mjs";

export const HOST = "codex";
export const CLI = "codex";
export const COMPACT_MECHANISM = "none: codex exec has no known controlled compaction command (Codex 0.167.0)";

// Codex passes only the variables named in env_vars of the MCP entry to the MCP server. A -c override per
// invocation names the three variables that the benchmark sets. The user configuration file is not edited.
// The key assumes the MCP entry is named "context-mode" (the name that `context-mode setup` writes).
export const DEFAULT_CONFIG_OVERRIDES = Object.freeze([
  "mcp_servers.context-mode.env_vars=['CTX_CLOCK','CTX_CLOCK_FEEDBACK','CONTEXT_MODE_DATA_DIR']",
]);

let cachedVersion = null;
export function hostInfo() {
  if (cachedVersion === null) cachedVersion = (/(\d+\.\d+\.\d+)/.exec(quickOutput(CLI, ["--version"])) ?? [null, "unknown"])[1];
  return { host: HOST, cliVersion: cachedVersion, canCompact: false, compactMechanism: COMPACT_MECHANISM };
}

export function buildArgs({ sessionId, model, configOverrides = DEFAULT_CONFIG_OVERRIDES }) {
  const args = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"];
  if (model) args.push("--model", model);
  for (const c of configOverrides) args.push("-c", c);
  if (sessionId) args.push("resume", sessionId);
  args.push("-");
  return args;
}

function toolOf(item) {
  switch (item?.type) {
    case "command_execution":
      return { name: "shell", isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0), input: item.command ?? null };
    case "mcp_tool_call": {
      const isError = item.status === "failed" || item.error != null || item.result?.is_error === true || item.result?.isError === true;
      return { name: `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`, isError, input: item.arguments ?? null };
    }
    case "file_change":
      return { name: "apply_patch", isError: item.status === "failed", input: (item.changes ?? []).map((c) => c.path) };
    case "web_search":
      return { name: "web_search", isError: false, input: item.query ?? null };
    default:
      return null;
  }
}

/** Parse one turn's `codex exec --json` text. */
export function parseStream(text) {
  const { events } = jsonLines(text);
  let sessionId = null;
  let resultText = "";
  let compactBoundary = false;
  let failed = false;
  let errorText = "";
  const usage = { ...EMPTY_USAGE };
  let sawUsage = false;
  const calls = [];
  const hostEvents = [];
  for (const e of events) {
    const type = String(e.type ?? "");
    if (type === "thread.started" && e.thread_id) sessionId = e.thread_id;
    if (type === "session_configured" && e.session_id) sessionId = e.session_id;
    if (/compact/i.test(type)) compactBoundary = true;
    if (type === "turn.completed" && e.usage) {
      sawUsage = true;
      usage.inputTokens = (usage.inputTokens ?? 0) + (e.usage.input_tokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (e.usage.output_tokens ?? 0);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (e.usage.cached_input_tokens ?? 0);
    }
    if (type === "turn.failed" || type === "error") {
      failed = true;
      errorText = String(e.error?.message ?? e.message ?? JSON.stringify(e)).slice(0, 500);
    }
    if (type === "item.completed" && e.item) {
      if (e.item.type === "agent_message" || e.item.type === "reasoning") {
        if (e.item.type === "agent_message" && typeof e.item.text === "string") resultText = e.item.text;
        continue; // the model's own text is not a snapshot delivery
      }
      const t = toolOf(e.item);
      if (t) calls.push(t);
    }
    if (type === "item.started" || type === "item.updated") continue; // the completed item carries the same output
    hostEvents.push(e);
  }
  if (!sawUsage) Object.assign(usage, EMPTY_USAGE);
  return {
    sessionId,
    model: null,
    resultText,
    usage,
    toolCalls: calls.map((c) => ({ name: c.name, isError: c.isError })),
    toolInputs: calls.map((c) => ({ name: c.name, input: c.input })),
    compactBoundary,
    clockSnapshots: countSnapshots(hostEvents),
    isError: failed,
    errorText,
  };
}

export function toolInputs(text) {
  return parseStream(text).toolInputs;
}

export async function runTurn({ workspace, prompt, sessionId, env, model, timeoutMs, rawDir, label, configOverrides }) {
  const streamPath = join(rawDir, `${label}.jsonl`);
  const proc = await runProcess({
    cmd: CLI, args: buildArgs({ sessionId, model, configOverrides }), cwd: workspace, env, input: prompt, timeoutMs,
    stdoutPath: streamPath, stderrPath: join(rawDir, `${label}.stderr.txt`),
  });
  const parsed = parseStream(proc.stdout);
  const failed = parsed.isError || proc.exitCode !== 0;
  const errorText = proc.spawnError ?? (parsed.errorText || proc.stderr.slice(-500));
  return {
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    durationMs: proc.durationMs,
    sessionId: parsed.sessionId ?? sessionId ?? null,
    model: null,
    resultText: parsed.resultText,
    usage: parsed.usage,
    toolCalls: parsed.toolCalls,
    streamPath,
    compactBoundary: parsed.compactBoundary,
    clockSnapshots: parsed.clockSnapshots,
    isError: failed,
    rateLimited: failed && isLimitText([parsed.errorText, proc.stderr].join("\n")),
    errorText,
  };
}

/** No controlled compaction exists for codex exec. Never reports a compaction. */
export async function compact() {
  return { confirmed: false, mechanism: COMPACT_MECHANISM, exitCode: null, durationMs: 0, streamPath: null };
}
