# Context Clock v12 harder tasks

This folder holds the harder set of phase 1b of `docs/context-clock/PLAN-standalone.md`. Opus 5.5 scored 0.981 on the six v0.9 tasks with no instruction text. The tasks of this set are harder to keep in a summary.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate".

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-hard
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-hard --check
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-hard --freeze
```

`--check` takes about 5 minutes. The specs are in `tasks/generator/v12.mjs`, after the comment "The harder set".

## How the tasks are harder

| Property | tasks/v09 part 1 | This set |
|---|---|---|
| Stages | 8 | 12 |
| Compactions | after stages 3, 5, 7 | after stages 2, 4, 6, 8, 10 |
| Tracked items (facts) | 16 to 27 | 30 to 48 |
| State changes for each stage | 4 to 8 | 12 to 18 |
| Distractors for each stage | 8 to 19 | 27 to 34 |
| Final questions | 9 or 10 | 12 |
| Material for each stage | about 12 KB | 12 to 14 KB |

- The old shape uses kind A and the reason kind F at difficulty 2. The v0.7 and v0.8 pools of each kind are merged, so that the task tracks about twice the items.
- Each worklog task merges two worklog pools. Each decision task merges two decision pools and records 8 reasons instead of 4.
- The update count is twice the rate of a v0.9 stage over 12 stages.
- The distractor rate is 1.6 instead of 0.9. Distractors are proposals, withdrawn drafts, archived copies and quotes that name tracked items.
- A hook adds history questions of depth 3 or more. One kind asks the value two values before the current value. The other kind asks every replaced value of an item with at least 3 replaced values. Each task has at least 3 such questions.
- In the old shape, three items that a current-state question asks keep their value after the first compaction. The worklog and decision builders already do this. The shared rules need at least 3 answers that are set before the first compaction and kept.

## The tasks

| Task | Category | Shape | Seed | Material bytes | task.json bytes | Facts | Final questions | Depth-3 questions | Probe questions | Deliveries |
|---|---|---|---|---|---|---|---|---|---|---|
| A14-platform-program | A | old | 2400000 | 144630 | 210508 | 32 | 12 | 4 | 6, 5, 6, 5, 6 | 52 |
| A14-media-observability | A | old (reasons) | 2425000 | 150712 | 221876 | 30 | 12 | 4 | 4, 6, 5, 6, 6 | 56 |
| W14-ledger-and-login | W | worklog | 2450000 | 152737 | 227719 | 48 | 12 | 3 | 6, 4, 4, 5, 6 | 61 |
| W14-search-and-ledger | W | worklog | 2475000 | 155593 | 232570 | 48 | 12 | 3 | 6, 5, 6, 6, 5 | 63 |
| X14-retention-and-release | X | decision | 2500000 | 164330 | 239058 | 39 | 12 | 3 | 6, 5, 4, 5, 4 | 64 |
| X14-edge-and-retention | X | decision | 2525000 | 161028 | 235464 | 40 | 12 | 3 | 5, 5, 5, 4, 6 | 64 |

## Run limits

A task has 52 to 64 deliveries, against about 35 in a v0.9 task. Each delivery is one tool call, so a run needs about 70 to 80 tool calls with the probe turns. The material is about 1.5 times the material of a v0.9 task. A plain Haiku run of a v0.9 task uses about 0.78 million tokens. The estimate for a run of this set is about 2 million tokens.

The current limits of 120 tool calls and 3 million tokens are enough by this estimate, with a small margin. A margin of 160 tool calls and 4 million tokens covers re-reads and a model that writes longer replies.

## What the tests make sure of

The tests are in `tests/tasks/v12-hard.test.mjs`.

- There are 6 tasks, 2 of each shape, with 12 stages and 5 compactions.
- By shape, the facts are 1.7 to 2.4 times and the changes for each stage 1.6 to 2.8 times the values of `tasks/v09`. The distractors for each stage are at least 1.8 times the v0.9 values.
- Each task has at least 3 history questions of depth 3 or more. The reason task and the decision tasks have at least 3 reason questions.
- The generator reproduces every file, and `FROZEN.json` has the SHA-256 and bytes of every file.
- The shared rules and the rules of the harder set pass. Each question has one correct answer, and the solver equals the key.
- No source line of a worklog or decision task has the form "name: value". The fact names are unique, and no key text is in a task file.
- The grader accepts each key value with no change.
