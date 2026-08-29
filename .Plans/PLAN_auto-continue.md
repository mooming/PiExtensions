# Plan: auto-continue extension

## 1. Goal (confirmed)
When the agent halts with **"Response was truncated before completion."**, the extension
sends, on behalf of the user, the prompt:

> `Continue if you hasn't completed your planned tasks yet.`

…so the agent picks up and completes the task. Truncation is **not** a user-input case.

## 2. Detection (root-cause verified in source)
| Source signal | Meaning |
| --- | --- |
| `assistantMessage.stopReason === "length"` | Model hit its output limit → UI renders `"Response was truncated before completion."` |
| `isRecoverableLength` | SDK auto-retry (compact + `agent.continue()`) fires **once** only for recoverable length stops |
| `maxTokens` clamp / model's desired limit | Length stop is **not** recoverable → SDK leaves it → agent halts with the truncation string |

The extension targets the case the SDK cannot recover from: a final assistant message
with `stopReason === "length"` after all SDK recovery has finished.

## 3. Hook
`agent_settled` — fires after the run fully settles and **no** automatic retry/compaction/
queued continuation will run. This avoids double-continuation with the SDK's own overflow
recovery and gives a clean, single decision point.

## 4. Mechanism
- On `agent_settled`, read the branch via `ctx.sessionManager.getBranch()`.
- Find the most recent **assistant** message; if its `stopReason === "length"`, it was truncated.
- Under the cap: `pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" })` triggers a new
  turn that runs to completion (re-entrant `agent_settled` continues the chain).
- The prompt wording ("…if you haven't…") makes it safe even when the previous turn actually
  completed: the model recognises completion and adds nothing.

## 5. Safety cap
`maxAutoContinuations` default **256** (configurable via `~/.pi/agent/auto-continue.json`).
The re-entrant turn re-fires `agent_settled`, so a cap prevents an unbounded loop when a
model perpetually truncates. When the cap is reached, a warning notify is shown.

## 6. Files
| File | Purpose |
| --- | --- |
| `.pi/extensions/auto-continue/index.ts` | Extension implementation |
| `.pi/extensions/auto-continue/README.md` | Docs |
| root `README.md` + `JOURNAL.md` | Announce new extension |

## 7. Verification
1. Type-check against installed `@earendil-works/pi-coding-agent` `.d.ts` (narrowing
   `SessionEntry` → `SessionMessageEntry` → `AssistantMessage.stopReason`).
2. Structured review (Architect + Validator + Joker).
