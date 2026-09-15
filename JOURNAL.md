# JOURNAL

## 2026-07-11 — SYSTEM.md 전체 워크플로우 리팩토링

### 변경 전
- 기존 프로토콜 11개 항목 + 별도 Review Process
- 오타 수정 3건, 번호 중복 수정 완료

### 변경 후 구조
```
Fundamental Thinking
  ├─ 과학적 사고, 알고리즘 비용 평가
  ├─ 추가 전 필수 필요성 검토
  └─ 코드 간결성 강제

Execution Protocol
  Phase 1: Goal Definition       (Step 1~2) — 요청 분석 + 목표 보완
  Phase 2: Planning              (Step 3~5) — PLAND.md 작성 + 검증 기획 + 승인 (+ UI HTML 프로토타입)
  Phase 3: Execution & Verification (Step 6~9) — 실행 → 검증 → 분석 → 수정 (루프 10회/15분)
  Phase 4: Reporting             (Step 10~11) — 보고 + 다음 단계
  Critical: 코드 간결성 + 전처리기 기반 조건부 로깅

Review Process
  ├─ Code 변경 시: 4-agent 리뷰 (Goal Inspector, Architect, Validator, Joker) → 만장일치 필요
  └─ Code 변경 없을 시: light self-review (체크리스트 기반)

File Management
  ├─ PLAND.md:  계획 (Step 3 작성, 변경 시만 수정)
  ├─ JOURNAL.md: 의사결정 로그 (매 단계 업데이트, *why* 기록)
  └─ Git: 코드 변경 시 필수 (의미 단위 커밋)
```

### 주요 개선점
1. PLAND.md/JOURNAL.md 역할 분리 (계획 vs 의사결정 로그)
2. 코드 작업 여부に関係없이 검증 필수 (테스트 또는 체크리스트)
3. 코드 작업 여부に関게없이 리뷰 필수 (4-agent 또는 self-review)
4. 반복 루프 10회/15분 (이전 3회)
5. 코드 추가 시 필요성 검토 단계 추가
6. 코드 간결성 유지 강제
7. 분석(Step 8)과 수정(Step 9) 단계 분리
8. **구조적 사고 강제** — 사고, 계획, 문서, 보고서, 프로그램 설계 모두 구조적으로. 구조 설계 자체도 불필요한 부분 없이 간결하게.
9. **리뷰 4인체제** — Goal Inspector(결과) + Architect(구조) + Validator(구현) + Joker(유저 관점 혁신). 조커는 상시 활성화.
10. **전처리기 기반 조건부 로깅** — 그래픽 프로그램 상세 로그 필수, #ifdef/#endif로 한번에 전환. 검증 후 로그 제거하지 않고 조건부로 전환.
11. **UI 디자인 HTML 프로토타입** — UI 포함 작업 시 코드 작성 전 브라우저 실행 가능한 HTML 프로토타입 작성 및 사용자 승인.

## 2026-08-30 — New extension: auto-continue

### Goal
When the agent halts with **"Response was truncated before completion."**, auto-submit the
user prompt `Continue if you hasn't completed your planned tasks yet.` on the user's behalf,
resuming the task until complete (truncation ≠ user input).

### Decision log
| Decision | Rationale |
| --- | --- |
| Signal: `assistantMessage.stopReason === "length"` | Source-verified: this is the exact condition that renders the truncation string (assistant-message.js). |
| Hook: `agent_settled` | Fires after SDK's own overflow/compact recovery finishes → no double-continuation; single clean decision point. |
| Mechanism: `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` | Runs a turn to completion; its own `agent_settled` continues the chain. Conditional prompt wording makes it safe when the turn already finished. |
| Cap `maxAutoContinuations` default **256** | Re-entrant `agent_settled` would otherwise loop forever on a perpetually-truncating model. Configurable via `~/.pi/agent/auto-continue.json`. |
| Detection: most recent assistant `stopReason` in branch | Skips user/tool/custom entries; handles assistant(length)+toolResult ordering correctly. |

### Verification
- Runtime logic tested (7/7 cases) against the real `SessionEntry`/`AgentMessage` shapes via
  Node native type-stripping (no compiler installed in this repo).
- Type bindings verified by inspection against installed `@earendil-works/pi-coding-agent` `.d.ts`:
  `SessionEntry` export, `SessionMessageEntry.type === "message"`, `AgentMessage.role` discriminant,
  `sendUserMessage`/`notify`/`agent_settled` signatures.

## 2026-09-15 — model-selector: last selected model was not kept across restarts

### Goal
`/select-model` must survive a Pi restart, as it did before Pi 0.84.3.

