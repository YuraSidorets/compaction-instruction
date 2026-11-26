#!/usr/bin/env node
// Context Clock v0.3 workspace guard (EXPERIMENT-V03.md, "Workspace guard"). A Claude Code PreToolUse hook in every
// mode. It denies a tool call whose input names a path outside the task workspace and outside the overlay folder.
// Allowed: relative paths that stay inside the workspace, paths under CCB_WORKSPACE, paths under CCB_OVERLAY_DIR,
// plain command names, regex and escape text, URLs, /dev/null and NUL. Denied: absolute paths elsewhere (home, the
// repository, other temp folders), home and temp forms (~, $HOME, %USERPROFILE%, $TMPDIR, %TEMP%), ".." that leaves
// the workspace, and any .claude or .codex path segment. Windows forms C:\, C:/, /c/ and UNC are read as host paths.
// Node built-ins only. Owner: overlay worker.
import { appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DENY_REASON = "This path is outside the task workspace and is not available.";

/** Input fields that are search text or prose, never a path. */
const NOT_PATH_KEYS = new Set(["pattern", "queries", "query", "description", "prompt", "url", "intent", "old_string", "new_string", "content", "text"]);
/** Glob's pattern is a path pattern, so it is checked. */
const PATH_PATTERN_TOOLS = new Set(["Glob"]);
/** Fields that hold a whole path (spaces are part of the path). */
const WHOLE_PATH_KEYS = new Set(["file_path", "notebook_path", "path", "file", "cwd", "directory", "dir"]);
// Brackets and braces do not split: a regex such as \[e[0-9]{3}\] stays one token, and ${HOME} stays whole.
const SPLIT_CHARS = new Set([" ", "\t", "\n", "\r", "\"", "'", "`", ";", "|", "&", "(", ")", "<", ">", "=", ","]);
const HOME_VARS = ["$HOME", "${HOME}", "%USERPROFILE%", "$env:USERPROFILE", "${env:USERPROFILE}", "%HOMEPATH%", "$USERPROFILE", "${USERPROFILE}"];
const TEMP_VARS = ["%TEMP%", "%TMP%", "$TEMP", "${TEMP}", "$TMP", "$TMPDIR", "${TMPDIR}", "$env:TEMP", "$env:TMP", "${env:TEMP}"];
const CWD_VARS = ["$PWD", "${PWD}", "%CD%"];
/** Device paths that are always allowed. */
const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "nul", "nul:"]);
/** Regex and escape characters. A token that starts with "/" and holds one of them is a pattern, not a path. */
const PATTERN_CHARS = /[\[\]{}()^$|\\+?]/;
/** A .claude or .codex path segment, in any path form. */
const SECRET_SEGMENT = /(^|[\\/])\.(claude|codex)([\\/]|$)/i;

