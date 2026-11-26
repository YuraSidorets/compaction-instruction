#!/usr/bin/env node
// Context Clock benchmark analysis (CONTRACT.md "Analysis", EXPERIMENT-V03.md "Instrumentation and analysis",
// EXPERIMENT-V04.md "Measurements", EXPERIMENT-V06.md "Fact-level analysis").
//   node benchmarks/context-clock/analysis/analyze.mjs --batch <name> [--root <benchmark root>] [--raw-dir <dir>] [--tasks-dir <dir>] [--pool <batch>[,<batch>]]
// Reads the tasks and keys, results/<batch>/runs/<runId>/{run,grade}.json, the raw streams under results/<batch>/raw/
// (or --raw-dir), plus results/<batch>/batch.json and results/<batch>/review.json when present. Writes
// runs/<runId>/retrieval.json, runs/<runId>/coverage.json, runs/<runId>/facts.json, summary.json, report.md and charts/*.svg in the batch folder. Same inputs, same bytes.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCharts } from "./charts.mjs";
import { coverageForRun } from "./coverage.mjs";
import { factsForRun } from "./facts.mjs";
import { computeSummary } from "./metrics.mjs";
import { renderReport } from "./report.mjs";
import { retrievalForRun } from "./retrieval.mjs";
import { cmp, stableStringify } from "./util.mjs";
import { BENCH_ROOT, benchPaths, resolveTasksDir } from "../paths.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptional(path) {
  return existsSync(path) ? readJson(path) : null;
}

function listDir(path) {
  return existsSync(path) ? readdirSync(path).sort(cmp) : [];
}

// The task folder of a batch: shared with the grader (paths.mjs).
export { resolveTasksDir };

/**
 * Loads one batch and builds the retrieval record of each run from its raw streams. A run with no raw stream keeps
 * the retrieval.json that is already in its run folder, else it has no retrieval record.
 * `opts.rawDir` replaces results/<batch>/raw; `opts.tasksDir` replaces the task folder.
 */
export function loadBatch(root, batchName, opts = {}) {
  const paths = benchPaths({ root });
  const batchDir = join(paths.resultsDir, batchName);
  const runsDir = join(batchDir, "runs");
  if (!existsSync(runsDir)) throw new Error("no runs folder: results/" + batchName + "/runs");
  const batch = readOptional(join(batchDir, "batch.json"));
  const tasksRoot = resolveTasksDir({ root, tasksDir: opts.tasksDir ?? null, batch });
  const rawRoot = opts.rawDir ? resolve(opts.rawDir) : join(batchDir, "raw");
  const records = [];
  for (const id of listDir(runsDir)) {
    const runPath = join(runsDir, id, "run.json");
    if (!existsSync(runPath)) continue;
    const run = readJson(runPath);
    const grade = readOptional(join(runsDir, id, "grade.json"));
    records.push({ id, run, grade, retrieval: null, retrievalFresh: false, coverage: null, coverageFresh: false, facts: null, factsFresh: false });
  }
  const tasks = new Map();
  const keys = new Map();
  for (const taskId of [...new Set(records.map((r) => r.run.taskId))].sort(cmp)) {
    const t = readOptional(join(tasksRoot, "generated", taskId + ".task.json"));
    if (t !== null) tasks.set(taskId, t);
    const k = readOptional(join(tasksRoot, "keys", taskId + ".key.json"));
    if (k !== null) keys.set(taskId, k);
  }
  for (const r of records) {
    const task = tasks.get(r.run.taskId);
    const key = keys.get(r.run.taskId);
    const fresh = task && key ? retrievalForRun({ task, key, run: r.run, grade: r.grade, rawRunDir: join(rawRoot, r.id) }) : null;
    if (fresh !== null) {
      r.retrieval = fresh;
      r.retrievalFresh = true;
    } else {
      r.retrieval = readOptional(join(runsDir, r.id, "retrieval.json"));
    }
    const reference = readOptional(join(tasksRoot, "reference", r.run.taskId + ".state.json"));
    const cov = key ? coverageForRun({ key, run: r.run, grade: r.grade, rawRunDir: join(rawRoot, r.id), reference }) : null;
    if (cov !== null) {
      r.coverage = cov;
      r.coverageFresh = true;
    } else {
      r.coverage = readOptional(join(runsDir, r.id, "coverage.json"));
    }
    const facts = factsForRun({ run: r.run, task: task ?? null, key: key ?? null, grade: r.grade, reference, rawRunDir: join(rawRoot, r.id) });
    if (facts !== null) {
      r.facts = facts;
      r.factsFresh = true;
    } else {
      r.facts = readOptional(join(runsDir, r.id, "facts.json"));
    }
  }
  return {
    batchName,
    batch,
    review: readOptional(join(batchDir, "review.json")),
    suites: readOptional(join(BENCH_ROOT, "configs", "suites.json")),
    tasks,
    keys,
    records: records.map(({ run, grade, retrieval, coverage, facts }) => ({ run, grade, retrieval, coverage, facts })),
    fresh: records.filter((r) => r.retrievalFresh).map((r) => ({ id: r.id, retrieval: r.retrieval })),
    freshCoverage: records.filter((r) => r.coverageFresh).map((r) => ({ id: r.id, coverage: r.coverage })),
    freshFacts: records.filter((r) => r.factsFresh).map((r) => ({ id: r.id, facts: r.facts })),
    runsDir,
  };
}

