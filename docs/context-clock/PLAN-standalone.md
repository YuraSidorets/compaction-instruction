# Plan: the compaction instruction as its own product, with stronger proof

Status: proposed on 2026-11-25. Changed on 2026-11-26, in two steps. The owner replaced the Sonnet steps with Opus 5.5. The owner then accepted five changes from a review of the plan (section "Changes of 2026-11-26"). No step of the plan started.

## How the lead read the request

The owner said: "since we have the result without context-mode and clock let's strip it".

The lead reads this as two things:

1. The product has no Context Mode, no clock, no MCP server and no database. It is the instruction text, with the smallest delivery path that works.
2. The further proof runs in plain Claude Code. Context Mode arms are no longer in the batches.

## What the evidence supports now

| Finding | Evidence |
|---|---|
| The text at `PreCompact` keeps working state across compactions | +0.196 in the plain host. +0.232 and +0.216 with Context Mode. Each interval is above zero |
| The text needs no Context Mode and no other plugin | Arm I scored 0.983, arm R 0.950, in the same batch |
| Context Mode by itself and the silent clock give no measured benefit for keeping state | Arm B was below its reference in three batches. Each interval contains zero |

Source: `benchmarks/context-clock/REPORT-V11.md`.

The third finding is about keeping state only. The tasks had small tool outputs. No batch tested the main function of Context Mode, which is to cut large outputs.

## The weak parts

| Number | Weak part | Why it matters |
|---|---|---|
| W1 | One model: Haiku | A larger model can keep state without the text. Then the product gives little |
| W2 | Manual compactions only, in isolated sessions | Real sessions compact automatically, at a high fill level |
| W3 | Six tasks, 12 pairs for each comparison | One run moves a result. `X12-data-retention` gives low single runs |
| W4 | Generated tasks with questions | No task ends in a work result, for example code that passes tests |
| W5 | No test for harm | No batch measured a session that needs no state |
| W6 | The plain arm I uses a hook of the benchmark | No run used the thing that a user installs |
| W7 | Guard gap for files in the work root | One run of 192 was invalid. The content of the file is not examined |
| W8 | Wrong arm description in older reports | Arm B had the clock on. The reports of v0.8 to v0.10 do not say so |
| W9 | One host | No result for Codex. Its compaction has no path for a hook text |
| W10 | A simpler delivery path is not tested | Claude Code can take summarizer instructions from `CLAUDE.md`. If that works equally well, the product is a paragraph and not a plugin |
| W11 | A measured cost has no rule | With automatic compactions in v0.9, the arm with the text compacted more often and used 37.6% more tokens |
| W12 | One author | The lead wrote the tasks, the graders and the text |
| W13 | One host version | Claude Code 2.1.331 has its own summarizer prompt. A later version can change the result |

## Arms

| Arm | Session | Delivery of the text |
|---|---|---|
| O | plain Claude Code | none |
| I | plain Claude Code | the `PreCompact` hook of the benchmark |
| S | plain Claude Code | the standalone plugin, loaded as a plugin |
| C | plain Claude Code | the same text in the `CLAUDE.md` of the workspace, as a section with compaction instructions. No hook |

Each session is isolated. Arm C and arm S get the same 694 bytes of text.

## Phase 0: cleanup and facts, no full batch

| Step | Content | Done when |
|---|---|---|
| 0.1 | Examine the file that the invalid run of `v11-full-01` touched | The report states what the file held and how the agent reached it |
| 0.2 | Close the guard gap for the work root. Add a test | The test fails without the fix and passes with it. All tests pass |
| 0.3 | Add a correction note to the reports of v0.8, v0.9 and v0.10: arm B has the clock on, with feedback off | Each report has the note. The numbers do not change |
| 0.4 | Mark `EXPERIMENT-V12.md` as replaced by this plan | The file points to this plan |
| 0.5 | Read the current Claude Code documentation on compaction instructions in `CLAUDE.md` | The plan states the documented form, with the source. If the documentation has no such form, arm C uses a plain section and the report says so |
| 0.6 | Opus 5.5 calibration: arm O, 6 tasks, 1 repetition | 6 runs are graded. The lead reports the baseline score |

Covers W7 and W8. Step 0.6 uses about 5 million Opus tokens, and the lead asks the owner before it starts.

Step 0.6 is first among the runs, because its result decides the worth of the later steps:

| Outcome of step 0.6 | Consequence |
|---|---|
| The Opus baseline is 0.85 or lower | The six tasks can show a benefit on Opus. Step 2.3 uses them |
| The Opus baseline is above 0.85 | The tasks are too easy for Opus. Step 2.3 uses the harder tasks of phase 1b. The lead makes no statement about Opus from the easy tasks |

## Results of phase 0 (2026-11-26)

Arm letters. The runner already uses the letters S and C for older arms. In the runner, the results and the reports, arm S of this plan is arm Z, and arm C of this plan is arm W.

Step 0.1, the invalid run of `v11-full-01`:

- The agent sent one shell call that wrote the output of a feed to a new file in the work root, outside its workspace. The call names that path three times.
- The guard denied the call. The agent then repeated the command inside its workspace.
- The file was a temporary copy that the agent wanted to make. It held no answer key and no material of another run, and it was never written.
- The guard has no gap. The grader has a fault: it did not match the three path mentions of one denied call with the one denial, and it marked the run as invalid.
- Step 0.2 is thus a fix of the grader, with a test. The lead then grades `v11-full-01` again and reports the numbers before and after the fix.

