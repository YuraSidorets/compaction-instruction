// Hand-made v0.7 fixture: modes B, L, N, T, P, one task, one repetition, 8 stages, compactions after stages 3, 5, 7.
//
// Reference facts (schema 2), with a reason fact and a link (condition) fact:
//   stage 3: API gateway "kong-gw"; reason for api-gateway "cost"; condition of feature-x "only while region is eu"
//   stage 5 and 7: API gateway "envoy-gw" (history "kong-gw"); reason "latency" (history "cost"); condition unchanged
// Key: q1 API gateway (lastChangedStage 4), q2 reason (lastChangedStage 4), q3 condition (lastChangedStage 2), q4 no fact.
// State files: B and P none. L and T write at stages 3, 5, 7 (file A, then file B). N writes at stages 1, 2, 3, 6:
// file A before compactions 3 and 5 (stale at 5, two stages after the write), file B before compaction 7.
// File B writes the condition as "Only while region = EU" (formatted).
// Summaries: compact-3 "kong-gw" in every mode; compact-5 "envoy-gw" in every mode; compact-7 B "kong-gw", others "envoy-gw".
// Grades: q1 wrong in B and N, q2 wrong in N. Early wrong readings: N q1 and q2 (state file stale at compaction 5);
// B q1 is not early (the summary at compaction 5 is right).
// Triggers: N standing deliveries 4. T reminders at stage 3 (turn index), "stage-6" and "stage-7", estimates 41000,
// 45000, 47000; preTokens of T 50000, 55000, 60000. P precompact deliveries 3, and a PreCompact hook_response line in
// each compact stream.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "./fixture-v04.mjs";

export const BATCH = "v07-fixture";
export const HOST = "claude";
export const TASK = "R7-fixture";
export const MODES = Object.freeze(["B", "L", "N", "T", "P"]);
export const COMPACTION_STAGES = Object.freeze([3, 5, 7]);

export const FACTS3 = Object.freeze([
  { name: "API gateway", kind: "scalar", value: "kong-gw", history: null },
  { name: "reason for api-gateway", kind: "scalar", value: "cost", history: null },
  { name: "condition of feature-x", kind: "scalar", value: "only while region is eu", history: null },
]);
export const FACTS5 = Object.freeze([
  { name: "API gateway", kind: "scalar", value: "envoy-gw", history: ["kong-gw"] },
  { name: "reason for api-gateway", kind: "scalar", value: "latency", history: ["cost"] },
  { name: "condition of feature-x", kind: "scalar", value: "only while region is eu", history: null },
]);

export function reference(taskId) {
  return { schema: 2, taskId, states: [{ afterStage: 3, facts: FACTS3 }, { afterStage: 5, facts: FACTS5 }, { afterStage: 7, facts: FACTS5 }] };
}

export function key(taskId) {
  const a = (value, fact, last) => ({ value, aspect: "current_state", establishedBy: [], staleValues: [], errorCategory: "obsolete_decision", lastChangedStage: last, fact });
  return {
    schema: 1, taskId, seed: 7, events: [],
    answers: {
      q1: a("envoy-gw", { name: "API gateway", part: "current" }, 4),
      q2: a("latency", { name: "reason for api-gateway", part: "current" }, 4),
      q3: a("only while region is eu", { name: "condition of feature-x", part: "current" }, 2),
      q4: a("x", null, 1),
    },
    checkpointAnswers: {},
  };
}

export const FILE_A = "api-gateway: kong-gw\nreason(api-gateway): cost\ncondition of feature-x: only while region is eu\n";
export const FILE_B = "api-gateway: envoy-gw\nreason(api-gateway): latency\ncondition of feature-x: Only while region = EU\n";
export const WRITE_STAGES = Object.freeze({ L: [3, 5, 7], T: [3, 5, 7], N: [1, 2, 3, 6] });
const fileAt = (mode, n) => (mode === "N" ? (n === 7 ? FILE_B : FILE_A) : n === 3 ? FILE_A : FILE_B);
const summaryAt = (mode, n) => "API gateway: " + (n === 3 || (n === 7 && mode === "B") ? "kong-gw" : "envoy-gw") + ".";
export const PRECOMPACT_TEXT = "Keep each tracked value and its history in the summary.";
export const PRE_TOKENS = Object.freeze({ 3: 50000, 5: 55000, 7: 60000 });

const init = () => ({ type: "system", subtype: "init" });
const done = () => ({ type: "result", subtype: "success" });
const summary = (text) => ({ type: "user", message: { content: "This session is being continued from a previous conversation. " + text } });

