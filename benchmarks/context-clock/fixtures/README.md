# Benchmark fixtures and integration tests

The verification worker owns `benchmarks/context-clock/fixtures/` and `benchmarks/context-clock/tests/integration/`. Everything here follows `CONTRACT.md`. It uses only Node built-in modules and imports nothing from `src/`.

## Layout

```text
fixtures/
  schema.mjs                     contract validators (import them from any module)
  README.md                      this file
  mock/
    build.mjs                    writes generated/, keys/ and runs/ (deterministic)
    generated/<taskId>.task.json two hand-written tasks
    keys/<taskId>.key.json       their keys
    runs/<taskId>__<mode>__r<rep>.json   one recorded run per file, turns in order
tests/integration/
  helpers.mjs                    shared helpers (not a test file)
  fixtures.test.mjs              branch-local: validators and mock fixtures
  isolation.test.mjs             branch-local: no import from src/, no change under src/
  pipeline.test.mjs              MERGED TREE ONLY: generated tasks, generator, mock pipeline
```

`fixtures/mock` has the same layout as a tasks root (`generated/` and `keys/`). The folder is not named `tasks/`, because the repository root `.gitignore` ignores every folder named `tasks/` (line 33). See "Open issues".

To rebuild the mock fixtures after a change to `build.mjs`, run:

```text
node benchmarks/context-clock/fixtures/mock/build.mjs
```

A test makes sure that the committed files equal the builder output.

## Validators: `fixtures/schema.mjs`

Each function returns a list of problem strings. An empty list means valid.

`validateTask(task, key?)` looks at these rules:

- the shape and the enumerations (category, profile, question type)
- stage numbers 1 to N, and relative file paths
- `checkpoint` is null for the profile `long`
- the profile `compaction` has one or two `compactAfter` stages and a checkpoint at the first one
- 5 to 8 final questions, with unique question ids
- unique event ids, each with a visible `[eNNN]` label in the material of its stage
- at least one feed above 6000 bytes
- each stage prompt names its files and feeds
- no answer-like field in the task

With `key`, `validateTask` also runs `validateKey(key, task)`.

`validateKey(key, task?)` looks at these rules:

- the shape and the enumerations (event kind, aspect, error category)
- unique event ids, and `establishedBy` names only known events
- `staleValues` never holds the answer value
- the stage numbers of each answer. Stage 0 is the intro, the initial specification of the task. An event of stage 0 has its label in the task intro.

With `task`, `validateKey` also looks at the pair. The key must have the same `taskId` and seed as the task. It must have one answer for each final and checkpoint question. Each value and stale value must fit the question type and options. The event stages must match the task. The final answers must cover at least three aspects.

`validateRun(run)` looks at these rules:

- the shape and the enumerations (host, mode, profile, status, turn kind)
- `runId` is `<host>__<taskId>__<mode>__r<rep>`
- the environment of the mode
- `failure` is null only for `completed`
- `attempts` is a list of 1 to 3 attempt records `{ attempt, status, failure, durationMs }`, numbered from 1. The last record has the run status. Only the last record can be `completed` or `agent_failed`. A run with `failure.kind: "profile_not_executable"` has an empty list.
- turn records, answers and `integrity.violations`
- no compaction for the profile `long`
- no clock event and no clock snapshot in mode A
- for a run with `telemetry.clockFeedbackByChannel` (an extra field): the keys are `tool_reply`, `hook_context`, `session_start` and `other`, each value is `{ count, bytes }`, and the values add up to `clockFeedbackCount` and `clockFeedbackBytes`
- mode B (feedback off) has no `tool_reply` and no `hook_context` snapshot. It can have `session_start` snapshots, because the product sends the SessionStart state block in every clock mode. A mode B run without `clockFeedbackByChannel` must have no snapshot.

`validateGrade(grade, run?)` looks at these rules:

- the shape and the enumerations (aspect, error category). A correct question has `errorCategory: null`.
- if a question is wrong, `success` is false
- `score` is the fraction of correct questions
- the keys and counts of `continuityErrors` and `preCompaction`

With `run`, `validateGrade` also applies the run rules. A run that is not completed has `success: false` and `score: 0`. A run with a violation is invalid. `preCompaction` is false for the profile `long`. The error counts equal the wrong questions.

`validateSummary(summary)` is narrow, because the contract gives no field names for `summary.json`. It looks only at these rules:

- the summary is a JSON object
- if present, `schema` is 1 and `batch` is a name
- an object named `byMode`, `perMode` or `modes` has only the keys A, B and C
- every number is finite
- no field has a name like `pValue` or `significant`, because the analysis makes no significance claim

The module also exports the enumerations and these helpers:

