// benchmarks/context-clock/tests/integration/pipeline.test.mjs
// MERGED TREE ONLY. Each test skips with a "MERGED TREE ONLY" message while a module it needs is missing, so the
// verification branch is green alone. After the merge these tests check the generated tasks and keys, reproducible
// generation, the end-to-end mock pipeline (runner -> grader -> analysis), determinism, batch resume, mode environments
// and workspace isolation.
//
// Wiring the lead adds at merge (see fixtures/README.md):
//   CCB_RESULTS_DIR  root that replaces benchmarks/context-clock/results (runner, grader, analysis)
//   CCB_TASKS_DIR    root that replaces benchmarks/context-clock/tasks: <root>/generated and <root>/keys
//                    (generator writes there; runner and grader read from there)
//   CCB_MOCK_DIR     folder of recorded run transcripts for hosts/mock.mjs (default: fixtures/mock/runs)

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { validateGrade, validateKey, validateRun, validateSummary, validateTask, answerFieldPaths, sameValue } from "../../fixtures/schema.mjs";
import {
  BENCH, FIXTURES, GENERATED, KEYS, MOCK_RUNS, MODULES, jsonFiles, listFiles, needs, readJson, repoPathForms, runDirs, runNode, tempDir,
} from "./helpers.mjs";

const BATCH = "itest-mock";
const RUNNER_ARGS = (batch, extra = []) => ["--host", "claude", "--batch", batch, "--suite", "smoke", "--mock", ...extra];

// ---------- generated tasks and keys ----------

describe("generated tasks and keys (MERGED TREE ONLY)", () => {
  const skip = needs("generator");

  test("every committed task and key passes the validators, as a pair", { skip }, () => {
    const tasks = jsonFiles(GENERATED, ".task.json");
    const keys = jsonFiles(KEYS, ".key.json");
    assert.ok(tasks.size > 0, "no committed task under tasks/generated");
    assert.deepEqual([...keys.keys()].map((n) => n.replace(".key.json", "")).sort(), [...tasks.keys()].map((n) => n.replace(".task.json", "")).sort(), "one key per task");
    const problems = [];
    for (const [name, t] of tasks) {
      if (name !== t.taskId + ".task.json") problems.push(name + ": file name differs from taskId " + t.taskId);
      problems.push(...validateTask(t, keys.get(t.taskId + ".key.json")));
    }
    for (const k of keys.values()) problems.push(...validateKey(k));
    assert.deepEqual(problems, []);
  });

  test("the suite has 20 tasks: four per category, ten per profile, two per category and profile", { skip }, () => {
    const tasks = [...jsonFiles(GENERATED, ".task.json").values()];
    assert.equal(tasks.length, 20);
    for (const c of ["A", "B", "C", "D", "E"]) {
      assert.equal(tasks.filter((t) => t.category === c).length, 4, "category " + c);
      for (const p of ["long", "compaction"]) assert.equal(tasks.filter((t) => t.category === c && t.profile === p).length, 2, c + " " + p);
    }
    const events = tasks.map((t) => t.params.events);
    assert.ok(Math.min(...events) >= 30 && Math.max(...events) <= 700, "event counts vary (scaled tasks: about 150 to 520): " + events.join(","));
    assert.ok(new Set(events).size > 5, "event counts vary");
  });

  test("no task file holds the key: no answer field, and no question id maps to its answer value", { skip }, () => {
    const leaks = [];
    for (const t of jsonFiles(GENERATED, ".task.json").values()) {
      const k = readJson(join(KEYS, t.taskId + ".key.json"));
      for (const p of answerFieldPaths(t)) leaks.push(t.taskId + " " + p);
      const answers = { ...k.answers, ...k.checkpointAnswers };
      const walk = (v, path) => {
        if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path + "[" + i + "]"));
        if (v && typeof v === "object") for (const [f, x] of Object.entries(v)) {
          if (f in answers && sameValue(x, answers[f].value)) leaks.push(t.taskId + " " + path + "." + f + " holds the answer of " + f);
          walk(x, path + "." + f);
        }
      };
      walk(t, "$");
      const text = JSON.stringify(t);
      for (const word of ["key.json", "graders", "benchmarks"]) if (text.includes(word)) leaks.push(t.taskId + " names " + word);
      for (const form of repoPathForms()) if (text.includes(form)) leaks.push(t.taskId + " names the repository path");
    }
    assert.deepEqual(leaks, []);
  });

  test("generation is reproducible: two runs are byte-equal and equal to the committed files", { skip, timeout: 300000 }, () => {
    const outs = [tempDir("gen1"), tempDir("gen2")];
    for (const out of outs) runNode(MODULES.generator, [], { CCB_TASKS_DIR: out });
    const [a, b] = outs.map((o) => listFiles(o).filter((p) => p.startsWith("generated/") || p.startsWith("keys/")));
    assert.ok(a.length > 0, "the generator wrote nothing under CCB_TASKS_DIR (" + outs[0] + "): the lead must wire CCB_TASKS_DIR");
    assert.deepEqual(a, b);
    const committed = [...listFiles(GENERATED).map((p) => "generated/" + p), ...listFiles(KEYS).map((p) => "keys/" + p)].sort();
    assert.deepEqual(a, committed, "generated file list equals the committed list");
    for (const rel of a) {
      const one = readFileSync(join(outs[0], rel));
      assert.ok(one.equals(readFileSync(join(outs[1], rel))), rel + ": two runs differ");
      const local = rel.startsWith("generated/") ? join(GENERATED, rel.slice(10)) : join(KEYS, rel.slice(5));
      assert.ok(one.equals(readFileSync(local)), rel + ": differs from the committed file");
    }
  });
});

