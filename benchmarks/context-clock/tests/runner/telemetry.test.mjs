import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { integrityScan, readClockTelemetry, redact, redactionPairs, shortToolName } from "../../runner/telemetry.mjs";
import { cleanup, tmp } from "./helpers.mjs";

test("redaction replaces the workspace, the data folder and the home folder in every form", () => {
  const ws = process.platform === "win32" ? "C:\\Temp\\ccbench\\ws-1" : "/tmp/ccbench/ws-1";
  const pairs = redactionPairs({ workspace: ws, dataDir: ws + "-data", workRoot: null });
  const home = homedir();
  const rec = {
    a: `${ws}${process.platform === "win32" ? "\\" : "/"}conf/app.ini`,
    b: [ws.split("\\").join("/") + "/x", ws.split("\\").join("\\\\") + "\\\\y"],
    c: { d: `${home}/.claude/settings.json`, e: 5, f: null },
    g: `${ws}-data/projects/k/context.db`,
  };
  const out = JSON.stringify(redact(rec, pairs));
  assert.doesNotMatch(out, /ccbench/);
  assert.equal(out.includes(home), false);
  assert.equal(out.includes(home.split("\\").join("/")), false);
  assert.match(out, /<workspace>/);
  assert.match(out, /<home>/);
  assert.match(out, /<data>\/projects/);
  assert.equal(redact(rec, pairs).c.e, 5);
});

test("integrity scan: paths outside the workspace and forbidden words", () => {
  const ws = process.platform === "win32" ? "C:\\Temp\\ccbench\\ws-1" : "/tmp/ccbench/ws-1";
  const inside = process.platform === "win32" ? "C:\\Temp\\ccbench\\ws-1\\conf\\app.ini" : "/tmp/ccbench/ws-1/conf/app.ini";
  const clean = integrityScan([
    { turn: "stage-1", name: "Read", input: { file_path: inside } },
    { turn: "stage-1", name: "Bash", input: { command: "node feed.mjs log1 > /dev/null" } },
    { turn: "stage-1", name: "Bash", input: { command: "cat conf/app.ini | grep engine" } },
  ], ws);
  assert.deepEqual(clean, []);
  const bad = integrityScan([
    { turn: "stage-1", name: "Read", input: { file_path: "C:\\Git\\repo\\benchmarks\\context-clock\\key.json" } },
    { turn: "stage-2", name: "Bash", input: { command: "cat ../../secret.txt" } },
    { turn: "stage-2", name: "Bash", input: { command: "ls ~/projects" } },
    { turn: "stage-3", name: "Bash", input: { command: "ls /home/user/graders" } },
  ], ws);
  const reasons = bad.map((v) => `${v.turn}:${v.reason}`);
  assert.ok(reasons.some((r) => r.startsWith("stage-1:forbidden word")));
  assert.ok(reasons.some((r) => r === "stage-1:path outside the workspace"));
  assert.ok(reasons.some((r) => r === "stage-2:path outside the workspace"));
  assert.ok(reasons.filter((r) => r.startsWith("stage-2")).length >= 2);
  assert.ok(reasons.some((r) => r.startsWith("stage-3:forbidden word: graders")));
});

test("clock telemetry reads events, the main agent's max tick and state revision read-only", () => {
  const data = tmp("db");
  try {
    const dir = join(data, "projects", "k1");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "context.db"));
    db.exec(`CREATE TABLE clock_events (session_id TEXT, agent_id TEXT, exposure_tick INTEGER);
      CREATE TABLE clock_counters (session_id TEXT, agent_id TEXT, last_exposure_tick INTEGER, PRIMARY KEY (session_id, agent_id));
      CREATE TABLE clock_state_revisions (session_id TEXT, agent_id TEXT, revision INTEGER);
      INSERT INTO clock_events VALUES ('s','main',1),('s','main',2),('s','sub',1);
      INSERT INTO clock_counters VALUES ('s','main',9),('s','sub',40);
      INSERT INTO clock_state_revisions VALUES ('s','main',1),('s','main',3);`);
    db.close();
    const t = readClockTelemetry(data);
    assert.deepEqual({ events: t.events, maxTick: t.maxTick, stateRevision: t.stateRevision, present: t.present, error: t.error }, { events: 3, maxTick: 9, stateRevision: 3, present: true, error: null });
    const none = readClockTelemetry(join(data, "missing"));
    assert.deepEqual([none.events, none.present, none.databases], [0, false, 0]);
  } finally {
    cleanup(data);
  }
});

test("short tool names", () => {
  assert.equal(shortToolName("mcp__plugin_context-mode_context-mode__ctx_clock_status"), "ctx_clock_status");
  assert.equal(shortToolName("Read"), "Read");
});