- `CATEGORIES`, `PROFILES`, `QUESTION_TYPES`, `EVENT_KINDS`, `ASPECTS`
- `ERROR_CATEGORIES`, `STATUSES`, `MODES`, `TURN_KINDS`, `HOSTS`, `MODE_ENV`
- `envProblems(run)` and `answerProblems(question, value)`
- `answerFieldPaths(value)` and `sameValue(a, b)` (the set rule of the grader)

## Mock tasks

| Task | Category | Profile | Stages | Questions |
|---|---|---|---|---|
| `A0-mock-long` | A | `long` | 3 | 5 final |
| `D0-mock-compaction` | D | `compaction` | 4, compaction after stage 2 | 2 checkpoint, 5 final (4 established before the compaction) |

The ids use the number 0, so they do not collide with generated ids.

## Mock run transcripts: `fixtures/mock/runs/`

One JSON file for each run. The file name is `<taskId>__<mode>__r<rep>.json`. The file does not name the host, so one file serves `--host claude --mock` and every other host.

```json
{
  "schema": 1,
  "fixture": "mock-run",
  "taskId": "A0-mock-long",
  "mode": "C",
  "rep": 1,
  "variant": "missing-answer",
  "turns": [
    { "kind": "intro", "durationMs": 4000, "result": { "exitCode": 0, "timedOut": false, "sessionId": "...", "resultText": "...",
      "usage": { "inputTokens": 900, "outputTokens": 40, "cacheReadTokens": 2700, "cacheCreationTokens": 200 },
      "toolCalls": [], "streamPath": null, "compactBoundary": false, "clockSnapshots": { "count": 0, "bytes": 0 } } },
    { "kind": "stage", "stage": 1, "durationMs": 21000, "result": { "...": "a runTurn result" },
      "stream": [ { "type": "tool_use", "name": "Bash", "input": { "command": "..." } } ] },
    { "kind": "checkpoint", "durationMs": 6000, "result": { "...": "a runTurn result" } },
    { "kind": "compact", "afterStage": 2, "result": { "confirmed": true, "mechanism": "/compact through claude -p --resume", "exitCode": 0, "durationMs": 15000, "streamPath": null } },
    { "kind": "final", "durationMs": 9000, "result": { "...": "a runTurn result" } }
  ],
  "expect": { "status": "completed", "valid": true, "success": false, "score": 0.8, "continuityErrors": { "invalid_transition": 1 } }
}
```

The turn fields:

- `kind`: `intro`, `stage`, `checkpoint`, `compact` or `final`, in the order of the run.
- `stage`: the stage number of a `stage` turn.
- `afterStage`: the stage of a `compact` turn.
- `result`: exactly what the contract's `runTurn` returns, or for a `compact` turn what `compact` returns.
- `durationMs`: the recorded turn duration. `runTurn` returns no duration. The mock host reports this value, so a mock run gives the same numbers every time.
- `stream` (optional): host stream events of the turn. The mock host writes them to the turn's stream file, so the runner's integrity scan finds a tool input that leaves the workspace. Only the `integrity-violation` run has one.
- `expect`: what the runner and grader must record for this run. A test recomputes it with a small reference grader from the contract rules.

The checkpoint and final answers are in `resultText` as a fenced `json` block `{"answers": {...}}`, the format of the fixed final prompt. Mode C turns carry `clockSnapshots` and a `[context-clock]` line before the final JSON block. The grader must not read that line as an answer.

| File | Variant | Expected result |
|---|---|---|
| `A0-mock-long__A__r1` | `perfect` | completed, success, score 1 |
| `A0-mock-long__B__r1` | `stale-answer` | completed, score 0.6, `obsolete_decision: 2` (two stale values) |
| `A0-mock-long__C__r1` | `missing-answer` | completed, score 0.8, `invalid_transition: 1` (q4 missing) |
| `A0-mock-long__A__r2` | `agent-failed` | `agent_failed` (no JSON block), score 0 |
| `A0-mock-long__B__r2` | `timeout` | `timeout` (stage 2 times out), score 0 |
| `A0-mock-long__C__r2` | `integrity-violation` | completed, `valid: false`, one violation (a Bash call reads a `key.json` path) |
| `D0-mock-compaction__A__r1` | `perfect-confirmed` | completed, score 1, `preCompaction` 4 of 4, checkpoint 2 of 2, compaction `confirmed: true` |
| `D0-mock-compaction__B__r1` | `stale-pre-compaction` | completed, score 0.8, `preCompaction` 4 of 3 correct, `obsolete_decision: 1` |
| `D0-mock-compaction__C__r1` | `unconfirmed-compaction` | completed, score 1, `preCompaction` 0 of 0 (the host marked no compaction), checkpoint 1 of 2, compaction `confirmed: false` |

### Mock host convention (for the runner worker)

`runner/hosts/mock.mjs` must work as follows:

