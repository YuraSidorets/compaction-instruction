// Hand-made v0.6 fixture: modes B, J, H, two tasks, one repetition, compactions after stage 1 and stage 2.
//
// Reference facts (schema 2):
//   stage 1: upload limit "5 MB" (history "100 MB"); log shipper set [vector-dev, filebeat]; metrics store "mimir-store" (history "thanos")
//   stage 2: upload limit "10 MB" (history "100 MB", "5 MB"); log shipper [filebeat] (history [vector-dev, filebeat]); metrics store unchanged
// Key: q1 upload limit (current, lastChangedStage 2), q2 log shipper (current, lastChangedStage 3), q3 metrics store
// (history), q4 no fact; probe c1 upload limit (current), after stage 1.
// State files: B none. J and H write the same file before compaction 1. Before compaction 2, J is right (log shipper
// by bold name, metrics store by the alias "store"), H is stale on all three facts.
// Blocks: H only, equal to its state file. Summaries: compact-1 the same in every mode; compact-2 B stale, J and H right.
// Grades: q1 wrong in B and H. The H run of the second task stops at a limit (valid grade, score 0 in the primary table).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "./fixture-v04.mjs";

export const BATCH = "v06-fixture";
export const HOST = "claude";
export const TASKS = Object.freeze([["A9-fixture", "A"], ["C9-fixture", "C"]]);
export const MODES = Object.freeze(["B", "J", "H"]);

export const FACTS1 = Object.freeze([
  { name: "upload limit", kind: "scalar", value: "5 MB", history: ["100 MB"] },
  { name: "log shipper", kind: "set", value: ["vector-dev", "filebeat"], history: null },
  { name: "metrics store", kind: "scalar", value: "mimir-store", history: ["thanos"] },
]);
export const FACTS2 = Object.freeze([
  { name: "upload limit", kind: "scalar", value: "10 MB", history: ["100 MB", "5 MB"] },
  { name: "log shipper", kind: "set", value: ["filebeat"], history: [["vector-dev", "filebeat"]] },
  { name: "metrics store", kind: "scalar", value: "mimir-store", history: ["thanos"] },
]);

export function reference(taskId) {
  return { schema: 2, taskId, states: [{ afterStage: 1, text: "state after stage 1\n", facts: FACTS1 }, { afterStage: 2, text: "state after stage 2\n", facts: FACTS2 }] };
}

export function key(taskId) {
  const a = (value, fact, last) => ({ value, aspect: "current_state", establishedBy: [], staleValues: [], errorCategory: "obsolete_decision", lastChangedStage: last, fact });
  return {
    schema: 1, taskId, seed: 9, events: [],
    answers: {
      q1: a("10 MB", { name: "upload limit", part: "current" }, 2),
      q2: a(["filebeat"], { name: "log shipper", part: "current" }, 3),
      q3: a(["thanos"], { name: "metrics store", part: "history" }, 0),
      q4: a("x", null, 1),
    },
    checkpointAnswers: { c1: { value: "5 MB", establishedBy: [], lastChangedStage: 1, fact: { name: "upload limit", part: "current" } } },
  };
}

export const FILE1 = "# state\nupload limit: 5 MB\nupload limit history: 100 MB, then 5 MB\nlog shipper: filebeat, vector-dev\nmetrics store: mimir-store\nmetrics store history: thanos\n";
export const FILE2 = {
  J: "upload limit: 10 MB\n- **Log Shipper**: filebeat\nstore: mimir-store\n",
  H: "upload limit: 5 MB\nlog shipper: vector-dev, filebeat\nmetrics store: thanos\n",
};
export const SUMMARY1 = "Upload limit is 5 MB. log shipper: vector-dev, filebeat. Metrics store moved from thanos to mimir-store.";
export const SUMMARY2 = { B: "upload limit: 5 MB.", J: "upload limit: 10 MB. log shipper: filebeat.", H: "upload limit: 10 MB. log shipper: filebeat." };

