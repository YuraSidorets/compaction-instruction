// Workspaces and mode environments (CONTRACT.md "Isolation"). A workspace is a new folder outside the repository with
// feed.mjs and, during one stage, that stage's material. Each attempt also gets its own Context Mode data folder.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** benchmarks/context-clock/configs: the fixed texts that the v0.7 trigger modes name by absolute path. */
export const CONFIGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "configs");

export const FEED_SCRIPT = [
  "// Prints one named output of the current stage: node feed.mjs <name>",
  'import { readFileSync } from "node:fs";',
  "const name = process.argv[2] ?? \"\";",
  "if (!/^[A-Za-z0-9._-]+$/.test(name)) { console.error(\"usage: node feed.mjs <name>\"); process.exit(2); }",
  "try { process.stdout.write(readFileSync(new URL(\".feed/\" + name + \".txt\", import.meta.url), \"utf8\")); }",
  "catch { console.error(\"no output named \" + name + \" in this stage\"); process.exit(1); }",
  "",
].join("\n");

/** The default parent of all workspaces and data folders. It must be outside the repository. */
export function defaultWorkRoot() {
  return join(realpathSync.native(tmpdir()), "ccbench");
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertOutsideRepo(dir) {
  const a = process.platform === "win32" ? resolve(dir).toLowerCase() : resolve(dir);
  const b = process.platform === "win32" ? REPO_ROOT.toLowerCase() : REPO_ROOT;
  if (isInside(a, b)) throw new Error(`workspace root ${dir} is inside the repository ${REPO_ROOT}`);
}

function safeName(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
}

/** A new workspace folder with git init and feed.mjs, plus a separate data folder. */
export function createWorkspace(workRoot, runId, attempt) {
  assertOutsideRepo(workRoot);
  mkdirSync(workRoot, { recursive: true });
  const ws = realpathSync.native(mkdtempSync(join(workRoot, `ws-${safeName(runId)}-a${attempt}-`)));
  const data = realpathSync.native(mkdtempSync(join(workRoot, `data-${safeName(runId)}-a${attempt}-`)));
  writeFileSync(join(ws, "feed.mjs"), FEED_SCRIPT);
  writeFileSync(join(ws, "package.json"), '{ "type": "module", "private": true }\n');
  const git = spawnSync("git", ["init", "-q"], { cwd: ws, stdio: "ignore", windowsHide: true });
  return { dir: ws, dataDir: data, git: git.status === 0 };
}

function stagePath(ws, rel) {
  const p = normalize(join(ws, rel));
  if (!isInside(p, ws)) throw new Error(`stage file path leaves the workspace: ${rel}`);
  return p;
}

/** Write the files and feeds of one stage. Returns the written paths. */
export function writeStageMaterial(ws, stage) {
  const written = [];
  for (const f of stage.files ?? []) {
    const p = stagePath(ws, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    written.push(p);
  }
  for (const f of stage.feeds ?? []) {
    const p = stagePath(ws, join(".feed", f.name + ".txt"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    written.push(p);
  }
  return written;
}

/** Delete the material of one stage and every folder that it left empty (never the workspace itself). */
export function removeStageMaterial(ws, written) {
  for (const p of written) rmSync(p, { force: true });
  const dirs = [...new Set(written.map((p) => dirname(p)))].sort((a, b) => b.length - a.length);
  for (let d of dirs) {
    while (d !== ws && isInside(d, ws)) {
      try {
        if (readdirSync(d).length > 0) break;
        rmdirSync(d);
      } catch {
        break;
      }
      d = dirname(d);
    }
  }
}

export function removeWorkspace(w) {
  for (const d of [w.dir, w.dataDir]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows keeps a file open for a moment after a hook process ends; the temp folder is cleaned later.
    }
  }
}

export const CLOCK_VARS = Object.freeze(["CTX_CLOCK", "CTX_CLOCK_FEEDBACK", "CCB_FEEDBACK"]);
/** Overlay variables (EXPERIMENT-V03.md). The runner sets them for each run; a child never inherits them. */
export const OVERLAY_VARS = Object.freeze([
  "CCB_FEEDBACK", "CCB_SHIM_LOG", "CCB_GUARD_LOG", "CCB_WORKSPACE", "CCB_OVERLAY_DIR", "CCB_DATA_DIR", "CCB_RETURN_STATE", "CCB_STATE_FILE",
  // EXPERIMENT-V07.md: the trigger variables of modes N, T and P.
  "CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PRECOMPACT_FILE",
  // EXPERIMENT-V08.md: the periodic reminder of mode U.
  "CCB_PERIODIC_FILE", "CCB_PERIODIC_EVERY", "CCB_PERIODIC_OFFSET",
  // EXPERIMENT-V11.md: the marker of a plain run (mode O or I).
  "CCB_PLAIN",
]);
/** EXPERIMENT-V11.md: the modes without any Context Mode part (runner/plain.mjs PLAIN_MODES). */
const NO_CONTEXT_MODE_MODES = Object.freeze(["O", "I", "Z", "W"]);
/** Mode G: the reference state file in the data folder (EXPERIMENT-V04.md "Interfaces"). */
export const STATE_FILE_NAME = "reference-state.txt";
/** Mode H: the state file the agent writes in the workspace of the run (EXPERIMENT-V05.md "Arms"). */
export const CLOCK_STATE_FILE_NAME = "clock-state.md";

/** Mode values (CONTRACT.md "Question"). null means: not in the environment. */
export const MODE_ENV = Object.freeze({
  A: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  B: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  C: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null }),
  // EXPERIMENT-V03.md: the overlay shims replace each real snapshot with a placebo of the same size.
  D: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null, CCB_FEEDBACK: "placebo" }),
  // EXPERIMENT-V04.md: E adds the commit paragraph, F also returns the committed state, G returns the reference state.
  E: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  F: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "committed" }),
  G: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "reference" }),
  // EXPERIMENT-V05.md: H returns the state file the agent writes, S sends /compact with a fixed instruction.
  H: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" }),
  S: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V06.md: J is H without the returned file; K and L are H and J with the paragraph only before a compaction.
  J: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  K: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" }),
  L: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V07.md: N, T and P deliver a fixed text through a hook of the overlay (TRIGGER_ENV), with no returned file.
  N: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  T: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  P: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V08.md: U adds the periodic reminder of UserPromptSubmit, Q the stronger PreCompact text.
  U: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  Q: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V09.md: R is Q with the general PreCompact text.
  R: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V10.md: V is R with the variant PreCompact text.
  V: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // Context Clock v0.3 design "Acceptance with the benchmark" (arm C3): M has no overlay text. The product hook itself
  // prints the PreCompact text, because CTX_CLOCK_COMPACT stays unset (PRODUCT_COMPACT_MODES).
  M: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V11.md: the plain arms run without Context Mode (runner/plain.mjs). I adds the PreCompact text of arm R
  // through a hook of the benchmark plugin (TRIGGER_ENV.I).
  O: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  I: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  // v0.11 isolated batches: Y has the clock on, feedback off, no overlay text and CTX_CLOCK_COMPACT=off (every mode
  // outside PRODUCT_COMPACT_MODES and the plain modes gets it).
  Y: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // v12 plain arms (docs/context-clock/PLAN-standalone.md, arms S and C there): Z loads the standalone plugin
  // compaction-instruction, W gets the text in the CLAUDE.md of the workspace. No benchmark PreCompact hook in either.
  Z: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  W: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
});
/**
 * Context Clock v0.3: the modes in which the product prints its PreCompact text. Every other mode runs with
 * CTX_CLOCK_COMPACT=off, so that the product PreCompact output is empty there (a product build without the PreCompact
 * entry ignores the variable).
 */
