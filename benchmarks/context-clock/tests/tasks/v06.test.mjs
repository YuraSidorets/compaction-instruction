// Tests of the v0.6 task set (EXPERIMENT-V06.md, sections "Tasks" and "Interfaces"): determinism, key agreement with
// the reference state machine, reference schema 2 with facts, the fact links of the keys, the explicit rules of each
// intro, no key or reference text in a task file, and frozen hashes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { STATE_TEXT_MAX_BYTES, stateFacts, stateText } from "../../tasks/generator/refstate.mjs";
import { SIDE_IDS, V06_DIR, V06_RANGE, V06_RULES, V06_TASKS, generateAllV06, sha256, validateV06 } from "../../tasks/generator/v06.mjs";
import { V04_TASKS } from "../../tasks/generator/v04.mjs";
import { V03_TASKS } from "../../tasks/generator/v03.mjs";
import { TASKS } from "../../tasks/generator/tasks.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";
import { validateTask } from "../../fixtures/schema.mjs";

const read = (rel) => readFileSync(join(V06_DIR, rel), "utf8");
const taskText = V06_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V06_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V06_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const refs = V06_TASKS.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const bytes = (s) => Buffer.byteLength(s, "utf8");
const canon = (v) => (Array.isArray(v) ? JSON.stringify(v.map(String).sort()) : JSON.stringify(v));
const shown = (q, v) => (q.type === "bool" ? (v ? "ON" : "OFF") : Array.isArray(v) ? v.map(String).sort() : String(v));
const questionOf = (i, id) => [...refs[i].questions, ...refs[i].checkpointQuestions].find((q) => q.id === id);

describe("v06 task set", () => {
  test("4 tasks A9, B9, C9 and E9 with 7 stages and compactions after stages 4 and 6", () => {
    assert.deepEqual(V06_TASKS.map((s) => s.taskId.slice(0, 3)), ["A9-", "B9-", "C9-", "E9-"]);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(V06_DIR, dir)).sort(), V06_TASKS.map((s) => `${s.taskId}.${ext}.json`).sort(), dir);
    }
    for (const t of tasks) {
      assert.match(t.taskId, /^[ABCE]9-[a-z0-9-]+$/);
      assert.equal(t.profile, "compaction");
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [4, 6], t.taskId);
      assert.equal(Math.max(...t.stages.map((s) => s.stage)), 7, t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [4, 6], t.taskId);
      const total = t.stages.reduce((a, s) => a + [...s.files, ...s.feeds].reduce((b, f) => b + bytes(f.content), 0), 0);
      assert.ok(total >= V06_RANGE[0] && total <= V06_RANGE[1], `${t.taskId}: ${total}`);
    }
  });

  test("no content of an earlier folder is reused: new slugs, seeds and scenario values", () => {
    const old = [
      ...TASKS.map((s) => [s, join(V06_DIR, "..", "generated")]),
      ...V03_TASKS.map((s) => [s, join(V06_DIR, "..", "v03", "generated")]),
      ...V04_TASKS.map((s) => [s, join(V06_DIR, "..", "v04", "generated")]),
    ];
    const oldOptions = new Set();
    for (const [s, dir] of old) {
      const t = JSON.parse(readFileSync(join(dir, `${s.taskId}.task.json`), "utf8"));
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) oldOptions.add(o);
    }
    const generic = new Set(["pending", "applied", "failed"]); // migration statuses are rule words, not scenario values
    for (const t of tasks) {
      assert.ok(!old.some(([s]) => s.taskId.slice(3) === t.taskId.slice(3)), t.taskId);
      assert.ok(!old.some(([s]) => s.seed === t.seed), t.taskId);
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        for (const o of q.options ?? []) assert.ok(generic.has(o) || /^\d+$/.test(o) || !oldOptions.has(o), `${t.taskId} ${q.id}: ${o}`);
      }
    }
  });

  test("the generator is deterministic and reproduces every committed file byte for byte", () => {
    const a = generateAllV06();
    const b = generateAllV06();
    assert.deepEqual(a, b);
    assert.equal(Object.keys(a).length, 12);
    for (const [rel, content] of Object.entries(a)) assert.equal(read(rel), content, rel);
  });

  test("FROZEN.json holds the generator commit, the seeds and the SHA-256 of every task, key and reference file", () => {
    const frozen = JSON.parse(read("FROZEN.json"));
    assert.equal(frozen.schema, 1);
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), V06_TASKS.map((s) => s.taskId));
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.seed, V06_TASKS[i].seed, x.taskId);
      for (const f of [x.task, x.key, x.reference]) assert.equal(sha256(read(f.path)), f.sha256, f.path);
    }
  });

  test("every task and key pair passes the shared validator, the v03 rules and the v06 rules", () => {
    for (const [i, t] of tasks.entries()) {
      assert.deepEqual(validateTask(t, keys[i]), [], t.taskId);
      const r = validateV03(t, keys[i], refs[i]);
      assert.ok(r.stable >= 3 && r.changed >= 2 && r.decisiveInBig <= 1, `${t.taskId}: ${JSON.stringify(r)}`);
      assert.doesNotThrow(() => validateV06(t, keys[i], refs[i]), t.taskId);
    }
  });
});

