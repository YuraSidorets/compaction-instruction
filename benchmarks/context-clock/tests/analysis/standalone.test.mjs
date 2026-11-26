// Mode names of the standalone plugin arms (docs/context-clock/PLAN-standalone.md): Z (plain host with the standalone
// plugin) and W (plain host with the PreCompact text in CLAUDE.md, no hook). Comparisons Z-O (primary), W-O, W-Z, Z-I.
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparisonsOf, DEFAULT_COMPARISONS_STANDALONE, MODE_NAMES } from "../../analysis/metrics.mjs";

// fixtures/schema.mjs MODES and MODE_ENV must match the runner and the contract, so the runner worker adds Z and W there.
test("modes Z and W: analysis names", () => {
  assert.equal(MODE_NAMES.Z, "plain host with the standalone plugin");
  assert.equal(MODE_NAMES.W, "plain host with the text in CLAUDE.md");
});

test("modes Z and W: default comparisons and labels", () => {
  assert.deepEqual([...DEFAULT_COMPARISONS_STANDALONE], ["Z-O", "W-O", "W-Z", "Z-I"]);
  const cs = comparisonsOf({ suite: "v12-standalone" }, null, ["I", "O", "W", "Z"]);
  assert.deepEqual(cs.map((c) => c.label), [
    "Z minus O (standalone plugin against the plain host, primary)",
    "W minus O (text in CLAUDE.md against the plain host)",
    "W minus Z (text in CLAUDE.md against the standalone plugin)",
    "Z minus I (standalone plugin against the summarizer instruction of the plain host)",
  ]);
  assert.deepEqual(comparisonsOf({}, null, ["O", "Z"]).map((c) => c.id), ["Z-O"], "only pairs whose modes have runs");
  assert.deepEqual(comparisonsOf({ comparisons: ["W-O"] }, null, ["O", "W", "Z"]).map((c) => c.id), ["W-O"], "a batch list takes priority");
  assert.deepEqual(comparisonsOf({ suite: "v11-plain" }, null, ["I", "O"]).map((c) => c.id), [], "no change for O and I alone");
});