const init = () => ({ type: "system", subtype: "init" });
const done = () => ({ type: "result", subtype: "success" });
const hook = (output) => ({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", output, stdout: output, exit_code: 0 });
const jsonHook = (ctx) => hook(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
const summary = (text) => ({ type: "user", message: { content: "This session is being continued from a previous conversation. " + text } });
const call = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

function compact(mode, n) {
  const lines = [init(), hook("")];
  if (mode === "H") lines.push(jsonHook("[context-clock] product block\n[committed-state]\n" + (n === 1 ? FILE1 : FILE2.H) + "[/committed-state]"));
  else lines.push(jsonHook("[context-clock] product block only"));
  const boundary = { type: "system", subtype: "compact_boundary" };
  if (mode === "J") boundary.compact_metadata = { trigger: "manual", pre_tokens: 1000 * n };
  lines.push(boundary, summary(n === 1 ? SUMMARY1 : SUMMARY2[mode]), done());
  return lines;
}

export function streams(mode) {
  return {
    intro: [init(), done()],
    "stage-1": mode === "B" ? [init(), done()] : [init(), call("w1", "Bash", { command: "cat > clock-state.md" }), done()],
    "compact-1": compact(mode, 1),
    "checkpoint-1": [init(), done()],
    "stage-2": [init(), done()],
    "compact-2": compact(mode, 2),
    final: mode === "J" ? [init(), call("r1", "Read", { file_path: "/w/clock-state.md" }), call("r2", "Read", { file_path: "/w/notes.md" }), done()] : [init(), done()],
  };
}

const usage = (total) => ({ inputTokens: total / 10, outputTokens: total / 10, cacheReadTokens: (total * 7) / 10, cacheCreationTokens: total / 10 });
const STAGE_TOKENS = { B: 100, J: 200, H: 300 };

function turns(mode) {
  const cost = mode === "J" ? { costUsd: 0.5 } : {};
  return [
    { kind: "intro", stage: null, usage: usage(10), ...cost },
    { kind: "stage", stage: 1, usage: usage(STAGE_TOKENS[mode]), ...cost },
    { kind: "compact", stage: 1 },
    { kind: "checkpoint", stage: 1 },
    { kind: "stage", stage: 2, usage: usage(STAGE_TOKENS[mode]), ...cost },
    { kind: "compact", stage: 2 },
    { kind: "final", usage: usage(10) },
  ];
}

export const runId = (taskId, mode) => HOST + "__" + taskId + "__" + mode + "__r1";
const limited = (taskId, mode) => mode === "H" && taskId === TASKS[1][0];

function runJson(taskId, mode) {
  const pre = (n) => (mode === "H" ? { preTokens: 500 * n } : {});
  return {
    schema: 1, runId: runId(taskId, mode), batch: BATCH, host: HOST, taskId, mode, rep: 1, profile: "compaction",
    status: limited(taskId, mode) ? "limit_exceeded" : "completed", limitHit: limited(taskId, mode) ? "tokens" : null,
    failure: null, attempts: [{ attempt: 1, status: "completed" }], durationMs: 1000,
    turns: turns(mode),
    compactions: [{ afterStage: 1, confirmed: true, ...pre(1) }, { afterStage: 2, confirmed: true, ...pre(2) }],
    telemetry: {
      toolCalls: 4,
      ...(mode === "B" ? {} : { stateFile: { writes: 2, stagesWithWrite: 1, stages: 2, reads: { total: mode === "J" ? 1 : 0, afterCompaction: mode === "J" ? 1 : 0 } } }),
    },
    integrity: { violations: [] },
  };
}

function gradeJson(taskId, mode) {
  const wrong = mode === "J" ? [] : ["q1"];
  const questions = ["q1", "q2", "q3", "q4"].map((id) => ({ id, type: "text", correct: !wrong.includes(id), given: "x", reason: wrong.includes(id) ? "wrong_value" : null, aspect: "current_state", preCompaction: false }));
  const n = questions.filter((q) => q.correct).length;
  return {
    schema: 1, runId: runId(taskId, mode), status: limited(taskId, mode) ? "limit_exceeded" : "completed", valid: true, invalidReason: null,
    success: n === 4, score: n / 4, questions, continuityErrors: {},
    preCompaction: { questions: 0, correct: 0 }, checkpoint: { questions: 1, correct: 1 },
    checkpointItems: [{ id: "c1", correct: true, given: "5 MB", reason: null }],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Writes the v0.6 fixture into a new temp root. */
export function writeV06Fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v06-"));
  for (const [id, cat] of TASKS) {
    const t = task(id, cat);
    writeJson(join(root, "tasks", "v06", "generated", id + ".task.json"), t);
    writeJson(join(root, "tasks", "v06", "keys", id + ".key.json"), key(id));
    writeJson(join(root, "tasks", "v06", "reference", id + ".state.json"), reference(id));
  }
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite: "v06-a", modes: [...MODES], comparisons: ["J-B", "H-J", "H-B"], tasksDir: "tasks/v06" });
  for (const [taskId] of TASKS) {
    for (const mode of MODES) {
      const run = runJson(taskId, mode);
      writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
      writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(taskId, mode));
      const dir = join(batchDir, "raw", run.runId, "a1");
      mkdirSync(dir, { recursive: true });
      for (const [label, lines] of Object.entries(streams(mode))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
      if (mode !== "B") {
        writeFileSync(join(dir, "state-file-1.md"), FILE1, "utf8");
        writeFileSync(join(dir, "state-file-2.md"), FILE2[mode], "utf8");
      }
    }
  }
  return { root };
}
