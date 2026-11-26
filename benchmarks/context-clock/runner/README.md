# Context Clock benchmark runner

The runner executes the benchmark runs that `../CONTRACT.md` defines. A run is one task in one mode with one repetition. The runner writes one `run.json` for each run and one `batch.json` for each batch. It does not grade. The grader reads the records later.

## Commands

Run a batch with the Claude host:

```text
node benchmarks/context-clock/runner/run.mjs --host claude --batch <name> --suite smoke|pilot|full
     [--tasks id,id] [--modes A,B,C] [--reps 2] [--concurrency 4] [--model haiku] [--seed 1] [--mock]
     [--session-mode persistent|resume] [--overlay on|off] [--raise-budget] [--keep] [--tasks-dir DIR] [--results-dir DIR] [--work-root DIR]
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--host` | `claude` or `codex` | `claude` |
| `--batch` | Batch name. It is also the folder name under `results/`. | required |
| `--suite` | `smoke`, `pilot`, `full`, `v03-smoke`, `v03-full`, `v04-smoke`, `v04-full`, `v05-smoke`, `v05-full`, `v06-smoke`, `v06-a`, `v06-b-restore`, `v06-b-prep`, `v07-calib`, `v07-smoke`, `v07-full`, `v08-smoke`, `v08-full`, `v09-calib`, `v09-smoke`, `v09-full`, `v09-auto-smoke` or `v09-auto`. `configs/suites.json` gives the tasks, modes and reps of each suite. | required unless `--tasks` |
| `--tasks` | Task ids. They replace the suite's task pick. | suite pick |
| `--modes` | Modes to run, from `A` to `H`, `J` to `L`, `N`, `P` to `U` | suite value, else `A,B,C` |
| `--reps` | Repetitions of each task and mode | suite value |
| `--concurrency` | Runs at the same time | `1` |
| `--model` | Model name for the host CLI | `configs/hosts.json` |
| `--seed` | Seed of the run order shuffle | `1` |
| `--mock` | Use the mock host. No model call. Runs keep the `--host` name. The budgets come from the `mock` entry of `configs/hosts.json`. | off |
| `--session-mode` | `persistent` (one host process for the whole attempt) or `resume` (one process for each turn). See "Session modes". `persistent` needs `--host claude` or `--mock`. | `persistent` for `claude`, `resume` for `codex` |
| `--overlay` | `on` runs Claude Code through the plugin overlay. Mode D needs it. | `on` for the v03 suites, `off` for the others |
| `--raise-budget` | Continue a batch that has a `budget_stopped` mark. Each use adds one more budget. | off |
| `--keep` | Keep each workspace and data folder after the run | off |
| `--tasks-dir` | Folder of the task files | `<CCB_TASKS_DIR>/generated`, else `tasks/generated` |
| `--results-dir` | Results folder | `CCB_RESULTS_DIR`, else `results` |
| `--work-root` | Parent folder of the workspaces. It must be outside the repository. | `<temp>/ccbench` |

Examples:

```text
node benchmarks/context-clock/runner/run.mjs --mock --suite smoke --batch selftest
node benchmarks/context-clock/runner/run.mjs --host claude --batch claude-smoke-01 --suite smoke --model haiku
node --test benchmarks/context-clock/tests/runner/
```

The shared module `../paths.mjs` resolves the folders for the generator, the runner, the mock host, the grader and the analysis. An explicit option comes first, then the environment variable, then the default:

| Variable | Replaces |
| --- | --- |
| `CCB_RESULTS_DIR` | `benchmarks/context-clock/results` |
| `CCB_TASKS_DIR` | `benchmarks/context-clock/tasks` (tasks in `generated/`, keys in `keys/`) |
| `CCB_MOCK_DIR` | `benchmarks/context-clock/fixtures/mock/runs` (recorded mock runs) |

If the task folder has no task file and you give `--mock`, the runner uses the two test tasks in `tests/runner/fixtures/task-files`. In this case, it prints a note.

Exit codes:

- `0`: every run of the batch is final.
- `1`: one or more runs are not final.
- `2`: a usage error, or a batch with a different run list.
- `3`: the batch stopped after three rate-limit failures in a row.
- `4`: the batch budget is spent, or the batch has a `budget_stopped` mark and you did not give `--raise-budget`.

## Output

| Path | Content |
| --- | --- |
| `results/<batch>/batch.json` | Host, CLI version, model, session mode, seed, task seeds, benchmark git commit, OS, Node version, prompt version and run order. It holds no wall time, because the report prints it. |
| `results/<batch>/invocations.json` | Start time, end time and counts of each runner invocation |
| `results/<batch>/runs/<runId>/run.json` | The run record in the contract schema. `attempts` is the list of attempt records `[{ attempt, status, failure, durationMs }]`. The extra field `sessionMode` records the session mode. |
| `results/<batch>/raw/<runId>/a<N>/` | The raw host stream of each turn of attempt N (`<label>.jsonl`), and the stderr. In persistent mode, it also holds `session-tail.jsonl` (stream lines after the last `result` line) and `transcript.jsonl` (a copy of the Claude session transcript). |
| `results/<batch>/work/<runId>/a<N>/context.db` | A copy of the attempt's Context Mode database, for evidence |

Git ignores `raw/` and `work/`. Before the runner saves `run.json`, `batch.json` or `invocations.json`, it replaces local paths with fixed tokens:

| Path | Token |
| --- | --- |
| Home folder | `<home>` |
| Workspace | `<workspace>` |
| Data folder | `<data>` |
| Work root | `<work-root>` |
| Repository root | `<repo>` |

Raw streams keep the real paths.

## Turn sequence

Each attempt sends these turns in one host session:

1. The intro turn. It allows no tool.
2. One turn for each stage. The runner writes the stage files and named outputs into the workspace before the turn and deletes them after the turn.
3. The checkpoint turn, for profile `compaction` only. It comes after stage `checkpoint.afterStage`, directly before the first compaction.
4. A compaction after each stage with `compactAfter: true`.
5. The final turn. It allows no tool.

The prompt text is in `prompts.mjs`. It is the same for every mode. It does not name the clock, a memory tool or Context Mode. The checkpoint and final prompts ask for one fenced json block `{ "answers": { ... } }`. They list each question with its id, type and options.

`answers.mjs` parses the reply. It tries the fenced json blocks from the last to the first. Then it tries the first balanced object in the text. If no block parses, the run is `agent_failed` with `answers.finalParseError` set.

## Isolation

- Each attempt gets a new workspace folder under the work root, with `git init`, `feed.mjs` and a `package.json`. The work root must be outside the repository. If it is inside, the runner stops.
- `feed.mjs <name>` prints the named output of the current stage. After the stage, it exits with code 1 and the text `no output named <name>`.
- Each attempt gets its own `CONTEXT_MODE_DATA_DIR`, outside the workspace.
- The runner builds the child environment from the parent environment. It removes every `CTX_CLOCK*` variable, `CONTEXT_MODE_DATA_DIR`, and the session variables of a surrounding Claude Code or Codex session. Then it adds the mode values. Mode A never inherits a clock variable from your shell.
- The runner deletes the workspace and the data folder after the attempt, unless you give `--keep`.
- The integrity scan reads the tool inputs of every turn. It reports a path outside the workspace and the words `key.json`, `graders` and `benchmarks` in `integrity.violations`. The run status does not change.

