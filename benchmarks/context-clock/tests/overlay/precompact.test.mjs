// v0.9 PreCompact path (EXPERIMENT-V09.md, arm R and part 2): any file that CCB_PRECOMPACT_FILE names is delivered,
// the same text goes out for a manual and an automatic compaction, and the log line records the trigger kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OVERLAY_DIR, tempDir, writeScript } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const CONFIGS = path.resolve(OVERLAY_DIR, "..", "..", "configs");
const dir = tempDir("ccb-precompact-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const VARS = ["CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PRECOMPACT_FILE", "CCB_PERIODIC_FILE", "CCB_PERIODIC_EVERY", "CCB_PERIODIC_OFFSET",
  "CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"];

function envFor(stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, ...extra };
  for (const k of VARS) if (!(k in extra)) delete env[k];
  return env;
}
/** The PreCompact input of the host; trigger undefined leaves the field out. */
const input = (trigger) => JSON.stringify({ hook_event_name: "PreCompact", session_id: "s1", ...(trigger === undefined ? {} : { trigger }), custom_instructions: null });
const lines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const textOf = (file) => readFileSync(file, "utf8").replace(/\s+$/, "");

for (const name of ["precompact-general-instruction.txt", "precompact-strong-instruction.txt"]) {
  test(`${name}: the same text for "manual", "auto" and a missing trigger; the log records the kind`, async () => {
    const file = path.join(CONFIGS, name);
    const text = textOf(file);
    const log = path.join(dir, `${name}.jsonl`);
    for (const trigger of ["manual", "auto", undefined]) {
      // the PreCompact entry that build.mjs adds runs the shim with no product hook
      const r = await run([SHIM], { env: envFor("", { CCB_PRECOMPACT_FILE: file, CCB_SHIM_LOG: log }), pieces: [input(trigger)] });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.toString("utf8"), text, String(trigger));
    }
    assert.deepEqual(lines(log).map((l) => ({ ...l, t: 0 })), ["manual", "auto", null].map((trigger) => ({
      t: 0, channel: "precompact", event: "PreCompact", trigger, delivered: true, bytes: Buffer.byteLength(text),
    })));
    assert.ok(!readFileSync(log, "utf8").includes(text.slice(0, 40)), "log holds no text");
  });
}

test("any file name and folder is delivered: no list of allowed names", async () => {
  const file = writeScript(path.join(dir, "any", "folder"), "my own text.md", "Keep each open item.\n");
  const log = path.join(dir, "any.jsonl");
  const r = await run([SHIM], { env: envFor("", { CCB_PRECOMPACT_FILE: file, CCB_SHIM_LOG: log }), pieces: [input("auto")] });
  assert.equal(r.stdout.toString("utf8"), "Keep each open item.");
  assert.deepEqual(lines(log).map((l) => [l.trigger, l.delivered, l.bytes]), [["auto", true, 20]]);
});

test("a product PreCompact hook: its output first, then the text, for both trigger kinds", async () => {
  const file = path.join(CONFIGS, "precompact-general-instruction.txt");
  const log = path.join(dir, "product.jsonl");
  for (const trigger of ["manual", "auto"]) {
    const r = await run([SHIM, HOOK, "--agent", "claude-code"], { env: envFor("product text\n", { CCB_PRECOMPACT_FILE: file, CCB_SHIM_LOG: log }), pieces: [input(trigger)] });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), "product text\n" + textOf(file));
  }
  assert.deepEqual(lines(log).filter((l) => l.channel === "precompact").map((l) => l.trigger), ["manual", "auto"]);
  // Context Clock v0.3: one precompact_product line for each call of the product hook, before the overlay line.
  assert.deepEqual(lines(log).map((l) => [l.channel, l.trigger]), [["precompact_product", "manual"], ["precompact", "manual"], ["precompact_product", "auto"], ["precompact", "auto"]]);
  assert.ok(lines(log).filter((l) => l.channel === "precompact_product").every((l) => l.bytes === Buffer.byteLength("product text\n")));
});

test("a trigger that is not a string is logged as null; without the variable nothing is logged", async () => {
  const file = path.join(CONFIGS, "precompact-general-instruction.txt");
  const log = path.join(dir, "odd.jsonl");
  const odd = JSON.stringify({ hook_event_name: "PreCompact", trigger: 7 });
  const r = await run([SHIM], { env: envFor("", { CCB_PRECOMPACT_FILE: file, CCB_SHIM_LOG: log }), pieces: [odd] });
  assert.equal(r.stdout.toString("utf8"), textOf(file));
  assert.equal(lines(log)[0].trigger, null);
  const none = path.join(dir, "none.jsonl");
  for (const trigger of ["manual", "auto", undefined]) {
    const q = await run([SHIM], { env: envFor("", { CCB_SHIM_LOG: none }), pieces: [input(trigger)] });
    assert.equal(q.code, 0);
    assert.equal(q.stdout.length, 0);
  }
  assert.deepEqual(lines(none), []);
});
