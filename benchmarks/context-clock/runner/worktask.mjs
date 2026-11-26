// Work-result tasks (plan step 2.6): files that the runner writes into the agent workspace before stage 1
// (`workspace.files`), a final turn without questions (`final.questions` empty, `final.prompt`), and the copy of
// workspace paths into the results folder before the workspace is deleted (`workspace.collect`).
// A task without these fields runs as before.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { redact } from "./telemetry.mjs";

/** The size limit of one collected copy, in bytes, summed over all files after redaction. */
export const COLLECT_LIMIT_BYTES = 1024 * 1024;
/** Folders that a collected directory never copies. */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** File names that can hold a secret: never copied. */
const SECRET_NAMES = [
  /^\.env(\..*)?$/i, /^\.(npmrc|pypirc|netrc|git-credentials)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /credential/i, /secret/i,
];
/** Text that looks like a secret: the file is not copied. */
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9]{32,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/,
];
/** Absolute host paths that the redaction pairs do not cover. */
const HOST_PATHS = [[/\b[A-Za-z]:[\\/][^\s"'`<>|*?]*/g, "<host-path>"], [/\\\\[^\s"'`<>|\\]+\\[^\s"'`<>|]*/g, "<host-path>"], [/\/(?:Users|home|root)\/[^\s"'`<>|]*/g, "<host-path>"]];

/** The tools that a work task adds to the stage tools, so that the host grants them without a permission prompt. */
export const WORK_TOOLS = Object.freeze(["Write", "Edit"]);

/** A work task is a task with `workspace.collect`: its result is the files in the workspace. */
export function isWorkTask(task) {
  return Array.isArray(task?.workspace?.collect);
}

/**
 * The allowed tools of the stage turns. A work task adds Write and Edit (once each). Without the grant, Claude Code in
 * print mode answers a Write call with a permission request that nobody can accept, and the file stays unchanged. The
 * benchmark guard hook (PreToolUse) still denies each path outside the workspace. Other tasks keep `stageTools`.
 */
export function sessionToolsOf(stageTools, task) {
  return isWorkTask(task) ? [...stageTools, ...WORK_TOOLS.filter((t) => !stageTools.includes(t))] : stageTools;
}

/** The final turn of a task: a work task gets the session tools and the stage turn limit, other tasks no tool. */
export function finalTurnOf(tools, task, cfg) {
  return isWorkTask(task)
    ? { allowedTools: tools, maxTurns: cfg.stageMaxTurns }
    : { allowedTools: [], disallowedTools: tools, maxTurns: cfg.questionMaxTurns };
}

/** run.json session.permissions: the tool grants of the run (`guard`: the benchmark guard hook is loaded). */
export function permissionsRecord({ tools, task, cfg, guard }) {
  const final = finalTurnOf(tools, task, cfg);
  return {
    workTask: isWorkTask(task),
    permissionMode: "default",
    stageAllowedTools: tools,
    finalAllowedTools: final.allowedTools,
    finalMaxTurns: final.maxTurns ?? null,
    guard,
  };
}

/** The problem of one workspace path ("" when the path is a relative path inside the workspace, outside .git). */
export function workspacePathProblem(rel) {
  if (typeof rel !== "string" || rel.trim() === "") return "is not a non-empty string";
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("\\") || rel.startsWith("/")) return "is absolute";
  const n = normalize(rel).split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
  if (n.length === 0) return "names the workspace root";
  if (n[0] === "..") return "leaves the workspace";
  if (n[0].toLowerCase() === ".git") return "is inside .git";
  return "";
}

