// Tests of the v12 task set, package 1 (docs/context-clock/PLAN-standalone.md, step 2.1): 10 tasks from new seeds of
// the three v0.9 shapes with the settings of tasks/v09 part 1. Structure, new ids and seeds, the generator reproduces
// every file, the hashes, the shared and v0.9 rules, one correct answer for each question, the solver equals the key,
// no "name: value" source line in the new shapes, unique fact names, no key text in a task file, and the grader.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { fixAnswer } from "../../tasks/generator/keyfix.mjs";
import { V07_TASKS, sha256 } from "../../tasks/generator/v07.mjs";
import { V08_TASKS } from "../../tasks/generator/v08.mjs";
import { V09_DIR, V09_TASKS, fullSpec, longSpec, nameValueLines, validateV09 } from "../../tasks/generator/v09.mjs";
import { V12_SETS, V12_TASKS, generateSet } from "../../tasks/generator/v12.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";

const DIR = V12_SETS.v12.dir;
const read = (rel) => readFileSync(join(DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const IDS = ["A13-data-lakehouse", "A13-mobile-checkout", "D13-network-segments", "D13-archive-policy", "W13-billing-cutover", "W13-catalog-search", "W13-auth-migration", "X13-log-retention", "X13-cdn-cutover", "X13-mobile-release"];
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V12_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V12_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V12_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V12_TASKS.map((s) => ({ ...fullSpec(s), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const allPairs = (i) => [...tasks[i].final.questions.map((q) => [q, keys[i].answers[q.id]]), ...tasks[i].checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];

describe("v12 task set (package 1)", () => {
  test("10 tasks: 2 old of kind A, 2 old of kind D, 3 worklog and 3 decision, with new ids", () => {
    assert.deepEqual(V12_TASKS.map((s) => s.taskId), IDS);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(DIR, dir)).sort(), IDS.map((id) => `${id}.${ext}.json`).sort(), dir);
    }
    assert.deepEqual(tasks.map((t) => t.shape), ["old", "old", "old", "old", "worklog", "worklog", "worklog", "decision", "decision", "decision"]);
    assert.deepEqual(V12_TASKS.map((s) => s.kind), ["A", "A", "D", "D", "W", "W", "W", "X", "X", "X"]);
    for (const t of tasks) assert.equal(t.taskId[0], t.category, t.taskId);
    const earlier = [...V07_TASKS, ...V08_TASKS, ...V09_TASKS, longSpec()].map((s) => s.taskId);
    for (const id of IDS) assert.ok(!earlier.includes(id), id);
    assert.ok(IDS.every((id) => /^[A-Z]13-/.test(id)));
  });

  test("new base seeds: no seed of tasks/v07, v08 or v09 repeats", () => {
    const earlier = new Set([...V07_TASKS, ...V08_TASKS, ...V09_TASKS, longSpec()].flatMap((s) => [s.seed, ...Object.values(s.found ?? {})]));
    for (const s of V12_TASKS) {
      assert.ok(!earlier.has(s.seed), s.taskId);
      assert.ok(!earlier.has(seedOf(s)), s.taskId);
    }
  });

  test("the settings of tasks/v09 part 1: 8 stages, compactions after stages 3, 5 and 7, a probe after each compaction", () => {
    const w = V09_TASKS.find((s) => s.shape === "worklog");
    for (const [i, t] of tasks.entries()) {
      assert.equal(t.profile, "compaction", t.taskId);
      assert.equal(t.stages.length, 8, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.equal(t.checkpoint.timing, "after_compaction", t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [3, 5, 7], t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
      assert.deepEqual(specs[i].group, w.group, t.taskId);
      assert.deepEqual(specs[i].range, w.range, t.taskId);
      if (t.shape !== "old") for (const k of ["entities", "updates", "minFacts", "limits"]) assert.deepEqual(specs[i][k], V09_TASKS.find((s) => s.shape === t.shape)[k], `${t.taskId} ${k}`);
    }
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateSet("v12");
    assert.equal(Object.keys(files).length, 30);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of V12_TASKS) assert.equal(seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json: status candidate, the seeds, the shape and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.set, "v12");
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), IDS);
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.shape, tasks[i].shape, x.taskId);
      for (const part of ["task", "key", "reference"]) {
        const text = read(x[part].path);
        assert.equal(sha256(text), x[part].sha256, x[part].path);
        assert.equal(Buffer.byteLength(text, "utf8"), x[part].bytes, x[part].path);
      }
    }
  });

  test("the shared and v0.9 rules pass on the committed files", () => {
    for (const [i, s] of specs.entries()) {
      validateV03(tasks[i], keys[i], refs[i]);
      validateV09(tasks[i], keys[i], refs[i], s);
    }
  });

  test("each question has exactly one correct answer of its type", () => {
    for (const [i, t] of tasks.entries()) {
      for (const [q, a] of allPairs(i)) {
        const at = `${t.taskId} ${q.id}`;
        assert.ok(a.value !== null && a.value !== undefined, at);
        if (q.type === "choice") assert.equal(q.options.filter((o) => o === String(a.value)).length, 1, at);
        else if (q.type === "set") assert.ok(Array.isArray(a.value) && a.value.length > 0 && new Set(a.value).size === a.value.length && a.value.every((x) => q.options.includes(String(x))), at);
        else if (q.type === "int") assert.ok(Number.isInteger(a.value), at);
        else assert.equal(typeof a.value, "boolean", at);
        for (const s of a.staleValues) assert.notEqual(JSON.stringify(s), JSON.stringify(a.value), at);
      }
    }
  });

  test("the solver equals the key", () => {
    for (const [i, ref] of refs.entries()) {
      const answers = computeAnswers(ref.vars, ref.events, ref.questions);
      const fixed = Object.fromEntries(ref.questions.map((q) => [q.id, fixAnswer(ref.vars, ref.events, q, answers[q.id])]));
      assert.deepEqual(fixed, strip(keys[i].answers), tasks[i].taskId);
      const stageOf = new Map(tasks[i].checkpoint.probes.flatMap((p) => p.questionIds.map((id) => [id, p.afterStage])));
      const cps = Object.fromEntries(ref.checkpointQuestions.map((q) => {
        const up = stageOf.get(q.id);
        return [q.id, fixAnswer(ref.vars, ref.events, q, computeAnswers(ref.vars, ref.events, [q], up)[q.id], up)];
      }));
      assert.deepEqual(cps, strip(keys[i].checkpointAnswers), tasks[i].taskId);
    }
  });

  test("the new shapes have no \"name: value\" source line", () => {
    for (const [i, t] of tasks.entries()) if (t.shape !== "old") assert.deepEqual(nameValueLines(t, refs[i].vars), [], t.taskId);
  });

  test("reference schema 2 with unique fact names and valid fact links", () => {
    for (const [i, rf] of refFiles.entries()) {
      assert.equal(rf.schema, 2);
      assert.deepEqual(rf.states.map((x) => x.afterStage), [3, 5, 7]);
      for (const st of rf.states) assert.equal(new Set(st.facts.map((f) => f.name)).size, st.facts.length, `${rf.taskId} ${st.afterStage}`);
      const names = new Set(rf.states.flatMap((x) => x.facts.map((f) => f.name)));
      for (const a of [...Object.values(keys[i].answers), ...Object.values(keys[i].checkpointAnswers)]) if (a.fact) assert.ok(names.has(a.fact.name), rf.taskId);
    }
  });

  test("no key text and no reference text is in a task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\"", "\"templates\""]) assert.ok(!raw.includes(field), `${tasks[i].taskId}: ${field}`);
      for (const s of refFiles[i].states) assert.ok(!raw.includes(`state after stage ${s.afterStage}`), tasks[i].taskId);
    }
  });

  test("the grader accepts each key value and rejects each stale value", () => {
    for (const [i, t] of tasks.entries()) {
      for (const [q, a] of allPairs(i)) {
        assert.equal(gradeAnswer(q, a, a.value).correct, true, `${t.taskId} ${q.id}`);
        for (const s of a.staleValues) assert.equal(gradeAnswer(q, a, s).correct, false, `${t.taskId} ${q.id} stale`);
      }
    }
  });

  test("tasks/v09 does not change: its files match its FROZEN.json", () => {
    const f9 = JSON.parse(readFileSync(join(V09_DIR, "FROZEN.json"), "utf8"));
    for (const x of f9.tasks) for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(V09_DIR, x[part].path), "utf8")), x[part].sha256, x[part].path);
  });
});
