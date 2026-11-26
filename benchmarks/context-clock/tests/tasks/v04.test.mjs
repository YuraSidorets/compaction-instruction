// Tests of the v0.4 task set (EXPERIMENT-V04.md, sections "Tasks" and "Interfaces"): schema, key agreement with the
// reference state machine, sizes and delivery rules, probe placement, chunk lists, the reference state files and
// frozen hashes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BIG_MIN, DELIVERY_MIN, SMALL_LIMIT } from "../../tasks/generator/render.mjs";
import { eventLabels, generateTask, validateV03 } from "../../tasks/generator/generate.mjs";
import { computeAnswers } from "../../tasks/generator/reference.mjs";
import { PROBE_ASPECTS } from "../../tasks/generator/probes.mjs";
import { STATE_TEXT_MAX_BYTES, stateText } from "../../tasks/generator/refstate.mjs";
import { SIDE_IDS, V04_DIR, V04_RANGE, V04_TASKS, generateAllV04, sha256 } from "../../tasks/generator/v04.mjs";
import { V03_TASKS } from "../../tasks/generator/v03.mjs";
import { TASKS } from "../../tasks/generator/tasks.mjs";
import { gradeAnswer } from "../../graders/grade.mjs";
import { validateTask } from "../../fixtures/schema.mjs";

const read = (rel) => readFileSync(join(V04_DIR, rel), "utf8");
const tasks = V04_TASKS.map((s) => JSON.parse(read(`generated/${s.taskId}.task.json`)));
const keys = V04_TASKS.map((s) => JSON.parse(read(`keys/${s.taskId}.key.json`)));
const states = V04_TASKS.map((s) => JSON.parse(read(`reference/${s.taskId}.state.json`)));
const refs = V04_TASKS.map((s) => generateTask(s, { withReference: true, checkCoverage: false }).reference);
const checks = tasks.map((t, i) => validateV03(t, keys[i], refs[i]));
const bytes = (s) => Buffer.byteLength(s, "utf8");
const compactions = (t) => t.stages.filter((s) => s.compactAfter).map((s) => s.stage);

/** The value tokens of a reference text: the parts after "name: ", split at ", ", ", then " and " > ". */
function valueTokens(text) {
  const out = new Set();
  for (const line of text.split("\n")) {
    const at = line.indexOf(": ");
    if (at < 0) continue;
    for (const v of line.slice(at + 2).split(/, then |, | > /)) out.add(v);
  }
  return out;
}

/** The expected value of an answer as it appears in a reference text. */
const shown = (q, value) => (q.type === "bool" ? (value ? "ON" : "OFF") : String(value));