function tokens(s) {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (SPLIT_CHARS.has(ch)) {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

const isDrive = (t) => t.length >= 2 && t[1] === ":" && /[A-Za-z]/.test(t[0]) && (t.length === 2 || t[2] === "\\" || t[2] === "/");

const startsWithVar = (t, vars) => vars.some((v) => t === v || t.startsWith(v + "/") || t.startsWith(v + "\\"));
const hasDotDotSegment = (t) => t.split(/[\\/]/).includes("..");

/**
 * True when a command token is a path candidate. Only these forms are: a drive path (X:\ or X:/), a UNC path
 * (\\server\...), a POSIX absolute path (/tmp/..., /c/Users/...), ~ or ~/..., a home or temp variable, file:// URLs,
 * and a relative path with a ".." segment. Regex and escape text (\[, \d, s/a/b/, /e[0-9]+/), plain names, option
 * values and other URLs are not candidates. A relative candidate is denied only when it leaves the workspace.
 */
function pathLike(t) {
  if (t.includes("://")) return t.toLowerCase().startsWith("file://");
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) return true;
  if (startsWithVar(t, HOME_VARS) || startsWithVar(t, TEMP_VARS)) return true;
  if (isDrive(t)) return true;
  if (t.startsWith("\\\\")) return t.length > 2 && /[A-Za-z0-9._-]/.test(t[2]);
  if (t.startsWith("/")) return t.length > 1 && /[A-Za-z0-9._~-]/.test(t[1]) && !PATTERN_CHARS.test(t);
  return hasDotDotSegment(t) && !PATTERN_CHARS.test(t.replace(/\\/g, "/"));
}

/** The part of a token to check, or null. A flag with a glued path (-I/usr/include, -IC:/x) gives the glued path. */
function pathPart(t) {
  if (t.startsWith("-")) {
    // --file=/x was already split at "="
    const body = t.replace(/^-+[A-Za-z]?/, "");
    if (body !== "" && body !== t && pathLike(body)) return body;
    return null;
  }
  return pathLike(t) ? t : null;
}

function norm(p, platform) {
  const r = path.win32 && platform === "win32" ? path.win32.resolve(p) : path.posix.resolve(p);
  return platform === "win32" ? r.split("/").join("\\").toLowerCase() : r;
}

function inside(p, root, platform) {
  if (!root) return false;
  const a = norm(p, platform);
  const b = norm(root, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** The host path a token names, or null when it cannot be resolved (an unknown variable). */
export function resolveToken(t, ctx) {
  const { workspace, home, platform } = ctx;
  const P = platform === "win32" ? path.win32 : path.posix;
  let s = t;
  if (s.toLowerCase().startsWith("file://")) {
    s = s.slice(7);
    if (platform === "win32" && s.startsWith("/") && isDrive(s.slice(1))) s = s.slice(1);
  }
  for (const v of HOME_VARS) if (s === v || s.startsWith(v + "/") || s.startsWith(v + "\\")) s = home + s.slice(v.length);
  for (const v of TEMP_VARS) if (s === v || s.startsWith(v + "/") || s.startsWith(v + "\\")) s = (ctx.temp || tmpdir()) + s.slice(v.length);
  for (const v of CWD_VARS) if (s === v || s.startsWith(v + "/") || s.startsWith(v + "\\")) s = workspace + s.slice(v.length);
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = home + s.slice(1);
  if (s.startsWith("$") || s.startsWith("%")) return null;
  if (platform === "win32") {
    // Git Bash and WSL forms: /c/Users/x and /mnt/c/Users/x
    const m = /^\/(?:mnt\/)?([A-Za-z])(\/.*)?$/.exec(s);
    if (m) s = m[1] + ":" + (m[2] ?? "\\");
    if (isDrive(s) && s.length === 2) s += "\\";
  }
  return P.isAbsolute(s) ? P.resolve(s) : P.resolve(workspace, s);
}

/**
 * The decision for one PreToolUse payload. Pure apart from the given context.
 * @returns {{ allow: boolean, tool: string, reason: string | null }}
 */
export function guardDecision(payload, ctx) {
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const input = payload && typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
  const workspace = ctx.workspace || (typeof payload?.cwd === "string" ? payload.cwd : "");
  const c = { ...ctx, workspace };
  const check = (t) => {
    if (DEVICE_PATHS.has(t.toLowerCase())) return null;
    if (SECRET_SEGMENT.test(t)) return "outside_workspace";
    const p = resolveToken(t, c);
    if (p === null) return "unresolved_variable";
    if (workspace && inside(p, workspace, c.platform)) return null;
    if (c.overlayDir && inside(p, c.overlayDir, c.platform)) return null;
    return "outside_workspace";
  };
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (key !== null && NOT_PATH_KEYS.has(key) && !(key === "pattern" && PATH_PATTERN_TOOLS.has(tool))) return null;
      if (key !== null && WHOLE_PATH_KEYS.has(key)) return v.trim() === "" ? null : check(v.trim());
      if (key === "pattern") return check(v);
      for (const t of tokens(v)) {
        // a .claude or .codex segment is denied in any form, also in a relative path that is not a candidate
        if (!t.includes("://") && SECRET_SEGMENT.test(t)) return "outside_workspace";
        const p = pathPart(t);
        if (p !== null) { const r = check(p); if (r) return r; }
      }
      return null;
    }
    if (Array.isArray(v)) { for (const x of v) { const r = walk(x, key); if (r) return r; } return null; }
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { const r = walk(x, k); if (r) return r; } }
    return null;
  };
  const reason = walk(input, null);
  return { allow: reason === null, tool, reason };
}

export function denyOutput() {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } });
}

function log(env, line) {
  if (!env.CCB_GUARD_LOG) return;
  try {
    appendFileSync(env.CCB_GUARD_LOG, JSON.stringify(line) + "\n");
  } catch {
    // a log failure never blocks a tool call
  }
}

/** The hook entry: reads the payload from stdin, writes the deny reply or nothing, exits 0. */
export async function main(env = process.env) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    log(env, { t: new Date().toISOString(), tool: "", reason: null, error: "unreadable payload" });
    return;
  }
  const d = guardDecision(payload, { workspace: env.CCB_WORKSPACE || "", overlayDir: env.CCB_OVERLAY_DIR || "", home: homedir(), platform: process.platform });
  if (d.allow) return;
  log(env, { t: new Date().toISOString(), tool: d.tool, reason: d.reason });
  process.stdout.write(denyOutput());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), () => process.exit(0));
}
