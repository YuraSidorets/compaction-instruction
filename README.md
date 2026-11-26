# compaction-instruction

This repository has two parts:

- `plugin/` is a Claude Code plugin with one hook. Before Claude Code compacts a conversation, the hook tells the summarizer to keep the full working state of the session.
- `benchmarks/context-clock/` is the benchmark that measured the plugin, with its tasks, graders, raw grades and report.

A compaction is the step where Claude Code replaces a long conversation with a summary.

## Short result

The plugin helps the small model Haiku. It gives no measured benefit to Opus 5.5.

| Model | Result |
|---|---|
| Haiku, manual compactions | The final score rises by 0.25 to 0.32 in three task groups. The token cost is between -3.9% and +3.9%. |
| Haiku, automatic compactions | No difference in the final score over 8 pairs on one task, with 11.9% more tokens. |
| Opus 5.5 | The plain model already scores 0.98 to 1.00, so there is nothing to repair. With the plugin, the score is 0.972 against 0.986 over 6 pairs, and the token cost is 5.03% higher. |

If you use Opus 5.5, do not install the plugin. If you use Haiku for long sessions that track decisions, values and work status, the plugin can help.

The full account is in `benchmarks/context-clock/REPORT-V12.md`. Read its section "Limits" before you rely on a number.

## Install the plugin

You need Claude Code with plugin support, and Node.js 18 or later on the `PATH`.

```sh
git clone https://github.com/YuraSidorets/compaction-instruction.git
claude --plugin-dir /path/to/this/repository/plugin
```

To make sure that the hook is loaded, run `/hooks` in the session. The list shows one `PreCompact` entry of the plugin. `plugin/README.md` tells you how to turn the plugin off and how to change the text.

## How the benchmark works

- A task is a long session in stages. Each stage gives the agent new documents, and the tracked state changes: decisions, values, work status.
- The runner compacts the conversation between stages. After the last stage, the agent answers questions about the state.
- A deterministic grader compares each answer with a hidden key. No model grades a run.
- Each comparison pairs a plain session (arm O) with a session that has the plugin (arm Z), on the same task and repetition.
- Each session is isolated. It loads no other plugin and no MCP server of the user.

## Layout

| Path | Content |
|---|---|
| `plugin/` | The plugin, with its own README and tests. |
| `benchmarks/context-clock/REPORT-V12.md` | The report of the plugin study. |
| `docs/context-clock/PLAN-standalone.md` | The plan, with each decision rule and each result in the order of the work. |
| `benchmarks/context-clock/tasks/` | The task sets, their generators and the hidden keys. |
| `benchmarks/context-clock/runner/` | The runner that drives Claude Code. |
| `benchmarks/context-clock/graders/` | The graders. |
| `benchmarks/context-clock/analysis/` | The paired analysis and the batch reports. |
| `benchmarks/context-clock/results/` | For each batch: the run record, the grade and the analysis of each run. |
| `benchmarks/context-clock/tests/` | The tests of the benchmark code. |

## Run the tests

```sh
node --test plugin/test
node --test benchmarks/context-clock/tests
```

The benchmark tests need about 10 minutes.

## Repeat a batch

A live batch starts real Claude Code sessions with your own login. It costs tokens. The main batch of 80 Haiku runs used 62 million tokens.

```sh
node benchmarks/context-clock/runner/run.mjs --host claude --batch my-main-01 --suite v12-main --model haiku --concurrency 2 --seed 1
node benchmarks/context-clock/graders/grade.mjs --batch my-main-01
node benchmarks/context-clock/analysis/analyze.mjs --batch my-main-01
```

- The suites are in `benchmarks/context-clock/configs/suites.json`.
- Arm Z loads the plugin from `plugin/`. To use another folder, set the variable `CCB_STANDALONE_PLUGIN`.
- The runner was used on Windows 11 with Git Bash only. Other systems are not tested.
- `benchmarks/context-clock/runner/README.md` has the details.

## Limits

- The samples are small: 6 to 20 pairs for each comparison. The work is exploratory.
- The tasks are generated. One host (Claude Code) on one machine. Codex is not measured.
- The results belong to the Claude Code version and the models of late 2026. A later version can change its summarizer, and then the results can change.

## License

MIT. See `LICENSE`.
