# Context Clock benchmark analysis

The analysis reads one graded batch and writes a summary, a report and charts. It makes no model call and uses only Node built-in modules.

```text
node benchmarks/context-clock/analysis/analyze.mjs --batch <name> [--root <benchmark root>] [--raw-dir <raw folder>] [--tasks-dir <tasks folder>]
node benchmarks/context-clock/analysis/retrieval.mjs --batch <name> [same options]
node benchmarks/context-clock/analysis/coverage.mjs --batch <name> [same options]
node benchmarks/context-clock/analysis/facts.mjs --batch <name> [same options]
```

`--root` defaults to `benchmarks/context-clock`. The tests use it to point at a temporary fixture folder.

`--raw-dir` is the folder that holds `<runId>/a<N>/*.jsonl`. It defaults to `results/<batch>/raw`. The raw streams are git-ignored, so a worktree can point this option at the raw folder of another checkout.

`--tasks-dir` is the folder with `generated/` and `keys/`. Without it, the analysis uses `CCB_TASKS_DIR` (only when `--root` is not given), then `batch.json` `tasksDir` (relative to the root), then `tasks`.

`retrieval.mjs` writes only the `retrieval.json` files. `coverage.mjs` and `facts.mjs` write the `retrieval.json`, `coverage.json` and `facts.json` files. `analyze.mjs` writes them too, before the summary. A run gets `facts.json` only when its task has a schema 2 reference (`reference/<taskId>.state.json` with `facts`).

## Inputs and outputs

| Input | Use |
|---|---|
| `results/<batch>/runs/<runId>/run.json` | Status, mode, repetition, telemetry. |
| `results/<batch>/runs/<runId>/grade.json` | Score, success, per-question results, continuity errors. A run without this file is "ungraded". |
| `tasks/generated/<taskId>.task.json` | Category, profile, `params.approxBytes`. |
| `tasks/keys/<taskId>.key.json` | Expected values, aspects, error categories, and the `establishedBy` events. |
| `results/<batch>/batch.json` | Optional. Batch facts for the report (CLI versions, model, commit, seeds), `modes`, `comparisons` and `tasksDir`. |
| `configs/suites.json` | Optional. The `comparisons` list of the batch suite. |
| `<raw folder>/<runId>/a<N>/<turn>.jsonl` | Optional. The host stream of each turn. Only the last attempt counts. |
| `results/<batch>/runs/<runId>/retrieval.json`, `coverage.json` | Read when no raw stream of the run exists. |
| `results/<batch>/review.json` | Optional. The lead's classification of each differing case, and the recommendation. |

| Output | Content |
|---|---|
| `results/<batch>/runs/<runId>/retrieval.json` | The retrieval facts and the error class of each question. See "Retrieval and error classes". |
| `results/<batch>/runs/<runId>/coverage.json` | Value coverage of each final question with a text answer. See "Value coverage". |
| `results/<batch>/runs/<runId>/facts.json` | Fact statuses at each compaction, the question join and the state file reads. See "Fact-level analysis". |
| `results/<batch>/summary.json` | Every number of the report, with sorted keys. |
| `results/<batch>/report.md` | The tables, chart links, listed runs, differing cases, limits and recommendation. |
| `results/<batch>/charts/*.svg` | Four charts. |

The same inputs give the same bytes. The analysis reads no clock time, sorts every list, rounds stored numbers to fixed decimals, and uses a seeded random generator.

## Which runs count

| Run | In accuracy numbers | In the report |
|---|---|---|
| `completed` with a valid grade | yes | in all tables |
| `agent_failed`, `timeout` or `limit_exceeded` with a valid grade | yes, with score 0 and success false | also in the listed-runs table |
| `infra_failed` (after all retries) | no | listed-runs table |
| grade with `valid: false` | no | listed-runs table, with the reason and the violation count |
| no `grade.json` | no | listed-runs table as `ungraded` |

If a run is not `completed`, it scores 0. This is true even if its grade file gives another score.

## Metrics per mode

All metrics below use the runs in the accuracy numbers of one mode (A baseline, B silent, C active, D placebo, E commit prompt, F commit and returned state, G reference state, H state file, S compaction instruction, J state file with no return, K sparse state file with return, L sparse state file with no return).

