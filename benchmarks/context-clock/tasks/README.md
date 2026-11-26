# Context Clock benchmark tasks

This folder holds the 20 staged tasks of the Context Clock benchmark and their answer keys. The contract is `../CONTRACT.md`.

| Path | Content |
|---|---|
| `generator/` | The generator. `generate.mjs` is the entry point. |
| `generated/<taskId>.task.json` | The task files. The runner reads only these files. They hold no answer. |
| `keys/<taskId>.key.json` | The answer keys. A key never enters a workspace. |
| `../tests/tasks/tasks.test.mjs` | The tests of the generator and of the 40 committed files. |

## Commands

To rewrite the 40 files, run this command:

```text
node benchmarks/context-clock/tasks/generator/generate.mjs
```

To make sure that the committed files equal a fresh generation, run this command. If a file differs, the command exits with 1.

```text
node benchmarks/context-clock/tasks/generator/generate.mjs --check
```

To run the tests, run this command:

```text
node --test benchmarks/context-clock/tests/tasks/
```

The environment variable `CCB_TASKS_DIR` sets another output root. The root replaces `benchmarks/context-clock/tasks`, and the generator writes `generated/` and `keys/` under it.

## How the generator works

The same seed gives the same bytes. The only random source is the seeded generator in `generator/rng.mjs` (mulberry32). The generator reads no clock time.

Each task goes through these steps:

1. A category builder in `generator/builders/` declares the tracked variables, emits structured events per stage, and declares each question as a structured query. A builder never computes an answer.
2. `addDistractors` in `generator/builders/common.mjs` adds events that change no state. Their kind in the key is `conflict`.
3. `generate.mjs` adds the large feeds and the routine records (noise). It puts the noise between the other events of each stage. Then it gives each event its label (`e001`, `e002`, and so on, in time order).
4. `generator/render.mjs` writes the text of each event and packs each stage into files and feeds. A bool value appears as `ON` or `OFF`.
5. The self-check in `generate.mjs` makes sure that the rendered text of each event holds every value of its structured event. Examples are the variable label, the new value, the guard condition, and the source, document and version of a claim. It also makes sure that each label and each tag appears only where it must.
6. `generator/reference.mjs` computes the key. It is an independent state machine that replays the structured events. It has no import, and it never reads event text. It gives `value`, `establishedBy` (the events that changed the answer), `staleValues` (earlier answers that differ from the final one), `firstEstablishedStage` and `lastChangedStage`.
7. When a rule fails, `validate` and `validateCoverage` in `generate.mjs` stop the generation. The rules are in the sections below.

The `options` list of a `choice` or `set` question comes from the declared universe of the variable, not from the answer. The universe holds every value that the variable takes. Thus the stale values are always distractors in that list.

The reference supports these operations:

- `set`, `add` and `remove`, each of which can have a guard (a condition that the change needs)
- `rename`, `snapshot` and `rollback`
- `attempt`, a migration run that needs its prerequisites
- `claim`, `authority` and `retract`
- `mention`, `touch` and `restate`, which change nothing

When the condition of a guarded change is false, the change has no effect.

## Bulk and distractors

The size comes from realistic material, not from padding:

- Each state event is a record with one or two context lines, for example the attendees of a meeting or the watchers of a ticket.
- Routine records have several lines: standup notes, review threads, key-value exports of unrelated tools, run summaries, calendar updates, chat excerpts and style guide excerpts.
- A large feed holds verbose log records with detail lines.

There are three kinds of distractors (events that change no state):

- A near miss (`touch`) names a tracked subject but changes nothing, for example a request for a load test plan.
- A rejected proposal (`mention`) names a value for a subject, and the text says that nothing changes.
- A dated copy (`restate`) quotes an old value. It names the entry that it copies (for example "as of entry e012") and says that it is history only. A copy only quotes a value that a later event changes. It never quotes the initial value that an "initial specification" question asks about.

