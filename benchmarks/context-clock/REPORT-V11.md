# Context Clock v0.11 report: the text works without Context Mode, and the product path delivers it

Batch `v11-iso-01`, 2026-11-25. Design: `EXPERIMENT-V11.md`. Generated tables: `results/v11-iso-01/report.md`. The lead wrote this file from those tables and from the run records.

Part A is batch `v11-iso-01`. Part B (the product path) is batch `v11-full-01`, in the section "Part B" at the end of this file. The sections before it are part A.

## Answer

1. The instruction text gives its benefit in plain Claude Code. Arm I scored 0.983 and arm O 0.787. The difference is +0.196, with an interval of [+0.125, +0.275].
2. The earlier result holds in isolated sessions. Arm R scored 0.950 and arm B 0.719. The difference is +0.232, with an interval of [+0.102, +0.346].
3. Arm B scored 0.069 below the plain host (arm O). The interval contains zero. The batch does not show the cause.
4. With the text, the plain host and the Context Mode session are close: R minus I is -0.033.

The sample is exploratory: 6 tasks, 2 repetitions, one host and one small model. This report makes no significance claim.

## Correction of the arm description

`EXPERIMENT-V11.md` and the earlier summaries of the lead describe arm B as "Context Mode, clock off". That description is wrong.

- In the runner, arms B and R set `CTX_CLOCK=1` and `CTX_CLOCK_FEEDBACK=off`. The clock is on, and it sends no feedback to the agent. This is the same in each batch since v0.4.
- In this batch, arms B and R also set `CTX_CLOCK_COMPACT=off`. The product hook ran at each compaction and printed 0 bytes.
- Arm B is thus the same configuration as the proposed arm Y. No arm of this batch has Context Mode with the clock off.
- The smoke note "the product hook ran with the clock off" is wrong for the same reason. The run showed the compaction instruction off, with the clock on. The product tests cover the disabled mode. No live run covers it.

Consequences:

- The comparisons R minus B and I minus O are not affected. Both sides of each pair have the same clock configuration.
- The comparison B minus O measures Context Mode with the silent clock against the plain host. It does not separate the two.
- Part B needs arm A (Context Mode, clock off) in place of arm Y.

## What ran

| Item | Value |
|---|---|
| Runs | 48 of 48 completed, no retry, no run at a limit |
| Valid runs | 48 |
| Arms | O plain host. I plain host with the text. B Context Mode with the silent clock. R the same with the text from the overlay |
| Tasks | the six frozen tasks of part 1 of v0.9 |
| Host and model | Claude Code 2.1.331, Haiku, two sessions at the same time, the plugin build with the v0.3 change |
| Compactions | 144 of 144 have the mark of the host |
| Deliveries of the text | I and R: 3 of 3 in each run, 694 bytes with the hash of the file. O and B: none |
| Product hook output | 0 bytes in each run |
| Shim errors | 0 |
| Tokens | about 39.5 million, below the limit of 70 million |
| Cost as the host reports it | about 2.43 dollars |

## Isolation

The session record of each run shows what the session loaded.

- Arms B and R: the Context Mode overlay plugin and its MCP server.
- Arms O and I: the benchmark plugin `ccb-plain` with the guard, and no MCP server.
- Each session also lists four built-in plugins of the host (`cc-plugin-*`). The host adds them, and no arm can remove them.
- No run shows a plugin or an MCP server of the user configuration.

## Scores

All 48 runs are in the numbers.

| Measure | O | I | B | R |
|---|---|---|---|---|
| Runs in the numbers | 12 | 12 | 12 | 12 |
| Mean final score | 0.787 | 0.983 | 0.719 | 0.950 |
| Perfect runs | 1 | 10 | 3 | 7 |
| Final answers about state before a compaction | 78.2% (86 of 110) | 98.2% (108 of 110) | 70.9% (78 of 110) | 94.5% (104 of 110) |
| Probe accuracy after each compaction | 87.6% (163 of 186) | 97.8% (182 of 186) | 76.3% (142 of 186) | 97.8% (182 of 186) |

Paired differences of the final score. The interval is a bootstrap over tasks.