## Hosts

| Host | Turn | Compaction |
| --- | --- | --- |
| `claude` | Persistent mode: one `claude -p --input-format stream-json --output-format stream-json --verbose` process, one user message line on stdin for each turn. Resume mode: `claude -p --output-format stream-json --verbose`, prompt on stdin, `--resume <session>` after the first turn. | `/compact` sent on the same stdin (persistent) or through `--resume` (resume). A `system`/`compact_boundary` line in the stream is the proof of the compaction. |
| `codex` | `codex exec --json --sandbox workspace-write --skip-git-repo-check -`, then `codex exec ... resume <id> -` | None. No controlled compaction command is known for `codex exec`. |
| `mock` | With a recorded run `<CCB_MOCK_DIR>/<taskId>__<mode>__r<rep>.json`: its recorded turns. Without one: a synthetic Claude stream, parsed with the Claude parser. | With a recorded run: its compaction result. Without one: a synthetic `compact_boundary` line. |

The mock host follows the convention in `../fixtures/README.md`. It replays the same recorded file for each retry. Its durations are fixed numbers, and the run duration is the sum of the turn durations. Thus two mock pipelines give byte-equal grades, summaries and reports.

The allowed tools of a stage turn are in `configs/hosts.json`: Read, Bash, ToolSearch and the Context Mode tools. The same list applies to every mode. The intro, checkpoint and final turns deny the stage tools.

For Codex, a compaction-profile run is not executable. The runner spends no tokens on it. It writes `status: "infra_failed"` with `failure.kind: "profile_not_executable"`, `attempts: []` and one `compactions` entry with `confirmed: false`. Resume does not run it again.

If a Claude compaction gives no boundary line, the runner records `confirmed: false` in `compactions` and the run goes on. The grader counts only compactions with `confirmed: true` (CONTRACT.md, grade rules). The runner never records a compaction without a boundary line as a done compaction. A timeout or a rate limit in the compaction turn is a failure of the attempt.

Usage is the sum over the turn. For Claude, it comes from the `result` line and includes the cache read and cache creation tokens. The snapshot count includes only `[context-clock]` blocks in tool results and hook output, not the model's own text.

## Session modes

In resume mode, each turn is a new `claude -p --resume` process. Each new process fires the `SessionStart:resume` hook, so every turn of modes B and C gets the clock state block. This makes mode B almost the same as mode C. Persistent mode fixes this. The SessionStart hook fires at the start and after each compaction only.

Persistent mode works like this:

1. The runner starts one process for the attempt, with the mode environment. The MCP server and the hooks get that environment from the process.
2. Before each stage turn, the runner writes the stage material. Then it sends the turn as one stdin line.
3. The runner waits for the `result` line of the turn. It splits the stream at each `result` line and writes one raw file for each turn. The startup lines go to the first turn.
4. After the `result` line, the runner deletes the stage material and sends the next turn.
5. A compaction sends `/compact` on the same stdin. Only a `compact_boundary` line is proof of the compaction.
6. At the end, the runner closes stdin and waits for the process to exit. After 30 seconds, it kills the process tree.

If a turn runs longer than the turn timeout, the runner kills the process tree and the run is `timeout`. If the process exits before a `result` line, the turn is an error with the exit code.

Persistent mode has these limits:

- The process has one tool permission list for the whole attempt: the stage tools. The intro, checkpoint and final turns can use the stage tools. Only the prompt tells the agent to answer without tools.
- `--max-turns` does not apply for each turn.
- `--session-mode resume` keeps the old behavior for a comparison.

## Snapshot channels

The runner sorts each `[context-clock]` block into a channel. `telemetry.clockFeedbackByChannel` (an extra field) holds `{ count, bytes }` for each channel. The channel values add up to `clockFeedbackCount` and `clockFeedbackBytes`. Each turn record has the same values in `clockSnapshotsByChannel`.

| Channel | Source |
| --- | --- |
| `tool_reply` | The result of a Context Mode tool call (`ctx_*` or a tool name with `context-mode`) |
| `hook_context` | The additional context of a `PostToolUse` or `PostToolUseFailure` hook |
| `session_start` | The additional context of a `SessionStart` hook (startup, resume or compact) |
| `other` | Any other tool result or hook, for example a file that holds a block |

The Claude stream writes each hook result two times: as `hook_progress` and as `hook_response` with the same `hook_id`. The runner counts each `hook_id` one time. Snapshot counts of the first smoke batch counted both lines.

The Claude stream shows no `PostToolUse` hook line. Thus the runner counts `hook_context` from the Claude session transcript `~/.claude/projects/<encoded workspace>/<sessionId>.jsonl`. The transcript records an attachment `hook_additional_context` with `hookEvent: "PostToolUse"` for each delivered hook context. After the attempt, the runner copies the transcript to `raw/` as `transcript.jsonl`. `telemetry.clockHooks.source` tells where the count comes from: `transcript` (the runner found the transcript), `stream` (the mock host), or `unavailable` (no transcript). `telemetry.clockHooks.postToolUse` counts the `PostToolUse` hooks that succeeded, were cancelled, or gave context.

The feedback mark table in the clock database cannot count deliveries. It keeps one row for each session and agent, and each new mark replaces it.

## v0.3 placebo experiment

`EXPERIMENT-V03.md` is the contract. This section tells what the runner does for it.

Modes and order:

- Mode D sets `CTX_CLOCK=1` and `CCB_FEEDBACK=placebo`. The overlay shims then replace each real snapshot with a placebo of the same size. `run.json` records `env.CCB_FEEDBACK` in mode D.
- The v03 suites read `tasks/v03/generated`. `v03-smoke` picks one task with 1 compaction and one task with 2.
- The v03 suites use the block order. The runner shuffles the (task, repetition) blocks with the seed. Then it shuffles the modes inside each block. `batch.json` records `order`, `blocks` and `runOrder`. The old suites keep one shuffle of all runs.

Overlay:

- The runner builds one overlay for the batch in `<work-root>/overlay/<batch>`, through `buildOverlay` and `findInstalledPlugin` of `runner/overlay/build.mjs`. `overlay-run.mjs` holds the runner side.
- Claude Code gets `--plugin-dir <overlay>` and `--settings <data>/claude-settings.json`. The settings file disables the installed plugin. A file avoids the quoting problem of inline JSON on Windows.
- Each run gets `CCB_SHIM_LOG` and `CCB_GUARD_LOG` (files in its data folder), `CCB_WORKSPACE` and `CCB_OVERLAY_DIR`. The runner never passes these variables from its own environment to a run.
- After the attempt, the runner copies `shim.jsonl` and `guard.jsonl` to `raw/`. It writes `telemetry.shim` and `telemetry.guard`. `telemetry.shim` holds `byChannel` (`real`, `placebo`, `none` and `bytes` for each channel) and `errors`. `telemetry.guard` holds `denied` and `byTool`.
- A run with a shim error is `infra_failed` with `failure.kind: "shim_error"`.
- `run.json` gets `overlay: { sourceSha }`. Redaction replaces the overlay path with `<overlay>`.

