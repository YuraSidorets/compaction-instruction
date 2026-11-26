// A fake `claude -p --input-format stream-json --output-format stream-json` process for the runner tests.
// It reads one user message per stdin line and writes stream lines in the Claude format:
// - startup: a SessionStart:startup hook_response line, before the first message (only once).
// - "/compact": SessionStart:compact hook lines with a [context-clock] block, a compact_boundary line, an empty result.
// - a text that contains "HANG": no reply (the runner must time out and kill the process).
// - a text that contains "DIE": exit with code 7 before a result line.
// - any other text: init, one assistant tool call, a tool result, an assistant reply and a result line.
// It exits when stdin ends.
import { createInterface } from "node:readline";

const SID = "fake-session-1";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let turn = 0;

out({ type: "system", subtype: "hook_started", hook_id: "h0", hook_name: "SessionStart:startup", hook_event: "SessionStart", session_id: SID });
out({ type: "system", subtype: "hook_response", hook_id: "h0", hook_name: "SessionStart:startup", hook_event: "SessionStart", output: "", stdout: "", session_id: SID });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = JSON.parse(line).message.content[0].text;
  turn += 1;
  if (text.includes("HANG")) return;
  if (text.includes("DIE")) process.exit(7);
  if (text === "/compact") {
    const ctx = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[context-clock] tick=0 seq=4 state_rev=0\nsession=fake" } });
    out({ type: "system", subtype: "hook_progress", hook_id: `c${turn}`, hook_name: "SessionStart:compact", hook_event: "SessionStart", stdout: ctx, session_id: SID });
    out({ type: "system", subtype: "hook_response", hook_id: `c${turn}`, hook_name: "SessionStart:compact", hook_event: "SessionStart", output: ctx, stdout: ctx, session_id: SID });
    out({ type: "system", subtype: "compact_boundary", session_id: SID, compact_metadata: { trigger: "manual" } });
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: SID, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    return;
  }
  out({ type: "system", subtype: "init", session_id: SID, model: "fake-model" });
  out({ type: "assistant", message: { id: `m${turn}a`, content: [{ type: "tool_use", id: `t${turn}`, name: "mcp__plugin_context-mode_context-mode__ctx_search", input: { queries: ["x"] } }], usage: { input_tokens: 1, output_tokens: 1 } }, session_id: SID });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: [{ type: "text", text: `hits\n[context-clock] tick=${turn} seq=${turn}` }] }] }, session_id: SID });
  out({ type: "assistant", message: { id: `m${turn}b`, content: [{ type: "text", text: `reply ${turn}: ${text.slice(0, 20)}` }], usage: { input_tokens: 2, output_tokens: 3 } }, session_id: SID });
  out({ type: "result", subtype: "success", is_error: false, result: `reply ${turn}`, session_id: SID, usage: { input_tokens: 10 * turn, output_tokens: turn, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } });
});
rl.on("close", () => process.exit(0));
