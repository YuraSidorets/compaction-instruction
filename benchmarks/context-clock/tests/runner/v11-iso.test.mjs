// Isolated sessions (suite field "isolated", flag --isolated on|off). With it, an overlay session starts like a plain
// session: --setting-sources project,local and ENABLE_CLAUDEAI_MCP_SERVERS=false, so no user plugin, user hook or user
// MCP server reaches it. The overlay keeps its own MCP server, so an overlay session does not use --strict-mcp-config.
// A run whose init line shows a plugin or MCP server outside the allowed list is infra_failed and never retried.
// Mode Y: the clock on, feedback off, CTX_CLOCK_COMPACT=off, no overlay text. Suites v11-iso-smoke, v11-iso, v12-calib,
// v12-full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArgs, buildPersistentArgs, overlayArgs } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import {
  BUILTIN_PLUGIN, ISOLATED_ENV, OVERLAY_ISOLATION, PLAIN_ISOLATION, allowedPartsOf, isolationViolations, overlayPluginInfo, sessionRecord,
} from "../../runner/plain.mjs";
import { MODES } from "../../runner/plan.mjs";
import { buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { MODE_ENV, TRIGGER_ENV, modeEnv } from "../../runner/workspace.mjs";
import { MODES as SCHEMA_MODES, MODE_ENV as SCHEMA_MODE_ENV, validateRun } from "../../fixtures/schema.mjs";
import { MODE_NAMES } from "../../analysis/metrics.mjs";
import { BENCH_ROOT } from "../../runner/run.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const OVERLAY_PARTS = { plugins: ["cc-plugin-telemetry", "context-mode"], mcpServers: ["plugin:context-mode:context-mode"], tools: [], skills: [], slashCommands: [] };
const PLAIN_PARTS = { plugins: ["cc-plugin-telemetry", "ccb-plain"], mcpServers: [], tools: [], skills: [], slashCommands: [] };

/** A mock host that records the isolation and the environment of every session it opens or turn it runs. */
function recordingHost(hostOpts = {}) {
  const host = createMockHost({ mockDir: null, ...hostOpts });
  const seen = [];
  const note = (a) => seen.push({ plain: a.env?.CCB_PLAIN ?? null, isolation: a.isolation ?? null, connectors: a.env?.ENABLE_CLAUDEAI_MCP_SERVERS ?? null, pluginDir: a.pluginDir ?? null });
  return {
    seen,
    host: {
      ...host,
      openSession: (a) => (note(a), host.openSession(a)),
      runTurn: (a) => (note(a), host.runTurn(a)),
    },
  };
}

async function runSuite(suite, { hostOpts = {}, args = [] } = {}) {
  const results = tmp("v11iso-res");
  const work = tmp("v11iso-work");
  try {
    const { host, seen } = recordingHost(hostOpts);
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch, seen };
  } finally {
    cleanup(results, work);
  }
}

// ---------------------------------------------------------------- flag and plan