Probes:

- A v03 task has `checkpoint.timing: "after_compaction"` and `checkpoint.probes` (`[{ afterStage, questionIds }]`), as `tasks/v03/README.md` tells. Each probe is one turn of kind `checkpoint`, recorded with its stage. It runs directly after the compaction of its stage and asks only the questions in its `questionIds`.
- The answers of all probes go into `answers.checkpoint`, by question id.
- A task without `timing` keeps the old behavior: one checkpoint turn directly before the compaction.
- The grader and the analysis read the task and key files from the folder in `batch.json` `tasksDir` (`resolveTasksDir` in `paths.mjs`). A set `CCB_TASKS_DIR` still wins.

Limits come from `configs/limits.json`:

| Limit | Value | What the runner does |
| --- | --- | --- |
| Wall time of one run | 1200 s | stops the run: `limit_exceeded`, `limitHit: "wallTime"` |
| Time of one turn | 420 s | caps the turn timeout of `configs/hosts.json`: `timeout` |
| Tool calls of one run | 90 | stops the run: `limitHit: "toolCalls"` |
| Total tokens of one run | 3000000 | stops the run: `limitHit: "totalTokens"` |
| Retries | 2 | as before |
| Runs at the same time | 6 | refuses a higher `--concurrency` |
| Total tokens of the batch | 150000000 | starts no new run: `budget_stopped` |
| Wall time of the batch | 6 h | the same |

- The runner counts tool calls and tokens from the stream while the turn runs. When a limit trips, it stops the process tree of that run only. The raw stream of the stopped turn stays. The runner also checks the counts after each turn and the wall time before each turn. For the mock host, the run time is the sum of the recorded turn durations.
- `limit_exceeded` is a final status. The runner does not retry it. `run.json` records `limits` (the values in force) and `limitHit`.
- The batch budget adds up the tokens and the wall time of every invocation of the batch. `invocations.json` holds the totals, the budget in force and the `budgetStopped` mark. Runs that already run finish. A new start with a mark stops with exit code 4. With `--raise-budget`, the budget grows by one more unit and the batch continues. A run with a final status never runs again.

## v0.4 returned state experiment

`EXPERIMENT-V04.md` adds the modes E, F and G. Every v0.4 mode sets `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`.

| Mode | Added environment | Commit paragraph |
|---|---|---|
| B | none | no |
| E | none | yes |
| F | `CCB_RETURN_STATE=committed` | yes |
| G | `CCB_RETURN_STATE=reference`, `CCB_STATE_FILE=<data>/reference-state.txt` | no |

- The runner sets `CCB_DATA_DIR` to the Context Mode data folder of the run in every mode. A child never inherits `CCB_DATA_DIR`, `CCB_RETURN_STATE` or `CCB_STATE_FILE` from the parent environment.
- In modes E and F, the paragraph of `configs/commit-instruction.txt` ends each stage message. Other turns and other modes do not get it. `batch.json` records its sha256 in `commitInstruction`.
- Mode G reads `<tasks>/reference/<taskId>.state.json`. If a task has no text for one of its compactions, or a text is above 1900 bytes, the plan stops before any run. Before each compaction, the runner writes the text of that stage to `CCB_STATE_FILE`. The file is in the data folder, outside the workspace.
- Modes F and G need `--overlay on`, because the hook shim sends the state block.
- `telemetry.stateBlock` is `{ deliveries, missing, bytes, findings, cuts }` from the `state_block` lines of the shim log. It is null without the overlay. A malformed `state_block` line counts as a shim error, and a shim error makes the run `infra_failed`.
- `telemetry.commits` is `{ calls, ok, rejected, stagesWithCommit, stages }` from the raw streams. `rejected` counts the rejected calls by error code. The code is the product code, for example `REVISION_CONFLICT` or `UNKNOWN_EVIDENCE`. Other codes are `INVALID_INPUT` (a malformed call), `TOOL_ERROR` (a host error) and `NO_RESULT` (a call without a result). If the stage turn of a stage has at least one ok commit, the stage counts in `stagesWithCommit`.
- The suites `v04-smoke` and `v04-full` read `tasks/v04` and use block order and the overlay. `batch.json` copies their `comparisons`: `F-E` (primary), `G-B`, `E-B` and `F-B`.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v04-smoke --batch v04-smoke-01
```

## v0.5 state file and compaction instruction

`EXPERIMENT-V05.md` adds the modes H and S. Like the v0.4 modes, they set `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`.

| Mode | Added environment | Stage message | Compaction |
|---|---|---|---|
| H | `CCB_RETURN_STATE=file`, `CCB_STATE_FILE=<workspace>/clock-state.md` | ends with the state file paragraph | `/compact` |
| S | none | unchanged | `/compact` and the compaction instruction |

- In mode H, the paragraph of `configs/state-file-instruction.txt` ends each stage message. It tells the agent to replace `clock-state.md` in the workspace with one Write call before the reply. The stage turns of mode H also allow the `Write` tool, because the stage tools of `configs/hosts.json` do not include it.
- After each compaction in mode H, the hook shim returns the file in the state block. Thus mode H needs `--overlay on`, as F and G do.
- In mode S, the runner sends `/compact`, a space and the one line of `configs/compact-instruction.txt`. All other modes send the plain `/compact`. Each compact turn in `run.json` has `compactInstruction: true` or `false`.
- `batch.json` records `stateFileInstruction` and `compactInstruction` as `{ file, sha256 }`. If no mode of the batch uses a text, its field is null.
- `telemetry.stateFile` is `{ writes, stagesWithWrite, stages }` in every mode. `writes` counts the Write and Edit calls whose file path ends with `clock-state.md`, in all turns of the raw streams. If the stage turn of a stage has at least one such call, the stage counts in `stagesWithWrite`. The count does not look at the result of the call.
- The suites `v05-smoke` and `v05-full` read `tasks/v04` and use block order and the overlay. `v05-smoke` runs A8 and E7 in modes H and S once. `v05-full` runs 7 tasks in modes B, F, H and S four times, and `batch.json` copies its `comparisons`: `H-F` (primary), `H-B`, `S-B` and `F-B`.
- A suite can set `batchTokens`. This value replaces the batch token limit of `configs/limits.json` for that suite only. `v05-full` sets 200 million tokens.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v05-smoke --batch v05-smoke-01
```

## v0.6 memory delivery and save frequency

`EXPERIMENT-V06.md` adds the modes J, K and L. Like H, they set `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`, and their stage turns allow `Write`.

| Mode | Added environment | State file paragraph |
|---|---|---|
| J | none | every stage message |
| K | as H: `CCB_RETURN_STATE=file`, `CCB_STATE_FILE=<workspace>/clock-state.md` | only the message of a stage with `compactAfter` true |
| L | none | only the message of a stage with `compactAfter` true |