The intro states that a quote of an old page is not a new statement.

## Values

Every value in event text is code-marked with backticks, for example "Approved: `it-IT` joins the supported locales". This applies to new values, set members, team names in a rename, migration results, guard conditions and checkpoint names. A bool value appears as `ON` or `OFF`.

No value is a common English word. A value like "it" or "us" reads as part of the sentence, so the pools use forms like these:

- locale codes with a region: `it-IT`, `de-DE`
- data residency regions with a suffix: `us-zone`, `eu-zone`
- team names with a prefix: `team-core`, `team-platform`
- the API style `rest-json`

The generator rejects a value that is in its word list (`COMMON_WORDS` in `generator/vocab.mjs`). The tests use a separate fixed word list for the question options. A test also makes sure that each value of each structured event is code-marked in the line that holds the event.

## Delivery

- Each stage has 4 to 8 deliveries (files plus feeds).
- Every file is below 3500 bytes. Every feed is either below 3500 bytes or above 6000 bytes.
- In each task, at least 60 percent of the small deliveries are 1500 bytes or more. In the small group, the last delivery of a stage is often a short note.
- A task has one, two or three large feeds (small, medium and large group). A large feed has 7 to 15 KB, and the limit is 16.5 KB.
- The large feeds sit in the early, middle and late parts of the stage range. Each one holds two to four needed events among routine log records.
- The needed events of a large feed carry a tag, and the stage prompt names that tag. The tag has the form `CR-NNNN`, `CHG-NNNN` or `INC-NNNN`.
- A search for the tag finds every needed event of its feed and nothing else. The tag appears in no other material of the task. A test makes sure of this.
- Each stage prompt names every file and feed of the stage and asks the agent to read all of them.
- The intro holds the initial specification (stage 0 events) and, for category D, the precedence rule.
- No task text names a clock, a memory tool, Context Mode, compaction, the keys or the benchmark. A test makes sure of this.

## Where the facts sit

The stages fall into three bands: early (the intro and the first third of the stages), middle and late. The generator and the tests make sure that each task follows these rules:

- The events that change the answers sit in all three bands.
- At least three final questions have a fact from the early band.
- At least two of those answers change in a later band.
- At least one answer gets its last change in the early band, and no later event repeats it.
- At least one answer has a fact from the stage material of the early band, not only from the intro.
- In a compaction task, at least three answers start before the first compaction, and at least one of them changes after it.
- In categories C and D, at least two answers need three or more events combined. When the answer changes without an event, that event is needed.

## The tasks

The columns have these meanings:

- "Group" is `params.sizeGroup`. The small group is 28 to 42 KB, the medium group is 55 to 75 KB, and the large group is 100 to 125 KB.
- "Compact after" is the stage or stages after which the runner compacts.
- "Events", "Noise", "Updates", "Entities" and "Depth" are the values of `params`. "Updates" is the number of non-noise events in stages 1 and later, distractors included.
- "Q" is the number of final questions. "CQ" is the number of checkpoint questions.
- "Bytes" is `approxBytes`, the total of all files and feeds.
- "Deliveries" gives the count of files and feeds per stage. "Large feeds" gives the size of each large feed in bytes.

