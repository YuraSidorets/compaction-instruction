# Context Clock benchmark grader

The grader compares the answers of one benchmark run with the answer key of its task and writes a grade record. It is deterministic. It makes no model call, reads no clock time and uses no random source. The contract is `../CONTRACT.md`, section "Grade record".

## Command

```text
node benchmarks/context-clock/graders/grade.mjs --batch <name> [--root <folder>]
```

The command reads these files. The base folder is `benchmarks/context-clock/`. With `--root`, the base folder is the folder you give.

- `tasks/generated/<taskId>.task.json`
- `tasks/keys/<taskId>.key.json`
- `results/<batch>/runs/<runId>/run.json`

It writes `grade.json` next to each `run.json`. A run folder with no `run.json` is skipped. If a `grade.json` already has the same bytes, the command does not write it again, so a second run changes nothing. The command prints one summary line, for example:

```text
graded 6 runs in batch b1: valid 4, invalid 2, success 2, mean score 0.933 over 3 valid completed runs (written 6, unchanged 0)
```

Exit codes: 0 when the batch is graded, 1 when the batch folder is missing, 2 for a usage error.

## Library

`grade.mjs` exports these functions:

- `gradeRun(task, key, run)` returns the grade record. It is pure and never throws. A malformed input gives an invalid grade with a reason.
- `gradeAnswer(question, answerKey, given)` returns `{ correct, reason }` for one answer.
- `gradeJson(grade)` returns the exact bytes of `grade.json`: two-space JSON and a final newline.
- `gradeBatch(root, batch)` runs the command logic and returns the counts.

## Grade record

```json
{
  "schema": 1,
  "runId": "claude__A1-db-overrides__C__r1",
  "status": "completed",
  "valid": true,
  "invalidReason": null,
  "success": false,
  "score": 0.8,
  "questions": [
    { "id": "q1", "type": "choice", "correct": false, "given": "postgresql", "reason": "stale",
      "aspect": "current_state", "errorCategory": "obsolete_decision", "preCompaction": true, "establishedBy": ["e005", "e046"] }
  ],
  "continuityErrors": { "obsolete_decision": 1 },
  "preCompaction": { "questions": 3, "correct": 2 },
  "checkpoint": { "questions": 2, "correct": 2 },
  "checkpointItems": []
}
```

The record has the fields of the contract plus these additions:

| Field | Meaning |
|---|---|
| `status` | The run status, copied from `run.json`. If the grader cannot read the run record, the value is `null`. |
| `questions[].type` | The question type from the task. |
| `questions[].reason` | `null` for a correct answer. Otherwise the reason it is wrong (see "Wrong reasons"). |
| `checkpointItems` | One entry per checkpoint question: `id`, `type`, `correct`, `given`, `reason`. `checkpoint` keeps the contract shape `{ questions, correct }`. |

If the task has no checkpoint (profile `long`), `checkpoint` and `checkpointItems` are `null`. `given` is a bounded copy of the answer. A long string is cut at 200 characters.

## Answer comparison

Normalization for strings: remove the surrounding space, then use lowercase.

| Type | Correct when |
|---|---|
| `choice` | The answer is a string. After normalization it is one of the options and it equals the key value. |
| `set` | The answer is a list of strings. After normalization and removal of repeated members, it is the same set as the key value. Order is ignored. A string instead of a list is wrong. |
| `int` | The answer is an integer, or a string with only an optional sign and digits (`"3"`, `" +3 "`). `3.5`, `"3.0"` and `"three"` are wrong. |
| `bool` | The answer is `true` or `false`, or the string `"true"` or `"false"` in any case. `"yes"` and `1` are wrong. |

The grader takes the question list from the task, in task order. It ignores extra answers in the run record.

## Clock text

If an answer holds clock text in place of a value, the answer is wrong. Clock text is a `[context-clock]` marker (any case), or a tick reference such as `tick=17`, `tick: 17` or `tick 17`. For a `set`, one member with clock text makes the answer wrong. Words such as "ticket" or "stick" are not clock text.

## Wrong reasons

| Reason | Meaning |
|---|---|
| `missing` | No answer, or `null`. A run with no final answer block has every answer missing. |
| `malformed` | The answer does not fit the question type. |
| `clock_text` | The answer holds clock text in place of a value. |
| `not_an_option` | A `choice` or `set` member is not one of the options. |
| `stale` | The answer is a value that was true earlier (see "Error taxonomy"). |
| `wrong_value` | A well-formed answer that is not the key value. |

