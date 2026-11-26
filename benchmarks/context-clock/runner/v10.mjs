// Runner side of v0.10 (EXPERIMENT-V10.md "The text of arm V").
// - Mode V: mode R with configs/precompact-variant-instruction.txt as the PreCompact output. The overlay reads the text
//   from the file that CCB_PRECOMPACT_FILE names, so the overlay does not change.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIGS_DIR, TRIGGER_ENV } from "./workspace.mjs";

export const V10_TRIGGER_MODES = Object.freeze(["V"]);
export const PRECOMPACT_VARIANT_INSTRUCTION_FILE = join(CONFIGS_DIR, TRIGGER_ENV.V.CCB_PRECOMPACT_FILE);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** batch.json: { file, sha256 } of the PreCompact text of mode V (sha256 of the trimmed text), else null. */
export function v10Records(modes) {
  return {
    precompactVariantInstruction: modes.includes("V")
      ? { file: `configs/${TRIGGER_ENV.V.CCB_PRECOMPACT_FILE}`, sha256: sha256(readFileSync(PRECOMPACT_VARIANT_INSTRUCTION_FILE, "utf8").trim()) }
      : null,
  };
}
