// Tests of the benchmark task generator (benchmarks/context-clock/tasks/generator) and its 40 committed files.
// Contract: benchmarks/context-clock/CONTRACT.md, sections "Task file" and "Key file".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_DIR, KEYS_DIR, OUTPUT_DIR, SIZE_RANGES, TASKS_DIR, band, generateAll, generateTask, requiredTokens } from "../../tasks/generator/generate.mjs";
import { SIZE_GROUPS, TASKS } from "../../tasks/generator/tasks.mjs";
import { computeAnswers, createMachine } from "../../tasks/generator/reference.mjs";
import { createRng } from "../../tasks/generator/rng.mjs";

const SMALL = 3500;
const BIG = 6000;
const BIG_MAX = 16500;
const DELIVERY_MIN = 1500;
const GROUPS = ["small", "medium", "large"];
const ASPECTS = ["current_state", "original_constraint", "superseded_decision", "relationship", "conditional_state", "conflict_resolution", "outstanding_work", "completed_work", "rejected_approach"];
const ERRORS = ["forgotten_requirement", "obsolete_decision", "wrong_relationship", "invalid_transition", "contradiction", "lost_progress", "repeated_work"];
const KINDS = ["state", "supersede", "noise", "rule", "conflict"];
const QTYPES = ["choice", "set", "int", "bool"];

const fresh = generateAll();
const tasks = TASKS.map((s) => JSON.parse(readFileSync(join(GENERATED_DIR, `${s.taskId}.task.json`), "utf8")));
const keys = TASKS.map((s) => JSON.parse(readFileSync(join(KEYS_DIR, `${s.taskId}.key.json`), "utf8")));
const pairs = tasks.map((t, i) => [t, keys[i]]);

function material(t) {
  return t.stages.flatMap((s) => [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)]);
}
function allText(t) {
  return [t.intro, ...t.stages.map((s) => s.prompt), ...material(t)].join("\n");
}
function canon(v) {
  return Array.isArray(v) ? JSON.stringify([...v].sort()) : JSON.stringify(v);
}
function isObj(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function keysExactly(obj, list, where) {
  assert.deepEqual(Object.keys(obj).sort(), [...list].sort(), where);
}

describe("generator: determinism", () => {
  test("two generations are byte-equal", () => {
    const again = generateAll();
    assert.deepEqual(Object.keys(again), Object.keys(fresh));
    for (const [k, v] of Object.entries(again)) assert.equal(v, fresh[k], k);
  });

  test("the committed generated/ and keys/ equal a fresh generation, and no other file is there", () => {
    for (const [rel, content] of Object.entries(fresh)) assert.equal(readFileSync(join(OUTPUT_DIR, rel), "utf8"), content, rel);
    assert.deepEqual(readdirSync(GENERATED_DIR).sort(), TASKS.map((s) => `${s.taskId}.task.json`).sort());
    assert.deepEqual(readdirSync(KEYS_DIR).sort(), TASKS.map((s) => `${s.taskId}.key.json`).sort());
  });

  test("the generator source uses no clock time and no Math.random", () => {
    const dir = join(TASKS_DIR, "generator");
    const files = ["generate.mjs", "rng.mjs", "story.mjs", "render.mjs", "reference.mjs", "vocab.mjs", "tasks.mjs", ...readdirSync(join(dir, "builders")).map((f) => `builders/${f}`)];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const bad of ["Math.random", "Date.now", "new Date", "performance.now", "process.hrtime"]) assert.ok(!src.includes(bad), `${f} uses ${bad}`);
    }
  });

  test("the seeded generator repeats its sequence", () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i += 1) assert.equal(a.float(), b.float());
  });
});