## Error taxonomy

Each wrong final answer gets one continuity error category:

1. If the reason is `stale`, the category is `obsolete_decision`, whatever the key says.
2. Otherwise the category is the `errorCategory` of the key entry.

The answer is `stale` in these cases:

- `choice`, `int`, `bool`: the normalized answer equals a normalized entry of `staleValues`.
- `set`: the answer holds a member that is in `staleValues` and not in the key value. An entry of `staleValues` can also be a whole list. Then an answer that is the same set is stale.

The categories of the contract:

| Category | A wrong answer shows that the agent |
|---|---|
| `forgotten_requirement` | lost a requirement or constraint from earlier in the session |
| `obsolete_decision` | used a decision or value that a later event replaced |
| `wrong_relationship` | connected the wrong entities |
| `invalid_transition` | assumed a state change that the rules do not allow |
| `contradiction` | resolved conflicting information the wrong way |
| `lost_progress` | lost track of work that is done or still open |
| `repeated_work` | counted work again that was already done |

`continuityErrors` counts the categories of the wrong final answers, with keys in name order. Checkpoint answers are not counted. Errors are counted only for a valid run with status `completed`.

## Score and success

- `score` is the exact fraction of correct final questions, with no rounding.
- If every final question is correct, `success` is true. Otherwise it is false.
- A run that is not `completed` (`agent_failed`, `timeout`, `infra_failed`) gets `success: false` and `score: 0`. It keeps its `status`, so the analysis can report an `infra_failed` run apart from the accuracy numbers. Its questions are still listed, and its `continuityErrors` is empty.
- An invalid run gets `success: false` and `score: 0`. Its questions are still listed for the report, and its `continuityErrors` is empty.

## Pre-compaction questions

The grader finds the first compaction in `run.compactions` with `confirmed: true`, in record order. A compaction with `confirmed: false` never counts. Each question has a `firstEstablishedStage` in the key. If that stage is at or before the `afterStage` of the compaction, the question is pre-compaction. If the task or run profile is `long`, or no compaction has `confirmed: true`, no question is pre-compaction. The `preCompaction` block counts the pre-compaction questions and the correct ones among them.

## Probes after automatic compactions (v0.9)

This rule comes from EXPERIMENT-V09.md, part 2. It applies only to a task whose `checkpoint.timing` is `after_auto_compaction` and whose checkpoint has a `probes` list. Other tasks keep the old checkpoint shape and the same grade bytes.

- The runner asks a probe `{ afterStage, questionIds }` only after an automatic compaction. Then the run has a turn with `kind: "checkpoint"` and that stage. `askedProbeIds(task, run)` gives the ids of the asked questions.
- Each item of `checkpointItems` gets `asked: true` or `asked: false`.
- `checkpoint` becomes `{ questions, asked, correct }`. `questions` counts all probe questions of the task, and `asked` counts the asked ones. `correct` counts the asked questions with a correct answer.
- An asked question with no parsed answer counts as wrong. An answer to a question that was not asked does not count.

## Validity

A run is invalid in these cases. `invalidReason` gives the reason.

- `integrity.violations` is not empty. The reason names the count and the first violation.
- The run record is malformed. Examples: it is not an object, `schema` is not 1, or `runId` is missing. Other examples: an unknown `status`, a missing `answers` or `integrity.violations`, or `compactions` that is not a list.
- The run, task and key do not agree on `taskId`.
- The task has no valid final question list, or the key has no valid answer for a question.
- In the command only: `run.json` is not valid JSON, or the task or key file is missing.

The grader never throws for a bad input. It returns an invalid grade with `questions: []` for a record that it cannot grade.

### Denied attempts (v0.8, repaired in v0.9)

This rule comes from EXPERIMENT-V08.md, "Change of the validity rule". If the `suite` of `batch.json` starts with `v` and a version of 08 or more (`v08`, `v09`), the command uses this rule. Older batches keep the rule above, and their grade files keep the same bytes.

If the guard denied each violation of a run, the run stays valid. `deniedViolations(violations, streams)` decides this from the raw streams of the last attempt folder: `results/<batch>/raw/<runId>/a<n>/<turn>.jsonl`, or the folder that `--raw-dir` names.

