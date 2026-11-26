# Plugin overlay

The overlay is a copy of the installed context-mode plugin for one benchmark run. `build.mjs` makes the copy and changes it. In the copy, the MCP server and the hooks run through the shims in the `ccb/` folder. The installed plugin is only read. The product code does not change.

## Files

| File | Content |
|---|---|
| `build.mjs` | Copies the plugin and rewrites the manifest and the hook file. |
| `server-shim.mjs` | Runs the real MCP server. In mode D, it replaces the clock snapshot with the placebo. |
| `hook-shim.mjs` | Runs the real `hook.mjs`, then changes the reply for the arm of the run. |
| `placebo.mjs` | The placebo text of the same length as the snapshot (mode D). |
| `guard.mjs` | An extra `PreToolUse` hook. It denies agent tool calls outside the workspace. |
| `state-block.mjs` | The returned state block of v0.4 and v0.5 (`CCB_RETURN_STATE`). |
| `triggers.mjs` | The product triggers of v0.7 (arms N, T and P). |

## Hook entries in the copy

- Each context-mode hook command runs as `node ccb/hook-shim.mjs <real hook.mjs> <args>`.
- The guard runs as an extra `PreToolUse` entry. Its matcher adds `Glob`.
- The installed plugin has no `PreCompact` hook. The copy adds a `PreCompact` entry that runs the shim with no real hook. If the product has a `PreCompact` hook, the shim runs it, and the copy adds no second entry.
- The added `PreCompact` entry has no matcher, so it runs for a manual and for an automatic compaction. The shim sends the same text for both. The `precompact` log line records the `trigger` field of the hook input: `manual`, `auto`, or null.

## v0.7 triggers

The runner sets these variables. If none of them is set, every hook reply is byte-equal to the reply before v0.7. The `PreCompact` entry then prints nothing and exits 0, as with no hook.

| Variable | Arm | Effect |
|---|---|---|
| `CCB_STANDING_FILE` | N | The text of the file goes after the product text of every `SessionStart` reply, for each source. |
| `CCB_REMIND_FILE`, `CCB_REMIND_THRESHOLD` | T | After a `PostToolUse` call, the shim estimates the context size. At or above the threshold, the text of the file goes after the product text. |
| `CCB_PRECOMPACT_FILE` | P | The `PreCompact` hook prints the product output, then the text of the file. The host uses this output as the instructions for the compaction summary. |

Arm T uses `CCB_DATA_DIR` for a marker file, `ccb-reminder.json`. The reminder fires at most one time between two compactions. A `SessionStart` with source `compact` arms it again. The marker keeps the time of that compaction, so a usage record from before the compaction cannot fire the reminder.

The context estimate is the usage of the last assistant record in the transcript: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The shim skips sidechain records, synthetic records and lines that it cannot parse. It reads at most the last 4 MiB of the file, in windows of 256 KiB, 1 MiB and 4 MiB.

The shim itself reads the session transcript in arm T, at the `transcript_path` of the hook input. The agent still cannot read the transcript, because the guard rules did not change.

## v0.8 periodic reminder

The runner sets these variables for arm U.

| Variable | Value | Effect |
|---|---|---|
| `CCB_PERIODIC_FILE` | path of the reminder text | If it is set, the `UserPromptSubmit` path of the shim counts each prompt. |
| `CCB_PERIODIC_EVERY` | integer, at least 1, default 2 | The period. |
| `CCB_PERIODIC_OFFSET` | integer, at least 0, default 0 | The phase. |

The counter is the file `ccb-periodic.json` in `CCB_DATA_DIR`, one for each run. Each prompt that reaches the hook adds 1, also a slash command and a prompt that the product hook blocks. The rule for prompt n is `n > offset && (n - offset) % every == 0`. If the rule is true, prompt n gets the text after the product text. With the defaults, prompts 2, 4, 6 and 8 get the text.

Claude Code adds `UserPromptSubmit` output to the context in two forms: plain stdout and `hookSpecificOutput.additionalContext`. The shim keeps the form of the product reply. The installed plugin already has a `UserPromptSubmit` hook that runs through the shim, so the build adds no entry for arm U. For a plugin with no such hook, the build adds an entry that runs the shim with no product hook.

Claude Code caps additional context and `PreCompact` output at 10 000 characters for each hook. If a trigger text file has more than 10 000 characters, the shim refuses it, sends the product reply unchanged and logs `error`.

## Log lines

Each shim writes JSON lines to `CCB_SHIM_LOG`. A log line never holds the text of a reply or of a trigger file.

| Channel | Fields |
|---|---|
| `standing` | `t, channel, event, source, delivered, bytes` |
| `reminder` | `t, channel, event, fired, estimate, threshold`. A fired reminder also has `tool, bytes`. The shim writes this line for a fired reminder and for an estimate that it cannot read (`reason`). |
| `precompact` | `t, channel, event, trigger, delivered, bytes` |
| `periodic` | `t, channel, event, n, fired, bytes`, one line for each prompt. A prompt that starts with a slash command also has `command`, the name of the command only. |

If a trigger fails, the shim sends the product reply unchanged and the line holds `error`. If the product hook exits with a code that is not 0, the shim adds nothing and the line holds `hookExit`.
