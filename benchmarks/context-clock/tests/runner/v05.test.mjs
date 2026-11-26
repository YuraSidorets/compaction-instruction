// v0.5 runner arms (EXPERIMENT-V05.md "Arms", "Runs and limits"): mode H (state file paragraph, the file returned by the
// shim), mode S (/compact with a fixed instruction), telemetry.stateFile, compactInstruction on compact turns, the two
// fixed texts in batch.json, the v05 suites and the suite batch token limit. The overlay module is a stub; the host is
// the mock (a mock Write of clock-state.md, a mock state block line in the shim log).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODE_ENV as SCHEMA_MODE_ENV, MODES as SCHEMA_MODES, validateRun } from "../../fixtures/schema.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { STATE_BLOCK_ARMS } from "../../runner/overlay-run.mjs";
import { MODES } from "../../runner/plan.mjs";
import { USAGE, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { STATE_BLOCK_MODES, commitInstruction, stageMessage } from "../../runner/v04.mjs";
import {
  CLOCK_STATE_FILE_NAME, COMPACT_INSTRUCTION_MODES, STATE_FILE_MODES, compactInstruction, compactInstructionOf, compactPrompt,
  instructionRecords, isStateFileWrite, stageToolsOf, stateFileInstruction, stateFileTelemetry, stateFileWritesOf,
} from "../../runner/v05.mjs";
import { MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { BENCH, cleanup, readJson, readTask, tmp } from "./helpers.mjs";

const quiet = () => {};
const V04_GENERATED = join(BENCH, "tasks", "v04", "generated");
const SMOKE_TASKS = ["A8-registry-move", "E7-bulk-import"];
const FULL_TASKS = ["A8-registry-move", "B7-ledger-teams", "B8-payments-reorg", "C8-storage-upgrade", "D8-security-baseline", "E7-bulk-import", "E8-index-rebuild"];

function stubOverlay() {
  return {
    findInstalledPlugin: () => "C:/fake/installed/context-mode",
    buildOverlay: ({ destDir }) => {
      mkdirSync(destDir, { recursive: true });
      return { pluginDir: destDir, sourceSha: "sha-stub-1" };
    },
  };
}

function dirs() {
  return { results: tmp("v05res"), work: tmp("v05work") };
}

function v05Opts(x, extra = []) {
  return { ...parseArgs(["--host", "claude", "--batch", "v", "--suite", "v05-smoke", "--mock", ...extra]), resultsDir: x.results, workRoot: x.work };
}

/**
 * A mock host that records every turn (prompt, env, the state file text), every compaction (instruction, prompt) and
 * the allowed tools of each persistent session.
 */
function recordingHost(seen, opts = {}) {
  const base = createMockHost({
    mockDir: null,
    ...opts,
    onCompact: (c) => seen.compacts.push(c),
    behave: ({ prompt, env, label, mock }) => {
      seen.turns.push({ mode: mock.mode, taskId: mock.taskId, label, prompt, env: { ...env }, stateText: env.CCB_STATE_FILE && existsSync(env.CCB_STATE_FILE) ? readFileSync(env.CCB_STATE_FILE, "utf8") : null });
      return null;
    },
  });
  return {
    ...base,
    openSession: (a) => {
      seen.sessions.push({ mode: a.mock?.mode, allowedTools: a.allowedTools });
      return base.openSession(a);
    },
    runTurn: (a) => {
      seen.tools.push({ mode: a.mock?.mode, label: a.label, allowedTools: a.allowedTools, disallowedTools: a.disallowedTools });
      return base.runTurn(a);
    },
  };
}
const newSeen = () => ({ turns: [], compacts: [], sessions: [], tools: [] });

/** The additionalContext of the SessionStart hook reply in one raw compaction stream. */
function hookContext(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hook = lines.find((e) => e.subtype === "hook_response" && e.hook_event === "SessionStart");
  return hook ? JSON.parse(hook.output).hookSpecificOutput.additionalContext : "";
}

/** Answer options and stage file names of the v04 tasks: no fixed text may name one. */
function taskValues() {
  const values = new Set();
  const add = (t) => {
    for (const q of [...(t.final?.questions ?? []), ...(t.checkpoint?.questions ?? []), ...(t.checkpoints ?? []).flatMap((c) => c.questions ?? [])]) {
      for (const o of q.options ?? []) if (String(o).length >= 4) values.add(String(o));
    }
  };
  add(readTask("T1-runner-long"));
  add(readTask("T2-runner-compaction"));
  if (existsSync(V04_GENERATED)) for (const f of readdirSync(V04_GENERATED)) add(readJson(join(V04_GENERATED, f)));
  return values;
}

// ---------------------------------------------------------------- mode table

test("modes H and S: the mode table of EXPERIMENT-V05.md, in the runner and in the shared schema", () => {
  for (const m of ["H", "S"]) {
    assert.ok(MODES.includes(m) && SCHEMA_MODES.includes(m), m);
    assert.deepEqual(MODE_ENV[m], SCHEMA_MODE_ENV[m], m);
    assert.equal(MODE_ENV[m].CTX_CLOCK, "1");
    assert.equal(MODE_ENV[m].CTX_CLOCK_FEEDBACK, "off");
  }
  assert.equal(MODE_ENV.H.CCB_RETURN_STATE, "file");
  assert.equal(MODE_ENV.S.CCB_RETURN_STATE, undefined);
  // EXPERIMENT-V06.md adds J, K and L (tests/runner/v06.test.mjs).
  assert.deepEqual(STATE_FILE_MODES, ["H", "J", "K", "L"]);
  assert.deepEqual(COMPACT_INSTRUCTION_MODES, ["S"]);
  assert.ok(STATE_BLOCK_MODES.includes("H") && !STATE_BLOCK_MODES.includes("S"));
  assert.ok(STATE_BLOCK_ARMS.includes("file"));
  assert.ok(USAGE.includes("v05-smoke") && USAGE.includes("v05-full"));
});

test("modeEnv: mode H sets CCB_STATE_FILE to <workspace>/clock-state.md and needs the workspace; mode S sets no state variable", () => {
  const parent = { PATH: "/bin", CCB_RETURN_STATE: "committed", CCB_STATE_FILE: "/old/state.txt" };
  const h = modeEnv("H", "/data", parent, "/ws");
  assert.equal(h.CCB_RETURN_STATE, "file");
  assert.equal(h.CCB_STATE_FILE, join("/ws", CLOCK_STATE_FILE_NAME));
  assert.equal(h.CCB_DATA_DIR, "/data");
  assert.throws(() => modeEnv("H", "/data", parent), /needs the workspace/);
  const s = modeEnv("S", "/data", parent, "/ws");
  assert.equal("CCB_RETURN_STATE" in s, false);
  assert.equal("CCB_STATE_FILE" in s, false);
  assert.equal(s.CTX_CLOCK, "1");
  assert.equal(s.CTX_CLOCK_FEEDBACK, "off");
});

// ---------------------------------------------------------------- the two fixed texts

test("the state file paragraph: one fixed paragraph, one Write call on clock-state.md, the line forms, no task value", () => {
  const text = stateFileInstruction();
  assert.equal(text, readFileSync(join(BENCH, "configs", "state-file-instruction.txt"), "utf8").trim());
  assert.equal(text.includes("\n"), false, "one paragraph");
  for (const w of [CLOCK_STATE_FILE_NAME, "one Write call", "replaces the whole file", "exact identifier", "exact value", '"<identifier>: <value>"', '"<identifier> history: <first value>, then <next value>"', "No other tool call is needed"]) {
    assert.ok(text.includes(w), w);
  }
  // Parallel to the commit paragraph: the same opening and the same line forms.
  assert.ok(text.startsWith("Before you write your reply for this stage, save the tracked state of the task"));
  assert.ok(commitInstruction().startsWith("Before you write your reply for this stage, save the tracked state of the task"));
  for (const v of taskValues()) assert.equal(text.includes(v), false, `names the task value ${v}`);
});

test("the compaction instruction: one fixed line with the line forms, no task value; only mode S sends it", () => {
  const text = compactInstruction();
  assert.equal(text, readFileSync(join(BENCH, "configs", "compact-instruction.txt"), "utf8").trim());
  assert.equal(/[\r\n]/.test(text), false, "one line");
  for (const w of ["summary", "exact identifier", '"<identifier>: <value>"', '"<identifier> history: <first value>, then <next value>"']) assert.ok(text.includes(w), w);
  for (const v of taskValues()) assert.equal(text.includes(v), false, `names the task value ${v}`);
  for (const m of MODES) assert.equal(compactInstructionOf(m), m === "S" ? text : null, m);
  assert.equal(compactPrompt(null), "/compact");
  assert.equal(compactPrompt(text), "/compact " + text);
});

test("stageMessage: mode H ends with the state file paragraph, mode S is unchanged; stageToolsOf adds Write in mode H only", () => {
  const p = "Stage 2 of 3.\nDo the work.\n";
  const h = stageMessage(p, "H");
  assert.ok(h.startsWith("Stage 2 of 3.\nDo the work.\n\n"));
  assert.ok(h.trimEnd().endsWith(stateFileInstruction()));
  assert.equal(h.includes(commitInstruction()), false);
  assert.equal(stageMessage(p, "S"), p);
  const tools = ["Read", "Bash"];
  assert.deepEqual(stageToolsOf(tools, "H"), ["Read", "Bash", "Write"]);
  assert.deepEqual(stageToolsOf(["Read", "Write"], "H"), ["Read", "Write"]);
  // EXPERIMENT-V07.md: modes N and T also add Write (a hook names the state file, not the stage message).
  // EXPERIMENT-V08.md: mode U too.
  for (const m of ["N", "T", "U"]) assert.deepEqual(stageToolsOf(tools, m), ["Read", "Bash", "Write"], m);
  for (const m of MODES.filter((x) => !STATE_FILE_MODES.includes(x) && !["N", "T", "U"].includes(x))) assert.deepEqual(stageToolsOf(tools, m), tools, m);
  assert.deepEqual(tools, ["Read", "Bash"], "the input list is not changed");
});

test("batch.json records: file and sha256 of each text only when a batch mode uses it", () => {
  assert.deepEqual(instructionRecords(["B", "F"]), { stateFileInstruction: null, compactInstruction: null });
  const both = instructionRecords(["B", "F", "H", "S"]);
  assert.equal(both.stateFileInstruction.file, "configs/state-file-instruction.txt");
  assert.equal(both.compactInstruction.file, "configs/compact-instruction.txt");
  for (const r of [both.stateFileInstruction, both.compactInstruction]) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(instructionRecords(["H"]).compactInstruction, null);
  assert.equal(instructionRecords(["S"]).stateFileInstruction, null);
});

// ---------------------------------------------------------------- telemetry.stateFile

const toolUse = (name, input, id = "t1") => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

test("stateFileWritesOf and stateFileTelemetry: Write or Edit on clock-state.md, any separator; stage turns only for stagesWithWrite", () => {
  assert.ok(isStateFileWrite("Write", { file_path: "C:\\ws\\clock-state.md" }));
  assert.ok(isStateFileWrite("Edit", { file_path: "/ws/clock-state.md" }));
  assert.ok(isStateFileWrite("Write", { file_path: "clock-state.md" }));
  assert.equal(isStateFileWrite("Read", { file_path: "/ws/clock-state.md" }), false);
  assert.equal(isStateFileWrite("MultiEdit", { file_path: "/ws/clock-state.md" }), false);
  assert.equal(isStateFileWrite("Write", { file_path: "/ws/my-clock-state.md" }), false);
  assert.equal(isStateFileWrite("Write", { file_path: "/ws/clock-state.md.bak" }), false);
  assert.equal(isStateFileWrite("Write", {}), false);
  const two = [toolUse("Write", { file_path: "C:\\ws\\clock-state.md", content: "a: 1" }, "a"), toolUse("Edit", { file_path: "/ws/clock-state.md" }, "b"), toolUse("Write", { file_path: "/ws/notes.md" }, "c")].join("\n");
  assert.equal(stateFileWritesOf(two), 2);
  assert.equal(stateFileWritesOf("not json\n"), 0);
  const t = stateFileTelemetry([{ turn: "stage-1", text: two }, { turn: "stage-2", text: "" }, { turn: "checkpoint-2", text: two }, { turn: "stage-3", text: toolUse("Write", { file_path: "/ws/clock-state.md" }) }], 3);
  assert.deepEqual(t, { writes: 5, stagesWithWrite: 2, stages: 3, reads: { total: 0, afterCompaction: 0 }, writeStages: [1, 1, 3] });
});

// ---------------------------------------------------------------- mock batch

test("v05-smoke --mock: 4 completed runs; H writes and gets back clock-state.md, S sends the compaction instruction", async () => {
  const x = dirs();
  const seen = newSeen();
  try {
    const r = await runBatch(v05Opts(x), { host: recordingHost(seen), overlay: stubOverlay(), log: quiet });
    assert.equal(r.records.length, 4);
    for (const rec of r.records) {
      assert.equal(rec.status, "completed", rec.runId);
      assert.deepEqual(validateRun(rec), [], rec.runId);
      assert.equal(rec.telemetry.shim.errors, 0);
      const task = readJson(join(V04_GENERATED, `${rec.taskId}.task.json`));
      const stages = task.stages.length;
      const compactions = task.stages.filter((s) => s.compactAfter === true).length;
      const compacts = rec.turns.filter((t) => t.kind === "compact");
      assert.equal(compacts.length, compactions);
      for (const c of compacts) assert.equal(c.compactInstruction, rec.mode === "S", rec.runId);
      if (rec.mode === "H") {
        assert.deepEqual(rec.telemetry.stateFile, { writes: stages, stagesWithWrite: stages, stages, reads: { total: 0, afterCompaction: 0 }, writeStages: Array.from({ length: stages }, (_, i) => i + 1) });
        assert.deepEqual({ d: rec.telemetry.stateBlock.deliveries, m: rec.telemetry.stateBlock.missing }, { d: compactions, m: 0 });
      } else {
        assert.deepEqual(rec.telemetry.stateFile, { writes: 0, stagesWithWrite: 0, stages, reads: { total: 0, afterCompaction: 0 }, writeStages: [] });
        assert.equal(rec.telemetry.stateBlock.deliveries + rec.telemetry.stateBlock.missing, 0, "S delivers no state block");
      }
      assert.equal(rec.env.CCB_RETURN_STATE, rec.mode === "H" ? "file" : undefined);
      assert.equal(rec.telemetry.commits.calls, 0);
    }
    // Mode S: each compaction is "/compact <instruction>"; mode H: the plain "/compact".
    const nS = r.records.filter((v) => v.mode === "S").reduce((a, v) => a + v.compactions.length, 0);
    const nH = r.records.filter((v) => v.mode === "H").reduce((a, v) => a + v.compactions.length, 0);
    assert.equal(seen.compacts.filter((c) => c.prompt === "/compact " + compactInstruction()).length, nS);
    assert.equal(seen.compacts.filter((c) => c.prompt === "/compact").length, nH);
    // Mode H: the paragraph ends every stage message and no other message; the session allows Write. S: neither.
    const para = stateFileInstruction();
    for (const t of seen.turns) {
      const want = t.mode === "H" && t.label.startsWith("stage-");
      assert.equal(t.prompt.includes(para), want, `${t.mode} ${t.label}`);
      if (want) assert.ok(t.prompt.trimEnd().endsWith(para));
      if (t.mode === "H") assert.equal(t.env.CCB_STATE_FILE.endsWith(CLOCK_STATE_FILE_NAME), true);
      else assert.equal("CCB_STATE_FILE" in t.env, false);
    }
    assert.equal(seen.sessions.length, 4);
    for (const s of seen.sessions) assert.equal(s.allowedTools.includes("Write"), s.mode === "H", s.mode);
    // The block after each compaction of mode H holds the file as the agent wrote it before that compaction.
    const a8 = readJson(join(V04_GENERATED, "A8-registry-move.task.json"));
    const raw = join(x.results, "v", "raw", "claude__A8-registry-move__H__r1", "a1");
    for (const s of a8.stages.filter((v) => v.compactAfter === true)) {
      const ctx = hookContext(join(raw, `compact-${s.stage}.jsonl`));
      assert.ok(ctx.includes(`mock-item-${s.stage}: value-${s.stage}`), `compact-${s.stage}`);
      assert.equal(ctx.includes(`mock-item-${s.stage + 1}:`), false, `compact-${s.stage}`);
    }
    for (const s of seen.turns.filter((v) => v.mode === "H" && v.label === "final")) assert.ok(s.stateText.includes("history:"));
    // batch.json: both texts, no comparisons in the smoke suite, the batch token limit of configs/limits.json.
    const b = readJson(join(x.results, "v", "batch.json"));
    assert.deepEqual(b.stateFileInstruction, instructionRecords(["H"]).stateFileInstruction);
    assert.deepEqual(b.compactInstruction, instructionRecords(["S"]).compactInstruction);
    assert.equal(b.commitInstruction, null);
    assert.equal(b.comparisons, null);
    assert.equal(b.limits.batch.totalTokens, loadConfigs().limits.batch.totalTokens);
  } finally {
    cleanup(x.results, x.work);
  }
});

test("mode H: a stage without a write counts in telemetry.stateFile; resume mode gives Write to stage turns only", async () => {
  const x = dirs();
  const seen = newSeen();
  try {
    const r = await runBatch(v05Opts(x, ["--tasks", "E7-bulk-import", "--modes", "H", "--session-mode", "resume"]), { host: recordingHost(seen, { stateFileSkipStages: [1, 2] }), overlay: stubOverlay(), log: quiet });
    const rec = r.records[0];
    assert.equal(rec.status, "completed");
    const stages = rec.telemetry.stateFile.stages;
    assert.deepEqual(rec.telemetry.stateFile, { writes: stages - 2, stagesWithWrite: stages - 2, stages, reads: { total: 0, afterCompaction: 0 }, writeStages: Array.from({ length: stages - 2 }, (_, i) => i + 3) });
    for (const t of seen.tools) {
      if (t.label.startsWith("stage-")) assert.ok(t.allowedTools.includes("Write"), t.label);
      else {
        assert.deepEqual(t.allowedTools, [], t.label);
        assert.ok(t.disallowedTools.includes("Write"), t.label);
      }
    }
  } finally {
    cleanup(x.results, x.work);
  }
});

test("mode H needs the overlay; mode S does not", () => {
  const x = dirs();
  try {
    assert.throws(() => buildPlan(v05Opts(x, ["--modes", "H", "--overlay", "off"])), /mode H needs the overlay/);
    assert.equal(buildPlan(v05Opts(x, ["--modes", "S", "--overlay", "off"])).overlay, false);
  } finally {
    cleanup(x.results, x.work);
  }
});

// ---------------------------------------------------------------- suites and the batch token limit

test("suites v05-smoke and v05-full: the task lists, modes, repetitions, tasks/v04, block order, overlay, comparisons", () => {
  const { suites } = loadConfigs();
  const s = suites["v05-smoke"];
  assert.deepEqual(s.tasks, SMOKE_TASKS);
  assert.deepEqual(s.modes, ["H", "S"]);
  assert.equal(s.reps, 1);
  const f = suites["v05-full"];
  assert.deepEqual(f.tasks, FULL_TASKS);
  assert.deepEqual(f.modes, ["B", "F", "H", "S"]);
  assert.equal(f.reps, 4);
  assert.deepEqual(f.comparisons, ["H-F", "H-B", "S-B", "F-B"]);
  assert.equal(f.batchTokens, 200000000);
  assert.equal(s.batchTokens, undefined);
  for (const v of [s, f]) {
    assert.equal(v.tasksDir, "tasks/v04");
    assert.equal(v.order, "block");
    assert.equal(v.overlay, true);
  }
});

test("v05 plans: 4 smoke runs, 112 full runs in blocks; batchTokens replaces the batch token limit of the suite only", () => {
  const x = dirs();
  try {
    const configs = loadConfigs();
    const smoke = buildPlan(v05Opts(x), configs);
    assert.equal(smoke.runs.length, 4);
    assert.deepEqual(smoke.tasks.map((t) => t.taskId), SMOKE_TASKS);
    assert.equal(smoke.limits.batch.totalTokens, configs.limits.batch.totalTokens);
    const full = buildPlan({ ...v05Opts(x), suite: "v05-full" }, configs);
    assert.equal(full.runs.length, 112);
    assert.deepEqual(full.comparisons, ["H-F", "H-B", "S-B", "F-B"]);
    assert.equal(full.limits.batch.totalTokens, 200000000);
    assert.equal(full.limits.batch.wallTimeMs, configs.limits.batch.wallTimeMs);
    assert.equal(full.limits.batch.maxConcurrency, configs.limits.batch.maxConcurrency);
    assert.equal(configs.limits.batch.totalTokens, 150000000, "configs/limits.json itself is not changed");
    assert.ok(full.notes.some((n) => n.includes("200000000")));
    const bad = { ...configs, suites: { ...configs.suites, "v05-full": { ...configs.suites["v05-full"], batchTokens: -1 } } };
    assert.throws(() => buildPlan({ ...v05Opts(x), suite: "v05-full" }, bad), /batchTokens must be a positive integer/);
  } finally {
    cleanup(x.results, x.work);
  }
});