describe("v04 task set", () => {
  test("10 tasks, 2 per category, one with 1 compaction and one with 2", () => {
    assert.equal(V04_TASKS.length, 10);
    for (const [dir, ext] of [["generated", "task"], ["keys", "key"], ["reference", "state"]]) {
      assert.deepEqual(readdirSync(join(V04_DIR, dir)).sort(), V04_TASKS.map((s) => `${s.taskId}.${ext}.json`).sort(), dir);
    }
    for (const cat of ["A", "B", "C", "D", "E"]) {
      const ids = V04_TASKS.filter((s) => s.category === cat).map((s) => s.taskId);
      assert.equal(ids.length, 2, cat);
      assert.ok(ids.some((id) => id.startsWith(`${cat}7-`)) && ids.some((id) => id.startsWith(`${cat}8-`)), cat);
    }
    for (const t of tasks) {
      assert.match(t.taskId, /^[A-E][78]-[a-z0-9-]+$/);
      assert.equal(t.profile, "compaction");
      assert.equal(compactions(t).length, t.taskId[1] === "7" ? 1 : 2, t.taskId);
    }
  });

  test("no v0.2 or v0.3 task is reused: new slugs, seeds and scenario values", () => {
    const old = [...TASKS.map((s) => [s, join(V04_DIR, "..", "generated")]), ...V03_TASKS.map((s) => [s, join(V04_DIR, "..", "v03", "generated")])];
    const oldSlugs = new Set(old.map(([s]) => s.taskId.slice(3)));
    const oldSeeds = new Set(old.map(([s]) => s.seed));
    const oldOptions = new Set();
    for (const [s, dir] of old) {
      const t = JSON.parse(readFileSync(join(dir, `${s.taskId}.task.json`), "utf8"));
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) oldOptions.add(o);
    }
    const generic = new Set(["pending", "applied", "failed"]); // migration statuses are rule words, not scenario values
    for (const [i, t] of tasks.entries()) {
      assert.ok(!oldSlugs.has(t.taskId.slice(3)), t.taskId);
      assert.ok(!oldSeeds.has(t.seed), t.taskId);
      assert.equal(t.seed, V04_TASKS[i].seed);
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) {
        for (const o of q.options ?? []) assert.ok(generic.has(o) || /^\d+$/.test(o) || !oldOptions.has(o), `${t.taskId} ${q.id}: ${o}`);
      }
    }
    assert.equal(new Set(V04_TASKS.map((s) => s.seed)).size, 10);
  });

  test("the generator reproduces every committed file byte for byte", () => {
    const files = generateAllV04();
    assert.equal(Object.keys(files).length, 30);
    for (const [rel, content] of Object.entries(files)) assert.equal(read(rel), content, rel);
  });

  test("FROZEN.json holds the generator commit, the seeds and the SHA-256 of every task, key and reference file", () => {
    const frozen = JSON.parse(read("FROZEN.json"));
    assert.equal(frozen.schema, 1);
    assert.match(frozen.generatorCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), V04_TASKS.map((s) => s.taskId));
    for (const [i, x] of frozen.tasks.entries()) {
      assert.equal(x.seed, V04_TASKS[i].seed, x.taskId);
      assert.deepEqual(x.compactAfter, V04_TASKS[i].compactAfter, x.taskId);
      for (const f of [x.task, x.key, x.reference]) assert.equal(sha256(read(f.path)), f.sha256, f.path);
    }
  });

  test("every task and key pair passes the shared contract validator and the v03 rules", () => {
    for (const [i, t] of tasks.entries()) {
      assert.deepEqual(validateTask(t, keys[i]), [], t.taskId);
      assert.ok(checks[i].stable >= 3 && checks[i].changed >= 2 && checks[i].decisiveInBig <= 1, `${t.taskId}: ${JSON.stringify(checks[i])}`);
    }
  });
});

