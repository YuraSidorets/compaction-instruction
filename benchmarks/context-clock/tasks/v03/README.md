# Context Clock v0.3 held-out tasks

This folder holds the 10 tasks of the v0.3 placebo experiment. `EXPERIMENT-V03.md`, section "Tasks", is the contract. The tasks come from the same five families and builders as the v0.2 tasks in `tasks/generated/`. They use new recorded seeds, new slugs and new value pools. No v0.2 task is reused.

A model session must not read `keys/`.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v03.mjs
node benchmarks/context-clock/tasks/generator/v03.mjs --check
node benchmarks/context-clock/tasks/generator/v03.mjs --freeze
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/` and `keys/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--freeze` writes `FROZEN.json`, and `HEAD` becomes the generator commit. If the generator code is not committed or a file differs, it stops.

The specs, seeds and value pools are in `tasks/generator/v03.mjs`. The v0.2 generator code path is unchanged, and `generate.mjs --check` still reports 40 matching files.

## The tasks

Every task has the profile `compaction` and 2 large feeds. Bytes are the staged material of all stages. Events include the routine records.

| Task | Seed | Bytes | Events | Compaction after stage | Probe questions | Final questions |
|---|---|---|---|---|---|---|
| A5-ci-platform | 700098 | 68356 | 322 | 4 | 5 | 7 |
| A6-mesh-rollout | 725014 | 70108 | 330 | 4, 6 | 5, 6 | 7 |
| B5-commerce-teams | 750124 | 70123 | 328 | 4 | 6 | 7 |
| B6-catalog-split | 775137 | 71572 | 338 | 4, 6 | 6, 6 | 7 |
| C5-pay-switch | 800053 | 73393 | 331 | 4 | 5 | 7 |
| C6-data-replatform | 825066 | 72611 | 338 | 4, 6 | 5, 4 | 8 |
| D5-partner-terms | 850079 | 70330 | 323 | 4 | 6 | 7 |
| D6-platform-limits | 875092 | 70220 | 322 | 4, 6 | 5, 6 | 7 |
| E5-offline-mode | 900105 | 68635 | 330 | 4 | 6 | 7 |
| E6-notify-split | 926961 | 70518 | 340 | 4, 6 | 6, 4 | 7 |

Tasks with the digit 5 have 6 stages and 1 compaction. Tasks with the digit 6 have 7 stages and 2 compactions.

## Schema additions

The task schema stays at version 1. The v03 task files add three fields. The shared validator in `fixtures/schema.mjs` accepts them.

- `checkpoint.timing` is `"after_compaction"`. A probe turn comes directly after the compaction, not before it.
- `checkpoint.probes` is a list of `{ afterStage, questionIds }`, one probe for each compaction. `checkpoint.questions` holds the questions of all probes, in probe order, with the ids `c1`, `c2` and so on. `checkpoint.afterStage` is the first compaction stage, as the shared validator requires.
- `stages[].chunks` is a list of `{ chunkId, kind, name, bytes, events }` for each stage. The files come first, then the feeds, in delivery order. `chunkId` has the form `s<stage>-c<n>`. `name` is the file path or the feed name. `events` are the `[eNNN]` labels in the chunk, in text order.

The key schema is unchanged. `checkpointAnswers` has one entry for each probe question. The reference computes each entry from the events up to the end of the probe stage. Each entry has `establishedBy`, `firstEstablishedStage` and `lastChangedStage`.

How the runner must use the probes: after the compaction that follows stage `afterStage`, send one `checkpoint` turn with only the questions in `questionIds`. The turn allows no tool call. The grader needs no change, because it grades every question in `checkpoint.questions` against `checkpointAnswers`.

## Rules that the generator enforces

If a rule fails, the generator stops with an error. The tests in `tests/tasks/v03.test.mjs` check the rules again on the committed files.

- Size: 55000 to 95000 bytes of staged material.
- Delivery: 4 to 8 chunks in each stage. Every file and every small feed is below 3500 bytes, and at least 60 percent of them are 1500 bytes or more. Each task has 2 feeds above 6000 bytes.
- Values: every value is in backticks, and no value is a common English word. These rules are the same as in the v0.2 tasks.
- Probes: one probe directly after each compaction, with 4 to 6 questions. Over a task, the probes cover the aspects of the category. A later probe avoids a question that an earlier probe asked with the same answer.
- Continuity: at least 3 final answers are set before the first compaction and do not change after it. At least 2 of them are not questions about the initial specification. At least 2 final answers are set before the first compaction and change after it.
- Retrieval: at most one event that a final answer needs is inside a large feed. The tests count every event that changed a final answer and every event that the answer needs.
- The v0.2 coverage rules also apply: needed facts in the early, middle and late stages, and in categories C and D at least 2 questions that need 3 or more events.

## Large feeds

Each large feed carries its routine records and 2 or 3 records of a side value. No question asks about a side value. Examples are the staging cluster name and the build runner image. One large feed of each task also carries one decisive event. The stage prompt names the tag of each large feed, and a search for that tag finds exactly the tagged entries.

## Probe questions

The probe candidates are the final questions in an "at this point" form. A value question for each scalar value that no final question asks is also a candidate. In category A, the candidates also include a superseded-values question for each choice value. The generator picks the questions with a separate seeded generator, so the probe choice does not change the stage material. It prefers questions whose answer at the probe differs from the final answer, and aspects that the task does not cover yet.

| Category | Aspects that the probes must cover |
|---|---|
| A | current decisions, superseded decisions |
| B | relationships, current state |
| C | conditional state, current state |
| D | conflict resolution |
| E | completed work, outstanding work, requirements, rejected approaches |

## Frozen hashes

`FROZEN.json` holds the generator commit, the seed and compaction stages of each task, and the SHA-256 of every task file and key file. The tests recompute the hashes and regenerate every file from the seeds.