The modes come from `batch.json` `modes`, plus the mode of each run. Without `modes`, the analysis uses A, B and C. If a run has mode D, E, F, G, H, S, J, K or L, the analysis uses only the modes of the runs.

| Metric | Definition |
|---|---|
| Runs by status | The count of each `status`, plus the invalid and ungraded counts. |
| Task success rate | The share of runs with every final question correct. |
| Mean score | The mean of the run scores. A run score is the share of correct final questions. |
| Mean continuity errors per run | The mean of the sum of `continuityErrors` in each grade. |
| Error counts by category | The sum of `continuityErrors` per error category. |
| Accuracy by task category | Mean score and success rate per task category A to E. |
| Accuracy by context size | Mean score and success rate per size group. The tasks of the batch are sorted by `params.approxBytes` (ties by task id) and split into three groups of equal task count: small, medium, large. A task with no size is "unknown". |
| Accuracy by profile | Mean score and success rate for `long` and `compaction`. |
| Post-compaction continuity accuracy | Correct divided by questions, summed over the `preCompaction` field of each grade. These questions ask about facts from before the compaction. `summary.json` calls it `postCompactionContinuity`. |
| Checkpoint accuracy | Correct divided by questions, summed over the `checkpoint` field of each grade (the mid-run questions). |
| Cost | The mean per run of each cost field: the four token fields and their total, tool calls, duration, and compactions that the host stream marked. Also clock feedback count and bytes, clock commit and status calls, and search calls. Also clock feedback count and bytes for each channel (tool reply, hook context, session start), from `telemetry.clockFeedbackByChannel`. A run without that field gives `null`. A `null` value in a run is left out of that mean. Total tokens is the sum of the four token fields that are not `null`. Also unconfirmed compactions (`compactions[i].confirmed` is false), guard denials (`telemetry.guard.denied`), and the real, placebo, none and bytes counts of each shim channel (`telemetry.shim.byChannel`), as `shim_<channel>_<kind>`. |
| Limit hits | The count of each `limitHit` value. |
| Errors | The error class counts of the wrong final questions and of the wrong probes, from `retrieval.json`. Also the retrieval failure rate (retrieval errors divided by all final questions), the share of wrong answers that are retrieval errors, and the cut chunks with and without a follow-up. |
| Assistant mentions | Assistant messages that name the clock or the placebo tag. This is a plain text count, not a measure of use. |
| Accuracy per task | Mean score and success rate per task. |
| Commit compliance | From `telemetry.commits`: commit calls, accepted commits, rejected commits by error code, and the stages with a commit divided by all stages. Counts are `null` (n/a) when no run of the mode has the field. |
| State block facts | From `telemetry.stateBlock`: deliveries, missing blocks, bytes, bytes per delivery, findings and cuts. Counts are `null` (n/a) when no run of the mode has the field. |
| Value coverage | The four-cell table from `coverage.json`, and the `ctx_clock_status` calls in probe and final turns. See "Value coverage". |
| State saves | From `telemetry.stateFile`: writes of the state file, and the stages with a write divided by all stages. Counts are `null` (n/a) when no run of the mode has the field. |
| State correctness | From `coverage.json` `stateCorrectness`: compactions, compactions with a reference state, with a block and with a host summary, and the share of reference lines found in the block and in the summary. See "State correctness". |
| Fact status | From `facts.json`: the share of each status (correct, formatted, stale, incorrect, missing, absent) of the reference facts in the state file, the summary and the block, for the current value and for the history. Also the question join and the anchoring candidates. See "Fact-level analysis". |
| State file reads and size | Reads from `telemetry.stateFile.reads` and from the streams, the runs with a read after a compaction, and the bytes of the state file copies. |
| Tokens by kind | The sum of each `usage` field over the turns of a run, mean per run, and the mean `costUsd` of a run where turns have it. The overhead gives the added tokens of each kind against the baseline. |
| Compaction stages | For each stage: the compactions and the mean `preTokens` (from `run.json` `compactions`, else from `compact_metadata.pre_tokens` in the stream). The summary lists the task and repetition blocks whose modes compacted after different stages. |
| Stage turn cost | The mean total tokens of a `stage` turn (the four `usage` fields of the turn in `run.json`) and of a run. A turn without `usage` is left out. |

