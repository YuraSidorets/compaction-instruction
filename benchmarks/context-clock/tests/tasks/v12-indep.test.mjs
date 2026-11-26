// Tests of the independent set tasks/v12-indep (docs/context-clock/PLAN-standalone.md, step 2.5): 2 tasks of the
// incident shape (kind T), designed without the instruction text, with the run protocol and size of tasks/v12:
// 8 stages, compactions after stages 3, 5 and 7, a probe after each compaction. Also the generator reproduces every
// file, the hashes, the shared and v0.9 rules, one correct answer for each question, the solver equals the key, no
// "name: value" source line, unique fact names, no key text in a task file, the grader, and earlier sets stay the same.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { fixAnswer } from "../../tasks/generator/keyfix.mjs";
import { V07_TASKS, sha256 } from "../../tasks/generator/v07.mjs";
import { V08_TASKS } from "../../tasks/generator/v08.mjs";
import { V09_TASKS, fullSpec, longSpec, nameValueLines, validateV09 } from "../../tasks/generator/v09.mjs";
import { V12_HARD_TASKS, V12_INCIDENT_TASKS, V12_SETS, V12_TASKS, generateSet } from "../../tasks/generator/v12.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";

const DIR = V12_SETS["v12-indep"].dir;
const read = (rel) => readFileSync(join(DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const IDS = ["T13-payments-outage", "T13-login-incident"];
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V12_INCIDENT_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V12_INCIDENT_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V12_INCIDENT_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V12_INCIDENT_TASKS.map((s) => ({ ...fullSpec(s), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const allPairs = (i) => [...tasks[i].final.questions.map((q) => [q, keys[i].answers[q.id]]), ...tasks[i].checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];
const v12Task = (id) => JSON.parse(readFileSync(join(V12_SETS.v12.dir, "generated", `${id}.task.json`), "utf8"));

describe("v12-indep task set (incident shape)", () => {
  test("2 tasks of kind T and shape incident, with new ids and new seeds", () => {
    assert.deepEqual(V12_INCIDENT_TASKS.map((s) => s.taskId), IDS);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(DIR, dir)).sort(), IDS.map((id) => `${id}.${ext}.json`).sort(), dir);
    }
    for (const t of tasks) {
      assert.equal(t.category, "T", t.taskId);
      assert.equal(t.shape, "incident", t.taskId);
    }
    const earlier = [...V07_TASKS, ...V08_TASKS, ...V09_TASKS, longSpec(), ...V12_TASKS, ...V12_HARD_TASKS];
    const ids = new Set(earlier.map((s) => s.taskId));
    const seeds = new Set(earlier.flatMap((s) => [s.seed, ...Object.values(s.found ?? {})]));
    for (const s of V12_INCIDENT_TASKS) {
      assert.ok(!ids.has(s.taskId), s.taskId);
      assert.ok(!seeds.has(seedOf(s)), s.taskId);
    }
  });

  test("the protocol of tasks/v12: 8 stages, compactions after stages 3, 5 and 7, a probe after each compaction", () => {
    for (const t of tasks) {
      assert.equal(t.profile, "compaction", t.taskId);
      assert.equal(t.stages.length, 8, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.equal(t.checkpoint.timing, "after_compaction", t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [3, 5, 7], t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
    }
  });

  test("the size of the tasks/v12 worklog tasks: material within 10% and deliveries within 3", () => {
    const w = v12Task("W13-billing-cutover");
    const deliveries = (t) => t.stages.reduce((a, s) => a + s.files.length + s.feeds.length, 0);
    for (const t of tasks) {
      assert.ok(Math.abs(t.params.approxBytes / w.params.approxBytes - 1) <= 0.1, `${t.taskId} ${t.params.approxBytes}`);
      assert.ok(Math.abs(deliveries(t) - deliveries(w)) <= 3, t.taskId);
    }
  });

  test("the questions ask role history, the affected set, the finished actions and the cause", () => {
    for (const [i, t] of tasks.entries()) {
      const qs = refs[i].questions;
      assert.ok(qs.some((q) => q.query.q === "previous"), t.taskId);
      assert.ok(qs.some((q) => q.query.q === "superseded"), t.taskId);
      assert.ok(qs.some((q) => q.query.q === "members"), t.taskId);
      assert.ok(qs.some((q) => q.query.q === "whereEq"), t.taskId);
      assert.ok(qs.some((q) => q.query.var === "cause"), t.taskId);
      assert.ok(refFiles[i].states.at(-1).facts.length >= 15, t.taskId);
    }
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateSet("v12-indep");
    assert.equal(Object.keys(files).length, 6);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of V12_INCIDENT_TASKS) assert.equal(seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json: status candidate, the seeds, the shape and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.set, "v12-indep");
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

  test("each question has exactly one correct answer of its type, and the solver equals the key", () => {
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
      const ref = refs[i];
      const answers = computeAnswers(ref.vars, ref.events, ref.questions);
      assert.deepEqual(Object.fromEntries(ref.questions.map((q) => [q.id, fixAnswer(ref.vars, ref.events, q, answers[q.id])])), strip(keys[i].answers), t.taskId);
      const stageOf = new Map(t.checkpoint.probes.flatMap((p) => p.questionIds.map((id) => [id, p.afterStage])));
      const cps = Object.fromEntries(ref.checkpointQuestions.map((q) => {
        const up = stageOf.get(q.id);
        return [q.id, fixAnswer(ref.vars, ref.events, q, computeAnswers(ref.vars, ref.events, [q], up)[q.id], up)];
      }));
      assert.deepEqual(cps, strip(keys[i].checkpointAnswers), t.taskId);
    }
  });

  test("no \"name: value\" source line, unique fact names and valid fact links, no key text in a task file", () => {
    for (const [i, t] of tasks.entries()) {
      assert.deepEqual(nameValueLines(t, refs[i].vars), [], t.taskId);
      const rf = refFiles[i];
      assert.equal(rf.schema, 2);
      assert.deepEqual(rf.states.map((x) => x.afterStage), [3, 5, 7]);
      for (const st of rf.states) assert.equal(new Set(st.facts.map((f) => f.name)).size, st.facts.length, `${t.taskId} ${st.afterStage}`);
      const names = new Set(rf.states.flatMap((x) => x.facts.map((f) => f.name)));
      for (const a of [...Object.values(keys[i].answers), ...Object.values(keys[i].checkpointAnswers)]) if (a.fact) assert.ok(names.has(a.fact.name), t.taskId);
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\"", "\"templates\""]) assert.ok(!taskText[i].includes(field), `${t.taskId}: ${field}`);
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

  test("tasks/v12 and tasks/v12-hard do not change: their files match their FROZEN.json", () => {
    for (const name of ["v12", "v12-hard"]) {
      const d = V12_SETS[name].dir;
      const f = JSON.parse(readFileSync(join(d, "FROZEN.json"), "utf8"));
      for (const x of f.tasks) for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(d, x[part].path), "utf8")), x[part].sha256, x[part].path);
    }
  });
});
