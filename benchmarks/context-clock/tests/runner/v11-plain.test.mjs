// EXPERIMENT-V11.md part A: the plain arms O and I. A plain session loads no Context Mode plugin, hook, MCP server or
// skill: the host starts with --setting-sources project,local, --strict-mcp-config and a benchmark plugin that holds
// only the workspace guard (and, in mode I, one PreCompact hook that prints the text of arm R). run.json "session"
// records the configuration and the parts of the init line; telemetry that needs the shim is null (not applicable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeBatch } from "../../graders/grade.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { MODE_NAMES } from "../../analysis/metrics.mjs";
import { buildArgs, buildPersistentArgs } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { MODES } from "../../runner/plan.mjs";
import {
  PLAIN_ISOLATION, buildPlainPlugin, contextModePartsOf, initPartsOf, mergeParts, plainHooks, sessionRecord,
} from "../../runner/plain.mjs";
import { plainPreCompact } from "../../runner/plain/precompact-hook.mjs";
import { BENCH_ROOT, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { MODE_ENV, TRIGGER_ENV, modeEnv } from "../../runner/workspace.mjs";
import { MODES as SCHEMA_MODES, MODE_ENV as SCHEMA_MODE_ENV, validateRun } from "../../fixtures/schema.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const TEXT_FILE = join(BENCH_ROOT, "configs", "precompact-general-instruction.txt");
const TEXT = readFileSync(TEXT_FILE, "utf8").trim();
const TEXT_SHA = sha(TEXT);

/** Run a suite with --mock; the mock host records the env of each turn. `root` keeps results/<batch> for grading. */
async function runSuite(suite, { root = null, args = [] } = {}) {
  const own = root === null;
  const base = root ?? tmp("v11p-root");
  const work = tmp("v11p-work");
  const envs = [];
  try {
    const host = createMockHost({ mockDir: null, behave: ({ env }) => { envs.push({ ...env }); return null; } });
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: join(base, "results"), workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(base, "results", "b", "batch.json"), "utf8"));
    return { r, batch, envs };
  } finally {
    if (own) cleanup(base);
    cleanup(work);
  }
}

// ---------------------------------------------------------------- modes and environment

test("v11 plain: modes O and I are known, have no clock, and carry their analysis names", () => {
  assert.deepEqual(MODES.slice(MODES.indexOf("O"), MODES.indexOf("O") + 2), ["O", "I"]);
  assert.deepEqual(SCHEMA_MODES, MODES);
  for (const m of ["O", "I"]) {
    assert.deepEqual(MODE_ENV[m], { CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null });
    assert.deepEqual(SCHEMA_MODE_ENV[m], MODE_ENV[m]);
  }
  assert.equal(TRIGGER_ENV.O, undefined);
  assert.deepEqual(TRIGGER_ENV.I, { CCB_PRECOMPACT_FILE: "precompact-general-instruction.txt" });
  assert.equal(MODE_NAMES.O, "plain host");
  assert.equal(MODE_NAMES.I, "plain host with summarizer instruction");
  assert.equal(Buffer.byteLength(TEXT), 694);
});

test("v11 plain: a plain run inherits no CTX_* or CCB_* variable and has no Context Mode data folder", () => {
  const parent = { PATH: "x", CTX_CLOCK: "1", CTX_CLOCK_COMPACT: "1", CTX_OTHER: "y", CCB_PRECOMPACT_FILE: "/evil.txt", CCB_ANYTHING: "z", ccb_lower: "q", CONTEXT_MODE_DATA_DIR: "/d" };
  for (const m of ["O", "I"]) {
    const e = modeEnv(m, "data", parent, "ws");
    const bad = Object.keys(e).filter((k) => /^CTX_/i.test(k) || k === "CONTEXT_MODE_DATA_DIR");
    assert.deepEqual(bad, [], m);
    assert.equal(e.CCB_PLAIN, m);
    assert.equal(e.ccb_lower, undefined);
    assert.equal(e.CCB_ANYTHING, undefined);
    assert.equal(e.PATH, "x");
  }
  assert.equal(modeEnv("O", "data", parent, "ws").CCB_PRECOMPACT_FILE, undefined);
  assert.equal(modeEnv("I", "data", parent, "ws").CCB_PRECOMPACT_FILE, TEXT_FILE);
  // The Context Mode modes keep their environment.
  assert.equal(modeEnv("B", "data", parent, "ws").CONTEXT_MODE_DATA_DIR, "data");
  assert.equal(modeEnv("B", "data", parent, "ws").CTX_CLOCK_COMPACT, "off");
});

