// PreCompact hook of the plain arm I (EXPERIMENT-V11.md "Arms"). The benchmark plugin of arm I runs it; no Context Mode
// part is involved. With CCB_PRECOMPACT_FILE set, it prints the trimmed text of that file as plain stdout and logs one
// line to CCB_SHIM_LOG: { channel: "precompact", event: "PreCompact", trigger, delivered, bytes, sha256 }. It always
// exits 0, so a failure never blocks a compaction. Node built-ins only.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readStdin(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(""));
  });
}

/** The stdout text and the log record for one PreCompact call. Pure apart from reading `file`. */
export function plainPreCompact(file, input) {
  let trigger = null;
  try {
    const p = JSON.parse(input || "{}");
    if (typeof p.trigger === "string") trigger = p.trigger;
  } catch {
    trigger = null;
  }
  const rec = { channel: "precompact", event: "PreCompact", trigger, delivered: false, bytes: 0, sha256: null };
  if (!file) return { out: "", record: null };
  try {
    const text = readFileSync(file, "utf8").trim();
    if (text === "") return { out: "", record: { ...rec, error: "empty text file" } };
    return { out: text, record: { ...rec, delivered: true, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text, "utf8").digest("hex") } };
  } catch (e) {
    return { out: "", record: { ...rec, error: String(e?.message ?? e).slice(0, 200) } };
  }
}

export async function main({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const input = await readStdin(stdin);
  const { out, record } = plainPreCompact(env.CCB_PRECOMPACT_FILE, input);
  if (record && env.CCB_SHIM_LOG) {
    try {
      appendFileSync(env.CCB_SHIM_LOG, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n");
    } catch {
      // a log failure never breaks the hook
    }
  }
  if (out !== "") await new Promise((r) => stdout.write(out, r));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), () => process.exit(0));
}