1. Find the file `<CCB_MOCK_DIR or fixtures/mock/runs>/<taskId>__<mode>__r<rep>.json`. If there is none, it uses its own synthetic turns (the smoke suite on generated tasks needs those).
2. Return the recorded `result` of each turn in order. A turn that times out ends the run there.
3. Replay the same file for every retry attempt. The `timeout` fixture therefore uses all retries and ends as `timeout`.
4. Report `durationMs` from the record, and write `stream` events to the stream file of the turn.
5. Make no model call and use no clock time in any field that reaches `grade.json`, `summary.json` or `report.md`.

The runner gets the task id, the mode and the repetition from its own run plan. The mock host needs them, for example through an option that only the mock host reads. That interface belongs to the runner worker.

## Integration tests

Run them with:

```text
node --test benchmarks/context-clock/tests/integration/
```

On the verification branch alone: 28 tests, 18 pass and 10 skip. Every skip message starts with `MERGED TREE ONLY: missing <module>`.

`fixtures.test.mjs` needs nothing. Its tests:

- the validators accept the mock data and find each kind of problem
- the committed fixtures equal the builder output
- each transcript has the documented layout, and the required variants exist
- each `expect` block equals a reference grade
- clock text before the final JSON is no answer
- no mock task holds a key value

`isolation.test.mjs` has two tests:

- No file under `benchmarks/` imports from `src/`, from outside `benchmarks/`, or from a package. This test needs nothing.
- `git diff --stat context-clock/bench-base -- src/` is empty, and `src/` has no untracked file. This test needs the ref `context-clock/bench-base`.

`pipeline.test.mjs` runs only on the merged tree. Its tests:

- Every committed task and key passes the validators as a pair (needs the generator).
- The suite has 20 tasks: 4 per category, 2 per category and profile (needs the generator).
- No task holds a key value or an answer field. No task names `key.json`, `graders`, `benchmarks` or the repository path (needs the generator).
- Two generator runs into temporary folders give byte-equal files, equal to the committed files (needs the generator).
- The smoke suite with `--mock` runs the runner, the grader and the analysis. The records pass the validators. Each run has the environment of its mode (needs all five modules).
- A second pipeline gives byte-equal `grade.json`, `summary.json` and `report.md` (needs all five modules).
- A resume adds no run and changes no `run.json` (needs all five modules).
- No record or stream names the repository path, `.key.json`, `tasks/keys` or `graders/`. No record names the home folder (needs all five modules).
- The nine fixture transcripts go through the real runner and grader. Each run gives its `expect` values and compactions. This test needs the runner, the mock host, the grader and the analysis.

## What the lead must wire at merge

The contract fixes no option for a results root or a tasks root. The tests use environment variables. The shared module `benchmarks/context-clock/paths.mjs` resolves them for every module (done at merge):

| Variable | Read by | Meaning |
|---|---|---|
| `CCB_RESULTS_DIR` | runner, grader, analysis | The root that replaces `benchmarks/context-clock/results`. A batch is then `<CCB_RESULTS_DIR>/<batch>/`. |
| `CCB_TASKS_DIR` | generator (writes), runner and grader (read) | The root that replaces `benchmarks/context-clock/tasks`: tasks in `<root>/generated/`, keys in `<root>/keys/`. |
| `CCB_MOCK_DIR` | `runner/hosts/mock.mjs` | The folder of recorded transcripts. The default is `benchmarks/context-clock/fixtures/mock/runs`. |

The tests also expect these points:

- The generator takes no argument for the default suite and writes all 20 tasks and keys.
- `node runner/run.mjs --host claude --batch <b> --suite smoke --mock` runs 2 tasks in 3 modes, 1 repetition, with the mock host. With `--tasks` and `--reps` it runs the named tasks.
- `run.json` writes `env` with the keys `CTX_CLOCK` and `CTX_CLOCK_FEEDBACK`. An unset variable is `null` or missing.
- In mock mode, nothing that reaches `grade.json`, `summary.json` or `report.md` depends on wall time or on the results path.
- `report.md` contains the word "exploratory", and every linked `.svg` file exists.

## Limits

- The workspace test is indirect. The tests cannot list a workspace after the runner deletes it. They scan every record and raw stream of the mock batch for the repository path, key file names and the grader folder. A direct test needs a workspace listing from the runner.
- `validateSummary` looks only at the fields the contract names, because the contract gives no summary field names.
- The pipeline tests ran only against missing modules on this branch. Their first real run is after the merge.

## Open issues

1. The repository root `.gitignore` has the line `tasks/`. It ignores `benchmarks/context-clock/tasks/generated/` and `tasks/keys/` too. The generator worker's committed files need `git add -f`, or the lead adds `!benchmarks/context-clock/tasks/` to `.gitignore`.
2. Closed at merge: the contract shows `"attempts": 1` but also says "Every attempt stays in attempts". The lead fixed the list form. `run.json` holds a list of attempt records, and `validateRun` accepts only that form.
