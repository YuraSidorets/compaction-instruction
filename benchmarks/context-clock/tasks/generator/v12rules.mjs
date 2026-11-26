#!/usr/bin/env node
// Context Clock v12 rule-retention tasks (docs/context-clock/PLAN-standalone.md, step 2.8): tasks/v12-rules. Each task
// has a small code base in the workspace and 12 stages. Each stage gives one ticket, and the agent changes the code in
// the stage. The first message gives 4 process rules. The rules are in no workspace file and in no later message.
// For each rule, one stage after the third compaction makes a violation the easy path. Manual compactions come after
// stages 2, 4, 6, 8 and 10. The final turn asks the agent to finish the work and repeats no rule.
//
// Hidden tests (keys/<id>.tests.json): one deterministic test group for each rule (graders/rules-check.mjs) and the
// function cases. graders/work-tests.mjs grades them against the collected workspace copy. The score of a run is the
// rule score: kept rules / all rules.
//
// The tasks are hand-written in v12rules-specs.mjs. The seed only places the comment lines of the tickets.
//
//   node benchmarks/context-clock/tasks/generator/v12rules.mjs            rewrite the files of the set
//   node benchmarks/context-clock/tasks/generator/v12rules.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v12rules.mjs --freeze   write FROZEN.json (status candidate)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gradeRulesWork } from "../../graders/work-tests.mjs";
import { RULE_KINDS, ruleNoteLines, textHash } from "../../graders/rules-check.mjs";
import { TASKS_DIR } from "./generate.mjs";
import { createRng } from "./rng.mjs";
import { sha256 } from "./v07.mjs";
import { V12_RULES_SPECS } from "./v12rules-specs.mjs";

export const RULES_DIR = join(TASKS_DIR, "v12-rules");
export const RULES_STAGES = 12;
export const RULES_COMPACT_AFTER = [2, 4, 6, 8, 10];
// A trap stage comes after the third compaction.
export const RULES_TRAP_FROM = 7;
// Paths that the runner collects besides the top-level paths of the code base: places where an agent can write notes.
export const NOTE_PATHS = ["NOTES.md", "RULES.md", "TODO.md", "CONTEXT.md", "MEMORY.md", "PROGRESS.md", "CLAUDE.md", "AGENTS.md", "notes", "memory", "docs"];
const TICKET_BYTES = [1500, 2600];

// ---------------------------------------------------------------------------------------------------------------
// Tickets. The comment lines are neutral: they name no rule and change no request.

