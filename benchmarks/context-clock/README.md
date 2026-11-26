# Context Clock effectiveness benchmark

Note for this public copy:

- This README was written for the full project. It names reports, designs and result folders of the versions v0.3 to v0.10. Those files are not in this repository.
- This repository holds the plugin study (v0.12) and the files of v0.11 that it cites. Start with `REPORT-V12.md`.
- The arms that need the Context Mode fork cannot run from this repository. Use the arms O, Z and W.
- The top-level `README.md` of the repository lists what is left out.

This benchmark measures the effect of Context Clock v0.2 on long tasks in Claude Code and Codex. It is separate from the product code. It needs no model API key. It uses the host CLI that you already signed in to.

The results of the first experiment are in `REPORT.md`. The results of the placebo experiment (v0.3) are in `REPORT-V03.md`.

The report of the v0.4 experiment (state that survives compaction) is `REPORT-V04.md`. Its design is `EXPERIMENT-V04.md`.

The report of the v0.5 experiment (a cheaper way to save state) is `REPORT-V05.md`. Its design is `EXPERIMENT-V05.md`.

The report of the v0.6 experiment (memory delivery and efficiency) is `REPORT-V06.md`. Its protocol is `EXPERIMENT-V06.md`.

The report of the v0.11 experiment (the text without Context Mode, and the product path, in isolated sessions) is `REPORT-V11.md`. Its design is `EXPERIMENT-V11.md`.

The report of the v0.10 experiment (the general text with a fixed line format) is `REPORT-V10.md`. Its design is `EXPERIMENT-V10.md`.

The report of the v0.9 experiment (a general instruction, new task shapes, automatic compactions) is `REPORT-V09.md`. Its design is `EXPERIMENT-V09.md`.

The report of the v0.8 experiment (the same benefit at a lower cost) is `REPORT-V08.md`. Its design is `EXPERIMENT-V08.md`.

The report of the v0.7 experiment (a save that a product can start) is `REPORT-V07.md`. Its design is `EXPERIMENT-V07.md`.

## What it compares

| Mode | Environment | Meaning |
|---|---|---|
| A | `CTX_CLOCK` not set | Context Mode with no clock (baseline) |
| B | `CTX_CLOCK=1`, `CTX_CLOCK_FEEDBACK=off` | The clock records and sends no automatic feedback |
| C | `CTX_CLOCK=1` | The clock records and sends the automatic snapshot |

C minus B is the effect of the automatic feedback. C minus A is the total effect.

## Folders

| Folder | Content |
|---|---|
| `CONTRACT.md` | The frozen rules: modes, task format, run record, grade record, analysis outputs |
| `tasks/generator/` | The seeded task generator and its reference state machine |
| `tasks/generated/` | 20 task files (5 categories, 4 tasks each) |
| `tasks/keys/` | 20 answer keys. The agent never gets these files. |
| `runner/` | The runner and the host adapters (`claude`, `codex`, `mock`) |
| `graders/` | The deterministic grader |
| `analysis/` | The paired analysis, the Markdown report and the SVG charts |
| `results/<batch>/` | One folder for each batch |
| `tests/` | The tests of the benchmark code |

## Requirements

- Node.js 22 or later.
- The Context Mode build with Context Clock v0.2, installed as the Claude Code plugin and as the Codex MCP server.
- Claude Code 2.1.330 or later for the host `claude`. Codex 0.167.0 or later for the host `codex`.

Run every command from the repository root.

## Procedure

1. Make sure that the benchmark code works. This step makes no model call.

   ```text
   node --test benchmarks/context-clock/tests/
   node benchmarks/context-clock/runner/run.mjs --mock --suite smoke --batch selftest
   ```

2. Run a live smoke batch (2 tasks, 3 modes, 1 repetition).

   ```text
   node benchmarks/context-clock/runner/run.mjs --host claude --batch my-smoke --suite smoke --model haiku
   ```

3. Run the full batch (20 tasks, 3 modes, 2 repetitions, 120 runs).

   ```text
   node benchmarks/context-clock/runner/run.mjs --host claude --batch my-full --suite full --model haiku --concurrency 6 --seed 20261122
   ```

   If the batch stops, run the same command again. The runner skips each run that has a final record.

4. Grade the batch.

   ```text
   node benchmarks/context-clock/graders/grade.mjs --batch my-full
   ```

5. Write the summary, the report and the charts.

   ```text
   node benchmarks/context-clock/analysis/analyze.mjs --batch my-full
   ```

6. Read `results/my-full/report.md`. For each differing case, read the raw stream in `results/my-full/raw/`. Write your classification to `results/my-full/review.json`. Then do step 5 again.

The full batch on Haiku took 2 hours with 6 runs at the same time. One run used 0.77 million tokens on average, and most of them were cache reads.

## Placebo experiment (v0.3)

This experiment compares modes B, C and D. Mode D sets `CCB_FEEDBACK=placebo`: the runner replaces each automatic snapshot with opaque text of the same size. The rules are in `EXPERIMENT-V03.md`. The tasks are in `tasks/v03/`, and the limits are in `configs/limits.json`.

The runner copies the installed plugin to the work root and starts Claude Code with that copy. The product code and the installed plugin do not change.

1. Run the smoke batch (2 tasks, 3 modes, 1 repetition).

   ```text
   node benchmarks/context-clock/runner/run.mjs --host claude --batch my-v03-smoke --suite v03-smoke --model haiku
   ```

2. Run the full batch (10 tasks, 3 modes, 3 repetitions, 90 runs).

   ```text
   node benchmarks/context-clock/runner/run.mjs --host claude --batch my-v03 --suite v03-full --model haiku --concurrency 6 --seed 20261125
   ```

3. Grade and analyze the batch with steps 4 to 6 of the procedure above.

If the batch stops, run the same command again. If the batch stopped at its token budget, add `--raise-budget`. The full batch took 80 minutes and used 72 million tokens.

## What a run does

The runner makes an empty workspace outside the repository and a separate Context Mode data folder. It starts one host process for the run. It sends the task in stages. The agent reads the files of a stage and prints its feeds. The runner deletes that material after the stage. In the profile `compaction`, the runner sends `/compact` at fixed stages and waits for the compaction mark of the host. The last message asks the final questions.

The grader compares each answer with the key. It uses no model. It gives each wrong answer one error category.

## Results in the repository

`results/<batch>/` holds `batch.json`, `runs/<run>/run.json`, `runs/<run>/grade.json`, `summary.json`, `report.md`, `review.json` and `charts/`. Local paths in these files are replaced with tokens such as `<home>` and `<workspace>`.

The raw host streams are in `results/<batch>/raw/`. Git ignores this folder, because the streams hold local paths and the full hook output of every installed plugin.

## Limits of the method

- The agent uses the plugins and the global instructions of the local user account. They are the same in every mode.
- The answer check is exact. The questions ask for identifiers in a fixed format.
- If the agent reads a path outside the workspace, the run is invalid. The report lists these runs.
- Codex has no compaction command in `codex exec`, so the Codex host runs only the profile `long`.
- Codex passes only the variables that its configuration names to the MCP server. Mode B on Codex needs `CTX_CLOCK_FEEDBACK` in that list.
