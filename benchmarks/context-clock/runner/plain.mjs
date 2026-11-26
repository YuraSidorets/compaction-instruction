// Plain arms O and I (EXPERIMENT-V11.md "Arms"): a Claude Code session without any Context Mode part.
// - The runner builds one small benchmark plugin for each plain mode of the batch, under <workRoot>/plain/<batch>/<mode>.
//   It holds the workspace guard (the same guard.mjs as the overlay, as a PreToolUse hook) and, in mode I, one PreCompact
//   hook (plain/precompact-hook.mjs) that prints configs/precompact-general-instruction.txt (trimmed).
// - Isolation: the host starts with --setting-sources project,local (no user settings, so no user hook, no user plugin
//   and no user permission rule), --strict-mcp-config with no --mcp-config (no MCP server at all), --plugin-dir with the
//   benchmark plugin only, and a run settings file that also disables the installed Context Mode plugin. The workspace
//   has no project settings. No global file changes.
// - run.json "session" records the configuration and what the init line of the stream reported (plugins, MCP servers,
//   tools, skills, slash commands), and lists every name of a Context Mode part.
// - v12 (docs/context-clock/PLAN-standalone.md, arms S and C there): mode Z loads the standalone plugin
//   compaction-instruction unchanged as a second --plugin-dir; mode W writes CLAUDE.md into the workspace root before the
//   session. Both have the guard only in the benchmark plugin, and no PreCompact hook of the benchmark.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines } from "./stream.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLAIN_MODES = Object.freeze(["O", "I", "Z", "W"]);
/** v12: the plain mode that loads the standalone plugin, and the plain mode that gets the text in CLAUDE.md. */
export const STANDALONE_MODES = Object.freeze(["Z"]);
export const CLAUDE_MD_MODES = Object.freeze(["W"]);
/** The folder of the standalone plugin: env CCB_STANDALONE_PLUGIN, else this default. */
export const DEFAULT_STANDALONE_DIR = fileURLToPath(new URL("../../../plugin", import.meta.url));
export const STANDALONE_PLUGIN_NAME = "compaction-instruction";
/** Mode W: the file whose text the runner writes as CLAUDE.md into the workspace root. */
export const CLAUDE_MD_TEXT_FILE = "claude-md-compact-instruction.md";
const CONFIGS = join(HERE, "..", "configs");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
export const PLAIN_PLUGIN_NAME = "ccb-plain";
/** The setting sources of a plain session: no "user" (EXPERIMENT-V11.md: no Context Mode hook from the user settings). */
export const PLAIN_SETTING_SOURCES = "project,local";
export const PLAIN_ISOLATION = Object.freeze({ settingSources: PLAIN_SETTING_SOURCES, strictMcpConfig: true });
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const GUARD_SRC = join(HERE, "overlay", "guard.mjs");
const PRECOMPACT_SRC = join(HERE, "plain", "precompact-hook.mjs");
const DEFAULT_GUARD_MATCHER = "^(Bash|PowerShell|Read|Grep|Glob|WebFetch|Write|Edit|NotebookEdit)$";
/** A name of a Context Mode part in the init line of the stream (plugin, MCP server, tool, skill or command). */
export const CONTEXT_MODE_NAME = /context[-_ ]?mode|ctx_/i;

export const isPlain = (mode) => PLAIN_MODES.includes(mode);

/**
 * Isolated sessions (suite field "isolated", flag --isolated on|off). A probe of Claude Code 2.1.331 (no model call)
 * showed: --setting-sources project,local drops the user plugins, user hooks and user MCP servers; the claude.ai
 * connectors stay unless ENABLE_CLAUDEAI_MCP_SERVERS=false is in the environment of the host process;
 * --strict-mcp-config also drops the MCP server of a --plugin-dir plugin, so an overlay session must not use it.
 */