## Paired comparison

A pair is one `(taskId, rep)` with a run in both modes. The comparisons come from `batch.json` `comparisons`, then from the suite, then from the defaults. The first comparison is the primary one.

| Modes | Default comparisons |
|---|---|
| A, B, C | C minus B (effect of feedback), C minus A (total effect), B minus A (effect of silent recording) |
| B, C, D | C minus D (real feedback against placebo), D minus B (placebo against no feedback), C minus B (effect of feedback) |
| J, K or L present | J minus B (preparation), H minus J (restoration), H minus B, K minus H, L minus J. The v0.6 suites give the list. |
| H or S present | H minus F (state file against the commit step), H minus B (total effect of the state file), S minus B (effect of the compaction instruction), F minus B (total effect of the candidate) |
| E, F or G present | F minus E (effect of the returned state), G minus B (ceiling of the channel), E minus B (effect of the commit step), F minus B (total effect of the candidate) |

Each comparison is made for the final score, for the post-compaction continuity accuracy and for the probe (checkpoint) accuracy. A run that did not complete scores 0 in each of them.

| Value | Definition |
|---|---|
| Pairs | Pairs where both runs are in the accuracy numbers. |
| Dropped | Pairs where one run is missing or excluded. Each dropped pair is listed with the mode that is missing. |
| Mean difference | The mean of (first score minus second score) over the pairs. |
| Relative | The mean difference divided by the mean score of the second mode. If that mean is 0, it is "n/a". |
| 95% interval | A percentile bootstrap of the mean difference. Each of 10000 iterations draws tasks with replacement. All pairs of a drawn task go in together, so the two repetitions of a task stay together. The generator is mulberry32 with the fixed seed 20261122. Fewer than two tasks give no interval. |
| Win, tie, loss | Pairs where the first mode scored higher, equal, or lower. |
| Regressions | The pairs where the first mode scored lower. |
| Sensitivity | The mean difference with one task left out, for each task. The report gives the task with the largest change. |

The interval describes this sample only. It is not a significance test.

## Overhead

For each mode against the baseline (A, or B when there is no A): the difference of the per-run means of each token field, of the tool calls and of the duration, and that difference as a percent of the baseline mean. The per-run means come from the cost table. The estimated feedback tokens per run are the mean clock feedback bytes divided by 4. That is an estimate, not a tokenizer count. The section also gives the mean total tokens of a stage turn and of a run for each mode, and the stage turn difference against the baseline.

## Differing cases

A differing case is a `(taskId, rep)` where at least two modes are in the accuracy numbers and their per-question results differ. When the batch has C and D, only a difference between C and D makes a case. Else, when the batch has E and F, only a difference between E and F makes a case. Else, when the batch has F and H, only a difference between F and H makes a case. A question counts as wrong in a run that did not complete. For each mode, the case lists:

- the run id, status and score,
- each wrong question with the given value, the expected value from the key, the aspect, the error category and the pre-compaction flag,
- the `establishedBy` events with their stage and summary from the key,
- for each wrong question, the retrieval facts: needed events, events seen before and after the last compaction, events never seen, needed chunks, cut chunks, follow-ups, a noted gap, and the error class,
- the clock telemetry: feedback count and bytes, commit calls, status calls, compactions, unconfirmed compactions and guard denials,
- for each wrong question with a text answer, `inSummary` and `inBlock` from `coverage.json`,
- the assistant mention counts.

The case id is `<taskId>__r<rep>`. A batch with more than one host puts `<host>__` in front. Each case has `classification: "unreviewed"` and `note: null` until `review.json` sets them:

```json
{
  "A1-db-overrides__r1": { "classification": "feedback_helped", "note": "..." },
  "recommendation": "Text for the Recommendation section."
}
```

A review key with no matching case is listed in the report. Without a `recommendation`, the report section says "Lead to complete."

## Retrieval and error classes

`retrieval.mjs` reads the host stream of each turn of the last attempt. An event is visible in a turn when its `[eNNN]` tag is in a tool result or in a user text of that turn. The task intro and the stage prompts are not in the stream, so they do not count.

