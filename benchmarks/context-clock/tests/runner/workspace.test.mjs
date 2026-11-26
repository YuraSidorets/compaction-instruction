import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  REPO_ROOT, assertOutsideRepo, createWorkspace, listFilesRel, modeEnv, removeStageMaterial, removeWorkspace, writeStageMaterial,
} from "../../runner/workspace.mjs";
import { cleanup, readTask, tmp } from "./helpers.mjs";

const PARENT = {
  PATH: "p", CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", ctx_clock_extra: "x", CONTEXT_MODE_DATA_DIR: "/leak",
  CLAUDECODE: "1", CLAUDE_PROJECT_DIR: "/repo", CLAUDE_CODE_SESSION_ID: "s", CODEX_THREAD_ID: "t", KEEP_ME: "yes",
};

test("mode A has no clock variable, even when the parent shell sets them", () => {
  const env = modeEnv("A", "/data", PARENT);
  assert.equal(env.CTX_CLOCK, undefined);
  assert.equal(env.CTX_CLOCK_FEEDBACK, undefined);
  assert.equal(env.ctx_clock_extra, undefined);
  assert.equal(env.CONTEXT_MODE_DATA_DIR, "/data");
  assert.equal(env.KEEP_ME, "yes");
  for (const k of ["CLAUDECODE", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) assert.equal(env[k], undefined, k);
});

test("mode B sets CTX_CLOCK=1 and feedback off; mode C leaves feedback unset", () => {
  const b = modeEnv("B", "/data", PARENT);
  assert.equal(b.CTX_CLOCK, "1");
  assert.equal(b.CTX_CLOCK_FEEDBACK, "off");
  const c = modeEnv("C", "/data", { ...PARENT, CTX_CLOCK: "0" });
  assert.equal(c.CTX_CLOCK, "1");
  assert.equal("CTX_CLOCK_FEEDBACK" in c, false);
  assert.throws(() => modeEnv("X", "/data", PARENT), /unknown mode/);
  const d = modeEnv("D", "/data", { ...PARENT, CCB_SHIM_LOG: "/old", CCB_FEEDBACK: "real" });
  assert.equal(d.CTX_CLOCK, "1");
  assert.equal("CTX_CLOCK_FEEDBACK" in d, false);
  assert.equal(d.CCB_FEEDBACK, "placebo");
  assert.equal("CCB_SHIM_LOG" in d, false, "an overlay variable of the parent never reaches the child");
  assert.equal("CCB_FEEDBACK" in modeEnv("C", "/data", { ...PARENT, CCB_FEEDBACK: "placebo" }), false);
});

test("a workspace is outside the repository, has git and a working feed.mjs", () => {
  const root = tmp("ws");
  try {
    assert.throws(() => assertOutsideRepo(join(REPO_ROOT, "x")), /inside the repository/);
    assert.throws(() => createWorkspace(join(REPO_ROOT, "benchmarks", "tmp"), "r", 1), /inside the repository/);
    const ws = createWorkspace(root, "claude__T1__A__r1", 1);
    assert.equal(ws.git, true);
    assert.ok(existsSync(join(ws.dir, ".git")));
    assert.notEqual(ws.dir, ws.dataDir);
    const stage = readTask("T1-runner-long").stages[0];
    const written = writeStageMaterial(ws.dir, stage);
    const ok = spawnSync(process.execPath, ["feed.mjs", "log1"], { cwd: ws.dir, encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, stage.feeds[0].content);
    const bad = spawnSync(process.execPath, ["feed.mjs", "../x"], { cwd: ws.dir, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    removeStageMaterial(ws.dir, written);
    const gone = spawnSync(process.execPath, ["feed.mjs", "log1"], { cwd: ws.dir, encoding: "utf8" });
    assert.equal(gone.status, 1);
    assert.match(gone.stderr + gone.stdout, /no output named/);
    removeWorkspace(ws);
    assert.equal(existsSync(ws.dir), false);
    assert.equal(existsSync(ws.dataDir), false);
  } finally {
    cleanup(root);
  }
});

test("stage material exists after write and is gone after remove, with empty folders", () => {
  const root = tmp("mat");
  try {
    const ws = createWorkspace(root, "r", 1);
    const before = listFilesRel(ws.dir);
    const stage = readTask("T1-runner-long").stages[0];
    const written = writeStageMaterial(ws.dir, stage);
    assert.deepEqual(listFilesRel(ws.dir), [...before, ".feed/log1.txt", "conf/app.ini"].sort());
    assert.equal(readFileSync(join(ws.dir, "conf", "app.ini"), "utf8"), stage.files[0].content);
    removeStageMaterial(ws.dir, written);
    assert.deepEqual(listFilesRel(ws.dir), before);
    assert.equal(existsSync(join(ws.dir, "conf")), false);
    assert.equal(existsSync(join(ws.dir, ".feed")), false);
    assert.throws(() => writeStageMaterial(ws.dir, { files: [{ path: "../escape.txt", content: "x" }] }), /leaves the workspace/);
    removeWorkspace(ws);
  } finally {
    cleanup(root);
  }
});