| Task | Seed | Cat. | Profile | Group | Stages | Compact after | Events | Noise | Updates | Entities | Depth | Q | CQ | Bytes | Deliveries | Large feeds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1-db-overrides | 104729 | A | long | small | 5 | - | 166 | 0.82 | 22 | 6 | 1 | 7 | 0 | 34879 | 5/4/4/4/4 | 7421 |
| A2-api-redesign | 130363 | A | long | large | 7 | - | 502 | 0.84 | 71 | 9 | 1 | 7 | 0 | 108851 | 4/5/4/5/4/5/4 | 13064, 13949, 14098 |
| A3-launch-plan | 155921 | A | compaction | medium | 6 | 3 | 284 | 0.79 | 51 | 7 | 1 | 7 | 2 | 59963 | 5/4/4/5/4/4 | 9072, 8977 |
| A4-pricing-rules | 181081 | A | compaction | small | 6 | 2, 4 | 194 | 0.73 | 42 | 8 | 1 | 7 | 2 | 39158 | 4/4/4/5/4/4 | 7289 |
| B1-service-owners | 206749 | B | long | medium | 5 | - | 281 | 0.85 | 31 | 9 | 2 | 7 | 0 | 60197 | 5/4/4/4/5 | 9216, 8726 |
| B2-module-deps | 232259 | B | long | large | 7 | - | 519 | 0.82 | 75 | 14 | 4 | 7 | 0 | 110944 | 5/4/5/4/4/5/4 | 14372, 14389, 14195 |
| B3-org-reshuffle | 257687 | B | compaction | small | 6 | 3 | 193 | 0.75 | 35 | 11 | 3 | 7 | 2 | 40152 | 4/4/4/5/4/4 | 7766 |
| B4-service-graph | 283009 | B | compaction | medium | 7 | 2, 5 | 306 | 0.77 | 53 | 13 | 3 | 7 | 2 | 63565 | 5/4/4/4/4/4/5 | 8961, 9471 |
| C1-flag-rollout | 308641 | C | long | small | 4 | - | 156 | 0.81 | 21 | 8 | 1 | 7 | 0 | 32740 | 4/4/5/4 | 7572 |
| C2-schema-migration | 334219 | C | long | medium | 6 | - | 290 | 0.84 | 32 | 13 | 4 | 8 | 0 | 63937 | 5/4/4/5/4/4 | 10631, 10234 |
| C3-release-train | 359441 | C | compaction | large | 6 | 3 | 503 | 0.91 | 34 | 10 | 2 | 8 | 3 | 111429 | 6/5/6/5/5/6 | 13193, 14423, 14245 |
| C4-infra-cutover | 384737 | C | compaction | medium | 6 | 2, 4 | 290 | 0.82 | 40 | 13 | 3 | 8 | 3 | 61390 | 5/4/4/4/4/5 | 9287, 9858 |
| D1-spec-errata | 410087 | D | long | small | 5 | - | 168 | 0.76 | 34 | 6 | 3 | 7 | 0 | 34430 | 4/4/4/5/4 | 7718 |
| D2-config-sources | 435577 | D | long | medium | 6 | - | 288 | 0.76 | 60 | 9 | 3 | 7 | 0 | 61002 | 5/4/4/5/4/4 | 9404, 10519 |
| D3-policy-docs | 460949 | D | compaction | large | 6 | 3 | 493 | 0.87 | 55 | 7 | 3 | 7 | 2 | 109494 | 5/6/6/5/5/6 | 13084, 12965, 14082 |
| D4-design-doc | 486377 | D | compaction | large | 7 | 2, 5 | 512 | 0.84 | 73 | 10 | 3 | 7 | 2 | 112063 | 5/4/5/4/4/4/5 | 14547, 14687, 14970 |
| E1-export-feature | 511757 | E | long | medium | 6 | - | 291 | 0.84 | 38 | 12 | 2 | 7 | 0 | 63499 | 5/4/4/4/5/4 | 10758, 10013 |
| E2-auth-refactor | 537143 | E | long | large | 7 | - | 500 | 0.88 | 44 | 16 | 2 | 7 | 0 | 109414 | 4/5/5/4/4/5/4 | 13109, 13296, 14301 |
| E3-search-rewrite | 562651 | E | compaction | small | 6 | 3 | 196 | 0.78 | 32 | 14 | 2 | 7 | 2 | 39486 | 4/4/4/4/5/4 | 7551 |
| E4-billing-port | 588019 | E | compaction | large | 6 | 2, 4 | 512 | 0.87 | 52 | 16 | 2 | 7 | 2 | 112846 | 5/6/5/6/5/6 | 14861, 14639, 14873 |

