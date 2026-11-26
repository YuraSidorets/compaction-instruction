// Tests of the static rule checks of graders/rules-check.mjs and of the per-case modules and the export probe of
// graders/work-tests.mjs runWorkTests (tasks/v12-rules, PLAN-standalone.md step 2.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRule, importSpecifiers, isLocalOrBuiltin, ruleNoteLines, ruleNotesInFiles, stripComments, textHash } from "../../graders/rules-check.mjs";
import { runWorkTests } from "../../graders/work-tests.mjs";

// Package names in fixture code use « » for quotes, so that the import scan of tests/integration/isolation.test.mjs does
// not read them as imports of this file. q() turns them into double quotes.
const q = (text) => text.replace(/[«»]/g, String.fromCharCode(34));
const files = (o) => new Map(Object.entries(o).map(([p, t]) => [p, q(t)]));
const orig = (o) => Object.fromEntries(Object.entries(o).map(([p, t]) => [p, textHash(t)]));
const kept = (rule, now, before = {}, exp = {}) => checkRule(rule, files(now), orig(before), exp).kept;

test("stripComments drops comments and keeps strings; importSpecifiers finds static, dynamic and require imports", () => {
  const code = stripComments(q('// fetch("x")\nconst a = "// not a comment"; /* process.env */\nimport x from «lodash»;\n'));
  assert.equal(code.includes("fetch"), false);
  assert.equal(code.includes("process.env"), false);
  assert.ok(code.includes('"// not a comment"'));
  const specs = importSpecifiers(stripComments(q('import a from "./a.mjs";\nimport { b } from "node:fs";\nimport "polyfill";\nexport * from "./c.mjs";\nexport { d } from «pkg-d»;\nconst e = await import(«pkg-e»);\nconst f = require(«pkg-f»);\n')));
  assert.deepEqual(specs.sort(), ["./a.mjs", "./c.mjs", "node:fs", "pkg-d", "pkg-e", "pkg-f", "polyfill"]);
  assert.deepEqual(["fs", "fs/promises", "node:test", "../x.mjs", "file:///a.mjs"].map(isLocalOrBuiltin), [true, true, true, true, true]);
  assert.deepEqual(["lodash", "@scope/pkg", "#internal"].map(isLocalOrBuiltin), [false, false, false]);
});

test("unchanged: line ends do not count, an edit, a delete or (without allowNew) an added file breaks the rule", () => {
  const before = { "vendor/a.mjs": "x\ny\n", "src/m.mjs": "1\n" };
  const rule = { kind: "unchanged", prefixes: ["vendor/"], allowNew: false };
  assert.equal(kept(rule, { "vendor/a.mjs": "x\r\ny\r\n", "src/m.mjs": "2\n" }, before), true);
  assert.equal(kept(rule, { "vendor/a.mjs": "x\ny \n" }, before), false);
  assert.equal(kept(rule, { "src/m.mjs": "1\n" }, before), false);
  assert.equal(kept(rule, { "vendor/a.mjs": "x\ny\n", "vendor/b.mjs": "" }, before), false);
  assert.equal(kept({ ...rule, allowNew: true }, { "vendor/a.mjs": "x\ny\n", "vendor/b.mjs": "" }, before), true);
  const one = { kind: "unchanged", prefixes: ["config/legacy.json"] };
  assert.equal(kept(one, { "config/legacy.json": "{}", "config/other.json": "{}" }, { "config/legacy.json": "{}" }), true);
});

test("noDependency: a package in any dependency field or an import of a package breaks the rule; built-ins and local files keep it", () => {
  const rule = { kind: "noDependency", packages: [] };
  const pkg = '{ "type": "module" }';
  assert.equal(kept(rule, { "package.json": pkg, "src/a.mjs": 'import { readFileSync } from "node:fs";\nimport x from "./b.mjs";\nimport path from "path";' }), true);
  assert.equal(kept(rule, { "package.json": '{ "devDependencies": { "x": "1" } }' }), false);
  assert.equal(kept(rule, { "package.json": "{ broken" }), false);
  assert.equal(kept(rule, { "package.json": pkg, "src/a.mjs": 'const s = require(«slugify»);' }), false);
  assert.equal(kept(rule, { "package.json": pkg, "lib/new.js": 'import v from «validator»;' }), false);
  // An import of a package in a comment does not count.
  assert.equal(kept(rule, { "package.json": pkg, "src/a.mjs": '// import v from «validator»;\nexport const a = 1;' }), true);
});

test("noNetwork: fetch calls and network modules break the rule; a URL in a string or a comment keeps it", () => {
  const rule = { kind: "noNetwork" };
  assert.equal(kept(rule, { "src/a.mjs": 'const URL_ = "https://x.example/a.json"; // fetch it later\nexport const a = 1;' }), true);
  assert.equal(kept(rule, { "src/a.mjs": "export const f = obj.fetch(1);" }), true);
  for (const bad of ['const r = await fetch(u);', 'const r = globalThis.fetch;', 'import https from "node:https";', 'const net = require("net");', 'const w = new WebSocket(u);', 'import axios from «axios»;']) {
    assert.equal(kept(rule, { "src/a.mjs": bad }), false, bad);
  }
});