test("v11 plain: the host flags isolate the session (no user settings, no MCP server)", () => {
  const a = buildArgs({ model: "haiku", pluginDir: "/p", settingsPath: "/s.json", isolation: PLAIN_ISOLATION });
  const at = (k) => a[a.indexOf(k) + 1];
  assert.equal(at("--plugin-dir"), "/p");
  assert.equal(at("--settings"), "/s.json");
  assert.equal(at("--setting-sources"), "project,local");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(!a.includes("--mcp-config"));
  const p = buildPersistentArgs({ model: "haiku", pluginDir: "/p", settingsPath: "/s.json", isolation: PLAIN_ISOLATION });
  assert.ok(p.includes("--strict-mcp-config") && p[p.indexOf("--setting-sources") + 1] === "project,local");
  // Without isolation (the Context Mode arms) nothing changes.
  const b = buildArgs({ model: "haiku", pluginDir: "/p", settingsPath: "/s.json" });
  assert.ok(!b.includes("--setting-sources") && !b.includes("--strict-mcp-config"));
});

test("v11 plain: plain modes need the claude host", () => {
  assert.throws(() => buildPlan({ ...parseArgs(["--host", "codex", "--batch", "x", "--suite", "v11-plain", "--mock"]) }, loadConfigs()), /mode O needs --host claude/);
});

// ---------------------------------------------------------------- the benchmark plugin and its hooks

test("v11 plain: the plugin of O holds only the guard; the plugin of I adds one PreCompact hook", () => {
  const root = tmp("v11p-plugin");
  try {
    for (const m of ["O", "I"]) {
      const { pluginDir, hooks } = buildPlainPlugin({ destDir: join(root, m), mode: m });
      const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
      assert.equal(manifest.name, "ccb-plain");
      assert.equal(manifest.hooks, undefined, "hooks/hooks.json loads by itself");
      assert.equal(manifest.mcpServers, undefined);
      assert.deepEqual(JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")), plainHooks(m));
      assert.deepEqual(hooks.map((h) => h.event), m === "O" ? ["PreToolUse"] : ["PreToolUse", "PreCompact"]);
      assert.equal(readFileSync(join(pluginDir, "ccb", "guard.mjs"), "utf8"), readFileSync(join(BENCH_ROOT, "runner", "overlay", "guard.mjs"), "utf8"), "the same guard");
      assert.equal(existsSync(join(pluginDir, "ccb", "precompact-hook.mjs")), m === "I");
      assert.deepEqual(contextModePartsOf({}, hooks), []);
    }
  } finally {
    cleanup(root);
  }
});

test("v11 plain: the guard of the plugin denies a path outside the workspace and logs it", () => {
  const root = tmp("v11p-guard");
  try {
    const { pluginDir } = buildPlainPlugin({ destDir: join(root, "O"), mode: "O" });
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const log = join(root, "guard.jsonl");
    const env = { ...process.env, CCB_WORKSPACE: ws, CCB_OVERLAY_DIR: pluginDir, CCB_GUARD_LOG: log };
    const secret = join(tmpdir(), "elsewhere", "keys", "x.key.json");
    const r = spawnSync(process.execPath, [join(pluginDir, "ccb", "guard.mjs")], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: secret }, cwd: ws }), env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /deny/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  } finally {
    cleanup(root);
  }
});

