// v12 plain arms (docs/context-clock/PLAN-standalone.md calls them S and C; the runner uses Z and W):
// - Z: plain host, isolated, plus the standalone plugin compaction-instruction loaded unchanged as a second --plugin-dir.
//   The plugin writes no log. telemetry.triggers.precompactStandalone comes from the host records: after a manual
//   compaction Claude Code writes "<local-command-stdout>Compacted PreCompact [<command>] completed successfully:
//   <stdout></local-command-stdout>". For an automatic compaction it writes nothing, so the call is "unobserved".
// - W: plain host, isolated, no PreCompact hook; the runner writes CLAUDE.md into the workspace root before the session.
//   The "instructions" attachments of the host transcript show whether the host loaded it.
// Suites v12-smoke, v12-main, v12-opus, v12-auto, v12-rerun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overlayArgs } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { guardDecision } from "../../runner/overlay/guard.mjs";
import {
  CLAUDE_MD_TEXT_FILE, DEFAULT_STANDALONE_DIR, PLAIN_MODES, STANDALONE_PLUGIN_NAME, allowedPartsOf, claudeMdLoaded, claudeMdText, compactStdoutRecords,
  hostDebugRuns, instructionFilesOf, isolationViolations, parseCompactStdout, preCompactDebugLines, plainHooks, standaloneDirOf, standalonePluginInfo, standaloneTelemetry,
} from "../../runner/plain.mjs";
import { MODES } from "../../runner/plan.mjs";
import { BENCH_ROOT, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { integrityScan } from "../../runner/telemetry.mjs";
import { MODE_ENV, TRIGGER_ENV, modeEnv } from "../../runner/workspace.mjs";
import { MODES as SCHEMA_MODES, MODE_ENV as SCHEMA_MODE_ENV, validateRun } from "../../fixtures/schema.mjs";
import { gradeBatch } from "../../graders/grade.mjs";
import { analyze } from "../../analysis/analyze.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const TEXT = readFileSync(join(BENCH_ROOT, "configs", "precompact-general-instruction.txt"), "utf8").trim();
const TEXT_SHA = sha(TEXT);
const COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/precompact.mjs"';

/** A plugin folder with the layout of compaction-instruction: manifest, hooks/hooks.json, a script that prints the text. */
function fixturePlugin(dir, { name = STANDALONE_PLUGIN_NAME, preCompact = true } = {}) {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "0.1.0" }));
  const hooks = preCompact ? { PreCompact: [{ hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }] } : { Stop: [{ hooks: [{ type: "command", command: "node x.mjs" }] }] };
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }));
  writeFileSync(join(dir, "instruction.txt"), TEXT + "\n");
  writeFileSync(join(dir, "scripts", "precompact.mjs"), [
    'import { readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'if (!["0", "false", "off", "no"].includes(String(process.env.COMPACTION_INSTRUCTION ?? "").trim().toLowerCase())) {',
    '  process.stdout.write(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "instruction.txt"), "utf8").trim());',
    "}",
  ].join("\n"));
  return dir;
}

async function runSuite(suite, { hostOpts = {}, args = [], env = {}, root = null } = {}) {
  const results = root ? join(root, "results") : tmp("v12-res");
  const work = tmp("v12-work");
  const plugin = fixturePlugin(tmp("v12-plugin"));
  const saved = {};
  const vars = { CCB_STANDALONE_PLUGIN: plugin, ...env };
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const host = createMockHost({ mockDir: null, ...hostOpts });
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", ...args]), resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, log: () => {} });
    const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
    return { r, batch, plugin };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(...(root ? [] : [results]), work, plugin);
  }
}

// ---------------------------------------------------------------- modes