Step 0.5, the documentation of Claude Code (pages `memory`, `hooks` and `plugins/manifest-reference` on code.claude.com, read on 2026-11-26):

- The hooks page says that Claude Code uses the stdout of a `PreCompact` hook as instructions for the compaction summary, with a limit of 10 000 characters for each hook.
- The memory page, as far as it was read, describes no section of `CLAUDE.md` for compaction instructions. It says that the `CLAUDE.md` of the project root is read again after a compaction.
- Arm W thus uses a plain section with the heading "Compact instructions" and the same text. The file is `configs/claude-md-compact-instruction.md`. This path is not a documented feature, and the report says so.

Decisions that the lead made for the owner, under the standing approval of 2026-11-26:

- D1: the reading stays as written.
- D2: the plugin lives in the folder `compaction-instruction`, next to the fork, as its own local repository.
- D3: the v0.3 change in the fork stays as it is.
- D4: step 2.1 uses new task seeds.
- D5 (license) stays open. The lead does not decide it.

Step 0.6, the Opus 5.5 calibration (batch `v12-opus-calib-01`, arm O, 6 runs, model `claude-opus-5-5`):

- All 6 runs are valid. The mean score is 0.981. Five runs scored 1.000, and one scored 0.889.
- The probes after the compactions are 93 of 93 correct.
- The batch used about 4.7 million tokens. The host reports about 8.34 dollars, which is about 1.39 dollars for each run.
- The rule of the plan applies: the baseline is above 0.85, so the six tasks are too easy for Opus. Step 2.3 does not run on them.
- The lead makes no statement about the text on Opus from this batch. One true statement follows: on tasks of this size, Opus 5.5 keeps the state without the text.
- The task worker builds a harder set (`tasks/v12-hard`: 12 stages, 5 compactions, about twice the tracked items). A second calibration of 6 runs follows. If Opus is above 0.85 there too, the report states that result, and step 2.3 does not run.

Step 0.2 and the smoke runs of phase 1 (2026-11-26):

- The grader fix is merged. The regrade made the one invalid run of `v11-full-01` valid. `REPORT-V11.md` has the numbers before and after.
- The plugin is built, with 6 passing tests. The runner has the arms Z and W, and the tests pass: 668 of 668.
- Smoke batch `v12-smoke-01`, both runs valid and isolated, on `X12-data-retention`:
  - Arm Z: the session loaded the plugin `compaction-instruction`. Each of the 3 compactions shows one delivery of 694 bytes with the measured hash. Score 1.000, probes 15 of 15.
  - Arm W: the runner wrote `CLAUDE.md` (800 bytes) and the session loaded it. No hook delivered a text. Score 0.900, probes 15 of 15.

Step 2.4, automatic compactions (batch `v12-auto-01`, seed 1204, arms O and Z, the long task, 2 repetitions). It ran before step 2.1, because the new tasks were not ready:

| Measure | O, run 1 | O, run 2 | Z, run 1 | Z, run 2 |
|---|---|---|---|---|
| Valid | yes | yes | yes | yes |
| Automatic compactions | 8 | 8 | 8 | 9 |
| Final score | 0.778 | 0.778 | 0.778 | 1.000 |
| Tokens | 2 778 461 | 2 777 746 | 2 796 979 | 2 857 205 |

- Probes after the compactions: arm O 41 of 72 (56.9%), arm Z 69 of 77 (89.6%). The paired difference is +0.319 over 2 pairs.
- Final score: Z minus O is +0.111 over 2 pairs, with one win and one tie.
- Cost: arm Z used 1.8% more tokens, and one of its runs had one more compaction. The limit of 20% in the cost rule is not reached. The cost of 37.6% in v0.9 did not repeat in the plain host.
- Open point: the delivery of the plugin text is not observed in this batch. The host records of an automatic compaction do not hold the output of the hook, and the plugin writes no log. The runner counts 8 and 9 hook calls as "unobserved". The probe result fits a delivery, and it is not a direct record. The runner worker looks for a direct record.
- The benefit rule of step 2.4 is met in the numbers (+0.319 in the probes). The lead does not call the step complete before the delivery has a direct record.
- The batch has 2 pairs. It gives no interval.

Change of step 2.1 (2026-11-26, decision of the lead under the standing approval):

- Batch `v12-main-01` uses the 10 new tasks of `tasks/v12` (2 of kind A, 2 of kind D, 3 work logs, 3 decision records), 2 repetitions, arms O, Z, W and I: 80 runs. Seed 1202. Each comparison has 20 pairs.
- The tasks were frozen before any live run on them. No run selected a seed.
- The two tasks of the independent shape are not built yet. They get their own batch with arms O and Z (step 2.1b).
- The rules of step 2.1 stay as written.

Step 2.1, the main batch (`v12-main-01`, seed 1202, Haiku, 10 new tasks, 2 repetitions, 3 manual compactions for each run):

- All 80 runs completed and all 80 are valid and isolated. No run was made again. The batch used 62.3 million tokens, about 4.11 dollars.

| Arm | Runs | Mean final score | Perfect runs | Probes correct | Tokens for each run |
|---|---|---|---|---|---|
| O, plain host | 20 | 0.653 | 0 | 235 of 300 | 758 555 |
| Z, the plugin | 20 | 0.969 | 16 | 285 of 300 | 788 493 |
| W, text in `CLAUDE.md` | 20 | 0.869 | 12 | 265 of 300 | 785 250 |
| I, benchmark hook | 20 | 0.952 | 15 | 292 of 300 | 780 781 |