| Comparison | Pairs | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|---|
| I minus O (primary) | 12 | +0.196 | [+0.125, +0.275] | 11 / 1 / 0 |
| R minus B | 12 | +0.232 | [+0.102, +0.346] | 8 / 3 / 1 |
| B minus O | 12 | -0.069 | [-0.211, +0.098] | 4 / 2 / 6 |
| R minus I | 12 | -0.033 | [-0.067, -0.008] | 0 / 9 / 3 |

Paired differences of the probe accuracy:

| Comparison | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|
| I minus O | +0.102 | [+0.049, +0.174] | 9 / 3 / 0 |
| R minus B | +0.209 | [+0.097, +0.336] | 9 / 2 / 1 |
| B minus O | -0.109 | [-0.224, +0.029] | 4 / 1 / 7 |
| R minus I | -0.002 | [-0.048, +0.048] | 3 / 7 / 2 |

The interval of B minus O contains zero. It does not show that the two arms are equal.

Scores for each task (mean of two runs):

| Task | Shape | O | I | B | R |
|---|---|---|---|---|---|
| A12-mobile-gateway | old | 0.889 | 1.000 | 0.722 | 1.000 |
| D12-backup-policy | old | 0.833 | 1.000 | 0.889 | 1.000 |
| W12-ledger-migration | work log | 0.850 | 1.000 | 0.650 | 0.950 |
| W12-shop-search | work log | 0.700 | 1.000 | 0.600 | 0.950 |
| X12-cdn-migration | decision record | 0.800 | 0.900 | 0.500 | 0.900 |
| X12-data-retention | decision record | 0.650 | 1.000 | 0.950 | 0.900 |

Scores for each shape (4 runs for each cell):

| Shape | O | I | B | R |
|---|---|---|---|---|
| old | 0.861 | 1.000 | 0.806 | 1.000 |
| work log | 0.775 | 1.000 | 0.625 | 0.950 |
| decision record | 0.725 | 0.950 | 0.725 | 0.900 |

The text helped on each shape, with and without Context Mode.

## What the summary held

| Measure | O | I | B | R |
|---|---|---|---|---|
| Reference lines whose current value is in the summary | 98.6% | 99.8% | 91.6% | 99.0% |
| Reference lines whose earlier values are in the summary | 84.3% | 100.0% | 76.1% | 96.4% |
| Final questions whose answer is in the last summary, of 92 | 81 | 92 | 75 | 91 |
| Wrong answers of the kind "obsolete decision" | 18 | 2 | 24 | 5 |
| Wrong answers of the kind "forgotten requirement" | 6 | 0 | 8 | 1 |

- The answers follow the summary. For answers that the summary did not hold, arm O had 2 of 11 correct and arm B 3 of 17.
- The summaries of arm B held less state than the summaries of arm O. This agrees with the lower score of arm B.
- The summary measure uses exact text matches, and it is weak on the work log shape.

## Arm B against the plain host

The rule of the design for "O is more than 0.05 above B" applies to the point value. The lead examined the records.

- The difference comes from 6 of 12 pairs. Arm B is lower on four tasks and higher on two.
- The largest single differences are `X12-cdn-migration` (B 0.60 and 0.40, O 0.80 and 0.80) and `A12-mobile-gateway` repetition 2 (B 0.44).
- On `X12-data-retention`, arm B is 0.30 higher than arm O.
- The agents used the Context Mode tools in 2 of 444 tool calls in arm B, and in 10 of 444 calls in arm R. The tool path of Context Mode was almost not in use on these tasks.
- After each compaction, the sessions of arms B and R got a session start text of about 495 bytes. The plain arms got none.
- Arm B has the clock on. The batch does not separate the clock from the other parts of Context Mode.

The cause is open. The records show a lower state share in the summaries of arm B, and they do not show why. With 12 pairs and an interval of [-0.211, +0.098], the difference can be noise.

## Cost

Means for each run.