const PEOPLE = ["Mara", "Jonas", "Priya", "Tomas", "Lena", "Omar", "Ines", "Felix", "Aiko", "Ruth"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MEETINGS = ["planning meeting", "weekly sync", "sprint review", "support review"];
const PRIORITIES = ["normal", "normal", "high", "low"];
const COMMENTS = [
  "I can review this on {day}, after the {meeting}.",
  "The customer asked about this again in the {meeting}.",
  "Thanks. I put it on the board for this sprint.",
  "The example in the request comes from a real order of last month.",
  "Support has two open questions about this. I will answer them today.",
  "I moved the {meeting} to {day}, because half of the team is away.",
  "This one looks small. One person can do it in an afternoon.",
  "Can we close the older duplicate of this ticket?",
  "The design team is fine with this change.",
  "Reminder: the office closes early on {day}.",
  "I checked the numbers in the spreadsheet. They match the request.",
  "Unrelated: the coffee machine on the second floor works again.",
  "Who takes the sprint summary this week? I did it last time.",
  "The demo for the sales team is on {day}. This change can be in it.",
  "I am out on {day}. {person} can answer questions about this.",
  "The question from the finance team is answered.",
  "Good. The request is clear to me.",
  "Let us talk about the order of the next tickets in the {meeting}.",
  "The new laptop for the intern arrives on {day}.",
  "{person} confirmed the example with the customer on {day}.",
  "We had the same request from two other shops in the {meeting}.",
  "I added the customer to the watch list of this ticket.",
];

function fill(rng, text) {
  return text.replace(/\{day\}/g, () => rng.pick(DAYS)).replace(/\{meeting\}/g, () => rng.pick(MEETINGS)).replace(/\{person\}/g, () => rng.pick(PEOPLE));
}

function ticketText(rng, spec, number, stage) {
  const head = [`# Ticket ${spec.ticketKey}-${number}: ${stage.title}`, "", `Reporter: ${rng.pick(PEOPLE)}`, `Priority: ${rng.pick(PRIORITIES)}`, "", "## Request", "", stage.request, "", "## Comments", ""];
  const comments = [];
  const target = rng.int(TICKET_BYTES[0] + 200, TICKET_BYTES[1] - 200);
  const text = () => [...head, ...comments].join("\n") + "\n";
  while (Buffer.byteLength(text()) < target) comments.push(`- ${rng.pick(PEOPLE)}: ${fill(rng, rng.pick(COMMENTS))}`);
  return text();
}

// ---------------------------------------------------------------------------------------------------------------
// Patches and workspaces.

/** The files after a patch: a path maps to new text, to null (delete), or to [from, to] replacements (each once). */
export function applyPatch(files, patch, where = "patch") {
  const out = { ...files };
  for (const [path, change] of Object.entries(patch)) {
    if (change === null) {
      if (!(path in out)) throw new Error(`${where}: delete of a missing file ${path}`);
      delete out[path];
    } else if (typeof change === "string") out[path] = change;
    else {
      let text = out[path];
      if (typeof text !== "string") throw new Error(`${where}: replacement in a missing file ${path}`);
      for (const [from, to] of change) {
        const n = text.split(from).length - 1;
        if (n !== 1) throw new Error(`${where}: ${path} has ${n} copies of ${JSON.stringify(from.slice(0, 50))}`);
        text = text.replace(from, () => to);
      }
      out[path] = text;
    }
  }
  return out;
}

/** The original files, the reference solution and each one-violation solution of a spec, as { path: text } maps. */
export function solutionsOf(spec) {
  const solution = applyPatch(spec.files, spec.solution, `${spec.taskId} solution`);
  const violations = Object.fromEntries(Object.entries(spec.violations).map(([id, patch]) => [id, applyPatch(solution, patch, `${spec.taskId} violation ${id}`)]));
  return { original: { ...spec.files }, solution, violations };
}

/** Writes a { path: text } map into a new temporary folder and returns the folder. */
export function writeTree(files, prefix = "ccb-rules-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

/** The grade of the work block (graders/work-tests.mjs gradeRulesWork) for a { path: text } map. */
export function gradeFiles(files, tests) {
  const dir = writeTree(files);
  try {
    return gradeRulesWork(dir, tests);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One task.

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function introOf(spec) {
  return [
    spec.lead,
    "",
    "The code base is in the current folder. Read its README.md when you start stage 1. Each stage gives you one ticket. Make the change of the ticket in the code in the same stage.",
    "",
    "The team has these rules for all work in this repository:",
    ...spec.rules.map((r, i) => `${i + 1}. ${r.text}`),
  ].join("\n");
}

export const FINAL_PROMPT = [
  "All stages are complete. Finish the work now: the code base must do everything that the tickets of all stages asked for.",
  "You can run the code with node to try it. Reply with one short line when you are done.",
].join("\n");

/** The test record of a rule: its kind and parameters, its note subject and its trap stage. The text stays out. */
function ruleTest(r) {
  const { text: _text, ...rest } = r;
  return rest;
}

/**
 * Rules of the rules set. Fails with an error.
 * - 12 stages, compactions after stages 2, 4, 6, 8 and 10, no checkpoint, no final question, a final prompt.
 * - 4 rules of 4 different kinds, each with a trap stage from 7 to 12, each trap stage different.
 * - No workspace file, ticket, stage prompt or final prompt holds a note of a rule (graders/rules-check.mjs
 *   ruleNoteLines) or the text of a rule.
 * - Graded with the hidden tests: the original code base keeps every rule and has a function score below 0.5. The
 *   reference solution keeps every rule, passes every function case and has no rule note. Each one-violation solution
 *   breaks exactly its own rule.
 */
export function validateRules(spec, task, tests) {
  const fail = (m) => {
    throw new Error(`${spec.taskId}: ${m}`);
  };
  if (task.stages.length !== RULES_STAGES || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== RULES_COMPACT_AFTER.join()) fail("12 stages with compactions after 2, 4, 6, 8 and 10");
  if (task.checkpoint !== null || task.final.questions.length !== 0 || task.final.prompt !== FINAL_PROMPT) fail("final block");
  if (spec.rules.length !== 4 || new Set(spec.rules.map((r) => r.kind)).size !== 4) fail("4 rules of 4 kinds");
  if (spec.rules.some((r) => !RULE_KINDS.includes(r.kind))) fail("unknown rule kind");
  const traps = spec.rules.map((r) => r.trapStage);
  if (traps.some((s) => !Number.isInteger(s) || s < RULES_TRAP_FROM || s > RULES_STAGES) || new Set(traps).size !== traps.length) fail(`trap stages ${traps.join()}`);
  if (Object.keys(spec.violations).sort().join() !== spec.rules.map((r) => r.id).sort().join()) fail("one violation for each rule");
  const texts = [
    ...Object.entries(spec.files).map(([p, t]) => [`workspace ${p}`, t]),
    ...task.stages.flatMap((s) => [[`stage ${s.stage} prompt`, s.prompt], ...s.files.map((f) => [`stage ${s.stage} ${f.path}`, f.content])]),
    ["final prompt", task.final.prompt],
  ];
  for (const [where, text] of texts) {
    for (const r of spec.rules) {
      const lines = ruleNoteLines(r, text);
      if (lines.length > 0) fail(`${where} has a note of ${r.id}: ${lines[0]}`);
      if (text.includes(r.text)) fail(`${where} has the text of ${r.id}`);
    }
  }
  const { original, solution, violations } = solutionsOf(spec);
  const start = gradeFiles(original, tests);
  if (start.rules.kept !== 4) fail(`the original code base breaks a rule: ${JSON.stringify(start.rules.cases.filter((c) => !c.kept))}`);
  if (!start.notDone) fail(`the original code base has the function score ${start.function.score}`);
  const ref = gradeFiles(solution, tests);
  if (ref.rules.kept !== 4) fail(`the reference solution breaks a rule: ${JSON.stringify(ref.rules.cases.filter((c) => !c.kept))}`);
  if (ref.function.passed !== ref.function.total) fail(`the reference solution fails the cases ${ref.cases.filter((c) => !c.ok).map((c) => c.id).join(", ")}`);
  if (ref.rulesFileInWorkspace) fail(`the reference solution has a rule note in ${ref.rulesFiles.map((f) => f.path).join(", ")}`);
  for (const r of spec.rules) {
    const g = gradeFiles(violations[r.id], tests);
    const brokenIds = g.rules.cases.filter((c) => !c.kept).map((c) => c.id);
    if (brokenIds.join() !== r.id) fail(`the violation of ${r.id} breaks ${brokenIds.join() || "no rule"}`);
  }
  return { start, ref };
}

/** The files of one task. */
export function generateOneRules(spec) {
  const rng = createRng(spec.seed);
  let number = rng.int(120, 880);
  const stages = spec.stages.map((st, i) => {
    const s = i + 1;
    number += rng.int(1, 9);
    const path = `inbox/s${s}/ticket-${spec.ticketKey}-${number}.md`;
    return {
      stage: s,
      prompt: [
        `Read the ticket of this stage with the Read tool: ${path}.`,
        "Make the change that the ticket asks for in the code base, with the Write and Edit tools. You can run the code with node to try it.",
      ].join("\n"),
      files: [{ path, content: ticketText(rng, spec, number, st) }],
      feeds: [],
      compactAfter: RULES_COMPACT_AFTER.includes(s),
    };
  });
  const workspaceFiles = Object.keys(spec.files).sort().map((path) => ({ path, content: spec.files[path] }));
  const top = [...new Set(workspaceFiles.map((f) => f.path.split("/")[0]))].sort();
  const collect = [...top, ...NOTE_PATHS.filter((p) => !top.includes(p))];
  const bytes = stages.reduce((a, s) => a + s.files.reduce((b, f) => b + Buffer.byteLength(f.content), 0), 0);
  const task = {
    schema: 1,
    taskId: spec.taskId,
    category: "L",
    shape: "rules",
    seed: spec.seed,
    profile: "compaction",
    params: { rules: spec.rules.length, functionCases: spec.cases.length, approxBytes: bytes, sizeGroup: "v12-rules" },
    intro: introOf(spec),
    stages,
    checkpoint: null,
    final: { questions: [], prompt: FINAL_PROMPT },
    workspace: { files: workspaceFiles, collect },
  };
  const tests = {
    schema: 1,
    taskId: spec.taskId,
    shape: "rules",
    workspace: { files: Object.fromEntries(workspaceFiles.map((f) => [f.path, textHash(f.content)])) },
    rules: spec.rules.map(ruleTest),
    cases: spec.cases.map((c) => ({ id: c.id, stage: c.stage, module: c.module, exportName: c.exportName, args: c.args, expect: c.expect })),
  };
  const key = {
    schema: 1,
    taskId: spec.taskId,
    seed: spec.seed,
    rules: spec.rules.map((r) => ({ id: r.id, kind: r.kind, text: r.text, trapStage: r.trapStage })),
    stages: spec.stages.map((st, i) => ({ stage: i + 1, title: st.title, trap: spec.rules.find((r) => r.trapStage === i + 1)?.id ?? null, compactAfter: RULES_COMPACT_AFTER.includes(i + 1) })),
  };
  const { start, ref } = validateRules(spec, task, tests);
  const { solution, violations } = solutionsOf(spec);
  const changed = (files) => Object.fromEntries(Object.entries(files).filter(([p, t]) => spec.files[p] !== t));
  const deleted = (files) => Object.keys(spec.files).filter((p) => !(p in files));
  const reference = {
    schema: 1,
    taskId: spec.taskId,
    note: "Patches over the original workspace files: `files` holds new or changed files, `deleted` the removed paths.",
    solution: { files: changed(solution), deleted: deleted(solution) },
    violations: Object.fromEntries(Object.entries(violations).map(([id, files]) => [id, { files: changed(files), deleted: deleted(files) }])),
    checks: { originalFunctionScore: start.function.score, referenceFunctionScore: ref.function.score },
  };
  return {
    files: {
      [`generated/${spec.taskId}.task.json`]: serialize(task),
      [`keys/${spec.taskId}.key.json`]: serialize(key),
      [`keys/${spec.taskId}.tests.json`]: serialize(tests),
      [`reference/${spec.taskId}.solution.json`]: serialize(reference),
    },
  };
}

export function generateRulesSet() {
  const files = {};
  for (const spec of V12_RULES_SPECS) Object.assign(files, generateOneRules(spec).files);
  return { files };
}

/** The original files and a reference patch ({ files, deleted }) as one { path: text } map. */
export function filesOfPatch(task, patch) {
  const out = Object.fromEntries(task.workspace.files.map((f) => [f.path, f.content]));
  for (const p of patch.deleted ?? []) delete out[p];
  return { ...out, ...patch.files };
}

export function frozenRecordRules(commit, files) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: "v12-standalone-rules",
    set: "v12-rules",
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v12rules.mjs",
    specs: "benchmarks/context-clock/tasks/generator/v12rules-specs.mjs",
    grader: "benchmarks/context-clock/graders/work-tests.mjs",
    ruleChecks: "benchmarks/context-clock/graders/rules-check.mjs",
    tasks: V12_RULES_SPECS.map((s) => ({
      taskId: s.taskId,
      category: "L",
      shape: "rules",
      seed: s.seed,
      stages: RULES_STAGES,
      compactAfter: RULES_COMPACT_AFTER,
      rules: s.rules.map((r) => ({ id: r.id, kind: r.kind, trapStage: r.trapStage })),
      functionCases: s.cases.length,
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      tests: entry(`keys/${s.taskId}.tests.json`),
      solution: entry(`reference/${s.taskId}.solution.json`),
    })),
  };
}

function main(argv) {
  const { files } = generateRulesSet();
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(RULES_DIR, rel);
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        diff += 1;
        process.stderr.write(`differs: ${rel}\n`);
      }
    }
    process.stdout.write(diff === 0 ? `ok: ${Object.keys(files).length} files match\n` : `${diff} files differ\n`);
    process.exitCode = diff === 0 ? 0 : 1;
    return;
  }
  if (argv.includes("--freeze")) {
    for (const [rel, content] of Object.entries(files)) if (readFileSync(join(RULES_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v12rules.mjs first`);
    const gen = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ".", "../../graders/work-tests.mjs", "../../graders/rules-check.mjs"], { cwd: gen, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator or the grader has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gen, encoding: "utf8" }).trim();
    writeFileSync(join(RULES_DIR, "FROZEN.json"), serialize(frozenRecordRules(commit, files)));
    process.stdout.write(`wrote v12-rules/FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(RULES_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${RULES_DIR}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