test("v12: modes Z and W are plain modes with no clock, no Context Mode variable and no benchmark PreCompact hook", () => {
  for (const m of ["Z", "W"]) {
    assert.ok(MODES.includes(m) && PLAIN_MODES.includes(m), m);
    assert.deepEqual(MODE_ENV[m], { CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null });
    assert.deepEqual(SCHEMA_MODE_ENV[m], MODE_ENV[m]);
    assert.equal(TRIGGER_ENV[m], undefined, "no benchmark PreCompact text");
    const env = modeEnv(m, "/d", { PATH: "x", CTX_CLOCK: "1", CCB_PRECOMPACT_FILE: "y", COMPACTION_INSTRUCTION: "off", compaction_instruction: "0" }, "/w");
    for (const k of Object.keys(env)) assert.ok(!/^CTX_/i.test(k) && !/^COMPACTION_INSTRUCTION$/i.test(k), `${m}: ${k}`);
    assert.equal(env.CCB_PLAIN, m);
    assert.equal(env.CCB_PRECOMPACT_FILE, undefined);
    assert.equal(env.CONTEXT_MODE_DATA_DIR, undefined);
    // Only the guard: the PreCompact hook of mode I must not run in Z or W.
    assert.deepEqual(Object.keys(plainHooks(m).hooks), ["PreToolUse"], m);
  }
  assert.deepEqual(SCHEMA_MODES, MODES);
  assert.deepEqual(Object.keys(plainHooks("I").hooks), ["PreToolUse", "PreCompact"]);
});

test("v12: the allowed list of Z holds ccb-plain, compaction-instruction and cc-plugin-*; the other plain modes do not allow the plugin", () => {
  assert.deepEqual(allowedPartsOf("Z"), { plugins: ["ccb-plain", "compaction-instruction"], mcpServerPrefixes: [] });
  const z = { plugins: ["cc-plugin-telemetry", "ccb-plain", "compaction-instruction"], mcpServers: [] };
  assert.deepEqual(isolationViolations(z, "Z"), []);
  assert.deepEqual(isolationViolations(z, "W"), ["plugin compaction-instruction"]);
  assert.deepEqual(isolationViolations(z, "O"), ["plugin compaction-instruction"]);
  assert.deepEqual(isolationViolations({ plugins: ["ccb-plain", "codex"], mcpServers: ["repowise"] }, "Z"), ["plugin codex", "MCP server repowise"]);
});

test("v12: the host gets one --plugin-dir for each plugin folder of mode Z", () => {
  assert.deepEqual(overlayArgs({ pluginDir: ["/plain", "/standalone"], settingsPath: "/s.json", isolation: { settingSources: "project,local", strictMcpConfig: true } }),
    ["--plugin-dir", "/plain", "--plugin-dir", "/standalone", "--settings", "/s.json", "--setting-sources", "project,local", "--strict-mcp-config"]);
  assert.deepEqual(overlayArgs({ pluginDir: "/plain" }), ["--plugin-dir", "/plain"]);
  assert.deepEqual(overlayArgs({ pluginDir: "/plain", isolation: { settingSources: "project,local", strictMcpConfig: true, debugFile: "/d/host-debug.txt" } }),
    ["--plugin-dir", "/plain", "--setting-sources", "project,local", "--strict-mcp-config", "--debug-file", "/d/host-debug.txt"]);
});

