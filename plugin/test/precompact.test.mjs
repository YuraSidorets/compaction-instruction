import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instructionText, isOff } from "../scripts/precompact.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "precompact.mjs");
// The hash of the text that the benchmark measured (arm R, arm I and arm M of Context Clock v0.11).
const MEASURED_SHA256 = "72ab92318bd8a9cfebdb422d19e46e0368c53e195bc9836ec47ace3044d92bbb";
const MEASURED_BYTES = 694;

function run(env = {}, input = '{"hook_event_name":"PreCompact","trigger":"manual","custom_instructions":null}') {
  const clean = { ...process.env };
  delete clean.COMPACTION_INSTRUCTION;
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...clean, ...env } });
}

test("prints the measured text: 694 bytes with the measured hash", () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.equal(Buffer.byteLength(r.stdout), MEASURED_BYTES);
  assert.equal(createHash("sha256").update(r.stdout, "utf8").digest("hex"), MEASURED_SHA256);
});

test("the output does not depend on the hook input", () => {
  const a = run({}, "");
  const b = run({}, "not json");
  const c = run({}, '{"trigger":"auto"}');
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.stdout, c.stdout);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
});

test("the off switch gives an empty output and exit code 0", () => {
  for (const v of ["off", "OFF", "0", "false", "no", " off "]) {
    const r = run({ COMPACTION_INSTRUCTION: v });
    assert.equal(r.status, 0, v);
    assert.equal(r.stdout, "", v);
    assert.equal(isOff({ COMPACTION_INSTRUCTION: v }), true, v);
  }
  assert.equal(isOff({}), false);
  assert.equal(isOff({ COMPACTION_INSTRUCTION: "on" }), false);
});

test("a missing text file gives an empty output and no throw", () => {
  assert.equal(instructionText({}, path.join(ROOT, "no-such-file.txt")), "");
});

test("the script uses no network module, no child process and no write call", () => {
  const src = readFileSync(SCRIPT, "utf8");
  for (const bad of ["node:http", "node:https", "node:net", "node:dgram", "node:child_process", "fetch(", "writeFile", "appendFile"]) {
    assert.equal(src.includes(bad), false, bad);
  }
});

test("the plugin has one hook entry, for PreCompact", () => {
  const hooks = JSON.parse(readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks), ["PreCompact"]);
  assert.equal(hooks.PreCompact.length, 1);
  assert.equal(hooks.PreCompact[0].hooks.length, 1);
  assert.match(hooks.PreCompact[0].hooks[0].command, /precompact\.mjs/);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "compaction-instruction");
  assert.deepEqual(readdirSync(path.join(ROOT, "scripts")), ["precompact.mjs"]);
});
