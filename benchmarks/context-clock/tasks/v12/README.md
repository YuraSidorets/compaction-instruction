# Context Clock v12 tasks

This folder holds the tasks of step 2.1 of `docs/context-clock/PLAN-standalone.md`. Package 1 has 10 tasks from new seeds of the three v0.9 shapes. The shapes are described in `tasks/v09/README.md`.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate".

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v12.mjs
node benchmarks/context-clock/tasks/generator/v12.mjs --check
node benchmarks/context-clock/tasks/generator/v12.mjs --from-base --check
node benchmarks/context-clock/tasks/generator/v12.mjs --freeze
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1. The check takes about 3 minutes.
- `--from-base` searches each seed from its base seed again, instead of from the recorded seed.
- `--freeze` writes `FROZEN.json` with the status "candidate", and `HEAD` becomes the generator commit.

The specs, seeds and pools are in `tasks/generator/v12.mjs`.

## The tasks of package 1

Every task has the profile `compaction`, 8 stages, 2 large feeds and a compaction after stages 3, 5 and 7. A probe turn follows each compaction. The size and difficulty parameters are the ones of `tasks/v09` part 1.

| Task | Category | Shape | Seed | Material bytes | task.json bytes | Facts | Final questions | Probe questions |
|---|---|---|---|---|---|---|---|---|
| A13-data-lakehouse | A | old | 2100060 | 95045 | 136592 | 16 | 9 | 4, 6, 5 |
| A13-mobile-checkout | A | old | 2125017 | 95301 | 136645 | 16 | 9 | 5, 6, 5 |
| D13-network-segments | D | old | 2150008 | 94816 | 136346 | 16 | 9 | 6, 4, 5 |
| D13-archive-policy | D | old | 2175005 | 94841 | 136996 | 16 | 9 | 6, 5, 6 |
| W13-billing-cutover | W | worklog | 2200000 | 99287 | 143982 | 27 | 10 | 4, 6, 5 |
| W13-catalog-search | W | worklog | 2225000 | 99723 | 144912 | 27 | 10 | 4, 5, 6 |
| W13-auth-migration | W | worklog | 2250000 | 100753 | 146136 | 27 | 10 | 6, 4, 5 |
| X13-log-retention | X | decision | 2275000 | 102325 | 146725 | 18 | 10 | 6, 4, 4 |
| X13-cdn-cutover | X | decision | 2300000 | 101162 | 145975 | 20 | 10 | 4, 5, 5 |
| X13-mobile-release | X | decision | 2325000 | 100901 | 145308 | 20 | 10 | 4, 4, 6 |

The base seeds are 2100000 to 2325000 in steps of 25000. No seed of an earlier set repeats.

Sources of the specs:

- A13-data-lakehouse and D13-network-segments use the v0.7 specs of kind A and D, with their pools.
- A13-mobile-checkout and D13-archive-policy use the v0.8 specs of kind A and D, with their pools.
- The worklog and decision tasks copy the v0.9 specs. Two tasks of each shape reuse a v0.9 pool. W13-auth-migration and X13-mobile-release have new pools.

The id number 13 also occurs in `tasks/v09/A13-long-mobile-platform`. No id of this folder repeats an earlier id.

## What the tests make sure of

The tests are in `tests/tasks/v12.test.mjs`.

- There are 10 tasks with the ids, kinds and shapes above, and no id or seed of an earlier set repeats.
- Each task has the settings of `tasks/v09` part 1.
- The generator reproduces every committed file, and `FROZEN.json` has the SHA-256 and bytes of every file.
- The shared and v0.9 rules pass. Each question has exactly one correct answer, and the solver equals the key.
- No source line of a worklog or decision task has the form "name: value". The fact names of each reference state are unique.
- No key text is in a task file, and the grader accepts each key value with no change.
- The files of `tasks/v09` still match their `FROZEN.json`.
