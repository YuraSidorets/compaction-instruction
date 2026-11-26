// Tests for probes after automatic compactions (EXPERIMENT-V09.md part 2): with checkpoint timing
// after_auto_compaction, only the probes of the boundaries where the run has a probe turn count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askedProbeIds, AUTO_PROBE_TIMING, gradeJson, gradeRun } from "../../graders/grade.mjs";

const FIX = join(import.meta.dirname, "fixtures");
const load = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const TASK = load("T1-compact.task.json");
const KEY = load("T1-compact.key.json");
const BASE = load("run-completed.json");

// c1 is the probe of stage 1, c2 the probe of stage 2. Key: c1 "postgresql", c2 false.
const autoTask = () => ({ ...structuredClone(TASK), checkpoint: { ...structuredClone(TASK.checkpoint), timing: AUTO_PROBE_TIMING, probes: [{ afterStage: 1, questionIds: ["c1"] }, { afterStage: 2, questionIds: ["c2"] }] } });
const runWith = (probeStages, answers) => {
  const r = structuredClone(BASE);
  r.turns = [{ kind: "intro", stage: null }, ...[1, 2, 3].flatMap((s) => [{ kind: "stage", stage: s }, ...(probeStages.includes(s) ? [{ kind: "checkpoint", stage: s }] : [])]), { kind: "final" }];
  r.answers = { ...r.answers, checkpoint: answers };
  return r;
};

test("askedProbeIds: probes of the stages with a probe turn; null for planned probes", () => {
  assert.deepEqual([...askedProbeIds(autoTask(), runWith([2], {}))], ["c2"]);
  assert.deepEqual([...askedProbeIds(autoTask(), runWith([1, 2], {}))].sort(), ["c1", "c2"]);
  assert.deepEqual([...askedProbeIds(autoTask(), runWith([], {}))], []);
  assert.deepEqual([...askedProbeIds(autoTask(), { turns: null })], [], "a run with no turn list asked nothing");
  assert.equal(askedProbeIds(TASK, runWith([2], {})), null, "a task without the timing");
  const planned = { ...autoTask(), checkpoint: { ...autoTask().checkpoint, timing: "after_compaction" } };
  assert.equal(askedProbeIds(planned, runWith([2], {})), null, "planned probes after a /compact");
});

test("gradeRun: checkpoint.asked; an unasked probe is not counted, an asked probe with no answer is wrong", () => {
  const one = gradeRun(autoTask(), KEY, runWith([2], { c2: false }));
  assert.deepEqual(one.checkpoint, { questions: 2, asked: 1, correct: 1 });
  assert.deepEqual(one.checkpointItems.map((i) => [i.id, i.asked, i.correct, i.reason]), [["c1", false, false, "missing"], ["c2", true, true, null]]);
  const noAnswer = gradeRun(autoTask(), KEY, runWith([1, 2], { c2: false }));
  assert.deepEqual(noAnswer.checkpoint, { questions: 2, asked: 2, correct: 1 }, "c1 asked without a parsed answer counts as wrong");
  const none = gradeRun(autoTask(), KEY, runWith([], {}));
  assert.deepEqual(none.checkpoint, { questions: 2, asked: 0, correct: 0 });
  // An answer to a question that the runner did not ask does not count.
  const extra = gradeRun(autoTask(), KEY, runWith([2], { c1: "postgresql", c2: false }));
  assert.deepEqual(extra.checkpoint, { questions: 2, asked: 1, correct: 1 });
  assert.equal(one.score, gradeRun(TASK, KEY, BASE).score, "the final score does not change");
});

test("gradeRun: a task with planned probes keeps the old checkpoint shape and bytes", () => {
  const g = gradeRun(TASK, KEY, BASE);
  assert.deepEqual(g.checkpoint, { questions: 2, correct: 2 });
  assert.ok(g.checkpointItems.every((i) => !("asked" in i)));
  assert.equal(gradeJson(gradeRun(TASK, KEY, runWith([2], BASE.answers.checkpoint))), gradeJson(g), "turns do not matter without the timing");
});