function writeFresh(data) {
  for (const f of data.fresh) writeFileSync(join(data.runsDir, f.id, "retrieval.json"), stableStringify(f.retrieval), "utf8");
  return data.fresh.length;
}

function writeFreshCoverage(data) {
  for (const f of data.freshCoverage) writeFileSync(join(data.runsDir, f.id, "coverage.json"), stableStringify(f.coverage), "utf8");
  return data.freshCoverage.length;
}

function writeFreshFacts(data) {
  for (const f of data.freshFacts) writeFileSync(join(data.runsDir, f.id, "facts.json"), stableStringify(f.facts), "utf8");
  return data.freshFacts.length;
}

/** Writes runs/<runId>/{retrieval,coverage,facts}.json for every run with raw streams (facts.json: schema 2 references only). */
export function writeDerived({ root = null, batch, rawDir = null, tasksDir = null }) {
  const data = loadBatch(root, batch, { rawDir, tasksDir });
  return { retrieval: writeFresh(data), coverage: writeFreshCoverage(data), facts: writeFreshFacts(data), withoutStreams: data.records.length - data.freshCoverage.length };
}

/** Writes runs/<runId>/retrieval.json for every run with raw streams. */
export function writeRetrievals({ root = null, batch, rawDir = null, tasksDir = null }) {
  const data = loadBatch(root, batch, { rawDir, tasksDir });
  return { written: writeFresh(data), withoutStreams: data.records.length - data.fresh.length };
}

/**
 * The names of the pool batches (EXPERIMENT-V10.md pooled table): the `pool` option (CLI --pool), else the
 * batch.json field `poolBatches`. Names are unique and sorted, and the batch itself is left out.
 */
export function poolNamesOf(batchName, batchDoc, pool = null) {
  const given = Array.isArray(pool) && pool.length > 0 ? pool : Array.isArray(batchDoc?.poolBatches) ? batchDoc.poolBatches : [];
  return [...new Set(given.filter((n) => typeof n === "string" && n !== "" && n !== batchName))].sort(cmp);
}

/** Loads a pool batch: batch.json and the run and grade records only (no raw stream, no derived file). */
export function loadPoolBatch(root, batchName) {
  const runsDir = join(benchPaths({ root }).resultsDir, batchName, "runs");
  if (!existsSync(runsDir)) throw new Error("no runs folder for pool batch: results/" + batchName + "/runs");
  const records = [];
  for (const id of listDir(runsDir)) {
    const runPath = join(runsDir, id, "run.json");
    if (!existsSync(runPath)) continue;
    records.push({ run: readJson(runPath), grade: readOptional(join(runsDir, id, "grade.json")) });
  }
  return { batchName, batch: readOptional(join(runsDir, "..", "batch.json")), records };
}

/** Runs the analysis and writes the outputs. Returns the written paths relative to the batch folder. */
export function analyze({ root = null, batch, rawDir = null, tasksDir = null, pool = null }) {
  const data = loadBatch(root, batch, { rawDir, tasksDir });
  data.pool = poolNamesOf(batch, data.batch, pool).map((name) => loadPoolBatch(root, name));
  const summary = computeSummary(data);
  const outDir = join(benchPaths({ root }).resultsDir, batch);
  const chartsDir = join(outDir, "charts");
  mkdirSync(chartsDir, { recursive: true });
  const written = [];
  writeFresh(data);
  if (data.fresh.length > 0) written.push("runs/*/retrieval.json (" + data.fresh.length + ")");
  writeFreshCoverage(data);
  if (data.freshCoverage.length > 0) written.push("runs/*/coverage.json (" + data.freshCoverage.length + ")");
  writeFreshFacts(data);
  if (data.freshFacts.length > 0) written.push("runs/*/facts.json (" + data.freshFacts.length + ")");
  writeFileSync(join(outDir, "summary.json"), stableStringify(summary), "utf8");
  written.push("summary.json");
  writeFileSync(join(outDir, "report.md"), renderReport(summary, data.batch), "utf8");
  written.push("report.md");
  const charts = renderCharts(summary);
  for (const name of Object.keys(charts).sort(cmp)) {
    writeFileSync(join(chartsDir, name), charts[name], "utf8");
    written.push("charts/" + name);
  }
  return { summary, written };
}

const VALUE_ARGS = Object.freeze({ "--batch": "batch", "--root": "root", "--raw-dir": "rawDir", "--tasks-dir": "tasksDir" });

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --pool <batch>[,<batch>]: repeatable, batch names (not paths).
    if (a === "--pool") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(a + " needs a value");
      out.pool = [...(out.pool ?? []), ...v.split(",").map((x) => x.trim()).filter((x) => x !== "")];
      i++;
      continue;
    }
    const name = VALUE_ARGS[a];
    if (name === undefined) throw new Error("unknown argument: " + a);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(a + " needs a value");
    out[name] = name === "batch" ? v : resolve(v);
    i++;
  }
  if (out.batch === undefined) throw new Error("--batch <name> is required");
  return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { written } = analyze(args);
    process.stdout.write("analysis: results/" + args.batch + "/{" + written.join(", ") + "}\n");
  } catch (err) {
    process.stderr.write("analysis: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}