export const ISOLATED_ENV = Object.freeze({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
export const OVERLAY_ISOLATION = Object.freeze({ settingSources: PLAIN_SETTING_SOURCES, strictMcpConfig: false });
/** Plugins that the host always lists (built in), allowed in every isolated session. */
export const BUILTIN_PLUGIN = /^cc-plugin-/;

/** The allowed plugins and MCP servers of an isolated session of `mode`. */
export function allowedPartsOf(mode, overlayPluginName = "context-mode", standaloneName = STANDALONE_PLUGIN_NAME) {
  // v12: mode Z also loads the standalone plugin (no MCP server).
  if (STANDALONE_MODES.includes(mode)) return { plugins: [PLAIN_PLUGIN_NAME, standaloneName], mcpServerPrefixes: [] };
  if (isPlain(mode)) return { plugins: [PLAIN_PLUGIN_NAME], mcpServerPrefixes: [] };
  return { plugins: [overlayPluginName], mcpServerPrefixes: [`plugin:${overlayPluginName}:`] };
}

/** The plugins and MCP servers of `parts` (initPartsOf) outside the allowed list of `mode`. Pure. */
export function isolationViolations(parts, mode, overlayPluginName = "context-mode", standaloneName = STANDALONE_PLUGIN_NAME) {
  const allowed = allowedPartsOf(mode, overlayPluginName, standaloneName);
  const out = [];
  for (const p of parts?.plugins ?? []) if (!allowed.plugins.includes(p) && !BUILTIN_PLUGIN.test(p)) out.push(`plugin ${p}`);
  for (const m of parts?.mcpServers ?? []) if (!allowed.mcpServerPrefixes.some((x) => m.startsWith(x))) out.push(`MCP server ${m}`);
  return out;
}

/** The hook file of the plain plugin of `mode`: the guard, and in mode I the PreCompact hook. Pure. */
export function plainHooks(mode) {
  if (!isPlain(mode)) throw new Error(`mode ${mode} is not a plain mode`);
  const hooks = { PreToolUse: [{ matcher: DEFAULT_GUARD_MATCHER, hooks: [{ type: "command", command: `node "${ROOT_VAR}/ccb/guard.mjs"`, timeout: 5 }] }] };
  if (mode === "I") hooks.PreCompact = [{ hooks: [{ type: "command", command: `node "${ROOT_VAR}/ccb/precompact-hook.mjs"`, timeout: 5 }] }];
  return { hooks };
}

/** [{ event, matcher, command }] of a hook file, for the records. Pure. */
export function hookList(file) {
  const out = [];
  for (const [event, entries] of Object.entries(file?.hooks ?? {})) {
    for (const e of entries ?? []) for (const h of e?.hooks ?? []) out.push({ event, matcher: e.matcher ?? null, command: h.command });
  }
  return out;
}

/** Build the plain plugin of `mode` in `destDir` (replaced). Returns { pluginDir, hooks }. */
export function buildPlainPlugin({ destDir, mode }) {
  const file = plainHooks(mode);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(join(destDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(destDir, "hooks"), { recursive: true });
  mkdirSync(join(destDir, "ccb"), { recursive: true });
  // No "hooks" key: Claude Code loads hooks/hooks.json of a plugin by itself.
  writeFileSync(join(destDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLAIN_PLUGIN_NAME, version: "0.11.0", description: `Context Clock benchmark, plain arm ${mode}: workspace guard${mode === "I" ? " and PreCompact text" : ""}` }, null, 2) + "\n");
  writeFileSync(join(destDir, "hooks", "hooks.json"), JSON.stringify(file, null, 2) + "\n");
  copyFileSync(GUARD_SRC, join(destDir, "ccb", "guard.mjs"));
  if (mode === "I") copyFileSync(PRECOMPACT_SRC, join(destDir, "ccb", "precompact-hook.mjs"));
  return { pluginDir: destDir, hooks: hookList(file) };
}

/**
 * Build the plain plugins of the plain modes of a batch: { O: { pluginDir, hooks }, I: ... }.
 * v12: Z also carries `standalone` (standalonePluginInfo of `standaloneDir`), W carries `claudeMd` (claudeMdText()).
 */
export function preparePlain({ workRoot, batch, modes, standaloneDir = null }) {
  const out = {};
  for (const m of modes.filter(isPlain)) {
    out[m] = buildPlainPlugin({ destDir: join(workRoot, "plain", batch, m), mode: m });
    if (STANDALONE_MODES.includes(m)) out[m].standalone = standalonePluginInfo(standaloneDir ?? standaloneDirOf());
    if (CLAUDE_MD_MODES.includes(m)) out[m].claudeMd = claudeMdText();
  }
  return out;
}

/** The folder of the standalone plugin (env CCB_STANDALONE_PLUGIN, else DEFAULT_STANDALONE_DIR). */
export function standaloneDirOf(env = process.env) {
  const v = env.CCB_STANDALONE_PLUGIN;
  return resolve(typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULT_STANDALONE_DIR);
}

/**
 * The standalone plugin as it is in `dir` (the runner loads it unchanged): { dir, name, version, hooks, hooksSha256,
 * text: { bytes, sha256 } | null }. `text` is the trimmed instruction.txt of the plugin, when it has one. Throws when the
 * folder has no plugin manifest or no PreCompact hook.
 */
export function standalonePluginInfo(dir) {
  const manifest = readJsonOrNull(join(dir, ".claude-plugin", "plugin.json"));
  if (!manifest || typeof manifest.name !== "string") throw new Error(`mode Z: no plugin manifest in ${dir} (set CCB_STANDALONE_PLUGIN)`);
  const rel = typeof manifest.hooks === "string" ? manifest.hooks : "./hooks/hooks.json";
  const hooksPath = join(dir, rel);
  const raw = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;
  let file = null;
  try {
    file = raw === null ? null : JSON.parse(raw);
  } catch {
    file = null;
  }
  const hooks = file ? hookList(file) : [];
  if (!hooks.some((h) => h.event === "PreCompact")) throw new Error(`mode Z: the plugin in ${dir} has no PreCompact hook`);
  const textPath = join(dir, "instruction.txt");
  const text = existsSync(textPath) ? readFileSync(textPath, "utf8").trim() : null;
  return {
    dir, name: manifest.name, version: typeof manifest.version === "string" ? manifest.version : null, hooks, hooksSha256: sha256(raw),
    text: text === null ? null : { bytes: Buffer.byteLength(text), sha256: sha256(text) },
  };
}

/** Mode W: the text of CLAUDE.md (configs/CLAUDE_MD_TEXT_FILE, unchanged): { file, text, bytes, sha256 }. */
export function claudeMdText(file = join(CONFIGS, CLAUDE_MD_TEXT_FILE)) {
  const text = readFileSync(file, "utf8");
  return { file: `configs/${CLAUDE_MD_TEXT_FILE}`, text, bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

/** The run settings of a plain session: the installed Context Mode plugin stays disabled even if a source enables it. */
export function plainSettings() {
  return { enabledPlugins: { "context-mode@context-mode": false } };
}

/**
 * Per-run setup of a plain mode: the hook and guard logs, the settings file and the guard variables in `env`.
 * `hostDebug`: the host writes its debug log to <dataDir>/host-debug.txt (--debug-file), the only host record of a
 * PreCompact hook run at an automatic compaction (hostDebugRuns).
 */
export function runPlain({ plain, env, workspace, dataDir, hostDebug = false }) {
  const shimLog = join(dataDir, "hooks.jsonl");
  const guardLog = join(dataDir, "guard.jsonl");
  const settingsPath = join(dataDir, "claude-settings.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(plainSettings()) + "\n");
  env.CCB_SHIM_LOG = shimLog;
  env.CCB_GUARD_LOG = guardLog;
  env.CCB_WORKSPACE = workspace;
  env.CCB_OVERLAY_DIR = plain.pluginDir;
  // v12 mode Z: the standalone plugin as a second --plugin-dir, loaded unchanged. Its hooks join the record.
  const standalone = plain.standalone ?? null;
  const pluginDirs = [plain.pluginDir, ...(standalone ? [standalone.dir] : [])];
  const hooks = [...plain.hooks, ...(standalone ? standalone.hooks.map((h) => ({ ...h, plugin: standalone.name })) : [])];
  // v12 mode W: CLAUDE.md in the workspace root, before the session starts (setting source "project" loads it).
  let claudeMd = null;
  if (plain.claudeMd) {
    const path = join(workspace, "CLAUDE.md");
    writeFileSync(path, plain.claudeMd.text);
    claudeMd = { path, file: plain.claudeMd.file, bytes: plain.claudeMd.bytes, sha256: plain.claudeMd.sha256 };
  }
  const debugFile = hostDebug ? join(dataDir, "host-debug.txt") : null;
  const isolation = debugFile ? { ...PLAIN_ISOLATION, debugFile } : PLAIN_ISOLATION;
  return { shimLog, guardLog, settingsPath, pluginDir: plain.pluginDir, pluginDirs, isolation, hooks, standalone, claudeMd, debugFile };
}

// ---------------------------------------------------------------- v12: what the host recorded

/** The text of a user message content (a string, or a list of text blocks). */
function contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("");
  return "";
}

/**
 * The PreCompact hook outputs of a "Compacted" message body. Claude Code 2.1.331 ends a manual compaction with the user
 * message "<local-command-stdout>Compacted PreCompact [<command>] completed successfully: <stdout></local-command-stdout>"
 * (one header for each hook with output; a hook without output is not listed). Returns [{ command, status, stdout }].
 */
export function parseCompactStdout(body) {
  const re = /(?:^|\n)PreCompact \[([^\]\n]*)\] ([^:\n]*): /g;
  const heads = [...String(body ?? "").matchAll(re)];
  return heads.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    return { command: m[1], status: m[2], stdout: body.slice(start, end) };
  });
}

/** Each "Compacted" message of a stream or transcript text, in order: a list of parseCompactStdout results. */
export function compactStdoutRecords(text) {
  const out = [];
  for (const e of jsonLines(String(text ?? "")).events) {
    if (e?.type !== "user") continue;
    const m = /<local-command-stdout>Compacted ?([\s\S]*?)<\/local-command-stdout>/.exec(contentText(e.message?.content));
    if (m) out.push(parseCompactStdout(m[1]));
  }
  return out;
}

export function emptyStandalone() {
  return { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: null };
}

/** The PreCompact lines of a host debug log (the rest of the log is not kept). */
export function preCompactDebugLines(text) {
  return String(text ?? "").split(/\r?\n/).filter((l) => /\] PreCompact:\w+ \[/.test(l));
}

/**
 * The PreCompact hook runs of `commands` in a host debug log. Claude Code 2.1.331 writes one line for each hook run,
 * at a manual and at an automatic compaction: "<time> [DEBUG] PreCompact:<trigger> [<command>] completed with status <n>"
 * ("cancelled" or "failed to run" instead when it did not finish). The log never holds the hook output, so a run is no
 * delivery: it shows that the host ran the command, at which trigger, and its exit status.
 * Returns { manual, auto, unknown, nonZeroExit, notCompleted } (counts of completed runs by trigger).
 */
export function hostDebugRuns(text, commands) {
  const out = { manual: 0, auto: 0, unknown: 0, nonZeroExit: 0, notCompleted: 0 };
  for (const line of preCompactDebugLines(text)) {
    const m = /\] PreCompact:(\w+) \[(.*)\] (completed with status (-?\d+)|cancelled|failed to run.*)$/.exec(line);
    if (!m || !commands.includes(m[2])) continue;
    if (m[4] === undefined) {
      out.notCompleted++;
      continue;
    }
    out[m[1] === "manual" || m[1] === "auto" ? m[1] : "unknown"]++;
    if (Number(m[4]) !== 0) out.nonZeroExit++;
  }
  return out;
}

