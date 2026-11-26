#!/usr/bin/env node
// Hidden-test grader of the v12 work-result tasks (tasks/v12-work, docs/context-clock/PLAN-standalone.md step 2.6).
// Deterministic, Node built-ins only, no network.
//
// A work task has `workspace.collect` and `final.questions: []`. The runner copies the collected paths of a run to
// results/<batch>/runs/<runId>/workspace/. This grader runs the hidden tests (<tasks>/keys/<taskId>.tests.json)
// against that copy and writes the score (passed tests / all tests) into the grade of the run.
//
// Agent-written code runs only in a child process: the collected folder is its working folder, it has a timeout,
// a small environment, and (where Node has it) the permission model, which allows reads in the collected folder
// only and denies writes, child processes, workers and network. The tests are sent on stdin; the module never gets
// them as a file.
//
//   node benchmarks/context-clock/graders/work-tests.mjs --batch <name> [--root <dir>] [--raw-dir <dir>]
//
// Validity is the rule of graders/grade.mjs: for a v08 or later suite, a run whose outside attempts the guard denied
// stays valid (deniedViolations), and the grade records deniedAttempts.
//
// Run it after graders/grade.mjs: for a work task it rewrites grade.json with the score of the hidden tests.
//
// Rule-retention tasks (tasks/v12-rules, step 2.8) have a "rules" list in their tests. For them, the score is the rule
// score (kept rules / all rules, graders/rules-check.mjs), work.function and work.passed/total hold the function
// cases, work.notDone is true below a function score of 0.5, and work.rulesFileInWorkspace is true when a file that
// the agent wrote holds the text of a rule.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { benchPaths, resolveTasksDir } from "../paths.mjs";
import { deniedViolations, falseRecordsOf, usesDeniedRule, violationsOf } from "./grade.mjs";
import { checkRule, readTree, ruleNotesInFiles } from "./rules-check.mjs";

export const WORK_GRADE_SCHEMA = 1;
export const WORK_TIMEOUT_MS = 20000;

/** True for a task whose result is code: a workspace with collected paths and no final question. */
export function isWorkTask(task) {
  return Array.isArray(task?.workspace?.collect) && Array.isArray(task?.final?.questions) && task.final.questions.length === 0;
}

/** The JSON text of a value with sorted object keys (the same comparison as the generator). */
export function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

// The child: reads { marker, exportsOf, cases } from stdin. Each case is { module, exportName, args } (module is a file
// URL or null). For each module of exportsOf, it prints "<marker> X<index> <canon of the sorted exported function
// names>" or "<marker> X<index> !error". Then for each case it prints "<marker> <index> <canon of the result>" or
// "<marker> <index> !error". The marker comes only on stdin, in a closure, so the module cannot print a result line of
// its own without it.
const HARNESS = `
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const write = process.stdout.write.bind(process.stdout);
const canon = ${canon.toString()};
const mods = new Map();
async function load(url) {
  if (!mods.has(url)) {
    try {
      mods.set(url, await import(url));
    } catch {
      mods.set(url, null);
    }
  }
  return mods.get(url);
}
for (let i = 0; i < job.exportsOf.length; i += 1) {
  const mod = job.exportsOf[i] ? await load(job.exportsOf[i]) : null;
  const line = mod ? canon(Object.keys(mod).filter((k) => typeof mod[k] === "function").sort()) : "!error";
  write(job.marker + " X" + i + " " + line + "\\n");
}
for (let i = 0; i < job.cases.length; i += 1) {
  let line;
  try {
    const c = job.cases[i];
    const mod = c.module ? await load(c.module) : null;
    const fn = mod ? mod[c.exportName] : null;
    if (typeof fn !== "function") throw new Error("no function");
    const r = await fn(...c.args);
    line = canon(r === undefined ? null : r);
  } catch {
    line = "!error";
  }
  write(job.marker + " " + i + " " + line + "\\n");
}
`;

function hasPermissionModel() {
  return process.allowedNodeEnvironmentFlags.has("--permission");
}

/**
 * Runs the hidden tests against a workspace copy. Returns { score, passed, total, timedOut, error, cases, exports }.
 * `dir` is the collected workspace copy, `tests` the parsed tests file. A case can name its own `module` and
 * `exportName`; the defaults are `tests.module` and `tests.exportName`. `exportsOf` is a list of module paths: for
 * each one, `exports[path]` is the sorted list of its exported function names, or null when it does not load.
 * Never throws.
 */