| Measure | O | I | B | R |
|---|---|---|---|---|
| Tokens | 769 066 | 778 691 | 859 482 | 887 022 |
| Tokens against O | | +1.3% | +11.8% | +15.3% |
| Tool calls | 35.3 | 35.2 | 37.0 | 37.0 |
| Duration in minutes | 3.0 | 3.4 | 3.6 | 4.4 |
| Cost in dollars | 0.0481 | 0.0531 | 0.0475 | 0.0542 |

- The text costs about 1% of the tokens in the plain host and about 3% in the Context Mode session.
- The Context Mode sessions used about 12% more tokens than the plain sessions. The tasks have small tool outputs, so Context Mode had little output to cut.

## Decision rules

| Rule of `EXPERIMENT-V11.md` | Numbers | Result |
|---|---|---|
| I minus O is +0.10 or more, with an interval above zero | +0.196, [+0.125, +0.275] | Met. The text works without Context Mode. |
| I minus O is below +0.05 | +0.196 | Does not apply. |
| R minus B in isolated sessions is +0.10 or more, with an interval above zero | +0.232, [+0.102, +0.346] | Met. The earlier results hold without the other plugins. |
| R minus B in isolated sessions is below +0.05 | +0.232 | Does not apply. No stop. |
| O is within 0.05 of B, and I is within 0.05 of R | 0.069 and 0.033 | Not met for O and B. Met for I and R. |
| O is more than 0.05 below B | O is 0.069 above B | Does not apply. |
| O is more than 0.05 above B | 0.069, interval [-0.211, +0.098] for B minus O | Applies to the point value. The cause is open. See the section above. |

## Denied attempts and invalid runs

- No run is invalid by the current rule.
- The guard denied calls in 6 of 48 runs: 9 calls in total (B 5, O 3, R 1, I 0).
- 4 runs have a recorded attempt to read the session transcript of the run. All 4 are on `D12-backup-policy`: both runs of arm B and both runs of arm O. The guard denied each attempt.
- The attempts are in the two arms without the text. An agent that lost state looked for it in the transcript.
- With these 4 runs left out, arm O scores 0.778 and arm B 0.684. Arms I and R do not change.

## Limits

- One host, one small model, generated tasks, manual compactions only.
- Two tasks for each shape, and 12 pairs for each comparison.
- Arm B has the clock on. The batch has no arm with Context Mode and the clock off.
- The tasks have small tool outputs. The result says little about work in which Context Mode cuts large outputs.
- The plain arm I uses a hook of the benchmark. It is not a product.
- The built-in plugins of the host are in each session.
- The summary measure uses exact text matches.

## What this means for the product

- The benefit belongs to the text at `PreCompact`. It does not depend on Context Mode, on the clock or on the other plugins of the test machine.
- A Claude Code user can get the same effect with one `PreCompact` hook that prints the text.
- Context Clock v0.3 delivers the text from the product. Part B must still show that this path gives the result of arm R.
- This batch gives no evidence that Context Mode by itself, or the silent clock, helps to keep state on these tasks.

## Part B: the product path

Batch `v11-full-01`, 2026-11-25, seed 1111. Generated tables: `results/v11-full-01/report.md`. The owner accepted the change of the arms (arm A in place of arm Y) before the run.

### Answer

1. The product path of Context Clock v0.3 gives the result of the benchmark overlay. Arm M scored 0.906 and arm R 0.916. M minus R is -0.009, with an interval of [-0.108, +0.107].
2. Each of the 36 compactions of arm M has one product delivery of 694 bytes with the hash of the text.
3. Arm M is above the baseline: M minus B is +0.206, with an interval of [+0.098, +0.323].
4. The disabled mode held in live sessions. The product hook printed 0 bytes in each run of arms A, B and R.
5. The silent clock (arm B) scored 0.054 below Context Mode with the clock off (arm A), over 11 pairs. The interval contains zero. The result depends on the handling of one invalid run.

### What ran

