# compaction-instruction

A Claude Code plugin with one job. When Claude Code compacts a conversation, the plugin tells the summarizer to keep the full working state of the session.

Status: version 0.1.0, local and private. The measurements below are from an exploratory benchmark with small samples.

## What it does

Claude Code replaces a long conversation with a summary. This step is the compaction. The summary can lose decisions, exact values and the history of changes.

Claude Code runs `PreCompact` hooks before each compaction, and it uses their output as instructions for the summary. This plugin has one such hook. The hook prints the text of `instruction.txt`: 694 bytes that tell the summarizer what to keep.

The plugin does nothing else:

- It reads no part of your conversation.
- It writes no file and keeps no state.
- It makes no network call.
- If the script has a fault, it prints nothing and exits with code 0. A fault never blocks a compaction.

## Requirements

- Claude Code with plugin support.
- Node.js 18 or later on the `PATH`, because the hook is a Node.js script.

## Installation

Load the plugin folder for one session:

```sh
claude --plugin-dir /path/to/this/repository/plugin
```

To make sure that the hook is loaded, run `/hooks` in the session. The list shows one `PreCompact` entry of this plugin.

## Turn it off

Set the environment variable `COMPACTION_INSTRUCTION` to `off` before you start Claude Code. The hook then prints nothing.

```sh
COMPACTION_INSTRUCTION=off claude --plugin-dir /path/to/this/repository/plugin
```

The values `0`, `false` and `no` have the same effect.

## Change the text

Edit `instruction.txt`. The measured results apply only to the original text. The test `test/precompact.test.mjs` fails after a change, because it compares the hash of the text with the measured one.

## What was measured

The benchmark is in this repository, under `benchmarks/context-clock/`. Its report is `benchmarks/context-clock/REPORT-V12.md`.

Setup: Claude Code in isolated sessions, with this plugin as the only added plugin. The tasks are generated. After the last stage, the agent answers questions about the state of the task. The score is the share of correct answers. Each difference is the session with the plugin minus the plain session.

Haiku with manual compactions:

| Tasks | Plain | With the plugin | Difference | 95% interval | Pairs |
|---|---|---|---|---|---|
| 10 new tasks | 0.653 | 0.969 | +0.316 | [+0.227, +0.404] | 20 |
| 2 tasks of a shape that was designed without the text | 0.700 | 0.950 | +0.250 | not given, 7 wins and 1 tie | 8 |
| 3 older tasks | 0.681 | 0.933 | +0.252 | [+0.056, +0.400] | 6 |
| 3 tasks that need no state from before a compaction | 0.970 | 1.000 | +0.030 | [0.000, +0.063] | 12 |

The hook delivered the text at each manual compaction of these batches.

Other results:

- The same text in the `CLAUDE.md` file of the workspace, with no hook, scored 0.869 on the 10 new tasks. That is 0.099 below the plugin, with the interval [-0.214, -0.010]. Use the plugin and not a `CLAUDE.md` copy of the text.
- Opus 5.5 without the text scored 0.981 and 0.986 on two task sets with manual compactions. It scored 1.000 in 2 runs with automatic compactions.
- The benchmark therefore has no room to show a benefit for Opus 5.5. The measured benefit is for Haiku.
- One batch of 6 pairs used the plugin on Opus 5.5: 0.972 with the plugin against 0.986 without, a difference of one wrong answer. The sessions with the plugin used 5.03% more tokens.
- With automatic compactions, 8 pairs on one long task show no difference in the final score (0.889 in both sessions). The answers during the session were more often correct with the plugin.
- Three tasks that end in code with hidden tests gave a full score in each session, with and without the plugin. No benefit in written code is shown.

Cost:

- With manual compactions, the sessions with the plugin used between 3.9% fewer and 3.9% more tokens.
- With automatic compactions, they compacted more often (71 against 64) and used 11.9% more tokens.

## Limits of the evidence

- The measured benefit is for one model (Haiku), one version of Claude Code and one machine.
- The tasks are generated. They track decisions, values and work status. Other kinds of work are not measured.
- The comparisons have 6 to 20 pairs. The benchmark makes no significance claim beyond the intervals.
- The automatic compaction result comes from one task.
- A later version of Claude Code can change its summarizer, and then the result can change.

## Tests

```sh
node --test test
```
