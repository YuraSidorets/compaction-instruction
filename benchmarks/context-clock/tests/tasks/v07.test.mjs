// Tests of the v0.7 task set (EXPERIMENT-V07.md, section "Tasks"): 6 harder tasks with 8 stages and 3 compactions,
// determinism, key agreement with the reference state machine, reference schema 2 with facts (reasons and conditions
// included), the fact links of the keys, the explicit rules of each intro, no key or reference text in a task file,
// the grader with no change, and the candidate FROZEN.json.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { stateFacts, stateText } from "../../tasks/generator/refstate.mjs";
import {
  SIDE_IDS, V07_DIR, V07_RANGE, V07_RULES, V07_STATE_TEXT_MAX_BYTES, V07_TASKS, generateAllV07, generateOneV07,
  isConditionQuestion, isReasonQuestion, sha256, v07Spec, validateV07,
} from "../../tasks/generator/v07.mjs";
import { V06_DIR, V06_TASKS } from "../../tasks/generator/v06.mjs";
import { V04_TASKS } from "../../tasks/generator/v04.mjs";
import { V03_TASKS } from "../../tasks/generator/v03.mjs";
import { TASKS } from "../../tasks/generator/tasks.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";
import { validateTask } from "../../fixtures/schema.mjs";

const read = (rel) => readFileSync(join(V07_DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = V07_TASKS.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = V07_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = V07_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = V07_TASKS.map((s) => ({ ...v07Spec(s, frozen.difficulty), seed: seedOf(s) }));
const refs = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const bytes = (s) => Buffer.byteLength(s, "utf8");
const canon = (v) => (Array.isArray(v) ? JSON.stringify(v.map(String).sort()) : JSON.stringify(v));
const shown = (q, v) => (q.type === "bool" ? (v ? "ON" : "OFF") : Array.isArray(v) ? v.map(String).sort() : String(v));
const questionOf = (i, id) => [...refs[i].questions, ...refs[i].checkpointQuestions].find((q) => q.id === id);
const lastFacts = (i) => refFiles[i].states.at(-1).facts.filter((f) => f.kind === "scalar");
const meanChanges = (facts) => facts.reduce((a, f) => a + (f.history ? f.history.length : 0), 0) / facts.length;

describe("v07 task set", () => {
  test("6 tasks, two A10 and B10, C10, D10, E10, with 8 stages and exactly 3 compactions, after stages 3, 5 and 7", () => {
    assert.deepEqual(V07_TASKS.map((s) => s.taskId.slice(0, 4)), ["A10-", "A10-", "B10-", "C10-", "D10-", "E10-"]);
    assert.equal(new Set(V07_TASKS.map((s) => s.taskId)).size, 6);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(V07_DIR, dir)).sort(), V07_TASKS.map((s) => `${s.taskId}.${ext}.json`).sort(), dir);
    }
    for (const t of tasks) {
      assert.match(t.taskId, /^[A-E]10-[a-z0-9-]+$/);
      assert.equal(t.taskId[0], t.category, t.taskId);
      assert.equal(t.profile, "compaction");
      assert.equal(t.stages.length, 8, t.taskId);
      assert.equal(t.stages.filter((s) => s.compactAfter).length, 3, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [3, 5, 7], t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
    }
  });

  test("the material of each task is 1.3 to 1.5 times the bytes of a v06 task", () => {
    const v06 = V06_TASKS.map((s) => JSON.parse(readFileSync(join(V06_DIR, "generated", `${s.taskId}.task.json`), "utf8")).params.approxBytes);
    const mean = v06.reduce((a, b) => a + b, 0) / v06.length;
    for (const t of tasks) {
      const total = t.stages.reduce((a, s) => a + [...s.files, ...s.feeds].reduce((b, f) => b + bytes(f.content), 0), 0);
      assert.equal(total, t.params.approxBytes, t.taskId);
      assert.ok(total >= V07_RANGE[0] && total <= V07_RANGE[1], `${t.taskId}: ${total}`);
      assert.ok(total / mean >= 1.3 && total / mean <= 1.5, `${t.taskId}: ${(total / mean).toFixed(2)} times`);
    }
  });

  test("harder than the matching earlier task: about twice the facts and more changes for each item", () => {
    const earlier = (dir, id) => JSON.parse(readFileSync(join(V07_DIR, "..", dir, "reference", `${id}.state.json`), "utf8"));
    const match = { A: ["v06", "A9-api-gateway"], F: ["v06", "A9-api-gateway"], B: ["v06", "B9-logistics-teams"], C: ["v06", "C9-billing-migration"], E: ["v06", "E9-export-service"] };
    for (const [i, s] of V07_TASKS.entries()) {
      const facts = refFiles[i].states.at(-1).facts;
      assert.ok(facts.length >= s.minFacts, `${s.taskId}: ${facts.length} facts`);
      if (!match[s.kind]) continue;
      const old = earlier(...match[s.kind]).states.at(-1).facts;
      assert.ok(facts.length >= 2 * old.length, `${s.taskId}: ${facts.length} facts against ${old.length}`);
      const oldScalars = old.filter((f) => f.kind === "scalar");
      assert.ok(meanChanges(lastFacts(i)) > meanChanges(oldScalars), `${s.taskId}: ${meanChanges(lastFacts(i))} changes for each item`);
    }
    // D10 against D8 of v0.4 (reference schema 1, history lines in the text): 8 parameters, 9 changes.
    const d = V07_TASKS.findIndex((s) => s.kind === "D");
    const d8 = earlier("v04", "D8-security-baseline").states.at(-1).text.split("\n").filter((l) => l.includes(" history: "));
    const d8Changes = d8.reduce((a, l) => a + l.split(", then ").length - 1, 0) / 8;
    assert.ok(refFiles[d].states.at(-1).facts.length >= 16);
    assert.ok(meanChanges(lastFacts(d)) > d8Changes, `D10: ${meanChanges(lastFacts(d))} against ${d8Changes}`);
  });

  test("no content of an earlier folder is reused: new slugs, seeds and scenario values", () => {
    const old = [
      ...TASKS.map((s) => [s, join(V07_DIR, "..", "generated")]),
      ...V03_TASKS.map((s) => [s, join(V07_DIR, "..", "v03", "generated")]),
      ...V04_TASKS.map((s) => [s, join(V07_DIR, "..", "v04", "generated")]),
      ...V06_TASKS.map((s) => [s, join(V07_DIR, "..", "v06", "generated")]),
    ];
    const oldOptions = new Set();
    for (const [s, dir] of old) {
      const t = JSON.parse(readFileSync(join(dir, `${s.taskId}.task.json`), "utf8"));
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) oldOptions.add(o);
    }
    const generic = new Set(["pending", "applied", "failed"]); // migration statuses are rule words, not scenario values
    const slug = (id) => id.replace(/^[A-Z]\d+-/, "");
    for (const t of tasks) {
      assert.ok(!old.some(([s]) => slug(s.taskId) === slug(t.taskId)), t.taskId);
      assert.ok(!old.some(([s]) => s.seed === t.seed), t.taskId);
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        for (const o of q.options ?? []) assert.ok(generic.has(o) || /^\d+$/.test(o) || !oldOptions.has(o), `${t.taskId} ${q.id}: ${o}`);
      }
    }
  });

  test("the generator is deterministic and reproduces every committed file byte for byte", () => {
    const a = generateAllV07({ difficulty: frozen.difficulty });
    const b = generateAllV07({ difficulty: frozen.difficulty });
    assert.deepEqual(a, b);
    assert.equal(Object.keys(a.files).length, 18);
    for (const [rel, content] of Object.entries(a.files)) assert.equal(read(rel), content, rel);
    for (const s of V07_TASKS) assert.equal(a.seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("FROZEN.json is a candidate: generator commit, difficulty, seeds, SHA-256 and bytes of every file", () => {
    assert.equal(frozen.schema, 1);
    assert.ok(["candidate", "frozen"].includes(frozen.status));
    assert.equal(frozen.difficulty, 1);
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), V07_TASKS.map((s) => s.taskId));
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.baseSeed, V07_TASKS[i].seed, x.taskId);
      assert.equal(x.seed, tasks[i].seed, x.taskId);
      assert.ok(x.seed >= x.baseSeed, x.taskId);
      assert.deepEqual(x.compactAfter, [3, 5, 7]);
      for (const f of [x.task, x.key, x.reference]) {
        assert.equal(sha256(read(f.path)), f.sha256, f.path);
        assert.equal(bytes(read(f.path)), f.bytes, f.path);
      }
    }
  });

  test("a difficulty is a seed-stable regeneration: more items and changes, the same rules", () => {
    for (const s of V07_TASKS) {
      const one = v07Spec(s, 1);
      const two = v07Spec(s, 2);
      assert.ok(two.entities >= one.entities && two.updates > one.updates, s.taskId);
      assert.deepEqual(two.v07.rules, one.v07.rules);
    }
    // One task at difficulty 2 from its recorded seed: it passes every rule and differs from difficulty 1.
    const e = V07_TASKS.find((s) => s.kind === "E");
    const r = generateOneV07(e, { difficulty: 2, tries: 1 });
    assert.equal(r.seed, e.found[2]);
    assert.notEqual(r.files[`generated/${e.taskId}.task.json`], read(`generated/${e.taskId}.task.json`));
  });

  test("every task and key pair passes the v03 and v07 rules, and the shared validator except the compaction count", () => {
    for (const [i, t] of tasks.entries()) {
      // fixtures/schema.mjs allows one or two compactions and 5 to 8 final questions. v0.7 asks for three compactions
      // and 8 to 10 final questions: an open point for the owner of that file. No other problem is allowed.
      const known = [/one or two stages with compactAfter/, /final\.questions must hold 5 to 8 questions \(got (9|10)\)/];
      const problems = validateTask(t, keys[i]);
      assert.deepEqual(problems.filter((p) => !known.some((re) => re.test(p))), [], t.taskId);
      assert.ok(problems.some((p) => known[0].test(p)), t.taskId);
      const r = validateV03(t, keys[i], refs[i]);
      assert.ok(r.stable >= 3 && r.changed >= 2 && r.decisiveInBig <= 1, `${t.taskId}: ${JSON.stringify(r)}`);
      assert.doesNotThrow(() => validateV07(t, keys[i], refs[i], specs[i]), t.taskId);
    }
  });
});

