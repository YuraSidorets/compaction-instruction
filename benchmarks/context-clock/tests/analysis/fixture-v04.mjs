// Hand-made v0.4 fixture: modes B, E, F, G, two tasks, one repetition, two compactions per run.
//
// Key answers: q1 "alpha-1" (text), q2 ["beta", "gamma"] (list), q3 42 (a number, so no coverage), q4 "delta".
// compact-1 summary holds every value (it must be ignored: only the last compact turn counts).
// compact-2 summary holds "alpha-1" and "beta" only. So q1 is in the summary, q2 and q4 are not.
// Blocks in compact-2: B and E none; F (JSON hook output) an older block with "alpha-1", then the last block with
// "beta gamma delta"; G (raw hook output) one block with every value.
// Grades: B and E get q1 and q3 right (score 0.5); F misses q3 (0.75); G is perfect (1).
// Probe c1: B wrong, E, F and G right. Status calls: G one in the probe turn, E two in the final turn.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BATCH = "v04-fixture";
export const HOST = "claude";
export const TASKS = Object.freeze([["A7-fixture", "A"], ["B7-fixture", "B"]]);
export const MODES = Object.freeze(["B", "E", "F", "G"]);

const VALUES = { q1: "alpha-1", q2: ["beta", "gamma"], q3: 42, q4: "delta" };
const Q = Object.keys(VALUES);

export function task(taskId, category) {
  return {
    schema: 1, taskId, category, seed: 9, profile: "compaction",
    params: { approxBytes: 50000 },
    intro: "Spec.",
    stages: [
      { stage: 1, prompt: "s1", files: [], feeds: [], eventIds: [], compactAfter: true, chunks: [] },
      { stage: 2, prompt: "s2", files: [], feeds: [], eventIds: [], compactAfter: true, chunks: [] },
    ],
    checkpoint: { afterStage: 1, questions: [{ id: "c1", text: "c1?", type: "choice", options: ["x", "y"] }] },
    final: { questions: Q.map((id) => ({ id, text: id + "?", type: "text" })) },
  };
}

export function key(taskId) {
  const answers = {};
  for (const id of Q) answers[id] = { value: VALUES[id], aspect: "current_state", establishedBy: [], staleValues: [], errorCategory: "obsolete_decision" };
  return { schema: 1, taskId, seed: 9, events: [], answers, checkpointAnswers: { c1: { value: "x", establishedBy: [] } } };
}

// ---- stream lines ----
const init = () => ({ type: "system", subtype: "init" });
const done = () => ({ type: "result", subtype: "success" });
const hook = (output) => ({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", output, stdout: output, exit_code: 0 });
const summary = (text) => ({ type: "user", message: { content: "This session is being continued from a previous conversation. " + text } });
const status = (id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__plugin_context-mode_context-mode__ctx_clock_status", input: {} }] } });
const jsonHook = (ctx) => hook(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));

function compact2(mode) {
  const lines = [init(), hook(""), hook("Other plugin text.")];
  if (mode === "F") {
    lines.push(jsonHook("[context-clock] product block\n[committed-state]\nsummary: alpha-1\n[/committed-state]"));
    lines.push(jsonHook("[context-clock] product block\n[committed-state]\nsummary: work\nfinding 1: beta gamma\nfinding 2: delta\n[/committed-state]"));
  } else if (mode === "G") {
    lines.push(hook("[context-clock] product block\n[committed-state]\nname: alpha-1\nqueue: beta, gamma\nstore: delta\n[/committed-state]"));
  } else {
    lines.push(jsonHook("[context-clock] product block only"));
  }
  lines.push({ type: "system", subtype: "compact_boundary" }, summary("Facts: alpha-1 and beta."), done());
  return lines;
}

export function streams(mode) {
  return {
    intro: [init(), done()],
    "stage-1": [init(), done()],
    "compact-1": [init(), { type: "system", subtype: "compact_boundary" }, summary("alpha-1 beta gamma delta"), done()],
    "checkpoint-1": mode === "G" ? [init(), status("s1"), done()] : [init(), done()],
    "stage-2": [init(), done()],
    "compact-2": compact2(mode),
    final: mode === "E" ? [init(), status("s2"), status("s3"), done()] : [init(), done()],
  };
}

const TURNS = [
  { kind: "intro" }, { kind: "stage", stage: 1 }, { kind: "compact", stage: 1 }, { kind: "checkpoint", stage: 1 },
  { kind: "stage", stage: 2 }, { kind: "compact", stage: 2 }, { kind: "final" },
];

const RIGHT = { B: ["q1", "q3"], E: ["q1", "q3"], F: ["q1", "q2", "q4"], G: Q };
const TELEMETRY = {
  B: {},
  E: { commits: { calls: 3, ok: 2, rejected: { STALE_REVISION: 1 }, stagesWithCommit: 1, stages: 2 } },
  F: {
    commits: { calls: 2, ok: 2, rejected: {}, stagesWithCommit: 2, stages: 2 },
    stateBlock: { deliveries: 2, missing: 0, bytes: 300, findings: 3, cuts: 1 },
  },
  G: { stateBlock: { deliveries: 2, missing: 0, bytes: 1000, findings: 0, cuts: 0 } },
};

export const runId = (taskId, mode) => HOST + "__" + taskId + "__" + mode + "__r1";

function runJson(taskId, mode) {
  return {
    schema: 1, runId: runId(taskId, mode), batch: BATCH, host: HOST, taskId, mode, rep: 1, profile: "compaction",
    status: "completed", failure: null, attempts: [{ attempt: 1, status: "completed" }], durationMs: 1000,
    turns: TURNS.map((t) => ({ ...t })),
    compactions: [{ afterStage: 1, confirmed: true }, { afterStage: 2, confirmed: true }],
    limitHit: null,
    telemetry: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: mode === "B" ? 4 : 6, ...TELEMETRY[mode] },
    integrity: { violations: [] },
  };
}

function gradeJson(taskId, mode) {
  const questions = Q.map((id) => {
    const correct = RIGHT[mode].includes(id);
    return { id, type: "text", correct, given: correct ? VALUES[id] : "other", reason: correct ? null : "wrong_value", aspect: "current_state", preCompaction: id === "q1" };
  });
  const n = questions.filter((q) => q.correct).length;
  const probe = mode !== "B";
  return {
    schema: 1, runId: runId(taskId, mode), status: "completed", valid: true, invalidReason: null,
    success: n === Q.length, score: n / Q.length, questions, continuityErrors: {},
    preCompaction: { questions: 1, correct: 1 },
    checkpoint: { questions: 1, correct: probe ? 1 : 0 },
    checkpointItems: [{ id: "c1", correct: probe, given: probe ? "x" : "y", reason: probe ? null : "wrong_value" }],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Writes the v0.4 fixture into a new temp root. `opts.noStreams` leaves out the raw folder. */
export function writeV04Fixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v04-"));
  for (const [id, cat] of TASKS) {
    writeJson(join(root, "tasks", "v04", "generated", id + ".task.json"), task(id, cat));
    writeJson(join(root, "tasks", "v04", "keys", id + ".key.json"), key(id));
  }
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite: "v04-full", modes: [...MODES], tasksDir: "tasks/v04" });
  for (const [taskId] of TASKS) {
    for (const mode of MODES) {
      const run = runJson(taskId, mode);
      writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
      writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(taskId, mode));
      if (opts.noStreams) continue;
      const dir = join(batchDir, "raw", run.runId, "a1");
      mkdirSync(dir, { recursive: true });
      for (const [label, lines] of Object.entries(streams(mode))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    }
  }
  return { root };
}