/**
 * telemetry.triggers.precompactStandalone of mode Z, from the host records (the plugin writes no log). `events` holds
 * one entry for each compaction: { trigger, segments } where segments is the parseCompactStdout result of its
 * "Compacted" message, or null when the host recorded none (Claude Code 2.1.331 records none for an automatic
 * compaction). A segment of a PreCompact command of the plugin, "completed successfully", with a non-empty stdout is a
 * delivery: its bytes and the sha256 of the trimmed stdout count. The text itself is never stored.
 */
export function standaloneTelemetry(events, commands, hookRuns = null) {
  const out = emptyStandalone();
  // hookRuns (hostDebugRuns): evidence that the host ran the command, never a delivery.
  out.hookRuns = hookRuns;
  for (const ev of events ?? []) {
    out.calls++;
    if (!Array.isArray(ev.segments)) {
      out.unobserved++;
      continue;
    }
    for (const s of ev.segments) {
      if (!commands.includes(s.command) || s.status !== "completed successfully" || s.stdout.trim() === "") continue;
      out.deliveries++;
      out.bytes += Buffer.byteLength(s.stdout);
      out.sha256s.push(sha256(s.stdout.trim()));
      out.byTrigger[ev.trigger === "manual" || ev.trigger === "auto" ? ev.trigger : "unknown"]++;
    }
  }
  return out;
}