A compaction is confirmed when `run.json` `compactions[i].confirmed` is true. If `run.json` lists no compactions, a `compact_boundary` line in the stream decides. Before means a turn before the last confirmed compaction turn. After means that turn or a later one, so the compaction summary counts as after. Without a confirmed compaction, both lists are empty.

The chunks of a task come from the `chunks` list of each stage. For an older task without that list, the analysis makes one chunk per staged file (`s<stage>:file:<path>`) and per feed (`s<stage>:feed:<name>`), with the events tagged in its content.

| Chunk fact | Rule |
|---|---|
| Requested | A tool call input names the file path, or names `feed.mjs <name>`. |
| Cut | A result of that call holds `searches the whole output`. |
| Follow-up | After a cut, a later call in the same turn is `ctx_search`, `ctx_execute` or `ctx_execute_file`, or names the feed with a pipe. |

Each wrong final question and each wrong probe gets one error class. The first rule that matches wins.

1. `tool_or_infrastructure`: the run did not complete.
2. `retrieval`: a needed event of stage 1 or later was never visible.
3. `compaction_recovery`: all needed events were visible, and one or more was visible only before the last confirmed compaction.
4. `state_tracking`: the grader reason is `stale`.
5. `reasoning`: another wrong value.
6. `indeterminate`: the answer is missing, malformed or null.

Stage-0 events come in the intro prompt, so rule 2 does not use them. They are visible only when a later tool result repeats their tag. For this reason, an intro event often counts as visible only before the compaction, and rule 3 matches.

A noted gap means an assistant text of a stage that holds a needed event uses one of the gap phrases in `GAP_PHRASES` (for example, output that was cut or truncated). `retrieval.json` also has `streamsFound`, `streamsExpected` and `assistantMentions`.

## Value coverage

`coverage.mjs` reads the raw streams of the last attempt. The compaction turn is the last `compact` turn of `run.json`, else the `compact-N.jsonl` file with the highest N.

| Field | Rule |
|---|---|
| Text answer | The key value is a string, or a list of strings. Other answers get no coverage entry. |
| `inSummary` | Every expected value is an exact substring of the host summary. The summary is the last user message of the compaction turn that starts with `This session is being continued`. |
| `inBlock` | Every expected value is an exact substring of the returned block. The block is the last text between `[committed-state]` and `[/committed-state]` in the `SessionStart` `hook_response` lines of the compaction turn. For a JSON hook output, the analysis reads `hookSpecificOutput.additionalContext`. With no block, the value is false. |
| `correct` | The run completed and the grade marks the question correct. |
| `statusCalls` | The `ctx_clock_status` calls in the probe turns and in the final turn. |

The report gives one table per mode with four cells: value in the summary and in the block, in the summary only, in the block only, and in neither. A real effect of the returned state shows in the cell "not in summary, in block".

## State correctness

`coverage.json` has one `stateCorrectness` entry for each compaction turn with a stream file. For compaction N, the analysis compares the block and the host summary of `compact-N.jsonl` with the reference state with `afterStage` N in `<tasks dir>/reference/<taskId>.state.json`. The block and the summary use the same rules as in "Value coverage".

| Field | Rule |
|---|---|
| Reference lines | The first line (`state after stage N`) is skipped. Each other line has the form `name: value`. A line whose name ends with ` history` is a history line, and each element between `, then ` is one value. Each other line is a current-value line, and each comma-separated element is one value. |
| `lines`, `historyLines` | The number of current-value lines and of history lines. `null` when the task has no reference state for that stage. |
| `found`, `historyFound` | The lines whose every value is an exact substring of the block. 0 when the compaction has no block. |
| `summaryFound`, `summaryHistoryFound` | The same count for the host summary of that compaction. |
| `blockFound`, `summaryPresent` | The compaction has a block, and a host summary. |

The summary pools the lines of all compactions with a reference state in one mode. It gives the share of found lines for the block and for the summary, and the block share for the compactions with a block only. A value that the block or the summary paraphrases counts as absent.

## Fact-level analysis

`facts.mjs` reads, for each compaction N of the last attempt: the reference facts with `afterStage` N, the state file copy `state-file-<N>.md`, the host summary of `compact-N.jsonl`, and the returned block of that turn. `facts.json` holds statuses and sizes only, never text of a summary, a block or a state file.