// ---------- the mock pipeline ----------

function pipeline(root, batch, runnerExtra = [], env = {}) {
  const e = { CCB_RESULTS_DIR: root, ...env };
  runNode(MODULES.runner, RUNNER_ARGS(batch, runnerExtra), e);
  runNode(MODULES.grader, ["--batch", batch], e);
  runNode(MODULES.analysis, ["--batch", batch], e);
}

describe("end-to-end mock pipeline (MERGED TREE ONLY)", () => {
  const skip = needs("generator", "runner", "mockHost", "grader", "analysis");
  const roots = {};

  before(() => {
    if (skip) return;
    roots.first = tempDir("results1");
    roots.second = tempDir("results2");
    pipeline(roots.first, BATCH);
    pipeline(roots.second, BATCH);
  }, { timeout: 600000 });

  test("runner, grader and analysis write records that pass the validators", { skip }, () => {
    const dirs = runDirs(roots.first, BATCH);
    assert.equal(dirs.length, 6, "smoke is 2 tasks x 3 modes x 1 repetition");
    const tasks = jsonFiles(GENERATED, ".task.json");
    const problems = [];
    for (const d of dirs) {
      const run = readJson(join(d, "run.json"));
      const grade = readJson(join(d, "grade.json"));
      problems.push(...validateRun(run), ...validateGrade(grade, run));
      if (basename(d) !== run.runId) problems.push(basename(d) + ": folder name differs from runId");
      if (run.batch !== BATCH) problems.push(run.runId + ": batch " + run.batch);
      if (!tasks.has(run.taskId + ".task.json")) problems.push(run.runId + ": unknown task");
      else if (tasks.get(run.taskId + ".task.json").profile !== run.profile) problems.push(run.runId + ": profile differs from the task");
      if (run.integrity.violations.length > 0) problems.push(run.runId + ": integrity violation in a mock run");
    }
    const summary = readJson(join(roots.first, BATCH, "summary.json"));
    problems.push(...validateSummary(summary));
    assert.deepEqual(problems, []);
    const report = readFileSync(join(roots.first, BATCH, "report.md"), "utf8");
    assert.ok(report.length > 0, "report.md is empty");
    assert.ok(/exploratory/i.test(report), "the report states that the sample is exploratory");
    for (const m of report.matchAll(/\]\(([^)]+\.svg)\)/g)) assert.ok(existsSync(join(roots.first, BATCH, m[1])), "linked chart " + m[1] + " exists");
  });

  test("each run uses its mode environment (A: no clock variable, B: feedback off, C: feedback unset)", { skip }, () => {
    const seen = new Set();
    for (const d of runDirs(roots.first, BATCH)) {
      const run = readJson(join(d, "run.json"));
      seen.add(run.mode);
      const env = run.env;
      const v = (k) => (env[k] === undefined ? null : env[k]);
      if (run.mode === "A") assert.deepEqual([v("CTX_CLOCK"), v("CTX_CLOCK_FEEDBACK")], [null, null], run.runId);
      if (run.mode === "B") assert.deepEqual([v("CTX_CLOCK"), v("CTX_CLOCK_FEEDBACK")], ["1", "off"], run.runId);
      if (run.mode === "C") assert.deepEqual([v("CTX_CLOCK"), v("CTX_CLOCK_FEEDBACK")], ["1", null], run.runId);
    }
    assert.deepEqual([...seen].sort(), ["A", "B", "C"]);
  });

  test("a second pipeline gives byte-equal grade.json, summary.json and report.md", { skip }, () => {
    const a = runDirs(roots.first, BATCH).map((d) => basename(d));
    const b = runDirs(roots.second, BATCH).map((d) => basename(d));
    assert.deepEqual(a, b);
    for (const id of a) {
      const rel = join(BATCH, "runs", id, "grade.json");
      assert.ok(readFileSync(join(roots.first, rel)).equals(readFileSync(join(roots.second, rel))), id + "/grade.json differs");
    }
    for (const f of ["summary.json", "report.md"]) {
      assert.ok(readFileSync(join(roots.first, BATCH, f)).equals(readFileSync(join(roots.second, BATCH, f))), f + " differs between two pipelines");
    }
  });

  test("batch resume skips finished runs: no duplicate run, records unchanged", { skip, timeout: 300000 }, () => {
    const before = new Map(runDirs(roots.first, BATCH).map((d) => [basename(d), readFileSync(join(d, "run.json"))]));
    runNode(MODULES.runner, RUNNER_ARGS(BATCH), { CCB_RESULTS_DIR: roots.first });
    const after = runDirs(roots.first, BATCH);
    assert.deepEqual(after.map((d) => basename(d)), [...before.keys()], "the same run folders");
    for (const d of after) assert.ok(readFileSync(join(d, "run.json")).equals(before.get(basename(d))), basename(d) + ": run.json changed on resume");
    const ids = after.map((d) => readJson(join(d, "run.json")).runId);
    assert.equal(new Set(ids).size, ids.length, "no runId twice");
  });

  test("the workspace held no key file and no repository path: no record or stream names them", { skip }, () => {
    const forms = repoPathForms();
    const home = homedir();
    const homeForms = [home, home.split("\\").join("/"), home.split("\\").join("\\\\")];
    const bad = [];
    for (const rel of listFiles(roots.first)) {
      const text = readFileSync(join(roots.first, rel), "utf8");
      for (const f of forms) if (text.includes(f)) bad.push(rel + " names the repository path");
      for (const w of [".key.json", "tasks/keys", "tasks\\keys", "graders/"]) if (text.includes(w)) bad.push(rel + " names " + w);
      if (!rel.includes("/raw/")) for (const h of homeForms) if (text.includes(h)) bad.push(rel + " names the home folder (records replace it with a token)");
    }
    assert.deepEqual([...new Set(bad)], []);
  });
});