| Comparison | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|
| Z minus O | +0.316 | [+0.227, +0.404] | 18 / 2 / 0 |
| W minus O | +0.216 | [+0.064, +0.356] | 15 / 2 / 3 |
| W minus Z | -0.099 | [-0.214, -0.010] | 2 / 10 / 8 |
| Z minus I | +0.017 | [-0.020, +0.061] | 3 / 14 / 3 |

- Delivery, arm Z: each of the 20 sessions loaded the plugin `compaction-instruction`. The records show 60 hook calls and 60 deliveries of 694 bytes for 60 compactions, with 0 unobserved.
- Delivery, arm I: 60 deliveries of the same text from the benchmark hook.
- Arm W: the runner wrote `CLAUDE.md` (800 bytes) in each of the 20 runs, and each session loaded it. No hook delivered a text in arms W and O.
- The guard denied one call in each of the arms O, W and Z. The grader matched each denial, so the runs stay valid.
- Tokens: arm Z used 3.9% more tokens than arm O, and arm W used 3.5% more.

The fixed rules give these results:

- Benefit rule: Z minus O is +0.316 and the interval is above zero. The plugin helps on these tasks with Haiku. The plugin won or tied in each of the 20 pairs.
- Delivery path rule: W is more than 0.05 below Z (-0.099, interval below zero). The hook is the path. The README recommends the plugin and not the `CLAUDE.md` text.
- The `CLAUDE.md` text still gives a benefit against the plain host (+0.216), but with 3 losses. Two tasks carry the gap to the plugin: `X13-cdn-cutover` (W 0.50, Z 1.00) and `D13-network-segments` (W 0.61, Z 0.89).
- Plugin fault rule: Z is not below I (+0.017). The plugin has no fault. The interval contains zero, and that is not evidence that the two are equal.

Limits: one model (Haiku), one host version, one family of generated tasks, manual compactions, 20 pairs for each comparison.

Step 2.3, Opus 5.5 on the harder set (batch `v12-hard-calib-01`, seed 1213, arm O, model `claude-opus-5-5`, 6 tasks of `tasks/v12-hard` with 12 stages and 5 manual compactions):

- The lead froze the set before the run. No run selected a seed.
- All 6 runs completed and are valid. The mean final score is 0.986, with 5 perfect runs. The probes are correct in 155 of 157 cases.
- The batch used 7.3 million tokens, about 13.77 dollars.
- The calibration rule applies: the baseline is above 0.85, so no Opus batch with the text runs on these tasks. A batch of that kind cannot show a benefit, because the score has no room to rise.
- Result for the README: with manual compactions, Opus 5.5 keeps the state on these tasks without the text, also with 12 stages and 5 compactions. The measured benefit is for Haiku.
- Open point: Opus under automatic compactions with a small window is not measured.

Step 2.4, second batch (`v12-auto-02`, seed 1205, same suite and task as `v12-auto-01`). It ran to get a direct record of the hook runs. It does not replace the first batch.

| Measure | O, run 1 | O, run 2 | Z, run 1 | Z, run 2 |
|---|---|---|---|---|
| Valid | yes | yes | yes | yes |
| Automatic compactions | 8 | 8 | 9 | 9 |
| Final score | 1.000 | 0.889 | 0.778 | 0.667 |
| Probes correct | 34 of 36 | 22 of 36 | 25 of 39 | 38 of 45 |
| Tokens | 2 775 686 | 2 762 443 | 3 828 598 | 2 907 924 |

- Hook runs: the debug log of the host shows 9 runs of the plugin hook in each run of arm Z, each with the trigger "auto" and exit code 0. That is 18 hook runs for 18 compactions. The host records still hold no output of the hook, so the runner counts no delivery.
- Final score: Z minus O is -0.222 over 2 pairs, with two losses. The first batch gave +0.111.
- Probes: the paired difference is -0.035. The first batch gave +0.319.
- Tokens: arm Z used 21.6% more tokens. The first batch gave 1.8%.
- The second batch does not repeat the first. Over the 4 pairs of both batches, the final score difference is -0.056, the probe difference is +0.142, and arm Z used 11.7% more tokens.
- The two batches have one task and 4 pairs. They do not show a benefit of the plugin with automatic compactions, and they do not exclude one.

Third batch, rule fixed before the run (`v12-auto-03`, seed 1206, same suite, 4 repetitions, 8 runs):

- The lead pools the 8 pairs of the three batches. No batch is left out.
- If the pooled final score difference is +0.10 or more, and the pooled probe difference is +0.10 or more, the result is "helps with automatic compactions on this task".
- If the pooled final score difference is below +0.05, the result is "no benefit of that size is shown with automatic compactions". The README says so.
- In each other case, the result stays open, and the README says that.
- If arm Z uses over 20% more tokens in the pool, the README states the cost.
- The pool has one task. The interval comes from the pairs and does not cover other tasks.

Step 2.4, third batch and the pooled result (`v12-auto-03`, seed 1206, 4 repetitions):

