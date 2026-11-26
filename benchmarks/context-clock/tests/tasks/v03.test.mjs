// Tests of the v0.3 held-out task set (EXPERIMENT-V03.md, section "Tasks"): schema, key agreement with the reference
// state machine, sizes and delivery rules, probe placement, chunk lists, retrieval guard and frozen hashes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BIG_MIN, DELIVERY_MIN, SMALL_LIMIT } from "../../tasks/generator/render.mjs";
import { eventLabels, generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { PROBE_ASPECTS } from "../../tasks/generator/probes.mjs";
import { V03_DIR, V03_RANGE, V03_TASKS, generateAllV03, sha256 } from "../../tasks/generator/v03.mjs";
import { TASKS } from "../../tasks/generator/tasks.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";
import { validateTask } from "../../fixtures/schema.mjs";

const read = (rel) => readFileSync(join(V03_DIR, rel), "utf8");
const tasks = V03_TASKS.map((s) => JSON.parse(read(`generated/${s.taskId}.task.json`)));
const keys = V03_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const refs = V03_TASKS.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const checks = tasks.map((t, i) => validateV03(t, keys[i], refs[i]));
const bytes = (s) => Buffer.byteLength(s, "utf8");
const compactions = (t) => t.stages.filter((s) => s.compactAfter).map((s) => s.stage);

describe("v03 task set", () => {
  test("10 tasks, 2 per category, one with 1 compaction and one with 2", () => {
    assert.equal(V03_TASKS.length, 10);
    assert.deepEqual(readdirSync(join(V03_DIR, "generated")).sort(), V03_TASKS.map((s) => `${s.taskId}.task.json`).sort());
    assert.deepEqual(readdirSync(join(V03_DIR, "keys")).sort(), V03_TASKS.map((s) => `${s.taskId}.key.json`).sort());
    for (const cat of ["A", "B", "C", "D", "E"]) {
      const ids = V03_TASKS.filter((s) => s.category === cat).map((s) => s.taskId);
      assert.equal(ids.length, 2, cat);
      assert.ok(ids.some((id) => id.startsWith(`${cat}5-`)) && ids.some((id) => id.startsWith(`${cat}6-`)), cat);
    }
    for (const t of tasks) {
      assert.match(t.taskId, /^[A-E][56]-[a-z0-9-]+$/);
      assert.equal(t.profile, "compaction");
      assert.equal(compactions(t).length, t.taskId[1] === "5" ? 1 : 2, t.taskId);
    }
  });

  test("no v0.2 task is reused: new ids, slugs, seeds and scenario values", () => {
    const oldSlugs = new Set(TASKS.map((s) => s.taskId.slice(3)));
    const oldSeeds = new Set(TASKS.map((s) => s.seed));
    const oldOptions = new Set();
    for (const s of TASKS) {
      const t = JSON.parse(readFileSync(join(V03_DIR, "..", "generated", `${s.taskId}.task.json`), "utf8"));
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) oldOptions.add(o);
    }
    const generic = new Set(["pending", "applied", "failed"]); // migration statuses are rule words, not scenario values
    for (const [i, t] of tasks.entries()) {
      assert.ok(!oldSlugs.has(t.taskId.slice(3)), t.taskId);
      assert.ok(!oldSeeds.has(t.seed), t.taskId);
      assert.notEqual(t.intro, undefined);
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        for (const o of q.options ?? []) assert.ok(generic.has(o) || /^\d+$/.test(o) || !oldOptions.has(o), `${t.taskId} ${q.id}: ${o}`);
      }
      assert.equal(t.seed, V03_TASKS[i].seed);
    }
  });

  test("the generator reproduces every committed file byte for byte", () => {
    for (const [rel, content] of Object.entries(generateAllV03())) assert.equal(read(rel), content, rel);
  });

  test("FROZEN.json holds the generator commit, the seeds and the SHA-256 of every task and key file", () => {
    const frozen = JSON.parse(read("FROZEN.json"));
    assert.equal(frozen.schema, 1);
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), V03_TASKS.map((s) => s.taskId));
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.seed, V03_TASKS[i].seed, x.taskId);
      assert.deepEqual(x.compactAfter, V03_TASKS[i].compactAfter, x.taskId);
      assert.equal(sha256(read(x.task.path)), x.task.sha256, x.task.path);
      assert.equal(sha256(read(x.key.path)), x.key.sha256, x.key.path);
    }
  });

  test("every task and key passes the shared contract validator", () => {
    for (const [i, t] of tasks.entries()) assert.deepEqual(validateTask(t, keys[i]), [], t.taskId);
  });
});

