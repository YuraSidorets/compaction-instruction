// v0.10 fixture, built on the v0.9 fixture: suite v10-full, modes Q, R and V, and a pool batch.
//
// - Modes B and N are removed from the batch. Each R run is copied to a V run.
// - The V summaries add the line "API gateway history: kong-gw, then envoy-gw" after stage 3, so each V summary of
//   stages 5 and 7 holds a history line. Q and R summaries hold none.
// - The V grade of R8-alpha has score 1 (R and Q: 0.75), so V minus R is +0.25 on R8-alpha and 0 on R8-beta.
// - Pool batch POOL ("v09-pool"): the run and grade records of the v0.9 fixture before the removal (modes B, N, Q, R),
//   with no raw stream. Both batch.json files hold cli.version and overlay.sourceSha; `build` changes the pool values.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BATCH, runId, TASKS, writeV09Fixture } from "./fixture-v09.mjs";

export { BATCH, runId, TASKS };
export const POOL = "v09-pool";
export const MODES = Object.freeze(["Q", "R", "V"]);
export const HOST_VERSION = "2.1.331";
export const PLUGIN_BUILD = "963bdcca";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");

/** Writes the v0.10 fixture into a new temp root. `poolBuild` overrides { hostVersion, pluginBuild } of the pool batch. */
export function writeV10Fixture({ suite = "v10-full", poolBuild = {}, poolField = null } = {}) {
  const { root } = writeV09Fixture({ suite });
  const batchDir = join(root, "results", BATCH);
  const poolDir = join(root, "results", POOL);

  // The pool batch: run and grade records only.
  for (const id of readdirSync(join(batchDir, "runs"))) {
    mkdirSync(join(poolDir, "runs", id), { recursive: true });
    for (const f of ["run.json", "grade.json"]) cpSync(join(batchDir, "runs", id, f), join(poolDir, "runs", id, f));
  }
  const batch = readJson(join(batchDir, "batch.json"));
  writeJson(join(poolDir, "batch.json"), { ...batch, batch: POOL, suite: "v09-full", modes: ["B", "N", "Q", "R"], cli: { name: "claude", version: poolBuild.hostVersion ?? HOST_VERSION }, overlay: { pluginDir: "<overlay>", sourceSha: poolBuild.pluginBuild ?? PLUGIN_BUILD } });
  writeJson(join(batchDir, "batch.json"), { ...batch, modes: [...MODES], cli: { name: "claude", version: HOST_VERSION }, overlay: { pluginDir: "<overlay>", sourceSha: PLUGIN_BUILD }, ...(poolField === null ? {} : { poolBatches: poolField }) });

  for (const taskId of TASKS) {
    for (const m of ["B", "N"]) for (const d of ["runs", "raw"]) rmSync(join(batchDir, d, runId(taskId, m)), { recursive: true, force: true });
    const r = runId(taskId, "R");
    const v = runId(taskId, "V");
    for (const d of ["runs", "raw"]) cpSync(join(batchDir, d, r), join(batchDir, d, v), { recursive: true });
    const run = readJson(join(batchDir, "runs", v, "run.json"));
    writeJson(join(batchDir, "runs", v, "run.json"), { ...run, runId: v, mode: "V" });
    const grade = readJson(join(batchDir, "runs", v, "grade.json"));
    writeJson(join(batchDir, "runs", v, "grade.json"), { ...grade, runId: v, ...(taskId === "R8-alpha" ? { score: 1, success: true, questions: grade.questions.map((q) => ({ ...q, correct: true, reason: null })) } : {}) });
    for (const st of [5, 7]) {
      const file = join(batchDir, "raw", v, "a1", "compact-" + st + ".jsonl");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      for (const l of lines) if (typeof l.message?.content === "string" && l.message.content.startsWith("This session is being continued")) l.message.content += "\nAPI gateway history: kong-gw, then envoy-gw";
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    }
  }
  return { root };
}
