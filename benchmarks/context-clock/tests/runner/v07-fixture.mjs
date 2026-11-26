// Test task set in the shape of tasks/v07 (EXPERIMENT-V07.md "Tasks"): 8 stages with compactAfter at stages 3, 5 and 7
// and a probe after each compaction. tasks/v07 does not exist yet, so the tasks are copies of the v0.6 tasks with one
// more stage. Only the shape matters for the runner tests (the mock host reads no task value).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V06 = join(HERE, "..", "..", "tasks", "v06", "generated");
export const V07_COMPACT_STAGES = Object.freeze([3, 5, 7]);
/** Six task ids, as the v0.7 suites expect (v07-smoke selects the prefix A10). */
export const V07_TASK_IDS = Object.freeze(["A10-fixture", "B10-fixture", "C10-fixture", "D10-fixture", "E10-fixture", "E11-fixture"]);

/** One 8-stage task from a v0.6 task: a copy of its last stage is stage 8, and the probes split its questions. */
export function eightStageTask(src, taskId, category) {
  const t = structuredClone(src);
  t.taskId = taskId;
  t.category = category;
  const last = structuredClone(t.stages[t.stages.length - 1]);
  while (t.stages.length < 8) t.stages.push({ ...structuredClone(last), stage: t.stages.length + 1 });
  t.stages = t.stages.slice(0, 8).map((s, i) => ({ ...s, stage: i + 1, compactAfter: V07_COMPACT_STAGES.includes(i + 1) }));
  const ids = t.checkpoint.questions.map((q) => q.id);
  const per = Math.ceil(ids.length / V07_COMPACT_STAGES.length);
  t.checkpoint = {
    ...t.checkpoint,
    afterStage: V07_COMPACT_STAGES[0],
    timing: "after_compaction",
    probes: V07_COMPACT_STAGES.map((afterStage, i) => ({ afterStage, questionIds: ids.slice(i * per, (i + 1) * per) })).filter((p) => p.questionIds.length > 0),
  };
  return t;
}

/** v0.8 has the same task shape (EXPERIMENT-V08.md "Tasks"); v08-smoke selects the prefix A11. */
export const V08_TASK_IDS = Object.freeze(["A11-fixture", "B11-fixture", "C11-fixture", "D11-fixture", "E11-fixture", "E12-fixture"]);

/** Write six fixture tasks (default: the v0.7 ids) to a new temporary folder and return it (remove it with cleanup). */
export function v07TaskDir(ids = V07_TASK_IDS) {
  const dir = tmp("v07-tasks");
  mkdirSync(dir, { recursive: true });
  const sources = readdirSync(V06).filter((f) => f.endsWith(".task.json")).sort().map((f) => JSON.parse(readFileSync(join(V06, f), "utf8")));
  ids.forEach((id, i) => {
    const t = eightStageTask(sources[i % sources.length], id, id[0]);
    writeFileSync(join(dir, `${id}.task.json`), JSON.stringify(t));
  });
  return dir;
}
