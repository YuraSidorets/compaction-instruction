// Hand-made v0.8 fixture: suite v08-full, modes B, N, U, Q, two tasks, one repetition, 8 stages, compactions after
// stages 3, 5 and 7. The reference facts, the key and the state files come from the v0.7 fixture.
//
// Telemetry per run (both tasks): tool calls B 10, N 18, U 14, Q 10; tokens B 1000, N 1800, U 1400, Q 1000;
// costUsd B 0.1, N 0.2, U 0.15, Q null. Saves: N at every stage (8), U at stages 2, 4, 6, 8 (one stage old at each
// compaction). Triggers: N standing 4, U periodic with user messages 2, 4, 6, 8 (turns stage-2 ... stage-8) of 9,
// Q precompact 3 with a PreCompact hook line in each compact stream.
// Summaries: B, N, U hold only the API gateway; Q holds all three facts.
// Scores: R8-alpha B 0.5, N 1, U 1, Q 0.75; R8-beta B 0.5 (invalid: one violation not denied), N 0.75 (valid with
// one denied violation), U 0.5, Q 0.75.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "./fixture-v04.mjs";
import { FILE_A, FILE_B, key, reference } from "./fixture-v07.mjs";

export const BATCH = "v08-fixture";
export const HOST = "claude";
export const TASKS = Object.freeze(["R8-alpha", "R8-beta"]);
export const MODES = Object.freeze(["B", "N", "U", "Q"]);
const STAGES = [3, 5, 7];
export const Q_TEXT = "Keep one line for each tracked item with its exact identifier, its current value and its earlier values.";
const CALLS = { B: 10, N: 18, U: 14, Q: 10 };
const TOKENS = { B: 1000, N: 1800, U: 1400, Q: 1000 };
const COST = { B: 0.1, N: 0.2, U: 0.15, Q: null };
const WRITES = { N: [1, 2, 3, 4, 5, 6, 7, 8], U: [2, 4, 6, 8] };
const SCORES = { "R8-alpha": { B: 0.5, N: 1, U: 1, Q: 0.75 }, "R8-beta": { B: 0.5, N: 0.75, U: 0.5, Q: 0.75 } };
export const VIOLATION = Object.freeze({ turn: "stage-6", tool: "Bash", reason: "path outside the workspace", excerpt: "/tmp/s6-log-1.txt" });

const init = () => ({ type: "system", subtype: "init" });
const done = () => ({ type: "result", subtype: "success" });
const summaryLine = (text) => ({ type: "user", message: { content: "This session is being continued from a previous conversation. " + text } });

function summaryText(mode, n) {
  const gw = n === 3 ? "kong-gw" : "envoy-gw";
  if (mode !== "Q") return "API gateway: " + gw + ".";
  return "API gateway: " + gw + ".\nreason(api-gateway): " + (n === 3 ? "cost" : "latency") + "\ncondition of feature-x: only while region is eu";
}

function streams(mode) {
  const out = { intro: [init(), done()] };
  for (let st = 1; st <= 8; st++) {
    out["stage-" + st] = [init(), done()];
    if (!STAGES.includes(st)) continue;
    const lines = [init()];
    if (mode === "Q") lines.push({ type: "system", subtype: "hook_response", hook_name: "PreCompact", hook_event: "PreCompact", output: Q_TEXT, stdout: Q_TEXT, exit_code: 0, outcome: "success" });
    lines.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 50000 } }, summaryLine(summaryText(mode, st)), done());
    out["compact-" + st] = lines;
  }
  out.final = [init(), done()];
  return out;
}

function turns() {
  const list = [{ kind: "intro", stage: null }];
  for (let st = 1; st <= 8; st++) {
    list.push({ kind: "stage", stage: st });
    if (STAGES.includes(st)) list.push({ kind: "compact", stage: st });
  }
  list.push({ kind: "final" });
  return list;
}