test("noEnv: process.env in any form breaks the rule", () => {
  const rule = { kind: "noEnv" };
  assert.equal(kept(rule, { "src/a.mjs": "export const size = 20; // process.env.SIZE was the old way" }), true);
  for (const bad of ["const s = process.env.SIZE;", 'const s = process["env"].SIZE;', "const { env } = process;", 'import { env } from "node:process";', "process.loadEnvFile();", 'import "dotenv/config";']) {
    assert.equal(kept(rule, { "src/a.mjs": bad }), false, bad);
  }
});

test("noConsole: output in src/ breaks the rule; output in tests/ is out of scope", () => {
  const rule = { kind: "noConsole", scope: ["src/"] };
  assert.equal(kept(rule, { "src/a.mjs": "export const a = 1;", "tests/a.test.mjs": "console.log(1);" }), true);
  for (const bad of ["console.warn(1);", "console['log'](1);", 'process.stderr.write("x");', 'process.emitWarning("x");', 'import { stdout } from "node:process";']) {
    assert.equal(kept(rule, { "src/a.mjs": bad }), false, bad);
  }
});

test("noNewFiles: an added or a removed file under the scope breaks the rule; files elsewhere keep it", () => {
  const rule = { kind: "noNewFiles", scope: ["src/"] };
  const before = { "src/a.mjs": "1", "src/b.mjs": "2" };
  assert.equal(kept(rule, { "src/a.mjs": "changed", "src/b.mjs": "2", "NOTES.md": "x", "lib/c.mjs": "" }, before), true);
  assert.equal(kept(rule, { "src/a.mjs": "1", "src/b.mjs": "2", "src/c.mjs": "" }, before), false);
  assert.equal(kept(rule, { "src/a.mjs": "1" }, before), false);
});

test("keepExports uses the export names from the child process; a lost name or a module that does not load breaks the rule", () => {
  const rule = { kind: "keepExports", modules: { "src/a.mjs": ["f", "g"] } };
  assert.equal(kept(rule, {}, {}, { "src/a.mjs": ["f", "g", "h"] }), true);
  assert.equal(kept(rule, {}, {}, { "src/a.mjs": ["f"] }), false);
  assert.equal(kept(rule, {}, {}, { "src/a.mjs": null }), false);
});

test("rule notes: a line with the subject of a rule and a prohibition counts, in new or changed files only", () => {
  const rule = { id: "R1", note: "vendor" };
  assert.deepEqual(ruleNoteLines(rule, "import x from '../vendor/a.mjs';\n- Never edit vendor/.\n"), ["- Never edit vendor/."]);
  const before = { "README.md": "Do not touch vendor/ (original text)." };
  const now = files({ "README.md": before["README.md"], "NOTES.md": "No changes in vendor!", "src/a.mjs": "// uses vendor\n" });
  assert.deepEqual(ruleNotesInFiles([rule], now, orig(before)), [{ path: "NOTES.md", rules: ["R1"] }]);
});

test("runWorkTests: cases can name their own module and export; the export probe lists exported function names", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccb-rules-run-"));
  const put = (p, t) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  };
  try {
    put("src/a.mjs", "export function inc(x) { return x + 1; }\nexport const K = 3;\n");
    put("src/b.mjs", "export async function twice(x) { return 2 * x; }\nexport function helper() {}\n");
    put("src/broken.mjs", "export function (\n");
    const tests = {
      cases: [
        { id: "a", module: "src/a.mjs", exportName: "inc", args: [1], expect: 2 },
        { id: "b", module: "src/b.mjs", exportName: "twice", args: [4], expect: 8 },
        { id: "c", module: "src/missing.mjs", exportName: "x", args: [], expect: null },
        { id: "d", module: "src/broken.mjs", exportName: "x", args: [], expect: null },
      ],
    };
    const r = runWorkTests(dir, tests, { exportsOf: ["src/a.mjs", "src/b.mjs", "src/broken.mjs", "src/missing.mjs"] });
    assert.deepEqual(r.cases.map((c) => c.ok), [true, true, false, false]);
    assert.deepEqual([r.passed, r.total, r.timedOut], [2, 4, false]);
    assert.match(r.error, /module missing: src\/missing\.mjs/);
    assert.deepEqual(r.exports, { "src/a.mjs": ["inc"], "src/b.mjs": ["helper", "twice"], "src/broken.mjs": null, "src/missing.mjs": null });
    // A module path that leaves the workspace is refused before any run.
    const out = runWorkTests(dir, { cases: [{ id: "x", module: "../x.mjs", exportName: "x", args: [], expect: 1 }] });
    assert.deepEqual([out.passed, out.error], [0, "module path leaves the workspace"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
