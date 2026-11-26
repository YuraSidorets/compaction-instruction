// Tests of the no-harm set tasks/v12-noharm (docs/context-clock/PLAN-standalone.md, step 2.5): 3 tasks, one of each
// v0.9 shape, with the protocol and size of tasks/v12 (8 stages, compactions after stages 3, 5 and 7) where no answer
// needs state from before a compaction: every state event of an asked item is in stage 8, after the last compaction.
// Also the generator reproduces every file, the hashes, one correct answer for each question, the solver equals the
// key, no "name: value" source line, unique fact names, no key text in a task file, the grader, and earlier sets.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { fixAnswer } from "../../tasks/generator/keyfix.mjs";
import { V07_TASKS, sha256 } from "../../tasks/generator/v07.mjs";
import { V08_TASKS } from "../../tasks/generator/v08.mjs";
import { V09_TASKS, fullSpec, longSpec, nameValueLines } from "../../tasks/generator/v09.mjs";
import { NOHARM_LAST, V12_HARD_TASKS, V12_INCIDENT_TASKS, V12_NOHARM_TASKS, V12_SETS, V12_TASKS, generateSet, validateNoHarm } from "../../tasks/generator/v12.mjs";
import { checkpointsOf, validateTask } from "../../runner/plan.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";

const DIR = V12_SETS["v12-noharm"].dir;
const read = (rel) => readFileSync(join(DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const IDS = ["A13-late-data-platform", "W13-late-ledger-cleanup", "X13-late-backup-policy"];
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V12_NOHARM_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V12_NOHARM_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V12_NOHARM_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V12_NOHARM_TASKS.map((s) => ({ ...fullSpec(s), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const varsOf = (q) => [q.query.var, ...(q.query.vars ?? [])].filter((x) => typeof x === "string");

describe("v12-noharm task set", () => {
  test("3 tasks, one of each v0.9 shape, with new ids and new seeds", () => {
    assert.deepEqual(V12_NOHARM_TASKS.map((s) => s.taskId), IDS);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(DIR, dir)).sort(), IDS.map((id) => `${id}.${ext}.json`).sort(), dir);
    }
    assert.deepEqual(tasks.map((t) => t.shape), ["old", "worklog", "decision"]);
    for (const t of tasks) assert.equal(t.taskId[0], t.category, t.taskId);
    const earlier = [...V07_TASKS, ...V08_TASKS, ...V09_TASKS, longSpec(), ...V12_TASKS, ...V12_HARD_TASKS, ...V12_INCIDENT_TASKS];
    const ids = new Set(earlier.map((s) => s.taskId));
    const seeds = new Set(earlier.flatMap((s) => [s.seed, ...Object.values(s.found ?? {})]));
    for (const s of V12_NOHARM_TASKS) {
      assert.ok(!ids.has(s.taskId), s.taskId);
      assert.ok(!seeds.has(seedOf(s)), s.taskId);
    }
  });

  test("the protocol of tasks/v12 without probes: 8 stages, compactions after stages 3, 5 and 7, 8 to 10 final questions", () => {
    for (const t of tasks) {
      assert.equal(t.profile, "compaction", t.taskId);
      assert.equal(t.stages.length, 8, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.equal(t.checkpoint, null, t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
      assert.deepEqual(t.final.questions.map((q) => q.id), t.final.questions.map((_, i) => `q${i + 1}`), t.taskId);
    }
  });

  test("the runner accepts the tasks and asks no probe", () => {
    for (const t of tasks) {
      assert.deepEqual(validateTask(t), [], t.taskId);
      assert.deepEqual(checkpointsOf(t), [], t.taskId);
    }
  });

  test("the material of a tasks/v09 task: 92000 to 107000 bytes", () => {
    for (const t of tasks) assert.ok(t.params.approxBytes >= 92000 && t.params.approxBytes <= 107000, `${t.taskId} ${t.params.approxBytes}`);
  });

  test("no answer needs state from before a compaction", () => {
    for (const [i, t] of tasks.entries()) {
      const ref = refs[i];
      const asked = new Set(ref.questions.flatMap(varsOf));
      const kind = new Map(keys[i].events.map((e) => [e.id, e.kind]));
      // No state event of an asked item comes before stage 8, and the answers from stage 8 alone are the key.
      for (const e of ref.events) {
        if (e.stage < NOHARM_LAST && !["noise", "conflict"].includes(kind.get(e.id))) assert.ok(![e.op.var, ...(e.op.vars ?? [])].some((v) => asked.has(v)), `${t.taskId} ${e.id}`);
      }
      const late = computeAnswers(ref.vars, ref.events.filter((e) => e.stage >= NOHARM_LAST), ref.questions);
      for (const q of ref.questions) assert.deepEqual(late[q.id].value, keys[i].answers[q.id].value, `${t.taskId} ${q.id}`);
      // The asked items have no value in the reference state after the last compaction (a set item is empty), so a
      // summary of it does not help.
      const names = new Set(refFiles[i].states.at(-1).facts.filter((f) => !(Array.isArray(f.value) && f.value.length === 0)).map((f) => f.name));
      for (const a of Object.values(keys[i].answers)) if (a.fact) assert.ok(!names.has(a.fact.name), `${t.taskId} ${a.fact.name}`);
      assert.ok(!t.final.questions.some((q) => /specification|first page/.test(q.text)), t.taskId);
    }
  });

  test("each compaction has state to summarize: the items that no question asks change in stages 1 to 7", () => {
    for (const [i, t] of tasks.entries()) {
      assert.ok(refFiles[i].states.every((s) => s.facts.length >= 8), t.taskId);
      validateNoHarm(t, keys[i], refs[i], specs[i]);
    }
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateSet("v12-noharm");
    assert.equal(Object.keys(files).length, 9);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of V12_NOHARM_TASKS) assert.equal(seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json: status candidate, the seeds, the shape and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.set, "v12-noharm");
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

  test("each question has exactly one correct answer of its type, and the solver equals the key", () => {
    for (const [i, t] of tasks.entries()) {
      for (const q of t.final.questions) {
        const a = keys[i].answers[q.id];
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
      assert.deepEqual(keys[i].checkpointAnswers, {}, t.taskId);
    }
  });

  test("no \"name: value\" source line in the new shapes, unique fact names, no key text in a task file", () => {
    for (const [i, t] of tasks.entries()) {
      if (t.shape !== "old") assert.deepEqual(nameValueLines(t, refs[i].vars), [], t.taskId);
      const rf = refFiles[i];
      assert.equal(rf.schema, 2);
      assert.deepEqual(rf.states.map((x) => x.afterStage), [3, 5, 7]);
      for (const st of rf.states) assert.equal(new Set(st.facts.map((f) => f.name)).size, st.facts.length, `${t.taskId} ${st.afterStage}`);
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\"", "\"templates\""]) assert.ok(!taskText[i].includes(field), `${t.taskId}: ${field}`);
    }
  });

  test("the grader accepts each key value and rejects each stale value", () => {
    for (const [i, t] of tasks.entries()) {
      for (const q of t.final.questions) {
        const a = keys[i].answers[q.id];
        assert.equal(gradeAnswer(q, a, a.value).correct, true, `${t.taskId} ${q.id}`);
        for (const s of a.staleValues) assert.equal(gradeAnswer(q, a, s).correct, false, `${t.taskId} ${q.id} stale`);
      }
    }
  });

  test("tasks/v12, v12-hard and v12-indep do not change: their files match their FROZEN.json", () => {
    for (const name of ["v12", "v12-hard", "v12-indep"]) {
      const d = V12_SETS[name].dir;
      const f = JSON.parse(readFileSync(join(d, "FROZEN.json"), "utf8"));
      for (const x of f.tasks) for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(d, x[part].path), "utf8")), x[part].sha256, x[part].path);
    }
  });
});