- Mode J is mode H without `CCB_RETURN_STATE` and `CCB_STATE_FILE`. The stage messages, the compactions and the tools of J and H are byte-equal. Mode K needs `--overlay on`, as H does.
- Directly before each `/compact`, the runner copies `<workspace>/clock-state.md` to `state-file-<N>.md` in the raw attempt folder, in every mode. N is the stage before the compaction. If the file does not exist, the runner makes no copy and goes on. Each entry of `compactions` records `stateFileCopied` and `stateFileBytes` (null without a copy).
- Each entry of `compactions` records `preTokens`, the `pre_tokens` value of the `compact_boundary` line in the host stream. It is null when the stream has no such value.
- `telemetry.stateFile.reads` is `{ total, afterCompaction }`. A read is a Read, Grep or Bash call whose input names `clock-state.md`. `afterCompaction` counts the reads in the turns after the first compact turn. In Claude Code, the Write tool replaces an existing file only after a Read of it, so a read before a write also counts.
- Each turn records `costUsd`. Claude Code reports `total_cost_usd` on each result line as the running total of the session, in persistent mode and after `--resume`. Thus `costUsd` is the increment against the previous total of the same attempt. The runner never adds up the totals. `costUsd` is null when the stream has no total, or when the total went down.
- A suite can select its tasks by id prefix with `taskPrefix`. `v06-smoke` uses `C9`.

| Suite | Modes | Repetitions | Comparisons | Batch token limit |
|---|---|---|---|---|
| `v06-smoke` | B, J, H | 1 | none | 6 million |
| `v06-a` | B, J, H | 2 | `J-B`, `H-J`, `H-B` | 40 million |
| `v06-b-restore` | H, K | 2 | `K-H` | 25 million |
| `v06-b-prep` | J, L | 2 | `L-J` | 25 million |

All four suites read `tasks/v06` and use block order and the overlay.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v06-smoke --batch v06-smoke-01 --concurrency 2
```

## v0.7 product triggers

`EXPERIMENT-V07.md` adds the modes N, T and P. Each one sets `CTX_CLOCK=1`, `CTX_CLOCK_FEEDBACK=off` and `CCB_DATA_DIR`, as mode B does. No mode returns the state file, so none sets `CCB_RETURN_STATE`. An overlay hook delivers a fixed text from `configs/`, and the runner gives the hook the absolute path of that text.

| Mode | Added environment | Hook of the overlay | Stage tools |
|---|---|---|---|
| N | `CCB_STANDING_FILE=<configs>/standing-instruction.txt` | `SessionStart`, at the start and after each compaction | as B, plus `Write` |
| T | `CCB_REMIND_FILE=<configs>/reminder-instruction.txt`, `CCB_REMIND_THRESHOLD=40000` | `PostToolUse`, one time after the context estimate passes the threshold | as B, plus `Write` |
| P | `CCB_PRECOMPACT_FILE=<configs>/compact-instruction.txt` | `PreCompact`, at each compaction | as B |

- The stage messages, the probe prompts and the compactions of N, T and P are byte-equal to those of mode B. No stage message names the state file. Mode P sends the plain `/compact`, unlike mode S.
- The texts of L, N and T describe the state file with the same sentences, taken from `configs/state-file-instruction.txt`. That file stays as in v0.6 for mode L. The text of P is the compaction instruction of mode S. No text names a task value.
- N, T and P need `--overlay on`.
- A suite can set `remindThreshold` to replace the threshold of mode T.
- `batch.json` records `standingInstruction` (mode N) and `reminderInstruction` (mode T) as `{ file, sha256 }`, else null. It also records `remindThreshold` when mode T is in the batch, else null. `compactInstruction` is set when mode S or mode P is in the batch.
- A task with 8 stages and compactions after stages 3, 5 and 7 needs no special case. The runner asks the probes after each compaction, and it copies the state file to `state-file-<N>.md` before each `/compact`, in every mode.
- `telemetry.stateFile.writeStages` lists the stage number of each Write or Edit call on `clock-state.md` in a stage turn. A stage with two calls appears two times. Calls in other turns count only in `writes`.
- `telemetry.triggers` is `{ standing: { deliveries }, reminder: { fired: [{ turn, estimate, threshold }], unreadable }, precompact: { deliveries } }`. It is null without the overlay. The runner reads it from the shim log channels `standing`, `reminder` and `precompact`:
  - A `standing` or `precompact` line counts as a delivery, unless it has `delivered: false`.
  - A `reminder` line with `unreadable: true` counts in `unreadable`. Any other `reminder` line is a reminder that fired, unless it has `fired: false`. `estimate` and `threshold` come from the line, or are null.
  - `turn` is the runner turn label during which the hook wrote the line. The runner counts the shim log lines after each turn to find it.
  - A line with an `error` field is a shim error, and the run is `infra_failed`, as in every other channel.
- A suite can replace two run limits of `configs/limits.json`: `runWallTimeMs` and `runToolCalls`. The v07 suites set 1 800 000 ms and 120 tool calls as first values. The lead sets the final values after the calibration batch.
- The mock host writes the shim log lines of the three hooks. In mode N, the mock agent writes `clock-state.md` in each stage with an odd number. In mode T, its context estimate grows by 15 000 tokens with each turn, and the mock agent writes the file in the stage turn where the reminder fires.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit |
|---|---|---|---|---|---|
| `v07-calib` | all 6 | B, L | 1 | none | 20 million |
| `v07-smoke` | the task with prefix `A10` | N, T, P | 1 | none | 6 million |
| `v07-full` | all 6 | B, L, N, T, P | 2 | `N-B`, `T-B`, `P-B`, `L-B`, `N-L`, `T-L`, `P-L` | 90 million |

All three suites read `tasks/v07` and use block order and the overlay.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v07-calib --batch v07-calib-01 --concurrency 2
```

## v0.8 periodic reminder and stronger summarizer instruction

`EXPERIMENT-V08.md` adds the modes U and Q. Like N, T and P, they set the clock variables of mode B and no `CCB_RETURN_STATE`, and they need `--overlay on`. Their stage messages, probe prompts and compactions are byte-equal to those of mode B. Both send the plain `/compact`.

| Mode | Added environment | Hook of the overlay | Stage tools |
|---|---|---|---|
| U | `CCB_PERIODIC_FILE=<configs>/state-file-instruction.txt`, `CCB_PERIODIC_EVERY`, `CCB_PERIODIC_OFFSET` | `UserPromptSubmit`, adds the text to user message n when n > offset and (n - offset) % every == 0 | as B, plus `Write` |
| Q | `CCB_PRECOMPACT_FILE=<configs>/precompact-strong-instruction.txt` | `PreCompact`, as P | as B |

The hook counts user messages, not stages. One run sends these user messages, in this order:

1. The intro.
2. Each stage message, followed by the probes of that stage before a compaction.
3. After a compaction, the probes of that stage.
4. The final questions.

The runner sends `/compact` as a message too. The Claude Code documentation does not say whether `/compact` fires `UserPromptSubmit`. The runner assumes that it does not. A suite can set `periodicCountsCompact: true` for the other case.