test("v11 plain: the PreCompact hook of I prints the trimmed text and logs trigger, bytes and sha256", () => {
  const root = tmp("v11p-hook");
  try {
    const { pluginDir } = buildPlainPlugin({ destDir: join(root, "I"), mode: "I" });
    const log = join(root, "hooks.jsonl");
    const script = join(pluginDir, "ccb", "precompact-hook.mjs");
    for (const trigger of ["manual", "auto"]) {
      const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: "PreCompact", trigger }), env: { ...process.env, CCB_PRECOMPACT_FILE: TEXT_FILE, CCB_SHIM_LOG: log }, encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, TEXT);
    }
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map(({ t, ...x }) => x), ["manual", "auto"].map((trigger) => ({ channel: "precompact", event: "PreCompact", trigger, delivered: true, bytes: 694, sha256: TEXT_SHA })));
    // Without the variable: no output and no line. A missing file: no output, a line with an error.
    const none = spawnSync(process.execPath, [script], { input: "{}", env: { ...process.env, CCB_PRECOMPACT_FILE: "", CCB_SHIM_LOG: join(root, "none.jsonl") }, encoding: "utf8" });
    assert.equal(none.stdout, "");
    assert.equal(existsSync(join(root, "none.jsonl")), false);
    const missing = plainPreCompact(join(root, "nope.txt"), "{}");
    assert.equal(missing.out, "");
    assert.equal(missing.record.delivered, false);
    assert.equal(typeof missing.record.error, "string");
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- session record

test("v11 plain: the session record lists every Context Mode part of the init line", () => {
  const stream = [
    { type: "system", subtype: "init", plugins: [{ name: "context-mode", path: "/x" }], mcp_servers: [{ name: "plugin:context-mode:context-mode", status: "connected" }], tools: ["Read", "mcp__plugin_context-mode_context-mode__ctx_execute"], skills: ["context-mode:context-mode"], slash_commands: ["compact"] },
    { type: "system", subtype: "init", plugins: [{ name: "ccb-plain" }], tools: ["Bash"] },
  ].map((l) => JSON.stringify(l)).join("\n");
  const parts = initPartsOf(stream);
  assert.deepEqual(parts.plugins, ["ccb-plain", "context-mode"]);
  assert.deepEqual(parts.tools, ["Bash", "Read", "mcp__plugin_context-mode_context-mode__ctx_execute"]);
  assert.deepEqual(contextModePartsOf(parts), [
    "plugins:context-mode", "mcpServers:plugin:context-mode:context-mode", "tools:mcp__plugin_context-mode_context-mode__ctx_execute", "skills:context-mode:context-mode",
  ]);
  assert.deepEqual(initPartsOf(""), { plugins: null, mcpServers: null, tools: null, skills: null, slashCommands: null });
  assert.deepEqual(mergeParts(null, { plugins: ["a"], mcpServers: null, tools: null, skills: null, slashCommands: null }).plugins, ["a"]);
  const rec = sessionRecord({ mode: "O", plainRun: { hooks: [] }, parts: null });
  assert.equal(rec.plain, true);
  assert.equal(rec.settingSources, "project,local");
  assert.equal(rec.strictMcpConfig, true);
  assert.deepEqual(rec.contextModeParts, []);
  assert.equal(sessionRecord({ mode: "B", overlay: true }).plugin, "Context Mode overlay");
});

// ---------------------------------------------------------------- suites and mock runs

test("v11 plain: suites v11-plain-smoke and v11-plain", () => {
  const s = loadConfigs().suites;
  const limits = { tasksDir: "tasks/v09", order: "block", runWallTimeMs: 1800000, runToolCalls: 120 };
  assert.deepEqual(s["v11-plain-smoke"], { tasks: ["X12-data-retention"], pick: "all", count: 1, modes: ["I"], reps: 1, ...limits, batchTokens: 4000000 });
  for (const k of ["tasks", "runWallTimeMs", "runToolCalls", "batchTokens", "tasksDir", "reps"]) assert.deepEqual(s["v11-plain-smoke"][k], s["v10-smoke"][k], k);
  assert.deepEqual(s["v11-plain"], { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6, modes: ["O", "I"], reps: 2, ...limits, comparisons: ["I-O"], batchTokens: 35000000 });
  const plan = buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", "v11-plain", "--mock"]) }, loadConfigs());
  assert.equal(plan.runs.length, 24);
  assert.equal(plan.overlay, false, "the plain arms need no overlay");
});