| Item | Value |
|---|---|
| Runs | 48 of 48 completed, no retry, no run at a limit |
| Valid runs | 47. One run of arm A is invalid |
| Arms | A Context Mode, clock off. B clock on, feedback off. R the same with the overlay text. M the same with the product text |
| Tasks, host and model | the same as in part A |
| Compactions | 144 of 144 have the mark of the host |
| Product deliveries | M: 36 of 36, 694 bytes each, one hash. A, B and R: 36 calls each, 0 bytes |
| Overlay deliveries | R: 36 of 36. A, B and M: none |
| Isolation | each session loaded only the Context Mode plugin, its MCP server and the built-in plugins of the host |
| Shim errors | 0 |
| Tokens | about 40.9 million, below the limit of 70 million |
| Cost as the host reports it | about 2.45 dollars |

### Scores

The numbers use the valid runs. Arm A has 11 runs.

| Measure | A | B | R | M |
|---|---|---|---|---|
| Runs in the numbers | 11 | 12 | 12 | 12 |
| Mean final score | 0.755 | 0.700 | 0.916 | 0.906 |
| Perfect runs | 1 | 0 | 9 | 6 |
| Final answers about state before a compaction | 76.0% (76 of 100) | 70.0% (77 of 110) | 90.9% (100 of 110) | 90.9% (100 of 110) |
| Probe accuracy after each compaction | 83.5% (142 of 170) | 78.5% (146 of 186) | 95.7% (178 of 186) | 94.6% (176 of 186) |

Paired differences of the final score. The interval is a bootstrap over tasks.

| Comparison | Pairs | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|---|
| M minus R (primary) | 12 | -0.009 | [-0.108, +0.107] | 1 / 6 / 5 |
| M minus B | 12 | +0.206 | [+0.098, +0.323] | 9 / 2 / 1 |
| R minus B | 12 | +0.216 | [+0.032, +0.364] | 10 / 1 / 1 |
| B minus A | 11 | -0.054 | [-0.171, +0.050] | 3 / 3 / 5 |

Paired differences of the probe accuracy:

| Comparison | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|
| M minus R | -0.014 | [-0.077, +0.045] | 2 / 6 / 4 |
| M minus B | +0.152 | [+0.050, +0.254] | 8 / 1 / 3 |
| R minus B | +0.166 | [+0.032, +0.281] | 9 / 1 / 2 |
| B minus A | -0.053 | [-0.133, +0.027] | 4 / 3 / 4 |

The intervals of M minus R and of B minus A contain zero. They do not show that the arms are equal.

Scores of each run:

| Task | A | B | R | M |
|---|---|---|---|---|
| A12-mobile-gateway | 0.44, 0.78 | 0.89, 0.44 | 1.00, 1.00 | 0.89, 1.00 |
| D12-backup-policy | 0.78, 1.00 | 0.78, 0.89 | 0.89, 1.00 | 0.89, 1.00 |
| W12-ledger-migration | 0.70, 0.80 | 0.70, 0.40 | 1.00, 1.00 | 0.90, 1.00 |
| W12-shop-search | 0.70, 0.70 | 0.50, 0.70 | 1.00, 0.70 | 0.70, 0.60 |
| X12-cdn-migration | 0.90, invalid | 0.60, 0.70 | 1.00, 1.00 | 1.00, 1.00 |
| X12-data-retention | 0.70, 0.80 | 0.90, 0.90 | 0.40, 1.00 | 1.00, 0.90 |

Scores for each shape:

| Shape | A | B | R | M |
|---|---|---|---|---|
| old | 0.750 | 0.750 | 0.972 | 0.944 |
| work log | 0.725 | 0.575 | 0.925 | 0.800 |
| decision record | 0.800 | 0.775 | 0.850 | 0.975 |

- Arm M is 0.125 below arm R on the work logs and 0.125 above it on the decision records. Each cell has 4 runs.
- One run of arm R on `X12-data-retention` scored 0.40. This task gave low single runs in v0.10 too.

### The invalid run

Run `X12-cdn-migration`, arm A, repetition 2 is invalid.

- In stage 3, the agent made three shell calls on a file in the work root, outside the workspace of the run. The guard did not deny them.
- The run answered 2 of 10 final questions correctly. The analysis does not count it.
- The lead did not rerun it.
- If the run counts with its score of 0.00, arm A scores 0.692, and B minus A is +0.008 over 12 pairs.

The guard has a gap for this path. The file name looks like stage material of the same run. The lead did not examine the content.