describe("generator: task set", () => {
  test("20 tasks: four per category, two long and two compaction per category, one and two compactions", () => {
    assert.equal(tasks.length, 20);
    assert.equal(new Set(tasks.map((t) => t.taskId)).size, 20);
    assert.equal(new Set(tasks.map((t) => t.seed)).size, 20);
    for (const c of ["A", "B", "C", "D", "E"]) {
      const ts = tasks.filter((t) => t.category === c);
      assert.equal(ts.length, 4, c);
      assert.equal(ts.filter((t) => t.profile === "long").length, 2, c);
      const comp = ts.filter((t) => t.profile === "compaction");
      assert.equal(comp.length, 2, c);
      const counts = comp.map((t) => t.stages.filter((s) => s.compactAfter).length).sort();
      assert.deepEqual(counts, [1, 2], c);
    }
  });

  test("three size groups (about 30, 60 and 110 KB), spread over categories and profiles", () => {
    for (const t of tasks) {
      const spec = TASKS.find((s) => s.taskId === t.taskId);
      assert.equal(t.params.sizeGroup, spec.size, t.taskId);
      assert.ok(GROUPS.includes(t.params.sizeGroup), t.taskId);
      const [lo, hi] = SIZE_RANGES[t.params.sizeGroup];
      assert.ok(t.params.approxBytes >= lo && t.params.approxBytes <= hi, `${t.taskId} ${t.params.approxBytes}`);
    }
    assert.deepEqual(Object.keys(SIZE_GROUPS).sort(), [...GROUPS].sort());
    // The groups do not overlap, and each one is clearly larger than the one before.
    assert.ok(SIZE_RANGES.small[1] * 1.25 < SIZE_RANGES.medium[0] && SIZE_RANGES.medium[1] * 1.25 < SIZE_RANGES.large[0]);
    for (const g of GROUPS) {
      const ts = tasks.filter((t) => t.params.sizeGroup === g);
      assert.ok(ts.length >= 6, g);
      assert.ok(ts.some((t) => t.profile === "long") && ts.some((t) => t.profile === "compaction"), `${g}: both profiles`);
    }
    for (const c of ["A", "B", "C", "D", "E"]) {
      assert.deepEqual([...new Set(tasks.filter((t) => t.category === c).map((t) => t.params.sizeGroup))].sort(), [...GROUPS].sort(), `${c}: all groups`);
    }
  });

  test("tasks vary in events, entities, updates, depth and noise ratio", () => {
    const ev = tasks.map((t) => t.params.events);
    assert.ok(Math.min(...ev) >= 100 && Math.max(...ev) <= 999, `events ${Math.min(...ev)} to ${Math.max(...ev)}`);
    for (const f of ["events", "entities", "updates", "dependencyDepth", "noiseRatio"]) {
      assert.ok(new Set(tasks.map((t) => t.params[f])).size >= 3, `${f} does not vary`);
    }
  });

  test("params match the files: event count, noise ratio and approxBytes", () => {
    for (const [t, k] of pairs) {
      assert.equal(t.params.events, k.events.length, t.taskId);
      const noise = k.events.filter((e) => e.kind === "noise").length;
      assert.equal(t.params.noiseRatio, Math.round((noise / k.events.length) * 100) / 100, t.taskId);
      assert.equal(t.params.approxBytes, material(t).reduce((a, m) => a + Buffer.byteLength(m, "utf8"), 0), t.taskId);
      assert.equal(t.params.updates, k.events.filter((e) => e.stage > 0 && e.kind !== "noise").length, t.taskId);
    }
  });
});