test("v11 plain: mock run of v11-plain-smoke: one arm I run, no Context Mode part, the text at each compaction", { timeout: 600000 }, async () => {
  const { r, batch, envs } = await runSuite("v11-plain-smoke");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["I"]);
  assert.equal(batch.overlay, null);
  assert.deepEqual(batch.precompactPlainInstruction, { file: "configs/precompact-general-instruction.txt", sha256: TEXT_SHA });
  assert.deepEqual(batch.plain.settingSources, "project,local");
  assert.deepEqual(Object.keys(batch.plain.plugins), ["I"]);
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.taskId, "X12-data-retention");
  assert.deepEqual(rec.session.contextModeParts, []);
  // The host always lists its built-in plugins (cc-plugin-*), allowed in an isolated session.
  assert.deepEqual(rec.session.init.plugins, ["cc-plugin-telemetry", "ccb-plain"]);
  assert.deepEqual(rec.session.init.mcpServers, []);
  const n = rec.compactions.length;
  assert.ok(n > 0);
  assert.deepEqual(rec.telemetry.triggers.precompactPlain, { deliveries: n, bytes: 694 * n, sha256s: Array(n).fill(TEXT_SHA), byTrigger: { manual: n, auto: 0, unknown: 0 } });
  assert.equal(rec.telemetry.triggers.precompactProduct.calls, 0, "no product hook");
  assert.equal(rec.telemetry.shim, null, "no shim: not applicable");
  assert.deepEqual(rec.telemetry.guard, { denied: 0, byTool: {} });
  for (const e of envs) assert.deepEqual(Object.keys(e).filter((k) => /^CTX_/i.test(k) || k === "CONTEXT_MODE_DATA_DIR"), []);
  assert.deepEqual(validateRun(rec), []);
});

test("v11 plain: mock run of v11-plain: 24 runs; the grader and the analysis run on the batch", { timeout: 600000 }, async () => {
  const root = tmp("v11p-batch");
  try {
    const { r, batch } = await runSuite("v11-plain", { root });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(batch.modes, ["O", "I"]);
    assert.deepEqual(batch.comparisons, ["I-O"]);
    assert.equal(r.records.length, 24);
    for (const rec of r.records) {
      assert.equal(rec.status, "completed", rec.runId);
      assert.equal(rec.session.plain, true);
      assert.deepEqual(rec.session.contextModeParts, [], rec.runId);
      assert.equal(rec.telemetry.shim, null);
      assert.equal(rec.telemetry.stateBlock, null);
      const n = rec.compactions.length;
      assert.equal(rec.telemetry.triggers.precompactPlain.deliveries, rec.mode === "I" ? n : 0, rec.runId);
      assert.equal(rec.telemetry.triggers.precompact.deliveries, rec.mode === "I" ? n : 0, rec.runId);
      assert.deepEqual(rec.session.hooks.map((h) => h.event), rec.mode === "I" ? ["PreToolUse", "PreCompact"] : ["PreToolUse"]);
      assert.deepEqual(validateRun(rec), [], rec.runId);
    }
    assert.doesNotThrow(() => gradeBatch(root, "b"));
    assert.doesNotThrow(() => analyze({ root, batch: "b" }));
    assert.ok(existsSync(join(root, "results", "b", "summary.json")));
    assert.ok(existsSync(join(root, "results", "b", "report.md")));
  } finally {
    cleanup(root);
  }
});

test("v11 plain: a Context Mode run records its parts, so the check can tell the two kinds apart", { timeout: 600000 }, async () => {
  const { r } = await runSuite("v10-smoke");
  const rec = r.records[0];
  assert.equal(rec.session.plain, false);
  assert.equal(rec.session.plugin, "Context Mode overlay");
  assert.ok(rec.session.contextModeParts.length > 0);
});
