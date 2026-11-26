# Benchmark of the compaction-instruction plugin

This benchmark measures the effect of the plugin in `plugin/` on long tasks in Claude Code. It needs no model API key. It uses the Claude Code CLI that you already use, with your own login.

The report is `REPORT-V12.md`. The plan, with each decision rule and each result in the order of the work, is `docs/context-clock/PLAN-standalone.md`.

## What it compares

| Arm | Setup |
|---|---|
| O | Plain Claude Code. No text. |
| Z | Plain Claude Code with the plugin of `plugin/`. |
| W | Plain Claude Code with the text in the `CLAUDE.md` of the workspace. No hook. |
| I | Plain Claude Code with a hook that the runner builds. It prints the same text. |

Z minus O is the effect of the plugin. Each comparison pairs two runs of the same task and repetition.

## Folders

| Folder | Content |
|---|---|
| `CONTRACT.md` | The rules for the task format, the run record, the grade record and the analysis outputs |
| `tasks/` | The task sets, their generators and the answer keys. The agent never gets a key. |
| `configs/suites.json` | The suites: which tasks, arms and repetitions a batch has |
| `runner/` | The runner and the host adapter for Claude Code |
| `graders/` | The deterministic graders |
| `analysis/` | The paired analysis, the Markdown report and the SVG charts |
| `results/<batch>/` | One folder for each batch, with a `review.json` note |
| `tests/` | The tests of the benchmark code |

## Task sets of the study

| Set | Content | Suite |
|---|---|---|
| `tasks/v12` | 10 tasks, 3 manual compactions | `v12-main` |
| `tasks/v12-indep` | 2 tasks of a shape that was designed without the text | `v12-indep` |
| `tasks/v09` | The older tasks and the long task for automatic compactions | `v12-rerun`, `v12-auto` |
| `tasks/v12-noharm` | 3 tasks where no answer needs state from before a compaction | `v12-noharm` |
| `tasks/v12-hard` | 6 tasks with 12 stages and 5 manual compactions | `v12-hard-calib`, `v12-hard-opus` |
| `tasks/v12-work` | 3 tasks that end in code, with hidden tests | `v12-work` |
| `tasks/v12-rules` | 6 code tasks with rules that are given only in the first message | `v12-rules-calib` |

## Requirements

- Node.js 22 or later.
- Claude Code with plugin support, and a login that can use the model of the batch.
- The runner was used on Windows 11 with Git Bash only. Other systems are not tested.

Run every command from the repository root.

## Procedure

1. Make sure that the benchmark code works. This step makes no model call.

   ```text
   node --test benchmarks/context-clock/tests/
   ```

2. Run a live batch. This example is the main batch: 10 tasks, 4 arms, 2 repetitions, 80 runs.

   ```text
   node benchmarks/context-clock/runner/run.mjs --host claude --batch my-main --suite v12-main --model haiku --concurrency 2 --seed 1
   ```

   If the batch stops, run the same command again. The runner skips each run that has a final record.

3. Grade the batch.

   ```text
   node benchmarks/context-clock/graders/grade.mjs --batch my-main
   ```

   For a batch of `tasks/v12-work` or `tasks/v12-rules`, run the test grader after that.

   ```text
   node benchmarks/context-clock/graders/work-tests.mjs --batch my-main
   ```

4. Write the summary, the report and the charts.

   ```text
   node benchmarks/context-clock/analysis/analyze.mjs --batch my-main
   ```

5. Read `results/my-main/report.md`.

To run fewer arms, add `--modes O,Z`. To use another model, change `--model`. Arm Z loads the plugin from `plugin/`. To use another folder, set the variable `CCB_STANDALONE_PLUGIN`.

The main batch on Haiku used 62 million tokens. Most of them were cache reads.

## What a run does

- The runner makes one isolated workspace and one Claude Code session for each run. The session loads no other plugin and no MCP server of the user.
- Each stage gives the agent new documents. The runner compacts the conversation between stages, or the host compacts by itself in the `v12-auto` suite.
- A guard denies each tool call that names a path outside the workspace.
- After the last stage, the agent answers the questions of the task, or it finishes the code. The grader compares the result with the hidden key or runs the hidden tests.

## Results in the repository

- `results/v12-*` holds each batch of the plugin study. For each run, it has the run record, the grade and the analysis records. The raw session traces are not included.
- `results/v11-full-01` and `results/v11-iso-01` are two earlier batches that the plan cites. `REPORT-V11.md` and `EXPERIMENT-V11.md` describe them.
- The arms A, B, R and M of those earlier batches need a separate project that is not in this repository. The same applies to the older suites in `configs/suites.json`. They cannot run from here.

## Limits of the method

- The tasks are generated. They track decisions, values and work status across a session.
- The samples are small. The intervals are percentile bootstrap intervals over tasks, and the reports claim nothing beyond them.
- The integrity checks read tool calls as text. `graders/README.md` describes what they find and what they do not find.
- The results belong to one host version, one machine and the models of the batches.