- A suite names the reminded stages with `periodicStages`. It can give the hook values with `periodicEvery` and `periodicOffset`. At plan time, the runner builds the message order of each task (`runner/v08.mjs` `promptSequence`). It then makes sure that the hook values remind exactly the messages of those stages, and no other message. If they do not, the plan fails with the message list. Without `periodicEvery` and `periodicOffset`, the runner finds the smallest values that fit, and the run environment gets the values for its task. Without `periodicStages`, the runner uses `periodicEvery` and `periodicOffset` (else 2 and 0) as they are.
- In a task with 8 stages, compactions after stages 3, 5 and 7, and one probe turn after each compaction, the messages are: intro (1), stages 1 to 3 (2 to 4), probe 3 (5), stages 4 and 5 (6, 7), probe 5 (8), stages 6 and 7 (9, 10), probe 7 (11), stage 8 (12) and final (13). Every 3 with offset 0 reminds messages 3, 6, 9 and 12. These are stages 2, 4, 6 and 8. The v08 suites set `periodicStages: [2, 4, 6, 8]`, `periodicEvery: 3` and `periodicOffset: 0`. If the host counts `/compact`, no pair of values fits, and the plan fails.
- `batch.json` records `periodicInstruction` (mode U) and `precompactStrongInstruction` (mode Q) as `{ file, sha256 }`, else null. It also records `periodic`, which is `{ stages, every, offset, countsCompact, byTask }` with the values and the reminded turns of each task, or null without mode U.
- `telemetry.triggers.periodic` is `{ fired: [{ n, turn }], prompts }`, from the shim log channel `periodic`. `prompts` counts the user messages that the hook saw. `fired` lists the message number and the runner turn of each reminder. In a correct run of mode U, the turns are `stage-2`, `stage-4`, `stage-6` and `stage-8`.
- `telemetry.costUsd` is the sum of the `costUsd` values of the turns of the run, in dollars as the host reports them. Each turn value is the increment of the session total `total_cost_usd`, so the sum equals the last session total of the attempt. It is null when no turn has a value.
- A `reminder` line of mode T with `fired: false` and a reason that says the transcript could not be read now counts in `reminder.unreadable`. The reasons are `no transcript_path`, `transcript missing` and `no usage record`. This is the form that the overlay writes.
- The mock host counts the user messages of mode U and writes one `periodic` line for each one. The mock agent writes `clock-state.md` in each stage turn where the reminder fires. With the host option `periodicCountsCompact`, the mock also counts each compaction.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit |
|---|---|---|---|---|---|
| `v08-smoke` | the task with prefix `A11` | U, Q | 1 | none | 4 million |
| `v08-full` | all 6 | B, N, U, Q | 2 | `N-B`, `U-B`, `Q-B`, `U-N`, `Q-N` | 80 million |

Both suites read `tasks/v08`, use block order and the overlay, and set 1 800 000 ms and 120 tool calls as run limits.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v08-smoke --batch v08-smoke-01 --concurrency 2
```

## v0.9 general summarizer instruction and automatic compaction

`EXPERIMENT-V09.md` adds mode R and a mode with no `/compact`.

- Mode R is mode Q with `CCB_PRECOMPACT_FILE=<configs>/precompact-general-instruction.txt`. It needs `--overlay on`, and its prompts and compactions are byte-equal to those of mode B. `batch.json` records the text as `precompactGeneralInstruction` (`{ file, sha256 }`, else null).
- A suite can select its tasks by a list of id prefixes with `taskPrefixes`. The runner takes the tasks of each prefix in list order, and each prefix must match a task. The v09 suites resolve their tasks this way when they load, so they need no task slug.
- A suite can replace the run token limit with `runTotalTokens`.
- Each turn record has `contextTokens`: the context size after the turn. It is the usage sum of the last assistant message of the main chain (input, cache read, cache creation and output tokens), or null.
- Each manual compaction in `compactions` has `trigger: "manual"`.
- `telemetry.triggers.precompactByTrigger` is `{ manual, auto, unknown }`. It counts the `precompact` deliveries by the `trigger` field of the shim line. A line with no such field, or with another value, counts as `unknown`.

### Automatic compaction mode

With `autoCompact: true` in the suite, the runner sends no `/compact`. After each turn, it reads the stream of that turn. Each `compact_boundary` line in it is a compaction that the host made by itself. This line is the same mark that confirms a manual compaction.

- The runner adds an entry to `compactions` for each such line: `{ afterStage, turn, confirmed: true, mechanism, preTokens, trigger: "auto", hostTrigger }`. `afterStage` is the stage of the turn, and `turn` is its label. `hostTrigger` is the `trigger` value of the host line. The runner makes no state file copy before an automatic compaction.
- After a stage turn with an automatic compaction, the runner asks the probes of that stage, as after a manual compaction. If no compaction was detected, the runner asks no probe. In this mode the runner never asks a plain probe at `checkpoint.afterStage`. A task with `checkpoint.timing: "after_auto_compaction"` uses only its `checkpoint.probes`, so a run with zero compactions has zero probe turns.
- A task with no compaction stage can name any stage in its probes. A suite without `autoCompact` rejects such a task, and also any task with `checkpoint.timing: "after_auto_compaction"`.
- A long task (profile `long`) can have automatic compactions. A manual compaction in a long run is still an error of the run record.
- The suite field `autoCompactWindow` (an integer, at least 100 000) makes the runner set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment of the host process of each run of that suite. The runner sets no global setting and writes no settings file. `batch.json` records the value as `autoCompactWindow` (`null` without the field), and `run.json` records it in `env`.
- The runner removes an inherited `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from the environment of every run. A suite with `autoCompactWindow` then sets only its own value.
- The mock host simulates the automatic compaction with the host options `autoCompactAt`, `contextPerTurn` (default 20 000) and `contextAfterCompact` (default 10 000). Without `autoCompactAt`, no compaction occurs, and the run has zero compactions.
- `claude --help` (Claude Code 2.1.331) documents `--autocompact <auto|tokens>`: "Auto-compact window size (auto, or at least 100k tokens)". The runner does not pass it.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit | Run limits |
|---|---|---|---|---|---|---|
| `v09-calib` | prefixes W12, X12 (4) | B | 1 | none | 6 million | 1 800 s, 120 tool calls |
| `v09-smoke` | the first W12 task | R | 1 | none | 4 million | 1 800 s, 120 tool calls |
| `v09-full` | prefixes A12, D12, W12, X12 (6) | B, N, Q, R | 2 | `N-B`, `Q-B`, `R-B`, `R-N`, `R-Q` | 80 million | 1 800 s, 120 tool calls |
| `v09-auto-smoke` | prefix A13 (the long task) | R | 1 | none | 20 million | 5 400 s, 400 tool calls, 20 million tokens |
| `v09-auto` | prefix A13 (the long task) | B, R | 2 | `R-B` | 60 million | 5 400 s, 400 tool calls, 20 million tokens |

