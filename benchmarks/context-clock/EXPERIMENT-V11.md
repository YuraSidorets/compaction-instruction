# Context Clock v0.11 experiment: the text without Context Mode, and the product path

Status: part A and part B are frozen (2026-11-25). The sections "Changes after the first smoke runs" and "Correction after part A" replace the earlier rows where they differ. The lead owns this file. `CONTRACT.md` and `EXPERIMENT-V09.md` stay valid where this file does not differ.

## Questions

1. Part A: does the instruction text give its benefit in plain Claude Code, without Context Mode? And what does Context Mode change by itself?
2. Part B: does the production path of Context Clock v0.3 give the same result as the benchmark overlay?

## Why these questions

In each earlier batch, each arm ran with the same Context Mode build. The comparisons show the effect of the text. They do not show the effect of Context Mode, and they do not show the text without Context Mode. The overlay printed the text, with the clock off. No batch ran the production code.

## Arms

| Arm | Plugin | Clock | Text at `PreCompact` | Part |
|---|---|---|---|---|
| O | none | none | none | A |
| I | none | none | a hook of the benchmark prints the text of arm R | A |
| B | Context Mode | off | none | B, and the reference for part A |
| R | Context Mode | off | the overlay prints the text of arm R | B, and the reference for part A |
| M | Context Mode | on, feedback off | the product hook prints its text | B |

Rules for the plain arms O and I:

- The session loads no Context Mode plugin, no Context Mode hook and no Context Mode tool.
- The workspace guard stays, because it protects the answer keys and the transcripts. It is a `PreToolUse` hook of the benchmark.
- In arm I, one `PreCompact` hook prints the file `configs/precompact-general-instruction.txt` as plain text. It logs one line for each delivery with the trigger kind, the byte count and the hash.
- The task text, the stage prompts, the compactions, the probes and the limits are the same as in the other arms.

## Tasks

The six frozen tasks of part 1 of v0.9, in `tasks/v09/`. No task changes.

## Runs and limits

| Item | Part A | Part B |
|---|---|---|
| Smoke batch | `v11-plain-smoke-01`: arm I, task `X12-data-retention`, 1 run | `v11-smoke-01`: arm M, the same task, 1 run |
| Full batch | `v11-plain-01`: arms O and I, 2 repetitions: 24 runs | `v11-full-01`: arms B, R and M, 2 repetitions: 36 runs |
| Token limit | 35 million. The estimate is 26 million | 50 million. The estimate is 40 million |
| Seed | 1110 | 1111 |
| Run limits | 1800 seconds, 120 tool calls and 3 million tokens for each run | the same |
| Comparisons in the batch | I-O | M-R (primary), M-B, R-B |

Host and model: Claude Code, Haiku, two sessions at the same time. Part B uses a new plugin build with the v0.3 change. Part A uses no plugin.

The owner asked for part A as its own batch. Part A thus has no fresh run of arms B and R. The analysis takes them from the stored batches `v09-full-01` and `v10-full-01` (12 runs of B, 24 runs of R), and from `v11-full-01` after part B.

## Measurements

- Final score and probe accuracy, with the paired differences and the bootstrap interval over tasks.
- The same tables for each task shape.
- Tokens, tool calls, dollars and duration for each run. Context Mode cuts large tool outputs, so the token cost of the plain arms is a result of its own.
- Length of the host summaries.
- Part A, across batches: O against B, and I against R. The table states the host version of each batch.
- Part B: the product delivery record for each compaction, in each arm.

## What the sample can show

In the earlier batches, 12 pairs gave an interval of about 0.08 to each side. The benefit of the text against the baseline was 0.17 to 0.28, so part A can show a benefit of that size. A comparison across batches has no pairs from the same day. Arm R scored 0.914 in one batch and 0.966 in the next. The report gives the comparisons across batches as pointers, with no interval claim.

## Decision rules, fixed before the run