### The silent clock

The rule of the design: if B is more than 0.05 below A, the silent clock costs score, and the product change needs a new decision of the owner.

- B minus A is -0.054 over the 11 valid pairs. The rule applies to this point value.
- The interval is [-0.171, +0.050]. With the invalid run counted as 0.00, the difference is +0.008.
- Arm A got no session start text. Arms B, R and M got one text of about 495 bytes after each compaction, from the clock.
- The summaries of arm B held the earlier values less often than those of arm A (71.7% against 81.6% of the reference lines).
- In part A, arm B was 0.069 below the plain host. The two batches agree in the direction, and each interval contains zero.

The evidence for a cost of the silent clock is weak, and it is not zero. The decision belongs to the owner.

### Cost

| Measure | A | B | R | M |
|---|---|---|---|---|
| Tokens for each run | 843 405 | 846 756 | 860 715 | 860 784 |
| Tool calls for each run | 36.3 | 36.6 | 36.5 | 36.4 |
| Cost in dollars for each run | 0.0490 | 0.0480 | 0.0531 | 0.0537 |

The text adds about 1.7% of tokens against arm B, on both paths.

### Decision rules

| Rule | Numbers | Result |
|---|---|---|
| Each compaction of arm M has a delivery with the hash. M is not lower than R by more than 0.05. M is above B | 36 of 36. -0.009. +0.206 | Met. The product path is accepted. |
| A delivery is missing, or arms B and R show a product output that is not empty | none missing. 0 bytes | Does not apply. |
| R minus B in isolated sessions is +0.10 or more, with an interval above zero | +0.216, [+0.032, +0.364] | Met, for the second time. |
| B is more than 0.05 below A | -0.054 over 11 pairs, interval [-0.171, +0.050] | Applies to the point value. The owner decides. |

### Denied attempts

- The guard denied calls in 4 of 48 runs (A 1, B 2, M 1, R 0).
- One run of arm M on `D12-backup-policy` tried to read its session transcript. The guard denied each call, and the run is valid.

### Limits of part B

- The limits of part A apply.
- Arm M ran with the clock feedback off. The clock with its normal feedback is not in this experiment.
- 12 pairs do not separate two arms that differ by less than about 0.10.
- The comparison B minus A has 11 pairs, and it changes sign with the handling of one run.

## Part C: the silent clock

Batch `v11-clock-01`, 2026-11-25, seed 1112. Design: part C of `EXPERIMENT-V11.md`. Generated tables: `results/v11-clock-01/report.md`.

### Answer

The question stays open. Arm B (clock on, feedback off) scored below arm A (clock off) again, and the interval again contains zero.

- This batch: A 0.686, B 0.609. B minus A is -0.077, with an interval of [-0.256, +0.083] over 12 pairs.
- Pooled with the valid pairs of part B: B minus A is -0.066, with an interval of [-0.178, +0.031] over 23 pairs.
- The probe accuracy after the compactions is almost equal: 79.0% for arm A and 77.4% for arm B.
- Two runs of arm B carry most of the difference of this batch.

### What ran

| Item | Value |
|---|---|
| Runs | 24 of 24 completed, no retry, no run at a limit |
| Valid runs | 24. The guard gap of part B did not occur |
| Arms | A Context Mode, clock off. B clock on, feedback off |
| Tasks, host, model and plugin build | the same as in part B |
| Compactions | 72 of 72 have the mark of the host |
| Product hook output | 0 bytes in each run |
| Clock | A: 0 events and no session start text. B: one session start text after each compaction |
| Isolation | each session loaded only the Context Mode plugin, its MCP server and the built-in plugins of the host |
| Shim errors | 0 |
| Tokens | about 20.2 million, below the limit of 35 million |
| Cost as the host reports it | about 1.15 dollars |

### Scores

| Measure | A | B |
|---|---|---|
| Runs in the numbers | 12 | 12 |
| Mean final score | 0.686 | 0.609 |
| Perfect runs | 1 | 1 |
| Probe accuracy after each compaction | 79.0% (147 of 186) | 77.4% (144 of 186) |
| Reference lines whose earlier values are in the summary | 80.1% | 76.1% |
| Tokens for each run | 835 412 | 845 505 |