export function runWorkTests(dir, tests, { timeoutMs = WORK_TIMEOUT_MS, exportsOf = [] } = {}) {
  const total = tests.cases.length;
  const noExports = Object.fromEntries(exportsOf.map((m) => [m, null]));
  const base = { total, passed: 0, score: 0, timedOut: false, error: null, cases: tests.cases.map((c) => ({ id: c.id, ok: false })), exports: noExports };
  const root = resolve(dir);
  // The file URL of a module path inside the workspace, "" for a path that leaves it, null for a missing file.
  const urlOf = (rel) => {
    const file = resolve(root, String(rel ?? ""));
    if (!file.startsWith(root + sep)) return "";
    return existsSync(file) ? pathToFileURL(file).href : null;
  };
  const caseModules = tests.cases.map((c) => c.module ?? tests.module);
  const urls = new Map([...new Set([...caseModules, ...exportsOf])].map((m) => [m, urlOf(m)]));
  const leaving = [...urls].find(([, u]) => u === "");
  if (leaving) return { ...base, error: "module path leaves the workspace" };
  const missing = [...new Set(caseModules)].filter((m) => urls.get(m) === null);
  const missingError = missing.length > 0 ? `module missing: ${missing.join(", ")}` : null;
  if (missing.length === new Set(caseModules).size && exportsOf.every((m) => urls.get(m) === null)) return { ...base, error: missingError };
  const marker = "WT-" + createHash("sha256").update(canon(tests.cases) + root).digest("hex").slice(0, 24);
  const job = {
    marker,
    exportsOf: exportsOf.map((m) => urls.get(m)),
    cases: tests.cases.map((c, i) => ({ module: urls.get(caseModules[i]), exportName: c.exportName ?? tests.exportName, args: c.args })),
  };
  const flags = hasPermissionModel() ? ["--permission", `--allow-fs-read=${root}`] : [];
  const env = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", NODE_OPTIONS: "" };
  const r = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", HARNESS], {
    cwd: root,
    env,
    input: JSON.stringify(job),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const got = new Map();
  const gotExports = new Map();
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    if (!line.startsWith(marker + " ")) continue;
    const rest = line.slice(marker.length + 1);
    const sp = rest.indexOf(" ");
    const head = rest.slice(0, sp);
    if (head.startsWith("X")) {
      const i = Number(head.slice(1));
      if (Number.isInteger(i) && !gotExports.has(i)) gotExports.set(i, rest.slice(sp + 1));
      continue;
    }
    const i = Number(head);
    if (Number.isInteger(i) && !got.has(i)) got.set(i, rest.slice(sp + 1));
  }
  const exports = {};
  exportsOf.forEach((m, i) => {
    const line = gotExports.get(i);
    let names = null;
    if (line !== undefined && line !== "!error") {
      try {
        const v = JSON.parse(line);
        names = Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
      } catch {
        names = null;
      }
    }
    exports[m] = names;
  });
  const cases = tests.cases.map((c, i) => ({ id: c.id, ok: got.has(i) && got.get(i) === canon(c.expect) }));
  const passed = cases.filter((c) => c.ok).length;
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  const error = timedOut ? null : r.error ? String(r.error.message) : got.size === 0 && r.status !== 0 ? `module run failed (exit ${r.status})` : missingError;
  return { total, passed, score: total === 0 ? 0 : Math.round((passed / total) * 1e6) / 1e6, timedOut, error, cases, exports };
}

/**
 * The grade of one work run, with the validity rule of graders/grade.mjs gradeRun:
 * - Integrity violations are those of violationsOf (records of paths inside the workspace do not count). With
 *   options.records (falseRecordsOf from the raw streams), they are options.records.kept: the written code of a write
 *   tool and the JSON escape of a quote do not count either.
 * - Without options.rule "v08", a run with any violation is invalid.
 * - With options.rule "v08" (the batch suite is v08 or later, usesDeniedRule), a run stays valid when the guard denied
 *   every outside attempt (deniedViolations(...).allDenied) and the guard log holds at least as many denials as the
 *   denied calls. options.denial is that result, computed from the raw streams of the run; without it, no attempt
 *   counts as denied.
 * A valid completed run gets the score of the hidden tests. An invalid or not completed run gets 0.
 */