/**
 * The instruction files that the host loaded, from the "instructions" attachments of its transcript:
 * [{ path, type, bytes, sha256, loads }] (one entry per path; loads counts the attachments that list it). The content is
 * never stored. null when there is no transcript text.
 */
export function instructionFilesOf(text) {
  if (text === null || text === undefined) return null;
  const byPath = new Map();
  for (const e of jsonLines(String(text)).events) {
    const a = e?.attachment;
    if (a?.type !== "instructions" || !Array.isArray(a.files)) continue;
    for (const f of a.files) {
      if (typeof f?.path !== "string") continue;
      const content = typeof f.content === "string" ? f.content : "";
      const prev = byPath.get(f.path);
      if (prev) prev.loads++;
      else byPath.set(f.path, { path: f.path, type: typeof f.type === "string" ? f.type : null, bytes: Buffer.byteLength(content), sha256: sha256(content), loads: 1 });
    }
  }
  return [...byPath.values()];
}

/** Mode W: was the workspace CLAUDE.md loaded? true, false, or null without host evidence. */
export function claudeMdLoaded(files, path) {
  if (!Array.isArray(files)) return null;
  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  return files.some((f) => norm(f.path) === norm(path));
}

/** Copy the plain hook and guard logs into the raw folder of the run. */
export function keepPlainLogs(paths, rawDir) {
  for (const [p, name] of [[paths.shimLog, "hooks.jsonl"], [paths.guardLog, "guard.jsonl"]]) {
    if (p && existsSync(p)) copyFileSync(p, join(rawDir, name));
  }
}