| Outcome | Reading |
|---|---|
| I minus O is +0.10 or more, with an interval above zero | The text works without Context Mode. The benefit does not depend on the plugin. |
| I minus O is below +0.05 | The text needs something that Context Mode supplies. The lead examines the summaries and the session start records. |
| O is within 0.05 of B, and I is within 0.05 of R | Context Mode by itself changes the score little on these tasks. |
| O is more than 0.05 below B | Context Mode by itself keeps state on these tasks. The report states its part. |
| O is more than 0.05 above B | Context Mode by itself costs score on these tasks. The lead examines the cause before any product step. |
| Part B: each compaction of arm M has a delivery with the hash of the text. M is not lower than R by more than 0.05, and M is above B | The product path is accepted. |
| Part B: a delivery is missing, or arms B and R show a product output that is not empty | The product change has a fault. The lead stops and reports. |

The report states each number and makes no significance claim.

## Stop rules before each full batch

- Part A smoke: no Context Mode tool and no Context Mode hook is in the session record. Each compaction has the mark of the host. The hook delivered 694 bytes with the hash of the file in each compaction. The guard works.
- Part B smoke: each compaction has one product delivery with 694 bytes and the hash of the file. No overlay text. No shim error. The tests pass, with the tests for disabled mode.

## Changes after the first smoke runs

Smoke batches of 2026-11-25:

| Batch | Arm | Result |
|---|---|---|
| `v11-plain-smoke-01` | I | Valid. The hook delivered 694 bytes with the hash of the file in 3 of 3 compactions. The session had no Context Mode plugin, hook or MCP server. Score 0.400, probes 13 of 15. |
| `v11-smoke-01` | M | Valid. The product hook delivered 694 bytes with the same hash in 3 of 3 compactions. No overlay text. Score 0.300, probes 9 of 15. |

Both runs used `X12-data-retention`, the task with two low runs in v0.10. One run shows the mechanism and not the score of an arm.

The isolation gap. The new session record shows what each session loaded. Each Context Mode session also loaded two other plugins and three MCP servers from the configuration of the test machine. This applies to v0.8, v0.9, v0.10 and `v11-smoke-01`. The plain arms load none of them. A comparison of the plain arms with stored runs of arms B and R thus mixes two differences.

The owner decided that all arms run in isolated sessions. These rules replace the rows of the section "Runs and limits":

- Isolated session. A Context Mode arm loads only the Context Mode overlay plugin with its hooks and its MCP server. A plain arm loads only the benchmark plugin with the guard. No arm loads a plugin, a hook or an MCP server of the user configuration. A run that shows another plugin or server is an infrastructure failure.
- Part A is batch `v11-iso-01`: arms O, I, B and R, 6 tasks, 2 repetitions: 48 runs. The token limit is 70 million, and the estimate is 52 million. Seed 1110. Comparisons: I-O, R-B, B-O and R-I. All four are paired comparisons inside the batch. The stored runs of v0.9 and v0.10 are not a reference for part A.
- Part A smoke is batch `v11-iso-smoke-01`: one run of arm R in an isolated session. It must show the isolation, the delivery of the overlay text and the mark of the host on each compaction.
- Part B is batch `v11-full-01`: arms B, R, M and Y, in isolated sessions, 48 runs. The token limit is 70 million. Seed 1111. Comparisons: M-R (primary), M-B, R-B, M-Y and Y-B.
- Arm Y has the clock on, the feedback off and the compaction instruction off (`CTX_CLOCK_COMPACT=off`). Arm M lost 6 of 15 probes in its smoke run. Arm M differs from arm R in the path of the text and in the clock. Arm Y separates the two.

Isolated smoke batch `v11-iso-smoke-01`, one run of arm R:

- The session loaded only the Context Mode plugin and its MCP server, with the hooks of the overlay.
- The overlay delivered the text in 3 of 3 compactions, and each compaction has the mark of the host.
- The product hook ran 3 times with the clock off and printed 0 bytes. This is the disabled mode of v0.3 in a live session.
- No shim error. The guard denied 1 call, and the run has no recorded attempt to leave the workspace.
- The run is valid, with score 1.000 and 15 of 15 probes. The tests pass: 651 of 651.

Part A is frozen on 2026-11-25 with these rules. Part B stays proposed.

Added decision rules:

| Outcome | Reading |
|---|---|
| R minus B in isolated sessions is +0.10 or more, with an interval above zero | The earlier results hold without the other plugins. |
| R minus B in isolated sessions is below +0.05 | The earlier benefit depended on the session load. The lead stops and reports before any product step. |
| Y is more than 0.05 below B | The clock by itself costs score. The product change needs a new decision of the owner. |