All five suites read `tasks/v09` and use block order and the overlay. The two automatic suites set `autoCompact: true` and `autoCompactWindow: 100000`.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v09-calib --batch v09-calib-01 --concurrency 2
```

## v0.10 variant summarizer instruction

EXPERIMENT-V10.md adds mode V. Mode V is mode R with `configs/precompact-variant-instruction.txt` as the `PreCompact` output. The runner sets `CCB_PRECOMPACT_FILE` to that file, and the overlay reads the text from it. Mode V needs the overlay.

`batch.json` records `precompactVariantInstruction`: `{ file, sha256 }` with the sha256 of the trimmed text, or `null` if the batch has no mode V. This is the same record as `precompactStrongInstruction` (mode Q) and `precompactGeneralInstruction` (mode R).

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit | Run limits |
|---|---|---|---|---|---|---|
| `v10-smoke` | `X12-data-retention` | V | 1 | none | 4 million | 1 800 s, 120 tool calls |
| `v10-full` | prefixes A12, D12, W12, X12 (6) | Q, R, V | 2 | `V-R`, `V-Q`, `R-Q` | 50 million | 1 800 s, 120 tool calls |

Both suites read `tasks/v09` and use block order and the overlay.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v10-smoke --batch v10-smoke-01
```

## Context Clock v0.3 product PreCompact instruction (mode M)

The design is in `docs/context-clock/v0.3-design.md`, section "Acceptance with the benchmark". Its arm C3 is runner mode M.

- Mode M has `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`, like mode B. It has no overlay text: no `CCB_PRECOMPACT_FILE`, no standing file and no reminder. `CTX_CLOCK_COMPACT` stays unset, so the product hook itself prints the text at `PreCompact`.
- Every other mode runs with `CTX_CLOCK_COMPACT=off`, so that the product `PreCompact` output is empty there. The runner removes an inherited `CTX_CLOCK_COMPACT`, as it does for each `CTX_CLOCK*` variable. `run.json` records `env.CTX_CLOCK_COMPACT` (`null` in mode M, `"off"` in the other modes).
- The hook shim logs one line for each `PreCompact` call of the product hook, in each mode: `{ channel: "precompact_product", event, trigger, bytes, sha256, exitCode }`. `bytes` is the size of the product stdout. `sha256` is the hash of the trimmed stdout, or `null` if the stdout is empty.
- `telemetry.triggers.precompactProduct` is `{ calls, deliveries, bytes, sha256s, byTrigger }`. `calls` counts the lines. A line with more than 0 bytes is a delivery. `sha256s` holds one hash for each delivery, and `byTrigger` counts the deliveries by trigger.
- `rewriteHooks` runs a product `PreCompact` entry through the shim once and adds no second entry. For a manifest without a `PreCompact` entry, it still adds its own shim entry.
- Mode M needs the overlay. If the batch has mode M and the product plugin has no `PreCompact` hook, the runner stops before the first run. Set `CCB_PLUGIN_SOURCE` to the Context Clock v0.3 build.
- `batch.json` records `precompactProductInstruction`: `{ file, sha256 }` of `configs/precompact-general-instruction.txt` (the text that the product prints), or `null` without mode M.
- The mock host simulates a product with a `PreCompact` hook (host option `productPreCompact`, default `true`).

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit | Run limits |
|---|---|---|---|---|---|---|
| `v11-smoke` | `X12-data-retention` | M | 1 | none | 4 million | 1 800 s, 120 tool calls |
| `v11-full` | prefixes A12, D12, W12, X12 (6) | B, R, M | 2 | `M-R`, `M-B`, `R-B` | 50 million | 1 800 s, 120 tool calls |

Both suites read `tasks/v09` and use block order and the overlay.

```powershell
$env:CCB_PLUGIN_SOURCE = "<path of the Context Clock v0.3 plugin build>"
node benchmarks/context-clock/runner/run.mjs --host claude --suite v11-smoke --batch v11-smoke-01
```

## v0.11 plain arms without Context Mode (modes O and I)

EXPERIMENT-V11.md part A adds two arms that run Claude Code with no Context Mode part.

- Mode O: plain Claude Code. The only hook is the workspace guard, as a `PreToolUse` hook of the benchmark. It is the same `guard.mjs` as in the overlay, with the same guard log.
- Mode I: mode O plus one `PreCompact` hook of the benchmark (`runner/plain/precompact-hook.mjs`). It prints `configs/precompact-general-instruction.txt` trimmed (694 bytes) as plain stdout. It logs one line for each call: `{ channel: "precompact", event: "PreCompact", trigger, delivered, bytes, sha256 }`.
- Both modes need `--host claude` and no overlay.

### Isolation

The runner builds one small plugin for each plain mode of the batch, under `<workRoot>/plain/<batch>/<mode>`. The plugin is named `ccb-plain`. It holds `hooks/hooks.json` and the hook scripts, and it has no MCP server, no skill and no command. Each plain run starts the host with these flags:

- `--plugin-dir` with the benchmark plugin only.
- `--setting-sources project,local`. The host does not load the user settings, so no user hook, no user plugin and no user permission rule reaches the session. The workspace has no project settings.
- `--strict-mcp-config` with no `--mcp-config`. The host starts no MCP server.
- `--settings` with a run settings file that also disables the installed Context Mode plugin.

The run inherits no `CTX_*` and no `CCB_*` variable, and it has no `CONTEXT_MODE_DATA_DIR`. The runner changes no global file. The guard keeps the agent inside the workspace, so the session cannot read the answer keys or the transcripts. The stage tool list of a plain run has no Context Mode tool.

### Records

