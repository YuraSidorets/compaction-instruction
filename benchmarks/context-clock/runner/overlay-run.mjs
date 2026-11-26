// Runner side of the plugin overlay (EXPERIMENT-V03.md "Plugin overlay" and "Runner").
// The overlay itself (runner/overlay/build.mjs, the shims, the guard) belongs to the overlay worker. This file only:
// - builds one overlay for the batch through the contract interface (buildOverlay, findInstalledPlugin),
// - sets the per-run overlay variables and writes the Claude settings file that disables the installed plugin,
// - reads the shim and guard logs (JSON lines) into telemetry.shim and telemetry.guard.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHIM_CHANNELS = Object.freeze(["mcp_reply", "hook_context", "session_start"]);
export const SHIM_MODES = Object.freeze(["real", "placebo", "none"]);
/** EXPERIMENT-V07.md: the channels of the trigger hooks of modes N, T and P (read by v07.mjs triggerTelemetry). */
// Context Clock v0.3: "precompact_product" is the line of the hook shim for each PreCompact call of the product hook.
export const TRIGGER_CHANNELS = Object.freeze(["standing", "reminder", "precompact", "periodic", "precompact_product"]);
export const INSTALLED_PLUGIN_KEY = "context-mode@context-mode";
export const OVERLAY_MODULE = join(HERE, "overlay", "build.mjs");

/** The settings that disable the installed plugin, so that only the overlay copy runs. */
export function overlaySettings() {
  return { enabledPlugins: { [INSTALLED_PLUGIN_KEY]: false } };
}

/**
 * Build the batch overlay. `module` injects the overlay module (tests); with `mock` and no module the runner uses a
 * placeholder overlay (the mock host starts no plugin). Returns { pluginDir, sourceSha }.
 */
export async function prepareOverlay({ workRoot, batch, mock = false, module = null, needProductPreCompact = false }) {
  let mod = module;
  if (!mod && mock) return { pluginDir: join(workRoot, "overlay", batch), sourceSha: "mock" };
  if (!mod) {
    if (!existsSync(OVERLAY_MODULE)) throw new Error("runner/overlay/build.mjs is missing: merge the overlay branch, or use --overlay off");
    mod = await import(pathToFileURL(OVERLAY_MODULE).href);
  }
  // CCB_PLUGIN_SOURCE names a plugin tree to overlay in place of the installed plugin (a kept copy of the build under
  // test). batch.json records its tree hash as overlay.sourceSha in both cases.
  const sourceDir = process.env.CCB_PLUGIN_SOURCE ? resolve(process.env.CCB_PLUGIN_SOURCE) : mod.findInstalledPlugin();
  const destDir = join(workRoot, "overlay", batch);
  const r = mod.buildOverlay({ sourceDir, destDir });
  if (!r || typeof r.pluginDir !== "string" || typeof r.sourceSha !== "string") throw new Error("buildOverlay must return { pluginDir, sourceSha }");
  // Context Clock v0.3 (mode M): without a product PreCompact hook, mode M would be mode B. Stop before any run.
  if (needProductPreCompact && !productPreCompactOf(r.pluginDir)) {
    throw new Error(`mode M needs a product plugin with a PreCompact hook; ${sourceDir} has none (set CCB_PLUGIN_SOURCE to the Context Clock v0.3 build)`);
  }
  return { pluginDir: r.pluginDir, sourceSha: r.sourceSha };
}

/**
 * Context Clock v0.3: true when the hook file of the plugin has a PreCompact entry that runs the product hook (hook.mjs),
 * directly or through the hook shim. The entry that the overlay adds (the shim alone) does not count.
 */
export function productPreCompactOf(pluginDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    const rel = typeof manifest.hooks === "string" ? manifest.hooks : "./hooks/claude-code.json";
    const hooks = JSON.parse(readFileSync(resolve(pluginDir, rel), "utf8"))?.hooks?.PreCompact;
    return Array.isArray(hooks) && hooks.some((e) => (e?.hooks ?? []).some((h) => typeof h?.command === "string" && /hook\.mjs"/.test(h.command.replace(/hook-shim\.mjs"/g, ""))));
  } catch {
    return false;
  }
}

/**
 * Per-run overlay setup. Adds CCB_SHIM_LOG, CCB_GUARD_LOG, CCB_WORKSPACE and CCB_OVERLAY_DIR to env (CCB_FEEDBACK comes
 * from the mode table), writes the settings file into the data folder, and returns the paths.
 */
