// v0.9 fixture, built on the v0.8 fixture: suite v09-full, modes B, N, Q, R (R is the Q run renamed), task R8-alpha
// of shape "old" (no field) and task R8-beta of shape "worklog".
//
// Changes against the v0.8 fixture:
// - Mode U is removed. Each Q run is copied to an R run with the same streams and grade.
// - R8-alpha R: the compactions carry a trigger ("auto" for the first, "manual" for the others) and preTokens. The
//   task checkpoint is after stage 3 with probes c1 and c2. The R grade has c1 correct and c2 wrong.
// - R8-beta B: run.json has no compaction.
//
// Also the summary lines of the matcher repair, cut from the v08-full-01 compact streams of task B11-ride-hailing,
// arm Q (run r1 and run r2, after stage 3). They hold no account name or path.
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BATCH, runId, TASKS, writeV08Fixture } from "./fixture-v08.mjs";

export { BATCH, runId, TASKS };
export const MODES = Object.freeze(["B", "N", "Q", "R"]);

/** Run r1 shape: a heading that ends with a colon, then bare "service: value" lines. */
export const SUMMARY_R1 = [
  "Owners (team per service):",
  "geo-index: team-pricing",
  "geo-index owner history: team-safety, then team-pricing",
  "heatmap-svc: team-drivers",
  "heatmap-svc owner history: team-safety, then team-drivers",
  "",
  "Direct dependencies (current list per service, with history where it changed):",
  "geo-index: heatmap-svc",
  "geo-index dependency history: none, then heatmap-svc",
  "heatmap-svc: rider-api",
  "heatmap-svc dependency history: none, then rider-api",
].join("\n");

/** Run r2 shape: a heading with no final colon and a colon inside parentheses, then list items. */
export const SUMMARY_R2 = [
  "Tracked state:",
  "Owning team (identifier: current value; history where changed)",
  "- geo-index: team-pricing; history: team-safety (e001), then team-pricing (e044)",
  "- heatmap-svc: team-drivers; history: team-safety (e002), then team-drivers (e183)",
  "",
  "Direct dependencies (identifier: current list; members removed listed on history line)",
  "- geo-index: heatmap-svc",
  "- heatmap-svc: rider-api",
].join("\n");

/** The reference facts of the summary lines (tasks/v08/reference/B11-ride-hailing.state.json, stage 3). */
export const B11_FACTS = Object.freeze([
  { name: "owning team of geo-index", kind: "scalar", value: "team-pricing", history: ["team-safety"] },
  { name: "dependencies of geo-index", kind: "set", value: ["heatmap-svc"], history: null },
  { name: "owning team of heatmap-svc", kind: "scalar", value: "team-drivers", history: ["team-safety"] },
  { name: "dependencies of heatmap-svc", kind: "set", value: ["rider-api"], history: null },
]);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");

/**
 * Writes the v0.9 fixture into a new temp root. With `auto`, the R8-alpha checkpoint has the timing
 * after_auto_compaction with probes c1 (stage 3) and c2 (stage 5). The R run of R8-alpha has a probe turn at stage 3
 * only, so its grade has c1 asked and correct, and c2 not asked (asked 1 of 2).
 */
export function writeV09Fixture({ suite = "v09-full", auto = false } = {}) {
  const { root } = writeV08Fixture({ suite });
  const batchDir = join(root, "results", BATCH);
  const tasksDir = join(root, "tasks", "v08", "generated");
  const batch = readJson(join(batchDir, "batch.json"));
  writeJson(join(batchDir, "batch.json"), { ...batch, modes: [...MODES] });

  const alpha = readJson(join(tasksDir, "R8-alpha.task.json"));
  alpha.checkpoint = { afterStage: 3, timing: "after_compaction", questions: [
    { id: "c1", text: "c1?", type: "choice", options: ["x", "y"] },
    { id: "c2", text: "c2?", type: "choice", options: ["x", "y"] },
  ] };
  if (auto) Object.assign(alpha.checkpoint, { timing: "after_auto_compaction", probes: [{ afterStage: 3, questionIds: ["c1"] }, { afterStage: 5, questionIds: ["c2"] }] });
  writeJson(join(tasksDir, "R8-alpha.task.json"), alpha);
  const beta = readJson(join(tasksDir, "R8-beta.task.json"));
  writeJson(join(tasksDir, "R8-beta.task.json"), { ...beta, shape: "worklog" });

  for (const taskId of TASKS) {
    rmSync(join(batchDir, "runs", runId(taskId, "U")), { recursive: true, force: true });
    rmSync(join(batchDir, "raw", runId(taskId, "U")), { recursive: true, force: true });
    const q = runId(taskId, "Q");
    const r = runId(taskId, "R");
    cpSync(join(batchDir, "runs", q), join(batchDir, "runs", r), { recursive: true });
    cpSync(join(batchDir, "raw", q), join(batchDir, "raw", r), { recursive: true });
    const run = readJson(join(batchDir, "runs", r, "run.json"));
    run.runId = r;
    run.mode = "R";
    if (taskId === "R8-alpha") run.compactions = run.compactions.map((c, i) => ({ ...c, trigger: i === 0 ? "auto" : "manual", preTokens: 150000 + i }));
    if (taskId === "R8-alpha" && auto) run.turns.splice(run.turns.findIndex((t) => t.kind === "compact" && t.stage === 3) + 1, 0, { kind: "checkpoint", stage: 3 });
    writeJson(join(batchDir, "runs", r, "run.json"), run);
    const grade = readJson(join(batchDir, "runs", r, "grade.json"));
    grade.runId = r;
    if (taskId === "R8-alpha" && auto) {
      grade.checkpoint = { questions: 2, asked: 1, correct: 1 };
      grade.checkpointItems = [
        { id: "c1", type: "choice", correct: true, given: "x", reason: null, asked: true },
        { id: "c2", type: "choice", correct: false, given: null, reason: "missing", asked: false },
      ];
    } else if (taskId === "R8-alpha") {
      grade.checkpoint = { questions: 2, correct: 1 };
      grade.checkpointItems = [
        { id: "c1", type: "choice", correct: true, given: "x", reason: null },
        { id: "c2", type: "choice", correct: false, given: "y", reason: "wrong_value" },
      ];
    }
    writeJson(join(batchDir, "runs", r, "grade.json"), grade);
  }
  const bBeta = join(batchDir, "runs", runId("R8-beta", "B"), "run.json");
  writeJson(bBeta, { ...readJson(bBeta), compactions: [] });
  return { root, runs: readdirSync(join(batchDir, "runs")).sort() };
}