- `run.json` `session` (every mode): `{ plain, settingSources, strictMcpConfig, plugin, hooks, init, contextModeParts }`. `init` holds the plugins, MCP servers, tools, skills and slash commands that the init lines of the stream reported, merged over the turns. `hooks` lists the hooks of the benchmark plugin in a plain run (`null` in the other modes). `contextModeParts` lists every name of a Context Mode part in `init` and `hooks`. A plain run must have `[]`.
- `telemetry.shim` and `telemetry.stateBlock` are `null` in a plain run, because there is no shim. `telemetry.guard` and `telemetry.triggers` read the guard log and the hook log as in the other runs.
- `telemetry.triggers.precompactPlain`: `{ deliveries, bytes, sha256s, byTrigger }` from the lines of the arm I hook.
- `batch.json` `plain`: the isolation flags and the hooks of each plain plugin. `precompactPlainInstruction`: `{ file, sha256 }` of the text of mode I, or `null`.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit | Run limits |
|---|---|---|---|---|---|---|
| `v11-plain-smoke` | `X12-data-retention` | I | 1 | none | 4 million | 1 800 s, 120 tool calls |
| `v11-plain` | prefixes A12, D12, W12, X12 (6) | O, I | 2 | `I-O` | 35 million | 1 800 s, 120 tool calls |

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v11-plain-smoke --batch v11-plain-smoke-01 --seed 1110
```

## Isolated sessions (suite field `isolated`)

Without isolation, an overlay session loads the user plugins, the user hooks and the user MCP servers of the machine, but a plain session loads none. The suite field `"isolated": true` gives every session of the suite the same isolation. The flag `--isolated on|off` overrides the field. Without the field and the flag, the runner starts the host exactly as before.

An isolated overlay session (modes B, R, M, Y and the other overlay modes) starts the host with these flags and this environment:

- `--plugin-dir` with the Context Mode overlay, and `--settings` with the run settings file (as before).
- `--setting-sources project,local`. The host does not load the user settings, so no user plugin, no user hook and no user MCP server reaches the session.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the environment of the host process only. The claude.ai connectors do not come from the settings, so `--setting-sources` does not remove them.
- No `--strict-mcp-config`. With that flag, the host also drops the MCP server of a `--plugin-dir` plugin, so the overlay would lose its own MCP server.

An isolated plain session (modes O and I) keeps the flags of the plain arms (`--setting-sources project,local` and `--strict-mcp-config`) and also gets `ENABLE_CLAUDEAI_MCP_SERVERS=false`. The sign-in of the CLI stays available, because the host reads it from its credential store and not from the user settings. The runner changes no global file. The user skills under `~/.claude/skills` still load: no flag of the host removes them without also removing the slash commands.

A suite can mix plain and overlay modes (for example `v11-iso`). The suite sets `overlay: true`, and the mode decides the session kind: a plain mode runs with its benchmark plugin and never with the overlay.

### Allowed parts

The runner reads the init lines of the stream of each isolated run. These parts are allowed:

- In an overlay run: the overlay plugin (the name in its `plugin.json`, normally `context-mode`), the MCP servers `plugin:<that name>:*`, and the built-in plugins `cc-plugin-*` of the host.
- In a plain run: `ccb-plain` and the built-in plugins `cc-plugin-*`. No MCP server.

If an init line shows another plugin or MCP server, the run is `infra_failed` with the failure kind `isolation_violation` and a message that names each part. The runner does not retry it, so no retry hides it.

### Records

- `run.json` `session`: `{ plain, isolated, settingSources, strictMcpConfig, claudeAiConnectors, plugin, plugins, mcpServers, hooks, init, contextModeParts, isolationViolations }`. `plugins` and `mcpServers` come from the init lines. `hooks` lists the hooks of the benchmark plugin in a plain run and the hooks of the overlay plugin in an overlay run. `isolationViolations` is `[]` in a clean isolated run and `null` in a run that is not isolated.
- `run.json` `env`: `ENABLE_CLAUDEAI_MCP_SERVERS: "false"` in an isolated run.
- `batch.json` `isolated` and `isolation`: `{ settingSources, strictMcpConfigOverlay, strictMcpConfigPlain, env }`, or `null`.

### Mode Y

Mode Y has `CTX_CLOCK=1`, `CTX_CLOCK_FEEDBACK=off`, `CTX_CLOCK_COMPACT=off` and no overlay text: the clock is on and the product compaction instruction is off. Its environment is the same as the environment of mode B, because every mode other than M and the plain modes gets `CTX_CLOCK_COMPACT=off`.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit |
|---|---|---|---|---|---|
| `v11-smoke` | `X12-data-retention` | M | 1 | none | 4 million |
| `v11-full` | prefixes A12, D12, W12, X12 (6) | B, R, M, Y | 2 | `M-R`, `M-B`, `R-B`, `M-Y`, `Y-B` | 70 million |
| `v11-iso-smoke` | `X12-data-retention` | R | 1 | none | 4 million |
| `v11-iso` | prefixes A12, D12, W12, X12 (6) | O, I, B, R | 2 | `I-O`, `R-B`, `B-O`, `R-I` | 70 million |
| `v12-calib` | prefixes A12, D12, W12, X12 (6) | B | 1 | none | 12 million |
| `v12-full` | prefixes A12, D12, W12, X12 (6) | B, R | 2 | `R-B` | 35 million |

All these suites are isolated, use `tasks/v09` in block order, and have the run limits 1 800 s and 120 tool calls.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v11-iso-smoke --batch v11-iso-smoke-01 --seed 1111
```

## v12 plain arms Z and W

`docs/context-clock/PLAN-standalone.md` names these arms S and C. The letters S and C are taken, so the runner uses Z and W. Both are plain modes like O and I: isolated, with no Context Mode part, and with the benchmark plugin `ccb-plain` that holds only the workspace guard. The `PreCompact` hook of mode I does not run in Z or W.

- Mode Z loads the standalone plugin `compaction-instruction` unchanged, as a second `--plugin-dir`. The folder comes from the variable `CCB_STANDALONE_PLUGIN`. Without it, the folder is `<plugin-dir>`. The runner reads the manifest and `hooks/hooks.json` and stops if the plugin has no `PreCompact` hook. A run never inherits the off switch `COMPACTION_INSTRUCTION`.
- Mode W has no `PreCompact` hook. Before the session starts, the runner writes `configs/claude-md-compact-instruction.md` unchanged as `CLAUDE.md` into the workspace root. The setting source `project` loads it. The guard allows the agent to read it, and the integrity scan and the grader treat it as a workspace file, not as stage material.

The isolation check of mode Z allows `ccb-plain`, `compaction-instruction` and the built-in plugins `cc-plugin-*`, and no MCP server.

### Delivery telemetry of mode Z

The plugin writes no log, so the runner reads what the host recorded. After a manual compaction, Claude Code 2.1.331 writes this user message into the stream and the transcript:

```text
<local-command-stdout>Compacted PreCompact [<command>] completed successfully: <stdout></local-command-stdout>
```

The message has one line for each `PreCompact` hook. A hook without output has the line without the colon and the output. For each compaction, the runner reads that message from the stream of the compaction turn. A segment with the command of the plugin, the status "completed successfully" and a non-empty output is a delivery. The runner keeps the byte count and the sha256 of the trimmed output, never the text.

`telemetry.triggers.precompactStandalone`: `{ calls, deliveries, bytes, sha256s, byTrigger, unobserved, hookRuns }`. `calls` counts the compactions of the run. `unobserved` counts the compactions without a host record of the output.

Claude Code 2.1.331 writes the "Compacted" message only as the output of the `/compact` command. At an automatic compaction the host still runs the hook and gives its output to the summarizer, but it writes the output nowhere: not in the stream, not in the transcript and not in the debug log. So in `v12-auto` each call of mode Z is unobserved, and the runner claims no delivery for it.

In a batch with mode Z, every plain run starts the host with `--debug-file`. The debug log has one line for each hook run, at a manual and at an automatic compaction:

```text
<time> [DEBUG] PreCompact:auto [<command>] completed with status 0
```

The runner keeps only the `PreCompact` lines, in `raw/<run>/a<n>/host-debug-precompact.txt`. `hookRuns`: `{ manual, auto, unknown, nonZeroExit, notCompleted }` counts these lines for the plugin command. A hook run proves that the host ran the command of the plugin at that trigger, with that exit status. It does not prove the output: the log never holds it. `hookRuns` is `null` without a debug log.

The transcript also has a `data-flow-records` entry `HookText`. The host records it one time in a session, when a `PreCompact` hook first prints a non-empty output. It names no hook, holds no output and does not repeat at later compactions, so the runner does not use it.

### Records

