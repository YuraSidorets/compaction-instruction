// Context Clock v0.3 acceptance (docs/context-clock/v0.3-design.md "Acceptance with the benchmark", arm C3 = mode M):
// mode M has the clock on, feedback off, no overlay text, and CTX_CLOCK_COMPACT unset, so the product hook prints the
// PreCompact text. Every other mode runs with CTX_CLOCK_COMPACT=off. telemetry.triggers.precompactProduct counts the
// "precompact_product" lines of the hook shim. Suites v11-smoke and v11-full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import * as overlayBuild from "../../runner/overlay/build.mjs";
import { prepareOverlay, productPreCompactOf, TRIGGER_CHANNELS } from "../../runner/overlay-run.mjs";
import { MODES } from "../../runner/plan.mjs";
import { BENCH_ROOT, buildPlan, loadConfigs, parseArgs, productCompactSha, runBatch } from "../../runner/run.mjs";
import { emptyTriggers, triggerTelemetry } from "../../runner/v07.mjs";
import { MODE_ENV, PRODUCT_COMPACT_MODES, PRODUCT_COMPACT_TEXT_FILE, TRIGGER_ENV, modeEnv } from "../../runner/workspace.mjs";
import { MODES as SCHEMA_MODES, MODE_ENV as SCHEMA_MODE_ENV, validateRun } from "../../fixtures/schema.mjs";
import { MODE_NAMES } from "../../analysis/metrics.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const TEXT_PATH = join(BENCH_ROOT, "configs", "precompact-general-instruction.txt");
const TEXT = readFileSync(TEXT_PATH, "utf8");
const TEXT_SHA = sha(TEXT.trim());
const OVERLAY_TEXT_VARS = ["CCB_PRECOMPACT_FILE", "CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PERIODIC_FILE"];

async function runSuite(suite, { hostOpts = {}, args = [] } = {}) {
  const results = tmp("v11-res");
  const work = tmp("v11-work");
  try {
    const host = createMockHost({ mockDir: null, ...hostOpts });
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch };
  } finally {
    cleanup(results, work);
  }
}

// ---------------------------------------------------------------- mode M

test("v11: mode M is known, has the env of mode B, no overlay text, and the analysis name", () => {
  assert.equal(MODES.indexOf("M"), MODES.indexOf("V") + 1);
  assert.deepEqual(SCHEMA_MODES, MODES);
  assert.deepEqual(MODE_ENV.M, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
  assert.deepEqual(SCHEMA_MODE_ENV.M, MODE_ENV.M);
  assert.equal(TRIGGER_ENV.M, undefined);
  assert.deepEqual(PRODUCT_COMPACT_MODES, ["M"]);
  assert.equal(PRODUCT_COMPACT_TEXT_FILE, "precompact-general-instruction.txt");
  assert.equal(MODE_NAMES.M, "product PreCompact instruction");
  assert.equal(TEXT.trim().length, 694, "the product prints the 694 bytes of the text of arm R");
  assert.equal(productCompactSha(), TEXT_SHA);
});

test("v11: CTX_CLOCK_COMPACT is unset in mode M and off in every other mode; an inherited value never reaches a run", () => {
  const parent = { PATH: "x", CTX_CLOCK_COMPACT: "1", ctx_clock_compact: "on" };
  const m = modeEnv("M", "d", parent, "w");
  assert.equal(m.CTX_CLOCK, "1");
  assert.equal(m.CTX_CLOCK_FEEDBACK, "off");
  for (const k of Object.keys(m)) assert.notEqual(k.toUpperCase(), "CTX_CLOCK_COMPACT", "mode M leaves CTX_CLOCK_COMPACT unset");
  for (const k of OVERLAY_TEXT_VARS) assert.equal(m[k], undefined, k);
  // EXPERIMENT-V11.md: the plain modes O and I have no CTX_* variable at all (tests/runner/v11-plain.test.mjs).
  for (const mode of MODES.filter((x) => !["M", "O", "I", "Z", "W"].includes(x))) {
    const e = modeEnv(mode, "d", parent, "w");
    assert.equal(e.CTX_CLOCK_COMPACT, "off", mode);
    assert.equal(e.ctx_clock_compact, undefined, mode);
  }
  for (const mode of ["O", "I", "Z", "W"]) assert.equal(modeEnv(mode, "d", parent, "w").CTX_CLOCK_COMPACT, undefined, mode);
  // Mode M differs from mode B only in CTX_CLOCK_COMPACT.
  const b = modeEnv("B", "d", parent, "w");
  const { CTX_CLOCK_COMPACT, ...rest } = b;
  assert.deepEqual(rest, m);
});

test("v11: mode M needs the overlay, because the hook shim records the product output", () => {
  const configs = loadConfigs();
  assert.throws(() => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v11-smoke", "--mock", "--overlay", "off"]) }, configs), /mode M needs the overlay/);
});

// ---------------------------------------------------------------- telemetry

test("v11: triggers.precompactProduct counts the product lines of the shim log", () => {
  assert.ok(TRIGGER_CHANNELS.includes("precompact_product"));
  assert.deepEqual(emptyTriggers().precompactProduct, { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } });
  const dir = tmp("v11-log");
  try {
    const log = join(dir, "shim.jsonl");
    const line = (o) => JSON.stringify({ t: "x", channel: "precompact_product", event: "PreCompact", exitCode: 0, ...o });
    writeFileSync(log, [
      line({ trigger: "manual", bytes: 695, sha256: TEXT_SHA }),
      line({ trigger: "auto", bytes: 695, sha256: TEXT_SHA }),
      line({ trigger: "manual", bytes: 0, sha256: null }),
      line({ trigger: null, bytes: 10, sha256: "a".repeat(64) }),
      JSON.stringify({ channel: "precompact_product", error: "x" }),
    ].join("\n") + "\n");
    assert.deepEqual(triggerTelemetry(log).precompactProduct, {
      calls: 4, deliveries: 3, bytes: 1400, sha256s: [TEXT_SHA, TEXT_SHA, "a".repeat(64)], byTrigger: { manual: 1, auto: 1, unknown: 1 },
    });
    // The other channels do not count the product lines.
    assert.equal(triggerTelemetry(log).precompact.deliveries, 0);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- product PreCompact entry of the plugin

function fakePlugin(root, withPreCompact) {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "context-mode", hooks: "./hooks/claude-code.json", mcpServers: { "context-mode": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] } } }));
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
  const hooks = { PostToolUse: [{ matcher: "^(Bash)$", hooks: [{ type: "command", command: cmd }] }] };
  if (withPreCompact) hooks.PreCompact = [{ hooks: [{ type: "command", command: cmd }] }];
  writeFileSync(join(root, "hooks", "claude-code.json"), JSON.stringify({ hooks }));
  writeFileSync(join(root, "hook.mjs"), "");
  writeFileSync(join(root, "server.mjs"), "");
}