describe("v04 sizes and delivery", () => {
  test("55 KB to 95 KB of staged material per task", () => {
    for (const t of tasks) {
      const total = t.stages.reduce((a, s) => a + [...s.files, ...s.feeds].reduce((b, f) => b + bytes(f.content), 0), 0);
      assert.equal(t.params.approxBytes, total, t.taskId);
      assert.ok(total >= V04_RANGE[0] && total <= V04_RANGE[1], `${t.taskId}: ${total}`);
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
});

describe("v04 probes and keys", () => {
  test("one probe directly after each compaction, 4 to 6 questions each, covering the category aspects", () => {
    for (const [i, t] of tasks.entries()) {
      const cs = compactions(t);
      assert.equal(t.checkpoint.timing, "after_compaction");
      assert.equal(t.checkpoint.afterStage, cs[0]);
      assert.deepEqual(t.checkpoint.probes.map((p) => p.afterStage), cs, t.taskId);
      for (const p of t.checkpoint.probes) assert.ok(p.questionIds.length >= 4 && p.questionIds.length <= 6, `${t.taskId} probe ${p.afterStage}`);
      assert.deepEqual(t.checkpoint.probes.flatMap((p) => p.questionIds), t.checkpoint.questions.map((q) => q.id));
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
        const want = computeAnswers(ref.vars, ref.events, qs, p.afterStage);
        for (const id of p.questionIds) assert.deepEqual(keys[i].checkpointAnswers[id], want[id], `${t.taskId} ${id}`);
      }
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

describe("v04 reference state files", () => {
  test("schema: { schema: 1, taskId, states: [{ afterStage, text }] }, one state for each compaction stage", () => {
    for (const [i, st] of states.entries()) {
      const t = tasks[i];
      assert.deepEqual(Object.keys(st), ["schema", "taskId", "states"], t.taskId);
      assert.equal(st.schema, 1);
      assert.equal(st.taskId, t.taskId);
      assert.deepEqual(st.states.map((s) => s.afterStage), compactions(t), t.taskId);
      for (const s of st.states) {
        assert.deepEqual(Object.keys(s), ["afterStage", "text"]);
        assert.equal(typeof s.text, "string");
      }
    }
  });

  test(`each text has at most ${STATE_TEXT_MAX_BYTES} bytes UTF-8 of plain "name: value" lines`, () => {
    for (const st of states) {
      for (const s of st.states) {
        assert.ok(bytes(s.text) <= STATE_TEXT_MAX_BYTES, `${st.taskId} stage ${s.afterStage}: ${bytes(s.text)}`);
        const lines = s.text.trimEnd().split("\n");
        assert.equal(lines[0], `state after stage ${s.afterStage}`);
        for (const l of lines.slice(1)) assert.match(l, /^[^:\n]+: \S.*$/, `${st.taskId}: ${l}`);
      }
    }
  });

  test("each text is the reference state after its stage, with no later event, no side value and no question, answer or event id", () => {
    for (const [i, st] of states.entries()) {
      const ref = refs[i];
      const sideValues = new Set(Object.entries(ref.vars).filter(([id]) => SIDE_IDS.has(id)).flatMap(([, v]) => v.options.map(String)));
      for (const s of st.states) {
        assert.equal(s.text, stateText(ref.vars, ref.events.filter((e) => e.stage <= s.afterStage), s.afterStage, SIDE_IDS));
        for (const tok of valueTokens(s.text)) {
          assert.ok(!/^(q|c|k)\d+$/.test(tok) && !/^e\d{3}$/.test(tok), `${st.taskId}: id ${tok}`);
          assert.ok(!sideValues.has(tok), `${st.taskId}: side value ${tok}`);
        }
      }
    }
  });

  test("every text answer of a final question that is set at or before the last compaction is an exact string of the last text", () => {
    let checked = 0;
    for (const [i, t] of tasks.entries()) {
      const last = states[i].states.at(-1);
      const tokens = valueTokens(last.text);
      for (const q of t.final.questions) {
        const a = keys[i].answers[q.id];
        if (a.lastChangedStage === null || a.lastChangedStage > last.afterStage) continue;
        if (q.type !== "choice" && q.type !== "set") continue;
        for (const v of Array.isArray(a.value) ? a.value : [a.value]) {
          assert.ok(last.text.includes(String(v)), `${t.taskId} ${q.id}: ${v}`);
          assert.ok(tokens.has(String(v)), `${t.taskId} ${q.id}: ${v} is not a whole value`);
        }
        checked += 1;
      }
    }
    assert.ok(checked >= 20, `only ${checked} questions checked`);
  });

  test("number and ON/OFF answers: a value query is a whole value of the last text, a count or membership query is derived", () => {
    // A count query (int) and a membership query (bool) have no line of their own. The text holds the set that they
    // derive from. Any other query kind must appear as a whole value.
    const derived = [];
    for (const [i, t] of tasks.entries()) {
      const last = states[i].states.at(-1);
      const tokens = valueTokens(last.text);
      for (const q of refs[i].questions) {
        const a = keys[i].answers[q.id];
        if (a.lastChangedStage === null || a.lastChangedStage > last.afterStage) continue;
        if (q.type !== "int" && q.type !== "bool") continue;
        if (q.query.q === "count" || q.query.q === "contains") {
          derived.push(`${t.taskId} ${q.id} ${q.query.q}`);
          continue;
        }
        assert.ok(tokens.has(shown(q, a.value)), `${t.taskId} ${q.id} ${q.query.q}: ${a.value}`);
      }
    }
    assert.ok(derived.every((d) => /^[BE]/.test(d)), derived.join("; "));
  });

  test("every probe answer is in the text of its stage", () => {
    for (const [i, t] of tasks.entries()) {
      for (const p of t.checkpoint.probes) {
        const s = states[i].states.find((x) => x.afterStage === p.afterStage);
        const tokens = valueTokens(s.text);
        for (const id of p.questionIds) {
          const q = refs[i].checkpointQuestions.find((x) => x.id === id);
          const a = keys[i].checkpointAnswers[id];
          if (q.query.q === "count" || q.query.q === "contains") continue;
          for (const v of Array.isArray(a.value) ? a.value : [a.value]) assert.ok(tokens.has(shown(q, v)), `${t.taskId} ${id} ${q.query.q}: ${v}`);
        }
      }
    }
  });
});
