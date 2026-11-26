// The v0.3 mock pipeline on the frozen tasks/v03 files (EXPERIMENT-V03.md): run.mjs --mock --suite v03-smoke, then
// grade.mjs and analyze.mjs. Checks the probe turn order after each compaction, the per-probe questions, valid grades
// from the batch task folder, probe questions in retrieval.json and the three comparisons. No model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V03 = join(BENCH, "tasks", "v03", "generated");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function node(script, args, env) {
  const r = spawnSync(process.execPath, [join(BENCH, script), ...args], { cwd: BENCH, env, encoding: "utf8", timeout: 600000, windowsHide: true });
  assert.equal(r.status, 0, `${script} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** The answer ids in the json block of the result line of one raw turn stream. */
function answeredIds(streamFile) {
  const result = readFileSync(streamFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "result");
  const m = /```json\n([\s\S]*?)\n```/.exec(result.result);
  return Object.keys(JSON.parse(m[1]).answers);
}

test("v03-smoke mock pipeline: probes after each compaction, valid grades, probe retrieval, three comparisons", { skip: !existsSync(V03) && "tasks/v03 is not on this branch" }, () => {
  const results = realpathSync.native(mkdtempSync(join(tmpdir(), "ccbench-test-v03pipe-")));
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "ccbench-test-v03work-")));
  try {
    const env = { ...process.env, CCB_RESULTS_DIR: results };
    delete env.CCB_TASKS_DIR;
    delete env.NODE_TEST_CONTEXT;
    node("runner/run.mjs", ["--mock", "--suite", "v03-smoke", "--batch", "mock-v03", "--work-root", work], env);
    node("graders/grade.mjs", ["--batch", "mock-v03"], env);
    node("analysis/analyze.mjs", ["--batch", "mock-v03"], env);

    const batchDir = join(results, "mock-v03");
    const runIds = readdirSync(join(batchDir, "runs")).sort();
    assert.equal(runIds.length, 6);
    const taskIds = new Set();
    for (const id of runIds) {
      const dir = join(batchDir, "runs", id);
      const run = readJson(join(dir, "run.json"));
      const grade = readJson(join(dir, "grade.json"));
      const task = readJson(join(V03, `${run.taskId}.task.json`));
      taskIds.add(run.taskId);
      const probes = task.checkpoint.probes;
      assert.equal(task.checkpoint.timing, "after_compaction");

      // Turn order: each probe directly after the compaction of its stage, recorded with its stage.
      const want = ["intro"];
      for (const s of task.stages) {
        want.push(`stage:${s.stage}`);
        if (s.compactAfter === true) want.push(`compact:${s.stage}`);
        if (probes.some((p) => p.afterStage === s.stage)) want.push(`checkpoint:${s.stage}`);
      }
      want.push("final");
      assert.deepEqual(run.turns.map((t) => (t.stage ? `${t.kind}:${t.stage}` : t.kind)), want, `${id} turn order`);
      assert.deepEqual(run.compactions.map((c) => [c.afterStage, c.confirmed]), task.stages.filter((s) => s.compactAfter).map((s) => [s.stage, true]));

      // Each probe turn asks only its questionIds; all answers end in answers.checkpoint by question id.
      for (const p of probes) assert.deepEqual(answeredIds(join(batchDir, "raw", id, "a1", `checkpoint-${p.afterStage}.jsonl`)), p.questionIds, `${id} probe after stage ${p.afterStage}`);
      assert.deepEqual(Object.keys(run.answers.checkpoint).sort(), task.checkpoint.questions.map((q) => q.id).sort());

      // Graded from the batch task folder (tasks/v03), with the probe results in grade.checkpoint.
      assert.equal(grade.valid, true, `${id}: ${grade.invalidReason}`);
      assert.equal(grade.status, "completed");
      assert.equal(grade.checkpoint.questions, task.checkpoint.questions.length);
      assert.equal(grade.checkpointItems.length, task.checkpoint.questions.length);

      const retrieval = readJson(join(dir, "retrieval.json"));
      assert.equal(retrieval.questions.filter((q) => q.scope === "probe").length, task.checkpoint.questions.length);
      assert.equal(retrieval.questions.filter((q) => q.scope === "final").length, task.final.questions.length);
    }
    const compactionCounts = [...taskIds].map((t) => readJson(join(V03, `${t}.task.json`)).stages.filter((s) => s.compactAfter).length).sort();
    assert.deepEqual(compactionCounts, [1, 2], "one task with 1 compaction and one with 2");

    const summary = readJson(join(batchDir, "summary.json"));
    assert.deepEqual(summary.comparisons.map((c) => c.id), ["C-D", "D-B", "C-B"]);
  } finally {
    rmSync(results, { recursive: true, force: true, maxRetries: 3 });
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
});