| Rule | Definition |
|---|---|
| Normalization | Lower case. Backticks, quotes and asterisks removed. Spaces folded. A final period removed. |
| Set values | Outer brackets removed, then a split on commas, semicolons, pipes, "and" and "plus". "none", "(none)", "-", "empty", "[]" and an empty value are the empty set. The order of the elements does not matter. |
| Name tokens | Lower case, then a split on every character that is not a letter or a digit. Stop words removed: of, for, the, in, a, an, to, is. Synonyms mapped to one token: owner, owning, owned are `owner` (with "team" next to it removed); deps, dependency, dependencies, depends are `deps`; oncall, on-call, "on call" are `oncall` (with "engineer" after it removed); db, database are `db`; hours, hrs are `hours`; kb; id. Plurals folded to the singular ("locales" is "locale"), except words that end in ss, us, is or ies. "flag" and "migration" are optional tokens. |
| Name match | The entity of a reference name is the tokens after "of" or "for" ("parcel-track" in "owner of parcel-track"). A line name fits a fact when it holds every entity token, and when every non-optional token of the shorter side is on the other side. Words joined by "-" or "_" must stay whole: "m1" does not fit "team-m1" or "m10". The fact with the highest token overlap wins, then the fact with fewer extra tokens. A tie between two facts gives no fact and marks both ambiguous. |
| State file and block lines | Each line `name: value`, after list and bold marks. A name whose last word is `history` is the history line of that fact. When two lines fit the same fact, the line with fewer extra tokens wins ("usage-metering: ON" over "snap-c9 usage-metering: OFF"), and on a tie the later line wins. A fact with only a history line has the last element of that line as its current value. A set fact with no line of its own can be stated by membership lines ("locale fa-IR: supported", "locale en-AU: not supported"). |
| Current status | `correct`: the exact value, a set in any order. `formatted`: equal only after normalization (case, quotes, backticks), or after a trailing note in parentheses is removed. `stale`: equal to an earlier value that differs from the current value. `incorrect`: another value. `missing`: no line fits the fact. `absent`: no file or no block. |
| History status | Against the reference history (the earlier values in order, a value can occur twice), with or without the current value at the end, split on ", then", "then", "->" or "=>". `stale`: only the first earlier values. `null` when the fact has no history. |
| Summary units | The lines of the summary, code block lines too, each split into sentences. A value counts only as whole tokens: "5" does not match "15". |
| Summary status | Each unit goes through three rules, in this order. First, a grouped line: a heading with the relation tokens, then items that start with the entity ("Owners: parcel-track = team-customs; geo-fence = team-routing"). Second, a unit of the shape `name: value`, matched by the name rule above. Third, prose: each occurrence of all name tokens (or the name without its first word, when no other fact has those words) reads the text after it, up to the next name of any fact. When that text holds no known value, the whole unit counts. A set also reads the wrapped list lines after the unit. `correct`: an occurrence holds the current value. `stale`: occurrences hold only earlier values. `missing`: no name, or no known value. The summary has no `formatted` status. History: every earlier value in a unit with the name is `correct`, only the first ones is `stale`, others are `incorrect`. |
| Which rule decides, and ambiguous cases | In a state file or a block, the name match decides. In a summary, the first of the three rules that finds the fact decides. The analysis keeps a fact as ambiguous, with a reason, and gives it no `correct` mark from that line, when: a line name ties between two facts ("a line name ties with another fact"), a summary name ties ("a name ties with another fact"), or every occurrence in a summary unit holds both the current and an earlier value, for example "m1 failed in stage 1 and applied in stage 3" ("current and earlier value in the same unit"; the status is then `correct`, and the report lists the case). |
| Question join | For each final and probe question whose key has `fact`: the statuses of that fact (current or history part) at the last compaction before the question (for a probe, at or before its `afterStage`). `changedAfterLastCompaction`: the key `lastChangedStage` is greater than that stage. |
| Anchoring candidate | The run completed, the answer is wrong, the block or the state file is `stale` or `incorrect`, and the summary is `correct` or `formatted`. |
| State file reads | Each Read, Grep or Bash call whose input names `clock-state.md`, with its turn and whether a compaction came before it. |