describe("v07 explicit semantics", () => {
  test("the intro states every rule of the task after the initial specification", () => {
    for (const [i, t] of tasks.entries()) {
      const at = t.intro.indexOf("Rules for this task:");
      assert.ok(at > t.intro.indexOf("Initial specification:"), t.taskId);
      for (const rule of V07_RULES[V07_TASKS[i].kind]) assert.ok(t.intro.includes(rule), `${t.taskId}: ${rule}`);
    }
  });

  test("question texts name one reading: direct dependencies, the status now, no final status", () => {
    for (const t of tasks) {
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) assert.doesNotMatch(q.text, /final status|depend on/, `${t.taskId} ${q.id}`);
    }
    for (const t of taskText) assert.ok(!t.includes("was not kept"));
  });

  test("the final set has current-state and history questions", () => {
    for (const [i, t] of tasks.entries()) {
      const kinds = refs[i].questions.map((q) => q.query.q);
      assert.ok(kinds.some((k) => k === "value" || k === "members"), t.taskId);
      assert.ok(kinds.some((k) => k === "initial" || k === "superseded"), t.taskId);
    }
  });

  test("A10-observability-stack: each new decision of an item with a reason is followed by an entry that records its reason", () => {
    const i = V07_TASKS.findIndex((s) => s.kind === "F");
    const ref = refs[i];
    const reasonOf = Object.fromEntries(Object.keys(ref.vars).filter((id) => id.startsWith("reason.")).map((id) => [id.slice(7), id]));
    assert.ok(Object.keys(reasonOf).length >= 5);
    const main = ref.events.filter((e) => e.op.op !== "noise");
    let decisions = 0;
    main.forEach((e, k) => {
      if (e.stage === 0 || e.op.op !== "set" || !reasonOf[e.op.var]) return;
      decisions += 1;
      const next = main[k + 1];
      assert.equal(next.op.op, "set", e.id);
      assert.equal(next.op.var, reasonOf[e.op.var], e.id);
      assert.equal(next.stage, e.stage, e.id);
    });
    assert.ok(decisions >= 10, `${decisions} decisions`);
    // Every reason entry changes the reason: no entry repeats the current reason.
    const cur = {};
    for (const e of ref.events) {
      if (e.op.op !== "set" || !e.op.var.startsWith("reason.")) continue;
      assert.notEqual(cur[e.op.var], e.op.value, e.id);
      cur[e.op.var] = e.op.value;
    }
    const qs = ref.questions.filter(isReasonQuestion);
    assert.ok(qs.length >= 3);
    assert.deepEqual(new Set(qs.map((q) => q.type)), new Set(["choice", "set", "int"]));
    for (const f of refFiles[i].states.at(-1).facts.filter((x) => x.name.startsWith("reason for "))) assert.ok(POOL_REASON.test(f.value), f.name);
  });

  test("C10: the condition facts decide whether a permit item is allowed, and a flag change never changes a condition", () => {
    const i = V07_TASKS.findIndex((s) => s.kind === "C");
    const ref = refs[i];
    const conds = Object.keys(ref.vars).filter((id) => id.startsWith("cond."));
    assert.ok(conds.length >= 3);
    for (const e of ref.events) if (e.op.op === "rollback") for (const v of e.op.vars) assert.ok(!v.startsWith("cond."), e.id);
    const qs = [...ref.questions, ...ref.checkpointQuestions].filter(isConditionQuestion);
    assert.ok(ref.questions.filter(isConditionQuestion).length >= 3);
    assert.ok(ref.questions.some((q) => q.query.q === "allowed" && q.type === "bool"));
    // An allowed answer at a probe follows from the condition fact and the flag fact of that stage.
    let checked = 0;
    for (const p of tasks[i].checkpoint.probes) {
      const facts = new Map(refFiles[i].states.find((s) => s.afterStage === p.afterStage).facts.map((f) => [f.name, f.value]));
      for (const id of p.questionIds) {
        const q = qs.find((x) => x.id === id);
        if (!q || q.query.q !== "allowed") continue;
        const c = facts.get(`condition of ${ref.vars[q.query.cond].permit}`);
        const rule = q.query.rules[c];
        const want = rule === null ? true : facts.get(ref.vars[rule.var].label.replace(/^the /, "")) === (rule.eq ? "ON" : "OFF");
        assert.equal(keys[i].checkpointAnswers[id].value, want, id);
        checked += 1;
      }
    }
    assert.ok(checked >= 1, "no allowed question in a probe");
  });
});