export function runOverlay({ overlay, env, workspace, dataDir }) {
  const shimLog = join(dataDir, "shim.jsonl");
  const guardLog = join(dataDir, "guard.jsonl");
  const settingsPath = join(dataDir, "claude-settings.json");
  mkdirSync(dataDir, { recursive: true });
  // A settings file, not inline JSON: no quoting problem when a .cmd shim goes through cmd.exe on Windows.
  writeFileSync(settingsPath, JSON.stringify(overlaySettings()) + "\n");
  env.CCB_SHIM_LOG = shimLog;
  env.CCB_GUARD_LOG = guardLog;
  env.CCB_WORKSPACE = workspace;
  env.CCB_OVERLAY_DIR = overlay.pluginDir;
  return { shimLog, guardLog, settingsPath, pluginDir: overlay.pluginDir };
}

function jsonLines(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ error: "unparsable log line" });
    }
  }
  return out;
}

/** EXPERIMENT-V04.md: the channel of the state block lines and their arms. */
export const STATE_BLOCK_CHANNEL = "state_block";
export const STATE_BLOCK_ARMS = Object.freeze(["committed", "reference", "file"]);

const isCount = (v) => Number.isInteger(v) && v >= 0;

/** True for a well-formed state block line: { channel: "state_block", event: "SessionStart", arm, delivered, bytes, findings?, cut }. */
export function isStateBlockLine(e) {
  return e?.channel === STATE_BLOCK_CHANNEL && e.event === "SessionStart" && STATE_BLOCK_ARMS.includes(e.arm) && typeof e.delivered === "boolean" &&
    isCount(e.bytes) && (e.findings === undefined || e.findings === null || isCount(e.findings)) && typeof e.cut === "boolean";
}

/**
 * telemetry.shim: { byChannel: { <channel>: { real, placebo, none, bytes } }, errors }. bytes = delivered bytes.
 * A line with an error field, an unknown channel or a malformed state block line is an error (the run is infra_failed).
 * Well-formed state block lines are counted by readStateBlockLog, not here. Lines of the trigger channels (v0.7) are
 * counted by v07.mjs triggerTelemetry, not here; with an error field they are errors too.
 */
export function readShimLog(file) {
  const byChannel = Object.fromEntries(SHIM_CHANNELS.map((c) => [c, { real: 0, placebo: 0, none: 0, bytes: 0 }]));
  let errors = 0;
  for (const e of jsonLines(file)) {
    if (e.error !== undefined) {
      errors++;
      continue;
    }
    if (e.channel === STATE_BLOCK_CHANNEL) {
      if (!isStateBlockLine(e)) errors++;
      continue;
    }
    if (TRIGGER_CHANNELS.includes(e.channel)) continue;
    const ch = byChannel[e.channel];
    if (!ch || !SHIM_MODES.includes(e.mode)) {
      errors++;
      continue;
    }
    ch[e.mode]++;
    if (typeof e.deliveredBytes === "number") ch.bytes += e.deliveredBytes;
  }
  return { byChannel, errors };
}

/**
 * telemetry.stateBlock: { deliveries, missing, bytes, findings, cuts } over the well-formed state block lines.
 * deliveries: lines with delivered true. missing: lines with delivered false (arm F with no commit, arm G with no file).
 * bytes, findings: sums over the delivered lines. cuts: delivered lines with cut true.
 */
export function readStateBlockLog(file) {
  const out = { deliveries: 0, missing: 0, bytes: 0, findings: 0, cuts: 0 };
  for (const e of jsonLines(file)) {
    if (e.error !== undefined || !isStateBlockLine(e)) continue;
    if (!e.delivered) {
      out.missing++;
      continue;
    }
    out.deliveries++;
    out.bytes += e.bytes;
    out.findings += e.findings ?? 0;
    if (e.cut) out.cuts++;
  }
  return out;
}

/** telemetry.guard: { denied, byTool }. */
export function readGuardLog(file) {
  const byTool = {};
  let denied = 0;
  for (const e of jsonLines(file)) {
    if (typeof e.tool !== "string") continue;
    denied++;
    byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  }
  return { denied, byTool: Object.fromEntries(Object.entries(byTool).sort(([a], [b]) => a.localeCompare(b))) };
}

/** Copy the two logs next to the raw streams (the data folder is deleted after the attempt). */
export function keepLogs(paths, rawDir) {
  for (const [p, name] of [[paths.shimLog, "shim.jsonl"], [paths.guardLog, "guard.jsonl"]]) {
    if (p && existsSync(p)) copyFileSync(p, join(rawDir, name));
  }
}
