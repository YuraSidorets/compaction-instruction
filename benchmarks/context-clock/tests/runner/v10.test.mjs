// v0.10 (EXPERIMENT-V10.md): mode V is mode R with configs/precompact-variant-instruction.txt as the PreCompact output;
// suites v10-smoke and v10-full; batch.json records the file and the sha256 of the trimmed text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { MODES } from "../../runner/plan.mjs";
import { BENCH_ROOT, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { stageToolsOf } from "../../runner/v05.mjs";
import { V09_TRIGGER_MODES } from "../../runner/v09.mjs";
import { PRECOMPACT_VARIANT_INSTRUCTION_FILE, V10_TRIGGER_MODES, v10Records } from "../../runner/v10.mjs";
import { MODE_ENV, TRIGGER_ENV, modeEnv } from "../../runner/workspace.mjs";
import { MODES as SCHEMA_MODES, MODE_ENV as SCHEMA_MODE_ENV, validateRun } from "../../fixtures/schema.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const VARIANT = "configs/precompact-variant-instruction.txt";
const variantSha = () => sha(readFileSync(join(BENCH_ROOT, VARIANT), "utf8").trim());

async function runSuite(suite, args = []) {
  const results = tmp("v10-res");
  const work = tmp("v10-work");
  try {
    const host = createMockHost({ mockDir: null });
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch };
  } finally {
    cleanup(results, work);
  }
}

test("v10: mode V is a known mode and a trigger mode, with the env of mode R", () => {
  assert.equal(MODES.indexOf("V"), MODES.indexOf("R") + 1);
  assert.deepEqual(SCHEMA_MODES, MODES);
  assert.deepEqual(V10_TRIGGER_MODES, ["V"]);
  assert.deepEqual(V09_TRIGGER_MODES, ["R"]);
  assert.deepEqual(MODE_ENV.V, MODE_ENV.R);
  assert.deepEqual(SCHEMA_MODE_ENV.V, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
  assert.deepEqual(TRIGGER_ENV.V, { CCB_PRECOMPACT_FILE: "precompact-variant-instruction.txt" });
  const v = modeEnv("V", "d", {}, "w");
  const r = modeEnv("R", "d", {}, "w");
  assert.equal(v.CCB_PRECOMPACT_FILE, PRECOMPACT_VARIANT_INSTRUCTION_FILE);
  assert.ok(isAbsolute(v.CCB_PRECOMPACT_FILE) && v.CCB_PRECOMPACT_FILE.endsWith("precompact-variant-instruction.txt"));
  // Only the PreCompact file differs from mode R.
  const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "CCB_PRECOMPACT_FILE"));
  assert.deepEqual(strip(v), strip(r));
  assert.deepEqual(stageToolsOf(["Read"], "V"), stageToolsOf(["Read"], "R"));
  // Mode V needs the overlay, as mode R does.
  const configs = loadConfigs();
  assert.throws(() => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v10-smoke", "--mock", "--overlay", "off"]) }, configs), /mode V needs the overlay/);
});

test("v10: batch record of the variant text is the file and the sha256 of the trimmed text", () => {
  assert.deepEqual(v10Records(["Q", "R"]), { precompactVariantInstruction: null });
  assert.deepEqual(v10Records(["V"]), { precompactVariantInstruction: { file: VARIANT, sha256: variantSha() } });
  assert.match(variantSha(), /^[0-9a-f]{64}$/);
});

test("v10: suites v10-smoke and v10-full", () => {
  const s = loadConfigs().suites;
  const base = { tasksDir: "tasks/v09", order: "block", overlay: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  assert.deepEqual(s["v10-smoke"], { tasks: ["X12-data-retention"], pick: "all", count: 1, modes: ["V"], reps: 1, ...base, batchTokens: 4000000 });
  assert.deepEqual(s["v10-full"], { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6, modes: ["Q", "R", "V"], reps: 2, ...base, comparisons: ["V-R", "V-Q", "R-Q"], batchTokens: 50000000 });
  // The limits of v10-smoke are those of v09-smoke.
  for (const k of ["runWallTimeMs", "runToolCalls", "batchTokens", "order", "overlay", "tasksDir"]) assert.equal(s["v10-smoke"][k], s["v09-smoke"][k], k);
  const configs = loadConfigs();
  const smoke = buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v10-smoke", "--mock"]) }, configs);
  assert.deepEqual(smoke.runs.map((x) => [x.taskId, x.mode, x.rep]), [["X12-data-retention", "V", 1]]);
  const full = buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v10-full", "--mock"]) }, configs);
  assert.equal(full.runs.length, 6 * 3 * 2);
  assert.deepEqual([...new Set(full.runs.map((x) => x.taskId.slice(0, 3)))].sort(), ["A12", "D12", "W12", "X12"]);
  assert.equal(new Set(full.runs.map((x) => x.taskId)).size, 6);
  // Block order: the three modes of a block run next to each other.
  for (let i = 0; i < full.runs.length; i += 3) {
    const b = full.runs.slice(i, i + 3);
    assert.equal(new Set(b.map((x) => `${x.taskId}#${x.rep}`)).size, 1);
    assert.deepEqual(b.map((x) => x.mode).sort(), ["Q", "R", "V"]);
  }
});

test("v10: mock run of v10-smoke delivers the variant text at each compaction", { timeout: 600000 }, async () => {
  const { r, batch } = await runSuite("v10-smoke");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["V"]);
  assert.deepEqual(batch.precompactVariantInstruction, { file: VARIANT, sha256: variantSha() });
  assert.equal(batch.precompactGeneralInstruction, null);
  assert.equal(batch.precompactStrongInstruction, null);
  assert.equal(r.records.length, 1);
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.taskId, "X12-data-retention");
  assert.equal(rec.mode, "V");
  assert.ok(rec.compactions.length > 0);
  assert.deepEqual(rec.telemetry.triggers.precompactByTrigger, { manual: rec.compactions.length, auto: 0, unknown: 0 });
  assert.equal(rec.telemetry.triggers.precompact.deliveries, rec.compactions.length);
  assert.deepEqual(validateRun(rec), []);
});

test("v10: mock run of v10-full completes all 36 runs; each arm gets its own PreCompact text", { timeout: 600000 }, async () => {
  const { r, batch } = await runSuite("v10-full");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["Q", "R", "V"]);
  assert.deepEqual(batch.comparisons ?? ["V-R", "V-Q", "R-Q"], ["V-R", "V-Q", "R-Q"]);
  assert.deepEqual(batch.precompactVariantInstruction, { file: VARIANT, sha256: variantSha() });
  assert.equal(batch.precompactGeneralInstruction.file, "configs/precompact-general-instruction.txt");
  assert.equal(batch.precompactStrongInstruction.file, "configs/precompact-strong-instruction.txt");
  assert.equal(r.records.length, 36);
  for (const rec of r.records) {
    assert.equal(rec.status, "completed", rec.runId);
    assert.ok(rec.compactions.length > 0, rec.runId);
    assert.equal(rec.telemetry.triggers.precompact.deliveries, rec.compactions.length, rec.runId);
    assert.deepEqual(validateRun(rec), [], rec.runId);
  }
  assert.deepEqual(Object.fromEntries(["Q", "R", "V"].map((m) => [m, r.records.filter((x) => x.mode === m).length])), { Q: 12, R: 12, V: 12 });
});