export const runId = (taskId, mode) => HOST + "__" + taskId + "__" + mode + "__r1";
const violationsOf = (taskId, mode) => (taskId === "R8-beta" && (mode === "N" || mode === "B") ? [VIOLATION] : []);

function triggers(mode) {
  if (mode === "N") return { standing: { deliveries: 4 } };
  if (mode === "U") return { periodic: { fired: [2, 4, 6, 8].map((n) => ({ n, turn: "stage-" + n })), prompts: 9 } };
  if (mode === "Q") return { precompact: { deliveries: 3 } };
  return null;
}

function runJson(taskId, mode) {
  const ws = WRITES[mode];
  const tr = triggers(mode);
  const vs = violationsOf(taskId, mode);
  return {
    schema: 1, runId: runId(taskId, mode), batch: BATCH, host: HOST, taskId, mode, rep: 1, profile: "compaction",
    status: "completed", limitHit: null, failure: null, attempts: [{ attempt: 1, status: "completed" }], durationMs: 1000,
    turns: turns(),
    compactions: STAGES.map((st) => ({ afterStage: st, confirmed: true })),
    telemetry: {
      toolCalls: CALLS[mode], inputTokens: TOKENS[mode], outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: COST[mode],
      ...(vs.length > 0 ? { guard: { denied: mode === "N" ? 1 : 0 } } : {}),
      ...(ws === undefined ? {} : { stateFile: { writes: ws.length, stagesWithWrite: ws.length, stages: 8, writeStages: ws, reads: { total: 0, afterCompaction: 0 } } }),
      ...(tr === null ? {} : { triggers: tr }),
    },
    integrity: { violations: vs },
  };
}

/** The grade as the grader writes it for a v08 batch: N of R8-beta stays valid (denied), B of R8-beta is invalid. */
function gradeJson(taskId, mode) {
  const score = SCORES[taskId][mode];
  const vs = violationsOf(taskId, mode);
  const valid = vs.length === 0 || mode === "N";
  const nRight = Math.round(score * 4);
  const questions = ["q1", "q2", "q3", "q4"].map((id, i) => ({ id, type: "text", correct: i < nRight, given: "x", reason: i < nRight ? null : "wrong_value", aspect: "current_state", preCompaction: false }));
  return {
    schema: 1, runId: runId(taskId, mode), status: "completed", valid,
    invalidReason: valid ? null : "integrity: 1 violation(s), 1 not denied by the guard, first not denied: x",
    success: valid && score === 1, score: valid ? score : 0, questions, continuityErrors: {},
    preCompaction: { questions: 0, correct: 0 }, checkpoint: { questions: 0, correct: 0 }, checkpointItems: [],
    validityRule: "v08", deniedAttempts: { violations: vs.length, denied: mode === "N" ? vs.length : 0, calls: mode === "N" ? 1 : 0, allDenied: valid && vs.length > 0 },
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Writes the v0.8 fixture into a new temp root. `suite` replaces the suite name (an older suite keeps the old summary). */
export function writeV08Fixture({ suite = "v08-full" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v08-"));
  for (const id of TASKS) {
    writeJson(join(root, "tasks", "v08", "generated", id + ".task.json"), task(id, "A"));
    writeJson(join(root, "tasks", "v08", "keys", id + ".key.json"), key(id));
    writeJson(join(root, "tasks", "v08", "reference", id + ".state.json"), reference(id));
  }
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite, modes: [...MODES], tasksDir: "tasks/v08" });
  for (const taskId of TASKS) {
    for (const mode of MODES) {
      const run = runJson(taskId, mode);
      writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
      writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(taskId, mode));
      const dir = join(batchDir, "raw", run.runId, "a1");
      mkdirSync(dir, { recursive: true });
      for (const [label, lines] of Object.entries(streams(mode))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
      if (WRITES[mode] !== undefined) for (const st of STAGES) writeFileSync(join(dir, "state-file-" + st + ".md"), st === 3 ? FILE_A : FILE_B, "utf8");
    }
  }
  return { root };
}
