// Fake MCP server and fake hook for the shim tests. Each is written to a temp folder and run as a child process.
import { spawn } from "node:child_process";

/**
 * Fake MCP server. Newline-delimited JSON-RPC on stdin. Each reply is written in two chunks with a pause, so the shim
 * sees partial lines. Methods: tools/call (arguments.reply, optional arguments.feedback), raw (prints a non-JSON line),
 * leak (a non-tools/call reply with clock text), exit (exits at once with params.code). On stdin end it writes to
 * stderr and exits with FAKE_EXIT.
 */
export const FAKE_SERVER = String.raw`
let buf = "";
let chain = Promise.resolve();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (s) => new Promise((r) => process.stdout.write(s, r));
const send = (s) => { chain = chain.then(async () => { const h = Math.floor(s.length / 2); await write(s.slice(0, h)); await delay(3); await write(s.slice(h)); }); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(line); }
});
process.stdin.on("end", () => {
  chain = chain.then(() => { process.stderr.write("fake server: stdin closed\n"); process.exitCode = Number(process.env.FAKE_EXIT || 0); });
});
function handle(line) {
  const m = JSON.parse(line);
  process.stderr.write("fake server got " + m.method + "\n");
  if (m.method === "exit") { chain = chain.then(() => process.exit(m.params.code)); return; }
  if (m.method === "raw") { send("not json at all\n"); return; }
  if (m.method === "leak") { send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { note: m.params.text } }) + "\n"); return; }
  if (m.method === "tools/call") {
    const content = [{ type: "text", text: m.params.arguments.reply }];
    if (m.params.arguments.feedback) content.push({ type: "text", text: m.params.arguments.feedback });
    send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content } }) + "\n");
    return;
  }
  if (m.id !== undefined) send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\n");
}
`;

/** Fake hook: writes FAKE_HOOK_STDOUT verbatim to stdout, its argv and stdin size to stderr, exits with FAKE_HOOK_EXIT. */
export const FAKE_HOOK = String.raw`
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  process.stderr.write("fake hook argv=" + JSON.stringify(process.argv.slice(2)) + " stdin=" + input.length + " mark=" + (process.env.FAKE_MARK || "") + "\n");
  process.stdout.write(process.env.FAKE_HOOK_STDOUT || "", () => process.exit(Number(process.env.FAKE_HOOK_EXIT || 0)));
});
`;

/**
 * Runs node with args. Writes stdin in the given pieces with short pauses, then closes stdin unless keepOpen.
 * @returns {Promise<{ stdout: Buffer, stderr: string, code: number | null, ms: number }>}
 */
export function run(args, { env, pieces = [], keepOpen = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code, ms: Date.now() - t0 });
    });
    (async () => {
      for (const p of pieces) {
        child.stdin.write(p);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!keepOpen) child.stdin.end();
    })();
  });
}

/** Splits a string into pieces that cut lines in the middle. */
export function cutPieces(s, size = 37) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
