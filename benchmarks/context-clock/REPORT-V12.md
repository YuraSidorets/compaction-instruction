# Context Clock v0.12 report: the standalone plugin

Date: 2026-11-26. Plan: `docs/context-clock/PLAN-standalone.md`. Each batch is in `results/<batch>/`, with a `review.json` note.

## What was tested

The product is the plugin `compaction-instruction`, version 0.1.0. It has one `PreCompact` hook. The hook prints one fixed text of 694 bytes, and Claude Code uses that text as instructions for the compaction summary. The plugin needs no Context Mode and no clock.

The arms of this version:

| Arm | Setup |
|---|---|
| O | Plain Claude Code. No text. |
| Z | Plain Claude Code with the real plugin. |
| W | Plain Claude Code with the text in the `CLAUDE.md` of the workspace. No hook. |
| I | Plain Claude Code with the benchmark hook of v0.11, which prints the same text. |

Each session is isolated. It loads its own plugin and four built-in host plugins, and no other plugin or MCP server.

## Summary of the results

| Question | Batch | Result |
|---|---|---|
| Does the plugin help with Haiku and manual compactions? | `v12-main-01` | Yes. Z minus O is +0.316, interval [+0.227, +0.404], 20 pairs, 18 wins, 2 ties, 0 losses. |
| Does the benefit repeat on a task shape that a worker designed without the text? | `v12-indep-01` | Yes. Z minus O is +0.250 over 8 pairs, 7 wins, 1 tie, 0 losses. |
| Does the benefit repeat on the older tasks? | `v12-rerun-01` | Yes. Z minus O is +0.252, interval [+0.056, +0.400], 6 pairs. |
| Is the `CLAUDE.md` text as good as the hook? | `v12-main-01` | No. W minus Z is -0.099, interval [-0.214, -0.010]. The text still helps against the plain host (+0.216). |
| Does the plugin differ from the benchmark hook? | `v12-main-01` | No fault found. Z minus I is +0.017, interval [-0.020, +0.061]. |
| Does the plugin lower the score where no state is needed? | `v12-noharm-01` | No. Z minus O is +0.030, interval [0.000, +0.063], 12 pairs, and 1.9% more tokens. |
| Does Opus 5.5 need the text with manual compactions? | `v12-opus-calib-01`, `v12-hard-calib-01` | No room to measure. The plain baseline is 0.981 and 0.986. |
| Does the plugin help with automatic compactions? | `v12-auto-01`, `-02`, `-03` | Not shown in the final score (0.000 over 8 pairs). The probes are higher (+0.162), with 11.9% more tokens. |
| Does the benefit show in a work result (code with hidden tests)? | `v12-work-01` | No room to measure. Each run scores 1.000 in both arms. |
| Does plain Haiku lose rules that are given only in the first message? | `v12-rules-calib-haiku-01` | No. It kept 24 of 24 rules over 5 compactions. The set cannot show a benefit. |
| Does Opus 5.5 lose state with automatic compactions? | `v12-auto-opus-calib-01` | No. Plain Opus scores 1.000 in 2 runs, with 17 of 17 probes correct. |
| Does the plugin harm Opus 5.5? | `v12-hard-opus-01` | No clear harm to the score (-0.014 over 6 pairs, one wrong answer). The token cost is 5.03%, just above the limit of 5%, so the fixed rule is not met. |

## The main batch

Batch `v12-main-01`: Haiku, 10 new tasks of `tasks/v12`, 2 repetitions, 3 manual compactions for each run, seed 1202. All 80 runs are valid. The batch used 62.3 million tokens.

| Arm | Runs | Mean final score | Perfect runs | Probes correct | Tokens for each run |
|---|---|---|---|---|---|
| O | 20 | 0.653 | 0 | 235 of 300 | 758 555 |
| Z | 20 | 0.969 | 16 | 285 of 300 | 788 493 |
| W | 20 | 0.869 | 12 | 265 of 300 | 785 250 |
| I | 20 | 0.952 | 15 | 292 of 300 | 780 781 |

| Comparison | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|
| Z minus O | +0.316 | [+0.227, +0.404] | 18 / 2 / 0 |
| W minus O | +0.216 | [+0.064, +0.356] | 15 / 2 / 3 |
| W minus Z | -0.099 | [-0.214, -0.010] | 2 / 10 / 8 |
| Z minus I | +0.017 | [-0.020, +0.061] | 3 / 14 / 3 |