describe("generator: schemas", () => {
  test("every task file has the contract schema", () => {
    for (const t of tasks) {
      const w = t.taskId;
      keysExactly(t, ["schema", "taskId", "category", "seed", "profile", "params", "intro", "stages", "checkpoint", "final"], w);
      assert.equal(t.schema, 1);
      assert.ok(["A", "B", "C", "D", "E"].includes(t.category));
      assert.ok(t.taskId.startsWith(t.category));
      assert.ok(Number.isInteger(t.seed));
      assert.ok(["long", "compaction"].includes(t.profile));
      keysExactly(t.params, ["events", "entities", "updates", "dependencyDepth", "noiseRatio", "approxBytes", "sizeGroup"], w);
      assert.equal(typeof t.intro, "string");
      assert.ok(t.stages.length >= 4 && t.stages.length <= 7, w);
      t.stages.forEach((s, i) => {
        keysExactly(s, ["stage", "prompt", "files", "feeds", "eventIds", "compactAfter"], w);
        assert.equal(s.stage, i + 1);
        assert.equal(typeof s.prompt, "string");
        for (const f of s.files) keysExactly(f, ["path", "content"], w);
        for (const f of s.feeds) keysExactly(f, ["name", "content"], w);
        assert.ok(s.eventIds.every((id) => /^e\d{3}$/.test(id)));
        assert.equal(typeof s.compactAfter, "boolean");
        for (const f of s.files) assert.ok(/^inbox\/s\d+\/[a-z]+-\d{2}\.md$/.test(f.path), f.path);
        for (const f of s.feeds) assert.ok(/^[a-z0-9-]+$/.test(f.name), f.name);
      });
      const qs = [...t.final.questions, ...(t.checkpoint?.questions ?? [])];
      for (const q of qs) {
        assert.ok(QTYPES.includes(q.type), `${w} ${q.id}`);
        keysExactly(q, q.type === "choice" || q.type === "set" ? ["id", "text", "type", "options"] : ["id", "text", "type"], `${w} ${q.id}`);
        if (q.options) assert.ok(q.options.length >= 2 && q.options.every((o) => typeof o === "string"));
      }
      keysExactly(t.final, ["questions"], w);
      assert.ok(t.final.questions.length >= 5 && t.final.questions.length <= 8, w);
      if (t.profile === "long") {
        assert.equal(t.checkpoint, null);
        assert.ok(t.stages.every((s) => !s.compactAfter));
      } else {
        keysExactly(t.checkpoint, ["afterStage", "questions"], w);
        assert.equal(t.checkpoint.afterStage, t.stages.find((s) => s.compactAfter).stage);
        assert.ok(t.checkpoint.questions.length >= 2 && t.checkpoint.questions.length <= 3, w);
        assert.ok(t.stages.filter((s) => s.compactAfter).every((s) => s.stage < t.stages.length), `${w}: a compaction needs a later stage`);
      }
    }
  });

  test("every key file has the contract schema", () => {
    for (const [t, k] of pairs) {
      const w = t.taskId;
      keysExactly(k, ["schema", "taskId", "seed", "events", "answers", "checkpointAnswers"], w);
      assert.equal(k.schema, 1);
      assert.equal(k.taskId, t.taskId);
      assert.equal(k.seed, t.seed);
      k.events.forEach((e, i) => {
        keysExactly(e, ["id", "stage", "kind", "summary"], w);
        assert.equal(e.id, `e${String(i + 1).padStart(3, "0")}`);
        assert.ok(KINDS.includes(e.kind), e.kind);
        assert.ok(e.stage >= 0 && e.stage <= t.stages.length);
      });
      const check = (answers, qs) => {
        assert.deepEqual(Object.keys(answers).sort(), qs.map((q) => q.id).sort(), w);
        for (const a of Object.values(answers)) {
          keysExactly(a, ["value", "aspect", "establishedBy", "staleValues", "errorCategory", "firstEstablishedStage", "lastChangedStage"], w);
          assert.ok(ASPECTS.includes(a.aspect), a.aspect);
          assert.ok(ERRORS.includes(a.errorCategory), a.errorCategory);
          assert.ok(Number.isInteger(a.firstEstablishedStage) && Number.isInteger(a.lastChangedStage));
          assert.ok(a.firstEstablishedStage <= a.lastChangedStage);
        }
      };
      check(k.answers, t.final.questions);
      check(k.checkpointAnswers, t.checkpoint?.questions ?? []);
    }
  });
});

