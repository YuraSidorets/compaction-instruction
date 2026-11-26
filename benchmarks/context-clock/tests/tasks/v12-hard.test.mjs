// Tests of the harder set tasks/v12-hard (docs/context-clock/PLAN-standalone.md, phase 1b): 6 tasks, 2 of each shape,
// with 12 stages, compactions after stages 2, 4, 6, 8 and 10, about twice the tracked items and changes for each
// stage of tasks/v09, more distractors, and history questions of depth 3 or more. Also the generator reproduces
// every file, the hashes, one correct answer for each question, the solver equals the key, and the grader.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { fixAnswer } from "../../tasks/generator/keyfix.mjs";
import { sha256 } from "../../tasks/generator/v07.mjs";
import { V09_DIR, V09_TASKS, fullSpec, isReasonQuestionV09, nameValueLines } from "../../tasks/generator/v09.mjs";
import { HARD_COMPACT_AFTER, V12_HARD_TASKS, V12_SETS, generateSet, isDeepQuestion, validateHard } from "../../tasks/generator/v12.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";

const DIR = V12_SETS["v12-hard"].dir;
const read = (rel) => readFileSync(join(DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const IDS = ["A14-platform-program", "A14-media-observability", "W14-ledger-and-login", "W14-search-and-ledger", "X14-retention-and-release", "X14-edge-and-retention"];
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V12_HARD_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V12_HARD_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V12_HARD_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V12_HARD_TASKS.map((s) => ({ ...fullSpec(s), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const allPairs = (i) => [...tasks[i].final.questions.map((q) => [q, keys[i].answers[q.id]]), ...tasks[i].checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];

// The v09 tasks of part 1 as the base of the comparisons, by shape.
const v09 = V09_TASKS.map((s) => ({
  shape: s.shape,
  task: JSON.parse(readFileSync(join(V09_DIR, "generated", `${s.taskId}.task.json`), "utf8")),
  key: JSON.parse(readFileSync(join(V09_DIR, "keys", `${s.taskId}.key.json`), "utf8")),
  ref: JSON.parse(readFileSync(join(V09_DIR, "reference", `${s.taskId}.state.json`), "utf8")),
}));
const perStage = (task, key, kind) => key.events.filter((e) => e.stage > 0 && (kind === "conflict" ? e.kind === "conflict" : e.kind !== "noise" && e.kind !== "conflict")).length / task.stages.length;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

describe("v12-hard task set", () => {
  test("6 tasks, 2 of each shape, with new ids", () => {
    assert.deepEqual(V12_HARD_TASKS.map((s) => s.taskId), IDS);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(DIR, dir)).sort(), IDS.map((id) => `${id}.${ext}.json`).sort(), dir);
    }
    assert.deepEqual(tasks.map((t) => t.shape), ["old", "old", "worklog", "worklog", "decision", "decision"]);
    for (const t of tasks) assert.equal(t.taskId[0], t.category, t.taskId);
  });

  test("12 stages, compactions after stages 2, 4, 6, 8 and 10, a probe of 4 to 6 questions after each, 10 to 12 final questions", () => {
    for (const t of tasks) {
      assert.equal(t.profile, "compaction", t.taskId);
      assert.equal(t.stages.length, 12, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), HARD_COMPACT_AFTER, t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), HARD_COMPACT_AFTER, t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, t.taskId);
      assert.ok(t.final.questions.length >= 10 && t.final.questions.length <= 12, t.taskId);
    }
  });

  test("about twice the tracked items and twice the changes for each stage of the v09 tasks of the same shape, and more distractors", () => {
    for (const shape of ["old", "worklog", "decision"]) {
      const base = v09.filter((x) => x.shape === shape);
      const hard = tasks.map((t, i) => ({ t, k: keys[i], r: refFiles[i] })).filter((x) => x.t.shape === shape);
      const facts = mean(hard.map((x) => x.r.states.at(-1).facts.length)) / mean(base.map((x) => x.ref.states.at(-1).facts.length));
      const changes = mean(hard.map((x) => perStage(x.t, x.k, "state"))) / mean(base.map((x) => perStage(x.task, x.key, "state")));
      const distract = mean(hard.map((x) => perStage(x.t, x.k, "conflict"))) / mean(base.map((x) => perStage(x.task, x.key, "conflict")));
      assert.ok(facts >= 1.7 && facts <= 2.4, `${shape} facts ratio ${facts}`);
      assert.ok(changes >= 1.6 && changes <= 2.8, `${shape} changes ratio ${changes}`);
      assert.ok(distract >= 1.8, `${shape} distractor ratio ${distract}`);
    }
  });

  test("at least 3 final questions of history depth 3 or more, and at least 3 reason questions in the reason and decision tasks", () => {
    for (const [i, t] of tasks.entries()) {
      const qs = refs[i].questions;
      assert.ok(qs.filter((q) => isDeepQuestion(q, keys[i].answers[q.id])).length >= 3, t.taskId);
      if (specs[i].kind === "F" || t.shape === "decision") assert.ok(qs.filter(isReasonQuestionV09).length >= 3, t.taskId);
      // A question two values back has an answer that differs from the current value.
      for (const q of qs.filter((x) => x.query.q === "previous" && x.query.steps === 2)) {
        const cur = computeAnswers(refs[i].vars, refs[i].events, [{ id: "x", query: { q: "value", var: q.query.var } }]).x.value;
        assert.notEqual(keys[i].answers[q.id].value, cur, `${t.taskId} ${q.id}`);
      }
    }
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateSet("v12-hard");
    assert.equal(Object.keys(files).length, 18);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of V12_HARD_TASKS) assert.equal(seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json: status candidate and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.set, "v12-hard");
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), IDS);
    for (const x of frozen.tasks) {
      for (const part of ["task", "key", "reference"]) {
        const text = read(x[part].path);
        assert.equal(sha256(text), x[part].sha256, x[part].path);
        assert.equal(Buffer.byteLength(text, "utf8"), x[part].bytes, x[part].path);
      }
    }
  });

  test("the shared rules and the rules of the harder set pass on the committed files", () => {
    for (const [i, s] of specs.entries()) {
      validateV03(tasks[i], keys[i], refs[i]);
      validateHard(tasks[i], keys[i], refs[i], s);
    }
  });

  test("each question has exactly one correct answer of its type, and the solver equals the key", () => {
    for (const [i, t] of tasks.entries()) {
      for (const [q, a] of allPairs(i)) {
        const at = `${t.taskId} ${q.id}`;
        assert.ok(a.value !== null && a.value !== undefined, at);
        if (q.type === "choice") assert.equal(q.options.filter((o) => o === String(a.value)).length, 1, at);
        else if (q.type === "set") assert.ok(Array.isArray(a.value) && a.value.length > 0 && a.value.every((x) => q.options.includes(String(x))), at);
        else if (q.type === "int") assert.ok(Number.isInteger(a.value), at);
        else assert.equal(typeof a.value, "boolean", at);
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

  test("no \"name: value\" source line in the new shapes, unique fact names, no key text in a task file", () => {
    for (const [i, t] of tasks.entries()) {
      if (t.shape !== "old") assert.deepEqual(nameValueLines(t, refs[i].vars), [], t.taskId);
      assert.deepEqual(refFiles[i].states.map((s) => s.afterStage), HARD_COMPACT_AFTER);
      for (const st of refFiles[i].states) assert.equal(new Set(st.facts.map((f) => f.name)).size, st.facts.length, t.taskId);
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "\"facts\"", "\"query\"", "\"templates\""]) assert.ok(!taskText[i].includes(field), `${t.taskId}: ${field}`);
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
});