- Delivery in arm Z: 60 hook calls and 60 deliveries of 694 bytes for 60 compactions. Each session loaded the plugin.
- Arm W: each of the 20 sessions loaded the `CLAUDE.md` file of 800 bytes. No hook delivered a text.
- Tokens: arm Z used 3.9% more tokens than arm O, and arm W used 3.5% more.
- Two tasks carry the gap between W and Z: `X13-cdn-cutover` (W 0.50, Z 1.00) and `D13-network-segments` (W 0.61, Z 0.89).

The intervals resample tasks, with 10 000 iterations. An interval that contains zero is not evidence that two arms are equal.

## The independent task shape

Batch `v12-indep-01`: 2 tasks of the incident shape, 4 repetitions, seed 1207. The task worker designed the shape from the plan brief and did not read the instruction text. All 16 runs are valid.

- Arm O 0.700 with 0 perfect runs. Arm Z 0.950 with 6 perfect runs.
- Z minus O is +0.250 over 8 pairs, with 7 wins, 1 tie and 0 losses. Both tasks give +0.250.
- Probes: arm O 98 of 124, arm Z 117 of 124.
- Delivery: 24 of 24. Tokens: +0.2%.
- With 2 tasks that have the same difference, the task-level interval is a single point. It gives no information, so this report gives the pair counts only.

## The rerun set

Batch `v12-rerun-01`: the 3 older tasks `A12-mobile-gateway`, `W12-ledger-migration` and `X12-cdn-migration`, 2 repetitions, seed 1211. All 12 runs are valid.

- Arm O 0.681, arm Z 0.933. Z minus O is +0.252, interval [+0.056, +0.400], with 4 wins, 2 ties and 0 losses.
- Probes: arm O 85 of 100, arm Z 99 of 100. Delivery: 18 of 18. Tokens: +2.6%.

## The no-harm set

Batch `v12-noharm-01`: 3 tasks where no answer needs state from before a compaction, 4 repetitions, seed 1208. The tasks have no probes.

- After the regrade: 24 valid runs. Arm O 0.970, arm Z 1.000. Z minus O is +0.030, interval [0.000, +0.063], with 3 wins, 9 ties and 0 losses.
- Tokens: +1.9%. Delivery: 36 of 36.
- The no-harm rule is met: arm Z is not lower than arm O by more than 0.03, and the token cost is below 5%.
- The plain score is near the top on these tasks. The batch can show harm, and it cannot show a benefit.

One run was invalid at first (`W13-late-ledger-cleanup`, arm Z, repetition 3). The integrity scan recorded 14 shell calls with a "path outside the workspace". Each call changes into the own workspace of the agent, written in the Git Bash path form. The guard denied nothing. The analysis worker fixed the grader, with a test. The lead graded the 8 stored v12 batches again, and only this grade changed. Before the regrade, the result was +0.033 over 11 pairs, interval [0.000, +0.083]. No run was made again.

## Opus 5.5

Both batches have arm O only, with the model `claude-opus-5-5`.

| Batch | Tasks | Valid runs | Mean final score | Perfect runs | Probes correct | Tokens |
|---|---|---|---|---|---|---|
| `v12-opus-calib-01` | 6 tasks of `tasks/v09`, 3 compactions | 6 of 6 | 0.981 | 5 | 93 of 93 | 4.7 million |
| `v12-hard-calib-01` | 6 tasks of `tasks/v12-hard`, 12 stages, 5 compactions | 6 of 6 | 0.986 | 5 | 155 of 157 | 7.3 million |

The calibration rule of the plan applies. The baseline is above 0.85 in both sets, so no Opus batch with the text ran. With manual compactions, Opus 5.5 keeps the state on these tasks without the text. A third batch, `v12-auto-opus-calib-01`, has 2 plain Opus runs on the long task with automatic compactions and a window of 100 000 tokens. Both runs score 1.000, with 17 of 17 probes correct and 4 compactions in total. It used 5.6 million tokens. The benchmark gives no evidence that the plugin helps Opus 5.5, because plain Opus loses no state in these conditions.

### Opus 5.5 with the plugin

Batch `v12-hard-opus-01`: arms O and Z, the 6 tasks of `tasks/v12-hard`, 1 repetition, seed 1216. The owner asked for this test of harm.

