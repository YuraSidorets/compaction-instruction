// Synthetic texts with the shapes of the live smoke run v06-smoke-01 (task C9, compaction after stage 6). The fact
// names are long ("flag usage-metering", "migration m1"); the agent writes short names ("usage-metering", "m1").
// The texts are written for the tests. They are not copies of raw files.

export const SMOKE_FACTS = Object.freeze([
  { name: "flag usage-metering", kind: "scalar", value: "ON", history: ["OFF"] },
  { name: "flag tax-engine", kind: "scalar", value: "ON", history: null },
  { name: "flag invoice-pdf", kind: "scalar", value: "ON", history: ["OFF"] },
  { name: "migration m1", kind: "scalar", value: "applied", history: ["pending", "failed"] },
  { name: "migration m2", kind: "scalar", value: "applied", history: ["pending"] },
  { name: "migration m3", kind: "scalar", value: "applied", history: ["pending", "failed"] },
  { name: "ledger replica count", kind: "scalar", value: "5", history: ["3", "5", "7"] },
  { name: "invoice worker count", kind: "scalar", value: "5", history: ["7"] },
  { name: "active pricing table", kind: "scalar", value: "plan-sheet-a", history: ["plan-sheet-a", "plan-sheet-c"] },
  { name: "live schema version", kind: "scalar", value: "ledger-s23", history: ["ledger-s20"] },
]);
export const SMOKE_NAMES = Object.freeze(SMOKE_FACTS.map((f) => f.name));

/** The state file with short names and history lines (the arm J and H shape). */
export const SMOKE_FILE = [
  "usage-metering: ON",
  "tax-engine: ON",
  "invoice-pdf: ON",
  "m1: applied",
  "m2: applied",
  "m3: applied",
  "ledger replica count: 5",
  "invoice worker count: 5",
  "active pricing table: plan-sheet-a",
  "live schema version: ledger-s23",
  "usage-metering history: OFF, then ON",
  "invoice-pdf history: OFF, then ON",
  "m1 history: pending, then failed, then applied",
  "m2 history: pending, then applied",
  "m3 history: pending, then failed, then applied",
  "ledger replica count history: 3, then 5, then 7, then 5",
  "invoice worker count history: 7, then 5",
  "active pricing table history: plan-sheet-a, then plan-sheet-c, then plan-sheet-a",
  "live schema version history: ledger-s20, then ledger-s23",
  "",
].join("\n");

/** A host summary that copies the state file into a code block, after some prose. */
export const SMOKE_SUMMARY_COPY = [
  "This session is being continued from a previous conversation.",
  "",
  "1. Primary request: track a billing migration over seven stages.",
  "2. The state file clock-state.md holds:",
  "   ```",
  ...SMOKE_FILE.trim().split("\n").map((l) => "   " + l),
  "   ```",
  "3. Pending: stage 7.",
].join("\n");

/** A B-arm summary: prose and one line that lists every current value. */
export const SMOKE_BLOCK_PROSE = [
  "- Stage 1: m1 became `failed` (e022), because usage-metering was `OFF` at the run.",
  "- Stage 5: replica count `7` (e194), then e208 restored replica count `5`.",
  "- Current state after stage 6: usage-metering `ON`, tax-engine `ON`, invoice-pdf `ON`, m1 `applied`, m2 `applied`, m3 `applied`, " +
    "ledger replica count `5`, invoice worker count `5`, active pricing table `plan-sheet-a`, live schema version `ledger-s23`.",
].join("\n");