test("v12: the standalone plugin folder: env CCB_STANDALONE_PLUGIN or the default; its manifest, hooks and text hash", () => {
  assert.equal(standaloneDirOf({}), DEFAULT_STANDALONE_DIR);
  const dir = tmp("v12-info");
  try {
    assert.equal(standaloneDirOf({ CCB_STANDALONE_PLUGIN: dir }), dir);
    assert.throws(() => standalonePluginInfo(dir), /no plugin manifest/);
    fixturePlugin(dir, { preCompact: false });
    assert.throws(() => standalonePluginInfo(dir), /no PreCompact hook/);
    fixturePlugin(dir);
    const info = standalonePluginInfo(dir);
    assert.equal(info.name, "compaction-instruction");
    assert.equal(info.version, "0.1.0");
    assert.deepEqual(info.hooks, [{ event: "PreCompact", matcher: null, command: COMMAND }]);
    assert.deepEqual(info.text, { bytes: 694, sha256: TEXT_SHA });
    assert.match(info.hooksSha256, /^[0-9a-f]{64}$/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- host records

test("v12: the PreCompact outputs of the 'Compacted' message (the form Claude Code 2.1.331 writes)", () => {
  assert.deepEqual(parseCompactStdout(""), []);
  assert.deepEqual(parseCompactStdout(`PreCompact [${COMMAND}] completed successfully: ${TEXT}`), [{ command: COMMAND, status: "completed successfully", stdout: TEXT }]);
  assert.deepEqual(parseCompactStdout("PreCompact [a] completed successfully: one\ntwo\nPreCompact [b] completed successfully: three"),
    [{ command: "a", status: "completed successfully", stdout: "one\ntwo" }, { command: "b", status: "completed successfully", stdout: "three" }]);
  const stream = [
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } },
    { type: "user", message: { role: "user", content: "This session is being continued ..." } },
    { type: "user", message: { role: "user", content: `<local-command-stdout>Compacted PreCompact [${COMMAND}] completed successfully: ${TEXT}</local-command-stdout>` } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "<local-command-stdout>Compacted </local-command-stdout>" }] } },
  ].map((x) => JSON.stringify(x)).join("\n");
  assert.deepEqual(compactStdoutRecords(stream), [[{ command: COMMAND, status: "completed successfully", stdout: TEXT }], []]);
});

test("v12: precompactStandalone counts deliveries of the plugin command; an automatic compaction without a record is unobserved", () => {
  const seg = (command, stdout, status = "completed successfully") => ({ command, status, stdout });
  const t = standaloneTelemetry([
    { trigger: "manual", segments: [seg(COMMAND, TEXT)] },
    { trigger: "manual", segments: [seg("node other.mjs", "x"), seg(COMMAND, TEXT)] },
    { trigger: "manual", segments: [] },
    { trigger: "manual", segments: [seg(COMMAND, "y", "failed with non-blocking status code 1")] },
    { trigger: "auto", segments: null },
  ], [COMMAND]);
  assert.deepEqual(t, { calls: 5, deliveries: 2, bytes: 2 * 694, sha256s: [TEXT_SHA, TEXT_SHA], byTrigger: { manual: 2, auto: 0, unknown: 0 }, unobserved: 1, hookRuns: null });
  assert.equal(JSON.stringify(t).includes(TEXT.slice(0, 40)), false, "the text itself is never stored");
});

test("v12: the instruction files of the host transcript, and the evidence that the workspace CLAUDE.md loaded", () => {
  assert.equal(instructionFilesOf(null), null);
  const tr = [
    { type: "attachment", attachment: { type: "instructions", files: [{ path: "C:\\ws\\CLAUDE.md", type: "Project", content: "abc" }, { path: "C:\\home\\.claude\\CLAUDE.md", type: "Project", content: "u" }] } },
    { type: "attachment", attachment: { type: "instructions", files: [{ path: "C:\\ws\\CLAUDE.md", type: "Project", content: "abc" }] } },
    { type: "attachment", attachment: { type: "date" } },
  ].map((x) => JSON.stringify(x)).join("\n");
  const files = instructionFilesOf(tr);
  assert.deepEqual(files, [
    { path: "C:\\ws\\CLAUDE.md", type: "Project", bytes: 3, sha256: sha("abc"), loads: 2 },
    { path: "C:\\home\\.claude\\CLAUDE.md", type: "Project", bytes: 1, sha256: sha("u"), loads: 1 },
  ]);
  assert.equal(claudeMdLoaded(files, "c:/ws/CLAUDE.md"), true);
  assert.equal(claudeMdLoaded(files, "C:\\other\\CLAUDE.md"), false);
  assert.equal(claudeMdLoaded(null, "C:\\ws\\CLAUDE.md"), null);
});

