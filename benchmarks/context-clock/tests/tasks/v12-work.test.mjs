// Tests of the work-result set tasks/v12-work (docs/context-clock/PLAN-standalone.md, step 2.6) and of the hidden-test
// grader graders/work-tests.mjs: 3 tasks that end in code, 8 stages with compactions after stages 3, 5 and 7, a code
// base in workspace.files, hidden tests out of the task file, the reference solution passes every hidden test, a
// solution with replaced values fails, and the grader runs agent code only in a limited child process.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "../../tasks/generator/v07.mjs";
import { V12_SETS } from "../../tasks/generator/v12.mjs";
import { V12_WORK_TASKS, WORK_COMPACT_AFTER, WORK_DIR, WORK_KINDS, canon, generateWorkSet, moduleFunction, solutionSource, validateWork } from "../../tasks/generator/v12work.mjs";
import { gradeWorkRun, isWorkTask, runWorkTests } from "../../graders/work-tests.mjs";

const read = (rel) => readFileSync(join(WORK_DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const IDS = ["K13-shipping-quote", "K13-password-policy", "K13-retry-policy"];
const taskText = V12_WORK_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V12_WORK_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const testsOf = V12_WORK_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.tests.json`)));
const solutions = V12_WORK_TASKS.map((s) => read(`reference/${s.taskId}.solution.mjs`));
const kinds = V12_WORK_TASKS.map((s) => WORK_KINDS[s.kind]);

/** A workspace copy with the code base of task i and, if given, the module source. Returns the folder. */
function workspace(i, source) {
  const dir = mkdtempSync(join(tmpdir(), "ccb-work-"));
  for (const f of tasks[i].workspace.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  if (source !== null) writeFileSync(join(dir, testsOf[i].module), source);
  return dir;
}
function scoreOf(i, source, opts) {
  const dir = workspace(i, source);
  try {
    return runWorkTests(dir, testsOf[i], opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const passShare = (i, req) => testsOf[i].cases.filter((c) => canon(moduleFunction(kinds[i], req)(...structuredClone(c.args))) === canon(c.expect)).length / testsOf[i].cases.length;

describe("v12-work task set", () => {
  test("3 tasks of category K and shape work, one module each", () => {
    assert.deepEqual(V12_WORK_TASKS.map((s) => s.taskId), IDS);
    assert.deepEqual(readdirSync(join(WORK_DIR, "generated")).sort(), IDS.map((id) => `${id}.task.json`).sort());
    assert.deepEqual(readdirSync(join(WORK_DIR, "keys")).sort(), IDS.flatMap((id) => [`${id}.key.json`, `${id}.tests.json`]).sort());
    assert.deepEqual(readdirSync(join(WORK_DIR, "reference")).sort(), IDS.flatMap((id) => [`${id}.solution.mjs`, `${id}.state.json`]).sort());
    for (const t of tasks) {
      assert.equal(t.category, "K", t.taskId);
      assert.equal(t.shape, "work", t.taskId);
      assert.ok(isWorkTask(t), t.taskId);
    }
  });

  test("8 stages, compactions after stages 3, 5 and 7, no checkpoint, no final question, a final prompt that names the module", () => {
    for (const [i, t] of tasks.entries()) {
      assert.equal(t.profile, "compaction");
      assert.equal(t.stages.length, 8);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), WORK_COMPACT_AFTER);
      assert.equal(t.checkpoint, null);
      assert.deepEqual(t.final.questions, []);
      assert.ok(t.final.prompt.includes(testsOf[i].module), t.taskId);
      for (const s of t.stages) for (const f of s.files) assert.ok(f.path.startsWith(`inbox/s${s.stage}/`), f.path);
    }
  });

  test("the code base: workspace.files is a list of { path, content } with a stub module, and collect names the module folder", () => {
    for (const [i, t] of tasks.entries()) {
      assert.ok(Array.isArray(t.workspace.files) && t.workspace.files.every((f) => typeof f.path === "string" && typeof f.content === "string"));
      const stub = t.workspace.files.find((f) => f.path === testsOf[i].module);
      assert.ok(stub && stub.content.includes("not implemented"), t.taskId);
      assert.ok(t.workspace.collect.some((p) => testsOf[i].module.startsWith(p + "/")), t.taskId);
      // No stage file can overwrite the code base.
      const ws = new Set(t.workspace.files.map((f) => f.path));
      for (const s of t.stages) for (const f of s.files) assert.ok(!ws.has(f.path), f.path);
    }
  });

  test("the hidden tests, the key and the solution stay out of the task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const word of ["\"expect\"", "\"cases\"", "REQUIREMENTS", "\"history\"", "\"current\"", "lastChangedStage"]) assert.ok(!raw.includes(word), `${tasks[i].taskId}: ${word}`);
      assert.ok(!raw.includes(kinds[i].logic.split("\n")[2]), tasks[i].taskId);
    }
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateWorkSet();
    assert.equal(Object.keys(files).length, 15);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of V12_WORK_TASKS) assert.equal(seeds[s.taskId], frozen.tasks.find((x) => x.taskId === s.taskId).seed, s.taskId);
  });

  test("FROZEN.json: status candidate and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.set, "v12-work");
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), IDS);
    for (const x of frozen.tasks) {
      for (const part of ["task", "key", "tests", "reference", "solution"]) {
        const text = read(x[part].path);
        assert.equal(sha256(text), x[part].sha256, x[part].path);
        assert.equal(Buffer.byteLength(text, "utf8"), x[part].bytes, x[part].path);
      }
    }
  });

  test("the rules of the set pass on the committed files", () => {
    for (const [i, s] of V12_WORK_TASKS.entries()) validateWork(s, kinds[i], tasks[i], keys[i], testsOf[i]);
  });

  test("hidden tests: each replaced value fails a case, and only the current requirements pass every case", () => {
    for (const [i, t] of tasks.entries()) {
      const cur = keys[i].current;
      assert.equal(passShare(i, cur), 1, t.taskId);
      for (const r of keys[i].requirements) {
        assert.deepEqual(r.history.at(-1), cur[r.id], `${t.taskId} ${r.id}`);
        for (const old of r.history.slice(0, -1)) {
          if (canon(old) === canon(cur[r.id])) continue;
          // Some case fails with this replaced value (a case can serve more than one replaced value).
          assert.ok(passShare(i, { ...cur, [r.id]: old }) < 1, `${t.taskId} ${r.id} ${canon(old)}`);
        }
      }
      const initial = Object.fromEntries(keys[i].requirements.map((r) => [r.id, r.history[0]]));
      assert.ok(passShare(i, initial) <= 0.7, t.taskId);
    }
  });

  test("the grader: the reference solution scores 1, the stub and a missing module score 0, the initial requirements score at most 0.7", () => {
    for (const [i, t] of tasks.entries()) {
      const sol = scoreOf(i, solutions[i]);
      assert.equal(sol.score, 1, `${t.taskId} ${JSON.stringify(sol.error)}`);
      assert.equal(sol.passed, testsOf[i].cases.length);
      assert.equal(scoreOf(i, null).score, 0, t.taskId);
      const initial = Object.fromEntries(keys[i].requirements.map((r) => [r.id, r.history[0]]));
      assert.ok(scoreOf(i, solutionSource(V12_WORK_TASKS[i], kinds[i], initial)).score <= 0.7, t.taskId);
    }
    const dir = mkdtempSync(join(tmpdir(), "ccb-work-"));
    try {
      const r = runWorkTests(dir, testsOf[0]);
      assert.equal(r.score, 0);
      assert.match(r.error, /module missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the grader runs agent code in a limited child process: a hang times out, a printed fake result does not count, a write is denied", () => {
    const i = 0;
    const hang = scoreOf(i, `export function ${testsOf[i].exportName}() { for (;;) {} }`, { timeoutMs: 1500 });
    assert.equal(hang.timedOut, true);
    assert.equal(hang.score, 0);
    const fake = scoreOf(i, `for (let k = 0; k < 50; k += 1) console.log("WT-x " + k + " null");\nexport function ${testsOf[i].exportName}() { return null; }\n`);
    assert.equal(fake.score, 0);
    if (process.allowedNodeEnvironmentFlags.has("--permission")) {
      const dir = workspace(i, `import { writeFileSync } from "node:fs";\nwriteFileSync("written.txt", "x");\n` + solutions[i]);
      try {
        const r = runWorkTests(dir, testsOf[i]);
        assert.equal(r.score, 0);
        assert.equal(existsSync(join(dir, "written.txt")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("gradeWorkRun: a completed valid run gets the hidden-test score, an invalid or failed run gets 0", () => {
    const i = 1;
    const dir = workspace(i, solutions[i]);
    try {
      const run = { schema: 1, runId: "r1", taskId: tasks[i].taskId, status: "completed", integrity: { violations: [] } };
      const ok = gradeWorkRun(tasks[i], testsOf[i], run, dir);
      assert.equal(ok.valid, true);
      assert.equal(ok.success, true);
      assert.equal(ok.score, 1);
      assert.equal(ok.work.total, testsOf[i].cases.length);
      const bad = gradeWorkRun(tasks[i], testsOf[i], { ...run, integrity: { violations: ["path outside the workspace"] } }, dir);
      assert.equal(bad.valid, false);
      assert.equal(bad.score, 0);
      assert.equal(gradeWorkRun(tasks[i], testsOf[i], { ...run, status: "timeout" }, dir).score, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("question tasks are not work tasks, and the earlier v12 sets do not change", () => {
    for (const name of ["v12", "v12-hard", "v12-indep", "v12-noharm"]) {
      const d = V12_SETS[name].dir;
      const f = JSON.parse(readFileSync(join(d, "FROZEN.json"), "utf8"));
      for (const x of f.tasks) {
        assert.equal(isWorkTask(JSON.parse(readFileSync(join(d, x.task.path), "utf8"))), false, x.taskId);
        for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(d, x[part].path), "utf8")), x[part].sha256, x[part].path);
      }
    }
  });
});