describe("v06 explicit semantics", () => {
  test("the intro states the rules of the category after the initial specification", () => {
    for (const t of tasks) {
      const at = t.intro.indexOf("Rules for this task:");
      assert.ok(at > t.intro.indexOf("Initial specification:"), t.taskId);
      for (const rule of V06_RULES[t.category]) assert.ok(t.intro.includes(rule), `${t.taskId}: ${rule}`);
    }
  });

  test("C9: every run event says that it sets the status, and no event leaves a run result open", () => {
    const c9 = tasks.find((t) => t.category === "C");
    const material = c9.stages.flatMap((s) => [...s.files, ...s.feeds].map((f) => f.content)).join("\n");
    const runs = material.split("\n").filter((l) => /\bran migration m\d|Run of migration m\d/.test(l));
    assert.ok(runs.length >= 3);
    for (const l of runs) assert.match(l, /The run sets the status of migration m\d/, l);
    for (const t of taskText) assert.ok(!t.includes("was not kept"));
    assert.ok(c9.intro.includes("A run event sets the status of its migration to the result of the runbook rule in the event."));
  });

  test("question texts name one reading: direct dependencies, the status now, no final status", () => {
    for (const t of tasks) {
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        assert.doesNotMatch(q.text, /final status|depend on/, `${t.taskId} ${q.id}`);
      }
    }
  });

  test("the final set has current-state and history questions", () => {
    for (const [i, t] of tasks.entries()) {
      const kinds = refs[i].questions.map((q) => q.query.q);
      assert.ok(kinds.some((k) => k === "value" || k === "members"), t.taskId);
      assert.ok(kinds.some((k) => k === "initial" || k === "superseded"), t.taskId);
    }
  });
});

