// benchmarks/context-clock/tests/integration/isolation.test.mjs
// Branch-local and merged tree: no file under benchmarks/ imports from src/ or from a package, and the benchmark
// changes no file under src/ against context-clock/v0.3-base.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BENCH, REPO, listFiles } from "./helpers.mjs";

const SRC = resolve(REPO, "src");
const CODE = [".mjs", ".js", ".cjs", ".ts", ".mts"];
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function codeFiles() {
  return listFiles(BENCH).filter((p) => CODE.some((e) => p.endsWith(e)) && !p.startsWith("results/") && !p.startsWith("work/") && !p.includes("node_modules/"));
}

test("no file under benchmarks/ imports from src/ or from a non-built-in package", () => {
  const bad = [];
  for (const rel of codeFiles()) {
    const file = join(BENCH, rel);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolve(dirname(file), spec);
        if (target === SRC || target.startsWith(SRC + "\\") || target.startsWith(SRC + "/")) bad.push(rel + " imports " + spec);
        else if (!target.startsWith(BENCH)) bad.push(rel + " imports " + spec + " from outside benchmarks/");
      } else if (spec.startsWith("node:")) {
        continue;
      } else if (!builtinModules.includes(spec.split("/")[0])) {
        bad.push(rel + " imports the package " + spec + " (Node built-in modules only)");
      }
    }
  }
  assert.deepEqual(bad, []);
});

function git(args) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

const base = git(["rev-parse", "--verify", "--quiet", "context-clock/v0.3-base"]);
const skipGit = base.status !== 0 ? "the ref context-clock/v0.3-base is not in this clone" : false;

test("no change under src/ against context-clock/v0.3-base (committed, staged, unstaged or untracked)", { skip: skipGit }, () => {
  const stat = git(["diff", "--stat", "context-clock/v0.3-base", "--", "src/"]);
  assert.equal(stat.status, 0, stat.stderr);
  assert.equal(stat.stdout.trim(), "", "git diff --stat context-clock/v0.3-base -- src/");
  const untracked = git(["status", "--porcelain", "--untracked-files=all", "--", "src/"]);
  assert.equal(untracked.stdout.trim(), "", "git status -- src/");
});