test("v12: CLAUDE.md of mode W: the guard and the integrity scan treat it as a workspace file", () => {
  const md = claudeMdText();
  assert.equal(md.file, `configs/${CLAUDE_MD_TEXT_FILE}`);
  assert.ok(md.text.includes(TEXT), "the text of arm I, unchanged");
  const ws = "C:\\ws\\run";
  const ctx = { workspace: ws, home: "C:\\Users\\u", platform: "win32" };
  assert.equal(guardDecision({ tool_name: "Read", tool_input: { file_path: `${ws}\\CLAUDE.md` } }, ctx).allow, true);
  assert.equal(guardDecision({ tool_name: "Read", tool_input: { file_path: "CLAUDE.md" } }, ctx).allow, true);
  assert.deepEqual(integrityScan([{ turn: "stage-1", name: "Read", input: { file_path: `${ws}\\CLAUDE.md` } }], ws), []);
});

// ---------------------------------------------------------------- suites

test("v12: suites v12-smoke, v12-main, v12-opus, v12-auto and v12-rerun", () => {
  const s = loadConfigs().suites;
  const lim = { order: "block", isolated: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  const v09 = { tasks: [], taskPrefixes: ["A12", "D12", "W12", "X12"], pick: "all", count: 6 };
  assert.deepEqual(s["v12-smoke"], { tasks: ["X12-data-retention"], pick: "all", count: 1, modes: ["Z", "W"], reps: 1, tasksDir: "tasks/v09", ...lim, batchTokens: 4000000 });
  assert.deepEqual(s["v12-main"], { tasks: [], pick: "all", count: 10, modes: ["O", "Z", "W", "I"], reps: 2, tasksDir: "tasks/v12", ...lim, comparisons: ["Z-O", "W-O", "W-Z", "Z-I"], batchTokens: 110000000 });
  assert.deepEqual(s["v12-opus"], { ...v09, modes: ["O", "Z"], reps: 2, tasksDir: "tasks/v09", model: "claude-opus-5-5", ...lim, comparisons: ["Z-O"], batchTokens: 40000000 });
  const auto = { ...s["v09-auto"] };
  for (const k of ["modes", "comparisons", "overlay"]) delete auto[k];
  assert.deepEqual(s["v12-auto"], { ...auto, modes: ["O", "Z"], isolated: true, comparisons: ["Z-O"] }, "the settings of v09-auto, plain and isolated");
  assert.deepEqual(s["v12-rerun"], { tasks: ["A12-mobile-gateway", "W12-ledger-migration", "X12-cdn-migration"], pick: "all", count: 3, modes: ["O", "Z"], reps: 2, tasksDir: "tasks/v09", ...lim, comparisons: ["Z-O"], batchTokens: 12000000 });
  for (const k of ["v12-smoke", "v12-main", "v12-opus", "v12-auto", "v12-rerun"]) assert.equal(s[k].overlay, undefined, `${k} is plain`);
  const configs = loadConfigs();
  const plan = (suite, more = []) => buildPlan(parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock", ...more]), configs);
  assert.equal(plan("v12-smoke").runs.length, 2);
  const opus = plan("v12-opus");
  assert.equal(opus.runs.length, 24);
  assert.equal(opus.model, "claude-opus-5-5");
  assert.equal(plan("v12-opus", ["--model", "haiku"]).model, "haiku", "--model overrides the suite model");
  const a = plan("v12-auto");
  assert.equal(a.runs.length, 4);
  assert.equal(a.autoCompact, true);
  assert.equal(a.autoCompactWindow, 100000);
  assert.equal(plan("v12-rerun").runs.length, 12);
  for (const k of ["v12-smoke", "v12-opus", "v12-auto", "v12-rerun"]) {
    const p = plan(k);
    assert.equal(p.isolated, true, k);
    assert.equal(p.overlay, false, k);
  }
  // tasks/v12 comes from the task worker; with it, v12-main has 10 tasks x 4 modes x 2 repetitions.
  if (existsSync(join(BENCH_ROOT, "tasks", "v12", "generated"))) assert.equal(plan("v12-main").runs.length, 80);
});

// ---------------------------------------------------------------- mock runs

test("v12: mock run of v12-smoke: Z delivers the plugin text at each compaction, W loads CLAUDE.md", { timeout: 600000 }, async () => {
  // An inherited off switch never reaches a run.
  const { r, batch } = await runSuite("v12-smoke", { env: { COMPACTION_INSTRUCTION: "off" } });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(batch.modes, ["Z", "W"]);
  assert.equal(batch.plain.plugins.Z.standalone.name, "compaction-instruction");
  assert.deepEqual(batch.plain.plugins.Z.standalone.text, { bytes: 694, sha256: TEXT_SHA });
  const md = claudeMdText();
  assert.deepEqual(batch.plain.plugins.W.claudeMd, { file: md.file, bytes: md.bytes, sha256: md.sha256 });
  assert.equal(batch.plain.plugins.W.standalone, undefined);
  assert.equal(r.records.length, 2);
  for (const rec of r.records) {
    assert.equal(rec.status, "completed", rec.runId);
    const n = rec.compactions.length;
    assert.ok(n > 0);
    const g = rec.telemetry.triggers;
    assert.equal(g.precompact.deliveries, 0, "no benchmark PreCompact hook");
    assert.equal(g.precompactPlain.deliveries, 0);
    assert.equal(rec.session.isolated, true);
    assert.deepEqual(rec.session.isolationViolations, [], rec.runId);
    assert.deepEqual(rec.session.contextModeParts, []);
    assert.equal(rec.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.deepEqual(validateRun(rec), [], rec.runId);
    if (rec.mode === "Z") {
      assert.deepEqual(g.precompactStandalone, { calls: n, deliveries: n, bytes: n * 694, sha256s: Array(n).fill(TEXT_SHA), byTrigger: { manual: n, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: { manual: n, auto: 0, unknown: 0, nonZeroExit: 0, notCompleted: 0 } });
      assert.deepEqual(rec.session.plugins, ["cc-plugin-telemetry", "ccb-plain", "compaction-instruction"]);
      assert.deepEqual(rec.session.hooks.filter((h) => h.event === "PreCompact"), [{ event: "PreCompact", matcher: null, command: COMMAND, plugin: "compaction-instruction" }]);
      assert.equal(rec.session.standalone.name, "compaction-instruction");
      assert.equal(rec.session.claudeMd, null);
      assert.equal(JSON.stringify(rec.telemetry).includes(TEXT.slice(0, 40)), false, "the text itself is not in the record");
    } else {
      assert.deepEqual(g.precompactStandalone, { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: null });
      assert.deepEqual(rec.session.plugins, ["cc-plugin-telemetry", "ccb-plain"]);
      assert.deepEqual(rec.session.hooks.map((h) => h.event), ["PreToolUse"]);
      assert.equal(rec.session.standalone, null);
      const { path, ...rest } = rec.session.claudeMd;
      assert.match(path, /^<workspace>[\\/]CLAUDE\.md$/);
      assert.deepEqual(rest, { written: true, file: md.file, bytes: md.bytes, sha256: md.sha256, loaded: true });
      assert.equal(rec.session.instructionFiles.length, 1);
      assert.equal(rec.session.instructionFiles[0].sha256, md.sha256);
    }
  }
});

test("v12: W without host evidence that CLAUDE.md loaded records loaded false", { timeout: 600000 }, async () => {
  const { r } = await runSuite("v12-smoke", { hostOpts: { claudeMdNotLoaded: true }, args: ["--modes", "W"] });
  const rec = r.records[0];
  assert.equal(rec.status, "completed");
  assert.equal(rec.session.claudeMd.loaded, false);
  assert.deepEqual(rec.session.instructionFiles, []);
});

test("v12: Z with automatic compactions: the host records no PreCompact output, so each call is unobserved", { timeout: 600000 }, async () => {
  const { r } = await runSuite("v12-auto", { hostOpts: { autoCompactAt: 100000, contextPerTurn: 20000, contextAfterCompact: 10000 }, args: ["--modes", "Z", "--reps", "1"] });
  const rec = r.records[0];
  const n = rec.compactions.length;
  assert.ok(n > 0);
  assert.ok(rec.compactions.every((c) => c.trigger === "auto"));
  assert.deepEqual(rec.telemetry.triggers.precompactStandalone, { calls: n, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: n, hookRuns: { manual: 0, auto: n, unknown: 0, nonZeroExit: 0, notCompleted: 0 } });
  assert.deepEqual(validateRun(rec), []);
});

test("v12: a user plugin in an isolated Z session makes the run infra_failed", { timeout: 600000 }, async () => {
  const { r } = await runSuite("v12-smoke", { hostOpts: { initExtra: { plugins: [{ name: "codex", path: "<user>" }] } }, args: ["--modes", "Z"] });
  const rec = r.records[0];
  assert.equal(rec.status, "infra_failed");
  assert.equal(rec.failure.kind, "isolation_violation");
  assert.deepEqual(rec.session.isolationViolations, ["plugin codex"]);
  assert.equal(rec.attempts.length, 1);
});

test("v12: the grader and the analysis run on a mock v12-smoke batch; CLAUDE.md is no stage material", { timeout: 600000 }, async () => {
  const root = tmp("v12-batch");
  try {
    const { r } = await runSuite("v12-smoke", { root });
    assert.equal(r.exitCode, 0);
    for (const rec of r.records) assert.deepEqual(rec.integrity.violations, [], rec.runId);
    assert.doesNotThrow(() => gradeBatch(root, "b"));
    assert.doesNotThrow(() => analyze({ root, batch: "b" }));
    assert.ok(existsSync(join(root, "results", "b", "summary.json")));
    assert.ok(existsSync(join(root, "results", "b", "report.md")));
    const graded = readFileSync(join(root, "results", "b", "summary.json"), "utf8");
    assert.ok(graded.includes('"Z"') && graded.includes('"W"'), "both modes are in the summary");
  } finally {
    cleanup(root);
  }
});

test("v12: the host debug log shows each PreCompact run of the plugin command (manual and auto), never its output", () => {
  // Lines in the form that Claude Code 2.1.331 writes with --debug-file (dry probe, no model call).
  const log = [
    "2026-11-26T00:52:27.919Z [DEBUG] $.store.set (cc-plugin-agents-md@builtin): usage-rows-queued",
    `2026-11-26T00:52:28.114Z [DEBUG] PreCompact:manual [${COMMAND}] completed with status 0`,
    "2026-11-26T00:52:28.114Z [DEBUG] Hook output does not start with {, treating as plain text",
    `2026-11-26T01:10:00.000Z [DEBUG] PreCompact:auto [${COMMAND}] completed with status 0`,
    `2026-11-26T01:20:00.000Z [DEBUG] PreCompact:auto [${COMMAND}] completed with status 1`,
    `2026-11-26T01:30:00.000Z [DEBUG] PreCompact:auto [${COMMAND}] cancelled`,
    "2026-11-26T01:40:00.000Z [DEBUG] PreCompact:auto [node other.mjs] completed with status 0",
  ].join("\r\n");
  assert.equal(preCompactDebugLines(log).length, 5);
  assert.deepEqual(hostDebugRuns(log, [COMMAND]), { manual: 1, auto: 2, unknown: 0, nonZeroExit: 1, notCompleted: 1 });
  assert.deepEqual(hostDebugRuns("", [COMMAND]), { manual: 0, auto: 0, unknown: 0, nonZeroExit: 0, notCompleted: 0 });
  // A hook run is no delivery: standaloneTelemetry keeps it apart.
  const t = standaloneTelemetry([{ trigger: "auto", segments: null }], [COMMAND], hostDebugRuns(log, [COMMAND]));
  assert.equal(t.deliveries, 0);
  assert.equal(t.unobserved, 1);
  assert.equal(t.hookRuns.auto, 2);
});