1. Some excerpts are a part of a regular expression literal in code, not a path. Examples are `\n/g,` and `]{0,160}`. The grader counts them in `notPaths`, and they need no denial. `isRegexLiteralExcerpt(excerpt)` finds them: an escape letter followed by the closing slash and flags, or a counted quantifier.
2. Each other violation `{ turn, tool, excerpt }` belongs to every call of the same tool in the stream of its turn whose input matches the excerpt. In the excerpt, each placeholder of the runner redaction matches any text: `<repo>`, `<workspace>`, `<data>`, `<overlay>`, `<work-root>` and `<home>`. A backslash counts as `/`, and a run of slashes counts as one. One call can thus hold several violations.
3. If the tool result of a call has `is_error` true and its text holds the guard reason, the call is denied. The guard reason is "This path is outside the task workspace and is not available."
4. If a violation belongs to at least one call and each of those calls is denied, the violation is denied. If the turn has no stream or no call matches, the violation is not denied.
5. If each violation is denied or is not a path, the run stays valid. If `telemetry.guard.denied` exists, its value must also be at least the number of denied calls.
6. A run with one violation that was not denied is invalid. `invalidReason` then names the count that was not denied and the first such violation. A call outside the workspace that got a real result thus keeps the run invalid.

A grade under this rule also has `validityRule: "v08"` and `deniedAttempts: { violations, notPaths, denied, calls, allDenied }`.

The v0.9 repair changed two things. First, a path in a string literal of code ("C:\\Users") now matches its excerpt, because a run of slashes counts as one. Second, regular expression literals no longer count as paths. Before the repair, run `claude__D11-storage-policy__U__r2` of `v08-full-01` was invalid with "2 not denied". Its one call was denied, so it is now valid.

### Paths inside the own workspace

On Windows, the runner scan compares a Git Bash path such as `/c/Users/<user>/.../ws-<runId>-a1-<suffix>` with the Windows form of the workspace. It thus records the agent's own workspace as a path outside the workspace. The redaction of `run.json` then turns the excerpt into `<workspace>`. Under both validity rules, the grader drops such a record before it decides validity. `isWorkspaceExcerpt(violation)` finds it:

- The reason is "path outside the workspace".
- The excerpt is `<workspace>` alone or `<workspace>/<part>`, with a backslash counted as `/`.
- No part of the excerpt is `..`.

A real outside path in the same form, such as `/c/Users/<user>/secret`, does not start with `<workspace>` and stays a violation. If the grader drops a record, the grade adds `insideWorkspace` with the count: in `deniedAttempts` under the v0.8 rule, else at the top level. Other grades keep the same bytes. The first such run was `claude__W13-late-ledger-cleanup__Z__r3` of `v12-noharm-01`, with 14 records of this kind.

### Written code and quote escapes

The runner scan reads the JSON text of the whole tool input. Two kinds of its "path outside the workspace" records are thus false. The function `falseRecordsOf(violations, streams)` finds them in the raw stream of the turn. Under the v0.8 rule, `grade.mjs` and `work-tests.mjs` drop them before the denied-attempt rule:

- `codeText`: a record of a write tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`). Its excerpt matches a call of that tool in its turn. It matches no target path of such a call (`file_path`, `notebook_path`, `path`). The excerpt then comes from the written code, for example a relative import (`../config/defaults.json`) or a regular expression. Only the target path decides. A target path outside the workspace gives its own record, which matches the target path and stays.
- `quoteEscape`: a record of another tool whose excerpt is one letter, a colon and a backslash (`v:\`). No string of the matching calls holds that letter followed by a colon and a slash or backslash. The backslash is then the JSON escape of a quote in code text such as `{v:"1"}`. A real drive root such as `dir C:\` stays a record.

If the turn has no stream or no call matches, the record stays. If the grader drops a record, `deniedAttempts` adds the count of each kind. The first such runs were 4 runs of `v12-rules-calib-haiku-01`.

## Tests

```text
node --test benchmarks/context-clock/tests/graders/
```

The fixtures in `tests/graders/fixtures/` are hand-made: one task with the `compaction` profile and a checkpoint, one task with the `long` profile, their keys, and a base run record. The tests cover these areas:

- Each answer type, normalization and missing answers.
- Stale detection and clock text.
- Pre-compaction flags and checkpoint grading.
- Invalid and failed runs.
- Determinism, and the command on a temporary batch folder.