export function gradeWorkRun(task, tests, run, workspaceDir, options = {}) {
  const hasList = Array.isArray(run?.integrity?.violations);
  const records = options?.records && Array.isArray(options.records.kept) ? options.records : null;
  const violations = !hasList ? [] : records === null ? violationsOf(run) : records.kept;
  const falseRecords = records === null ? {} : { ...(records.codeText > 0 ? { codeText: records.codeText } : {}), ...(records.quoteEscape > 0 ? { quoteEscape: records.quoteEscape } : {}) };
  const completed = run?.status === "completed";
  const v08 = options?.rule === "v08";
  const denial = v08 && violations.length > 0 ? (options.denial && typeof options.denial === "object" ? options.denial : deniedViolations(violations, null)) : null;
  const guardDenied = typeof run?.telemetry?.guard?.denied === "number" ? run.telemetry.guard.denied : null;
  const guardAgrees = denial === null || guardDenied === null || guardDenied >= denial.calls;
  const valid = hasList && (violations.length === 0 || (denial?.allDenied === true && guardAgrees));
  let invalidReason = null;
  if (!hasList) invalidReason = "run integrity.violations is missing";
  else if (!valid && denial !== null) {
    const notDenied = violations.length - denial.denied - denial.notPaths;
    invalidReason = notDenied > 0
      ? `integrity: ${violations.length} violation(s), ${notDenied} not denied by the guard`
      : `integrity: ${violations.length} violation(s), guard log has ${guardDenied} denial(s) for ${denial.calls} denied call(s)`;
  } else if (!valid) invalidReason = `integrity: ${violations.length} violation(s)`;
  const graded = completed && valid;
  const notGraded = { total: tests.cases.length, passed: 0, score: 0, timedOut: false, error: completed ? "invalid run" : `run status ${run?.status}`, cases: [] };
  const common = {
    schema: WORK_GRADE_SCHEMA,
    runId: run?.runId ?? null,
    status: run?.status ?? null,
    valid,
    invalidReason,
  };
  const validity = v08 ? { validityRule: "v08", deniedAttempts: { violations: violations.length, notPaths: denial === null ? 0 : denial.notPaths, denied: denial === null ? 0 : denial.denied, calls: denial === null ? 0 : denial.calls, allDenied: denial !== null && denial.allDenied, ...falseRecords } } : {};
  if (isRulesTests(tests)) {
    const r = graded ? gradeRulesWork(workspaceDir, tests) : { ...notGraded, ...rulesBlocks(tests, notGraded, null) };
    return {
      ...common,
      success: graded && r.rules.kept === r.rules.total && r.function.total > 0 && r.function.passed === r.function.total,
      score: graded ? r.rules.score : 0,
      questions: [],
      work: r,
      ...validity,
    };
  }
  const { exports: _exports, ...work } = graded ? runWorkTests(workspaceDir, tests) : notGraded;
  return {
    ...common,
    success: graded && work.total > 0 && work.passed === work.total,
    score: work.score,
    questions: [],
    work: { module: tests.module, ...work },
    ...validity,
  };
}