test("v11: a batch with mode M stops before any run when the product plugin has no PreCompact hook", async () => {
  const root = tmp("v11-plugin");
  const saved = process.env.CCB_PLUGIN_SOURCE;
  try {
    for (const withPreCompact of [true, false]) {
      const src = join(root, `src-${withPreCompact}`);
      fakePlugin(src, withPreCompact);
      process.env.CCB_PLUGIN_SOURCE = src;
      const work = join(root, `work-${withPreCompact}`);
      // Without mode M the overlay builds in both cases.
      const ov = await prepareOverlay({ workRoot: work, batch: "b", module: overlayBuild });
      assert.equal(productPreCompactOf(ov.pluginDir), withPreCompact);
      const hooks = JSON.parse(readFileSync(join(ov.pluginDir, "hooks", "claude-code.json"), "utf8")).hooks;
      assert.equal(hooks.PreCompact.length, 1, "one PreCompact entry in both cases");
      if (withPreCompact) {
        const again = await prepareOverlay({ workRoot: work, batch: "b2", module: overlayBuild, needProductPreCompact: true });
        assert.ok(productPreCompactOf(again.pluginDir));
      } else {
        await assert.rejects(prepareOverlay({ workRoot: work, batch: "b2", module: overlayBuild, needProductPreCompact: true }), /mode M needs a product plugin with a PreCompact hook/);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.CCB_PLUGIN_SOURCE;
    else process.env.CCB_PLUGIN_SOURCE = saved;
    cleanup(root);
  }
});

// ---------------------------------------------------------------- suites

test("v11: suites v11-smoke and v11-full", () => {
  const s = loadConfigs().suites;
  const base = { tasksDir: "tasks/v09", order: "block", overlay: true, isolated: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  assert.deepEqual(s["v11-smoke"], { tasks: ["X12-data-retention"], pick: "all", count: 1, modes: ["M"], reps: 1, ...base, batchTokens: 4000000 });
  for (const k of ["tasks", "runWallTimeMs", "runToolCalls", "batchTokens", "order", "overlay", "tasksDir", "reps"]) assert.deepEqual(s["v11-smoke"][k], s["v10-smoke"][k], k);
  assert.deepEqual(s["v11-full"], { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6, modes: ["A", "B", "R", "M"], reps: 2, ...base, comparisons: ["M-R", "M-B", "R-B", "B-A"], batchTokens: 70000000 });
  const configs = loadConfigs();
  const full = buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v11-full", "--mock"]) }, configs);
  assert.equal(full.runs.length, 48);
  assert.equal(full.isolated, true);
  for (let i = 0; i < full.runs.length; i += 4) assert.deepEqual(full.runs.slice(i, i + 4).map((x) => x.mode).sort(), ["A", "B", "M", "R"]);
});

test("v11: mock run of v11-smoke: one product delivery with the hash of the text at each compaction", { timeout: 600000 }, async () => {
  const { r, batch } = await runSuite("v11-smoke");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["M"]);
  assert.deepEqual(batch.precompactProductInstruction, { file: "configs/precompact-general-instruction.txt", sha256: TEXT_SHA });
  assert.equal(batch.precompactGeneralInstruction, null, "no overlay text in mode M");
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.taskId, "X12-data-retention");
  assert.equal(rec.env.CTX_CLOCK_COMPACT, null);
  const n = rec.compactions.length;
  assert.ok(n > 0);
  const p = rec.telemetry.triggers.precompactProduct;
  assert.deepEqual(p, { calls: n, deliveries: n, bytes: n * Buffer.byteLength(TEXT), sha256s: Array(n).fill(TEXT_SHA), byTrigger: { manual: n, auto: 0, unknown: 0 } });
  assert.equal(rec.telemetry.triggers.precompact.deliveries, 0);
  assert.deepEqual(validateRun(rec), []);
});

test("v11: mock run of v11-full: 48 runs; the product prints only in mode M, the overlay text only in mode R", { timeout: 600000 }, async () => {
  const { r, batch } = await runSuite("v11-full");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["A", "B", "R", "M"]);
  assert.equal(batch.isolated, true);
  assert.deepEqual(batch.precompactProductInstruction, { file: "configs/precompact-general-instruction.txt", sha256: TEXT_SHA });
  assert.equal(batch.precompactGeneralInstruction.file, "configs/precompact-general-instruction.txt");
  assert.equal(r.records.length, 48);
  for (const rec of r.records) {
    assert.equal(rec.status, "completed", rec.runId);
    const n = rec.compactions.length;
    assert.ok(n > 0, rec.runId);
    const g = rec.telemetry.triggers;
    assert.equal(g.precompactProduct.calls, n, rec.runId);
    if (rec.mode === "M") {
      assert.equal(rec.env.CTX_CLOCK_COMPACT, null);
      assert.equal(g.precompactProduct.deliveries, n);
      assert.deepEqual(g.precompactProduct.sha256s, Array(n).fill(TEXT_SHA));
      assert.equal(g.precompact.deliveries, 0);
    } else {
      assert.equal(rec.env.CTX_CLOCK_COMPACT, "off", rec.runId);
      assert.deepEqual(g.precompactProduct, { calls: n, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } }, rec.runId);
      assert.equal(g.precompact.deliveries, rec.mode === "R" ? n : 0, rec.runId);
    }
    assert.equal(rec.session.isolated, true, rec.runId);
    assert.deepEqual(rec.session.isolationViolations, [], rec.runId);
    assert.equal(rec.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false", rec.runId);
    assert.deepEqual(validateRun(rec), [], rec.runId);
  }
});

test("v11: an automatic compaction gives a product line with trigger auto", { timeout: 600000 }, async () => {
  const { r } = await runSuite("v09-auto-smoke", { hostOpts: { autoCompactAt: 100000, contextPerTurn: 20000, contextAfterCompact: 10000 } });
  const rec = r.records[0];
  // Mode R: the product prints nothing, so the auto calls are logged with 0 bytes.
  assert.equal(rec.telemetry.triggers.precompactProduct.calls, rec.compactions.length);
  assert.equal(rec.telemetry.triggers.precompactProduct.deliveries, 0);
  const configs = loadConfigs();
  const m = await runSuite("v09-auto-smoke", { hostOpts: { autoCompactAt: 100000, contextPerTurn: 20000, contextAfterCompact: 10000 }, args: ["--modes", "M"] });
  const p = m.r.records[0].telemetry.triggers.precompactProduct;
  assert.ok(configs && p.deliveries > 0);
  assert.deepEqual(p.byTrigger, { manual: 0, auto: p.deliveries, unknown: 0 });
});