// ---------- the hand-written fixtures through the real pipeline ----------

describe("fixture transcripts through the real pipeline (MERGED TREE ONLY)", () => {
  const skip = needs("runner", "mockHost", "grader", "analysis");

  test("the recorded runs grade to their expect blocks", { skip, timeout: 600000 }, () => {
    // fixtures/mock has the CCB_TASKS_DIR layout (generated/, keys/). A copy keeps the runner from writing beside it.
    const tasksRoot = tempDir("tasks");
    cpSync(join(FIXTURES, "mock", "generated"), join(tasksRoot, "generated"), { recursive: true });
    cpSync(join(FIXTURES, "mock", "keys"), join(tasksRoot, "keys"), { recursive: true });
    const root = tempDir("results-fixtures");
    const batch = "itest-fixtures";
    const env = { CCB_RESULTS_DIR: root, CCB_TASKS_DIR: tasksRoot, CCB_MOCK_DIR: MOCK_RUNS };
    runNode(MODULES.runner, ["--host", "claude", "--batch", batch, "--suite", "smoke", "--mock", "--tasks", "A0-mock-long,D0-mock-compaction", "--modes", "A,B,C", "--reps", "2"], env);
    runNode(MODULES.grader, ["--batch", batch], env);
    runNode(MODULES.analysis, ["--batch", batch], env);
    const problems = [];
    for (const name of readdirSync(MOCK_RUNS).sort()) {
      const tr = readJson(join(MOCK_RUNS, name));
      const runId = "claude__" + tr.taskId + "__" + tr.mode + "__r" + tr.rep;
      const dir = join(root, batch, "runs", runId);
      if (!existsSync(join(dir, "run.json"))) { problems.push(runId + ": no run.json"); continue; }
      const run = readJson(join(dir, "run.json"));
      const grade = readJson(join(dir, "grade.json"));
      problems.push(...validateRun(run), ...validateGrade(grade, run));
      const ex = tr.expect;
      if (run.status !== ex.status) problems.push(runId + ": status " + run.status + ", expected " + ex.status);
      for (const k of ["valid", "success", "score", "continuityErrors", "preCompaction", "checkpoint"]) {
        if (k in ex && JSON.stringify(grade[k]) !== JSON.stringify(ex[k])) problems.push(runId + ": " + k + " " + JSON.stringify(grade[k]) + ", expected " + JSON.stringify(ex[k]));
      }
      if ("integrityViolations" in ex && run.integrity.violations.length < ex.integrityViolations) problems.push(runId + ": the integrity scan missed the key path");
      const comps = tr.turns.filter((t) => t.kind === "compact").map((t) => ({ afterStage: t.afterStage, confirmed: t.result.confirmed }));
      const got = run.compactions.map((c) => ({ afterStage: c.afterStage, confirmed: c.confirmed }));
      if (ex.status === "completed" && JSON.stringify(got) !== JSON.stringify(comps)) problems.push(runId + ": compactions " + JSON.stringify(got) + ", expected " + JSON.stringify(comps));
      if (tr.mode === "C" && ex.status === "completed" && run.telemetry.clockFeedbackCount === 0) problems.push(runId + ": mode C snapshots not counted");
    }
    problems.push(...validateSummary(readJson(join(root, batch, "summary.json"))));
    assert.deepEqual(problems, []);
  });
});

