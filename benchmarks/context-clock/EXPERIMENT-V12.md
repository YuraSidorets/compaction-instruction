# Context Clock v0.12 experiment: the instruction text with other Claude models

Status on 2026-11-26: replaced by `docs/context-clock/PLAN-standalone.md`. No batch of this design ran. The model step is now Opus 5.5 with plain arms.

Status: proposed on 2026-11-25. Nothing in this file is frozen, and no run started. The lead owns this file. `CONTRACT.md` and `EXPERIMENT-V09.md` stay valid where this file does not differ.

## Question

With a larger Claude model in the session, does the general instruction to the summarizer keep its benefit?

## Why this question

Each batch up to v0.11 used the model alias `haiku`. A larger model can write a better summary without help. Then the text has less to add. A product text must not depend on one model.

## Models

| Alias for the runner | Order |
|---|---|
| `sonnet` | first |
| `opus` | second, only after the owner saw the result for `sonnet` |

The host resolves each alias. `run.json` records the model name that the host reports, and the report states it.

In Claude Code, the session model also writes the summary. Thus each batch changes the agent and the summarizer together. The experiment does not separate the two.

## Arms and tasks

| Arm | Text at `PreCompact` |
|---|---|
| B | none |
| R | the overlay prints the general text, `configs/precompact-general-instruction.txt` |

The six frozen tasks of part 1 of v0.9, in `tasks/v09/`. Each task has 8 stages and manual compactions after stages 3, 5 and 7.

Context Mode is on in both arms, with the same plugin build, as in v0.9.

## Step 1: calibration for each model

The tasks were calibrated for Haiku, with a baseline between 0.5 and 0.8. A larger model can reach the top of the scale in the baseline. Then the tasks cannot show a benefit.

| Item | Value |
|---|---|
| Batch | `v12-<model>-calib-01` |
| Runs | arm B, 6 tasks, 1 repetition: 6 runs, about 7 million tokens |
| Pass | The mean baseline score is 0.85 or lower, and at most 2 of 6 runs score 1.000 |

If the calibration does not pass, the lead stops and reports. The next step is then a task set with a higher difficulty, which needs the task worker and a new calibration. The calibration result is a finding by itself: the model loses little state on these tasks.

The probe accuracy of the calibration runs is the second pointer. A baseline that answers 98% or more of the probes has no loss to repair.

## Step 2: full batch for each model

| Item | Value |
|---|---|
| Batch | `v12-<model>-full-01` |
| Runs | arms B and R, 6 tasks, 2 repetitions: 24 runs |
| Token limit | 35 million. The estimate is 26 million |
| Run limits | 1800 seconds, 120 tool calls and 3 million tokens for each run |
| Seed | 1210 for `sonnet`, 1220 for `opus` |
| Comparison | R-B |
| Concurrency | two sessions at the same time |

The calibration runs are not a part of the full batch.

## Cost

The token count for each run stays near 1.1 million. A larger model uses more of the subscription limit for each token. If a run stops at a usage limit, the lead stops the batch, reports, and continues later with the runs that did not start. The lead does not work past a limit, and the report counts each stopped run.

## Measurements

- Final score and probe accuracy, with the paired difference R minus B and the bootstrap interval over tasks.
- The same tables for each task shape.
- Summary coverage of the current values and of the earlier values, on the old shape and on the decision records.
- Length of the host summaries.
- Tokens, tool calls, dollars as the host reports them, and duration.
- A table across models: B, R and R minus B for Haiku (from `v09-full-01`), Sonnet and Opus. The table states the host version of each batch.

## What the sample can show

With 12 pairs, the interval is about 0.08 to each side. The batch can show a benefit of 0.15 or more. It cannot show that the text has no effect. A comparison between models uses batches from different days, and the report gives it as a pointer.

## Decision rules, fixed before the run

| Outcome | Reading |
|---|---|
| R minus B is +0.10 or more, with an interval above zero | The benefit holds for this model. |
| R minus B is between -0.05 and +0.10, and the baseline is 0.85 or lower | No clear benefit for this model. The lead examines what the baseline summaries already hold. |
| R minus B is below -0.05 | The text costs score for this model. The product default for this model needs a new decision of the owner. |
| The calibration does not pass | No result for the text. The report states the baseline of the model. |

The report states each number and makes no significance claim.

## Stop rules

- The calibration passes for the model.
- In the first two runs of arm R, the overlay delivered the text in each compaction, and each compaction has the mark of the host.
- No shim error. The guard denied each attempt to leave the workspace.

## Work packages

| Package | Owner | Content |
|---|---|---|
| Suites | lead | `v12-calib` (arm B, 1 repetition) and `v12-full` (arms B and R, 2 repetitions) in `configs/suites.json`. The model comes from the flag `--model`. |
| Analysis | analysis worker | The table across models with the flag `--pool`, with the model name of each batch. Tests. |
| Lead | lead | Calibration, freeze, full batch, `REPORT-V12.md`. |

The runner needs no change, because it already takes the model as a flag and records it.

## Limits that the design already has

- One host. Generated tasks. Manual compactions at about 55 000 tokens.
- The agent and the summarizer change together.
- The tasks were made for Haiku. A pass of the calibration at the upper edge leaves little room for a difference.
- This experiment uses the overlay text, not the product path. The product path has its own acceptance in `EXPERIMENT-V11.md`.

## Not in scope

- Models of other vendors. Codex needs a feasibility study of its own.
- Automatic compactions and a large context.
- A push, a pull request or a release.