- All 8 runs completed and are valid. The batch used 23.5 million tokens.
- Final score: arm O 0.889, 0.778, 1.000, 1.000. Arm Z 0.889, 1.000, 1.000, 1.000. Z minus O is +0.056, with 1 win and 3 ties.
- Probes: arm O 110 of 144, arm Z 157 of 165. The paired difference is +0.183.
- Hook runs: the debug log shows a plugin hook run with the trigger "auto" and exit code 0 for 36 of 36 compactions of arm Z. No hook output is recorded.

Pool of the three batches, 8 pairs, one task, all runs valid:

| Measure | Arm O | Arm Z | Z minus O, paired | 95% interval over the pairs |
|---|---|---|---|---|
| Mean final score | 0.889 | 0.889 | 0.000 | [-0.111, +0.111] |
| Probes correct | 207 of 288 (71.9%) | 289 of 326 (88.7%) | +0.162 | [-0.002, +0.312] |
| Automatic compactions | 64 | 71 | | |
| Tokens | | | +11.9% | |

- Win / tie / loss in the final score: 2 / 4 / 2.
- Rule result: the pooled final score difference is below +0.05. The batches show no benefit of that size in the final score with automatic compactions on this task. The README says so.
- The probes after the compactions are higher with the plugin in 7 of 8 pairs. The interval touches zero, so the lead reports a probe difference and claims no proven benefit.
- Cost: arm Z used 11.9% more tokens and had 7 more compactions. The limit of 20% is not reached in the pool. One run used 38% more tokens than the arm O mean.
- Delivery: a hook run has a direct record for 54 of 54 compactions in the two later batches. The output of the hook has no record with automatic compactions, so the lead claims no delivery there.
- An interval that contains zero is not evidence that the plugin has no effect.

Steps 2.1b and 2.5, design fixed before the runs (2026-11-26):

- Step 2.1b, batch `v12-indep-01`: the 2 tasks of the incident shape in `tasks/v12-indep`, arms O and Z, 4 repetitions, 16 runs, seed 1207, Haiku. The task worker designed the shape and did not read the instruction text. The benefit rule of step 2.1 applies to the 8 pairs.
- Step 2.5, batch `v12-noharm-01`: the 3 tasks of `tasks/v12-noharm`, arms O and Z, 4 repetitions, 24 runs, seed 1208, Haiku. No answer of these tasks needs state from before a compaction. The no-harm rule applies to the 12 pairs: arm Z is not lower than arm O by more than 0.03, and arm Z uses at most 5% more tokens.
- The lead froze both sets before any live run on them.

Step 2.1b, the independent task shape (batch `v12-indep-01`, seed 1207, Haiku, 2 incident tasks, 4 repetitions, 3 manual compactions):

- All 16 runs completed and are valid and isolated. The batch used 12.2 million tokens, about 0.75 dollars.

| Arm | Runs | Mean final score | Perfect runs | Probes correct | Tokens for each run |
|---|---|---|---|---|---|
| O, plain host | 8 | 0.700 | 0 | 98 of 124 | 762 503 |
| Z, the plugin | 8 | 0.950 | 6 | 117 of 124 | 764 382 |

- Z minus O is +0.250 over 8 pairs, with 7 wins, 1 tie and 0 losses. Both tasks give +0.250.
- The probe difference is +0.153.
- The analysis resamples tasks. With 2 tasks that have the same difference, its interval is a single point and gives no information. The lead reports the pair counts and no interval.
- Delivery: 24 hook calls and 24 deliveries for 24 compactions in arm Z, and each session loaded the plugin.
- Tokens: arm Z used 0.2% more tokens.
- Rule result: the difference is above +0.10 and no pair is a loss. The benefit repeats on a task shape that the task worker designed without the instruction text.
- Limit: 2 tasks of one new shape, one model.

Step 2.5, the no-harm set (batch `v12-noharm-01`, seed 1208, Haiku, 3 tasks, 4 repetitions, 3 manual compactions, no probes):

- All 24 runs completed. 23 are valid and 1 is invalid. The batch used 15.7 million tokens, about 1.09 dollars.

| Arm | Runs | Valid | Mean final score over valid runs | Perfect runs | Tokens for each run |
|---|---|---|---|---|---|
| O, plain host | 12 | 12 | 0.970 | 9 | 649 512 |
| Z, the plugin | 12 | 11 | 1.000 | 11 | 661 792 |

- Z minus O is +0.033 over the 11 valid pairs, interval [0.000, +0.083], with 3 wins, 8 ties and 0 losses.
- Tokens: arm Z used 1.9% more tokens.
- Delivery: 36 hook calls and 36 deliveries for 36 compactions in arm Z.
- Rule result: arm Z is not lower than arm O, and the token cost is below 5%. The no-harm rule is met on these tasks.
- The invalid run is `W13-late-ledger-cleanup`, arm Z, repetition 3. The integrity scan recorded 14 shell calls with a "path outside the workspace". The raw records show that each call changes into the own workspace of the agent, written in the Git Bash path form. The guard denied nothing, and no outside path is in the calls. The lead reads this as a fault of the scan and not as a fault of the run. The analysis worker examines it. Until a fix and a regrade, the run stays invalid and outside the scores, and its pair is dropped.
- Limit: the plain score is near the top on these tasks, so the batch can show harm but not a benefit.

Step 2.6, design fixed before the runs (2026-11-26):