export const PRODUCT_COMPACT_MODES = Object.freeze(["M"]);
/** The text that the product hook prints at PreCompact in mode M (the text of arm R, docs/context-clock/v0.3-design.md). */
export const PRODUCT_COMPACT_TEXT_FILE = "precompact-general-instruction.txt";

/**
 * EXPERIMENT-V07.md "Arms": the variable of each trigger mode and the fixed text in configs/ it names (absolute path).
 * N: the standing instruction of SessionStart. T: the reminder of PostToolUse, with CCB_REMIND_THRESHOLD. P: the
 * PreCompact output (the compaction instruction of mode S, delivered by the hook; the runner sends the plain /compact).
 */
export const TRIGGER_ENV = Object.freeze({
  N: Object.freeze({ CCB_STANDING_FILE: "standing-instruction.txt" }),
  T: Object.freeze({ CCB_REMIND_FILE: "reminder-instruction.txt" }),
  P: Object.freeze({ CCB_PRECOMPACT_FILE: "compact-instruction.txt" }),
  // EXPERIMENT-V08.md: U reminds with the text of arm L (unchanged); Q is P with a stronger summarizer instruction.
  U: Object.freeze({ CCB_PERIODIC_FILE: "periodic-instruction.txt" }),
  Q: Object.freeze({ CCB_PRECOMPACT_FILE: "precompact-strong-instruction.txt" }),
  R: Object.freeze({ CCB_PRECOMPACT_FILE: "precompact-general-instruction.txt" }),
  // EXPERIMENT-V10.md: V is R with the variant PreCompact text.
  V: Object.freeze({ CCB_PRECOMPACT_FILE: "precompact-variant-instruction.txt" }),
  // EXPERIMENT-V11.md: the PreCompact hook of the plain plugin of arm I prints the text of arm R.
  I: Object.freeze({ CCB_PRECOMPACT_FILE: "precompact-general-instruction.txt" }),
});
/** Mode U: the defaults of the overlay hook (a reminder with each prompt n where (n - offset) % every == 0, n > offset). */
export const DEFAULT_PERIODIC = Object.freeze({ every: 2, offset: 0 });
/** Mode T: the context estimate in tokens above which the hook adds the reminder (a suite can set remindThreshold). */
export const DEFAULT_REMIND_THRESHOLD = 40000;

// Variables of a surrounding Claude Code session. A child that inherits them resolves the wrong project or session.
/**
 * EXPERIMENT-V09.md part 2: host variables that change the size of the automatic compaction. A run never inherits them;
 * only a suite with autoCompactWindow sets CLAUDE_CODE_AUTO_COMPACT_WINDOW for its runs.
 */