/** True for the hidden tests of a rule-retention task (tasks/v12-rules): they have a list of rules. */
export function isRulesTests(tests) {
  return Array.isArray(tests?.rules);
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The work block of a rules task. `fn` is a runWorkTests result; `ruleResults` is the list of checkRule results, or
// null when the workspace was not graded (then every rule counts as not kept).
function rulesBlocks(tests, fn, ruleResults, notes = []) {
  const total = tests.rules.length;
  const cases = tests.rules.map((rule, i) => ({ id: rule.id, kind: rule.kind, kept: ruleResults ? ruleResults[i].kept : false, reason: ruleResults ? ruleResults[i].reason : "not graded" }));
  const keptN = cases.filter((c) => c.kept).length;
  const fnScore = fn.total === 0 ? 0 : round6(fn.passed / fn.total);
  return {
    shape: "rules",
    function: { passed: fn.passed, total: fn.total, score: fnScore },
    rules: { kept: keptN, total, score: total === 0 ? 0 : round6(keptN / total), cases },
    notDone: fnScore < RULES_DONE_SCORE,
    rulesFileInWorkspace: notes.length > 0,
    rulesFiles: notes,
  };
}

/** Below this function score, a rules run gets work.notDone true. The run stays valid. */
export const RULES_DONE_SCORE = 0.5;

/**
 * Grades the collected workspace copy of a rules task: the function cases (passed and total stay the function cases,
 * as in the other work tasks), each rule (rules-check.mjs), and the notes check. The primary score is the rule score.
 */
export function gradeRulesWork(dir, tests, { timeoutMs = WORK_TIMEOUT_MS } = {}) {
  const exportsOf = [...new Set(tests.rules.filter((r) => r.kind === "keepExports").flatMap((r) => Object.keys(r.modules)))];
  const fn = runWorkTests(dir, tests, { timeoutMs, exportsOf });
  const files = readTree(dir);
  const original = tests.workspace?.files ?? {};
  const results = tests.rules.map((rule) => checkRule(rule, files, original, fn.exports));
  const { exports: _exports, ...rest } = fn;
  return { ...rest, ...rulesBlocks(tests, fn, results, ruleNotesInFiles(tests.rules, files, original)) };
}

/** The parsed lines of every <turn>.jsonl in the last attempt folder (a1, a2, ...) of a run, or null (as in grade.mjs). */
function rawStreamsOf(rawRunDir) {
  if (!existsSync(rawRunDir)) return null;
  const attempts = readdirSync(rawRunDir).filter((d) => /^a\d+$/.test(d)).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
  if (attempts.length === 0) return null;
  const dir = join(rawRunDir, attempts[attempts.length - 1]);
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    out[f.slice(0, -".jsonl".length)] = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Grades the work runs of one batch and writes grade.json next to each run.json. Returns the counts. */
export function gradeWorkBatch(root, batch, opts = {}) {
  const paths = benchPaths({ root });
  const runsDir = join(paths.resultsDir, batch, "runs");
  if (!existsSync(runsDir)) throw new Error("no runs folder: " + runsDir);
  const batchDoc = readJson(join(paths.resultsDir, batch, "batch.json"));
  const tasksRoot = resolveTasksDir({ root, batch: batchDoc });
  const v08 = usesDeniedRule(batchDoc);
  const rawRoot = opts.rawDir ? resolve(opts.rawDir) : join(paths.resultsDir, batch, "raw");
  const counts = { runs: 0, work: 0, scoreSum: 0, written: 0, unchanged: 0 };
  for (const name of readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const run = readJson(join(runsDir, name, "run.json"));
    if (!run) continue;
    counts.runs += 1;
    const task = readJson(join(tasksRoot, "generated", `${run.taskId}.task.json`));
    if (!isWorkTask(task)) continue;
    const tests = readJson(join(tasksRoot, "keys", `${run.taskId}.tests.json`));
    if (!tests) throw new Error(`no hidden tests for ${run.taskId}`);
    let options = {};
    if (v08) {
      const vs = violationsOf(run);
      const streams = vs.length === 0 ? null : rawStreamsOf(join(rawRoot, name));
      const records = vs.length === 0 ? null : falseRecordsOf(vs, streams);
      options = { rule: "v08", denial: records === null || records.kept.length === 0 ? null : deniedViolations(records.kept, streams), ...(records === null ? {} : { records }) };
    }
    const grade = gradeWorkRun(task, tests, run, join(runsDir, name, "workspace"), options);
    counts.work += 1;
    counts.scoreSum += grade.score;
    const out = join(runsDir, name, "grade.json");
    const bytes = JSON.stringify(grade, null, 2) + "\n";
    if (existsSync(out) && readFileSync(out, "utf8") === bytes) counts.unchanged += 1;
    else {
      writeFileSync(out, bytes);
      counts.written += 1;
    }
  }
  return counts;
}

function main(argv) {
  let batch = null;
  let root = null;
  let rawDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--batch") batch = argv[++i] ?? null;
    else if (argv[i] === "--root") root = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--raw-dir") rawDir = resolve(argv[++i] ?? ".");
    else {
      process.stderr.write(`work-tests.mjs: unknown argument ${argv[i]}\n`);
      return 2;
    }
  }
  if (!batch) {
    process.stderr.write("usage: node benchmarks/context-clock/graders/work-tests.mjs --batch <name> [--root <dir>] [--raw-dir <dir>]\n");
    return 2;
  }
  try {
    const c = gradeWorkBatch(root, batch, { rawDir });
    const mean = c.work === 0 ? "n/a" : (c.scoreSum / c.work).toFixed(3);
    process.stdout.write(`work-tests: ${c.work} work runs of ${c.runs} in batch ${batch}, mean score ${mean} (written ${c.written}, unchanged ${c.unchanged})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`work-tests.mjs: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
