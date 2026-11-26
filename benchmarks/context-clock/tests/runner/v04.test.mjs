// v0.4 runner arms (EXPERIMENT-V04.md "Arms", "Commit instruction", "Runs and limits" and "Interfaces"): modes E, F, G,
// the commit paragraph, the reference state file of mode G, telemetry.commits, telemetry.stateBlock and the v04 suites.
// The overlay module is a stub; the host is the mock (a mock commit call, a mock state block line in the shim log).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODE_ENV as SCHEMA_MODE_ENV, MODES as SCHEMA_MODES, validateRun } from "../../fixtures/schema.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { readShimLog, readStateBlockLog } from "../../runner/overlay-run.mjs";
import { MODES } from "../../runner/plan.mjs";
import { buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import {
  COMMIT_MODES, REFERENCE_TEXT_MAX_BYTES, STATE_FILE_NAME, commitCallsOf, commitErrorCode, commitInstruction, commitTelemetry,
  loadReferenceState, referenceDirOf, stageMessage,
} from "../../runner/v04.mjs";
import { MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { BENCH, cleanup, readJson, readTask, tmp } from "./helpers.mjs";

const PREFIX = "mcp__plugin_context-mode_context-mode__";
const quiet = () => {};

/** Reference texts of the fixture tasks, by task and stage. Each names its task and stage, so a test can tell them apart. */
const REF_TEXT = (taskId, stage) => `owner-${taskId}: stage-${stage}\nitems: ${stage * 3}`;

/** A v04-like task folder: A7 (1 compaction after stage 2), A8 (compactions after stages 1 and 2), and reference/. */
function v04Tasks({ reference = true } = {}) {
  const dir = tmp("v04tasks");
  const t2 = readTask("T2-runner-compaction");
  const a7 = { ...t2, taskId: "A7-runner-one" };
  const a8 = { ...t2, taskId: "A8-runner-two", stages: t2.stages.map((s) => ({ ...s, compactAfter: s.stage === 1 || s.stage === 2 })) };
  for (const t of [a7, a8, readTask("T1-runner-long")]) writeFileSync(join(dir, `${t.taskId}.task.json`), JSON.stringify(t));
  if (reference) {
    mkdirSync(join(dir, "reference"));
    for (const t of [a7, a8]) {
      const states = t.stages.filter((s) => s.compactAfter).map((s) => ({ afterStage: s.stage, text: REF_TEXT(t.taskId, s.stage) }));
      writeFileSync(join(dir, "reference", `${t.taskId}.state.json`), JSON.stringify({ schema: 1, taskId: t.taskId, states }));
    }
  }
  return dir;
}

function stubOverlay() {
  return {
    findInstalledPlugin: () => "C:/fake/installed/context-mode",
    buildOverlay: ({ destDir }) => {
      mkdirSync(destDir, { recursive: true });
      return { pluginDir: destDir, sourceSha: "sha-stub-1" };
    },
  };
}

function dirs(opts) {
  return { tasks: v04Tasks(opts), results: tmp("v04res"), work: tmp("v04work") };
}

function v04Opts(x, extra = []) {
  return { ...parseArgs(["--batch", "v", "--suite", "v04-smoke", "--mock", ...extra]), tasksDir: x.tasks, resultsDir: x.results, workRoot: x.work };
}

/** A mock host that records the prompt, env and label of every turn (behave returns null: the mock goes on). */
function recordingHost(seen, opts = {}) {
  return createMockHost({
    mockDir: null,
    ...opts,
    behave: ({ prompt, env, label, mock }) => {
      seen.push({ mode: mock.mode, taskId: mock.taskId, label, prompt, stateFile: env.CCB_STATE_FILE ?? null, stateText: env.CCB_STATE_FILE && existsSync(env.CCB_STATE_FILE) ? readFileSync(env.CCB_STATE_FILE, "utf8") : null, env: { ...env } });
      return null;
    },
  });
}

const rawDir = (x, runId) => join(x.results, "v", "raw", runId, "a1");

/** The additionalContext of the SessionStart hook reply in one raw compaction stream. */
function hookContext(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hook = lines.find((e) => e.subtype === "hook_response" && e.hook_event === "SessionStart");
  return hook ? JSON.parse(hook.output).hookSpecificOutput.additionalContext : "";
}

// ---------------------------------------------------------------- mode table

test("modes E, F, G: the mode table of EXPERIMENT-V04.md, in the runner and in the shared schema", () => {
  for (const m of ["E", "F", "G"]) {
    assert.ok(MODES.includes(m) && SCHEMA_MODES.includes(m), m);
    assert.deepEqual(MODE_ENV[m], SCHEMA_MODE_ENV[m], m);
    assert.equal(MODE_ENV[m].CTX_CLOCK, "1");
    assert.equal(MODE_ENV[m].CTX_CLOCK_FEEDBACK, "off");
  }
  assert.equal(MODE_ENV.E.CCB_RETURN_STATE, undefined);
  assert.equal(MODE_ENV.F.CCB_RETURN_STATE, "committed");
  assert.equal(MODE_ENV.G.CCB_RETURN_STATE, "reference");
  assert.deepEqual(COMMIT_MODES, ["E", "F"]);
});

test("modeEnv: CCB_DATA_DIR in every mode, CCB_STATE_FILE only in modes G, H and K, inherited v0.4 variables dropped", () => {
  const parent = { PATH: "/bin", CCB_RETURN_STATE: "committed", CCB_STATE_FILE: "/old/state.txt", CCB_DATA_DIR: "/old" };
  for (const m of MODES) {
    const env = modeEnv(m, "/data", parent, "/ws");
    assert.equal(env.CCB_DATA_DIR, "/data", m);
    // EXPERIMENT-V11.md: the plain modes O and I have no Context Mode data folder variable.
    assert.equal(env.CONTEXT_MODE_DATA_DIR, ["O", "I", "Z", "W"].includes(m) ? undefined : "/data", m);
    assert.equal(env.CCB_RETURN_STATE, MODE_ENV[m].CCB_RETURN_STATE, m);
    if (m === "G") assert.equal(env.CCB_STATE_FILE, join("/data", STATE_FILE_NAME));
    // Mode H (EXPERIMENT-V05.md): the state file the agent writes in the workspace.
    // Mode K (EXPERIMENT-V06.md) is mode H with the sparse paragraph.
    else if (m === "H" || m === "K") assert.equal(env.CCB_STATE_FILE, join("/ws", "clock-state.md"));
    else assert.equal("CCB_STATE_FILE" in env, false, m);
  }
  for (const m of ["B", "E", "F", "G"]) assert.equal(modeEnv(m, "/data", parent).CTX_CLOCK_FEEDBACK, "off");
});

// ---------------------------------------------------------------- commit paragraph

test("the commit paragraph is one fixed paragraph with the tool names and fields, and names no task value", () => {
  const text = commitInstruction();
  assert.equal(text, readFileSync(join(BENCH, "configs", "commit-instruction.txt"), "utf8").trim());
  assert.equal(text.includes("\n"), false, "one paragraph");
  for (const w of ["ctx_clock_status", "ctx_clock_commit", "expectedRevision", "state_rev", "summary", "findings", "evidence", "event id", "exact identifier"]) assert.ok(text.includes(w), w);
  // No task value: no answer option and no stage file text of any fixture task or v03 task appears in it.
  const values = new Set();
  const addTask = (t) => {
    for (const q of [...(t.final?.questions ?? []), ...(t.checkpoint?.questions ?? [])]) for (const o of q.options ?? []) if (String(o).length >= 4) values.add(String(o));
  };
  addTask(readTask("T1-runner-long"));
  addTask(readTask("T2-runner-compaction"));
  const v03 = join(BENCH, "tasks", "v03", "generated");
  if (existsSync(v03)) for (const f of readdirSync(v03)) addTask(readJson(join(v03, f)));
  for (const v of values) assert.equal(text.includes(v), false, `names the task value ${v}`);
});

test("stageMessage appends the commit paragraph in modes E and F only", () => {
  const p = "Stage 2 of 3.\nDo the work.\n";
  for (const m of MODES) {
    const s = stageMessage(p, m);
    if (m === "E" || m === "F") {
      assert.ok(s.startsWith("Stage 2 of 3.\nDo the work.\n\n"), m);
      assert.ok(s.trimEnd().endsWith(commitInstruction()), m);
    } else if (m === "H" || m === "J") {
      // EXPERIMENT-V05.md, EXPERIMENT-V06.md: modes H and J get the state file paragraph instead (v05 and v06 tests).
      // K and L add it only for a stage with compactAfter true, so a call without the stage leaves the prompt as is.
      assert.equal(s.includes(commitInstruction()), false, m);
    } else assert.equal(s, p, m);
  }
});

test("paragraph placement in a mock batch: at the end of every stage message of E and F, never in other turns or modes", async () => {
  const x = dirs();
  const seen = [];
  try {
    const r = await runBatch(v04Opts(x), { host: recordingHost(seen), overlay: stubOverlay(), log: quiet });
    assert.equal(r.records.length, 8);
    const para = commitInstruction();
    for (const s of seen) {
      const has = s.prompt.includes(para);
      if (s.label.startsWith("stage-") && (s.mode === "E" || s.mode === "F")) {
        assert.ok(has && s.prompt.trimEnd().endsWith(para), `${s.mode} ${s.label}`);
      } else assert.equal(has, false, `${s.mode} ${s.label}`);
    }
    assert.ok(seen.some((s) => s.mode === "E" && s.label === "stage-1"));
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

// ---------------------------------------------------------------- mode G state file

test("mode G: the reference text of each stage is in CCB_STATE_FILE (data folder) right after its compaction", async () => {
  const x = dirs();
  const seen = [];
  try {
    const r = await runBatch(v04Opts(x, ["--tasks", "A8-runner-two", "--modes", "G,B"]), { host: recordingHost(seen), overlay: stubOverlay(), log: quiet });
    for (const rec of r.records) assert.equal(rec.status, "completed", rec.runId);
    const g = seen.filter((s) => s.mode === "G");
    const at = (label) => g.find((s) => s.label === label);
    // Before the first compaction there is no file; after each compaction it holds the text of that stage.
    assert.equal(at("stage-1").stateText, null);
    assert.equal(at("checkpoint-1")?.stateText ?? at("stage-2").stateText, REF_TEXT("A8-runner-two", 1));
    assert.equal(at("stage-3").stateText, REF_TEXT("A8-runner-two", 2));
    assert.equal(at("final").stateText, REF_TEXT("A8-runner-two", 2));
    for (const s of g) {
      assert.ok(s.stateFile.endsWith(STATE_FILE_NAME));
      assert.equal(s.stateFile.startsWith(x.work), true, "inside the work root");
      assert.equal(s.env.CCB_DATA_DIR, join(s.stateFile, ".."));
    }
    for (const s of seen.filter((v) => v.mode === "B")) assert.equal(s.stateFile, null);
    // The mock hook shim sent each text in the SessionStart:compact reply of its compaction.
    const raw = rawDir(x, "claude__A8-runner-two__G__r1");
    for (const stage of [1, 2]) {
      const ctx = hookContext(join(raw, `compact-${stage}.jsonl`));
      assert.ok(ctx.includes("[committed-state]\n" + REF_TEXT("A8-runner-two", stage) + "\n[/committed-state]"), `compact-${stage}`);
    }
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("mode G: a missing or bad reference state stops the plan before any run", () => {
  const t = { taskId: "A8-x", stages: [{ stage: 1, compactAfter: true }, { stage: 2, compactAfter: true }] };
  const dir = tmp("v04ref");
  try {
    assert.throws(() => loadReferenceState(dir, t), /needs the reference state/);
    mkdirSync(join(dir, "reference"));
    const put = (doc) => writeFileSync(join(dir, "reference", "A8-x.state.json"), JSON.stringify(doc));
    put({ schema: 1, taskId: "A8-x", states: [{ afterStage: 1, text: "a: 1" }] });
    assert.throws(() => loadReferenceState(dir, t), /no text for the compaction after stage 2/);
    put({ schema: 1, taskId: "A8-x", states: [{ afterStage: 1, text: "a: 1" }, { afterStage: 2, text: "x".repeat(REFERENCE_TEXT_MAX_BYTES + 1) }] });
    assert.throws(() => loadReferenceState(dir, t), /above 1900 bytes/);
    put({ schema: 1, taskId: "other", states: [] });
    assert.throws(() => loadReferenceState(dir, t), /must be/);
    put({ schema: 1, taskId: "A8-x", states: [{ afterStage: 1, text: "a: 1" }, { afterStage: 2, text: "a: 2" }] });
    assert.equal(loadReferenceState(dir, t).states.length, 2);
    assert.equal(referenceDirOf(join(dir, "generated")), join(dir, "reference"));
  } finally {
    cleanup(dir);
  }
  const x = dirs({ reference: false });
  try {
    assert.throws(() => buildPlan(v04Opts(x)), /mode G needs the reference state/);
    assert.doesNotThrow(() => buildPlan(v04Opts(x, ["--modes", "B,E,F"])));
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("modes F and G need the overlay; mode E does not", () => {
  const x = dirs();
  try {
    assert.throws(() => buildPlan(v04Opts(x, ["--modes", "F", "--overlay", "off"])), /mode F needs the overlay/);
    assert.throws(() => buildPlan(v04Opts(x, ["--modes", "G", "--overlay", "off"])), /mode G needs the overlay/);
    assert.doesNotThrow(() => buildPlan(v04Opts(x, ["--modes", "B,E", "--overlay", "off"])));
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

// ---------------------------------------------------------------- telemetry

test("telemetry.commits and telemetry.stateBlock of a v04-smoke mock batch", async () => {
  const x = dirs();
  try {
    const r = await runBatch(v04Opts(x), { host: createMockHost({ mockDir: null }), overlay: stubOverlay(), log: quiet });
    assert.equal(r.records.length, 8);
    for (const rec of r.records) {
      assert.equal(rec.status, "completed", rec.runId);
      assert.deepEqual(validateRun(rec), [], rec.runId);
      const c = rec.telemetry.commits;
      const stages = rec.turns.filter((t) => t.kind === "stage").length;
      const comps = rec.compactions.length;
      const sb = rec.telemetry.stateBlock;
      assert.equal(c.stages, stages);
      if (rec.mode === "E" || rec.mode === "F") {
        assert.deepEqual(c, { calls: stages, ok: stages, rejected: {}, stagesWithCommit: stages, stages }, rec.runId);
        assert.equal(rec.telemetry.clock.commitCalls, stages);
        assert.equal(rec.telemetry.clock.statusCalls, stages);
      } else assert.deepEqual(c, { calls: 0, ok: 0, rejected: {}, stagesWithCommit: 0, stages }, rec.runId);
      if (rec.mode === "F") assert.deepEqual({ ...sb, bytes: 0 }, { deliveries: comps, missing: 0, bytes: 0, findings: comps, cuts: 0 }, rec.runId);
      else if (rec.mode === "G") assert.deepEqual({ ...sb, bytes: 0 }, { deliveries: comps, missing: 0, bytes: 0, findings: 0, cuts: 0 }, rec.runId);
      else assert.deepEqual(sb, { deliveries: 0, missing: 0, bytes: 0, findings: 0, cuts: 0 }, rec.runId);
      if (sb.deliveries > 0) assert.ok(sb.bytes > 0);
      assert.equal(rec.telemetry.shim.errors, 0);
      assert.equal(rec.env.CCB_RETURN_STATE, MODE_ENV[rec.mode].CCB_RETURN_STATE);
    }
    // The F block holds the last committed state (the mock commit of the stage before the compaction).
    const f = hookContext(join(rawDir(x, "claude__A8-runner-two__F__r1"), "compact-2.jsonl"));
    assert.ok(f.includes("[committed-state]\nsummary: mock state after stage 2\nfinding 1: mock-item-2: value-2"), f);
    for (const m of ["B", "E"]) assert.equal(hookContext(join(rawDir(x, `claude__A8-runner-two__${m}__r1`), "compact-2.jsonl")).includes("[committed-state]"), false, m);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("rejected commits count by error code; arm F with no commit before a compaction logs a missing block", async () => {
  const x = dirs();
  try {
    const host = createMockHost({ mockDir: null, commitRejectStages: [1, 2], commitRejectCode: "UNKNOWN_EVIDENCE" });
    const r = await runBatch(v04Opts(x, ["--tasks", "A8-runner-two", "--modes", "F"]), { host, overlay: stubOverlay(), log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "completed");
    assert.deepEqual(rec.telemetry.commits, { calls: 3, ok: 1, rejected: { UNKNOWN_EVIDENCE: 2 }, stagesWithCommit: 1, stages: 3 });
    assert.deepEqual(rec.telemetry.stateBlock, { deliveries: 0, missing: 2, bytes: 0, findings: 0, cuts: 0 });
    assert.deepEqual(validateRun(rec), []);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("a shim log line with an error still makes a v0.4 run infra_failed", async () => {
  const x = dirs();
  try {
    const r = await runBatch(v04Opts(x, ["--tasks", "A7-runner-one", "--modes", "F"]), { host: createMockHost({ mockDir: null, shimError: true }), overlay: stubOverlay(), log: quiet });
    const [rec] = r.records;
    assert.equal(rec.status, "infra_failed");
    assert.equal(rec.failure.kind, "shim_error");
    assert.deepEqual(validateRun(rec), []);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("readShimLog and readStateBlockLog: state block lines counted apart, a malformed one is a shim error", () => {
  const dir = tmp("v04log");
  try {
    const file = join(dir, "shim.jsonl");
    const line = (o) => JSON.stringify({ t: "x", ...o });
    const ok1 = { channel: "state_block", event: "SessionStart", arm: "committed", delivered: true, bytes: 120, findings: 3, cut: false };
    const ok2 = { channel: "state_block", event: "SessionStart", arm: "reference", delivered: true, bytes: 2000, cut: true };
    const miss = { channel: "state_block", event: "SessionStart", arm: "committed", delivered: false, bytes: 0, findings: 0, cut: false };
    const real = { channel: "session_start", event: "SessionStart", mode: "real", originalBytes: 52, deliveredBytes: 52, replaced: 0 };
    writeFileSync(file, [ok1, ok2, miss, real].map(line).join("\n") + "\n");
    assert.deepEqual(readStateBlockLog(file), { deliveries: 2, missing: 1, bytes: 2120, findings: 3, cuts: 1 });
    assert.equal(readShimLog(file).errors, 0);
    assert.equal(readShimLog(file).byChannel.session_start.real, 1);
    writeFileSync(file, [ok1, { ...ok1, arm: "other" }, { ...ok1, delivered: "yes" }].map(line).join("\n") + "\n");
    assert.equal(readShimLog(file).errors, 2);
    assert.deepEqual(readStateBlockLog(file), { deliveries: 1, missing: 0, bytes: 120, findings: 3, cuts: 0 });
    assert.deepEqual(readStateBlockLog(join(dir, "none.jsonl")), { deliveries: 0, missing: 0, bytes: 0, findings: 0, cuts: 0 });
  } finally {
    cleanup(dir);
  }
});

test("commitCallsOf and commitTelemetry: ok, the product error codes, malformed input, host errors and no result", () => {
  const use = (id, name = PREFIX + "ctx_clock_commit") => ({ type: "tool_use", id, name, input: {} });
  const res = (id, text, isError) => ({ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] });
  const stream = (uses, results) => [
    { type: "assistant", message: { content: uses } },
    { type: "user", message: { content: results } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const s1 = stream(
    [use("a"), use("b"), use("c"), use("d"), use("e"), use("f"), use("g", PREFIX + "ctx_clock_status")],
    [
      res("a", "ctx_clock_commit: state_rev=1 (was 0) agent=main tick=3 events=3", false),
      res("b", "ctx_clock_commit: REVISION_CONFLICT: expectedRevision=0 but the current revision is 1.", true),
      res("c", 'ctx_clock_commit: UNKNOWN_EVIDENCE: evidence id "x" is not an event of this agent in this session. Nothing was committed.', true),
      res("d", "ctx_clock_commit: findings[0].evidence must have at least 1 item. Correct call: ctx_clock_commit({...})", true),
      res("e", "<tool_use_error>Permission denied</tool_use_error>", true),
      res("g", "ctx_clock_status: tick=3", false),
    ],
  );
  assert.deepEqual(commitCallsOf(s1), [
    { ok: true, code: null }, { ok: false, code: "REVISION_CONFLICT" }, { ok: false, code: "UNKNOWN_EVIDENCE" },
    { ok: false, code: "INVALID_INPUT" }, { ok: false, code: "TOOL_ERROR" }, { ok: false, code: "NO_RESULT" },
  ]);
  assert.equal(commitErrorCode("ctx_clock_commit: STATE_STORE_BUSY: locked"), "STATE_STORE_BUSY");
  const ok = stream([use("z")], [res("z", "ctx_clock_commit: state_rev=2 (was 1)", false)]);
  const t = commitTelemetry([{ turn: "stage-1", text: s1 }, { turn: "stage-2", text: ok }, { turn: "checkpoint-2", text: ok }, { turn: "stage-3", text: "" }], 3);
  assert.deepEqual(t, { calls: 8, ok: 3, rejected: { INVALID_INPUT: 1, NO_RESULT: 1, REVISION_CONFLICT: 1, TOOL_ERROR: 1, UNKNOWN_EVIDENCE: 1 }, stagesWithCommit: 2, stages: 3 });
});

// ---------------------------------------------------------------- suites and batch.json

test("suites v04-smoke and v04-full: tasks/v04, modes B E F G, block order, overlay, the four comparisons", () => {
  const s = loadConfigs().suites;
  const common = { tasks: [], modes: ["B", "E", "F", "G"], tasksDir: "tasks/v04", order: "block", overlay: true, comparisons: ["F-E", "G-B", "E-B", "F-B"] };
  assert.deepEqual(s["v04-smoke"], { ...common, pick: "one-per-compaction-count", count: 2, reps: 1 });
  assert.deepEqual(s["v04-full"], { ...common, pick: "all", count: 10, reps: 3 });
  for (const name of ["v04-smoke", "v04-full"]) assert.equal(parseArgs(["--batch", "b", "--suite", name]).suite, name);
});

test("v04-smoke plan and batch.json: one task with 1 compaction and one with 2, 8 runs in blocks, comparisons and the paragraph hash", async () => {
  const x = dirs();
  try {
    const plan = buildPlan(v04Opts(x));
    assert.deepEqual(plan.tasks.map((t) => t.taskId), ["A7-runner-one", "A8-runner-two"]);
    assert.equal(plan.runs.length, 8);
    assert.equal(plan.overlay, true);
    assert.equal(plan.order, "block");
    assert.deepEqual(plan.comparisons, ["F-E", "G-B", "E-B", "F-B"]);
    await runBatch(v04Opts(x), { host: createMockHost({ mockDir: null }), overlay: stubOverlay(), log: quiet });
    const b = readJson(join(x.results, "v", "batch.json"));
    assert.deepEqual(b.modes, ["B", "E", "F", "G"]);
    assert.deepEqual(b.comparisons, ["F-E", "G-B", "E-B", "F-B"]);
    assert.equal(b.commitInstruction.file, "configs/commit-instruction.txt");
    assert.match(b.commitInstruction.sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.blocks.length, 2);
    for (const blk of b.blocks) assert.deepEqual([...blk.modes].sort(), ["B", "E", "F", "G"]);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});