describe("v03 sizes and delivery", () => {
  test("55 KB to 95 KB of staged material per task", () => {
    for (const t of tasks) {
      const total = t.stages.reduce((a, s) => a + [...s.files, ...s.feeds].reduce((b, f) => b + bytes(f.content), 0), 0);
      assert.equal(t.params.approxBytes, total, t.taskId);
      assert.ok(total >= V03_RANGE[0] && total <= V03_RANGE[1], `${t.taskId}: ${total}`);
    }
  });

  test("staged delivery rules: 4 to 8 chunks per stage, small chunks under 3500 bytes, large feeds above 6000", () => {
    for (const t of tasks) {
      let small = 0;
      let inBand = 0;
      let big = 0;
      for (const s of t.stages) {
        const n = s.files.length + s.feeds.length;
        assert.ok(n >= 4 && n <= 8, `${t.taskId} stage ${s.stage}: ${n}`);
        for (const f of s.files) assert.ok(bytes(f.content) < SMALL_LIMIT, `${t.taskId} ${f.path}`);
        for (const c of s.chunks) {
          if (c.bytes > BIG_MIN) {
            assert.equal(c.kind, "feed");
            big += 1;
          } else {
            assert.ok(c.bytes < SMALL_LIMIT, `${t.taskId} ${c.name}: ${c.bytes}`);
            small += 1;
            if (c.bytes >= DELIVERY_MIN) inBand += 1;
          }
        }
      }
      assert.ok(big >= 1, t.taskId);
      assert.ok(inBand / small >= 0.6, `${t.taskId}: ${inBand} of ${small}`);
    }
  });

  test("each stage lists its chunks with kind, name, bytes and events", () => {
    for (const t of tasks) {
      for (const s of t.stages) {
        const parts = [...s.files.map((f) => ["file", f.path, f.content]), ...s.feeds.map((f) => ["feed", f.name, f.content])];
        assert.equal(s.chunks.length, parts.length);
        s.chunks.forEach((c, i) => {
          const [kind, name, content] = parts[i];
          assert.deepEqual(c, { chunkId: `s${s.stage}-c${i + 1}`, kind, name, bytes: bytes(content), events: eventLabels(content) });
        });
        assert.deepEqual(s.chunks.flatMap((c) => c.events).sort(), [...s.eventIds].sort(), `${t.taskId} stage ${s.stage}`);
      }
    }
  });

  test("a search for the tag of a large feed finds exactly its tagged entries; at most one of them is decisive", () => {
    for (const [i, t] of tasks.entries()) {
      const prompts = t.stages.map((s) => s.prompt).join("\n");
      const material = t.stages.flatMap((s) => [...s.files, ...s.feeds].map((f) => f.content)).join("\n");
      const r = checks[i];
      assert.ok(r.decisiveInBig <= 1, t.taskId);
      for (const s of t.stages) {
        for (const f of s.feeds.filter((x) => bytes(x.content) > BIG_MIN)) {
          const m = new RegExp(`The feed ${f.name} is long\\. The entries that matter for this task carry the tag ([A-Z]+-\\d{4})`).exec(prompts);
          assert.ok(m, `${t.taskId}: no tag for ${f.name}`);
          const hits = f.content.split("\n").filter((l) => l.includes(m[1]));
          assert.ok(hits.length >= 2 && hits.every((l) => /^\[e\d{3}\]/.test(l)), `${t.taskId} ${f.name}`);
          assert.equal(material.split(m[1]).length - 1, hits.length, `${t.taskId}: tag ${m[1]} outside its feed`);
        }
      }
    }
  });
});