function compact(mode, n) {
  const lines = [init()];
  if (mode === "P") lines.push({ type: "system", subtype: "hook_response", hook_name: "PreCompact", hook_event: "PreCompact", output: PRECOMPACT_TEXT, stdout: PRECOMPACT_TEXT, exit_code: 0, outcome: "success" });
  lines.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: PRE_TOKENS[n] } }, summary(summaryAt(mode, n)), done());
  return lines;
}

export function streams(mode) {
  const out = { intro: [init(), done()] };
  for (let st = 1; st <= 8; st++) {
    out["stage-" + st] = [init(), done()];
    if (COMPACTION_STAGES.includes(st)) out["compact-" + st] = compact(mode, st);
  }
  out.final = [init(), done()];
  return out;
}

function turns() {
  const list = [{ kind: "intro", stage: null }];
  for (let st = 1; st <= 8; st++) {
    list.push({ kind: "stage", stage: st, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 70, cacheCreationTokens: 10 } });
    if (COMPACTION_STAGES.includes(st)) list.push({ kind: "compact", stage: st });
  }
  list.push({ kind: "final" });
  return list;
}

export const runId = (mode) => HOST + "__" + TASK + "__" + mode + "__r1";

function triggers(mode) {
  if (mode === "N") return { standing: { deliveries: 4 } };
  if (mode === "T") return { reminder: { fired: [{ turn: 3, estimate: 41000, threshold: 40000 }, { turn: "stage-6", estimate: 45000, threshold: 40000 }, { turn: "stage-7", estimate: 47000, threshold: 40000 }], unreadable: 0 } };
  if (mode === "P") return { precompact: { deliveries: 3 } };
  return null;
}

function runJson(mode) {
  const ws = WRITE_STAGES[mode];
  const tr = triggers(mode);
  return {
    schema: 1, runId: runId(mode), batch: BATCH, host: HOST, taskId: TASK, mode, rep: 1, profile: "compaction",
    status: "completed", limitHit: null, failure: null, attempts: [{ attempt: 1, status: "completed" }], durationMs: 1000,
    turns: turns(),
    compactions: COMPACTION_STAGES.map((st) => ({ afterStage: st, confirmed: true, ...(mode === "T" ? { preTokens: PRE_TOKENS[st] } : {}) })),
    telemetry: {
      toolCalls: 4,
      ...(ws === undefined ? {} : { stateFile: { writes: ws.length, stagesWithWrite: ws.length, stages: 8, writeStages: ws, reads: { total: 0, afterCompaction: 0 } } }),
      ...(tr === null ? {} : { triggers: tr }),
    },
    integrity: { violations: [] },
  };
}

const WRONG = Object.freeze({ B: ["q1"], N: ["q1", "q2"] });

function gradeJson(mode) {
  const wrong = WRONG[mode] ?? [];
  const questions = ["q1", "q2", "q3", "q4"].map((id) => ({ id, type: "text", correct: !wrong.includes(id), given: "x", reason: wrong.includes(id) ? "wrong_value" : null, aspect: "current_state", preCompaction: false }));
  const n = questions.filter((q) => q.correct).length;
  return {
    schema: 1, runId: runId(mode), status: "completed", valid: true, invalidReason: null,
    success: n === 4, score: n / 4, questions, continuityErrors: {},
    preCompaction: { questions: 0, correct: 0 }, checkpoint: { questions: 0, correct: 0 }, checkpointItems: [],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Writes the v0.7 fixture into a new temp root. */
export function writeV07Fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v07-"));
  writeJson(join(root, "tasks", "v07", "generated", TASK + ".task.json"), task(TASK, "A"));
  writeJson(join(root, "tasks", "v07", "keys", TASK + ".key.json"), key(TASK));
  writeJson(join(root, "tasks", "v07", "reference", TASK + ".state.json"), reference(TASK));
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite: "v07-full", modes: [...MODES], tasksDir: "tasks/v07" });
  for (const mode of MODES) {
    const run = runJson(mode);
    writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
    writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(mode));
    const dir = join(batchDir, "raw", run.runId, "a1");
    mkdirSync(dir, { recursive: true });
    for (const [label, lines] of Object.entries(streams(mode))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    if (WRITE_STAGES[mode] !== undefined) for (const st of COMPACTION_STAGES) writeFileSync(join(dir, "state-file-" + st + ".md"), fileAt(mode, st), "utf8");
  }
  return { root };
}
