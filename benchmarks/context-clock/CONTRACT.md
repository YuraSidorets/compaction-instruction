# Context Clock benchmark contract

The lead owns this file. A worker does not edit it. Every module is plain Node ESM (`.mjs`), uses only Node built-in modules, and runs on Node 24.15 or later. Nothing under `benchmarks/` imports from `src/`, and nothing under `src/` changes for the benchmark.

## Question

Does Context Clock v0.2 improve continuity and task accuracy in long sessions? The benchmark compares three modes on the same tasks.

| Mode | Environment of the agent process |
|---|---|
| `A` baseline | `CTX_CLOCK` unset, `CTX_CLOCK_FEEDBACK` unset |
| `B` silent | `CTX_CLOCK=1`, `CTX_CLOCK_FEEDBACK=off` |
| `C` active | `CTX_CLOCK=1`, `CTX_CLOCK_FEEDBACK` unset |

The prompts, the model, the tool permissions and the budgets are the same in every mode. No prompt names the clock or its tools.

## Folders and owners

| Path under `benchmarks/context-clock/` | Owner |
|---|---|
| `CONTRACT.md`, `README.md`, `results/` | lead |
| `tasks/generator/`, `tasks/generated/`, `tasks/keys/`, `tests/tasks/` | generator worker |
| `runner/`, `configs/`, `tests/runner/` | runner worker |
| `graders/`, `tests/graders/` | grading worker |
| `analysis/`, `tests/analysis/` | analysis worker |
| `fixtures/`, `tests/integration/` | verification worker |

Test files end with `.test.mjs` and run with `node --test benchmarks/context-clock/tests/`.

## How a task reaches the agent

A task is a sequence of stages. Each stage is one agent turn in the same session. The runner sends the stage prompt, the agent uses real tools to get the stage material, and the turn ends. The material of a stage exists in the workspace only during that stage. The runner deletes it after the turn. The agent therefore cannot read old material again at the end. The Context Mode index stays available in every mode.

A stage delivers material in two ways:

- `files`: small files that the agent reads with the `Read` tool.
- `feeds`: named outputs that the agent gets with the command `node feed.mjs <name>` through the `Bash` tool. `feed.mjs` is a fixed script in the workspace. It prints the file `.feed/<name>.txt`.

Most feeds and files are below 3500 bytes, so Context Mode passes them unchanged. Each task has at least one feed above 6000 bytes, so Context Mode indexes it and the agent uses `ctx_search` for it. The stage prompt names every file and feed of the stage.

The turns of one run, in order:

1. `intro`: the fixed instructions plus the initial specification of the task. No tool is needed.
2. `stage` 1 to N.
3. `checkpoint` (only for the profile `compaction`): a few questions directly before the first compaction.
4. `compact` (only for the profile `compaction`): a real host compaction after the stages that have `compactAfter: true`.
5. `final`: the final questions. The prompt allows no tool use for the answer.

Profiles: `long` has no forced compaction. `compaction` has one or two real compactions. Ten tasks have each profile, two per category.

## Task file: `tasks/generated/<taskId>.task.json`

This file holds no answer. The runner reads only this file.

```json
{
  "schema": 1,
  "taskId": "A1-db-overrides",
  "category": "A",
  "seed": 104729,
  "profile": "long",
  "params": { "events": 80, "entities": 6, "updates": 14, "dependencyDepth": 2, "noiseRatio": 0.6, "approxBytes": 52000 },
  "intro": "Initial specification text.",
  "stages": [
    {
      "stage": 1,
      "prompt": "Stage prompt text. It names each file and feed.",
      "files": [ { "path": "inbox/s1/notes-01.md", "content": "..." } ],
      "feeds": [ { "name": "s1-log", "content": "..." } ],
      "eventIds": ["e001", "e002"],
      "compactAfter": false
    }
  ],
  "checkpoint": { "afterStage": 3, "questions": [] },
  "final": {
    "questions": [
      { "id": "q1", "text": "Which database is the primary store now?", "type": "choice", "options": ["postgresql", "sqlite", "redis", "none"] }
    ]
  }
}
```

Rules:

- `category` is `A` (decision overrides), `B` (entities and relationships), `C` (conditional state), `D` (conflicting information) or `E` (long task continuity). Four tasks for each category.
- `checkpoint` is `null` for the profile `long`.
- Question `type` is `choice` (one of `options`), `set` (a list of strings from `options`, order ignored), `int`, or `bool`. No free text answer exists.
- Each task has 5 to 8 final questions. They cover at least three of the aspects in the key.
- Each event text has a visible label such as `[e046]`. Noise events have labels too.
- The same seed gives the same bytes. `generate.mjs` takes no clock time and no random source other than the seeded generator.
- The tasks vary in event count (about 40 to 160), entities, update frequency, dependency depth and noise ratio.