### Root cause (bisected, not inferred)
| Evidence | Result |
| --- | --- |
| `setModel` in npm **0.84.2** | `async setModel(model)` → `setDefaultModelAndProvider(...)` **unconditionally** → worked. |
| `setModel` in npm **0.84.3** | `async setModel(model, options = {})` → the write moved inside `if (options.persist)`. |
| Extension-facing action | **Identical in both**: `setModel: async (model) => { await this.setModel(model) }` — passes no `options`, so `persist` is always `undefined`. |
| `ExtensionAPI.setModel` | `(model: Model<any>) => Promise<boolean)` — no options parameter; `ExtensionAPI` has no settings surface at all. |
| Pi changelog 0.84.3 (2026-08-24) | "Fixed `/model` and `/thinking` selections being persisted globally unless explicitly saved with Ctrl+S" — the UI gained Ctrl+S; extensions silently lost persistence. |
| `settings.json` mtime | Sep 6 — unchanged through Sep 15 use; `defaultModel` frozen at a model the server no longer serves. |
| Live `/v1/models` | Serves only `example-org/Example-Model-NVFP4`, so the stale default made `findInitialModel` step 3 fail **silently** (`restoreModelFromSession` warns; `findInitialModel` does not) → fallback to `anthropic/claude-opus-4-8`. |

**None of the five commits under review caused this** — they were diagnostics churn plus `maxTokens`
derivation. The regression lives in the dependency, which is why `git log` on this repo could never
have shown it. The first diagnosis misattributed causality for exactly that reason; the user's
"it used to work" was the missing premise.

### Decision log
| Decision | Rationale |
| --- | --- |
| Write `defaultProvider`/`defaultModel` into `settings.json` rather than keep private state | Restores the *exact* pre-0.84.3 behaviour and lets Pi resolve the model itself, so the right model is active from the first frame — no extra `model_change` transcript entry, no visible switch. |
| Rejected: own state file + re-apply on `session_start` | Zero coupling to Pi's file and immune to a repeat of this class of change, but costs a visible model switch plus an extra session entry on every start. Kept as a documented fallback design. |
| Re-read immediately before writing; touch only those 2 keys | Pi locks the file with `proper-lockfile`, which is **not resolvable from an extension** (verified `MODULE_NOT_FOUND`). Read-modify-write scoped to two keys is the strongest available mitigation; a collision needs a simultaneous Ctrl+S in `/model`. |
| Never overwrite on parse failure / non-object / EACCES | A damaged config must produce a message, not data loss. Verified by test, including read-only (`0o444`). |
| Return failure reasons instead of `console.warn` | `main.js:502-504` deliberately skips `takeOverStdout()` in interactive mode, so console output draws over the TUI — the exact problem commit 5a33a9f fixed. `notify` is both user-facing and render-safe. Added **zero** new console calls. |
| Paths via `getAgentDir()` | Pi's resolver is a public export (`index.js:4`) and its loader aliases the package for extensions (`loader.js:48`), so the import works with no `node_modules`. Same file path on all three OSes and honours `PI_CODING_AGENT_DIR`, which the hardcoded `os.homedir()` path silently ignored. |
| `AbortSignal.timeout()` instead of `fetch(…, { timeout })` | Proved by experiment on Node v26 (the bundle is `#!/usr/bin/env node`) that `timeout` in `RequestInit` is ignored — a stalled endpoint never settled. Startup hung indefinitely, twice, because Pi awaits the extension factory. |

### Verification
15/15 assertions driving the **real** extension under a stubbed `ExtensionAPI` + a live
`/v1/models` server, via Node native type-stripping (no compiler in this repo; same approach as
`auto-continue`). Covered: settings.json absent → created; unrelated keys (`theme`, `packages`,
nested `terminal`) survive; stale default replaced; `setModel()` false → **no write** + error
notify; corrupt JSON / `[1,2]` / read-only → left byte-identical + reason reported; empty file →
recovered; provider list resolved from `getAgentDir()`; stalled endpoint bounded at **~10 s**
(2 × 5 s for primary + fallback) instead of hanging.

Additional checks run afterwards:
* Real `pi --mode rpc` + `get_state` against a sandboxed agent dir proved the persisted default is
  what drives startup resolution — and reproduced the original symptom as an A/B control: a stale
  `defaultModel` resolves to `anthropic/claude-opus-4-8`, the saved one to `my-vllm/…`.
* Real `pi` startup against the user's **live** `settings.json` resolved the saved model.
* **User-confirmed interactively**: `/select-model` now keeps the last selected model across
  restarts, which closes the one path the stubbed suite could not exercise.

### Known limitations / follow-ups
* Windows and Linux are **code-path reasoning, not executed tests**; only macOS + Node v26 verified.
  A three-OS CI matrix would be the only way to claim coverage.
* Not fixed (out of scope, deliberately): custom context length is still session-only; `8110a51`
  left `maxTokens === contextWindow` when the server reports no `max_model_len` (zero output
  headroom); `findInitialModel`'s silent fallback still hides provider-side model changes.
* Pre-existing TUI risk left as-is: `console.log`/`console.warn` at `index.ts:198,201` run at
  startup in interactive mode, same hazard described above.