/** Problems of the work-result fields of a task. [] for a task without them. */
export function workTaskProblems(t) {
  const p = [];
  const w = t?.workspace;
  if (w === undefined) return p;
  if (w === null || typeof w !== "object" || Array.isArray(w)) return ["workspace is not an object"];
  for (const k of Object.keys(w)) if (!["files", "collect"].includes(k)) p.push(`workspace.${k} is not a known field`);
  if (w.files !== undefined) {
    if (!Array.isArray(w.files)) p.push("workspace.files is not a list");
    else {
      const seen = new Set();
      w.files.forEach((f, i) => {
        const bad = workspacePathProblem(f?.path);
        if (bad) p.push(`workspace.files[${i}].path ${bad}`);
        if (typeof f?.content !== "string") p.push(`workspace.files[${i}].content is not a string`);
        const key = typeof f?.path === "string" ? normalize(f.path).toLowerCase() : null;
        if (key !== null && seen.has(key)) p.push(`workspace.files[${i}].path is a duplicate`);
        seen.add(key);
      });
    }
  }
  if (w.collect !== undefined) {
    if (!Array.isArray(w.collect) || w.collect.length === 0) p.push("workspace.collect is not a non-empty list");
    else w.collect.forEach((c, i) => {
      const bad = workspacePathProblem(c);
      if (bad) p.push(`workspace.collect[${i}] ${bad}`);
    });
  }
  return p;
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveIn(ws, rel) {
  const bad = workspacePathProblem(rel);
  if (bad) throw new Error(`workspace path ${bad}: ${rel}`);
  const p = normalize(join(ws, rel));
  if (!inside(p, ws) || p === normalize(ws)) throw new Error(`workspace path leaves the workspace: ${rel}`);
  return p;
}

/** Write `workspace.files` into the workspace. Returns the relative paths. The runner never removes these files. */
export function writeWorkspaceFiles(ws, files) {
  const out = [];
  for (const f of files ?? []) {
    const p = resolveIn(ws, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    out.push(relative(ws, p).split(sep).join("/"));
  }
  return out;
}

function isSecretName(name) {
  return SECRET_NAMES.some((re) => re.test(name));
}

/**
 * Copy the `collect` paths of the workspace into `outDir` (emptied first). A path is a file or a folder; a folder is
 * copied with its files, without .git, node_modules and links. A file is skipped when its name or text looks like a
 * secret, when it is binary, or when it would take the copy over `limit` bytes. Local paths in the text are replaced
 * with tokens (`pairs`, see redactionPairs), and other absolute host paths with <host-path>.
 * Returns { limitBytes, bytes, files: [{ path, bytes, sha256, redacted }], skipped: [{ path, reason }], missing }.
 */
export function collectWorkspace(ws, collect, outDir, pairs, limit = COLLECT_LIMIT_BYTES) {
  const res = { limitBytes: limit, bytes: 0, files: [], skipped: [], missing: [] };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const done = new Set();
  const rel = (p) => relative(ws, p).split(sep).join("/");
  const copyFile = (p) => {
    const r = rel(p);
    if (done.has(r)) return;
    done.add(r);
    const name = r.split("/").pop();
    if (isSecretName(name)) return res.skipped.push({ path: r, reason: "secret_name" });
    const buf = readFileSync(p);
    if (buf.includes(0)) return res.skipped.push({ path: r, reason: "binary" });
    const text = buf.toString("utf8");
    if (SECRET_TEXT.some((re) => re.test(text))) return res.skipped.push({ path: r, reason: "secret_text" });
    let out = redact(text, pairs);
    for (const [re, token] of HOST_PATHS) out = out.replace(re, token);
    const bytes = Buffer.byteLength(out);
    if (res.bytes + bytes > limit) return res.skipped.push({ path: r, reason: "size_limit" });
    const dest = join(outDir, ...r.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
    res.bytes += bytes;
    res.files.push({ path: r, bytes, sha256: createHash("sha256").update(out).digest("hex"), redacted: out !== text });
  };
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return res.skipped.push({ path: rel(p), reason: "link" });
    if (st.isFile()) return copyFile(p);
    if (!st.isDirectory()) return res.skipped.push({ path: rel(p), reason: "not_a_file" });
    for (const e of readdirSync(p).sort()) {
      if (SKIP_DIRS.has(e.toLowerCase())) continue;
      walk(join(p, e));
    }
  };
  for (const c of collect ?? []) {
    let p;
    try {
      p = resolveIn(ws, c);
    } catch {
      res.skipped.push({ path: String(c), reason: "outside_workspace" });
      continue;
    }
    if (!existsSync(p)) {
      res.missing.push(String(c));
      continue;
    }
    walk(p);
  }
  return res;
}