- All 12 runs completed and are valid and isolated. Each run record names the model `claude-opus-5-5`. The batch used 14.5 million tokens, about 28.22 dollars.
- Mean final score: arm O 0.986 with 5 perfect runs, arm Z 0.972 with 4 perfect runs. Z minus O is -0.014 over 6 pairs, interval [-0.042, 0.000], with 0 wins, 5 ties and 1 loss.
- The pair that lost is `W14-search-and-ledger`: arm O 1.000, arm Z 0.917. That is one wrong answer of 12.
- Probes: arm O 155 of 157, arm Z 154 of 157.
- Delivery: 30 hook calls and 30 deliveries for 30 compactions in arm Z.
- Tokens: arm Z used 1 237 536 tokens for each run, and arm O used 1 178 245. That is 5.03% more.
- Condition 1 of the rule is met: the score difference of -0.014 is inside the limit of -0.03.
- Condition 2 is not met, by a small amount: 5.03% is above the limit of 5%.
- By the fixed rule, the result is "harm not ruled out". The lead does not round the token cost down to meet the rule.
- Reading: the batch shows no clear harm to the score of Opus 5.5 and no benefit. The plugin has a token cost of about 5% on Opus with these tasks.
- Limits: 6 pairs. One wrong answer makes the whole score difference. An interval that ends at zero is not evidence that the arms are equal.

### Real sessions with Opus

- The lead scanned the local Claude Code session records of the owner for a case where Opus lost state after a compaction.
- Scope: 1 515 session files. Benchmark sessions and subagent files are left out. 44 real sessions hold 106 compactions with Opus 5.5 as the model.
- Method: the lead read each human message among the first 6 after each of these compactions, 160 messages in total. A keyword filter for correction words marked 5 of them.
- Three of the 5 are not corrections. The lead traced the other 2 in the session records.
- Case 1, a branch on the wrong base: the agent chose the wrong base before the first compaction. The summary held the correct instruction. This is not a loss by compaction.
- Case 2, a commit with the wrong author and a description: the owner gave that rule for the first time in that message. The 2 later summaries of the session hold the rule, and the later commits follow it.
- Result: the scan found no case where Opus 5.5 lost state after a compaction.
- Limits: the scan finds only a loss that the owner named in a message soon after a compaction. It does not find a loss that nobody saw. 24 of the 44 sessions have no human message after a compaction, because agents ran them.

## Automatic compactions

Three batches use one long task with a compaction window of 100 000 tokens. The host starts each compaction. All 16 runs are valid.

| Batch | Pairs | Final score, Z minus O | Probes, Z minus O | Extra tokens in arm Z |
|---|---|---|---|---|
| `v12-auto-01` | 2 | +0.111 | +0.319 | 1.8% |
| `v12-auto-02` | 2 | -0.222 | -0.035 | 21.6% |
| `v12-auto-03` | 4 | +0.056 | +0.183 | 12.1% |
| Pool | 8 | 0.000, interval [-0.111, +0.111] | +0.162, interval [-0.002, +0.312] | 11.9% |

- Pool, final score: arm O 0.889 and arm Z 0.889, with 2 wins, 4 ties and 2 losses.
- Pool, probes: arm O 207 of 288 (71.9%), arm Z 289 of 326 (88.7%). The probes are higher with the plugin in 7 of 8 pairs.
- Arm Z had 71 compactions against 64 in arm O.
- The lead fixed the pooling rule before the third batch. By that rule, the batches show no benefit of the size 0.05 in the final score.
- The pool has one task. Its intervals resample the 8 pairs and do not cover other tasks.
- Delivery: the host records hold no hook output for an automatic compaction. The debug log of the host shows a plugin hook run with exit code 0 for 54 of 54 compactions in the two later batches. The first batch has no such record. This report claims hook runs there, and it claims no delivery.

## The work result

Batch `v12-work-01`: 3 tasks of `tasks/v12-work` that end in code, 4 repetitions, seed 1209, Haiku. The requirements of one small module change over 8 stages, with 3 manual compactions. The agent writes the module in the final turn, and hidden tests give the score.