The report also gives a completed-only paired table next to the primary one (the primary table counts a valid run that did not complete as score 0), the difference for each pair, and a note when the batch has fewer than 6 tasks: the bootstrap interval over tasks is then coarse.

## v0.7 measurements

These measurements follow EXPERIMENT-V07.md "Measurements". Modes N (standing instruction), T (threshold reminder) and P (summarizer instruction) have labels. Comparisons come from the suite. Without a suite list, the defaults are N-B, T-B, P-B, L-B, N-L, T-L and P-L. Every per-compaction table works for any number of compactions. A field that a run does not have shows n/a.

| Measure | Definition |
|---|---|
| Text values | A text value with two or more content words (a reason or a condition) is `formatted` when the content words, without the name stop words, are the same and in the same order. For example, "Only while region = EU" is `formatted` for "only while region is eu". Reason and link fact names ("reason for api-gateway", "condition of feature-x") use the same token rule as other names. |
| stagesSinceWrite | This field is in `facts.json`, for each compaction. It is the compaction stage minus the last stage at or before it in `run.json` `telemetry.stateFile.writeStages`. It is null with no such write, or when `writeStages` is absent. |
| Freshness per mode | The share of compactions with a state file copy. The distribution of stagesSinceWrite (0, 1, 2 or more, none), only for runs with `writeStages`. The share of reference facts that the file holds (state file status `correct` or `formatted`) for each value of stagesSinceWrite. Writes per stage, and the write stages of each run. |
| Standing deliveries | `telemetry.triggers.standing.deliveries` per run (a number or a list). |
| Reminders | Each item of `telemetry.triggers.reminder.fired`, with its turn and stage. A numeric turn is an index into `run.json` `turns`. A text turn gives its last number ("stage-6" is stage 6). Each item also has its estimate, its threshold, the `preTokens` of the first compaction at or after its stage, and the difference (estimate minus `preTokens`). Reminders per compaction: the reminders with a stage after the previous compaction and at or before this one (0, 1, more). Also the reminders after the last compaction, and the sum of `unreadable`. |
| PreCompact deliveries | `telemetry.triggers.precompact.deliveries` divided by the confirmed compactions of the run. |
| PreCompact in the stream | `precompactHook` in `facts.json`, for each compaction. It holds the `hook_response` lines with `hook_event` PreCompact in the compact stream: their count, the bytes of their standard output, and how many ended with `outcome` success. It is null when the stream has no such line. |
| Early wrong reading | The `earlyWrong` field of a final question in `facts.json`. A wrong answer of a completed run gives `true` when the fact (current or history part, from the key fact link) is `stale` or `incorrect` in the state file or in the summary at the first compaction at or after the key `lastChangedStage`. Without a stage, the first compaction counts. The field is `false` when both statuses are known and neither is wrong. It is null for correct answers, probe questions, runs that did not complete, and when no status is known. The summary counts it per mode, next to the wrong final answers with a fact and the anchoring candidates among them. |
| Calibration view | Only for a batch with modes B and L and no other mode. The view gives the mean score of B and of L for each task, a flag where L is at 1.00, and whether L is at 1.00 in 5 or more tasks. |

## v0.8 measurements

These measurements follow EXPERIMENT-V08.md. Modes U (periodic reminder) and Q (stronger summarizer instruction) have labels. Q is a PreCompact arm in the trigger records, as P is. Without a suite list, the comparisons are N-B, U-B, Q-B, U-N and Q-N. A batch whose `batch.json` suite starts with `v08` gets the `v08` block in `summary.json` and the sections below. Other batches keep the same bytes.