- `run.json` `session.standalone` (mode Z): `{ name, version, dir, hooksSha256, text: { bytes, sha256 } }` of the plugin, else `null`. `session.hooks` also lists the plugin hooks, each with `plugin`.
- `run.json` `session.claudeMd` (mode W): `{ written, path, file, bytes, sha256, loaded }`, else `null`. `loaded` is true when an `instructions` attachment of the host transcript lists the workspace `CLAUDE.md`, false when the attachments do not list it, and `null` without a transcript.
- `run.json` `session.instructionFiles` (every run): `[{ path, type, bytes, sha256, loads }]` of the instruction files that the host transcript lists, or `null` without a transcript. The content is never stored.
- `batch.json` `plain.plugins.Z.standalone` and `plain.plugins.W.claudeMd` (file, byte count and sha256).

A suite can name its model (`model`). The flag `--model` overrides it.

| Suite | Tasks | Modes | Repetitions | Comparisons | Batch token limit |
|---|---|---|---|---|---|
| `v12-smoke` | `X12-data-retention` | Z, W | 1 | none | 4 million |
| `v12-main` | 12 tasks of `tasks/v12` | O, Z, W, I | 2 | `Z-O`, `W-O`, `W-Z`, `Z-I` | 110 million |
| `v12-opus` | prefixes A12, D12, W12, X12 (6), model `claude-opus-5-5` | O, Z | 2 | `Z-O` | 40 million |
| `v12-auto` | `A13` with automatic compactions (the settings of `v09-auto`) | O, Z | 2 | `Z-O` | 60 million |
| `v12-rerun` | `A12-mobile-gateway`, `W12-ledger-migration`, `X12-cdn-migration` | O, Z | 2 | `Z-O` | 12 million |

All these suites are plain and isolated. `v12-auto` has the run limits of `v09-auto`. The others have 1 800 s and 120 tool calls.

```powershell
node benchmarks/context-clock/runner/run.mjs --host claude --suite v12-smoke --batch v12-smoke-01 --seed 1201
```

## Work-result tasks

A work-result task checks the files that the agent leaves in the workspace, not answers to questions. Three optional task fields support it. A task without them runs as before. The code is in `worktask.mjs`.

- `workspace.files`: a list of `{ path, content }`. The runner writes these files into the workspace after it creates the workspace and before the intro turn. The runner never removes them. Each path must be relative, must stay inside the workspace and must not be under `.git`. If a file cannot be written, the attempt is `infra_failed` with `workspace_error`.
- `final.questions` empty with a non-empty string `final.prompt`: the final turn sends `final.prompt` unchanged, with the same tool limits as the question turn. The runner parses no answers. `answers.final` is `{}`, `answers.finalParseError` is `null`, and the run is `completed`. Without `final.prompt`, empty questions are still a task error.
- `workspace.collect`: a list of workspace paths, files or folders. Before the runner deletes the workspace, it copies these paths to `results/<batch>/runs/<runId>/workspace/`. It does this for every attempt that created a workspace, and a later attempt replaces the copy of an earlier one.

The copy follows these rules:

- A folder is copied with its files, but without `.git`, `node_modules` and links.
- A file is not copied when its name looks like a secret (`.env`, `*.pem`, `*.key`, `id_rsa`, a name with `secret` or `credential`), when its text looks like a secret (a private key block or an API token), or when it is binary.
- In the text, the workspace, data, work root and home paths become `<workspace>`, `<data>`, `<work-root>` and `<home>`. Other absolute host paths become `<host-path>`.
- The copy holds 1 MB (1 048 576 bytes) at most, counted after the redaction. A file that does not fit is skipped, and the next files are still tried.

A task with `workspace.collect` is a work task. Its stage tools also hold `Write` and `Edit`, so the host grants them without a permission prompt. Without this grant, Claude Code in print mode answers a `Write` call with a permission request that nobody can accept, and the file stays unchanged. In the persistent session mode, the one host process gets these tools with `--allowedTools`. In the resume mode, the stage turns and the final turn get them, and the final turn has the stage turn limit (`stageMaxTurns`). The intro and checkpoint turns still disallow all tools. The benchmark guard hook (`PreToolUse`) still denies each path outside the workspace, for `Write` and `Edit` too. A task without `workspace.collect` keeps its tools.

`run.json` `session.permissions` (every run): `{ workTask, permissionMode, stageAllowedTools, finalAllowedTools, finalMaxTurns, guard }`. `permissionMode` is `default`: the runner sets no `--permission-mode`. `guard` is true when the benchmark guard hook is loaded (plain and overlay modes).

`runs/<runId>/workspace-collect.json` records the copy: `{ attempt, limitBytes, bytes, files: [{ path, bytes, sha256, redacted }], skipped: [{ path, reason }], missing }`. The reasons are `secret_name`, `secret_text`, `binary`, `size_limit`, `link`, `not_a_file` and `outside_workspace`. `run.json` holds no list of the copy.

The grader (`graders/grade.mjs`) and the frozen task schema (`fixtures/schema.mjs`, 5 to 8 final questions) still need final questions. A work-result task needs its own grader.

## Failures, retries and resume

| Status | Cause | Retried |
| --- | --- | --- |
| `completed` | A parsable final answer | no |
| `agent_failed` | No parsable final answer | no |
| `timeout` | A turn ran longer than the turn timeout | up to 2 times |
| `infra_failed` | CLI error, missing session id, workspace error | up to 2 times |
| `infra_failed` with `failure.kind: "rate_limit"` | Rate limit or usage limit | no, see below |
| `limit_exceeded` | A run limit of `configs/limits.json` | no |

- A retry uses a new workspace, a new data folder and a new session. `attempts` in `run.json` keeps one record for each attempt. A run that the host cannot execute has an empty list.
- If a turn hits the turn timeout, the runner kills the process tree (`taskkill /T /F` on Windows).
- In resume mode, a turn can stop at the `--max-turns` limit. The runner does not count that stop as a failure, and the run continues.
- If three runs in a row end with a rate limit, the runner starts no new run. It prints a `STOP` line and exits with code 3. Runs that are already running finish.
- A rate-limit run is not final. If you run the same command again, the runner skips the final runs and runs the others. It rejects a batch name that already holds a different run list.

## Limits

- The agent runs with your user settings of the host CLI. For Claude, these include `~/.claude/CLAUDE.md` and the installed plugins. Record these settings with each batch.
- The Codex adapter passes `-c mcp_servers.context-mode.env_vars=[...]` so that the MCP server receives the mode variables. No live Codex run tested this override or the Codex event names. The Codex stream sample in `tests/runner/fixtures/streams/` is hand-written.
- The three Claude stream samples are trimmed from live haiku turns (Claude Code 2.1.330). `claude-persistent-compact.jsonl` is the compaction turn of a persistent session.
- In `claude -p` mode, Claude Code cancelled many `PostToolUse` hooks. In a live persistent check, all 28 `PostToolUse:Read` hooks were cancelled (14 parallel Read calls, two hooks each). In the first smoke batch, 8 were cancelled and 5 succeeded, and none gave a clock block. Thus the `hook_context` channel can stay empty in benchmark runs. `telemetry.clockHooks.postToolUse` records these counts.
- The mock host tests the runner flow only, not agent behavior. Its synthetic answers are the same in every mode.
- `clock.maxTick` and `clock.stateRevision` count the main agent only. `clock.events` counts all agents.
