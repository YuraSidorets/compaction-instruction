# Context Clock v0.6 tasks

This folder holds the 4 held-out tasks of the v0.6 experiment. `EXPERIMENT-V06.md`, sections "Tasks" and "Interfaces", is the contract. The tasks come from the same families and builders as the earlier task sets. They use new recorded seeds, new slugs and new value pools. No content of `tasks/generated/`, `tasks/v03/` or `tasks/v04/` is reused.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v06.mjs
node benchmarks/context-clock/tasks/generator/v06.mjs --check
node benchmarks/context-clock/tasks/generator/v06.mjs --freeze
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--freeze` writes `FROZEN.json`, and `HEAD` becomes the generator commit. If the generator code is not committed or a file differs, it stops.

The specs, seeds, value pools and rules are in `tasks/generator/v06.mjs`. All v06 changes of the shared generator are active only for a spec with the field `v06`. The outputs of the earlier task sets do not change.

## The tasks

Every task has the profile `compaction`, 7 stages, 2 large feeds and a compaction after stages 4 and 6. A probe turn follows each compaction. Stages 5, 6 and 7 each have new events that change a tracked value. Each task has at least one corrected or replaced value.

| Task | Seed | Bytes | Events | Probe questions | Final questions | State bytes | Facts | Answers with a fact |
|---|---|---|---|---|---|---|---|---|
| A9-api-gateway | 1400002 | 69732 | 325 | 4, 6 | 7 | 589, 661 | 8 | 17 of 17 |
| B9-logistics-teams | 1425000 | 71913 | 333 | 4, 4 | 7 | 1180, 1581 | 18 | 12 of 15 |
| C9-billing-migration | 1450000 | 71451 | 326 | 6, 4 | 8 | 588, 782 | 12 | 18 of 18 |
| E9-export-service | 1475000 | 71015 | 332 | 4, 6 | 8 | 722, 739 | 6 | 15 of 18 |

The size range, the delivery rules, the probe rules and the question types are the ones of the 8-series in `tasks/v04/`. Each final set has current-state questions and at least one history question. A history question asks for the value of the initial specification or for the superseded values.

## Rules of each task

The intro of each task states its rules after the initial specification. The generator adds them from `V06_RULES` in `tasks/generator/v06.mjs`. Each rule names how a tracked value changes.

These three rules are in every task:

```text
- A value changes only by an event that decides, corrects, adds, removes, renames, runs or restores it. A proposal, a question, a link or a quote of an old page changes nothing.
- A correction or a new decision replaces the earlier value. The earlier value is then superseded.
- The initial specification gives the first value of each item.
```

A9 adds these rules:

```text
- Each tool and each setting has one current decision. A new decision for it replaces the earlier one.
- A superseded value of an item is a value that was its decision at some time, the initial specification included, and is not its current decision.
- A locale is supported from the event that adds it until an event removes it.
```

B9 adds these rules:

```text
- A service has one owning team at a time. A new owner replaces the earlier owner.
- A rename gives a team a new name. The team keeps its services. Every reference to the old name means the new name.
- The dependencies of a service are the services in its own dependency list. These are its direct dependencies. A dependency of a dependency is not counted.
- A service has one on-call engineer at a time. A new assignment replaces the earlier one.
```

C9 adds these rules:

```text
- The status of a migration is `pending`, `applied` or `failed`. Only a run event of that migration changes its status.
- A run event sets the status of its migration to the result of the runbook rule in the event. The rule uses the values of its conditions at the moment of the run.
- A later run of the same migration can change the status again. A later change of a flag or of another migration does not change a status by itself.
- A change with a condition takes effect only if the condition holds at the moment of the change. If not, the value stays as it was, and a later change of the condition does not revive the change.
- A checkpoint records the current settings. A rollback event sets each setting that it names back to its value at that checkpoint. Every other value keeps its current value. A rollback never changes a migration status.
```

E9 adds these rules:

```text
- The acceptance criteria, the planned steps, the completed steps and the rejected approaches are lists. An event adds an item to a list or removes an item from it.
- A step is outstanding when it is in the planned steps and not in the completed steps.
- An approach is rejected while it is in the list of rejected approaches. A suggestion to use it again does not change the list.
- A decision on a detail replaces the earlier decision for that detail.
```

The v06 event wording also changes in two places. Each run event says that the run sets the status of its migration. No run event says that its output was not kept. Each change with a condition says that the condition applies at the moment of the entry.

## Reference files, schema 2

Each file `reference/<taskId>.state.json` has this form:

```json
{ "schema": 2, "taskId": "C9-billing-migration", "states": [{ "afterStage": 4, "text": "...", "facts": [{ "name": "migration m1", "kind": "scalar", "value": "applied", "history": ["pending", "failed"] }] }] }
```

- There is one state for stage 4 and one for stage 6.
- `text` has the plain form of `tasks/v04/README.md`, with at most 1900 bytes. Each fact has a line `name: value` in the text.
- `facts` has one fact for each tracked variable with a value, in the order of the text. The name is the name of its text line.
- `value` is a string, or the sorted members of a list as strings. An ON/OFF value is `ON` or `OFF`.
- `history` lists the earlier values of a single value, the first value first, without the current value. It is null for a list, and for a value that never changed.
- The side values of the large feeds are not facts.

## Fact links in the keys

Each answer in `answers` and `checkpointAnswers` has the new field `fact`. All other fields stay as before.

| Question kind | `fact` |
|---|---|
| a current value, the members of a list, a count of a list, a membership in a list | `{ name, part: "current" }` |
| the value of the initial specification, the superseded values | `{ name, part: "history" }` |
| a question that needs two or more facts | null |

Two question kinds need two or more facts. One is the services of a team in B9. The other is the outstanding steps in E9, which are the planned steps without the completed steps.

A history answer about the initial specification is the first value of `history`. If `history` is null, it is the current value.

## Possible second readings that I checked

- C9, status of a migration. Two readings: the stored value, or the result of the last run. The rules and the run wording say that the run sets the status. This was the problem of task C8 in v0.4.
- C9, "final status of a migration". Two readings: the last run result, or the stored value. The question now asks for the status now.
- C9, a change with a condition. Two readings: the condition applies at the moment of the change, or later. The rule and the wording name the moment of the change.
- C9, a rollback. Two readings: it restores only the named settings, or more values. The rule and the wording limit it to the named settings. It never changes a migration status.
- B9, "depend on". Two readings: direct dependencies, or direct and indirect dependencies. The questions now ask for direct dependencies, and a rule defines them.
- B9, a team name in a question. A risk: the name is an old name, or a name that does not exist yet. The generator makes sure that the name is the current name at the time of the question.
- B9, the initial owner after a rename. The question asks for the name that the team had then.
- A9, superseded values. Two readings: the value of the initial specification counts as decided, or not. A rule says that it counts as a decision.
- A9, B9, C9 and E9, a correction of an initial value. Two readings: a correction changes the value, or it changes the record of the initial specification. A rule says that the initial specification gives the first value, and a correction replaces the value after it.
- E9, a rejected approach that is suggested again. A rule says that the list does not change.
- E9, completed steps. A completed step is always a planned step in this task, so "outstanding" has one reading.
- Every task, a quote of an old page. The intro says that a quote is not a new statement.

## What the tests make sure of

The tests are in `tests/tasks/v06.test.mjs`.

- The generator gives the same files on each run, and it reproduces every committed file.
- Every task and key pair passes the shared validator, the v03 rules and the v06 rules.
- Each key answer matches the reference state machine.
- Each reference file has schema 2. Its text and its facts are equal to the state machine output.
- Each fact name in a key is a fact name of the reference file. A probe answer agrees with the fact of its stage.
- No key text and no reference text is in a task file.
- The grader accepts each key value and rejects each stale value with no change.
- `FROZEN.json` holds the SHA-256 of every task, key and reference file.