| Field of `summary.v08` | Definition |
|---|---|
| `deniedRuns` | Runs whose grade is valid although `integrity.violations` is not empty: the grader kept them valid because the guard denied every attempt (graders/README.md, "Denied attempts"). The count for each mode, and each run with its violations, denied calls and guard denials. These runs stay in the primary tables. |
| `oldRule` | The accuracy per mode (runs in accuracy, invalid runs, mean score, success rate) and the paired comparisons of the final score under the old rule, where a run with any violation is invalid. |
| `cost` | Means per run over the runs in the accuracy numbers: tool calls, tokens (`telemetry` token fields) and saves (`telemetry.stateFile.writeStages`, else `writes`). Added tool calls and added tokens are against B. Added tokens for each added call: added tokens divided by added tool calls, null when the mode adds no call. Cost in dollars: the mean and the sum of `telemetry.costUsd`, null when no run has it. |
| `periodic` | From `telemetry.triggers.periodic`: for each run, the user messages that held the reminder (`n`, the turn, and the stage of that turn), the count of user messages (`prompts`), and the save stages. The report section repeats the stagesSinceWrite rows of the freshness section. |
| `decision` | For U-N, Q-N, R-N and R-Q: the paired mean difference of the final score with its interval, the summary coverage of each mode (share of reference facts with summary status `correct` or `formatted`), the difference in points, the added tokens per run against B of each mode, and the ratio of the first mode to the second. With the `not assigned` status, `summaryCoverageAssigned` gives the coverage over the assigned facts. The helper gives numbers only and no verdict. |

From v0.9, a batch whose suite starts with `v` and a version of 08 or more (`v08`, `v09`) gets this block.

## v0.9 measurements

Probes after automatic compactions (part 2): the grade of such a task has `checkpoint.asked` and an `asked` flag on each item (graders/README.md). The probe accuracy, the paired probe comparison and the tables per shape then count the asked questions only. The paired probe comparison is per run, because arms can compact at different stages. The error classes and the question join of `facts.json` leave out the probes that were not asked. For other tasks the numbers stay the same.

These measurements follow EXPERIMENT-V09.md. Mode R (general summarizer instruction) has a label. R is a PreCompact arm in the trigger records, as Q is. If the suite starts with `v09` or the batch has mode R, the default comparisons are N-B, Q-B, R-B, R-N and R-Q, and no other default list is added. A suite list in `batch.json` or in the suite configuration still takes priority.

The fact matcher changed in two ways:

1. A summary line whose name ties between facts gets a second try. The matcher adds the heading of its section to the name. An example is "geo-index: team-pricing" under the heading "Owners (team per service):". If the second try gives one of the tied facts, the line counts for that fact. A heading line is a markdown heading, or a line that ends with its only colon. A short line that is not a list item and comes before a list is also a heading line.
2. A fact that the matcher cannot assign gets the status `not assigned`, in the summary, the state file and the block. It does not count as `missing`.

The fact status tables show the `not assigned` row in two cases: the suite is v08 or later, or a `facts.json` of the batch holds the status. Other batches keep the v0.6 rows and the same bytes. With the row, each table also gives the facts held (`correct` or `formatted`) over all facts and over the assigned facts.

A batch with a v08 or later suite gets the `v09` block in `summary.json` and the sections below.

| Field of `summary.v09` | Definition |
|---|---|
| `shapes` | The task shapes of the batch: `old`, `worklog`, `decision`, then other names. The shape is the task field `shape`. A task without the field has the shape `old`. |
| `byShape` | For each shape: the tasks, a table for each mode, and the paired comparisons of the batch over the tasks of that shape. The table of a mode holds the runs in accuracy, the invalid runs, the mean score and the success rate. It also holds the post-compaction accuracy, the probe accuracy and the fact status tables. |
| `summaryBytes` | For each mode, over the runs in the accuracy numbers: the count of host summaries and their mean, minimum and maximum length in bytes. The length comes from `facts.json` `compactions[].summary.bytes`. The mean is also given for each shape. |
| `compactions` (part 2) | `perMode` gives, over the runs in the accuracy numbers, the marked compactions per run, the mean `preTokens` and the probe accuracy over the asked questions of the rows. A probe list in the task checkpoint gives each probe question the stage of its probe. |
| `compactions` | One row for each compaction that the host marked (`run.json` `compactions[]` with `confirmed` true). A row gives the trigger kind (the runner field `trigger`, or null), the context size before it (`preTokens`), and the probe accuracy after it. The probes after a compaction are the probe questions from its stage up to the stage of the next marked compaction. Each run also has a run row with its count of marked compactions, which can be 0. |

## v0.10 measurements

These measurements follow EXPERIMENT-V10.md. Mode V (general summarizer instruction with line format) has a label. If the suite starts with `v10` or the batch has mode V, the default comparisons are V-R, V-Q and R-Q, and V-R is the primary comparison. A suite list in `batch.json` or in the suite configuration still takes priority. The paired tables, the tables per shape and the summary length table cover mode V with no other change.