describe("v06 keys and reference files", () => {
  test("each key answer matches the reference state machine", () => {
    for (const [i, t] of tasks.entries()) {
      const ref = refs[i];
      const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
      assert.deepEqual(strip(keys[i].answers), computeAnswers(ref.vars, ref.events, ref.questions), t.taskId);
      for (const p of t.checkpoint.probes) {
        const qs = p.questionIds.map((id) => ref.checkpointQuestions.find((q) => q.id === id));
        const want = computeAnswers(ref.vars, ref.events, qs, p.afterStage);
        for (const id of p.questionIds) assert.deepEqual(strip({ [id]: keys[i].checkpointAnswers[id] })[id], want[id], `${t.taskId} ${id}`);
      }
    }
  });

  test("reference schema 2: one state for stage 4 and one for stage 6, text of v0.4 form, facts from the state machine", () => {
    for (const [i, rf] of refFiles.entries()) {
      assert.deepEqual(Object.keys(rf), ["schema", "taskId", "states"]);
      assert.equal(rf.schema, 2);
      assert.equal(rf.taskId, tasks[i].taskId);
      assert.deepEqual(rf.states.map((s) => s.afterStage), [4, 6]);
      for (const s of rf.states) {
        assert.deepEqual(Object.keys(s), ["afterStage", "text", "facts"]);
        assert.ok(bytes(s.text) <= STATE_TEXT_MAX_BYTES, `${rf.taskId}: ${bytes(s.text)}`);
        assert.equal(s.text, stateText(refs[i].vars, refs[i].events, s.afterStage, SIDE_IDS));
        assert.deepEqual(s.facts, stateFacts(refs[i].vars, refs[i].events, s.afterStage, SIDE_IDS));
        assert.equal(new Set(s.facts.map((f) => f.name)).size, s.facts.length);
        const lines = new Set(s.text.split("\n"));
        for (const f of s.facts) {
          assert.deepEqual(Object.keys(f), ["name", "kind", "value", "history"]);
          assert.ok(f.kind === "scalar" ? typeof f.value === "string" : Array.isArray(f.value) && f.value.every((x) => typeof x === "string"), f.name);
          assert.ok(f.history === null || (Array.isArray(f.history) && f.history.length > 0 && f.history.every((x) => typeof x === "string")), f.name);
          const shownValue = f.kind === "set" ? (f.value.length === 0 ? "(none)" : f.value.join(", ")) : f.value;
          assert.ok(lines.has(`${f.name}: ${shownValue}`), `${rf.taskId}: ${f.name}`);
          if (f.history) assert.ok(lines.has(`${f.name} history: ${[...f.history, f.value].join(", then ")}`), `${rf.taskId}: ${f.name} history`);
        }
      }
    }
  });

  test("each fact in a key names a fact of the reference file, and the fact agrees with the probe answers", () => {
    let linked = 0;
    for (const [i, t] of tasks.entries()) {
      const names = new Set(refFiles[i].states.flatMap((s) => s.facts.map((f) => f.name)));
      const all = [...Object.entries(keys[i].answers), ...Object.entries(keys[i].checkpointAnswers)];
      for (const [id, a] of all) {
        assert.ok("fact" in a, `${t.taskId} ${id}`);
        if (a.fact === null) continue;
        linked += 1;
        assert.deepEqual(Object.keys(a.fact), ["name", "part"]);
        assert.ok(a.fact.part === "current" || a.fact.part === "history");
        assert.ok(names.has(a.fact.name), `${t.taskId} ${id}: ${a.fact.name}`);
      }
      for (const p of t.checkpoint.probes) {
        const facts = new Map(refFiles[i].states.find((s) => s.afterStage === p.afterStage).facts.map((f) => [f.name, f]));
        for (const id of p.questionIds) {
          const a = keys[i].checkpointAnswers[id];
          const q = questionOf(i, `${id}`);
          if (!a.fact || !["value", "members"].includes(q.query.q)) continue;
          assert.equal(canon(shown(q, a.value)), canon(facts.get(a.fact.name).value), `${t.taskId} ${id}`);
        }
      }
    }
    assert.ok(linked >= 40, `only ${linked} answers have a fact`);
  });

  test("no key text and no reference text is in a task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\""]) assert.ok(!raw.includes(field), `${tasks[i].taskId}: ${field}`);
      for (const s of refFiles[i].states) {
        assert.ok(!raw.includes(`state after stage ${s.afterStage}`), tasks[i].taskId);
        for (const line of s.text.split("\n")) if (line.includes(" history: ")) assert.ok(!raw.includes(line), `${tasks[i].taskId}: ${line}`);
      }
      for (const e of keys[i].events) assert.ok(!raw.includes(e.summary) || e.summary === "irrelevant", `${tasks[i].taskId}: ${e.summary}`);
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