describe("generator: answers and keys", () => {
  test("no answer value leaks into a task file as an answer field", () => {
    const banned = new Set(["answer", "answers", "value", "establishedBy", "staleValues", "errorCategory", "aspect", "checkpointAnswers", "key", "summary"]);
    const walk = (x, path) => {
      if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (isObj(x)) {
        for (const [k, v] of Object.entries(x)) {
          assert.ok(!banned.has(k), `${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    for (const t of tasks) walk(t, t.taskId);
  });

  test("each answer is in the question's options or of its type", () => {
    for (const [t, k] of pairs) {
      const qs = [...t.final.questions.map((q) => [q, k.answers[q.id]]), ...(t.checkpoint?.questions ?? []).map((q) => [q, k.checkpointAnswers[q.id]])];
      for (const [q, a] of qs) {
        const w = `${t.taskId} ${q.id}`;
        if (q.type === "choice") assert.ok(q.options.includes(a.value), w);
        if (q.type === "set") {
          assert.ok(Array.isArray(a.value) && a.value.length > 0, w);
          assert.ok(a.value.every((v) => q.options.includes(v)), w);
        }
        if (q.type === "int") assert.ok(Number.isInteger(a.value), w);
        if (q.type === "bool") assert.equal(typeof a.value, "boolean", w);
      }
    }
  });

  test("stale values differ from the value, and choice stale values are distractor options", () => {
    let staleCount = 0;
    for (const [t, k] of pairs) {
      const qs = [...t.final.questions.map((q) => [q, k.answers[q.id]]), ...(t.checkpoint?.questions ?? []).map((q) => [q, k.checkpointAnswers[q.id]])];
      for (const [q, a] of qs) {
        for (const s of a.staleValues) {
          staleCount += 1;
          assert.notEqual(canon(s), canon(a.value), `${t.taskId} ${q.id}`);
          if (q.type === "choice") assert.ok(q.options.includes(s), `${t.taskId} ${q.id}: stale ${s} not an option`);
          if (q.type === "set") assert.ok(s.every((x) => q.options.includes(x)), `${t.taskId} ${q.id}`);
        }
      }
      assert.ok(Object.values(k.answers).some((a) => a.staleValues.length > 0), `${t.taskId}: no question has a superseded value`);
    }
    assert.ok(staleCount > 60);
  });

  test("establishedBy ids exist, are non-noise events, and are labeled once in the task text", () => {
    for (const [t, k] of pairs) {
      const byId = new Map(k.events.map((e) => [e.id, e]));
      const text = allText(t);
      for (const a of [...Object.values(k.answers), ...Object.values(k.checkpointAnswers)]) {
        assert.ok(a.establishedBy.length > 0, t.taskId);
        for (const id of a.establishedBy) {
          assert.ok(byId.has(id), `${t.taskId} ${id}`);
          assert.notEqual(byId.get(id).kind, "noise", `${t.taskId} ${id}`);
          const at = text.indexOf(`[${id}]`);
          assert.ok(at >= 0 && text.indexOf(`[${id}]`, at + 1) < 0, `${t.taskId} ${id}`);
        }
        assert.equal(byId.get(a.establishedBy[a.establishedBy.length - 1]).stage, a.lastChangedStage);
      }
    }
  });

  test("each final question set covers at least three aspects, and each task has a superseded fact", () => {
    for (const [t, k] of pairs) {
      assert.ok(new Set(Object.values(k.answers).map((a) => a.aspect)).size >= 3, t.taskId);
      assert.ok(k.events.some((e) => e.kind === "supersede"), t.taskId);
    }
  });

  test("every compaction task has pre-compaction facts that a later stage changes", () => {
    for (const [t, k] of pairs.filter(([t]) => t.profile === "compaction")) {
      const first = t.checkpoint.afterStage;
      const changed = Object.values(k.answers).filter((a) => a.firstEstablishedStage <= first && a.lastChangedStage > first);
      assert.ok(changed.length >= 1, t.taskId);
      // State changes happen after the last compaction too.
      const last = Math.max(...t.stages.filter((s) => s.compactAfter).map((s) => s.stage));
      assert.ok(k.events.some((e) => e.stage > last && e.kind !== "noise"), t.taskId);
    }
  });
});

describe("generator: delivery", () => {
  test("4 to 8 deliveries per stage; most small ones 1500 to 3500 bytes; one to three large feeds up to 16.5 KB", () => {
    for (const t of tasks) {
      let big = 0;
      let small = 0;
      let inBand = 0;
      for (const s of t.stages) {
        const n = s.files.length + s.feeds.length;
        assert.ok(n >= 4 && n <= 8, `${t.taskId} s${s.stage}: ${n} deliveries`);
        for (const f of s.files) {
          const b = Buffer.byteLength(f.content);
          assert.ok(b < SMALL, `${t.taskId} ${f.path}`);
          small += 1;
          if (b >= DELIVERY_MIN) inBand += 1;
        }
        for (const f of s.feeds) {
          const b = Buffer.byteLength(f.content);
          assert.ok(b < SMALL || (b > BIG && b <= BIG_MAX), `${t.taskId} ${f.name} ${b}`);
          if (b > BIG) big += 1;
          else {
            small += 1;
            if (b >= DELIVERY_MIN) inBand += 1;
          }
        }
      }
      assert.ok(big >= 1 && big <= 3, `${t.taskId}: ${big} large feeds`);
      assert.equal(big, SIZE_GROUPS[t.params.sizeGroup].bigFeeds, t.taskId);
      assert.ok(inBand / small >= 0.6, `${t.taskId}: ${inBand} of ${small} small deliveries reach ${DELIVERY_MIN} bytes`);
    }
  });

  test("the large feed holds needed events among noise, findable by the tag that the stage prompt names", () => {
    for (const [t, k] of pairs) {
      const kind = new Map(k.events.map((e) => [e.id, e.kind]));
      for (const s of t.stages) {
        for (const f of s.feeds.filter((x) => Buffer.byteLength(x.content) > BIG)) {
          const lines = f.content.split("\n").filter((l) => l.startsWith("["));
          const needed = lines.filter((l) => kind.get(l.slice(1, 5)) !== "noise");
          const noise = lines.filter((l) => kind.get(l.slice(1, 5)) === "noise");
          assert.ok(needed.length >= 1 && noise.length > needed.length * 3, `${t.taskId} ${f.name}`);
          // The tag comes from the stage prompt, as the agent sees it.
          const m = s.prompt.match(new RegExp(`The feed ${f.name} is long\\. The entries that matter for this task carry the tag ([A-Z]+-\\d{4})`));
          assert.ok(m, `${t.taskId}: the prompt names no tag for ${f.name}`);
          const tag = m[1];
          assert.ok(/^(CR|CHG|INC)-\d{4}$/.test(tag), `${t.taskId} tag ${tag}`);
          // A search for the tag finds every needed event of the feed and nothing else.
          const hits = f.content.split("\n").filter((l) => l.includes(tag));
          assert.deepEqual(hits, needed, `${t.taskId} ${f.name}: tag search`);
          assert.ok(noise.every((l) => !l.includes(tag)), t.taskId);
          const elsewhere = [t.intro, ...material(t).filter((c) => c !== f.content)].join("\n");
          assert.ok(!elsewhere.includes(tag), `${t.taskId}: ${tag} outside ${f.name}`);
        }
      }
    }
  });

  test("each stage prompt names every file and feed and asks to read all of them", () => {
    for (const t of tasks) {
      for (const s of t.stages) {
        for (const f of s.files) assert.ok(s.prompt.includes(f.path), `${t.taskId} ${f.path}`);
        for (const f of s.feeds) assert.ok(s.prompt.includes(f.name), `${t.taskId} ${f.name}`);
        assert.ok(s.prompt.includes("Read all of the material"), t.taskId);
        assert.ok(s.files.length + s.feeds.length >= 1, t.taskId);
      }
    }
  });

  test("every event is labeled exactly once and stage eventIds partition the stage events", () => {
    for (const [t, k] of pairs) {
      const text = [t.intro, ...material(t)].join("\n");
      for (const e of k.events) {
        const at = text.indexOf(`[${e.id}]`);
        assert.ok(at >= 0 && text.indexOf(`[${e.id}]`, at + 1) < 0, `${t.taskId} ${e.id}`);
      }
      for (const s of t.stages) {
        assert.deepEqual(s.eventIds, k.events.filter((e) => e.stage === s.stage).map((e) => e.id), `${t.taskId} s${s.stage}`);
        const stageText = [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)].join("\n");
        for (const id of s.eventIds) assert.ok(stageText.includes(`[${id}]`), `${t.taskId} ${id} not in its stage`);
      }
      for (const e of k.events.filter((x) => x.stage === 0)) assert.ok(t.intro.includes(`[${e.id}]`));
    }
  });

  test("no task text names a clock or memory tool, the keys, or the benchmark", () => {
    const banned = ["clock", "memory", "ctx_", "context mode", "context-mode", "compact", "key.json", "graders", "benchmark"];
    for (const t of tasks) {
      const text = allText(t).toLowerCase();
      for (const b of banned) assert.ok(!text.includes(b), `${t.taskId} contains ${b}`);
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) {
        for (const b of banned) assert.ok(!q.text.toLowerCase().includes(b), `${t.taskId} ${q.id}`);
      }
    }
  });
});

describe("generator: distractors and fact placement", () => {
  const full = TASKS.map((spec) => generateTask(spec, { withReference: true }));

  // A fixed list for the test, kept apart from the generator's own list.
  const ENGLISH = new Set(
    ("a an the it its is are was be am i me my we us our you he him his she her they them this that to of in on at by " +
      "for from with as or and but nor not no yes so if up out off over into via per all any some none each both only " +
      "can will now new old one two ok set get put use run go do did has had have may must what who why how when where " +
      "here there also rest open done true false null default").split(" "),
  );

  test("no option of any question is a common English word", () => {
    for (const t of tasks) {
      for (const q of [...t.final.questions, ...(t.checkpoint?.questions ?? [])]) {
        for (const o of q.options ?? []) assert.ok(!ENGLISH.has(o.toLowerCase()), `${t.taskId} ${q.id}: option "${o}"`);
      }
    }
  });

  test("every value in a state event is code-marked in the line that holds the event", () => {
    const mark = (v) => "`" + (v === true ? "ON" : v === false ? "OFF" : String(v)) + "`";
    for (const { task, reference } of full) {
      const lineOf = new Map();
      for (const line of [task.intro, ...material(task)].join("\n").split("\n")) {
        const m = line.match(/\[(e\d{3})\]/);
        if (m) lineOf.set(m[1], line);
      }
      for (const e of reference.events) {
        const o = e.op;
        const vals = [o.value, o.item, o.from, o.to, o.success, o.fail].filter((x) => x !== undefined);
        if (o.op === "snapshot" || o.op === "rollback") vals.push(o.label);
        for (const c of [...(o.guard ?? []), ...(o.requires ?? [])]) vals.push(c.eq);
        for (const v of vals) assert.ok(lineOf.get(e.id).includes(mark(v)), `${task.taskId} ${e.id}: ${mark(v)} missing in ${lineOf.get(e.id)}`);
      }
    }
  });

  test("near misses, proposals and dated copies change no answer", () => {
    for (const { task, key, reference } of full) {
      const ops = new Map(reference.events.map((e) => [e.id, e.op.op]));
      const kinds = {};
      for (const op of ops.values()) kinds[op] = (kinds[op] ?? 0) + 1;
      assert.ok(kinds.touch >= 1 && kinds.restate >= 1 && kinds.mention >= 1 && kinds.touch + kinds.restate + kinds.mention >= 8, `${task.taskId}: ${JSON.stringify(kinds)}`);
      const plain = reference.events.filter((e) => !["touch", "restate", "mention"].includes(e.op.op));
      const again = computeAnswers(reference.vars, plain, reference.questions);
      for (const q of reference.questions) assert.deepEqual(again[q.id].value, key.answers[q.id].value, `${task.taskId} ${q.id}`);
    }
  });

  test("a dated copy names an earlier entry and says that it is history", () => {
    let copies = 0;
    for (const t of tasks) {
      for (const line of material(t).join("\n").split("\n")) {
        const m = line.match(/\[(e\d{3})\].*entry (e\d{3})/);
        if (!m) continue;
        copies += 1;
        assert.ok(m[2] < m[1], `${t.taskId}: ${m[1]} copies the later ${m[2]}`);
        assert.ok(/history|historical/.test(line), `${t.taskId} ${m[1]}`);
      }
    }
    assert.ok(copies >= 100, `${copies} copies`);
  });

  test("facts sit early, in the middle and late; several answers depend on the first third", () => {
    for (const [t, k] of pairs) {
      const S = t.stages.length;
      const stageOf = new Map(k.events.map((e) => [e.id, e.stage]));
      const hist = Object.values(k.answers).map((a) => ({ a, stages: a.establishedBy.map((id) => stageOf.get(id)) }));
      const all = hist.flatMap((h) => h.stages).filter((s) => s >= 1);
      for (const b of [0, 1, 2]) assert.ok(all.some((s) => band(s, S) === b), `${t.taskId}: no fact in band ${b}`);
      const early = hist.filter((h) => h.stages.some((s) => band(s, S) === 0));
      assert.ok(early.length >= 3, `${t.taskId}: ${early.length} questions with an early fact`);
      assert.ok(early.filter((h) => band(h.a.lastChangedStage, S) > 0).length >= 2, `${t.taskId}: early facts that a later event changes`);
      assert.ok(hist.some((h) => band(h.a.lastChangedStage, S) === 0), `${t.taskId}: an early fact that nothing changes later`);
      assert.ok(hist.some((h) => h.stages.some((s) => s >= 1 && band(s, S) === 0)), `${t.taskId}: an early fact from the stage material`);
      if (t.profile === "compaction") {
        const pre = Object.values(k.answers).filter((a) => a.firstEstablishedStage <= t.checkpoint.afterStage);
        assert.ok(pre.length >= 3 && pre.some((a) => a.lastChangedStage > t.checkpoint.afterStage), t.taskId);
      }
    }
  });

  test("in categories C and D, at least two answers need three or more events combined", () => {
    for (const { task, reference } of full.filter(({ task }) => task.category === "C" || task.category === "D")) {
      let deep = 0;
      for (const q of reference.questions) {
        const base = canon(computeAnswers(reference.vars, reference.events, [q])[q.id].value);
        let needed = 0;
        reference.events.forEach((e, i) => {
          if (["noise", "touch", "restate", "mention"].includes(e.op.op)) return;
          let v;
          try {
            v = canon(computeAnswers(reference.vars, reference.events.filter((_, j) => j !== i), [q])[q.id].value);
          } catch {
            v = "error";
          }
          if (v !== base) needed += 1;
        });
        if (needed >= 3) deep += 1;
      }
      assert.ok(deep >= 2, `${task.taskId}: ${deep} deep questions`);
    }
  });
});

describe("reference: independent state machine", () => {
  test("the reference imports nothing from the renderer, the story helper or the builders", () => {
    const src = readFileSync(join(TASKS_DIR, "generator", "reference.mjs"), "utf8");
    assert.ok(!src.includes("import "), "reference.mjs must have no imports");
  });

  test("rendered event text still holds the values the reference used (self-check, re-run on fresh data)", () => {
    for (const spec of TASKS.slice(0, 20)) {
      const { task, key } = generateTask(spec);
      const text = allText(task);
      assert.equal(key.events.length, task.params.events);
      // The generator throws when a token is missing; here the tokens are checked against the line of each label.
      const lineOf = new Map();
      for (const line of text.split("\n")) {
        const at = line.indexOf("[e");
        if (at >= 0 && line[at + 5] === "]") lineOf.set(line.slice(at + 1, at + 5), line);
      }
      for (const e of key.events) assert.ok(lineOf.has(e.id), `${spec.taskId} ${e.id}`);
    }
    assert.deepEqual(requiredTokens({ x: { label: "the flag x" } }, { op: "set", var: "x", value: true }), ["the flag x", "`ON`"]);
  });

  test("set, supersede, rename, guard, attempt, snapshot and rollback replay as specified", () => {
    const vars = {
      own: { type: "scalar", domain: "team" },
      deps: { type: "set" },
      flag: { type: "bool" },
      mig: { type: "scalar" },
      cfg: { type: "int" },
    };
    const ev = (id, stage, op) => ({ id, stage, op });
    const events = [
      ev("e001", 0, { op: "set", var: "own", value: "core" }),
      ev("e002", 0, { op: "set", var: "flag", value: false }),
      ev("e003", 0, { op: "set", var: "cfg", value: 8 }),
      ev("e004", 1, { op: "add", var: "deps", item: "a" }),
      ev("e005", 1, { op: "attempt", var: "mig", success: "applied", fail: "failed", requires: [{ var: "flag", eq: true }] }),
      ev("e006", 1, { op: "set", var: "cfg", value: 99, guard: [{ var: "mig", eq: "applied" }] }), // void
      ev("e007", 2, { op: "snapshot", label: "cp" }),
      ev("e008", 2, { op: "rename", domain: "team", from: "core", to: "platform" }),
      ev("e009", 2, { op: "set", var: "flag", value: true }),
      ev("e010", 2, { op: "attempt", var: "mig", success: "applied", fail: "failed", requires: [{ var: "flag", eq: true }] }),
      ev("e011", 3, { op: "set", var: "cfg", value: 16 }),
      ev("e012", 3, { op: "add", var: "deps", item: "b" }),
      ev("e013", 3, { op: "remove", var: "deps", item: "a" }),
      ev("e014", 4, { op: "rollback", label: "cp", vars: ["cfg"] }),
    ];
    const qs = [
      { id: "q1", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: "own" } },
      { id: "q2", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: "mig" } },
      { id: "q3", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: "cfg" } },
      { id: "q4", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "members", var: "deps" } },
      { id: "q5", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: "own" } },
      { id: "q6", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: "mig" } },
    ];
    const a = computeAnswers(vars, events, qs);
    assert.equal(a.q1.value, "platform");
    assert.deepEqual(a.q1.staleValues, ["core"]);
    assert.deepEqual(a.q1.establishedBy, ["e001", "e008"]);
    assert.equal(a.q2.value, "applied");
    assert.deepEqual(a.q2.staleValues, ["failed"]);
    assert.equal(a.q3.value, 8); // e006 void, e011 rolled back by e014
    assert.deepEqual(a.q3.establishedBy, ["e003", "e011", "e014"]);
    assert.deepEqual(a.q3.staleValues, [16]);
    assert.equal(a.q3.lastChangedStage, 4);
    assert.deepEqual(a.q4.value, ["b"]);
    assert.equal(a.q5.value, "core");
    assert.deepEqual(a.q6.value, ["failed"]);
    const cp = computeAnswers(vars, events, qs, 2);
    assert.equal(cp.q3.value, 8);
    assert.equal(cp.q2.value, "applied");
    assert.deepEqual(cp.q4.value, ["a"]);
  });

  test("claims resolve by authority, then version; a withdrawn document stops counting", () => {
    const vars = { x: { type: "scalar", mode: "claims" } };
    const m = createMachine(vars);
    m.apply({ op: "authority", order: ["top", "spec", "wiki"] });
    m.apply({ op: "claim", var: "x", value: "a", source: "spec", version: 1, doc: "S1" });
    m.apply({ op: "claim", var: "x", value: "w", source: "wiki", version: 9, doc: "W9" });
    assert.equal(m.valueOf("x"), "a");
    m.apply({ op: "claim", var: "x", value: "b", source: "spec", version: 2, doc: "S2" });
    assert.equal(m.valueOf("x"), "b");
    m.apply({ op: "retract", doc: "S2" });
    assert.equal(m.valueOf("x"), "a");
    m.apply({ op: "claim", var: "x", value: "t", source: "top", version: 1, doc: "T1" });
    m.apply({ op: "claim", var: "x", value: "c", source: "spec", version: 3, doc: "S3" });
    assert.equal(m.valueOf("x"), "t");
    assert.equal(m.evaluate({ q: "source", var: "x" }), "top");
  });
});