The decision rules for O against B and for I against R now use the runs of this batch.

## Correction after part A

Batch `v11-iso-01` ran on 2026-11-25. Its report is `REPORT-V11.md`. The run records show an error in this file.

- The table of arms gives "off" for the clock of arms B and R. That is wrong. In the runner, arms B and R set `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`. The clock is on and sends no feedback.
- Each arm except arm M also sets `CTX_CLOCK_COMPACT=off`. Arm B is thus the same configuration as arm Y.
- The note of the isolated smoke batch says that the product hook ran with the clock off. The clock was on, and the compaction instruction was off.
- Arm M differs from arm R only in the path of the text. Both have the clock on.

The rules and the comparisons of part A did not change. The reading of B minus O changed: it measures Context Mode with the silent clock against the plain host.

Change of part B. The owner accepted it on 2026-11-25:

- Batch `v11-full-01` has arms A, B, R and M. Arm A is Context Mode with the clock off (`CTX_CLOCK` not set). Arm Y is removed.
- Comparisons: M-R (primary), M-B, R-B and B-A.
- The rule for arm Y becomes: if B is more than 0.05 below A, the silent clock costs score, and the product change needs a new decision of the owner.

Isolated smoke batch `v11-b-smoke-01`, one run of arm A and one run of arm M on `X12-data-retention`:

- Arm A: `CTX_CLOCK` is not set. The clock recorded 0 events. The product hook ran 3 times and printed 0 bytes. The session got no session start text from the clock. This is the disabled mode in a live session.
- Arm M: the product hook delivered 694 bytes with the hash of the file in 3 of 3 compactions. No overlay text.
- Both sessions loaded only the Context Mode plugin, its MCP server and the built-in plugins of the host.
- Each compaction has the mark of the host. No shim error and no denied call.
- Both runs are valid. Arm A scored 0.900 and arm M 1.000, each with 15 of 15 probes. The tests pass: 651 of 651.

Part B is frozen on 2026-11-25 with arms A, B, R and M, 48 runs, a token limit of 70 million and seed 1111.

## Part C: the silent clock

Added on 2026-11-25, after part B. The owner asked for this batch. Frozen with this text.

Question: does the clock with its feedback off cost score against Context Mode with the clock off?

- Batch `v11-clock-01`, suite `v11-clock`: arms A and B in isolated sessions, the same 6 tasks, 2 repetitions: 24 runs.
- The token limit is 35 million, and the estimate is 20 million. Seed 1112. Comparison: B-A.
- The primary number is B minus A over the valid pairs of this batch. The report also gives the pooled number with the 11 valid pairs of `v11-full-01`.
- The guard gap of part B is not closed. A run with a call that the guard did not deny is invalid, and the lead does not rerun it. The report gives the difference with and without such runs.

Decision rules, fixed before the run. They use the pooled number.

| Outcome | Reading |
|---|---|
| B minus A is -0.05 or less, with an interval below zero | The silent clock costs score. The lead examines the session start text of the clock before any release. |
| B minus A is between -0.05 and +0.05 | The batches show no cost of the silent clock of that size. |
| Each other outcome | The question stays open. The report states the numbers. |

## Work packages

| Package | Owner | Content |
|---|---|---|
| Runner, part A | runner worker | Modes O and I with a session that has no plugin. The guard hook. The `PreCompact` hook of arm I with its log. The suites `v11-plain-smoke` and `v11-plain`. Tests. |
| Runner, part B | runner worker | Mode M, the product delivery record, the suites `v11-smoke` and `v11-full`. Tests. |
| Product | adapter worker | The v0.3 change of `docs/context-clock/v0.3-design.md`. |
| Analysis | analysis worker | Mode names, the table across batches with the flag `--pool`. Tests. |
| Lead | lead | Review of the product diff, merge, smoke batches, freeze, full batches, `REPORT-V11.md`. |

## Limits that the design already has

- One host, one small model, generated tasks, manual compactions.
- Part A compares with stored runs of arms B and R from other days.
- Without Context Mode, the agent reads large tool outputs whole. The tasks are small, so this difference can be small here and larger in real work.
- Arm M runs with the clock feedback off. The clock with its normal feedback is not in this experiment.

## Not in scope

- Automatic compactions.
- A push, a pull request or a release.