export const HOST_COMPACT_VARS = Object.freeze(["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]);
/** The smallest automatic compaction window that the host accepts (claude --help: "at least 100k tokens"). */
export const MIN_AUTO_COMPACT_WINDOW = 100000;
const HOST_SESSION_VARS = /^(CLAUDECODE|CLAUDE_PROJECT_DIR|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_ENTRYPOINT|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CODEX_THREAD_ID)$/i;

/**
 * The child environment of one attempt: the parent environment without any CTX_CLOCK* variable, without
 * CONTEXT_MODE_DATA_DIR and without host session variables, then the per-attempt data folder and the mode values.
 * Mode H needs `workspace`: CCB_STATE_FILE is <workspace>/clock-state.md. Modes N, T and P add TRIGGER_ENV with absolute
 * paths; mode T also CCB_REMIND_THRESHOLD (`remindThreshold`, else DEFAULT_REMIND_THRESHOLD). Mode U (v0.8) also sets
 * CCB_PERIODIC_EVERY and CCB_PERIODIC_OFFSET (`periodic` { every, offset }, else DEFAULT_PERIODIC).
 */
export function modeEnv(mode, dataDir, parent = process.env, workspace = null, { remindThreshold = DEFAULT_REMIND_THRESHOLD, periodic = DEFAULT_PERIODIC, autoCompactWindow = null } = {}) {
  const values = MODE_ENV[mode];
  if (!values) throw new Error(`unknown mode ${mode}`);
  const env = {};
  const plain = NO_CONTEXT_MODE_MODES.includes(mode);
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    // EXPERIMENT-V11.md: a plain run inherits no CTX_* and no CCB_* variable at all.
    if (plain && (/^CTX_/i.test(k) || /^CCB_/i.test(k))) continue;
    // v12: the off switch of the standalone plugin is never inherited (mode Z must print its text).
    if (plain && /^COMPACTION_INSTRUCTION$/i.test(k)) continue;
    if (/^CTX_CLOCK/i.test(k) || /^CONTEXT_MODE_DATA_DIR$/i.test(k) || HOST_SESSION_VARS.test(k)) continue;
    if (HOST_COMPACT_VARS.some((x) => x.toLowerCase() === k.toLowerCase())) continue;
    if (OVERLAY_VARS.some((x) => x.toLowerCase() === k.toLowerCase())) continue;
    env[k] = v;
  }
  // EXPERIMENT-V11.md: a plain run has no Context Mode data folder variable.
  if (!plain) env.CONTEXT_MODE_DATA_DIR = dataDir;
  // EXPERIMENT-V04.md: the Context Mode data folder of the run, in every mode (the overlay shim reads context.db there).
  env.CCB_DATA_DIR = dataDir;
  for (const [k, v] of Object.entries(values)) if (v !== null) env[k] = v;
  if (values.CCB_RETURN_STATE === "reference") env.CCB_STATE_FILE = join(dataDir, STATE_FILE_NAME);
  if (values.CCB_RETURN_STATE === "file") {
    if (!workspace) throw new Error(`mode ${mode} needs the workspace folder (CCB_STATE_FILE is <workspace>/${CLOCK_STATE_FILE_NAME})`);
    env.CCB_STATE_FILE = join(workspace, CLOCK_STATE_FILE_NAME);
  }
  for (const [k, file] of Object.entries(TRIGGER_ENV[mode] ?? {})) env[k] = join(CONFIGS_DIR, file);
  if (mode === "T") {
    if (!Number.isInteger(remindThreshold) || remindThreshold <= 0) throw new Error(`remindThreshold must be a positive integer, not ${remindThreshold}`);
    env.CCB_REMIND_THRESHOLD = String(remindThreshold);
  }
  // Context Clock v0.3: the product PreCompact instruction is on only in mode M.
  if (!PRODUCT_COMPACT_MODES.includes(mode) && !plain) env.CTX_CLOCK_COMPACT = "off";
  if (plain) env.CCB_PLAIN = mode;
  if (autoCompactWindow !== null && autoCompactWindow !== undefined) {
    if (!Number.isInteger(autoCompactWindow) || autoCompactWindow < MIN_AUTO_COMPACT_WINDOW) throw new Error(`autoCompactWindow must be an integer >= ${MIN_AUTO_COMPACT_WINDOW}, not ${autoCompactWindow}`);
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
  }
  if (mode === "U") {
    const { every, offset } = periodic ?? DEFAULT_PERIODIC;
    if (!Number.isInteger(every) || every <= 0 || !Number.isInteger(offset) || offset < 0) throw new Error(`mode U needs an integer every > 0 and offset >= 0, not ${every} and ${offset}`);
    env.CCB_PERIODIC_EVERY = String(every);
    env.CCB_PERIODIC_OFFSET = String(offset);
  }
  return env;
}

export function listFilesRel(ws) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(ws, p).split(sep).join("/"));
    }
  };
  if (existsSync(ws)) walk(ws);
  return out.sort();
}
