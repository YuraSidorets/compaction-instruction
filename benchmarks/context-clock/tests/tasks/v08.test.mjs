// Tests of the v0.8 task set (EXPERIMENT-V08.md, section "Tasks"): 6 new tasks from the v0.7 generators at base
// difficulty, structure, new names and values, hashes, the solver equals the key (with the fixed key metadata of
// keyfix.mjs), reference schema 2, the fact links, no key text in a task file, and the grader with no change.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers, createMachine } from "../../tasks/generator/reference.mjs";
import { stateFacts, stateText } from "../../tasks/generator/refstate.mjs";
import { fixAnswer, queryVars, touches } from "../../tasks/generator/keyfix.mjs";
import { SIDE_IDS, V07_DIR, V07_RANGE, V07_STATE_TEXT_MAX_BYTES, V07_TASKS, isConditionQuestion, isReasonQuestion, sha256, v07Spec, validateV07 } from "../../tasks/generator/v07.mjs";
import { V08_DIR, V08_TASKS, generateAllV08 } from "../../tasks/generator/v08.mjs";
import { V06_TASKS } from "../../tasks/generator/v06.mjs";
import { V04_TASKS } from "../../tasks/generator/v04.mjs";
import { V03_TASKS } from "../../tasks/generator/v03.mjs";
import { TASKS } from "../../tasks/generator/tasks.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";
import { validateTask } from "../../fixtures/schema.mjs";

const read = (rel) => readFileSync(join(V08_DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V08_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V08_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V08_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V08_TASKS.map((s) => ({ ...v07Spec(s, frozen.difficulty), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const bytes = (s) => Buffer.byteLength(s, "utf8");
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const RULE_WORDS = new Set(["pending", "applied", "failed", "always-allowed"]);

describe("v08 task set", () => {
  test("6 tasks with ids <letter>11-<slug>, the letter is the category, two tasks share the letter A", () => {
    assert.deepEqual(V08_TASKS.map((s) => s.taskId), ["A11-mobile-backend", "A11-video-pipeline", "B11-ride-hailing", "C11-insurance-claims", "D11-storage-policy", "E11-loyalty-program"]);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(V08_DIR, dir)).sort(), V08_TASKS.map((s) => `${s.taskId}.${ext}.json`).sort(), dir);
    }
    // The smoke suite takes the first id in order with the prefix A11.
    assert.equal(V08_TASKS.map((s) => s.taskId).filter((id) => id.startsWith("A11")).sort()[0], "A11-mobile-backend");
    for (const t of tasks) {
      assert.match(t.taskId, /^[A-E]11-[a-z0-9-]+$/);
      assert.equal(t.taskId[0], t.category, t.taskId);
    }
  });

  test("same structure as v07: 8 stages, exactly 3 compactions after stages 3, 5 and 7, probes, 8 to 10 final questions", () => {
    for (const t of tasks) {
      assert.equal(t.profile, "compaction");
      assert.equal(t.stages.length, 8, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [3, 5, 7], t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
      const total = t.stages.reduce((a, s) => a + [...s.files, ...s.feeds].reduce((b, f) => b + bytes(f.content), 0), 0);
      assert.ok(total >= V07_RANGE[0] && total <= V07_RANGE[1], `${t.taskId}: ${total}`);
    }
  });

  test("new seeds, slugs, values and tracked item names: nothing of an earlier set repeats, no v07 fact name repeats", () => {
    const old = [
      ...TASKS.map((s) => [s, join(V08_DIR, "..", "generated")]),
      ...V03_TASKS.map((s) => [s, join(V08_DIR, "..", "v03", "generated")]),
      ...V04_TASKS.map((s) => [s, join(V08_DIR, "..", "v04", "generated")]),
      ...V06_TASKS.map((s) => [s, join(V08_DIR, "..", "v06", "generated")]),
      ...V07_TASKS.map((s) => [s, join(V07_DIR, "generated")]),
    ];
    const oldOptions = new Set();
    const oldSeeds = new Set();
    for (const [s, dir] of old) {
      const t = JSON.parse(readFileSync(join(dir, `${s.taskId}.task.json`), "utf8"));
      oldSeeds.add(t.seed);
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) oldOptions.add(o);
    }
    const v07Names = new Set(V07_TASKS.flatMap((s) => JSON.parse(readFileSync(join(V07_DIR, "reference", `${s.taskId}.state.json`), "utf8")).states.flatMap((x) => x.facts.map((f) => f.name))));
    const slug = (id) => id.replace(/^[A-Z]\d+-/, "");
    for (const [i, t] of tasks.entries()) {
      assert.ok(!old.some(([s]) => slug(s.taskId) === slug(t.taskId)), t.taskId);
      assert.ok(!oldSeeds.has(t.seed), t.taskId);
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        for (const o of q.options ?? []) assert.ok(RULE_WORDS.has(o) || /^\d+$/.test(o) || !oldOptions.has(o), `${t.taskId} ${q.id}: ${o}`);
      }
      for (const s of refFiles[i].states) for (const f of s.facts) assert.ok(!v07Names.has(f.name), `${t.taskId}: ${f.name}`);
    }
  });

  test("the generator is deterministic and reproduces every committed file byte for byte", () => {
    const a = generateAllV08();
    const b = generateAllV08();
    assert.deepEqual(a, b);
    assert.equal(Object.keys(a.files).length, 18);
    for (const [rel, content] of Object.entries(a.files)) assert.equal(read(rel), content, rel);
    for (const s of V08_TASKS) assert.equal(a.seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json: status candidate or frozen, the generator commit, the seeds, the SHA-256 and bytes of every file", () => {
    assert.equal(frozen.schema, 1);
    assert.ok(["candidate", "frozen"].includes(frozen.status), frozen.status);
    assert.equal(frozen.difficulty, 1);
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), V08_TASKS.map((s) => s.taskId));
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.baseSeed, V08_TASKS[i].seed, x.taskId);
      assert.equal(x.seed, tasks[i].seed, x.taskId);
      assert.ok(x.seed >= x.baseSeed, x.taskId);
      assert.deepEqual(x.compactAfter, [3, 5, 7]);
      for (const f of [x.task, x.key, x.reference]) {
        assert.equal(sha256(read(f.path)), f.sha256, f.path);
        assert.equal(bytes(read(f.path)), f.bytes, f.path);
      }
    }
  });

  test("every task and key pair passes the v03 and v07 rules, and the shared validator except its two known limits", () => {
    const known = [/one or two stages with compactAfter/, /final\.questions must hold 5 to 8 questions \(got (9|10)\)/];
    for (const [i, t] of tasks.entries()) {
      const problems = validateTask(t, keys[i]);
      assert.deepEqual(problems.filter((p) => !known.some((re) => re.test(p))), [], t.taskId);
      const r = validateV03(t, keys[i], refs[i]);
      assert.ok(r.stable >= 3 && r.changed >= 2 && r.decisiveInBig <= 1, `${t.taskId}: ${JSON.stringify(r)}`);
      assert.doesNotThrow(() => validateV07(t, keys[i], refs[i], specs[i]), t.taskId);
    }
  });

  test("two tasks hold reason and condition state: A11-video-pipeline and C11-insurance-claims", () => {
    const i = V08_TASKS.findIndex((s) => s.taskId === "A11-video-pipeline");
    const c = V08_TASKS.findIndex((s) => s.taskId === "C11-insurance-claims");
    assert.ok(refFiles[i].states.at(-1).facts.filter((f) => f.name.startsWith("reason for the ")).length >= 5);
    assert.ok(refs[i].questions.filter(isReasonQuestion).length >= 3);
    for (const f of refFiles[i].states.at(-1).facts.filter((x) => x.name.startsWith("reason for "))) assert.match(f.value, /^why-[a-z]+$/);
    assert.ok(refFiles[c].states.at(-1).facts.filter((f) => f.name.startsWith("condition of the ")).length >= 3);
    assert.ok(refs[c].questions.filter(isConditionQuestion).length >= 3);
    for (const [k, t] of tasks.entries()) if (k !== i && k !== c) assert.ok(!refFiles[k].states.at(-1).facts.some((f) => /^(reason for|condition of) /.test(f.name)), t.taskId);
  });
});

