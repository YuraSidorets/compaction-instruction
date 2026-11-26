# Context Clock v0.9 tasks

This folder holds the 7 tasks of the v0.9 experiment. `EXPERIMENT-V09.md`, sections "Tasks" and "Part 2: automatic compaction", is the contract. Six tasks have three shapes of state. The seventh task is the long task of part 2.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate". A reviewer derives all answers from the material before the freeze.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v09.mjs
node benchmarks/context-clock/tasks/generator/v09.mjs --check
node benchmarks/context-clock/tasks/generator/v09.mjs --from-base --check
node benchmarks/context-clock/tasks/generator/v09.mjs --long-stages 24 --long-stage-bytes 24000
node benchmarks/context-clock/tasks/generator/v09.mjs --freeze
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--from-base` searches each seed from its base seed again, instead of from the recorded seed.
- `--long-stages` and `--long-stage-bytes` set the stage count and the material of one stage of the long task. The defaults are 24 stages and 24000 bytes. Other values give other files for the long task only.
- `--freeze` writes `FROZEN.json` with the status "candidate", and `HEAD` becomes the generator commit. Use the same long-task options as for the files.

After the calibration batch, W12-search-revamp and X12-edge-rollout had a baseline score of 0.4, below the range 0.5 to 0.8. Each got one new base seed and a new id: W12-shop-search and X12-cdn-migration. The generator, the pools and the parameters did not change. The files of the two old tasks are removed, and the other five tasks did not change.

The specs, seeds and value pools are in `tasks/generator/v09.mjs`. The builders of the new shapes are `tasks/generator/builders/w-worklog.mjs` and `tasks/generator/builders/x-decisions.mjs`.

## The tasks

Every task has 2 or 3 large feeds. Each `task.json` has the field `shape`, with the value "old", "worklog" or "decision".

| Task | Category | Shape | Base seed | Seed | Material bytes | task.json bytes | Facts | Final questions | Probe questions |
|---|---|---|---|---|---|---|---|---|---|
| A12-mobile-gateway | A | old | 1900000 | 1900034 | 97569 | 139931 | 16 | 9 | 5, 6, 6 |
| D12-backup-policy | D | old | 1925000 | 1925001 | 95074 | 135780 | 16 | 9 | 4, 4, 5 |
| W12-ledger-migration | W | worklog | 1950000 | 1950000 | 101101 | 147189 | 27 | 10 | 5, 6, 6 |
| W12-shop-search | W | worklog | 1985000 | 1985000 | 99143 | 144061 | 27 | 10 | 5, 4, 6 |
| X12-data-retention | X | decision | 2000000 | 2000000 | 100536 | 144979 | 19 | 10 | 4, 6, 5 |
| X12-cdn-migration | X | decision | 2035000 | 2035000 | 102574 | 147891 | 20 | 10 | 4, 6, 6 |
| A13-long-mobile-platform | A | old | 2050000 | 2050000 | 557386 | 781533 | 16 | 9 | 4 to 6 at each of 23 boundaries |

The six tasks of part 1 have the profile `compaction`, 8 stages and a compaction after stages 3, 5 and 7. A probe turn follows each compaction. Their size and difficulty parameters are the ones of `tasks/v08`.

A12-mobile-gateway comes from the v0.8 generator of kind A, and D12-backup-policy comes from the v0.8 generator of kind D. Both use the v0.8 pools with new seeds.

## The two new shapes

The new shapes keep the structure of the old tasks: notes, tickets and feeds in each stage, distractors, large feeds and probes. Only the kind of state changes. In both shapes, the source material states each fact in prose. No source line has the form "name: value". Each fact has one exact answer: a name, a path, a number or one state of a fixed set.

State changes come only from deciding events. The distractors are the kinds of the old tasks:

- A proposal with no decision.
- A draft that its author withdraws.
- An archived copy of an old page, dated by the entry that it copies.
- A correction: a wrong note, then an entry that corrects it.

The intro of each task states the rules, the fixed states and the meaning of "at some point" and "directly before".

### Worklog (kind W)

The state is a list of work items and a list of files.

- A work item has a status (`opened`, `closed` or `reopened`), one owner and at most one blocking item. The value `no-blocker` means that no item blocks it.
- When an item closes, the items that it blocked lose their link in the same stage.
- A file has a status (`draft`, `reviewed`, `merged` or `reverted`).
- Two owners and one file change only up to the first compaction. Their answers are set early and kept.

The questions ask for these facts:

- The current status, owner and blocking item of an item, and the items that one item blocks.
- The owner or the file status directly before the current one, and the earlier statuses of a file.
- The merged files, the count of closed items and the owner in the initial specification.

### Decision record (kind X)

The state is a set of decisions with reasons, constraints of the user and open questions.

- A decision has a value from a fixed list, and one decision is a number. Four decisions have a recorded reason from a closed list of reason ids.
- A later entry can replace a decision, or only its reason. A new decision with no reason entry keeps the earlier reason.
- The user sets a constraint (`in-force`) and can lift it (`lifted`).
- An open question has the answer `still-open` until an entry answers it. One question stays open.
- One reason, one constraint and one answer change only up to the first compaction.

The questions ask for these facts:

- The current decision and its earlier values, the number decision and a decision in the initial specification.
- The current reason of a decision, and the reason directly before the current one.
- The constraints in force, and whether one constraint is lifted.
- The answer of an open question, and the questions with no answer.

The reference machine has one new query for both shapes. The query `previous` gives the value directly before the current value of an item.

## The long task

A13-long-mobile-platform is the task of part 2. It comes from the v0.8 generator of kind A.

- It has the profile `long`. No stage has `compactAfter` true, so the runner sends no `/compact`.
- It has 24 stages. A stage holds about 23 KB of material, which is about twice the 12 KB of a v0.8 stage.
- The update count grows with the stage count, so that each stage has about as many changes as a v0.8 stage.
- `checkpoint.timing` is `after_auto_compaction`. `checkpoint.probes` has one probe for each stage boundary, after stages 1 to 23. The runner asks a probe only after a boundary where the host compacted by itself.
- The reference file has one state for each stage boundary.
- The task has more than 999 events. Its event labels have four digits, for example `[e1234]`, and its intro says so. All other tasks keep labels with three digits.

## Points for the other packages

- The runner (`runner/plan.mjs`), the analysis (`analysis/metrics.mjs`) and `fixtures/schema.mjs` accept only the categories A to E. The new categories W and X need an entry there.
- The current `runner/plan.mjs` reads a checkpoint with a timing other than `after_compaction` as one turn after `checkpoint.afterStage`. The mode with no `/compact` must read `after_auto_compaction` and ask a probe only after an automatic compaction.
- `fixtures/schema.mjs` reports the known v0.8 problems for the six tasks: 3 compactions and 9 or 10 final questions. For the long task, it reports that a task with the profile `long` must have no checkpoint.

## What the tests make sure of

The tests are in `tests/tasks/v09.test.mjs`.

- There are 7 tasks with the ids, categories and shapes above. The six tasks of part 1 have 8 stages with compactions after stages 3, 5 and 7.
- The long task has 24 stages and no compaction. It has a probe of 4 to 6 questions at each boundary and about twice the material of a v0.8 stage.
- A run of the long task with other parameters gives the asked stage count and size.
- The generator reproduces every committed file. The same seed gives the same bytes for both new generators, and another seed gives other bytes.
- `FROZEN.json` has the status "candidate" or "frozen", the shape, and the SHA-256 and bytes of every file.
- Each question has exactly one correct answer of its type, and the solver equals the key.
- No source line of a new shape has the form "name: value", and each state event states its fact in a sentence.
- The fact names of each reference state are unique, and each fact link names a fact of the reference file.
- No key text is in a task file, and the grader accepts each key value with no change.
- The v08 files still match their `FROZEN.json`.
