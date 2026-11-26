// Test task set in the shape of tasks/v09 (EXPERIMENT-V09.md "Tasks", "Part 2: automatic compaction"): two tasks of
// the old shape (A12, D12), two work log tasks (W12), two decision record tasks (X12), all with 8 stages and
// compactions after stages 3, 5 and 7, and one long task (A13) with 24 stages, no compaction stage, and a probe for
// every stage boundary. tasks/v09 does not exist yet, so the tasks are copies of the v0.6 tasks. Only the shape matters.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eightStageTask } from "./v07-fixture.mjs";
import { tmp } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V06 = join(HERE, "..", "..", "tasks", "v06", "generated");
export const V09_TASKS = Object.freeze([
  { id: "A12-fixture-old", shape: "old" },
  { id: "D12-fixture-old", shape: "old" },
  { id: "W12-fixture-log-1", shape: "worklog" },
  { id: "W12-fixture-log-2", shape: "worklog" },
  { id: "X12-fixture-dec-1", shape: "decision" },
  { id: "X12-fixture-dec-2", shape: "decision" },
]);
export const V09_LONG_ID = "A13-long-fixture";
export const LONG_STAGES = 24;

/** The long task: `stages` stages, no compactAfter, one probe after each stage boundary 1 .. stages - 1. */
export function longTask(src, taskId = V09_LONG_ID, stages = LONG_STAGES) {
  const t = structuredClone(src);
  t.taskId = taskId;
  t.category = "A";
  t.profile = "compaction";
  t.shape = "old";
  const base = t.stages.map((s) => structuredClone(s));
  t.stages = Array.from({ length: stages }, (_, i) => ({ ...structuredClone(base[i % base.length]), stage: i + 1, compactAfter: false }));
  const ids = t.checkpoint.questions.map((q) => q.id);
  t.checkpoint = {
    ...t.checkpoint,
    afterStage: 1,
    timing: "after_compaction",
    probes: Array.from({ length: stages - 1 }, (_, i) => ({ afterStage: i + 1, questionIds: [ids[i % ids.length]] })),
  };
  return t;
}

/** Write the seven fixture tasks to a new temporary folder and return it (the caller removes it with cleanup). */
export function v09TaskDir() {
  const dir = tmp("v09-tasks");
  mkdirSync(dir, { recursive: true });
  const sources = readdirSync(V06).filter((f) => f.endsWith(".task.json")).sort().map((f) => JSON.parse(readFileSync(join(V06, f), "utf8")));
  V09_TASKS.forEach(({ id, shape }, i) => {
    const t = { ...eightStageTask(sources[i % sources.length], id, id[0] === "W" || id[0] === "X" ? "B" : id[0]), shape };
    writeFileSync(join(dir, `${id}.task.json`), JSON.stringify(t));
  });
  writeFileSync(join(dir, `${V09_LONG_ID}.task.json`), JSON.stringify(longTask(sources[0])));
  return dir;
}