- After the regrade: 24 valid runs. Each run passes each hidden test. Z minus O is 0.000 over 12 pairs, with 12 ties.
- Before the regrade: arm O had 10 valid runs and arm Z had 11, with 9 valid pairs. Each valid run scored 1.000.
- Delivery: 36 of 36. Tokens: arm Z used 3.9% fewer tokens.
- By the rule of the plan, the result is "no benefit of that size in the work result". The plain score is at the top, so the batch cannot show a benefit. It is not evidence that the plugin has no effect on work results.
- Three runs were invalid at first. In each one, the agent tried to read the session transcript or to use the memory folder of the host. The guard denied each such call.
- The main grader keeps such a run valid, and the test grader did not. The task worker changed the test grader to use the same rule, with tests. No run was made again.

## The rule-retention set

The lead added this set after the ceiling results above. A public study (arXiv 2610.31778) reports that summaries lose rules that are given only in the first message. The set `tasks/v12-rules` tests that case: 6 code tasks with 12 stages, 5 manual compactions and 4 process rules in the first message. A later stage makes a violation the easy path for each rule. Hidden tests decide each rule.

Batch `v12-rules-calib-haiku-01`: plain Haiku, 6 runs, seed 1214.

- After the regrade: 6 valid runs. The agent kept 24 of 24 rules. The function cases pass in 106 of 108.
- In 3 runs, the agent wrote the rules to a workspace file on its own. In the other 3 runs, it kept each rule without such a file.
- The set is at the ceiling for plain Haiku, so it cannot show a benefit of the plugin. No Opus run and no run with the plugin was made on it.
- Four runs were invalid at first. The integrity scan took written code text and a quote escape for outside paths. The analysis worker fixed the grader, with tests. No run was made again.

## Cost

| Batch | Extra tokens in arm Z against arm O |
|---|---|
| `v12-main-01` | 3.9% |
| `v12-indep-01` | 0.2% |
| `v12-rerun-01` | 2.6% |
| `v12-noharm-01` | 1.9% |
| `v12-work-01` | -3.9% |
| Automatic compactions, pool | 11.9% |
| `v12-hard-opus-01` (Opus 5.5) | 5.03% |

## Limits

- The measured benefit is for one model (Haiku) in one host (Claude Code), on one machine.
- The tasks are generated. They track decisions, values and work status across a session. Other kinds of work are not measured.
- Three of the four task shapes come from the same generator family as the tasks that the text was developed on. The incident shape is the exception, with 2 tasks.
- The comparisons with manual compactions have 6 to 20 pairs. The automatic compaction result has 8 pairs on one task.
- Each Opus baseline has 2 or 6 runs. One batch of 6 pairs used the plugin on Opus.
- The intervals are percentile bootstrap intervals. This report claims no statistical significance beyond them.
- The work-result tasks are too easy. No batch shows the benefit in code that the agent wrote.
- Three attempts to find a harder case (a harder set, code tasks, rules in the first message) ended at the ceiling without the plugin.
- The Codex host is not measured.

## Invalid, failed and changed items

- `v12-noharm-01`: one run was invalid by a fault of the integrity scan and is valid after the grader fix. Both readings are above.
- `v12-work-smoke-01`: the smoke run failed, because the session had no write permission. The runner worker fixed the session setup, and `v12-work-smoke-02` passed.
- `v12-rules-calib-haiku-01`: four runs were invalid by false scan records and are valid after the grader fix.
- No run of a comparison batch was made again, and no run was left out.
- The guard denied one call in each of the arms O, W and Z of the main batch. Each run stayed valid.
- `v12-work-01`: three runs were invalid by a difference between the two graders and are valid after the grader change. Both readings are above. The guard denied 4 calls in arm O and 2 calls in arm Z.

## Token use of this version

| Batch | Runs | Tokens |
|---|---|---|
| `v12-opus-calib-01` | 6 | 4.7 million |
| `v12-smoke-01` | 2 | 1.5 million |
| `v12-auto-01`, `-02`, `-03` | 16 | 47.0 million |
| `v12-main-01` | 80 | 62.3 million |
| `v12-hard-calib-01` | 6 | 7.3 million |
| `v12-indep-01` | 16 | 12.2 million |
| `v12-noharm-01` | 24 | 15.7 million |
| `v12-rerun-01` | 12 | 9.2 million |
| `v12-work-smoke-01`, `-02` | 2 | 1.4 million |
| `v12-work-01` | 24 | 16.5 million |
| `v12-rules-calib-haiku-01` | 6 | 8.9 million |
| `v12-auto-opus-calib-01` | 2 | 5.6 million |
| `v12-hard-opus-01` | 12 | 14.5 million |
