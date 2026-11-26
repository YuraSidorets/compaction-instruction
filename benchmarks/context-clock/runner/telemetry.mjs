// Run telemetry: the clock tables of the attempt's context.db (read-only), tool counts, the integrity scan, and the
// redaction of local paths in every saved record.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Every context.db under <dataDir>/projects. */
export function findContextDbs(dataDir) {
  const projects = join(dataDir, "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects).map((k) => join(projects, k, "context.db")).filter((p) => existsSync(p));
}

function tableSet(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

/**
 * Clock numbers of one attempt: events (all agents), the main agent's max exposure tick and state revision.
 * Zeros when the clock tables do not exist (mode A). `present` says whether any clock table was found.
 */
export function readClockTelemetry(dataDir) {
  const out = { events: 0, maxTick: 0, stateRevision: 0, present: false, databases: 0, error: null };
  for (const p of findContextDbs(dataDir)) {
    out.databases += 1;
    let db;
    try {
      db = new DatabaseSync(p, { readOnly: true });
      const t = tableSet(db);
      if (t.has("clock_events")) {
        out.present = true;
        out.events += db.prepare("SELECT COUNT(*) AS n FROM clock_events").get().n;
      }
      if (t.has("clock_counters")) {
        const r = db.prepare("SELECT MAX(last_exposure_tick) AS m FROM clock_counters WHERE agent_id = 'main'").get();
        out.maxTick = Math.max(out.maxTick, r.m ?? 0);
      }
      if (t.has("clock_state_revisions")) {
        const r = db.prepare("SELECT MAX(revision) AS m FROM clock_state_revisions WHERE agent_id = 'main'").get();
        out.stateRevision = Math.max(out.stateRevision, r.m ?? 0);
      }
    } catch (err) {
      out.error = String(err?.message ?? err);
    } finally {
      try {
        db?.close();
      } catch {
        // closed
      }
    }
  }
  return out;
}

/** The short tool name: "mcp__plugin_context-mode_context-mode__ctx_search" -> "ctx_search". */
export function shortToolName(name) {
  return String(name).split("__").pop();
}

export function countByName(toolCalls) {
  const out = {};
  for (const c of toolCalls) out[c.name] = (out[c.name] ?? 0) + 1;
  return out;
}

export function countShort(byName, short) {
  let n = 0;
  for (const [k, v] of Object.entries(byName)) if (shortToolName(k) === short) n += v;
  return n;
}

const WORDS = /key\.json|graders|benchmarks/i;
const WIN_ABS = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`|<>*?]*/g;
const UNC = /\\\\[^\s"'`|<>*?]+/g;
const POSIX_ABS = /(?<![A-Za-z0-9.~_\-\\/:])\/(?:[A-Za-z0-9._@+-]+\/?)+/g;
const HOME_REF = /(?<![A-Za-z0-9])(~[\\/]|\$HOME\b|\$env:USERPROFILE\b|%USERPROFILE%)/gi;
const PARENT = /(?:^|[\s"'`=(])((?:\.\.[\\/])+[^\s"'`]*)/g;
const SAFE_POSIX = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/tmp"]);

function inside(p, root) {
  const a = process.platform === "win32" ? normalize(p).toLowerCase() : normalize(p);
  const b = process.platform === "win32" ? normalize(root).toLowerCase() : normalize(root);
  const rel = relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Integrity scan of tool inputs (CONTRACT.md "Isolation"): a path outside the workspace, and the words key.json,
 * graders and benchmarks. Returns violations { turn, tool, reason, excerpt }.
 */
export function integrityScan(inputs, workspace) {
  const violations = [];
  for (const { turn, name, input } of inputs) {
    const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
    const add = (reason, hit) => violations.push({ turn, tool: name, reason, excerpt: String(hit).slice(0, 200) });
    const w = WORDS.exec(text);
    if (w) add(`forbidden word: ${w[0]}`, text.slice(Math.max(0, w.index - 60), w.index + 60));
    const unescaped = text.replace(/\\\\/g, "\\");
    for (const m of unescaped.matchAll(WIN_ABS)) if (!inside(m[0], workspace)) add("path outside the workspace", m[0]);
    for (const m of unescaped.matchAll(UNC)) add("path outside the workspace", m[0]);
    if (process.platform !== "win32" || /\/(Users|home|etc|var|opt|root|mnt|private)\//.test(unescaped)) {
      for (const m of unescaped.matchAll(POSIX_ABS)) {
        const p = m[0].replace(/\/$/, "");
        if (SAFE_POSIX.has(p) || p.length < 2) continue;
        if (/^\/[A-Za-z]$/.test(p)) continue;
        if (!inside(p, workspace)) add("path outside the workspace", m[0]);
      }
    }
    for (const m of unescaped.matchAll(HOME_REF)) add("path outside the workspace", m[0]);
    for (const m of unescaped.matchAll(PARENT)) {
      if (!inside(resolve(workspace, m[1]), workspace)) add("path outside the workspace", m[1]);
    }
  }
  return violations;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace local paths in every string of a value. `pairs` is [[path, token], ...], most specific first.
 * Each path also matches with forward slashes and with doubled backslashes; on Windows the match ignores case.
 */
export function redact(value, pairs) {
  const rules = [];
  // The longest path first, so a path that starts with another path keeps its own token.
  for (const [p, token] of pairs.filter(([x]) => x).sort((a, b) => b[0].length - a[0].length)) {
    const variants = new Set([p, p.split("\\").join("/"), p.split("\\").join("\\\\"), p.split("/").join("\\")]);
    // The Git Bash form of a Windows path (/c/Users/name) and the folder name that Claude Code builds from a path (C--Users-name).
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (drive) variants.add("/" + drive[1].toLowerCase() + "/" + drive[2].split("\\").join("/"));
    variants.add(p.replace(/[^A-Za-z0-9]/g, "-"));
    for (const v of variants) rules.push([new RegExp(escapeRe(v), process.platform === "win32" ? "gi" : "g"), token]);
  }
  const fix = (s) => rules.reduce((acc, [re, t]) => acc.replace(re, t), s);
  const walk = (v) => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/** The redaction pairs of one attempt: workspace, data folder, work root, then home. */
export function redactionPairs({ workspace, dataDir, workRoot, overlay = null }) {
  return [[workspace, "<workspace>"], [dataDir, "<data>"], [overlay, "<overlay>"], [workRoot, "<work-root>"], [homedir(), "<home>"]];
}