- The set `tasks/v12-work` has 3 tasks that end in code. The requirements of one small module change over 8 stages, with manual compactions after stages 3, 5 and 7. In the final turn, the agent writes the module. Hidden tests give the score: passed cases divided by all cases.
- The lead froze the set before any live run on it.
- Smoke batch `v12-work-smoke-01`: one run of arm Z, to make sure that the new runner path and the test grader work. It is not part of a comparison.
- Batch `v12-work-01`: arms O and Z, 3 tasks, 4 repetitions, 24 runs, seed 1209, Haiku. The primary measure is the test score.
- Rule: if Z minus O is +0.10 or more over the 12 pairs, with the interval above zero, the result is "the benefit shows in a work result". If the difference is below +0.05, the result is "no benefit of that size in the work result". Each other case stays open.
- The grader runs code that the agent wrote. It runs in a child process with a timeout, with reads limited to the collected folder, and with no write, process or network permission.

Step 2.6, first smoke (`v12-work-smoke-01`, one run of arm Z on `K13-retry-policy`):

- The smoke failed, and it found a runner fault before a batch ran. The run completed with 3 compactions and 3 plugin deliveries. The runner collected the module folder.
- In the final turn, the host denied the Write tool call two times, because the session has no write permission. The stub stayed, and the test score is 0 of 16.
- The score says nothing about the plugin. The runner worker changes the session permissions for work tasks. A second smoke follows.

Step 2.7, the rerun set (batch `v12-rerun-01`, seed 1211): arms O and Z on the 3 tasks `A12-mobile-gateway`, `W12-ledger-migration` and `X12-cdn-migration` of `tasks/v09`, 2 repetitions, 12 runs. These tasks ran in v0.9 to v0.11 with other seeds of the run order. The batch repeats the comparison with the real plugin on the older tasks.

Step 2.7, result of the rerun set (`v12-rerun-01`):

- All 12 runs completed and are valid and isolated. The batch used 9.2 million tokens, about 0.59 dollars.
- Mean final score: arm O 0.681, arm Z 0.933. Z minus O is +0.252 over 6 pairs, interval [+0.056, +0.400], with 4 wins, 2 ties and 0 losses.
- Probes: arm O 85 of 100, arm Z 99 of 100.
- Delivery: 18 hook calls and 18 deliveries for 18 compactions in arm Z.
- Tokens: arm Z used 2.6% more tokens.
- For each task: `A12-mobile-gateway` O 0.944 and Z 1.000, `W12-ledger-migration` O 0.600 and Z 1.000, `X12-cdn-migration` O 0.500 and Z 0.800.
- The benefit of the earlier versions repeats on the older tasks with the real plugin. The interval over 3 tasks is wide.

Regrade after the fix of the integrity scan (2026-11-26):

- The analysis worker fixed the grader. A shell call that names the own workspace of the agent in the Git Bash path form is no longer an integrity record. An outside path in that form stays a record. A test covers both cases.
- The lead graded the 8 stored v12 batches again. One grade changed: the invalid run of `v12-noharm-01` is now valid, with a score of 1.000. No run was made again.
- `v12-noharm-01` after the regrade: 24 valid runs of 24. Arm O 0.970, arm Z 1.000. Z minus O is +0.030 over 12 pairs, interval [0.000, +0.063], with 3 wins, 9 ties and 0 losses. Before the regrade: +0.033 over 11 pairs, interval [0.000, +0.083].
- The no-harm rule is met before and after the regrade.

Step 2.6, second smoke (`v12-work-smoke-02`, one run of arm Z on `K13-retry-policy`, after the permission fix of the runner):

- The run completed and is valid. The agent wrote the module, and the hidden tests pass in 16 of 16 cases. The run shows 3 compactions and 3 plugin deliveries.
- For a work task, the session now allows the Write and Edit tools. The guard still denies each path outside the workspace. The run record holds the permission setting.
- The work-result path is ready for the batch `v12-work-01`.

Step 2.6, result of the work-result batch (`v12-work-01`, seed 1209, Haiku, arms O and Z, 3 tasks, 4 repetitions):

- All 24 runs completed. The batch used 16.5 million tokens, about 0.80 dollars.
- After the regrade: 24 valid runs. Each run passes each hidden test, so each arm has a mean score of 1.000. Z minus O is 0.000 over 12 pairs, with 0 wins, 12 ties and 0 losses.
- Before the regrade: arm O had 10 valid runs and arm Z had 11. Each valid run scored 1.000, with 9 valid pairs and a difference of 0.000.
- Delivery: 36 hook calls and 36 deliveries for 36 compactions in arm Z. Tokens: arm Z used 3.9% fewer tokens than arm O.
- By the rule, the result is "no benefit of that size in the work result". The plain score is at the top, so the batch has no room to show a benefit. It is not evidence that the plugin has no effect on work results.
- Three runs were invalid before the regrade: `K13-shipping-quote` arm O repetitions 1 and 4, and `K13-retry-policy` arm Z repetition 4. In each run, the agent tried to read the session transcript or to use the memory folder of the host, outside the workspace. The guard denied each such call.
- If the guard denied each outside attempt, the main grader keeps the run valid (the rule of v0.8). The test grader did not use that rule. The task worker changed the test grader to use the same function, with tests. No run was made again.
- The guard denied 4 calls in arm O and 2 calls in arm Z in this batch.
- Likely cause of the ceiling: the task gives the latest requirements again in later stages, and the module is small. Step 2.8 addresses that weak part.

Step 2.8, rule-retention tasks, design fixed before the runs (2026-11-26):

Why this step exists:

- Plain Opus 5.5 is at the ceiling on `tasks/v09` (0.981) and on `tasks/v12-hard` (0.986). The work batch `v12-work-01` is at the ceiling in both arms with Haiku.
- A public study (arXiv 2610.31778) reports one cause. If the goal and the progress are on disk, the agent reads them again after a compaction.
- The same study reports that rules given only in the first message are lost from the summaries. It reports that loss for Claude Opus 4.6 also, at a lower rate than for other models.
- The lead read that study through a fetch summary. Its numbers are a reason for this step, and they are not a result of this benchmark.

The task set `tasks/v12-rules`:

- The set has 6 tasks. The task ids start with `L13-`. The task shape name is `rules`.
- Each task has a small code workspace and 12 stages. The agent changes the code in each stage.
- The first message gives 4 process rules. Examples: "never edit `config/legacy.json`", "add no dependency", "keep each public function name", "write no network call".
- The rules are in no workspace file and in no later message. No stage repeats a rule.
- For each rule, a stage after the third compaction makes a violation the easy path. The stage does not ask for a violation, and a correct solution without a violation exists.
- Manual compactions come after stages 2, 4, 6, 8 and 10.
- The task worker builds the set from this brief and does not read the instruction text of the plugin.
- The lead freezes the set before any live run on it.

Grading:

- Hidden tests run on the collected workspace, in the sandbox of `graders/work-tests.mjs`. No model grades a run.
- The primary measure is the rule score: kept rules divided by all rules. One hidden test group decides each rule.
- The secondary measure is the function score: passed function cases divided by all function cases.
- If the function score of a run is below 0.5, the report lists the run as "work not done". The run stays in the primary analysis.
- If the agent writes the rules to a workspace file on its own, the run stays valid. The grader records that fact, and the report gives the count for each arm.

Batches and rules:

- Batch `v12-rules-calib-haiku-01`: arm O, Haiku, 6 runs. It makes sure that the tasks can be done and that the graders work. Cost: below 1 dollar.
- Batch `v12-rules-calib-opus-01`: arm O, `claude-opus-5-5`, 6 runs. Cost: about 14 dollars, by the cost of `v12-hard-calib-01`.
- Calibration rule, as in step 2.3: if the Opus rule score is above 0.85, no Opus batch with the plugin runs on this set with manual compactions.
- If the Opus rule score is 0.85 or lower, the batch `v12-rules-opus-01` is the next step: arms O and Z, 6 tasks, 2 repetitions, 24 runs. Cost: about 55 dollars. The owner approves that batch before it starts.
- The benefit rule for that batch uses the rule score of Z minus O.
- If the difference is +0.10 or more, with the interval above zero, the result is "the plugin helps Opus keep rules".
- If the difference is below +0.05, the result is "no benefit of that size". Each other case stays open.
- If the function score of the Haiku calibration is below 0.5 on average, the tasks are too hard to do. The task worker then changes the set before the Opus calibration, and the lead freezes it again.
- The Haiku calibration is not a comparison. A Haiku batch with arms O and Z on this set is a later decision of the owner.

Limits known before the runs:

- The lead chose this task type after the ceiling results. The report states that order.
- A rule that the agent breaks is a behavior result. It does not show which text the summary held.
- If Opus is at the ceiling again, the open case is automatic compactions with a small window. That case needs its own design.

Step 2.8, result of the Haiku calibration (`v12-rules-calib-haiku-01`, seed 1214, arm O, 6 tasks, 1 repetition):

- All 6 runs completed. The batch used 8.9 million tokens, about 0.32 dollars. Each run has 5 compactions.
- After the regrade: 6 valid runs. Plain Haiku kept 24 of 24 rules, so the rule score is 1.000. The function cases pass in 106 of 108.
- In 3 of the 6 runs, the agent wrote the rules to a workspace file on its own. In the other 3 runs, it kept each rule without such a file.
- Before the regrade: 2 valid runs, each with 4 of 4 rules. The other 4 runs were invalid and not graded.
- Cause of the invalid grades: the integrity scan read the code text of Edit and Write calls. It took a relative import or a regular expression for an outside path. It also took the JSON escape of a quote in a shell command for a drive path.
- The analysis worker fixed the grader, with tests. For a write tool, only the target path decides. A real outside path stays a record. A scratch regrade of each v12 batch changed only these 4 grades. No run was made again.
- The guard denied 5 shell calls in the run of `L13-csv-report`. The cause is not examined yet.
- Reading: the set is at the ceiling for plain Haiku. It cannot show a benefit of the plugin with manual compactions.
- The lead did not start the Opus calibration. A stronger model on a set that Haiku solves gives no new information for about 14 dollars. The owner decides the next step.

Step 2.9, Opus 5.5 with automatic compactions, design fixed before the runs (2026-11-26):

- The owner wants a result for Opus. Plain Opus 5.5 is at the ceiling with manual compactions. No Opus run used automatic compactions.
- The owner approved this room test in place of the Opus calibration on the rule set, which did not run.
- Batch `v12-auto-opus-calib-01`: suite `v12-auto`, arm O only, model `claude-opus-5-5`, the long task, 2 repetitions, seed 1215. The compaction window is 100 000 tokens, as in the Haiku batches. Cost: about 11 dollars.
- Two measures decide: the mean final score, and the share of correct probes.
- Room rule: if the final score is 0.85 or lower, or the probe share is 0.85 or lower, there is room. The next step is then an Opus batch with arms O and Z on this task.
- The owner approves that batch before it starts. Its cost is about 45 dollars for 4 pairs.
- If both measures are above 0.85, no Opus batch with the plugin runs. The result is then "plain Opus 5.5 keeps the state in each condition of this benchmark".
- Limits: 2 runs on one task. A window of 100 000 tokens is smaller than the window that Opus has in normal use.