## Key file: `tasks/keys/<taskId>.key.json`

The key never enters a workspace. An independent reference implementation computes it: a state machine that replays the event list. It does not reuse the code that writes the event text.

```json
{
  "schema": 1,
  "taskId": "A1-db-overrides",
  "seed": 104729,
  "events": [ { "id": "e046", "stage": 4, "kind": "state", "summary": "primary database changes to sqlite" } ],
  "answers": {
    "q1": {
      "value": "sqlite",
      "aspect": "current_state",
      "establishedBy": ["e005", "e046"],
      "staleValues": ["postgresql"],
      "errorCategory": "obsolete_decision",
      "firstEstablishedStage": 1,
      "lastChangedStage": 4
    }
  },
  "checkpointAnswers": {}
}
```

- Event `kind` is `state`, `supersede`, `noise`, `rule` or `conflict`.
- `aspect` is one of `current_state`, `original_constraint`, `superseded_decision`, `relationship`, `conditional_state`, `conflict_resolution`, `outstanding_work`, `completed_work`, `rejected_approach`.
- `errorCategory` is the continuity error that a wrong answer shows: `forgotten_requirement`, `obsolete_decision`, `wrong_relationship`, `invalid_transition`, `contradiction`, `lost_progress`, `repeated_work`.
- `staleValues` lists wrong answers that were true at an earlier point. A given answer that equals a stale value is always `obsolete_decision`.

## Fixed prompts

The runner owns the fixed wrapper text in `runner/prompts.mjs`. The same text goes to every mode.

- Intro: the agent gets a task in stages, the material of a stage is removed after the stage, and questions come at the end.
- Final: the agent answers with one JSON object in a fenced `json` block: `{ "answers": { "q1": "sqlite", "q2": ["a", "b"], "q3": 3, "q4": true } }`.

## Host adapter: `runner/hosts/<host>.mjs`

```js
/** One agent turn. sessionId null starts a new session. Never throws for a host failure. */
export async function runTurn({ workspace, prompt, sessionId, env, model, allowedTools, timeoutMs }) {
  return { exitCode, timedOut, sessionId, resultText, usage, toolCalls, streamPath, compactBoundary, clockSnapshots };
}
/** A real host compaction of the session. confirmed is true only for a compaction marker in the host stream. */
export async function compact({ workspace, sessionId, env, model, timeoutMs }) {
  return { confirmed, mechanism, exitCode, durationMs, streamPath };
}
export function hostInfo() { return { host, cliVersion }; }
```

- `usage`: `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` from the host stream. A missing value is `null`.
- `toolCalls`: `[{ name, isError }]` in call order. Tool input and output stay in the raw stream file.
- `clockSnapshots`: `{ count, bytes }` of `[context-clock]` text in the stream of the turn.
- `hosts/mock.mjs` replays recorded turns from `fixtures/` and makes no model call.
- A simulated hook call is never reported as a compaction.

## Isolation

Each run gets a new workspace folder outside the repository and its own Context Mode data folder through `CONTEXT_MODE_DATA_DIR`. The workspace holds `feed.mjs`, the material of the current stage and nothing more. No path in the workspace or in a prompt names the repository, the keys or the graders. The runner does not edit the user configuration of Claude Code or Codex.

Allowed tools: `Read`, `Bash`, `ToolSearch`, and the Context Mode tools. The runner scans the tool calls of every run. It looks for a path outside the workspace and for the words `key.json`, `graders` and `benchmarks`. Each such call is recorded in `integrity.violations`. The grader marks that run as invalid.

## Run record: `results/<batch>/runs/<runId>/run.json`

`runId` is `<host>__<taskId>__<mode>__r<rep>`.

