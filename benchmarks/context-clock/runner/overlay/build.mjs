// Context Clock v0.3 plugin overlay builder (EXPERIMENT-V03.md, "Plugin overlay"). It copies the installed
// context-mode plugin to a run folder and rewrites the copy so that the MCP server and the hook run through the shims,
// and so that the workspace guard runs as an extra PreToolUse hook. v0.7 adds a PreCompact hook that runs the hook
// shim (arm P). The installed plugin is only read.
// Node built-ins only. Owner: overlay worker.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_KEY = "context-mode@context-mode";
export const OVERLAY_SUBDIR = "ccb";
export const OVERLAY_MARKER = "overlay.json";
export const OVERLAY_FILES = Object.freeze(["placebo.mjs", "server-shim.mjs", "hook-shim.mjs", "guard.mjs", "state-block.mjs", "triggers.mjs"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const HOOK_RE = /^node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/hook\.mjs"(.*)$/;
const SHIM_PREFIX = `node "${ROOT_VAR}/${OVERLAY_SUBDIR}/hook-shim.mjs"`;
const GUARD_COMMAND =`node "${ROOT_VAR}/${OVERLAY_SUBDIR}/guard.mjs"`;

/** The installPath of the installed context-mode plugin, from ~/.claude/plugins/installed_plugins.json. */
export function findInstalledPlugin({ home = homedir() } = {}) {
  const file = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const entries = data?.plugins?.[PLUGIN_KEY];
  const entry = Array.isArray(entries) ? entries.find((e) => e && typeof e.installPath === "string") : null;
  if (!entry) throw new Error(`${PLUGIN_KEY} is not in ${file}`);
  if (!existsSync(path.join(entry.installPath, ".claude-plugin", "plugin.json"))) throw new Error(`no plugin manifest under ${entry.installPath}`);
  return entry.installPath;
}

function listFiles(dir, rel = "") {
  const out = [];
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...listFiles(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

/** SHA-256 over the sorted relative paths and the file contents of a folder. */
export function treeSha(dir) {
  const h = createHash("sha256");
  for (const r of listFiles(dir)) {
    h.update(r + "\0");
    h.update(readFileSync(path.join(dir, r)));
    h.update("\0");
  }
  return h.digest("hex");
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The manifest with the MCP server started through the server shim. */
export function rewriteManifest(manifest) {
  const m = structuredClone(manifest);
  const server = m?.mcpServers?.["context-mode"];
  if (!server || !Array.isArray(server.args)) throw new Error("manifest has no mcpServers.context-mode.args");
  const real = `${ROOT_VAR}/server.mjs`;
  const shim = `${ROOT_VAR}/${OVERLAY_SUBDIR}/server-shim.mjs`;
  if (server.args[0] === shim) return m;
  if (server.args[0] !== real) throw new Error(`unexpected server entry: ${server.args[0]}`);
  server.args = [shim, ...server.args];
  return m;
}

/** The PreToolUse matcher with Glob added to its alternation. */
export function guardMatcher(matcher) {
  const m = /^\^\((.*)\)\$$/.exec(matcher ?? "");
  if (!m) return "^(Bash|PowerShell|Read|Grep|Glob|WebFetch|Write|Edit|NotebookEdit)$";
  const names = m[1].split("|");
  if (!names.includes("Glob")) names.push("Glob");
  return `^(${names.join("|")})$`;
}

/**
 * The Claude hook file with every context-mode hook run through the hook shim, plus the guard entry. v0.7: plus a
 * PreCompact entry that runs the shim with no product hook, when no PreCompact hook runs the shim already. With
 * CCB_PRECOMPACT_FILE unset, that entry prints nothing and exits 0.
 */
export function rewriteHooks(hooksFile) {
  const f = structuredClone(hooksFile);
  const all = f?.hooks;
  if (!all || typeof all !== "object") throw new Error("hook file has no hooks object");
  let rewritten = 0;
  for (const entries of Object.values(all)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of entry?.hooks ?? []) {
        if (typeof h?.command !== "string") continue;
        if (h.command.startsWith(SHIM_PREFIX)) { rewritten++; continue; } // already rewritten
        const m = HOOK_RE.exec(h.command);
        if (!m) continue;
        h.command = `${SHIM_PREFIX} "${ROOT_VAR}/hook.mjs"${m[1]}`;
        rewritten++;
      }
    }
  }
  if (rewritten === 0) throw new Error("no context-mode hook command found");
  const pre = Array.isArray(all.PreToolUse) ? all.PreToolUse : (all.PreToolUse = []);
  if (!pre.some((e) => (e?.hooks ?? []).some((h) => h?.command === GUARD_COMMAND))) {
    pre.push({ matcher: guardMatcher(pre[0]?.matcher), hooks: [{ type: "command", command: GUARD_COMMAND, timeout: 5 }] });
  }
  const compact = Array.isArray(all.PreCompact) ? all.PreCompact : (all.PreCompact = []);
  if (!compact.some((e) => (e?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.startsWith(SHIM_PREFIX)))) {
    compact.push({ hooks: [{ type: "command", command: SHIM_PREFIX, timeout: 5 }] });
  }
  // v0.8 arm U: the periodic reminder runs in the UserPromptSubmit path of the shim. The installed plugin has a
  // UserPromptSubmit hook that already runs through the shim, so for it this adds nothing.
  const prompt = Array.isArray(all.UserPromptSubmit) ? all.UserPromptSubmit : (all.UserPromptSubmit = []);
  if (!prompt.some((e) => (e?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.startsWith(SHIM_PREFIX)))) {
    prompt.push({ hooks: [{ type: "command", command: SHIM_PREFIX, timeout: 5 }] });
  }
  return f;
}

/**
 * Builds the overlay. Idempotent: the same source gives the same destination tree.
 * @param {{ sourceDir: string, destDir: string }} opts
 * @returns {{ pluginDir: string, sourceSha: string }}
 */
export function buildOverlay({ sourceDir, destDir }) {
  const src = path.resolve(sourceDir);
  const dest = path.resolve(destDir);
  if (isInside(dest, src) || isInside(src, dest)) throw new Error("destDir and sourceDir must not contain each other");
  const manifestPath = path.join(src, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`no plugin manifest under ${src}`);
  if (existsSync(dest) && readdirSync(dest).length > 0 && !existsSync(path.join(dest, OVERLAY_SUBDIR, OVERLAY_MARKER))) {
    throw new Error(`${dest} is not empty and is not an overlay`);
  }
  const sourceSha = treeSha(src);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const hooksRel = typeof manifest.hooks === "string" ? manifest.hooks : "./hooks/claude-code.json";
  const hooksSrc = path.resolve(src, hooksRel);
  if (!isInside(hooksSrc, src) || !existsSync(hooksSrc)) throw new Error(`hook file ${hooksRel} not found`);
  const newManifest = rewriteManifest(manifest);
  const newHooks = rewriteHooks(JSON.parse(readFileSync(hooksSrc, "utf8")));

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  writeFileSync(path.join(dest, ".claude-plugin", "plugin.json"), JSON.stringify(newManifest, null, 2) + "\n");
  writeFileSync(path.join(dest, path.relative(src, hooksSrc)), JSON.stringify(newHooks, null, 2) + "\n");
  const ccb = path.join(dest, OVERLAY_SUBDIR);
  mkdirSync(ccb, { recursive: true });
  for (const f of OVERLAY_FILES) cpSync(path.join(HERE, f), path.join(ccb, f));
  writeFileSync(path.join(ccb, OVERLAY_MARKER), JSON.stringify({ sourceSha, files: OVERLAY_FILES }, null, 2) + "\n");
  return { pluginDir: dest, sourceSha };
}