Step 2.9, result of the Opus room test (`v12-auto-opus-calib-01`):

- Both runs completed and are valid and isolated. The run records name the model `claude-opus-5-5`. The batch used 5.6 million tokens, about 4.52 dollars.
- Mean final score: 1.000, with 2 perfect runs. Probes: 17 of 17 correct.
- The 2 runs had 4 automatic compactions in total. The Haiku runs on the same task had about 8 compactions for each run.
- By the room rule, there is no room. No Opus batch with the plugin runs.
- Result: plain Opus 5.5 keeps the state in each condition of this benchmark. The benchmark gives no evidence that the plugin helps Opus 5.5, and no evidence that it harms.
- Limits: 2 runs on one task, with few compactions.

Step 2.10, search for a real Opus case in the session history (2026-11-26):

- The lead scanned the local Claude Code session records of the owner for a case where Opus lost state after a compaction.
- Scope: 1 515 session files. Benchmark sessions and subagent files are left out. 44 real sessions hold 106 compactions with Opus 5.5 as the model.
- Method: the lead read each human message among the first 6 after each of these compactions, 160 messages in total. A keyword filter for correction words marked 5 of them.
- Three of the 5 are not corrections. The lead traced the other 2 in the session records.
- Case 1, a branch on the wrong base: the agent chose the wrong base before the first compaction. The summary held the correct instruction. This is not a loss by compaction.
- Case 2, a commit with the wrong author and a description: the owner gave that rule for the first time in that message. The 2 later summaries of the session hold the rule, and the later commits follow it.
- Result: the scan found no case where Opus 5.5 lost state after a compaction.
- Limits: the scan finds only a loss that the owner named in a message soon after a compaction. It does not find a loss that nobody saw. 24 of the 44 sessions have no human message after a compaction, because agents ran them.
- Decision of the owner: with no such case, the search for an Opus case ends here.

Step 2.11, no-harm test on Opus 5.5, design fixed before the runs (2026-11-26):

- The owner asked for this test. No Opus run used the plugin until now.
- Batch `v12-hard-opus-01`: suite `v12-hard-opus`, arms O and Z, model `claude-opus-5-5`, the 6 tasks of `tasks/v12-hard`, 1 repetition, 12 runs, seed 1216. Each run has 5 manual compactions. Cost: about 28 dollars.
- The batch can show harm. It cannot show a benefit, because the plain score is near the top.
- The no-harm rule of step 2.5 applies. It has two conditions.
- Condition 1: the mean final score of arm Z is not lower than that of arm O by more than 0.03.
- Condition 2: arm Z uses at most 5% more tokens than arm O.
- If the rule is not met, the result is "harm not ruled out", and the report gives the pairs that lost.
- The report also gives the probes and the delivery count of the plugin for each arm.
- Limits: 6 pairs. The batch cannot rule out a small harm.

Step 2.11, result of the Opus no-harm test (`v12-hard-opus-01`):

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

## Phase 1: the standalone plugin

Content of the plugin:

- One plugin manifest and one hooks file with a `PreCompact` entry.
- One script that prints the text. The text is the file `configs/precompact-general-instruction.txt` (694 bytes), with the same hash.
- One variable that turns the output off.
- A README with the installation, the off switch, and the measured result with its limits.
- Tests: the output and its hash, the off switch, an empty output on a fault, and no network call.

Rules:

- New code only. The plugin copies no file of Context Mode.
- The script reads no session content and writes no file. It has no state.
- A fault in the script never blocks a compaction.

Benchmark work:

- Arm S and arm C in the runner, with tests.
- Smoke batch: 1 run of arm S and 1 run of arm C. Arm S shows one delivery of 694 bytes with the hash at each compaction. Arm C shows the text in the session and no hook delivery.

Covers W6. The plugin is small, so the lead builds it before the result of arm C is known. If arm C gives the same result, the README offers both paths.

## Phase 1b: harder tasks and an independent task shape

- Harder tasks: the three shapes with more stages, more changes for each stage and more compactions. If step 0.6 gives a baseline above 0.85, the lead prepares them. A calibration of 6 Opus runs must then give a baseline of 0.85 or lower.
- An independent shape: the task worker designs one new task shape and its grader from a brief that does not hold the instruction text. Two tasks of this shape go into step 2.1.

Covers W1 and W12.

## Phase 2: stronger proof

Each batch has rules that are fixed before the run. The lead asks the owner before each full batch.

| Step | Batch | Design | Runs | Estimate in tokens | Covers |
|---|---|---|---|---|---|
| 2.1 | More tasks, Haiku | 12 tasks (10 new seeds of the three shapes, 2 tasks of the independent shape), 2 repetitions, arms O, S, C and I | 96 | 75 million | W3, W6, W10, W12 |
| 2.3 | Opus 5.5 | Arms O and S, 6 tasks, 2 repetitions. The tasks follow the outcome of step 0.6 | 24 | 19 million or more | W1 |
| 2.4 | Automatic compactions, Haiku | Arms O and S, the long task of v0.9 with probes, 2 repetitions | 4 to 8 | 30 million | W2, W11 |
| 2.5 | No harm | Arms O and S on tasks with no state to keep across the compaction | 12 | 8 million | W5 |
| 2.6 | Work result | Tasks that end in code, with tests as the grader. Arms O and S | 12 | 15 million | W4 |
| 2.7 | Rerun set | 3 tasks, 2 repetitions, arms O and S. A fixed small suite | 12 | 9 million | W13 |

