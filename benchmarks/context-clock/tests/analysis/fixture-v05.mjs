// Hand-made v0.5 fixture: modes B, F, H, S, two tasks, one repetition, two compactions per run, reference states.
//
// Reference after stage 1: "owner of api: team-a", "deps of api: db, cache", "owner of api history: team-x, then team-a".
// Reference after stage 2: the same three lines with team-b, plus "deps of db: (none)".
// Blocks: B and S none. F (JSON hook) compact-1 holds every value, compact-2 misses "cache" and the history.
// H (raw hook) compact-1 none, compact-2 holds every value.
// Summaries: compact-1 of every mode holds "team-a" only. compact-2 of S holds every value of stage 2; else "team-b".
// Telemetry: H has stateFile, F has commits. Stage turns carry usage: 100 tokens in B and S, 300 in F, 150 in H.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { key, task } from "./fixture-v04.mjs";

export const BATCH = "v05-fixture";
export const HOST = "claude";
export const TASKS = Object.freeze([["A8-fixture", "A"], ["B8-fixture", "B"]]);
export const MODES = Object.freeze(["B", "F", "H", "S"]);

export const REF1 = "state after stage 1\nowner of api: team-a\ndeps of api: db, cache\nowner of api history: team-x, then team-a\n";
export const REF2 = "state after stage 2\nowner of api: team-b\ndeps of api: db, cache\nowner of api history: team-x, then team-a, then team-b\ndeps of db: (none)\n";

export function reference(taskId) {
  return { schema: 1, taskId, states: [{ afterStage: 1, text: REF1 }, { afterStage: 2, text: REF2 }] };
}

const init = () => ({ type: "system", subtype: "init" });
const done = () => ({ type: "result", subtype: "success" });
const hook = (output) => ({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", output, stdout: output, exit_code: 0 });
const jsonHook = (ctx) => hook(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
const summary = (text) => ({ type: "user", message: { content: "This session is being continued from a previous conversation. " + text } });
const wrap = (body) => "[context-clock] product block\n[committed-state]\n" + body + "\n[/committed-state]";

function compact(mode, n) {
  const lines = [init(), hook("")];
  if (mode === "F") lines.push(jsonHook(wrap(n === 1 ? "owner: team-a\ndeps: db, cache\nwas team-x, then team-a" : "owner: team-b\ndeps: db\ndeps of db: (none)")));
  else if (mode === "H" && n === 2) lines.push(hook(wrap("owner team-b; deps db, cache; history team-x, then team-a, then team-b; db (none)")));
  else lines.push(jsonHook("[context-clock] product block only"));
  const text = n === 1 ? "Owner team-a." : mode === "S" ? "Owner team-b, deps db, cache, (none). Owners: team-x, then team-a, then team-b." : "Owner team-b.";
  lines.push({ type: "system", subtype: "compact_boundary" }, summary(text), done());
  return lines;
}

export function streams(mode) {
  return {
    intro: [init(), done()],
    "stage-1": [init(), done()],
    "compact-1": compact(mode, 1),
    "checkpoint-1": [init(), done()],
    "stage-2": [init(), done()],
    "compact-2": compact(mode, 2),
    final: [init(), done()],
  };
}

const STAGE_TOKENS = { B: 100, F: 300, H: 150, S: 100 };
const usage = (total) => ({ inputTokens: 0, outputTokens: total / 10, cacheReadTokens: (total * 9) / 10, cacheCreationTokens: 0 });

function turns(mode) {
  return [
    { kind: "intro", stage: null, usage: usage(10) },
    { kind: "stage", stage: 1, usage: usage(STAGE_TOKENS[mode]) },
    { kind: "compact", stage: 1 },
    { kind: "checkpoint", stage: 1 },
    { kind: "stage", stage: 2, usage: usage(STAGE_TOKENS[mode]) },
    { kind: "compact", stage: 2 },
    { kind: "final", usage: usage(10) },
  ];
}

const TELEMETRY = {
  B: {},
  F: { commits: { calls: 2, ok: 2, rejected: {}, stagesWithCommit: 2, stages: 2 } },
  H: { stateFile: { writes: 3, stagesWithWrite: 1, stages: 2 } },
  S: {},
};

export const runId = (taskId, mode) => HOST + "__" + taskId + "__" + mode + "__r1";

function runJson(taskId, mode) {
  const total = 2 * STAGE_TOKENS[mode] + 20;
  return {
    schema: 1, runId: runId(taskId, mode), batch: BATCH, host: HOST, taskId, mode, rep: 1, profile: "compaction",
    status: "completed", failure: null, attempts: [{ attempt: 1, status: "completed" }], durationMs: 1000,
    turns: turns(mode),
    compactions: [{ afterStage: 1, confirmed: true }, { afterStage: 2, confirmed: true }],
    limitHit: null,
    telemetry: { inputTokens: 0, outputTokens: total / 10, cacheReadTokens: (total * 9) / 10, cacheCreationTokens: 0, toolCalls: 4, ...TELEMETRY[mode] },
    integrity: { violations: [] },
  };
}

function gradeJson(taskId, mode) {
  const right = mode === "B" ? 2 : 3;
  const questions = ["q1", "q2", "q3", "q4"].map((id, i) => ({ id, type: "text", correct: i < right, given: "x", reason: i < right ? null : "wrong_value", aspect: "current_state", preCompaction: false }));
  return {
    schema: 1, runId: runId(taskId, mode), status: "completed", valid: true, invalidReason: null,
    success: false, score: right / 4, questions, continuityErrors: {},
    preCompaction: { questions: 0, correct: 0 }, checkpoint: { questions: 1, correct: 1 },
    checkpointItems: [{ id: "c1", correct: true, given: "x", reason: null }],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Writes the v0.5 fixture into a new temp root. */
export function writeV05Fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v05-"));
  for (const [id, cat] of TASKS) {
    writeJson(join(root, "tasks", "v04", "generated", id + ".task.json"), task(id, cat));
    writeJson(join(root, "tasks", "v04", "keys", id + ".key.json"), key(id));
    writeJson(join(root, "tasks", "v04", "reference", id + ".state.json"), reference(id));
  }
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite: "v05-full", modes: [...MODES], tasksDir: "tasks/v04" });
  for (const [taskId] of TASKS) {
    for (const mode of MODES) {
      const run = runJson(taskId, mode);
      writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
      writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(taskId, mode));
      const dir = join(batchDir, "raw", run.runId, "a1");
      mkdirSync(dir, { recursive: true });
      for (const [label, lines] of Object.entries(streams(mode))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    }
  }
  return { root };
}
