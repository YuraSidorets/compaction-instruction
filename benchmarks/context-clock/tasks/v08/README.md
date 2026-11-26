# Context Clock v0.8 tasks

This folder holds the 6 held-out tasks of the v0.8 experiment. `EXPERIMENT-V08.md`, section "Tasks", is the contract. The tasks come from the six v0.7 generators in `tasks/generator/v07.mjs`, at base difficulty 1. They use new base seeds, new slugs, and new names and values. No option value and no tracked item name of an earlier task set repeats.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate". The lead reviews each task for a second fair reading before the freeze.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v08.mjs
node benchmarks/context-clock/tasks/generator/v08.mjs --check
node benchmarks/context-clock/tasks/generator/v08.mjs --from-base --check
node benchmarks/context-clock/tasks/generator/v08.mjs --freeze
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--from-base` searches each seed from its base seed again, instead of from the recorded seed.
- `--freeze` writes `FROZEN.json` with the status "candidate", and `HEAD` becomes the generator commit.

The specs, seeds and value pools are in `tasks/generator/v08.mjs`. Each spec is the v0.7 spec of the same kind, with new pools, a new id, a new seed and a new lead text.

## The tasks

Every task has the profile `compaction`, 8 stages, 2 large feeds and a compaction after stages 3, 5 and 7. A probe turn follows each compaction. The structure, the rules and the question types are the ones of `tasks/v07/README.md`.

| Task | Category | Generator kind | Base seed | Seed | Bytes | Tracked items (facts) | Final questions | Probe questions |
|---|---|---|---|---|---|---|---|---|
| A11-mobile-backend | A | A | 1700000 | 1700003 | 97612 | 16 | 9 | 6, 4, 6 |
| A11-video-pipeline | A | reason | 1725000 | 1725005 | 95122 | 17 | 10 | 5, 4, 4 |
| B11-ride-hailing | B | B | 1750000 | 1750003 | 95540 | 36 | 9 | 5, 6, 5 |
| C11-insurance-claims | C | condition | 1775000 | 1775001 | 99538 | 24 | 10 | 6, 6, 4 |
| D11-storage-policy | D | D | 1800000 | 1800000 | 95012 | 16 | 9 | 6, 6, 5 |
| E11-loyalty-program | E | E | 1825000 | 1825000 | 99377 | 12 | 9 | 4, 6, 5 |

A11-video-pipeline holds the reason state. Five decisions each have a reason from the closed list `why-cost`, `why-latency`, `why-quality`, `why-licensing`, `why-scale`, `why-support` and `why-security`.

C11-insurance-claims holds the condition state. Three permit items each have a condition that ties them to a flag.

## Ids

The shared validator requires that a task id starts with its category letter. Two of the six generators have the category A, so A11-mobile-backend and A11-video-pipeline share the letter A. The other four letters are distinct.

The runner takes the first task in id order with a given prefix. Thus a suite with the prefix `A11` and a count of 1 takes A11-mobile-backend. To take the reason task, a suite names its full id.

## New names

The builders of categories A, C and E use the same labels for some items in every task set. A v08 pool sets a label suffix or a prefix, so that these names differ from the v07 names:

| Category | v07 name | v08 name |
|---|---|---|
| A | supported locales | supported locales of the app, supported locales of the player |
| C | migration m1 | claims migration m1 |
| C | active pricing table, live schema version | the same names with "for claims" |
| E | acceptance criteria, planned steps, completed steps, rejected approaches | the same names with "of the loyalty program" |

The options are active only for a pool that sets them. The outputs of the earlier task sets do not change. The condition id `always-allowed` and the migration statuses are rule words, and they repeat in every set.

## Key metadata

The v0.8 keys fix two faults of the v0.7 keys. The fix is in `tasks/generator/keyfix.mjs`. Only the v08 specs use it, so the v07 keys and hashes do not change.

- An "allowed now" answer cites the events that its current answer rests on. These are the last event that set the current condition and the last event that set the current value of its flag. If the condition is `always-allowed`, only the condition event is cited.
- An answer cites only events that can change a variable of its question. Before, a question with a value before any event cited the first event of the task. An example is "Is the approach X rejected?" for an approach that occurs in no event. Such an answer now cites the first event that sets its variable.

The value, the stale values and the fact link of an answer do not change. In the six tasks, the fix changes the cited events of 10 answers.

## Possible second readings

The checks of `tasks/v07/README.md` apply. The new labels add one point. A question can use a shorter name than the label. An example is "Which locales are supported now?" for the supported locales of the player. Each task has only one item of that kind, so the short form has one reading.

## What the tests make sure of

The tests are in `tests/tasks/v08.test.mjs`.

- There are 6 tasks with the ids above, 8 stages and exactly 3 compactions, after stages 3, 5 and 7.
- No seed, slug or option value of an earlier set repeats, and no fact name of tasks/v07 repeats.
- The generator gives the same files on each run, and it reproduces every committed file.
- `FROZEN.json` has the status "candidate" or "frozen", and the SHA-256 and bytes of every file.
- The solver equals the key. The reference state machine and the key fix give every answer.
- Each cited event can change a variable of its question. An "allowed now" answer cites the condition event and the flag event.
- The v07 files still match their `FROZEN.json`.
- Each reference file has schema 2 and one state for each compaction.
- No key text is in a task file, and the grader accepts each key value with no change.