Each category has all three groups, and each group has long and compaction tasks.

## What each task tests

All four tasks of a category use the same builder. The seed and the parameters change the subjects, the values, the number of changes and the noise.

### A: decision overrides (A1 to A4)

Stack decisions change over the stages. The tasks have these features:

- The focus topic is the primary database (A1), the public API style (A2), the deploy region (A3) and the payment provider (A4).
- The focus topic changes most often, and some changes go back to an earlier value.
- Rejected proposals name values that never become valid.

The questions ask for these values:

- the current value of two topics
- every superseded value of the focus topic
- a value from the initial specification
- a number and a flag
- the current locale set

In A3 and A4, the focus topic and a second topic change after the first compaction.

### B: entities and relationships (B1 to B4)

Services have an owning team, a dependency set and, for two services, an on-call engineer. The tasks have these features:

- The intro sets a dependency chain of the listed depth.
- Later stages move ownership, rename teams (all later events use the new name), add and remove dependencies, and move on-call duty.

The questions ask for these values:

- the current owner, under the current team name
- the services that one team owns
- a dependency set, a dependency count and a dependency yes or no
- the current on-call engineer
- the owner in the initial specification

### C: conditional state (C1 to C4)

Feature flags, a chain of migrations (the depth is the chain length), two numeric parameters, a pricing table and a schema version. The tasks have these features:

- When a migration runs and its prerequisites hold, it ends as `applied`. The text gives the rule but never the result.
- The first run of m1 fails, because its flag is OFF.
- A schema change that needs the last migration is void while that migration is not applied.
- A checkpoint is taken, parameters change, and then a rollback restores only some of them.
- Late in the task, a flag is turned OFF, so a dependent parameter change has no effect.

The questions ask for these values:

- migration states and the live schema version
- the rolled-back and the not-rolled-back parameters
- the pricing table and a flag
- a parameter value from the initial specification

### D: conflicting information (D1 to D4)

Parameters come from five sources with a fixed order of authority. Each task uses a different set of source names. The tasks have these features:

- A newer version of the same source overrides an older one.
- Lower sources state newer but losing values.
- A top-authority correction beats a later lower claim.
- A withdrawn document stops counting, so values of an older version come back.
- An outdated wiki or FAQ document is withdrawn.
- For two parameters, a lower source states a different value with a higher version. Only the precedence rule keeps the spec value.
- Spec version 5 changes one parameter, and a later stage withdraws it. The parameter falls back to spec version 3.

The questions ask for resolved values, the source that decides one parameter, a resolved flag, the value under the first specification, and a current value.

### E: long task continuity (E1 to E4)

A multi-day feature task with acceptance criteria, planned and completed steps, rejected approaches and two details (one text, one number). The features are a CSV export (E1), an auth refactor (E2), a search rewrite (E3) and a billing port (E4). The tasks have these features:

- Steps complete over the stages, and a completed step never reopens.
- New work is added, and one planned step stays open.
- One criterion is dropped and one is added.
- Rejected approaches are suggested again with no decision.
- The details change late.

The questions ask for these values:

- the outstanding steps and the completed steps
- whether one approach is rejected (true), and whether another one is rejected (false)
- both details
- the criteria that apply now

## Limits

- The small group is 33 to 40 KB, which is above the 30 KB aim. Four deliveries per stage with most of them at 1500 bytes or more need about 5.6 KB per stage. A task with six stages thus needs about 40 KB.
- The noise ratio is between 0.73 and 0.91, because most of the bulk is routine material.
- The prose comes from fixed templates, so the sentences repeat across tasks. The values, the order and the placement change with the seed.
- An "is the approach X rejected" question with the answer false names an approach that no event mentions.
- The count of needed events uses leave-one-out replay. When two events give the same value, neither one counts as needed, so the count is a lower limit.