describe("v08 keys", () => {
  test("the solver equals the key: the reference machine and the key fix give every answer", () => {
    for (const [i, t] of tasks.entries()) {
      const ref = refs[i];
      const want = computeAnswers(ref.vars, ref.events, ref.questions);
      const fixed = Object.fromEntries(Object.entries(want).map(([id, a]) => [id, fixAnswer(ref.vars, ref.events, ref.questions.find((q) => q.id === id), a)]));
      assert.deepEqual(strip(keys[i].answers), fixed, t.taskId);
      for (const p of t.checkpoint.probes) {
        const qs = p.questionIds.map((id) => ref.checkpointQuestions.find((q) => q.id === id));
        const at = computeAnswers(ref.vars, ref.events, qs, p.afterStage);
        for (const q of qs) assert.deepEqual(strip({ [q.id]: keys[i].checkpointAnswers[q.id] })[q.id], fixAnswer(ref.vars, ref.events, q, at[q.id], p.afterStage), `${t.taskId} ${q.id}`);
      }
    }
  });

  test("key metadata: each cited event touches a variable of its question, and no answer cites an unrelated first event", () => {
    let changed = 0;
    for (const [i, t] of tasks.entries()) {
      const ref = refs[i];
      const byId = new Map(ref.events.map((e) => [e.id, e]));
      const pairs = [...ref.questions.map((q) => [q, keys[i].answers[q.id]]), ...ref.checkpointQuestions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];
      for (const [q, a] of pairs) {
        assert.ok(a.establishedBy.length > 0, `${t.taskId} ${q.id}`);
        const S = new Set(queryVars(q.query));
        for (const id of a.establishedBy) assert.ok(touches(byId.get(id), S, ref.vars, ref.events), `${t.taskId} ${q.id}: ${id}`);
        assert.ok(a.lastChangedStage >= a.firstEstablishedStage, `${t.taskId} ${q.id}`);
      }
      // The old rule: the answers whose old metadata differ.
      const old = computeAnswers(ref.vars, ref.events, ref.questions);
      for (const q of ref.questions) if (JSON.stringify(old[q.id].establishedBy) !== JSON.stringify(keys[i].answers[q.id].establishedBy)) changed += 1;
    }
    assert.ok(changed >= 3, `${changed} final answers changed`);
  });

  test("an allowed-now answer names the events that set the current condition and the current value of its flag", () => {
    const c = V08_TASKS.findIndex((s) => s.kind === "C");
    const ref = refs[c];
    const t = tasks[c];
    const stageOf = new Map([...ref.questions.map((q) => [q.id, Infinity]), ...t.checkpoint.probes.flatMap((p) => p.questionIds.map((id) => [id, p.afterStage]))]);
    let n = 0;
    for (const q of [...ref.questions, ...ref.checkpointQuestions].filter((x) => x.query.q === "allowed")) {
      const a = (q.id.startsWith("q") ? keys[c].answers : keys[c].checkpointAnswers)[q.id];
      const timeline = ref.events.filter((e) => e.stage <= stageOf.get(q.id));
      const m = createMachine(ref.vars);
      for (const e of timeline) m.apply(e.op);
      const cond = m.valueOf(q.query.cond);
      const rule = q.query.rules[cond];
      const cited = a.establishedBy.map((id) => timeline.find((e) => e.id === id));
      // The condition: the last set of the condition variable, and it set the current condition.
      const condSets = timeline.filter((e) => e.op.op === "set" && e.op.var === q.query.cond);
      assert.ok(cited.includes(condSets.at(-1)), `${q.id}: condition event`);
      assert.equal(condSets.at(-1).op.value, cond, q.id);
      if (rule) {
        const flagEvent = cited.find((e) => e.op.var === rule.var);
        assert.ok(flagEvent, `${q.id}: flag event`);
        assert.equal(flagEvent.op.value, m.valueOf(rule.var), q.id);
        assert.equal(a.establishedBy.length, 2, q.id);
      } else assert.equal(a.establishedBy.length, 1, q.id);
      assert.equal(a.value, rule === null ? true : m.valueOf(rule.var) === rule.eq, q.id);
      n += 1;
    }
    assert.ok(n >= 2, `${n} allowed questions`);
  });

  test("the key metadata of tasks/v07 does not change: its files still match its FROZEN.json", () => {
    const f = JSON.parse(readFileSync(join(V07_DIR, "FROZEN.json"), "utf8"));
    for (const x of f.tasks) for (const e of [x.task, x.key, x.reference]) assert.equal(sha256(readFileSync(join(V07_DIR, e.path), "utf8")), e.sha256, e.path);
  });

  test("reference schema 2: one state for each compaction, facts from the state machine, fact links of the keys", () => {
    for (const [i, rf] of refFiles.entries()) {
      assert.deepEqual(Object.keys(rf), ["schema", "taskId", "states"]);
      assert.equal(rf.schema, 2);
      assert.deepEqual(rf.states.map((s) => s.afterStage), [3, 5, 7]);
      for (const s of rf.states) {
        assert.ok(bytes(s.text) <= V07_STATE_TEXT_MAX_BYTES, `${rf.taskId}: ${bytes(s.text)}`);
        assert.equal(s.text, stateText(refs[i].vars, refs[i].events, s.afterStage, SIDE_IDS));
        assert.deepEqual(s.facts, stateFacts(refs[i].vars, refs[i].events, s.afterStage, SIDE_IDS));
      }
      const names = new Set(rf.states.flatMap((s) => s.facts.map((f) => f.name)));
      for (const a of [...Object.values(keys[i].answers), ...Object.values(keys[i].checkpointAnswers)]) {
        assert.ok("fact" in a);
        if (a.fact) assert.ok(names.has(a.fact.name) && ["current", "history"].includes(a.fact.part), `${rf.taskId}: ${a.fact.name}`);
      }
    }
  });

  test("no key text and no reference text is in a task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\""]) assert.ok(!raw.includes(field), `${tasks[i].taskId}: ${field}`);
      for (const s of refFiles[i].states) {
        assert.ok(!raw.includes(`state after stage ${s.afterStage}`), tasks[i].taskId);
        for (const line of s.text.split("\n")) if (line.includes(" history: ")) assert.ok(!raw.includes(line), `${tasks[i].taskId}: ${line}`);
      }
    }
  });

  test("the grader grades the new tasks unchanged: it accepts each key value and rejects each stale value", () => {
    for (const [i, t] of tasks.entries()) {
      const pairs = [...t.final.questions.map((q) => [q, keys[i].answers[q.id]]), ...t.checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];
      for (const [q, a] of pairs) {
        assert.equal(gradeAnswer(q, a, a.value).correct, true, `${t.taskId} ${q.id}`);
        for (const s of a.staleValues) assert.equal(gradeAnswer(q, a, s).correct, false, `${t.taskId} ${q.id} stale`);
      }
    }
  });
});
