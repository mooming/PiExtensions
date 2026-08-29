# Auto-Continue Extension

When the coding agent halts with **`Response was truncated before completion.`**, this
extension automatically resumes the work — so you rarely have to type "continue" by hand.

## What it does

The message above appears when the assistant's `stopReason` is `"length"` — the model hit
its output limit instead of finishing its turn. This is most common when a provider's
`maxTokens` cap is reached. Pi's built-in overflow recovery only retries *recoverable*
length stops, so this extension picks up the rest.

On that halt, the extension submits, on behalf of you (the user):

```
Continue if you hasn't completed your planned tasks yet.
```

and lets the agent finish. Because the wording is conditional ("…if you haven't…"), it is
safe even if the previous turn actually completed — the model simply recognises completion
and adds nothing.

## When it runs

- After an agent run **fully settles** (`agent_settled`), i.e. after any automatic retry or
  compaction has already run. This avoids double-continuation with Pi's own recovery.
- Only when the most recent assistant message in the session has `stopReason === "length"`.
- Normal completions (`"stop"`), aborts (`"aborted"`), and errors (`"error"`) are left alone.

## Safety limit

To prevent an unbounded loop (a model that always truncates), the extension stops after a
configurable number of automatic continuations and warns you:

```
Auto-continue reached the limit (256); the task may be incomplete.
```

## Configuration

Optional file: `~/.pi/agent/auto-continue.json`

```json
{
  "maxAutoContinuations": 256
}
```

- `maxAutoContinuations` — integer `> 0`. Default `256`.
- If the file is missing or malformed, the default is used.

## Installation

Copy the `auto-continue` folder into one of:

- `.pi/extensions/` — local to this repository (development)
- `~/.pi/agent/extensions/` — global, for every project

Then restart `pi`. The extension activates automatically — no command to run.