const POOL_REASON = /^rsn-[a-z-]+$/;

describe("v07 keys and reference files", () => {
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

  test("reference schema 2: one state for each compaction, text of at most 4000 bytes, facts from the state machine", () => {
    for (const [i, rf] of refFiles.entries()) {
      assert.deepEqual(Object.keys(rf), ["schema", "taskId", "states"]);
      assert.equal(rf.schema, 2);
      assert.equal(rf.taskId, tasks[i].taskId);
      assert.deepEqual(rf.states.map((s) => s.afterStage), [3, 5, 7]);
      for (const s of rf.states) {
        assert.deepEqual(Object.keys(s), ["afterStage", "text", "facts"]);
        assert.ok(bytes(s.text) <= V07_STATE_TEXT_MAX_BYTES, `${rf.taskId}: ${bytes(s.text)}`);
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
    const names = (kind) => refFiles[V07_TASKS.findIndex((s) => s.kind === kind)].states.at(-1).facts.map((f) => f.name);
    assert.ok(names("F").filter((n) => n.startsWith("reason for the ")).length >= 5);
    assert.ok(names("C").filter((n) => n.startsWith("condition of the ")).length >= 3);
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
          const q = questionOf(i, id);
          if (!a.fact || !["value", "members"].includes(q.query.q)) continue;
          assert.equal(canon(shown(q, a.value)), canon(facts.get(a.fact.name).value), `${t.taskId} ${id}`);
        }
      }
    }
    assert.ok(linked >= 120, `only ${linked} answers have a fact`);
  });

  test("no key text and no reference text is in a task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\""]) {
        assert.ok(!raw.includes(field), `${tasks[i].taskId}: ${field}`);
      }
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