const names = (list, key = "name") => (Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x?.[key])).filter((x) => typeof x === "string") : null);

/**
 * The session parts that the init lines of one stream report: { plugins, mcpServers, tools, skills, slashCommands }
 * (sorted name lists, null when no init line has the field). Several init lines are merged.
 */
export function initPartsOf(streamText) {
  const out = { plugins: null, mcpServers: null, tools: null, skills: null, slashCommands: null };
  const add = (k, list) => {
    if (list === null) return;
    out[k] = [...new Set([...(out[k] ?? []), ...list])].sort();
  };
  for (const e of jsonLines(String(streamText ?? "")).events) {
    if (e?.type !== "system" || e.subtype !== "init") continue;
    add("plugins", names(e.plugins));
    add("mcpServers", names(e.mcp_servers));
    add("tools", names(e.tools));
    add("skills", names(e.skills));
    add("slashCommands", names(e.slash_commands));
  }
  return out;
}

/** Merge two initPartsOf results. */
export function mergeParts(a, b) {
  const out = {};
  for (const k of ["plugins", "mcpServers", "tools", "skills", "slashCommands"]) {
    out[k] = a?.[k] == null && b?.[k] == null ? null : [...new Set([...(a?.[k] ?? []), ...(b?.[k] ?? [])])].sort();
  }
  return out;
}

/** Every name of a Context Mode part in the session record (init parts and configured hook commands). */
export function contextModePartsOf(parts, hooks = []) {
  const out = [];
  for (const k of ["plugins", "mcpServers", "tools", "skills", "slashCommands"]) for (const n of parts?.[k] ?? []) if (CONTEXT_MODE_NAME.test(n)) out.push(`${k}:${n}`);
  for (const h of hooks ?? []) if (CONTEXT_MODE_NAME.test(h.command ?? "")) out.push(`hooks:${h.event}:${h.command}`);
  return out;
}

