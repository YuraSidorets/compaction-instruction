# Context Clock v0.4 tasks

This folder holds the 10 tasks of the v0.4 experiment. `EXPERIMENT-V04.md`, sections "Tasks" and "Interfaces", is the contract. The tasks come from the same five families and builders as the v0.2 and v0.3 tasks. They use new recorded seeds, new slugs and new value pools. No v0.2 or v0.3 task is reused.

A model session must not read `keys/` or `reference/`. The agent never gets a file of these folders.

## Commands

Run each command from the repository root.

```powershell
node benchmarks/context-clock/tasks/generator/v04.mjs
node benchmarks/context-clock/tasks/generator/v04.mjs --check
node benchmarks/context-clock/tasks/generator/v04.mjs --freeze
node --test benchmarks/context-clock/tests/
```

- The first command writes `generated/`, `keys/` and `reference/` in this folder.
- `--check` compares the committed files with the generator output. If a file differs, it exits with code 1.
- `--freeze` writes `FROZEN.json`, and `HEAD` becomes the generator commit. If the generator code is not committed or a file differs, it stops.

The specs, seeds and value pools are in `tasks/generator/v04.mjs`. The reference state export is in `tasks/generator/refstate.mjs`. The v0.2 and v0.3 outputs do not change.

## The tasks

Every task has the profile `compaction` and 2 large feeds. Bytes are the staged material of all stages. Events include the routine records. The last column gives the size of each reference state text.

| Task | Seed | Bytes | Events | Compaction after stage | Probe questions | Final questions | State bytes |
|---|---|---|---|---|---|---|---|
| A7-edge-delivery | 1100004 | 69581 | 323 | 4 | 5 | 7 | 443 |
| A8-registry-move | 1125004 | 69121 | 321 | 4, 6 | 6, 4 | 7 | 631, 689 |
| B7-ledger-teams | 1150003 | 69649 | 322 | 4 | 5 | 7 | 1053 |
| B8-payments-reorg | 1175000 | 69831 | 334 | 4, 6 | 6, 4 | 7 | 1258, 1286 |
| C7-search-cutover | 1200000 | 71443 | 325 | 4 | 4 | 7 | 485 |
| C8-storage-upgrade | 1225000 | 71230 | 329 | 4, 6 | 6, 6 | 8 | 584, 770 |
| D7-vendor-limits | 1250000 | 71159 | 325 | 4 | 4 | 7 | 866 |
| D8-security-baseline | 1275000 | 70209 | 328 | 4, 6 | 4, 6 | 7 | 877, 1008 |
| E7-bulk-import | 1300000 | 70154 | 325 | 4 | 6 | 7 | 636 |
| E8-index-rebuild | 1325005 | 70198 | 335 | 4, 6 | 6, 5 | 7 | 708, 726 |

Tasks with the digit 7 have 6 stages and 1 compaction. Tasks with the digit 8 have 7 stages and 2 compactions.

## Task files and keys

The task files and the key files have the same format as in `tasks/v03/`. Read `tasks/v03/README.md` for the probe fields `checkpoint.timing` and `checkpoint.probes`, the chunk lists `stages[].chunks` and the rules that the generator enforces. The size range, the delivery rules, the probe rules and the continuity rules are the same.

## Reference state

Each file `reference/<taskId>.state.json` has this form:

```json
{ "schema": 1, "taskId": "A8-registry-move", "states": [{ "afterStage": 4, "text": "..." }] }
```

There is one entry for each compaction stage, in stage order. The runner writes the `text` of a stage to `CCB_STATE_FILE` before the compaction that follows that stage.

The text is the tracked state of the reference state machine after the stage. It uses only events up to the end of that stage. It is plain lines of the form `name: value`, with at most 1900 bytes UTF-8. The same seed gives the same text.

- The first line is `state after stage <n>`.
- Each variable with a value has one line. The name is the label of the variable without the leading "the". A list shows its members in sorted order, or `(none)`.
- A variable that changed has a history line, for example `CDN provider history: akamai, then fastly`. The history holds every change from the first value to the current value. Questions about the first value or about superseded values use this line.
- An ON/OFF variable shows `ON` or `OFF`.
- In category B, a line `services owned by <team>: ...` lists the services of each team.
- In category D, each value has a source line, and the text ends with the precedence order and the withdrawn documents.
- In category E, a line `planned steps not completed: ...` lists the open steps.

The text holds no question id, no answer id and no event id. It omits the side values of the large feeds, because no question asks about them.

## What the tests make sure of

The tests are in `tests/tasks/v04.test.mjs`.

- Every task and key pair passes the shared validator and the v03 rules.
- Every reference file has the schema above, and every text is at most 1900 bytes.
- Every text is equal to the reference state machine output for its stage.
- `FROZEN.json` holds the SHA-256 of every task, key and reference file.
- A final answer can be set at or before the last compaction stage. If it is a choice or a list answer, each of its values is a whole value in the last reference text.
- A number answer or an ON/OFF answer of a value question is also a whole value of the last text.
- Every probe answer is a whole value in the text of its stage.

## Limits of the reference text

Two question kinds have no exact string in the text. The text holds the list that the answer comes from.

- A count question, for example "How many dependencies does a service have?", has a number answer. The text lists the members, not the count.
- A membership question, for example "Is an approach in the rejected list?", has a true or false answer. The text lists the members, not the answer.

In this set, these questions occur in categories B and E. The tests list these questions. If another kind of question has no exact string, the tests fail.

## Frozen hashes

`FROZEN.json` holds the generator commit and the seed and compaction stages of each task. It also holds the SHA-256 of every task file, key file and reference file. The tests recompute the hashes and regenerate every file from the seeds.