describe("v03 probes and keys", () => {
  test("one probe directly after each compaction, 4 to 6 questions each", () => {
    for (const t of tasks) {
      const cs = compactions(t);
      assert.equal(t.checkpoint.timing, "after_compaction");
      assert.equal(t.checkpoint.afterStage, cs[0]);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), cs, t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, `${t.taskId} probe ${p.afterStage}`);
      assert.deepEqual(t.checkpoint.probes.flatMap((p) => p.questionIds), t.checkpoint.questions.map((q) => q.id));
    }
  });

  test("the probes cover the aspects of the category", () => {
    for (const [i, t] of tasks.entries()) {
      const aspects = new Set(t.checkpoint.questions.map((q) => keys[i].checkpointAnswers[q.id].aspect));
      for (const a of PROBE_ASPECTS[t.category]) assert.ok(aspects.has(a), `${t.taskId}: ${a}`);
    }
  });

  test("the reference state machine agrees with every final and probe answer", () => {
    for (const [i, t] of tasks.entries()) {
      const ref = refs[i];
      assert.deepEqual(computeAnswers(ref.vars, ref.events, ref.questions), keys[i].answers, t.taskId);
      for (const p of t.checkpoint.probes) {
        const qs = p.questionIds.map((id) => ref.checkpointQuestions.find((q) => q.id === id));
        assert.ok(qs.every(Boolean), t.taskId);
        const want = computeAnswers(ref.vars, ref.events, qs, p.afterStage);
        for (const id of p.questionIds) assert.deepEqual(keys[i].checkpointAnswers[id], want[id], `${t.taskId} ${id}`);
      }
    }
  });

  test("each answer has establishedBy, firstEstablishedStage and lastChangedStage from real events", () => {
    for (const [i, t] of tasks.entries()) {
      const stageOf = new Map(keys[i].events.map((e) => [e.id, e.stage]));
      const all = [...Object.entries(keys[i].answers), ...Object.entries(keys[i].checkpointAnswers)];
      for (const [id, a] of all) {
        assert.ok(a.establishedBy.length > 0 && a.establishedBy.every((e) => stageOf.has(e)), `${t.taskId} ${id}`);
        assert.equal(a.firstEstablishedStage, stageOf.get(a.establishedBy[0]), `${t.taskId} ${id}`);
        assert.equal(a.lastChangedStage, stageOf.get(a.establishedBy.at(-1)), `${t.taskId} ${id}`);
      }
      for (const p of t.checkpoint.probes) {
        for (const id of p.questionIds) assert.ok(keys[i].checkpointAnswers[id].lastChangedStage <= p.afterStage, `${t.taskId} ${id}`);
      }
    }
  });

  test("final answers: at least 3 kept from before the first compaction, at least 2 changed after it", () => {
    for (const [i, t] of tasks.entries()) {
      const r = checks[i];
      assert.ok(r.stable >= 3 && r.changed >= 2, `${t.taskId}: ${JSON.stringify(r)}`);
    }
  });

  test("the grader accepts each key value and rejects each stale value", () => {
    for (const [i, t] of tasks.entries()) {
      const pairs = [...t.final.questions.map((q) => [q, keys[i].answers[q.id]]), ...t.checkpoint.questions.map((q) => [q, keys[i].checkpointAnswers[q.id]])];
      for (const [q, a] of pairs) {
        assert.equal(gradeAnswer(q, a, a.value).correct, true, `${t.taskId} ${q.id}`);
        for (const s of a.staleValues) assert.equal(gradeAnswer(q, a, s).correct, false, `${t.taskId} ${q.id} stale`);
      }
    }
  });
});
