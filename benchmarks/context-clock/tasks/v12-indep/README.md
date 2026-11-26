# Context Clock v12 independent tasks

This folder holds the independent set of `docs/context-clock/PLAN-standalone.md`, step 2.5. The set has 2 tasks of a new task shape, the incident timeline (kind T). I designed the shape from the plan brief only. I did not read the instruction texts in `configs/precompact-*.txt`.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

The status of the set is "candidate".

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-indep
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-indep --check
node benchmarks/context-clock/tasks/generator/v12.mjs --set v12-indep --freeze
```

The specs are `V12_INCIDENT_TASKS` in `tasks/generator/v12.mjs`. The builder is `tasks/generator/builders/t-incident.mjs`.

## The incident shape

The agent keeps the timeline of one production incident. The tracked state is:

- Three roles that people hand over: the incident commander, the communications lead and the operations lead.
- The severity, from `sev-1` to `sev-4`.
- The state of the status page.
- The services that are affected now. This is a set that grows and shrinks.
- Two times of the timeline: the start of the customer impact and the time of detection. A later correction can fix a time.
- 6 mitigation actions. Each action is planned, running, finished or abandoned.
- The leading root cause hypothesis. A new hypothesis rules out the earlier one.

Each fact is in prose in incident notes, tickets and feeds. No source line has the form "name: value". The distractors are suggestions with no decision, withdrawn drafts of updates and postmortems, archived copies of the incident document and quotes of old bridge summaries.

The final questions ask the current commander, the commander directly before, and every earlier commander. They ask the severity now and on the first page, and the affected services. They also ask the start time of the impact, the finished actions, the leading hypothesis and the previous communications lead.

## Run protocol and size

The protocol is the same as in `tasks/v12`. Each task has 8 stages, with compactions after stages 3, 5 and 7, and a probe after each compaction. The size is close to the worklog tasks of `tasks/v12`, so a plain Haiku run is not expected to reach the top score.

| Task | Category | Shape | Seed | Material bytes | task.json bytes | Facts | Final questions | Probe questions | Deliveries |
|---|---|---|---|---|---|---|---|---|---|
| T13-payments-outage | T | incident | 2350000 | 100785 | 146340 | 15 | 10 | 4, 5, 6 | 35 |
| T13-login-incident | T | incident | 2375000 | 98313 | 143353 | 15 | 10 | 5, 6, 5 | 34 |

For comparison, W13-billing-cutover in `tasks/v12` has 99287 material bytes and 34 deliveries.

## Grader and runner support

The grader needs no change. The questions use the existing types `choice` and `set`.

The category T and the shape "incident" are new. These lists do not have them yet:

- `CATEGORIES` in `runner/plan.mjs`, `analysis/metrics.mjs` and `fixtures/schema.mjs`.
- `TASK_SHAPES` in `analysis/metrics.mjs`.

The owners of those files must add T and "incident" before a batch uses this set.

## What the tests make sure of

The tests are in `tests/tasks/v12-indep.test.mjs`.

- There are 2 tasks of category T and shape "incident", with new ids and new seeds.
- The protocol is the protocol of `tasks/v12`. The material is within 10% of a `tasks/v12` worklog task.
- The questions ask role history, the affected set, the finished actions and the root cause.
- The generator reproduces every file, and `FROZEN.json` has the SHA-256 and bytes of every file.
- The shared rules and the v0.9 rules pass. Each question has one correct answer, and the solver equals the key.
- No source line has the form "name: value". The fact names are unique, and no key text is in a task file.
- The grader accepts each key value and rejects each stale value.
- The files of `tasks/v12` and `tasks/v12-hard` match their `FROZEN.json`.