/**
 * run.json "session" (EXPERIMENT-V11.md): the configuration of the host session and the parts it reported.
 * - plain: true for modes O and I. settingSources and strictMcpConfig: the host flags ("default" and false otherwise).
 * - plugin: "benchmark plain plugin", "Context Mode overlay" or null (no --plugin-dir).
 * - hooks: the hooks of the benchmark plugin (plain modes), else null (the overlay hooks are those of Context Mode).
 * - init: the parts that the init lines of the stream reported (initPartsOf, merged over the turns).
 * - contextModeParts: the names of Context Mode parts in init and hooks. A plain run must have [].
 */
export function sessionRecord({
  mode, plainRun = null, overlay = false, parts = null, isolated = false, overlayHooks = null, overlayPluginName = "context-mode", standalone = null, instructionFiles,
  claudeMd = null,
}) {
  const plain = isPlain(mode);
  const hooks = plain ? [...(plainRun?.hooks ?? []), ...(standalone ? standalone.hooks.map((h) => ({ ...h, plugin: standalone.name })) : [])] : overlay ? overlayHooks : null;
  const init = parts ?? { plugins: null, mcpServers: null, tools: null, skills: null, slashCommands: null };
  return {
    plain,
    isolated,
    settingSources: plain || isolated ? PLAIN_SETTING_SOURCES : "default",
    strictMcpConfig: plain,
    claudeAiConnectors: isolated ? "off" : plain ? "dropped by --strict-mcp-config" : "default",
    plugin: plain ? "benchmark plain plugin" : overlay ? "Context Mode overlay" : null,
    plugins: init.plugins,
    mcpServers: init.mcpServers,
    hooks,
    init,
    contextModeParts: contextModePartsOf(init, plain ? hooks : []),
    // Isolated sessions: the parts outside the allowed list (a run with any is infra_failed), null when not isolated.
    isolationViolations: isolated ? (parts ? isolationViolations(init, mode, overlayPluginName, standalone?.name ?? STANDALONE_PLUGIN_NAME) : null) : null,
    // v12 mode Z: the standalone plugin as loaded ({ name, version, dir, hooksSha256, text: { bytes, sha256 } }), else null.
    standalone: standalone ? { name: standalone.name, version: standalone.version, dir: standalone.dir, hooksSha256: standalone.hooksSha256, text: standalone.text } : null,
    // The CLAUDE.md files that the host loaded (instructionFilesOf its transcript), null without a transcript.
    ...(instructionFiles !== undefined ? { instructionFiles } : {}),
    // v12 mode W: { written, path, file, bytes, sha256, loaded }, else null.
    claudeMd,
  };
}

/** The name and the hook list of the overlay plugin in `pluginDir`, or { name: "context-mode", hooks: null }. */
export function overlayPluginInfo(pluginDir) {
  const manifest = pluginDir ? readJsonOrNull(join(pluginDir, ".claude-plugin", "plugin.json")) : null;
  const rel = typeof manifest?.hooks === "string" ? manifest.hooks : "./hooks/claude-code.json";
  const file = manifest ? readJsonOrNull(join(pluginDir, rel)) : null;
  return { name: typeof manifest?.name === "string" ? manifest.name : "context-mode", hooks: file ? hookList(file) : null };
}

/** batch.json "plain": the hooks of each plain plugin, the isolation flags and the text of mode I, or null. */
export function plainBatchRecord(plain, textRecord) {
  const modes = Object.keys(plain ?? {});
  if (modes.length === 0) return { plain: null, precompactPlainInstruction: null };
  return {
    plain: {
      settingSources: PLAIN_SETTING_SOURCES, strictMcpConfig: true,
      plugins: Object.fromEntries(modes.map((m) => [m, {
        name: PLAIN_PLUGIN_NAME, hooks: plain[m].hooks,
        // v12: mode Z also loads the standalone plugin; mode W writes CLAUDE.md (file, bytes and sha256, never the text).
        ...(plain[m].standalone ? { standalone: plain[m].standalone } : {}),
        ...(plain[m].claudeMd ? { claudeMd: { file: plain[m].claudeMd.file, bytes: plain[m].claudeMd.bytes, sha256: plain[m].claudeMd.sha256 } } : {}),
      }])),
    },
    precompactPlainInstruction: modes.includes("I") ? textRecord : null,
  };
}

/** Read a JSON file, or null. */
export function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
