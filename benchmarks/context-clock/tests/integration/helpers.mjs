// Shared helpers of the integration tests. Not a test file (no .test.mjs suffix).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO = resolve(BENCH, "..", "..");
export const FIXTURES = join(BENCH, "fixtures");
export const MOCK_RUNS = join(FIXTURES, "mock", "runs");

export const MODULES = Object.freeze({
  generator: join(BENCH, "tasks", "generator", "generate.mjs"),
  runner: join(BENCH, "runner", "run.mjs"),
  mockHost: join(BENCH, "runner", "hosts", "mock.mjs"),
  grader: join(BENCH, "graders", "grade.mjs"),
  analysis: join(BENCH, "analysis", "analyze.mjs"),
});
export const GENERATED = join(BENCH, "tasks", "generated");
export const KEYS = join(BENCH, "tasks", "keys");

/**
 * The skip reason for a test that needs the merged tree, or false when every named module exists.
 * node:test reports a string `skip` as the skip message.
 */
export function needs(...names) {
  const missing = names.filter((n) => !existsSync(MODULES[n])).map((n) => relative(REPO, MODULES[n]).split("\\").join("/"));
  return missing.length === 0 ? false : "MERGED TREE ONLY: missing " + missing.join(", ") + " (runs after the lead merges the benchmark branches)";
}

export function tempDir(label) {
  return mkdtempSync(join(tmpdir(), "ccb-" + label + "-"));
}

/** Runs a benchmark CLI with Node. Throws with stdout and stderr when the exit code is not 0. */
export function runNode(script, args, env = {}, timeoutMs = 300000) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO, env: { ...process.env, ...env }, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const tail = (s) => (s ?? "").split("\n").slice(-30).join("\n");
    throw new Error("command failed (" + (r.status ?? r.signal ?? r.error?.message) + "): node " + relative(REPO, script) + " " + args.join(" ") + "\nstdout:\n" + tail(r.stdout) + "\nstderr:\n" + tail(r.stderr));
  }
  return r;
}

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Every file under dir, as relative paths with forward slashes, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** The JSON files of one folder, as a map name -> parsed JSON. */
export function jsonFiles(dir, suffix) {
  const m = new Map();
  if (!existsSync(dir)) return m;
  for (const name of readdirSync(dir).sort()) if (name.endsWith(suffix)) m.set(name, readJson(join(dir, name)));
  return m;
}

/** The run folders of a batch under a results root. */
export function runDirs(resultsRoot, batch) {
  const d = join(resultsRoot, batch, "runs");
  return existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()).sort().map((n) => join(d, n)) : [];
}

/** The answers object of the last fenced json block in a text, or null. */
export function lastJsonAnswers(text) {
  const open = "```json";
  const at = text.lastIndexOf(open);
  if (at < 0) return null;
  const end = text.indexOf("```", at + open.length);
  if (end < 0) return null;
  try {
    const v = JSON.parse(text.slice(at + open.length, end));
    return v && typeof v === "object" && v.answers && typeof v.answers === "object" ? v.answers : null;
  } catch {
    return null;
  }
}

/** Forms of the repository path that must never appear in a workspace, a prompt or a record. */
export function repoPathForms() {
  const fwd = REPO.split("\\").join("/");
  const escaped = REPO.split("\\").join("\\\\"); // the form inside JSON text
  const forms = new Set([REPO, fwd, fwd.toLowerCase(), REPO.toLowerCase(), escaped, escaped.toLowerCase()]);
  if (/^[A-Za-z]:\//.test(fwd)) forms.add("/" + fwd[0].toLowerCase() + fwd.slice(2)); // Git Bash form /c/...
  return [...forms];
}
