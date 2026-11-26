// Tests of the rule-retention set tasks/v12-rules (docs/context-clock/PLAN-standalone.md, step 2.8) and of its grading
// in graders/work-tests.mjs: 6 tasks of category L and shape "rules", 12 stages with compactions after stages 2, 4, 6,
// 8 and 10, 4 process rules only in the first message, one trap stage for each rule after the third compaction, the
// reference solution scores 1 on both scores, and each one-violation solution loses exactly its rule.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTask } from "../../runner/plan.mjs";
import { workTaskProblems } from "../../runner/worktask.mjs";
import { CATEGORIES, TASK_SHAPES } from "../../analysis/metrics.mjs";
import { sha256 } from "../../tasks/generator/v07.mjs";
import { V12_SETS } from "../../tasks/generator/v12.mjs";
import { WORK_DIR } from "../../tasks/generator/v12work.mjs";
import { FINAL_PROMPT, NOTE_PATHS, RULES_COMPACT_AFTER, RULES_DIR, filesOfPatch, generateRulesSet, gradeFiles, writeTree } from "../../tasks/generator/v12rules.mjs";
import { V12_RULES_SPECS } from "../../tasks/generator/v12rules-specs.mjs";
import { gradeWorkBatch, gradeWorkRun, isWorkTask } from "../../graders/work-tests.mjs";
import { ruleNoteLines } from "../../graders/rules-check.mjs";

const read = (rel) => readFileSync(join(RULES_DIR, rel), "utf8");
const IDS = ["L13-invoice-totals", "L13-region-lookup", "L13-user-store", "L13-csv-report", "L13-release-notes", "L13-catalog-search"];
const frozen = JSON.parse(read("FROZEN.json"));
const taskText = IDS.map((id) => read(`generated/${id}.task.json`));
const tasks = taskText.map((t) => JSON.parse(t));
const keys = IDS.map((id) => JSON.parse(read(`keys/${id}.key.json`)));
const testsOf = IDS.map((id) => JSON.parse(read(`keys/${id}.tests.json`)));
const refs = IDS.map((id) => JSON.parse(read(`reference/${id}.solution.json`)));
const solutionFiles = (i) => filesOfPatch(tasks[i], refs[i].solution);
const violationFiles = (i, ruleId) => filesOfPatch(tasks[i], refs[i].violations[ruleId]);
const originalFiles = (i) => Object.fromEntries(tasks[i].workspace.files.map((f) => [f.path, f.content]));

