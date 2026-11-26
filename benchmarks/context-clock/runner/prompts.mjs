// Fixed wrapper text of the benchmark (CONTRACT.md "Fixed prompts"). The same text goes to every mode.
// Neutral wording: no prompt names the clock, a memory tool, Context Mode or any tool beyond Read, Bash and feed.mjs.

export const PROMPT_VERSION = 1;

export function introPrompt(task) {
  return [
    "You will work on one task in several stages. Each stage is one message from me.",
    "A stage gives you new material in the current folder: files that you read with the Read tool, and named outputs that you print with the command `node feed.mjs <name>` through the Bash tool.",
    "The material of a stage is removed from the folder when the stage ends. You cannot read it again later.",
    "Later material can change or replace earlier information.",
    "After the last stage you get questions about the task.",
    "",
    "Task specification:",
    task.intro,
    "",
    "Reply with one short line to confirm that you are ready. Do not call any tool for this message.",
  ].join("\n");
}

/** The material list of a stage, as the wrapper names it. */
export function materialLines(stage) {
  const lines = [];
  for (const f of stage.files ?? []) lines.push(`- file: ${f.path}`);
  for (const f of stage.feeds ?? []) lines.push(`- output: node feed.mjs ${f.name}`);
  return lines;
}

export function stagePrompt(task, stage) {
  const total = task.stages.length;
  const material = materialLines(stage);
  return [
    `Stage ${stage.stage} of ${total}.`,
    "",
    stage.prompt,
    "",
    "Material of this stage (removed when this stage ends):",
    ...(material.length > 0 ? material : ["- none"]),
    "",
    "Process all of the material. Then reply with a short summary of at most five lines.",
  ].join("\n");
}

function questionLine(q) {
  const opts = Array.isArray(q.options) && q.options.length > 0 ? ` Options: ${q.options.join(" | ")}` : "";
  return `- ${q.id} [${q.type}] ${q.text}${opts}`;
}

function exampleValue(q) {
  if (q.type === "set") return [q.options?.[0] ?? "a"];
  if (q.type === "int") return 0;
  if (q.type === "bool") return true;
  return q.options?.[0] ?? "a";
}

/** The answer format block: one fenced json block with every question id. */
export function answerFormat(questions) {
  const example = { answers: Object.fromEntries(questions.map((q) => [q.id, exampleValue(q)])) };
  return [
    "Reply with exactly one fenced json block in this form (the values are only an example):",
    "```json",
    JSON.stringify(example),
    "```",
    "Answer types: choice = one option string, set = a list of option strings, int = a whole number, bool = true or false.",
    "Give an answer for every question id. Use only the given options for choice and set questions.",
  ].join("\n");
}

export function checkpointPrompt(task) {
  const qs = task.checkpoint?.questions ?? [];
  return [
    "Before you continue, answer these questions about the task so far. Do not call any tool for this message.",
    "",
    ...qs.map(questionLine),
    "",
    answerFormat(qs),
  ].join("\n");
}

export function finalPrompt(task) {
  const qs = task.final.questions;
  return [
    "All stages are complete. Answer these questions about the final state of the task.",
    "Do not call any tool for this message. Answer from what you know now.",
    "",
    ...qs.map(questionLine),
    "",
    answerFormat(qs),
  ].join("\n");
}