| Comparison of the final score | Pairs | Mean difference | 95% interval | Win / tie / loss |
|---|---|---|---|---|
| B minus A, this batch | 12 | -0.077 | [-0.256, +0.083] | 6 / 1 / 5 |
| B minus A, pooled with part B | 23 | -0.066 | [-0.178, +0.031] | 9 / 4 / 10 |

Scores of each run:

| Task | A | B |
|---|---|---|
| A12-mobile-gateway | 1.00, 0.89 | 0.33, 1.00 |
| D12-backup-policy | 0.67, 0.78 | 0.89, 0.89 |
| W12-ledger-migration | 0.60, 0.70 | 0.50, 0.80 |
| W12-shop-search | 0.70, 0.60 | 0.60, 0.70 |
| X12-cdn-migration | 0.60, 0.50 | 0.80, 0.50 |
| X12-data-retention | 0.80, 0.40 | 0.00, 0.30 |

### Two runs carry the difference

- `X12-data-retention`, arm B, repetition 1 scored 0.00. The run answered 13 of 15 probes correctly. In the final stage, it gave an old value for each of the 10 questions.
- `A12-mobile-gateway`, arm B, repetition 1 scored 0.33.
- Without the first of these pairs, B minus A is -0.011 in this batch and -0.033 in the pooled table.
- Arm B has 6 wins and 5 losses in this batch. The arms differ in the size of single losses and not in their count.

`X12-data-retention` also gave low single runs in v0.10, in part A and in part B, in arms with and without the clock.

### Decision rules

| Rule of part C | Numbers | Result |
|---|---|---|
| Pooled B minus A is -0.05 or less, with an interval below zero | -0.066, [-0.178, +0.031] | Not met. The interval contains zero. |
| Pooled B minus A is between -0.05 and +0.05 | -0.066 | Not met. |
| Each other outcome | | Applies. The question stays open. |

With the invalid run of part B counted as 0.00, the pooled difference is -0.034 over 24 pairs. The rule uses the valid pairs.

### What the three batches show together

| Batch | Comparison | Difference | 95% interval |
|---|---|---|---|
| `v11-iso-01` | B minus O (plain host) | -0.069 | [-0.211, +0.098] |
| `v11-full-01` | B minus A | -0.054 | [-0.171, +0.050] |
| `v11-clock-01` | B minus A | -0.077 | [-0.256, +0.083] |

- The point value is negative three times, and each interval contains zero.
- The benchmark gives no evidence that the silent clock helps to keep state on these tasks.
- If the silent clock has a cost, it is small against the benefit of the text (+0.21 to +0.23).
- Arm B is not the product default of v0.3. With the clock on, the product prints the text (arm M), and arm M scored 0.906.

### Denied attempts

- The guard denied calls in 5 of 24 runs (A 3, B 2).
- Two runs of `D12-backup-policy`, one of each arm, tried to read the session transcript. The guard denied each call, and both runs are valid.

### Limits of part C

- The limits of part A apply.
- The sample does not separate a difference of this size from noise. A clear answer needs about four times the pairs, or tasks with less spread.
- The scores of both arms are lower than in part B (A 0.755 and B 0.700 there). The batches ran at different times of the same day.

## Examination after part C

The lead read the session records of arms A and B in `v11-full-01` and `v11-clock-01`. No new run was made.

### The session start text of the clock

After each compaction, Context Mode adds a state text to the session. In arm A, the text has the current stage and the list of the earlier user messages. In arm B, the clock adds one block of about 495 bytes to that text. The block holds:

- a counter line with the tick, the sequence number and the state revision,
- up to four file names with a version hash and the words "observed only", the first with the label "current",
- the name of the status tool,
- one line that says that delivery to the model is not confirmed.

The block holds no value of the task and no instruction. The host summaries did not copy it: 0 of 72 summaries of arm B have a word of the block.

### The two lowest runs of arm B

`X12-data-retention`, repetition 1, score 0.00:

- Four wrong answers come from a reading error in stage 8, after the last compaction. The agent decided that entries of the chat feed do not count, and it kept the older value. The rules of the task do not say that.
- Six wrong answers ask for facts of stages 1 and 2. The last summary did not hold them.
- The probes of this run were 13 of 15 correct.

`A12-mobile-gateway`, repetition 1, score 0.33:

- The last summary lists the event numbers of each stage and gives almost no values. The answer was in the summary for 1 of 6 measured questions.
- The same kind of summary is in runs of arm A.

Neither run shows a trace of the clock block in the answers or in the summaries.

### Both arms over two batches

Valid runs of `v11-full-01` and `v11-clock-01`:

| Measure | A (23 runs) | B (24 runs) |
|---|---|---|
| Final questions whose answer is in the last summary | 85.8% (151 of 176) | 78.8% (145 of 184) |
| Correct answers when the summary holds the answer | 76.8% | 73.8% |
| Correct answers when the summary does not hold it | 4 of 25 | 8 of 39 |
| Mean length of a host summary in bytes | 8 057 | 7 789 |
| Wrong answers about changes after the last compaction | 3 | 3 |

- The lower score of arm B comes from summaries that hold less state. The agents of both arms use a summary equally well.
- The summaries of arm B are about 3% shorter.
- The records do not show why the summaries of arm B hold less. The clock block is in the context that the next summarizer reads. An effect through that path is possible, and the records do not prove it.

### Reading

- The examination found no mechanism for a cost of the silent clock.
- The difference is in the summaries, and the text of arm R acts on the summaries. In arm M (clock on with the product text), the score was 0.906.
- A user who turns the clock on and the compaction instruction off gets the setup of arm B. This is the one setup with the open question.
- One low-cost product option is to leave out the clock block at session start when the feedback is off. The block gives the agent no task state in that mode. This is a product change, and the owner decides on it.

## Regrade of 2026-11-26: the invalid run of part B was valid

The lead examined the one invalid run of `v11-full-01` (`X12-cdn-migration`, arm A, repetition 2).

- The agent sent one shell call that wrote a temporary copy of a feed to the work root, outside its workspace. The guard denied the call. The agent repeated the command inside its workspace.
- The file held no answer key, and it was never written. The guard has no gap.
- The grader had a fault. One denied call that names an outside path three times gave three records, and the grader did not match them with the one denial.
- The grader is fixed, with a test. The lead graded the batches `v11-iso-01`, `v11-full-01`, `v11-clock-01` and `v12-opus-calib-01` again. One grade changed: this run is now valid, with a score of 0.20.
- No run was made again.

Numbers that change:

| Number | Before | After the regrade |
|---|---|---|
| Valid runs of `v11-full-01` | 47 | 48 |
| Arm A in part B, mean score | 0.755 over 11 runs | 0.708 over 12 runs |
| B minus A in part B | -0.054, [-0.171, +0.050], 11 pairs | -0.008, [-0.109, +0.084], 12 pairs |
| B minus A, pooled with part C | -0.066, [-0.178, +0.031], 23 pairs | -0.043, [-0.151, +0.051], 24 pairs |
| Win / tie / loss, pooled | 9 / 4 / 10 | 10 / 4 / 10 |

The numbers of arms B, R and M and the result for the product path do not change.

Effect on the rules:

- Part B, rule "B is more than 0.05 below A": it no longer applies. The difference is -0.008.
- Part C, pooled rule: the second row now applies. The pooled difference is between -0.05 and +0.05, so the batches show no cost of the silent clock of that size.
- The sections "The invalid run", "The silent clock" and part C above keep their first text, with the numbers before the regrade. This section replaces their conclusions.
- The statement on a "guard gap" in parts B and C is wrong. The next step "Close the guard gap" is done as a grader fix.

## Next steps

1. The owner decides on the silent clock. More runs of the same design are the costly way. The cheaper way is to read the session start text of the clock and the summaries of the two lowest runs.
2. Close the guard gap for files in the work root, and add a test for it.
3. Examine `X12-data-retention`: one more run answered each final question with an old value.
4. The model experiment v0.12 and the Codex question stay open, each with its own decision of the owner.
