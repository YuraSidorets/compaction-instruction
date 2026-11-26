# Context Clock v0.7 tasks

This folder holds the 6 held-out tasks of the v0.7 experiment. `EXPERIMENT-V07.md`, section "Tasks", is the contract. The tasks come from the same families and builders as the earlier task sets. They use new recorded seeds, new slugs and new value pools. No content of `tasks/generated/`, `tasks/v03/`, `tasks/v04/` or `tasks/v06/` is reused.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate". The lead can ask for one harder revision after the calibration batch. A revision is a regeneration with a higher difficulty, from the same base seeds.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v07.mjs
node benchmarks/context-clock/tasks/generator/v07.mjs --check
node benchmarks/context-clock/tasks/generator/v07.mjs --freeze
node benchmarks/context-clock/tasks/generator/v07.mjs --difficulty 2
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--freeze` writes `FROZEN.json` with the status "candidate", and `HEAD` becomes the generator commit. If the generator code is not committed or a file differs, it stops.
- `--difficulty N` sets the difficulty. The default is 1. It works with the other options too.

The specs, seeds, value pools and rules are in `tasks/generator/v07.mjs`. All v07 changes of the shared generator are active only for a spec with the field `v07`. The outputs of the earlier task sets do not change.

## Difficulty and seeds

Each task has a base seed. The generator tries the base seed, then the base seed plus 1, and so on. It takes the first seed that passes every rule. Thus the files depend only on the base seed and the difficulty.

The field `found` of a spec records the seed that this search found at a difficulty. The generator starts at that seed, which saves time. It is not a second source of truth. A search from the base seed found the same 6 seeds at difficulty 1.

A higher difficulty adds items, changes and questions:

| Item | Change for each step of difficulty |
|---|---|
| Changes for each added item | one more |
| Updates of the builder | 30% more |
| Entities of the builder | 2 more in A10-data-platform and B10, 1 more in A10-observability-stack |
| Added items | one more in A10-data-platform, A10-observability-stack, C10 and E10 |
| Reasons in A10-observability-stack | one more decision with a reason, one more reason-only change for each reason |
| Permit items in C10 | one more |
| Top-source parameters in D10 | 2 more |
| Final questions in A10-data-platform | one more at difficulty 2 |

## The tasks

Every task has the profile `compaction`, 8 stages, 2 large feeds and a compaction after stages 3, 5 and 7. A probe turn follows each compaction. Each stage from 1 to 8 has new events that change a tracked value. Each task has at least one corrected or replaced value.

| Task | Category | Seed | Bytes | Events | Probe questions | Final questions | Facts | State text bytes | Answers with a fact |
|---|---|---|---|---|---|---|---|---|---|
| A10-data-platform | A | 1500000 | 97476 | 469 | 5, 5, 4 | 9 | 16 | 979, 1257, 1422 | 23 of 23 |
| A10-observability-stack | A | 1525021 | 94960 | 469 | 4, 6, 5 | 10 | 17 | 1524, 2027, 2370 | 23 of 25 |
| B10-clinic-platform | B | 1550002 | 96991 | 483 | 4, 4, 4 | 9 | 36 | 2529, 3181, 3525 | 19 of 21 |
| C10-payments-cutover | C | 1575002 | 100163 | 479 | 5, 4, 6 | 10 | 24 | 1485, 1880, 2153 | 23 of 25 |
| D10-network-policy | D | 1600000 | 95537 | 471 | 6, 4, 6 | 9 | 16 | 1715, 1903, 2067 | 23 of 25 |
| E10-notification-hub | E | 1625000 | 96998 | 484 | 4, 4, 6 | 9 | 12 | 1285, 1496, 1619 | 21 of 23 |

The bytes are the bytes of all stage material. The mean of the v06 tasks is 71 028 bytes. Thus the v07 tasks have 1.34 to 1.41 times the bytes of a v06 task.

Two tasks have the category A, so two ids start with `A10-`. The shared validator requires that an id starts with its category letter, and the runner accepts only the categories A to E.

## How the tasks are harder

| Task | Facts | Facts of the earlier task | Mean changes for each single value | Mean changes in the earlier task |
|---|---|---|---|---|
| A10-data-platform | 16 | 8 (A9) | 2.33 | 1.57 |
| A10-observability-stack | 17 | 8 (A9) | 3.69 | 1.57 |
| B10-clinic-platform | 36 | 18 (B9) | 2.37 | 1.00 |
| C10-payments-cutover | 24 | 12 (C9) | 2.00 | 1.17 |
| D10-network-policy | 16 | 8 (D8 of v0.4) | 1.50 | 1.13 |
| E10-notification-hub | 12 | 6 (E9) | 3.25 | 2.50 |

The counts are from the reference state after the last compaction. A change is an entry of the fact history.

- A10-data-platform, A10-observability-stack, C10 and E10 get added items from the v07 hook, each with an initial value and 3 changes.
- A10-observability-stack tracks the reason of each of 5 decisions. C10 tracks the condition of each of 3 permit items.
- D10 gets claims of the top source for 6 parameters. Each claim changes the value, because the top source decides.
- B10 has 17 services, against 8 in B9.

## Reasons in A10-observability-stack

Five decisions of A10-observability-stack have a recorded reason. A reason is one id of a closed list of 7 ids. The initial specification records the reason of each of the 5 decisions. Each later decision of such an item comes with an entry that records its reason, directly after the decision. Other entries replace a reason and keep the decision.

The final set has three reason questions. One asks the current reason of a decision (choice). One asks the replaced reasons of another decision (set). One asks how many decisions have a given reason (number).

## Conditions in C10

Three permit items of C10 have a condition. A condition is `while-<flag>-on`, `while-<flag>-off` or `always-allowed`, for each flag of the task. An event changes the condition of an item. A flag change changes only whether the item is allowed.

The final set has three condition questions. One asks the current condition of an item (choice). One asks whether a second item is allowed now (boolean). One asks the replaced conditions of the first item (set). The reference machine computes "allowed" with the new query `allowed`. The query holds the condition of each id, so the key needs no other source.

## Rules of each task

The intro of each task states its rules after the initial specification. The generator adds them from `V07_RULES` in `tasks/generator/v07.mjs`.

These four rules are in every task except D10:

```text
- A value changes only by an event that decides, corrects, adds, removes, renames, runs or restores it. A proposal, a question, a link or a quote of an old page changes nothing.
- A correction or a new decision replaces the earlier value. The earlier value is then superseded.
- The initial specification gives the first value of each item.
- A question about the values of an item "at some point" counts every value from the initial specification on, up to the time of the question.
```

A10-data-platform adds these rules. A10-observability-stack adds them too:

```text
- Each tool and each setting has one current decision. A new decision for it replaces the earlier one.
- A superseded value of an item is a value that was its decision at some time, the initial specification included, and is not its current decision.
- A locale is supported from the event that adds it until an event removes it.
```

A10-observability-stack adds these rules:

```text
- Some decisions have a recorded reason. A reason is one id of this closed list: `rsn-cost`, `rsn-latency`, `rsn-security`, `rsn-compliance`, `rsn-ops-load`, `rsn-vendor-lock`, `rsn-team-skill`.
- Each decision with a recorded reason has one reason at a time. An entry that records a reason for it replaces the earlier reason.
- A new decision for such an item comes with an entry that records its reason. A later entry can replace the reason and keep the decision.
- A reason changes only by an entry that records it. A new decision with no such entry keeps the earlier reason. A proposed reason changes nothing.
```

B10 adds these rules:

```text
- A service has one owning team at a time. A new owner replaces the earlier owner.
- A rename gives a team a new name. The team keeps its services. Every reference to the old name means the new name.
- The dependencies of a service are the services in its own dependency list. These are its direct dependencies. A dependency of a dependency is not counted.
- A service has one on-call engineer at a time. A new assignment replaces the earlier one.
```

C10 adds these rules:

```text
- The status of a migration is `pending`, `applied` or `failed`. Only a run event of that migration changes its status.
- A run event sets the status of its migration to the result of the runbook rule in the event. The rule uses the values of its conditions at the moment of the run.
- A later run of the same migration can change the status again. A later change of a flag or of another migration does not change a status by itself.
- A change with a condition takes effect only if the condition holds at the moment of the change. If not, the value stays as it was, and a later change of the condition does not revive the change.
- A checkpoint records the current settings. A rollback event sets each setting that it names back to its value at that checkpoint. Every other value keeps its current value. A rollback never changes a migration status or a condition.
- Each permit item has one condition at a time. The condition `while-<flag>-on` means that the item is allowed only while that flag is ON. The condition `while-<flag>-off` means that it is allowed only while that flag is OFF. The condition `always-allowed` means that it is allowed at all times.
- Only an event that changes the condition of an item replaces its condition. A change of a flag never changes a condition. It changes only whether an item is allowed.
- An item is allowed at a moment when its condition at that moment holds for the value of its flag at that moment.
```

D10 has its own rules, because a new statement does not always replace a value under the precedence rule:

```text
- A value changes only by a document that states it or by the withdrawal of a document. A proposal, a question, a link or a quote of an old page changes nothing.
- The value of a parameter comes from the valid documents that state it. The highest source decides. Inside that source, the document with the higher version decides.
- A new document of a lower source does not replace the value of a higher source.
- A withdrawn document is not valid. The value then comes from the other valid documents by the same rule.
- The initial specification gives the first value of each item.
- A question about the values of an item "at some point" counts every value from the initial specification on, up to the time of the question.
```

The D builder also states the order of the sources and the version rule, as in the earlier D tasks.

E10 adds these rules:

```text
- The acceptance criteria, the planned steps, the completed steps and the rejected approaches are lists. An event adds an item to a list or removes an item from it.
- A step is outstanding when it is in the planned steps and not in the completed steps.
- An approach is rejected while it is in the list of rejected approaches. A suggestion to use it again does not change the list.
- A decision on a detail replaces the earlier decision for that detail.
```

The event wording of v06 stays. Each run event says that the run sets the status of its migration. Each change with a condition says that the condition applies at the moment of the entry. Reason entries and condition changes have their own wording.

## Reference files, schema 2

Each file `reference/<taskId>.state.json` has this form:

```json
{ "schema": 2, "taskId": "C10-payments-cutover", "states": [{ "afterStage": 3, "text": "...", "facts": [{ "name": "condition of the bulk refund tool", "kind": "scalar", "value": "while-sepa-instant-on", "history": ["while-fx-rates-v3-off"] }] }] }
```

- There is one state for each compaction: stages 3, 5 and 7.
- `text` has the plain form of `tasks/v04/README.md`, with at most 4000 bytes. No arm returns it. Each fact has a line `name: value` in the text.
- `facts` has one fact for each tracked variable with a value, in the order of the text. The name is the name of its text line.
- A reason is a fact with the name `reason for the <item> decision`. A condition is a fact with the name `condition of <item>`.
- `value` is a string, or the sorted members of a list as strings. An ON/OFF value is `ON` or `OFF`.
- `history` lists the earlier values of a single value, the first value first, without the current value. It is null for a list, and for a value that never changed.
- The side values of the large feeds are not facts.

## Fact links in the keys

Each answer in `answers` and `checkpointAnswers` has the field `fact`. All other fields stay as before.

| Question kind | `fact` |
|---|---|
| a current value, a current reason or condition, the members of a list, a count of a list, a membership in a list | `{ name, part: "current" }` |
| the value of the initial specification, the superseded values, reasons or conditions | `{ name, part: "history" }` |
| a question that needs two or more facts | null |

Four question kinds need two or more facts:

- the count of decisions with a given reason in A10-observability-stack
- whether a permit item is allowed in C10, which needs the condition and the flag
- the services of a team in B10, and the source that decides a parameter in D10
- the outstanding steps in E10, which are the planned steps without the completed steps

A history answer about the initial specification is the first value of `history`. If `history` is null, it is the current value.

## Possible second readings that I checked

- Every task, "at some point". Two readings: with the value of the initial specification, or without it. A rule now says that it counts every value from the initial specification on.
- A10-observability-stack, a new decision and its reason. Two readings: the reason stays, or it becomes open. Each new decision comes with a reason entry, and a rule says that a reason changes only by such an entry.
- A10-observability-stack, a reason entry that repeats the current reason. A risk: a "replacement" that changes nothing. The generator makes each reason entry a real change, and a test checks it.
- A10-observability-stack, the count of decisions with a reason. Two readings: all decisions, or the decisions with a recorded reason. The question names the count of decisions with a recorded reason.
- C10, a flag change. Two readings: it changes the condition, or only whether the item is allowed. A rule says that it changes only whether the item is allowed.
- C10, "allowed now". Two readings: by the condition at the time of the question, or by an earlier condition. A rule names the condition and the flag value at that moment.
- C10, a rollback. Two readings: it restores conditions too, or only the named settings. The rule says that a rollback never changes a condition. No rollback names a condition.
- C10, the status of a migration and a change with a condition. The v06 rules and wording stay.
- D10, a later document of a lower source. Two readings: it replaces the value because it is newer, or the higher source keeps it. A rule says that the higher source keeps it.
- D10, the common rule "a new decision replaces the earlier value". It does not hold under the precedence rule. D10 does not have this rule.
- D10, a version number. The added top-source documents have versions that rise in time. A later document of a source never has a lower version than an earlier one of the same parameter.
- B10, "depend on", a team name in a question and the initial owner after a rename. The v06 rewrites and checks stay.
- B10, the engineers on call "at some point". The question asks the engineers that are not on call now. The common rule names the initial specification.
- A10-data-platform and A10-observability-stack, superseded values. A rule says that the value of the initial specification counts as a decision.
- E10, a rejected approach that is suggested again, and completed steps. The v06 rules stay. A completed step is always a planned step in this task.
- Every task, a quote of an old page. The intro says that a quote is not a new statement.

## What the tests make sure of

The tests are in `tests/tasks/v07.test.mjs`.

- There are 6 tasks with 8 stages and exactly 3 compactions, after stages 3, 5 and 7.
- The bytes of each task are 1.3 to 1.5 times the mean of the v06 tasks.
- Each task has at least twice the facts of the matching earlier task, and more changes for each single value.
- The generator gives the same files on each run, and it reproduces every committed file. A regeneration at difficulty 2 passes every rule.
- Every task and key pair passes the v03 rules and the v07 rules. The shared validator reports only two known problems, the compaction count and the question count.
- Each key answer matches the reference state machine.
- Each reference file has schema 2. Its text and its facts are equal to the state machine output.
- In A10-observability-stack, a reason entry follows each new decision. In C10, the probe answers about "allowed" follow from the condition fact and the flag fact.
- Each fact name in a key is a fact name of the reference file. A probe answer agrees with the fact of its stage.
- No key text and no reference text is in a task file.
- The grader accepts each key value and rejects each stale value with no change.
- `FROZEN.json` has the status "candidate", the difficulty, the seeds, and the SHA-256 and bytes of every task, key and reference file.