```json
{
  "schema": 1,
  "runId": "claude__A1-db-overrides__C__r1",
  "batch": "claude-full-01",
  "host": "claude",
  "taskId": "A1-db-overrides",
  "mode": "C",
  "rep": 1,
  "profile": "long",
  "order": 37,
  "status": "completed",
  "failure": null,
  "attempts": 1,
  "startedAt": "2026-11-22T16:00:00.000Z",
  "durationMs": 240000,
  "cli": { "version": "2.1.330", "model": "claude-haiku-5-5" },
  "env": { "CTX_CLOCK": "1", "CTX_CLOCK_FEEDBACK": null },
  "sessionId": "…",
  "turns": [
    { "kind": "stage", "stage": 1, "exitCode": 0, "timedOut": false, "durationMs": 31000,
      "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0 },
      "toolCalls": { "Read": 2, "Bash": 3 }, "clockSnapshots": { "count": 0, "bytes": 0 }, "compactBoundary": false }
  ],
  "compactions": [ { "afterStage": 3, "confirmed": true, "mechanism": "/compact through claude -p --resume" } ],
  "answers": { "final": { "q1": "sqlite" }, "checkpoint": null, "finalParseError": null },
  "telemetry": {
    "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0,
    "toolCalls": 0, "toolCallsByName": {}, "clockFeedbackCount": 0, "clockFeedbackBytes": 0,
    "clock": { "events": 0, "maxTick": 0, "stateRevision": 0, "statusCalls": 0, "commitCalls": 0 },
    "searchCalls": 0
  },
  "integrity": { "violations": [] }
}
```

- `status` is `completed`, `agent_failed` (the agent gave no parsable final answer), `timeout`, or `infra_failed` (CLI error, rate limit, crash).
- Rerun policy: the runner retries an `infra_failed` or `timeout` run at most 2 times, in a new workspace and a new session. Every attempt stays in `attempts`. An `agent_failed` run is not retried. It counts as a failed task.
- A batch resumes: a run with a final `run.json` is skipped.
- The run order is a seeded shuffle of all runs of the batch, so no mode runs first as a group.
- Recorded text holds no home path. The runner replaces the home folder and the workspace root with fixed tokens before it saves a record. Raw stream files stay in `results/<batch>/raw/`, which git ignores.

Runner command:

```text
node benchmarks/context-clock/runner/run.mjs --host claude --batch <name> --suite smoke|pilot|full
     [--tasks id,id] [--modes A,B,C] [--reps 2] [--concurrency 4] [--model haiku] [--seed 1] [--mock]
```

`smoke` is 2 tasks, 3 modes, 1 repetition. `pilot` is 5 tasks (one per category), 3 modes, 1 repetition. `full` is 20 tasks, 3 modes, 2 repetitions.

## Grade record: `results/<batch>/runs/<runId>/grade.json`

```js
/** Pure and deterministic. No model call. */
export function gradeRun(task, key, run) { return grade; }
```

```json
{
  "schema": 1,
  "runId": "claude__A1-db-overrides__C__r1",
  "valid": true,
  "invalidReason": null,
  "success": false,
  "score": 0.8,
  "questions": [
    { "id": "q1", "correct": false, "given": "postgresql", "aspect": "current_state", "errorCategory": "obsolete_decision",
      "preCompaction": true, "establishedBy": ["e005", "e046"] }
  ],
  "continuityErrors": { "obsolete_decision": 1 },
  "preCompaction": { "questions": 3, "correct": 2 },
  "checkpoint": { "questions": 2, "correct": 2 }
}
```

- If every final question is correct, `success` is true. In every other case it is false.
- `score` is the fraction of correct final questions.
- If `firstEstablishedStage` is at or before the stage of the first confirmed compaction of the run, `preCompaction` on that question is true. For the profile `long` it is always false.
- A missing answer is wrong with the `errorCategory` of the key. A `set` answer is correct only as an exact set match.
- A run that is not `completed` gets `success: false` and `score: 0`, and keeps its `status` for the report. An `infra_failed` run that used all retries is reported apart and is not part of accuracy numbers.
- The grader never treats clock text in an answer as correct content.

Grader command: `node benchmarks/context-clock/graders/grade.mjs --batch <name>`.

## Analysis: `results/<batch>/summary.json` and `results/<batch>/report.md`

Command: `node benchmarks/context-clock/analysis/analyze.mjs --batch <name>`.

- Accuracy per mode: task success rate, mean score, mean continuity errors per run, and error counts by category.
- Accuracy splits per mode: by task category, by context size (three size groups from `params.approxBytes`), on pre-compaction questions, and on the mid-run questions.
- Cost per mode: tokens, tool calls, duration, compaction count, clock feedback count and bytes, commit calls and status calls.
- Paired comparison: for each `(taskId, rep)` pair, the score difference C minus B, C minus A and B minus A. The report gives the mean difference, a bootstrap 95% interval with a fixed seed, and the win, tie and loss counts.
- The report lists every run where the modes differ, with the wrong questions, the events in `establishedBy`, and the clock telemetry of the run.
- The report lists failed, timed out and invalid runs. It hides none.
- Charts are SVG files that the analysis writes with no dependency. The report links them.
- The analysis states that the sample is exploratory. It makes no significance claim.