test("v11 iso: --isolated on|off overrides the suite field; without the field a suite is not isolated", () => {
  const args = ["--batch", "x", "--suite", "v11-iso"];
  assert.equal(parseArgs(args).isolated, null);
  assert.equal(parseArgs([...args, "--isolated", "on"]).isolated, true);
  assert.equal(parseArgs([...args, "--isolated", "off"]).isolated, false);
  assert.throws(() => parseArgs([...args, "--isolated", "yes"]), /--isolated must be on or off/);
  const configs = loadConfigs();
  const plan = (suite, more = []) => buildPlan(parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock", ...more]), configs);
  assert.equal(plan("v11-iso").isolated, true);
  assert.equal(plan("v11-iso", ["--isolated", "off"]).isolated, false);
  assert.equal(plan("v11-plain").isolated, false, "an old suite keeps its behavior");
  assert.equal(plan("v11-plain", ["--isolated", "on"]).isolated, true);
  assert.equal(plan("v10-full").isolated, false);
});

test("v11 iso: the host flags of an isolated overlay session and of a plain session", () => {
  assert.deepEqual(OVERLAY_ISOLATION, { settingSources: "project,local", strictMcpConfig: false });
  assert.deepEqual(PLAIN_ISOLATION, { settingSources: "project,local", strictMcpConfig: true });
  assert.deepEqual(ISOLATED_ENV, { ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  assert.deepEqual(overlayArgs({ pluginDir: "/p", settingsPath: "/s.json", isolation: OVERLAY_ISOLATION }), ["--plugin-dir", "/p", "--settings", "/s.json", "--setting-sources", "project,local"]);
  assert.deepEqual(overlayArgs({ pluginDir: "/p", settingsPath: "/s.json", isolation: PLAIN_ISOLATION }), ["--plugin-dir", "/p", "--settings", "/s.json", "--setting-sources", "project,local", "--strict-mcp-config"]);
  assert.deepEqual(overlayArgs({ pluginDir: "/p", settingsPath: "/s.json" }), ["--plugin-dir", "/p", "--settings", "/s.json"], "not isolated: as before");
  const a = buildArgs({ sessionId: null, pluginDir: "/p", settingsPath: "/s.json", isolation: OVERLAY_ISOLATION });
  assert.ok(a.includes("--setting-sources") && !a.includes("--strict-mcp-config"));
  const b = buildPersistentArgs({ pluginDir: "/p", settingsPath: "/s.json", isolation: OVERLAY_ISOLATION });
  assert.ok(b.includes("--setting-sources") && !b.includes("--strict-mcp-config"));
});

// ---------------------------------------------------------------- allowed list and session record

test("v11 iso: the allowed list: the overlay plugin with its MCP servers, ccb-plain, and the built-in cc-plugin-* entries", () => {
  assert.ok(BUILTIN_PLUGIN.test("cc-plugin-telemetry") && !BUILTIN_PLUGIN.test("codex"));
  assert.deepEqual(allowedPartsOf("R"), { plugins: ["context-mode"], mcpServerPrefixes: ["plugin:context-mode:"] });
  assert.deepEqual(allowedPartsOf("O"), { plugins: ["ccb-plain"], mcpServerPrefixes: [] });
  assert.deepEqual(isolationViolations(OVERLAY_PARTS, "R"), []);
  assert.deepEqual(isolationViolations(PLAIN_PARTS, "I"), []);
  const user = { plugins: [...OVERLAY_PARTS.plugins, "simple-english", "codex"], mcpServers: [...OVERLAY_PARTS.mcpServers, "repowise", "claude.ai Google Drive"] };
  assert.deepEqual(isolationViolations(user, "B"), ["plugin simple-english", "plugin codex", "MCP server repowise", "MCP server claude.ai Google Drive"]);
  assert.deepEqual(isolationViolations(OVERLAY_PARTS, "O"), ["plugin context-mode", "MCP server plugin:context-mode:context-mode"], "a plain run allows no Context Mode part");
  assert.deepEqual(isolationViolations(PLAIN_PARTS, "R"), ["plugin ccb-plain"]);
});

test("v11 iso: the session record shows isolated, plugins, MCP servers and hooks", () => {
  const hooks = [{ event: "PreCompact", command: "x" }];
  const iso = sessionRecord({ mode: "R", overlay: true, parts: OVERLAY_PARTS, isolated: true, overlayHooks: hooks });
  assert.equal(iso.isolated, true);
  assert.equal(iso.settingSources, "project,local");
  assert.equal(iso.strictMcpConfig, false);
  assert.equal(iso.claudeAiConnectors, "off");
  assert.deepEqual(iso.plugins, OVERLAY_PARTS.plugins);
  assert.deepEqual(iso.mcpServers, OVERLAY_PARTS.mcpServers);
  assert.deepEqual(iso.hooks, hooks);
  assert.deepEqual(iso.isolationViolations, []);
  const old = sessionRecord({ mode: "R", overlay: true, parts: OVERLAY_PARTS });
  assert.equal(old.isolated, false);
  assert.equal(old.settingSources, "default");
  assert.equal(old.isolationViolations, null);
  const plain = sessionRecord({ mode: "O", plainRun: { hooks }, parts: PLAIN_PARTS, isolated: true });
  assert.equal(plain.strictMcpConfig, true);
  assert.deepEqual(plain.hooks, hooks);
  assert.deepEqual(plain.contextModeParts, []);
  assert.equal(sessionRecord({ mode: "R", overlay: true, parts: null, isolated: true }).isolationViolations, null, "no init line: nothing to check");
  assert.deepEqual(overlayPluginInfo(null), { name: "context-mode", hooks: null });
  const dir = tmp("v11iso-plugin");
  try {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "context-mode", hooks: "./hooks/claude-code.json" }));
    writeFileSync(join(dir, "hooks", "claude-code.json"), JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "node shim.mjs" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.mjs" }] }] } }));
    assert.deepEqual(overlayPluginInfo(dir), {
      name: "context-mode",
      hooks: [{ event: "PreCompact", matcher: null, command: "node shim.mjs" }, { event: "PreToolUse", matcher: "Bash", command: "node guard.mjs" }],
    });
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- mode Y

test("v11 iso: mode Y has the clock on, feedback off, CTX_CLOCK_COMPACT=off, no overlay text, and its analysis name", () => {
  assert.ok(MODES.includes("Y"));
  assert.deepEqual(SCHEMA_MODES, MODES);
  assert.deepEqual(MODE_ENV.Y, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
  assert.deepEqual(SCHEMA_MODE_ENV.Y, MODE_ENV.Y);
  assert.equal(TRIGGER_ENV.Y, undefined);
  const env = modeEnv("Y", "d", { PATH: "x", CTX_CLOCK_COMPACT: "1" }, "w");
  assert.equal(env.CTX_CLOCK, "1");
  assert.equal(env.CTX_CLOCK_FEEDBACK, "off");
  assert.equal(env.CTX_CLOCK_COMPACT, "off");
  assert.equal(MODE_NAMES.Y, "clock on, instruction off");
  // NEWER_MODES is not exported: read it from the source.
  const src = readFileSync(join(BENCH_ROOT, "analysis", "metrics.mjs"), "utf8");
  assert.match(/const NEWER_MODES = Object\.freeze\(\[([^\]]*)\]/.exec(src)[1], /"Y"/);
});

// ---------------------------------------------------------------- suites

test("v11 iso: suites v11-iso-smoke, v11-iso, v12-calib and v12-full", () => {
  const s = loadConfigs().suites;
  const base = { tasksDir: "tasks/v09", order: "block", overlay: true, isolated: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  const pre = { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6 };
  assert.deepEqual(s["v11-iso-smoke"], { tasks: ["X12-data-retention"], pick: "all", count: 1, modes: ["R"], reps: 1, ...base, batchTokens: 4000000 });
  assert.deepEqual(s["v11-iso"], { ...pre, modes: ["O", "I", "B", "R"], reps: 2, ...base, comparisons: ["I-O", "R-B", "B-O", "R-I"], batchTokens: 70000000 });
  assert.deepEqual(s["v12-calib"], { ...pre, modes: ["B"], reps: 1, ...base, batchTokens: 12000000 });
  assert.deepEqual(s["v12-full"], { ...pre, modes: ["B", "R"], reps: 2, ...base, comparisons: ["R-B"], batchTokens: 35000000 });
  const configs = loadConfigs();
  const plan = (suite) => buildPlan(parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock"]), configs);
  assert.equal(plan("v11-iso-smoke").runs.length, 1);
  const iso = plan("v11-iso");
  assert.equal(iso.runs.length, 48);
  assert.equal(iso.overlay, true);
  for (let i = 0; i < iso.runs.length; i += 4) assert.deepEqual(iso.runs.slice(i, i + 4).map((x) => x.mode).sort(), ["B", "I", "O", "R"]);
  assert.equal(plan("v12-calib").runs.length, 6);
  assert.equal(plan("v12-full").runs.length, 24);
  for (const k of ["v11-iso-smoke", "v11-iso", "v12-calib", "v12-full", "v11-smoke", "v11-full"]) assert.equal(plan(k).isolated, true, k);
});

// ---------------------------------------------------------------- mock runs

test("v11 iso: mock run of v11-iso-smoke: the overlay session runs isolated with its own MCP server", { timeout: 600000 }, async () => {
  const { r, batch, seen } = await runSuite("v11-iso-smoke");
  assert.equal(r.exitCode, 0);
  assert.equal(batch.isolated, true);
  assert.deepEqual(batch.isolation, { settingSources: "project,local", strictMcpConfigOverlay: false, strictMcpConfigPlain: true, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  assert.ok(seen.length > 0);
  for (const x of seen) {
    assert.deepEqual(x.isolation, OVERLAY_ISOLATION);
    assert.equal(x.connectors, "false");
    assert.ok(x.pluginDir);
  }
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.mode, "R");
  assert.equal(rec.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(rec.session.isolated, true);
  assert.equal(rec.session.plugin, "Context Mode overlay");
  assert.deepEqual(rec.session.plugins, ["cc-plugin-telemetry", "context-mode"]);
  assert.deepEqual(rec.session.mcpServers, ["plugin:context-mode:context-mode"]);
  // The mock overlay has no plugin files, so its hook list is null; overlayPluginInfo reads a real one (test below).
  assert.equal(rec.session.hooks, null);
  assert.deepEqual(rec.session.isolationViolations, []);
  assert.deepEqual(validateRun(rec), []);
});

test("v11 iso: mock run of v11-iso: plain and overlay modes in one suite; the mode decides the session kind", { timeout: 600000 }, async () => {
  const { r, batch, seen } = await runSuite("v11-iso");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["O", "I", "B", "R"]);
  assert.deepEqual(Object.keys(batch.plain.plugins).sort(), ["I", "O"]);
  assert.equal(r.records.length, 48);
  for (const x of seen) {
    assert.deepEqual(x.isolation, x.plain ? PLAIN_ISOLATION : OVERLAY_ISOLATION);
    assert.equal(x.connectors, "false");
  }
  assert.ok(seen.some((x) => x.plain) && seen.some((x) => !x.plain));
  for (const rec of r.records) {
    assert.equal(rec.status, "completed", rec.runId);
    const plain = rec.mode === "O" || rec.mode === "I";
    assert.equal(rec.session.plain, plain, rec.runId);
    assert.equal(rec.session.isolated, true, rec.runId);
    assert.deepEqual(rec.session.plugins, plain ? ["cc-plugin-telemetry", "ccb-plain"] : ["cc-plugin-telemetry", "context-mode"], rec.runId);
    assert.deepEqual(rec.session.mcpServers, plain ? [] : ["plugin:context-mode:context-mode"], rec.runId);
    assert.deepEqual(rec.session.isolationViolations, [], rec.runId);
    if (plain) assert.deepEqual(rec.session.contextModeParts, [], rec.runId);
    const n = rec.compactions.length;
    assert.equal(rec.telemetry.triggers.precompactPlain.deliveries, rec.mode === "I" ? n : 0, rec.runId);
    // The PreCompact text reaches the model in mode R (overlay hook) and in mode I (benchmark hook).
    assert.equal(rec.telemetry.triggers.precompact.deliveries, rec.mode === "R" || rec.mode === "I" ? n : 0, rec.runId);
    assert.deepEqual(validateRun(rec), [], rec.runId);
  }
});

test("v11 iso: mock run of v12-calib: six B runs, isolated", { timeout: 600000 }, async () => {
  const { r, batch } = await runSuite("v12-calib");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["B"]);
  assert.equal(r.records.length, 6);
  for (const rec of r.records) {
    assert.equal(rec.status, "completed", rec.runId);
    assert.equal(rec.session.isolated, true);
    assert.equal(rec.env.CTX_CLOCK, "1");
    assert.equal(rec.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  }
});

test("v11 iso: a user plugin or MCP server in an isolated session makes the run infra_failed, with no retry", { timeout: 600000 }, async () => {
  const initExtra = { plugins: [{ name: "simple-english", path: "<user>" }], mcp_servers: [{ name: "repowise", status: "pending" }] };
  const { r } = await runSuite("v11-iso-smoke", { hostOpts: { initExtra } });
  const rec = r.records[0];
  assert.equal(rec.status, "infra_failed");
  assert.equal(rec.failure.kind, "isolation_violation");
  assert.match(rec.failure.message, /plugin simple-english, MCP server repowise/);
  assert.equal(rec.attempts.length, 1, "no retry hides it");
  assert.deepEqual(rec.session.isolationViolations, ["plugin simple-english", "MCP server repowise"]);
  assert.deepEqual(validateRun(rec), []);
  // The same in a plain run.
  const p = await runSuite("v11-iso-smoke", { hostOpts: { initExtra }, args: ["--modes", "O"] });
  assert.equal(p.r.records[0].status, "infra_failed");
  assert.equal(p.r.records[0].failure.kind, "isolation_violation");
});

test("v11 iso: without isolation the same session completes and the record and environment stay as before", { timeout: 600000 }, async () => {
  const initExtra = { plugins: [{ name: "simple-english", path: "<user>" }], mcp_servers: [{ name: "repowise", status: "pending" }] };
  const { r, batch, seen } = await runSuite("v11-iso-smoke", { hostOpts: { initExtra }, args: ["--isolated", "off"] });
  assert.equal(batch.isolated, false);
  assert.equal(batch.isolation, null);
  for (const x of seen) {
    assert.equal(x.isolation, null);
    assert.equal(x.connectors, null);
  }
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  assert.equal(rec.session.isolated, false);
  assert.equal(rec.session.settingSources, "default");
  assert.equal(rec.session.isolationViolations, null);
  assert.ok(rec.session.plugins.includes("simple-english"));
});
