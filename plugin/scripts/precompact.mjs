// PreCompact hook of the compaction-instruction plugin.
// Claude Code uses the stdout of a PreCompact hook as instructions for the compaction summary.
// This script prints the text of ../instruction.txt and nothing else.
// It reads no session content, writes no file and makes no network call.
// On any fault it prints nothing and exits 0, so it never blocks a compaction.
// Node built-ins only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** True when the environment turns the instruction off (COMPACTION_INSTRUCTION=off). */
export function isOff(env = process.env) {
  return OFF_VALUES.has(String(env.COMPACTION_INSTRUCTION ?? "").trim().toLowerCase());
}

/** The text to print. An empty string means: print nothing. Never throws. */
export function instructionText(env = process.env, file = defaultFile()) {
  if (isOff(env)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function defaultFile() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "instruction.txt");
}

function isMain() {
  try {
    return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const text = instructionText();
    if (text !== "") process.stdout.write(text);
  } catch {
    // Print nothing.
  }
  process.exitCode = 0;
}
