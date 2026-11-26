// Tests of the v0.9 task set (EXPERIMENT-V09.md, sections "Tasks" and "Part 2: automatic compaction"): six tasks of
// three shapes and one long task, the two new generators (worklog and decision), determinism from the seed, one
// correct answer for each question, no "name: value" source line in the new shapes, unique fact names, the long-task
// parameters, the hashes, and the grader with no change.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { fixAnswer } from "../../tasks/generator/keyfix.mjs";
import { sha256 } from "../../tasks/generator/v07.mjs";
import { V08_DIR } from "../../tasks/generator/v08.mjs";
import { LONG_DEFAULTS, V09_DIR, V09_TASKS, fullSpec, generateAllV09, generateOneV09, isBlockQuestion, isReasonQuestionV09, longSpec, nameValueLines, validateV09 } from "../../tasks/generator/v09.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";

const read = (rel) => readFileSync(join(V09_DIR, rel), "utf8");
const frozen = JSON.parse(read("FROZEN.json"));
const ALL = [...V09_TASKS, longSpec()];
const IDS = ["A12-mobile-gateway", "D12-backup-policy", "W12-ledger-migration", "W12-shop-search", "X12-data-retention", "X12-cdn-migration", "A13-long-mobile-platform"];
const seedOf = (s) => frozen.tasks.find((x) => x.taskId === s.taskId).seed;
const taskText = ALL.map((s) => read(`generated/${s.taskId}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = ALL.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refFiles = ALL.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const specs = ALL.map((s) => ({ ...fullSpec(s), seed: seedOf(s) }));
const gens = specs.map((s) => generateTask(s, { withReference: true, checkCoverage: false }));
const refs = gens.map((g) => g.reference);
const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, { fact, ...rest }]) => [id, rest]));
const isLong = (s) => Boolean(s.long);
const sources = (t) => [t.intro, ...t.stages.flatMap((s) => [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)])].join("\n");
const allPairs = (i) => [...tasks[i].final.questions.map((q) => [q, keys[i].answers[q.id]]), ...tasks[i].checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];

describe("v09 task set", () => {
  test("7 tasks: two old, two worklog, two decision and one long task, each with the field shape", () => {
    assert.deepEqual(ALL.map((s) => s.taskId), IDS);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(V09_DIR, dir)).sort(), IDS.map((id) => `${id}.${ext}.json`).sort(), dir);
    }
    assert.deepEqual(tasks.map((t) => t.shape), ["old", "old", "worklog", "worklog", "decision", "decision", "old"]);
    assert.deepEqual(tasks.map((t) => t.category), ["A", "D", "W", "W", "X", "X", "A"]);
    for (const t of tasks) {
      assert.equal(t.taskId[0], t.category, t.taskId);
      assert.deepEqual(Object.keys(t).slice(0, 4), ["schema", "taskId", "category", "shape"], t.taskId);
    }
    // The two old-shape tasks come from two different v0.8 generators.
    assert.notEqual(V09_TASKS[0].kind, V09_TASKS[1].kind);
  });

  test("the six tasks have 8 stages, compactions after stages 3, 5 and 7 and a probe after each compaction", () => {
    for (const t of tasks.slice(0, 6)) {
      assert.equal(t.profile, "compaction", t.taskId);
      assert.equal(t.stages.length, 8, t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7], t.taskId);
      assert.equal(t.checkpoint.timing, "after_compaction", t.taskId);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [3, 5, 7], t.taskId);
      assert.ok(t.final.questions.length >= 8 && t.final.questions.length <= 10, t.taskId);
    }
  });

  test("the long task: no compaction in its plan, 24 stages, a probe for every stage boundary, about twice the material of a v0.8 stage", () => {
    const t = tasks[6];
    assert.equal(t.profile, "long");
    assert.equal(t.stages.length, LONG_DEFAULTS.stages);
    assert.ok(t.stages.every((s) => s.compactAfter === false));
    assert.equal(t.checkpoint.timing, "after_auto_compaction");
    assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), Array.from({ length: 23 }, (_, i) => i + 1));
    for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, `probe ${p.afterStage}`);
    assert.deepEqual(t.checkpoint.probes.flatMap((p) => p.questionIds), t.checkpoint.questions.map((q) => q.id));
    const v08 = readdirSync(join(V08_DIR, "generated")).map((f) => JSON.parse(readFileSync(join(V08_DIR, "generated", f), "utf8")));
    const v08Stage = v08.reduce((a, x) => a + x.params.approxBytes / x.stages.length, 0) / v08.length;
    const ratio = t.params.approxBytes / t.stages.length / v08Stage;
    assert.ok(ratio > 1.7 && ratio < 2.3, `material ratio ${ratio}`);
    const f = frozen.tasks.find((x) => x.taskId === t.taskId);
    assert.deepEqual(f.probeAfter, t.checkpoint.probes.map((p) => p.afterStage));
    assert.equal(f.stageBytes, LONG_DEFAULTS.stageBytes);
  });

  test("the stage count and the stage size of the long task are parameters", () => {
    const spec = longSpec({ stages: 10, stageBytes: 16000 });
    const r = generateOneV09(spec, { tries: 40 });
    const t = JSON.parse(r.files[`generated/${spec.taskId}.task.json`]);
    assert.equal(t.stages.length, 10);
    assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(t.params.approxBytes >= spec.range[0] && t.params.approxBytes <= spec.range[1], `${t.params.approxBytes}`);
    const ref = JSON.parse(r.files[`reference/${spec.taskId}.state.json`]);
    assert.deepEqual(ref.states.map((s) => s.afterStage), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("the generator reproduces every committed file", () => {
    const { files, seeds } = generateAllV09();
    assert.equal(Object.keys(files).length, 21);
    for (const [rel, content] of Object.entries(files)) assert.equal(content, read(rel), rel);
    for (const s of ALL) assert.equal(seeds[s.taskId], seedOf(s), s.taskId);
  });

  test("both new generators are deterministic: the same seed gives the same bytes, another seed other bytes", () => {
    for (const base of V09_TASKS.filter((s) => s.shape !== "old")) {
      const a = generateOneV09(base);
      const b = generateOneV09(base);
      assert.deepEqual(a.files, b.files, base.taskId);
      const other = generateTask({ ...fullSpec(base), seed: seedOf(base) + 1 }, { checkCoverage: false });
      assert.notEqual(JSON.stringify(other.task), a.files[`generated/${base.taskId}.task.json`], base.taskId);
    }
  });

  test("FROZEN.json: status candidate, the seeds, the shape and the SHA-256 and bytes of every file", () => {
    assert.ok(["candidate", "frozen"].includes(frozen.status));
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
      if (!isLong(s)) validateV03(tasks[i], keys[i], refs[i]);
      validateV09(tasks[i], keys[i], refs[i], s);
    }
  });

  test("each question has exactly one correct answer: a name, a path, a number or a state of a fixed set", () => {
    for (const [i, t] of tasks.entries()) {
      for (const [q, a] of allPairs(i)) {
        const at = `${t.taskId} ${q.id}`;
        assert.ok(a.value !== null && a.value !== undefined, at);
        if (q.type === "choice") {
          assert.equal(new Set(q.options).size, q.options.length, at);
          assert.equal(q.options.filter((o) => o === String(a.value)).length, 1, at);
        } else if (q.type === "set") {
          assert.ok(Array.isArray(a.value) && a.value.length > 0 && a.value.every((x) => q.options.includes(String(x))), at);
          assert.equal(new Set(a.value).size, a.value.length, at);
        } else if (q.type === "int") assert.ok(Number.isInteger(a.value), at);
        else assert.equal(typeof a.value, "boolean", at);
        for (const s of a.staleValues) assert.notEqual(JSON.stringify(s), JSON.stringify(a.value), at);
      }
    }
  });

  test("the solver equals the key: the reference state machine and the key fix give every answer", () => {
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

  test("the new shapes: no source line has the form \"name: value\"", () => {
    for (const [i, t] of tasks.entries()) {
      if (t.shape === "old") continue;
      assert.deepEqual(nameValueLines(t, refs[i].vars), [], t.taskId);
      // Every tracked fact appears in prose: each state event line holds its label inside a sentence.
      const text = sources(t);
      for (const e of refs[i].events) {
        if (e.op.op !== "set") continue;
        const line = text.split("\n").find((l) => l.includes(`[${e.id}]`));
        const label = refs[i].vars[e.op.var].label;
        if (!refs[i].vars[e.op.var].templates) continue; // side records of the large feeds
        assert.ok(line.includes(label) && !line.includes(`${label}:`), `${t.taskId} ${e.id}`);
      }
    }
  });

  test("worklog: statuses, owners, at most one blocking item, files with a status; questions about what blocks what and earlier values in order", () => {
    for (const [i, t] of tasks.entries()) {
      if (t.shape !== "worklog") continue;
      const vars = refs[i].vars;
      const ids = Object.keys(vars);
      assert.ok(ids.filter((id) => id.endsWith(".status")).length >= 6, t.taskId);
      assert.ok(ids.filter((id) => id.endsWith(".blocker")).every((id) => vars[id].type === "scalar"), t.taskId);
      assert.ok(ids.filter((id) => id.startsWith("file.")).length >= 5, t.taskId);
      const qs = refs[i].questions;
      assert.ok(qs.filter(isBlockQuestion).length >= 2, t.taskId);
      assert.ok(qs.some((q) => q.query.q === "previous"), t.taskId);
      assert.ok(qs.some((q) => q.query.q === "whereEq" && q.query.vars[0].startsWith("file.")), t.taskId);
      // Distractors: proposals, withdrawn drafts, archived copies and corrections.
      const raw = sources(t);
      for (const phrase of ["Nobody decided it", "withdr", "is history only", "Correction"]) assert.ok(raw.includes(phrase), `${t.taskId}: ${phrase}`);
    }
  });

  test("decision: decisions with a reason, constraints that the user sets and lifts, open questions that get an answer or stay open", () => {
    for (const [i, t] of tasks.entries()) {
      if (t.shape !== "decision") continue;
      const ref = refs[i];
      const qs = ref.questions;
      assert.ok(qs.filter(isReasonQuestionV09).length >= 2, t.taskId);
      assert.ok(qs.some((q) => q.query.q === "previous" && q.query.var.startsWith("reason.")), t.taskId);
      // A reason changes alone: an event sets a reason with no decision event of the same item in the same stage.
      const alone = ref.events.filter((e) => e.op.op === "set" && e.op.var.startsWith("reason.") && e.stage > 0 && !ref.events.some((x) => x.stage === e.stage && x.op.op === "set" && x.op.var === e.op.var.replace("reason.", "decision.")));
      assert.ok(alone.length > 0, t.taskId);
      const lifted = ref.events.filter((e) => e.op.op === "set" && e.op.var.startsWith("constraint.") && e.op.value === "lifted");
      assert.ok(lifted.length > 0, t.taskId);
      const final = keys[i].answers;
      const open = qs.find((q) => q.query.q === "whereEq" && q.query.value === "still-open");
      assert.ok(final[open.id].value.length >= 1 && final[open.id].value.length < open.query.vars.length, t.taskId);
      const raw = sources(t);
      for (const phrase of ["made no decision", "withdr", "is history only", "Correction"]) assert.ok(raw.includes(phrase), `${t.taskId}: ${phrase}`);
    }
  });

  test("facts change before a compaction and are asked after it", () => {
    for (const [i, t] of tasks.slice(0, 6).entries()) {
      const a = Object.values(keys[i].answers);
      assert.ok(a.filter((x) => x.firstEstablishedStage <= 3 && x.lastChangedStage > 3).length >= 2, t.taskId);
      const c = t.checkpoint.probes.slice(1).flatMap((p) => p.questionIds.map((id) => keys[i].checkpointAnswers[id]));
      assert.ok(c.some((x) => x.firstEstablishedStage <= 3), t.taskId);
    }
  });

  test("reference schema 2 with unique fact names, one state for each compaction (each probe boundary of the long task), and fact links", () => {
    for (const [i, rf] of refFiles.entries()) {
      const s = specs[i];
      assert.equal(rf.schema, 2);
      assert.equal(rf.taskId, s.taskId);
      assert.deepEqual(rf.states.map((x) => x.afterStage), isLong(s) ? s.probeAfter : [3, 5, 7]);
      for (const st of rf.states) {
        const names = st.facts.map((f) => f.name);
        assert.equal(new Set(names).size, names.length, `${s.taskId} after ${st.afterStage}`);
        for (const f of st.facts) assert.ok(["scalar", "set"].includes(f.kind));
      }
      const names = new Set(rf.states.flatMap((x) => x.facts.map((f) => f.name)));
      for (const a of [...Object.values(keys[i].answers), ...Object.values(keys[i].checkpointAnswers)]) {
        assert.ok("fact" in a);
        if (a.fact) assert.ok(names.has(a.fact.name) && ["current", "history"].includes(a.fact.part), s.taskId);
      }
    }
  });

  test("no key text and no reference text is in a task file", () => {
    for (const [i, raw] of taskText.entries()) {
      for (const field of ["establishedBy", "staleValues", "checkpointAnswers", "errorCategory", "firstEstablishedStage", "\"facts\"", "\"rules\"", "\"query\"", "\"templates\""]) assert.ok(!raw.includes(field), `${tasks[i].taskId}: ${field}`);
      for (const s of refFiles[i].states) assert.ok(!raw.includes(`state after stage ${s.afterStage}`), tasks[i].taskId);
    }
  });

  test("the grader grades the new tasks unchanged: it accepts each key value and rejects each stale value", () => {
    for (const [i, t] of tasks.entries()) {
      for (const [q, a] of allPairs(i)) {
        assert.equal(gradeAnswer(q, a, a.value).correct, true, `${t.taskId} ${q.id}`);
        for (const s of a.staleValues) assert.equal(gradeAnswer(q, a, s).correct, false, `${t.taskId} ${q.id} stale`);
      }
    }
  });

  test("the reseed after calibration: the two old tasks are gone, and the five other tasks keep the hashes of the first freeze", () => {
    const FIRST = {
      "A12-mobile-gateway": ["0ae261940421aacb0e7bc64757f5dfc5890e44fe13afc6db1839b838c08b14a0", "bd13826082f70ede736d9bbf1deca441b7828f1094a4f2f691b024f88885cc66", "0f29a60d7e53b2a3d701bcd33cad7b9d0a71bacaa74d5d478447047ad57a2439"],
      "D12-backup-policy": ["0bd16ffbc53fa29d401d2ee25d0a4c29ead09db60e5515ddedc2c37b4b251bed", "fb8fcc4b2b1cbd33ad165a6d83cdc66a3702148aedf48a3204d701ef79e4e10c", "7c2b4daa45494ceea861ce8e9c85694b14d7dd2db9d84c2b3323d0389f9b10d1"],
      "W12-ledger-migration": ["bba76cf651124d3f8af4bffa59095fb8dcc1b0d42f98325f7ee61ad0b703baec", "76bd9b83b643ca264a3afaf5003d7f87b7125a60f879726900694b51545f4cbe", "c72ebc5d45f75d4dada61d3137885524af5606721439d39c4984421ddd283a0d"],
      "X12-data-retention": ["a33d27f0150c2acf1d7550e1866ae45819f68403940333288ee4e29b426bda80", "cc6c9ca67e8c40dba8d53165500c068f9510e18e585132fecdcbbd439b4331a7", "94ab3ee1721827aed187bc5a405b606278b3a573767f506abb739cfa03c83086"],
      "A13-long-mobile-platform": ["ef1693f294c0c13fb14906f8386f619069b15eab966e5f877c3dbe8df266870d", "2e211bf0edaa5a2167d119541b2927157474eacc1dee1615185921c47f9deb1c", "f5c61b5ffff0829f7eac1d1269d51e6b3446bac0bea32511a5ee524a33d2f60c"],
    };
    for (const [id, hashes] of Object.entries(FIRST)) {
      const x = frozen.tasks.find((t) => t.taskId === id);
      assert.deepEqual([x.task.sha256, x.key.sha256, x.reference.sha256], hashes, id);
    }
    for (const old of ["W12-search-revamp", "X12-edge-rollout"]) {
      assert.ok(!frozen.tasks.some((t) => t.taskId === old), old);
      for (const dir of ["generated", "keys", "reference"]) assert.ok(!readdirSync(join(V09_DIR, dir)).some((f) => f.startsWith(old)), `${dir} ${old}`);
    }
    // Only the seed changed: the new tasks have the spec of the task that they replace, apart from the id, seed and lead.
    for (const id of ["W12-shop-search", "X12-cdn-migration"]) {
      const s = V09_TASKS.find((t) => t.taskId === id);
      const sibling = V09_TASKS.find((t) => t.kind === s.kind && t !== s);
      for (const k of ["entities", "updates", "files", "reasons", "constraints", "questions", "stages", "group", "range", "limits", "minFacts"]) assert.deepEqual(s[k], sibling[k], `${id} ${k}`);
    }
  });

  test("the v08 files still match their FROZEN.json", () => {
    const f8 = JSON.parse(readFileSync(join(V08_DIR, "FROZEN.json"), "utf8"));
    for (const x of f8.tasks) for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(V08_DIR, x[part].path), "utf8")), x[part].sha256, x[part].path);
  });
});