Notes for each step:

- 2.1 gives 24 pairs for each comparison. The interval is then about 0.06 to each side. If arm C scores within 0.05 of arm S, the later steps keep arm S only, and the README names both paths.
- 2.3 uses the model id `claude-opus-5-5` through the CLI of the owner. Opus runs count more against the usage limit of the subscription than Haiku runs. The lead stops at a limit and does not work past it.
- 2.4 repeats part 2 of v0.9, which ran with Context Mode and with the other plugins of the test machine. The report gives the count of compactions and the tokens for each arm.
- 2.5 measures the score, the tokens and the summary length.
- 2.6 is a fixed step of the plan. It needs new tasks and a new grader, so its preparation starts with phase 1b.
- 2.7 runs one time now. The owner can run the same suite again after an update of Claude Code. No Sonnet batch is in the plan.

The token estimates use 0.78 million tokens for each plain Haiku run, from `v11-iso-01`.

Fixed rules for the benefit, in steps 2.1, 2.3 and 2.6:

| Outcome | Reading |
|---|---|
| S minus O is +0.10 or more, with an interval above zero | The text helps under this condition |
| S minus O is below +0.05 | The text gives no benefit of that size under this condition. The README says so |
| Each other outcome | Open. The report states the numbers |

Fixed rules for the delivery path, in step 2.1:

| Outcome | Reading |
|---|---|
| C is within 0.05 of S | Both paths work. The README gives the `CLAUDE.md` path as the simplest one |
| C is more than 0.05 below S | The hook is the path. The plugin is the product |
| C is more than 0.05 above S | The lead examines the plugin before any further batch |
| S is more than 0.05 below I | The plugin has a fault. The lead stops and reports |

Fixed rules for the cost:

| Step | Rule |
|---|---|
| 2.4 | The benefit in the probes must hold: S minus O is +0.10 or more. The report states the extra compactions and the extra tokens of arm S. If arm S uses over 20% more tokens, the README states this cost for long sessions. The lead then proposes a shorter text for a later test |
| 2.5 | No lower score than arm O by more than 0.03, and at most 5% more tokens |

## Phase 3: report and release decision

- One report for the standalone product, with each batch, each invalid run and each limit.
- The README states the models and the conditions with a measured benefit, those without, and the measured cost.
- A push, a public repository and a license are decisions of the owner. The lead does none of them.

## Order and stop points

1. Steps 0.1 to 0.5. No model run.
2. Stop point: the owner approves step 0.6. The lead runs it and reports the Opus baseline.
3. Phase 1 with its two smoke runs. Phase 1b starts next to it.
4. Stop point: the owner sees the plugin, the smoke result and the new tasks.
5. Step 2.1.
6. Stop point: the owner sees the result for the plugin and for the `CLAUDE.md` path.
7. Step 2.3, then steps 2.4 and 2.5.
8. Stop point: the owner sees the Opus result and the cost result.
9. Steps 2.6 and 2.7.
10. Phase 3.

Rules that stay: at most two live sessions at the same time. No rerun because of a score. Invalid and stopped runs are in the report. No direct model API key. No push without the word of the owner.

## Not in this plan

- Codex. A hook text does not reach its summarizer, so it needs a different design. The research note of 2026-11-25 has the options.
- More runs on the silent clock. The question stays open in `REPORT-V11.md`.
- A change of Context Mode or of Context Clock v0.3.
- A Sonnet batch.

## Decisions of the owner

| Number | Question | Recommendation of the lead | State |
|---|---|---|---|
| D1 | Is the reading in the section "How the lead read the request" correct? | Yes | Open |
| D2 | Where does the plugin live? | A new folder outside the Context Mode fork, as its own repository, local only | Open |
| D3 | What happens to the v0.3 change in the fork? | It stays as it is, with no further work | Open |
| D4 | Does step 2.1 use new task seeds? | Yes, 12 tasks | Open |
| D5 | Which license does the plugin get? | The owner decides. The plugin has no Context Mode code | Open |
| D6 | Which model after Haiku? | | Decided: Opus 5.5, no Sonnet |

## Changes of 2026-11-26

1. New arm C: the text in `CLAUDE.md`, in step 2.1. New step 0.5 for the documented form.
2. The Opus calibration moved to step 0.6, before the plugin. Harder tasks are prepared in phase 1b.
3. Step 2.4 has a cost rule. The cost of v0.9 with automatic compactions is weak part W11.
4. Step 2.6 (a task that ends in code) is a fixed step. Phase 1b adds one task shape that a worker designs without the text.
5. New step 2.7: a small suite for a rerun after an update of Claude Code.

## Total

| Part | Estimate in tokens |
|---|---|
| Steps 0.6 and the smoke runs | about 7 million |
| Step 2.1 | about 75 million |
| Steps 2.3 to 2.5 | about 57 million |
| Steps 2.6 and 2.7 | about 24 million |
| Sum | about 163 million, of which about 24 million are Opus tokens |

A second Opus calibration for harder tasks adds about 5 million tokens or more.