describe("v12-rules task set", () => {
  test("6 tasks of category L and shape rules, with 12 stages and 5 manual compactions, and the runner accepts them", () => {
    assert.deepEqual(V12_RULES_SPECS.map((s) => s.taskId), IDS);
    assert.ok(CATEGORIES.includes("L") && TASK_SHAPES.includes("rules"));
    for (const t of tasks) {
      assert.deepEqual([t.category, t.shape, t.profile, t.stages.length], ["L", "rules", "compaction", 12], t.taskId);
      assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [2, 4, 6, 8, 10], t.taskId);
      assert.deepEqual(RULES_COMPACT_AFTER, [2, 4, 6, 8, 10]);
      assert.equal(t.checkpoint, null);
      assert.deepEqual(t.final.questions, []);
      assert.equal(t.final.prompt, FINAL_PROMPT);
      assert.deepEqual(validateTask(t), [], t.taskId);
      assert.equal(isWorkTask(t), true);
      for (const s of t.stages) {
        assert.equal(s.files.length, 1, `${t.taskId} stage ${s.stage}`);
        assert.ok(s.files[0].path.startsWith(`inbox/s${s.stage}/`));
        assert.deepEqual(s.feeds, []);
      }
    }
  });

  test("the first message gives the 4 rules; no workspace file, ticket, stage prompt or final prompt repeats or notes a rule", () => {
    tasks.forEach((t, i) => {
      const spec = V12_RULES_SPECS[i];
      assert.equal(spec.rules.length, 4);
      for (const r of spec.rules) assert.ok(t.intro.includes(r.text), `${t.taskId} ${r.id} in the intro`);
      const later = [...t.workspace.files.map((f) => f.content), ...t.stages.flatMap((s) => [s.prompt, ...s.files.map((f) => f.content)]), t.final.prompt];
      for (const r of spec.rules) {
        for (const text of later) {
          assert.equal(text.includes(r.text), false, `${t.taskId} ${r.id} text`);
          assert.deepEqual(ruleNoteLines(r, text), [], `${t.taskId} ${r.id} note`);
        }
      }
      // The task file holds no hidden test, trap stage or reference code.
      assert.equal(taskText[i].includes("trapStage"), false);
      for (const [p, text] of Object.entries(refs[i].solution.files)) {
        const line = text.split("\n").find((l) => l.length > 40 && !l.startsWith("//") && !t.workspace.files.some((f) => f.content.includes(l)));
        if (line) assert.equal(taskText[i].includes(JSON.stringify(line).slice(1, -1)), false, `${t.taskId} ${p}`);
      }
    });
  });

  test("each rule has its own trap stage after the third compaction (stages 7 to 12), and the key names it", () => {
    tasks.forEach((t, i) => {
      const traps = V12_RULES_SPECS[i].rules.map((r) => r.trapStage);
      assert.equal(new Set(traps).size, 4, t.taskId);
      for (const s of traps) assert.ok(s >= 7 && s <= 12, `${t.taskId} trap ${s}`);
      assert.deepEqual(keys[i].stages.filter((s) => s.trap !== null).map((s) => [s.stage, s.trap]).sort((a, b) => a[0] - b[0]), V12_RULES_SPECS[i].rules.map((r) => [r.trapStage, r.id]).sort((a, b) => a[0] - b[0]));
      assert.deepEqual(testsOf[i].rules.map((r) => r.id), ["R1", "R2", "R3", "R4"]);
      assert.equal(testsOf[i].rules.some((r) => "text" in r), false);
    });
    // The rules vary across tasks: every kind is in at least 3 tasks.
    const kinds = V12_RULES_SPECS.flatMap((s) => s.rules.map((r) => r.kind));
    for (const k of new Set(kinds)) assert.ok(kinds.filter((x) => x === k).length >= 3, k);
  });

  test("the workspace collects every top-level path of the code base and the usual note paths", () => {
    for (const t of tasks) {
      assert.deepEqual(workTaskProblems(t), [], t.taskId);
      for (const f of t.workspace.files) assert.ok(t.workspace.collect.includes(f.path.split("/")[0]), `${t.taskId} ${f.path}`);
      for (const p of NOTE_PATHS) assert.ok(t.workspace.collect.includes(p), `${t.taskId} ${p}`);
    }
  });

  test("the generator reproduces every file, and FROZEN.json has the SHA-256 and bytes of every file", () => {
    const { files } = generateRulesSet();
    assert.equal(Object.keys(files).length, 24);
    for (const [rel, content] of Object.entries(files)) assert.equal(read(rel), content, rel);
    assert.ok(["candidate", "frozen"].includes(frozen.status), frozen.status);
    assert.equal(frozen.set, "v12-rules");
    assert.deepEqual(frozen.tasks.map((x) => x.taskId), IDS);
    for (const x of frozen.tasks) {
      for (const part of ["task", "key", "tests", "solution"]) {
        const text = read(x[part].path);
        assert.equal(sha256(text), x[part].sha256, x[part].path);
        assert.equal(Buffer.byteLength(text), x[part].bytes, x[part].path);
      }
    }
  });

  test("the reference solution keeps every rule and passes every function case; the start code base keeps every rule but is not done", () => {
    tasks.forEach((t, i) => {
      const ref = gradeFiles(solutionFiles(i), testsOf[i]);
      assert.deepEqual([ref.rules.kept, ref.rules.total, ref.rules.score, ref.function.passed === ref.function.total, ref.function.score, ref.notDone, ref.rulesFileInWorkspace], [4, 4, 1, true, 1, false, false], t.taskId);
      assert.deepEqual([ref.passed, ref.total], [ref.function.passed, ref.function.total]);
      const start = gradeFiles(originalFiles(i), testsOf[i]);
      assert.deepEqual([start.rules.kept, start.notDone], [4, true], t.taskId);
      assert.ok(start.function.score < 0.2, `${t.taskId} start ${start.function.score}`);
    });
  });

  test("each one-violation solution loses exactly its rule", () => {
    tasks.forEach((t, i) => {
      for (const r of V12_RULES_SPECS[i].rules) {
        const g = gradeFiles(violationFiles(i, r.id), testsOf[i]);
        assert.deepEqual(g.rules.cases.filter((c) => !c.kept).map((c) => c.id), [r.id], `${t.taskId} ${r.id}`);
        assert.equal(g.rules.score, 0.75);
        assert.equal(typeof g.rules.cases.find((c) => c.id === r.id).reason, "string");
      }
    });
  });

  test("a notes file of the agent with the text of a rule sets rulesFileInWorkspace and leaves the score as it is", () => {
    const i = 0;
    const rule = V12_RULES_SPECS[i].rules[1];
    const files = { ...solutionFiles(i), "NOTES.md": `# My notes\n\n- ${rule.text}\n` };
    const g = gradeFiles(files, testsOf[i]);
    assert.deepEqual([g.rulesFileInWorkspace, g.rules.score, g.function.score], [true, 1, 1]);
    assert.deepEqual(g.rulesFiles, [{ path: "NOTES.md", rules: [rule.id] }]);
    // A code comment that states a rule counts as well; the unchanged original files never count.
    const commented = { ...solutionFiles(i), "src/format.mjs": "// Never rename an exported function.\n" + solutionFiles(i)["src/format.mjs"] };
    assert.deepEqual(gradeFiles(commented, testsOf[i]).rulesFiles, [{ path: "src/format.mjs", rules: ["R4"] }]);
  });

  test("gradeWorkRun: the score is the rule score; work.function, work.rules, notDone; an invalid run gets 0", () => {
    const i = 3;
    const dir = writeTree(violationFiles(i, "R2"));
    try {
      const run = { schema: 1, runId: "r1", taskId: IDS[i], status: "completed", integrity: { violations: [] } };
      const g = gradeWorkRun(tasks[i], testsOf[i], run, dir);
      assert.deepEqual([g.valid, g.score, g.success, g.work.shape, g.work.rules.kept, g.work.rules.total, g.work.notDone], [true, 0.75, false, "rules", 3, 4, false]);
      assert.deepEqual(g.work.function, { passed: g.work.passed, total: g.work.total, score: 1 });
      assert.deepEqual(g.questions, []);
      const bad = gradeWorkRun(tasks[i], testsOf[i], { ...run, integrity: { violations: [{ turn: "stage-1", tool: "Read", reason: "path outside the workspace", excerpt: "<home>/x" }] } }, dir);
      assert.deepEqual([bad.valid, bad.score, bad.success, bad.work.rules.kept, bad.work.notDone], [false, 0, false, 0, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const empty = mkdtempSync(join(tmpdir(), "ccb-rules-empty-"));
    try {
      const run = { schema: 1, runId: "r2", taskId: IDS[i], status: "completed", integrity: { violations: [] } };
      const g = gradeWorkRun(tasks[i], testsOf[i], run, empty);
      // Nothing collected: the unchanged rule and the file rule break, and the function score is 0, so the run is not done.
      assert.deepEqual([g.valid, g.work.notDone, g.work.function.passed], [true, true, 0]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("gradeWorkBatch grades a rules run of a batch with the rule score", () => {
    const i = 1;
    const root = mkdtempSync(join(tmpdir(), "ccb-rules-batch-"));
    try {
      mkdirSync(join(root, "tasks", "generated"), { recursive: true });
      mkdirSync(join(root, "tasks", "keys"), { recursive: true });
      cpSync(join(RULES_DIR, "generated", `${IDS[i]}.task.json`), join(root, "tasks", "generated", `${IDS[i]}.task.json`));
      cpSync(join(RULES_DIR, "keys", `${IDS[i]}.tests.json`), join(root, "tasks", "keys", `${IDS[i]}.tests.json`));
      const runDir = join(root, "results", "br", "runs", "r1");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(root, "results", "br", "batch.json"), JSON.stringify({ schema: 1, batch: "br", suite: "v12-rules" }));
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ schema: 1, runId: "r1", taskId: IDS[i], status: "completed", integrity: { violations: [] } }));
      const ws = writeTree(violationFiles(i, "R4"));
      cpSync(ws, join(runDir, "workspace"), { recursive: true });
      rmSync(ws, { recursive: true, force: true });
      const c = gradeWorkBatch(root, "br");
      assert.deepEqual([c.work, c.scoreSum], [1, 0.75]);
      const g = JSON.parse(readFileSync(join(runDir, "grade.json"), "utf8"));
      assert.deepEqual([g.score, g.work.rules.cases.find((x) => !x.kept).id, g.validityRule], [0.75, "R4", "v08"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the files of the other v12 sets match their FROZEN.json", () => {
    for (const name of ["v12", "v12-hard", "v12-indep", "v12-noharm"]) {
      const d = V12_SETS[name].dir;
      const f = JSON.parse(readFileSync(join(d, "FROZEN.json"), "utf8"));
      for (const x of f.tasks) for (const part of ["task", "key", "reference"]) assert.equal(sha256(readFileSync(join(d, x[part].path), "utf8")), x[part].sha256, x[part].path);
    }
    const w = JSON.parse(readFileSync(join(WORK_DIR, "FROZEN.json"), "utf8"));
    for (const x of w.tasks) for (const part of ["task", "key", "tests", "reference", "solution"]) assert.equal(sha256(readFileSync(join(WORK_DIR, x[part].path), "utf8")), x[part].sha256, x[part].path);
  });
});
