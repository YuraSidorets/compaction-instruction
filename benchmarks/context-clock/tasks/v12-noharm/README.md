# Context Clock v12 no-harm tasks

This folder holds the no-harm set of `docs/context-clock/PLAN-standalone.md`, step 2.5. The set has 3 tasks, one of each v0.9 shape. No answer of these tasks needs state from before a compaction. If there is no state to keep, the set shows whether the plugin lowers the score. The planned arms are O and Z.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate".

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-noharm
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-noharm --check
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-noharm --freeze
```

The specs are `V12_NOHARM_TASKS` in `tasks/generator/v12.mjs`, after the comment "The no-harm set".

## How the tasks are made

The tasks have the protocol and the material size of `tasks/v12`. Each task has 8 stages, with compactions after stages 3, 5 and 7.

A hook changes the normal task in four steps:

1. The hook drops the final questions over many items, for example "which work items are done". These questions move most of the task into stage 8 otherwise.
2. A question about the first value gets a new text without "specification" or "first page".
3. Each state event of an item that a final question asks moves to stage 8, after the last compaction. The events keep their order.
4. History questions about the asked items fill the task up to 8 final questions.

The items that no question asks change in stages 1 to 7 as in a normal task. Thus each compaction has state to summarize, but no question needs that state. The reference state after stage 7 holds none of the asked items.

The tasks have no probe. In this runner, a probe comes directly after a compaction. Thus its answer needs state from before that compaction.

## The tasks

| Task | Category | Shape | Seed | Material bytes | task.json bytes | Facts after stage 7 | Final questions | Deliveries | Stage 8 bytes |
|---|---|---|---|---|---|---|---|---|---|
| A13-late-data-platform | A | old | 2600000 | 99142 | 136242 | 10 | 9 | 36 | about 24000 |
| W13-late-ledger-cleanup | W | worklog | 2625000 | 100008 | 139282 | 20 | 8 | 37 | about 24000 |
| X13-late-backup-policy | X | decision | 2650000 | 104979 | 143749 | 12 | 8 | 37 | about 27000 |

The total material is in the v0.9 range of 92000 to 107000 bytes. Thus a run costs about as much as a `tasks/v12` run. Stage 8 holds about 2.5 times the material of the other stages, because the asked items arrive there. The stage can have up to 12 deliveries instead of 8.

## Generator changes

- If a compaction task has no checkpoint, `validate` in `generate.mjs` skips the checkpoint rules.
- If the spec has `coverage: false`, `generateTask` skips the coverage rules. The coverage rules need facts from the first third of the task.
- The v0.9 attempt in `v09.mjs` accepts a task with no checkpoint. If the spec has `coverage: false`, it skips the shared rules.

The earlier sets do not change. Their `--check` passes.

## What the tests make sure of

The tests are in `tests/tasks/v12-noharm.test.mjs`.

- There are 3 tasks, one of each v0.9 shape, with new ids and new seeds.
- Each task has 8 stages, compactions after stages 3, 5 and 7, no checkpoint, and 8 to 10 final questions.
- The runner accepts each task and plans no probe.
- No state event of an asked item comes before stage 8. The answers from the events of stage 8 alone equal the key.
- The items that no question asks change in each of stages 1 to 7.
- The generator reproduces every file, and `FROZEN.json` has the SHA-256 and bytes of every file.
- Each question has one correct answer, and the solver equals the key.
- No source line of a worklog or decision task has the form "name: value". The fact names are unique, and no key text is in a task file.
- The grader accepts each key value and rejects each stale value.
- The files of `tasks/v12`, `tasks/v12-hard` and `tasks/v12-indep` match their `FROZEN.json`.
