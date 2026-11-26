# Context Clock v12 work-result tasks

This folder holds the work-result set of `docs/context-clock/PLAN-standalone.md`, step 2.6. The set has 3 small tasks that end in code. Hidden tests decide the score of a run.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders. The hidden tests are in `keys/<taskId>.tests.json`, and the reference solution is in `reference/<taskId>.solution.mjs`.

The status of the set is "candidate".

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v12work.mjs
node benchmarks/context-clock/tasks/generator/v12work.mjs --check
node benchmarks/context-clock/tasks/generator/v12work.mjs --freeze
node benchmarks/context-clock/graders/work-tests.mjs --batch <name>
```

The generator is `tasks/generator/v12work.mjs`. The grader of the hidden tests is `graders/work-tests.mjs`.

## How a task works

Each task has a small code base in `workspace.files`, a list of `{ path, content }`. The runner writes these files into the workspace before stage 1 and never removes them. The code base has a project README, the README of one module with its fixed rules, and a stub of the module.

The values of the requirements arrive and change over 8 stages, with compactions after stages 3, 5 and 7. As in the other tasks, the runner removes the material of each stage at the end of the stage.

- A change replaces a value, turns a rule on or off, or adds or removes an item of a list.
- One change corrects a typo in an earlier entry of the same stage.
- In stage 4 or later, an item is added to a list. This is the added constraint.
- Distractors name the requirements but change nothing: proposals, withdrawn drafts, archived copies and rules of another team.
- Three items keep their value from stage 3 on, so the module needs values from before the first compaction. Two items change in stage 6 or later.

The task has no final question. `final.questions` is empty, and `final.prompt` asks the agent to write the module with the current requirements. `workspace.collect` names the module folder. The runner copies it to `results/<batch>/runs/<runId>/workspace/` before it deletes the workspace.

## The tasks

| Task | Module | Function | Seed | Requirements | Material bytes | Hidden tests |
|---|---|---|---|---|---|---|
| K13-shipping-quote | `src/shipping/quote.mjs` | `quote(order)` | 2700000 | 6 | 45282 | 15 |
| K13-password-policy | `src/accounts/password-policy.mjs` | `checkPassword(password, context)` | 2725000 | 7 | 47194 | 17 |
| K13-retry-policy | `src/http/retry-policy.mjs` | `retryDelay(status, retry)` | 2750000 | 6 | 48879 | 16 |

The material is about half of the material of a `tasks/v12` task, so a run is shorter.

## Hidden tests

The generator makes the tests from the module logic and the current requirements:

- For each replaced value of each item, a case where the output with that value differs from the output with the current value.
- For each item, up to 3 cases with values that the item never had. These cases check the current value.
- 5 general cases.

The reference solution passes every case. A solution with one replaced value fails at least one case. A solution with the initial requirements passes at most 70% of the cases. The score of a run is passed cases divided by all cases.

## The grader

`graders/work-tests.mjs` grades the work runs of a batch. A work task is a task with `workspace.collect` and an empty `final.questions`. For each work run, the grader does these steps:

1. It reads the hidden tests of the task.
2. It runs the module of the collected workspace copy in a child process.
3. It writes `grade.json` next to `run.json`, with the score in `score` and each case in `work.cases`.

The child process has the collected folder as its working folder, a timeout of 20 seconds, and a small environment. If Node has the permission model, the child can read only the collected folder. It cannot write, start processes or workers, or use the network. The tests reach the child on stdin. The module never gets them as a file.

The grader uses the validity rule of `graders/grade.mjs`, with the same exported functions. Thus both graders decide the same:

- A record of a path inside the workspace is not a violation (`violationsOf`).
- For a suite of v08 or later (`usesDeniedRule`), the grader reads the raw streams of the run. If the guard denied each outside attempt (`deniedViolations`), the run stays valid. The guard log must also hold at least as many denials as the denied calls.
- For an older suite, any violation makes the run invalid.

A valid completed run gets the score of the hidden tests. An invalid run gets the score 0. With the v08 rule, the grade records `validityRule` and `deniedAttempts`. The option `--raw-dir <dir>` names a raw folder outside the batch.

Run the grader after `graders/grade.mjs`, because for a work task it replaces the `grade.json` of `grade.mjs`.

## What the tests make sure of

The tests are in `tests/tasks/v12-work.test.mjs`.

- There are 3 tasks of category K and shape "work", each with 8 stages and compactions after stages 3, 5 and 7.
- The tasks have no checkpoint and no final question.
- `workspace.files` holds the stub module, and `workspace.collect` names its folder. No stage file can overwrite the code base.
- No hidden test, key or solution text is in a task file.
- The generator reproduces every file, and `FROZEN.json` has the SHA-256 and bytes of every file.
- The reference solution scores 1. The stub and a missing module score 0. Each replaced value fails a case.
- A module that hangs times out, and a printed fake result does not count.
- A module that writes a file gets the score 0, and the file is not written.
- The files of the other v12 sets match their `FROZEN.json`.