The decision helper (`summary.v08.decision`) has the rows V-R and V-Q. Each V row adds these fields:

| Field | Definition |
|---|---|
| `summaryHistoryCoverage` | For each mode, the share of facts with earlier values whose summary history status is `correct` or `formatted`. |
| `summaryHistoryCoverageDiffPoints` | The difference of that share in points, first mode minus second. |
| `summaryMeanBytes`, `summaryBytesRatio` | The mean length in bytes of the host summaries of each mode, and the ratio of the first to the second. |
| `byShape` | For each task shape, the summary coverage of the current values and of the earlier values of both modes. |

A batch with a v10 or later suite gets the `v10` block in `summary.json`. `v10.historyLines` counts, for each run and each mode, the host summaries that hold a line that matches `/^.*history: .+/m`. The flag comes from `facts.json` `compactions[].summary.historyLine`. The smoke batch needs at least one such summary.

The pooled comparison is a secondary table. The pool batches come from the `--pool <batch>[,<batch>]` option of `analyze.mjs`, which you can give more than once. Without the option, they come from the `batch.json` field `poolBatches`. The analysis reads only `batch.json`, `run.json` and `grade.json` of a pool batch. The `pooled` block of `summary.json` and the section "Pooled comparison" then give these items:

- The host version (`batch.json` `cli.version`) and the plugin build (`overlay.sourceSha`) of each batch.
- `pointerOnly`. It is true if the host version or the plugin build differs between the batches, or if one of them is not known. The report then says "Pointer only".
- The paired final score and probe accuracy for each comparison of the batch whose two modes have runs in every batch. For v10-full-01 with `--pool v09-full-01`, this is R minus Q. The pair key is batch, task and rep, and the `host` field of a pair holds its batch name. The bootstrap resamples tasks.

## Standalone plugin arms

These arms follow `docs/context-clock/PLAN-standalone.md`. Mode Z is the plain host with the standalone plugin, which prints the PreCompact text from a real plugin. Mode W is the plain host with the same text in `CLAUDE.md` and no hook. If a batch has mode Z or W and no comparison list, the default comparisons are Z-O, W-O, W-Z and Z-I, and Z-O is the primary comparison.

## Charts

| File | Chart |
|---|---|
| `success-rate.svg` | Task success rate by mode. |
| `score-by-category.svg` | Mean score by mode and task category. |
| `paired-diff-primary.svg` | Paired score difference per task for the primary comparison, as the mean over the repetitions of the task. |
| `token-overhead.svg` | Mean total tokens per run by mode, with the change against the baseline. |

Each chart has a white background and dark text, so it reads the same in light and dark viewers.

## Files

| File | Content |
|---|---|
| `analyze.mjs` | The command: loads the batch and writes the outputs. |
| `facts.mjs` | Fact-level analysis: parsing of state files, blocks and summaries, the statuses, the question join and the state file reads. Also a command that writes the derived files. |
| `coverage.mjs` | Value coverage: the host summary, the returned block, and the pure coverage record. Also a command that writes the `coverage.json` files. |
| `retrieval.mjs` | Stream reading, chunks, the pure retrieval record and the error classes. Also a command that writes only the `retrieval.json` files. |
| `metrics.mjs` | Pure metrics: classification, per-mode metrics, pairing, bootstrap, overhead, differing cases. |
| `report.mjs` | Pure `report.md` renderer. |
| `charts.mjs` | Pure SVG renderer. |
| `util.mjs` | Sorted-key JSON, the seeded generator, rounding and number formats. |

Tests are in `benchmarks/context-clock/tests/analysis/`. They use two hand-made fixture batches with known numbers: `fixture.mjs` (modes A, B, C, no streams) `fixture-v03.mjs` (modes B, C, D with raw streams, one case for each error class) `fixture-v04.mjs` (modes B, E, F, G with two compactions, commit and state block telemetry, and one case for each coverage cell) `fixture-v05.mjs` (modes B, F, H, S with reference states, state file telemetry and turn usage) and `fixture-v06.mjs` (modes B, J, H with schema 2 reference facts, state file copies, stream reads, turn cost, and a run at a limit).
