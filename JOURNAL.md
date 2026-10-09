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

## 2026-09-16 — SYSTEM.md: added the "Plain Naming" rule

### Goal
The user reported that acronyms and invented code names cause critical misreading and slow
reading. The requested change was to *add a statement* to `.pi/SYSTEM.md` forbidding them — not
to rewrite the shorthand already present in that file.

### Decision log
| Decision | Rationale |
| --- | --- |
| One new row in the Core Principles table plus two guidance bullets | The file's existing design is "table = the law, bullets = how to apply it". Adding to both keeps the rule enforceable without inventing a new section or touching the four-phase protocol. |
| Rule wording covers "things, roles, steps, or diagram nodes" | Those are the four places this repository actually generated unreadable shorthand: a review role named after a card-game character, single-letter flowchart identifiers, lettered steps. Naming the places beats naming the abstract concept. |
| "Write it in full the first time, declare the short phrase, then use only that phrase" | A blanket ban on abbreviations is unusable for genuinely long names, so the rule needs a legal path rather than an absolute prohibition. |
| Exact identifiers kept verbatim as the single exception | File paths, commands, configuration keys, code symbols and log level names must be reproducible character-for-character. Spelling them out would leave the agent unable to act on the instruction — a worse failure than the one being fixed. |
| Rejected: rewriting the shorthand already in SYSTEM.md | The user's follow-up narrowed scope, and that file is the live project system prompt — every rename inside it silently changes agent behaviour. Left as an explicit follow-up below. |

### Verification
- Alignment checked by script over all 12 framed tables: every block's rows share one display
  width, except the pre-existing "Key Results" block (79 vs 81 columns, caused by the
  warning-sign emoji counting as two). The same defect exists at the previous commit, so it was
  not introduced here.
- `git diff`: 4 insertions, 0 deletions — no other line touched. Carriage-return bytes: 0 before
  and after (the editing tool matched an adjacent line fuzzily; confirmed it changed nothing).

### Amendment, same day — established short forms are legal
The user rejected the blanket reading: `UI`, `GUI`, `HTML` are not invented shorthand but the names
practitioners actually use worldwide, so they must stay.

| Change | Reason |
| --- | --- |
| Table row reworded to "No **invented** acronyms or code names" | The unqualified ban would have forbidden the exact terms the user considers ordinary vocabulary. "Invented" is the operative word, and the 58-column limit forced the loss of "out" from "write terms out in full" — meaning is unchanged. |
| Exception bullet rewritten to state two exceptions, naming `UI`, `GUI`, `HTML` as worked examples | "Widely known" is unfalsifiable for a model reading the rule; "does that field's own documentation and code use the short form" is checkable against that field's literature. The longer expansion existing somewhere is explicitly ruled out as a reason to expand. |
| Left the first guidance bullet untouched | It already read "Never invent shorthand", so it was consistent with the narrowed rule before this amendment — editing it again would be churn. |

### Follow-up decision — the review role named Joker stays
The user rejected renaming the fourth review role: the card-game name is intuitive, so it stays.

| Item | Decision and reason |
| --- | --- |
| `Joker` | Unchanged. The ban is scoped to *private* code names — names that only make sense to whoever coined them. `Joker` carries a publicly readable connotation (the seat that argues the user's side and pushes for the unexpected improvement), so no memorised mapping is needed and the rule is not violated. Renaming a review role would also move the review's behaviour, a second reason not to touch it. |
| My earlier report flagging `Joker` as a violation | Retracted as a false positive. I tested the name against "is it a literal description of the job" instead of against the rule's actual test, which is "does the reader need a mapping held in memory". That misapplied test is the reason this row exists — without it, the next pass would flag the same name again. |
| Criterion for this file's own vocabulary | A name's etymology is irrelevant to the rule; only whether it self-explains to the reader matters. So `Joker`, `Goal Inspector`, `Architect`, `Validator` all stand, while the flowchart node letters `A` through `F` remain genuine violations — pure symbols whose meaning exists only in the diagram that defines them. |

### Verification of the flowchart identifier rename
Checked that the rename changes names and nothing else, by resolving each arrow endpoint through
the declaration map first (the way the diagram language itself resolves them) and comparing the
resulting arrow sets: 6 arrows before, 6 after, both endpoint texts and both branch labels
identical, box set identical, single-character identifiers reduced from six to zero.

## 2026-09-16 — SYSTEM.html: bilingual readable version of the system prompt

### Goal
`.pi/SYSTEM.md` is read by the agent as plain text; a human opening it sees box-drawing tables and
a diagram that never renders. The user asked for an HTML version in the project root with an
English / Korean switch, and the diagrams drawn as SVG.

### Decision log
| Decision | Reason |
| --- | --- |
| Both languages carried in the document as sibling pairs, switched by one `data-lang` attribute on the root element | No rendering step and no content duplication in a second file: one document, one truth, and the switch is a single attribute write. Every English element has an adjacent Korean twin, which a checker enforces. |
| Initial language taken from stored choice, else from the browser language | The reader should not have to pick every time; the choice persists across visits. |
| Diagrams hand-drawn as inline SVG instead of loading a diagram library from the network | The file must open with no network and no build step. A library would also redraw the diagram from the same text the reader is already reading, adding nothing. |
| Flowchart identifiers named with words (`ExecutePlan`, `Verify` …) inside the SVG markup | Follows the naming rule added earlier the same day: the markup a reader inspects should not need a symbol table. |
| English side reworded where the source has a slip ("ask to users", contractions, slashed pairs like "tests/checklists") | The page is the readable rendering of the prompt, not a byte-for-byte transcription. Every deviation is listed to the user rather than left silent. |
| Kept the source's short criteria column *and* its detailed criteria list for the reviewers | A first pass collapsed both into one column and dropped phrases such as "improvements, pain points"; the completeness checker caught it, so the table now mirrors the source structure. |

### Verification
No browser is installed in this environment, so nothing was verified by eye. Checks that did run:
* Markup balance parsed with a real hyper text markup parser: no unclosed or crossed tags (one was found and fixed — the report-format section).
* Language pairing: 160 English elements, 160 Korean elements, 160 adjacent pairs.
* Self-containment: no network address, no script or style source, no import anywhere in the file.
* Diagram geometry: every label's width estimated per character class (Korean syllables at one em,
  Latin at about half) with font size inherited through groups, then checked against its own box,
  against the canvas, and against every other label. Two overflows found and shortened; no overlap
  remains in either language.
* Style sheet: balanced braces, no malformed declaration, and every class used in markup is styled.
* Content coverage against `.pi/SYSTEM.md`: all 124 content lines, with diagram syntax excluded,
  reduce to deliberate rewordings only — no dropped content.
* Toggle script: syntax-checked with Node; both button identifiers it queries exist.

### Known limitations
* Layout is verified by measurement, not by a rendered screenshot. Font metrics differ per machine,
  so a reader on an unusual font set could see a tight label.
* The page is a snapshot: it does not regenerate itself when `.pi/SYSTEM.md` changes.
* The source file's logging example has an unclosed code fence, which the source still has; the page
  shows the snippet correctly regardless.

### Amendment — the page now opens in English
The user asked for English to be the default. Replaced the browser-language guess with a fixed
English start; a language the reader clicks is still remembered for the next visit.

| Point | Detail |
| --- | --- |
| What changed | The initial language is English unless the reader previously clicked a button. The earlier browser-language heuristic is gone, so a Korean browser no longer opens the page in Korean. |
| Deliberate remaining exception | An explicit click is honoured on later visits. If the reader clicked Korean once, the page still opens in Korean by design — this is a remembered choice, not a default. |
| Verification | Behaviour tested in Node against a stubbed browser: five cases — Korean browser / English browser / no browser language reported / Korean remembered / nonsense stored. All open in the expected language, exactly one toggle button is lit, and clicking Korean switches and stores. The markup already declares English, so nothing flashes in Korean before the script runs. |
| Harness note | Two of the first five reported failures were the test's own bugs: it read the language and button state *after* its synthetic click, so the click had already overwritten them. Snapshots at open time fixed the readings; the page never regressed. |

## 2026-09-16 — four-role review of the change set, before pushing
Ran the review panel the project's own protocol requires. Goal Inspector, Architect and Validator
each ran as an independent agent against the diff; the Joker seat could not run as an agent (first a
context-length failure, then an authentication failure on the substitute model), so that seat was
filled by the author — its findings carry less independence and are labelled as such.

### Defects found and fixed
| Lens | Finding | Fix |
| --- | --- | --- |
| Validator | Style sheet targeted `nav.toc` while the markup is `<nav><ul class="toc">`, so the contents row never received its rules and would have printed as a bulleted vertical list | Selectors retargeted to `ul.toc` and `.toc a`, including the print rule |
| Architect, Validator | Heading "Detailed criteria for the four reviewers" emitted after the bullets it names, leaving an empty section | Heading moved above its list |
| Validator | Each phase card's border was drawn inside its own clipping region, so the outer half of the stroke and the corner joins were cut | Border drawn last, outside the clip; the clip now only shapes the coloured header band |
| Validator | Diagram accessible names were hard-coded English `aria-label`, so a Korean reader with assistive technology heard English | Both diagrams now named through their bilingual captions via `aria-labelledby`; the verification diagram gained a caption |
| Validator, Architect | Style sheet carried `.note`, `.rule`, and three colour variables nothing used | Removed; the status cells now carry a real tint, so status is not colour-only-on-emoji |
| Architect | The ten-loops-or-fifteen-minutes limit, stated once in the source, appeared four times in the page | Reduced to two: the phase card that shows the loop, and the source-faithful table caption |
| Validator | "When code was changed" narrowed the source's "When Changes Were Made" | Widened to "When something was changed" |
| Validator | Legend label overran its box by about three pixels | Legend row wording shortened, box widened by six |
| Goal Inspector | The file-management table rows for the prompt pair, and promoting "Speak like a deep thinker…" to a bullet, were additions nobody asked for — the user had narrowed request one to "add a statement" | Both reverted in the plain text and in the page, so the pair stayed in step while scope stayed where the user put it |
| Goal Inspector | `AGENTS.md` stated the fidelity clause twice | One clause remains |
| Author's own check | The fix that demoted the bullet left a duplicate list close | Removed; markup walk clean |

### Findings accepted rather than fixed
| Lens | Finding | Why left |
| --- | --- | --- |
| Architect | The naming rule occupies roughly fifteen percent of the prompt's words while the other five principle rows carry no bullets at all | True imbalance. Shortening means dropping either the verbatim-identifier exception or the legality test for short forms, both of which the user asked for in this session. Left long on purpose; offered as a separate decision |
| Architect | The class token `i18n` on 320 elements carries no style rule | It marks a paired element for the reader and for the pairing checker, which switches on `en` and `ko` |
| Architect, Validator | Diagram key, captions and section navigation have no counterpart in the plain text | The synchronization rule now says explicitly that reader affordances the plain text cannot hold live in the page alone |
| Joker (author-filled) | Nothing detects drift: a future edit to the plain text that forgets the page is invisible | Needs a checker script, which is a new artifact. Proposed to the user rather than added unasked |

### Process deviations disclosed
* No `.Plans/PLAN_*.md` was written for either task, although the protocol's step three calls for one.
  `JOURNAL.md` carries the decisions and reasons; the plan files were skipped.
* Diagram layout is verified by measurement, not by a rendered screenshot: no browser is installed
  here. Font metrics vary by machine, so a label could sit tighter than measured.

## 2026-09-24 — model-selector: thinking 능력 하드코딩 제거, 서버에서 실측

### Goal
The user asked whether the extension sets `thinking` appropriately per model. It did not:
`fetchProviderModels` returned `reasoning: false` for every model, so Pi offered only `off`
(`getSupportedThinkingLevels` short-circuits on `!model.reasoning`, `pi-ai/dist/models.js:551`) while
the server was thinking anyway. The user then asked for the answer to be obtained through
`/select-model`, and chose measurement-plus-fallback over presets or manual entry.

### Measurements that decided the design
All taken against the user's live servers during this session, not from documentation.

| Measurement | Result | Consequence |
| --- | --- | --- |
| `GET /v1/models` field list — vLLM | `id, object, created, owned_by, root, parent, max_model_len, permission` | No reasoning information. Capability cannot be read. |
| `GET /v1/models` field list — Ollama | `id, object, created, owned_by` | Same, and not even `max_model_len`. |
| vLLM accepted `reasoning_effort` | `none`, `low`, `medium`, `xhigh`; **HTTP 400** for `minimal`, `high`, `max` — `Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.` | `reasoning: true` alone would fail *every* request: `settings.json` has `defaultThinkingLevel: high`, which is one of the rejected spellings. |
| Ollama accepted `reasoning_effort` | all seven, no 400 | Vocabulary is per-server, so it cannot be a constant. |
| No control field sent | 123–3559 characters of reasoning returned | `reasoning: false` does not switch thinking off; it just stops Pi from asking. |
| `reasoning_effort: "none"` | 0 characters of reasoning | A real off exists on this server, so off is worth claiming. |
| Top-level `enable_thinking: false` | ignored, thinking continued | Pi's `compat.thinkingFormat: "qwen"` would not work here — which is why the fix is the level map, not a compat setting. |
| `chat_template_kwargs.enable_thinking: false` | honoured, thinking suppressed | Noted for completeness; Pi's `qwen-chat-template` format would also send `preserve_thinking: true`. |
| `low` 2799 / `medium` 1682 / `xhigh` 3618 characters, identical prompt | levels do not order monotonically | Effort names are nominal on this server. No calibration applied — out of scope and unfixable from the client. |
| Ollama `POST /api/show` | `capabilities: ["completion","vision","tools","thinking"]` | Thinking *and* vision are discoverable for Ollama. Deliberately out of scope; recorded as a proposal. |
| `GET /server_info` on vLLM | 404 (`/version` answers) | No introspection endpoint to fall back on. |

### Decision log
| Decision | Reason |
| --- | --- |
| Measure by request, instead of inferring from the model id or keeping `false` | A name-based guess is unverifiable, and the hardcoded `false` was measured to be wrong in both directions. |
| Ask inside `/select-model`, with **Measure against the server** as the first option | The user's explicit choice. Also keeps capability where the model is already being chosen. |
| `thinkingLevelMap` is always stored and written together with `reasoning` | The 400 measurement: the flag without the map breaks every request, so the pair is the smallest unit that cannot fail. |
| Unknown level rounds **up** to the nearest accepted value | Pi's own `clampThinkingLevel` searches upward first (`models.js:563-578`). Rounding down would also silently do less than the user selected. |
| `off` set to `null` unless the server has a value that truly disables thinking | Registering an `off` that stops nothing is the exact defect this change replaces; Pi then drops the level from the list, which is the truth. |
| An unreadable server yields a fallback question, never a guess | A coarse vocabulary harms nothing; a wrong one fails every request. Asymmetric cost. |
| Stored in `model-capabilities.json`, beside `vision` | Consistent with the 2026-09-17 decision. `models.json` is Pi-validated, and one wrong key there costs every provider. |
| `saveCapability` merges, and its read-back guard checks the keys actually written | Two prompts now write one entry. The old guard compared `vision` only, so a write that dropped the thinking map — or the vision answer — was reported as saved. |
| Probe lives in `thinking-probe.ts`, importing nothing from Pi | So it can be run directly (`node --experimental-strip-types`) against live servers. Importing `index.ts` pulls the Pi package in, which is the thing the test should not need. |

### Verification
| Check | Method | Result |
| --- | --- | --- |
| V1 live probe, both servers | `node --experimental-strip-types` on the real probe module | vLLM produced `{off:none, minimal:low, low:low, medium:medium, high:xhigh, xhigh:xhigh, max:xhigh}` — identical to the map built by hand from raw measurements earlier in the session. Ollama produced the identity map. 4.8 s and 26.3 s. |
| V2 classification rules | 13 cases on synthetic responses (partial vocabulary, missing off value, all rejected, dead baseline, transport throw, URL shapes) | All pass |
| V3 loads the way Pi loads | `createJiti` with Pi's own alias set and `moduleCache: false` (`loader.js:416-427`) | `index.ts` and its `./thinking-probe.ts` import resolve; `/select-model` registers |
| V4 whole command path | Scripted `ExtensionAPI` + a throwaway `PI_CODING_AGENT_DIR`, three runs: measure / keep / text-only | Capability file and Pi registration carry flag + map; `settings.json` gains only `defaultProvider`/`defaultModel`, other keys intact; `[thinking]` tag appears after measuring; "Keep current answer" re-probes nothing |
| V5 no mapped value is rejected | The probe's own accepted list is the map's source | 400 appears only for values excluded from the map |
| Type check | `tsc 5.9 --strict` against Pi's shipped `.d.ts` | 0 errors; `HEAD` had 6 (below) |

### Defects found by the type check and fixed in passing
| Defect at HEAD | Fix | Effect today |
| --- | --- | --- |
| `ctx.ui.input(title, { placeholder: "…" })` at four call sites — the second parameter is a string (`types.d.ts:74`) | Pass the string | None visible: Pi's `ExtensionInputComponent` names the parameter `_placeholder` and discards it. Latent, and it becomes real the moment Pi honours it. |
| `err.message` in a `catch` under strict mode | `(err as Error).message` | Type-only |
| `modelsData.map(m => …)` implicit any | `(m: any)` | Type-only |

### Known limitations
* Measurement reads **vocabulary**, not calibration. It cannot say whether this server's `medium`
  thinks more than its `low`, and measured lengths do not order monotonically.
* A server that thinks by default and exposes no disabling value measures `reasoning: false`, and
  thinking there stays uncontrollable. The notification states it rather than hiding it.
* First selection of a model costs eight short requests — about 26 s against a cold local model.
* `[vision]` and `[thinking]` tags are read from Pi's registry, so a model whose capability changed
  server-side shows the old tag until the provider is re-registered.
* Two servers were tested: remote vLLM (Qwen3.8) and local Ollama. llama.cpp and LM Studio paths are
  untested — they are the reason the fallback dialog exists rather than a silent default.
* No real Pi session was launched: the command ran against a scripted `ExtensionAPI`. The TUI's
  rendering of the new prompts, and Pi's persistence of a per-model thinking level, are unobserved.

### Process note
`.Plans/PLAN_model-selector-thinking.md` was written before implementation, unlike the two entries
above that disclosed skipping it.

### Follow-up — `/measure-thinking-levels`, and why re-measuring is a command
The user asked whether a stored measurement is needed at all, then proposed asking to re-measure when
the model or effort setting changes, and finally settled on a dedicated command. Naming was theirs:
`/measure-thinking-levels` over the earlier `/measure_reasoning_effort` suggestion.

| Question examined | Finding |
| --- | --- |
| Does Pi report the thinking level being *changed*? | `pi.on("thinking_level_select")` exists, but `AgentSession.setThinkingLevel` emits only when `effectiveLevel !== previousLevel` (`agent-session.js:1364-1378`). On a model registered without reasoning the only available level is `off`, so the level never changes and **the event never fires** — the exact situation a re-measure prompt would be needed for is the one it cannot observe. |
| Does Pi report the model being changed? | Yes: `model_select` with `source: "set" | "cycle" | "restore"` (`agent-session.js:1238-1244`), and dialogs are available where `ctx.hasUI`. So a prompt on model switch is *possible* — declined in favour of the command, and available later if wanted. |
| Can a stale map be detected from the response? | Partially. `after_provider_response` carries `status` and `headers` only (`types.d.ts:533-537`) — no body, so a 400 cannot be confirmed as "Unexpected reasoning effort" without guessing among unrelated 400 causes. Not used. |
| Decision | `/measure-thinking-levels`: measures the current model, saves, re-registers, and re-binds the session. Explicit, zero extra requests when nothing is wrong, no dialog that can misfire at startup or during a session restore. |

Why re-binding the session matters: the session holds the `Model` object it was handed, so updating
Pi's registry alone does not change what the next request sends. The command therefore re-reads the
live registry entry and calls `setModel` on it — the same reason `/select-model` does. It deliberately
does **not** write `defaultProvider`/`defaultModel`, because re-measuring is not choosing a model.

Both measurement paths now share `measureThinkingCapability`, so the probe and its fallback dialog
cannot drift; verified by driving the new command in the scripted harness (measure → false → measure
again), including that an unmanaged provider is refused rather than probed blind. Type check still
clean.

### Follow-up — OpenAI-compatible API only, by decision
While answering whether audio input is possible, Ollama's native endpoints turned out to declare
per-model capabilities, which is exactly the information this extension asks and probes for. The user
chose to keep the OpenAI-compatible surface only and continue with `/measure-thinking-levels`.

| Measured | Result |
| --- | --- |
| `GET /v1/models` — vLLM | `id, object, created, owned_by, root, parent, max_model_len, permission`. No capability field of any kind. |
| `GET /v1/models/<id>` — vLLM | HTTP 404: the OpenAI retrieval endpoint is not implemented. |
| `GET /v1/models`, `GET /v1/models/<id>` — Ollama | `id, object, created, owned_by`. Nothing about modality or reasoning. |
| `GET /api/tags` — Ollama native | Per-model `capabilities`: `qwen3.8:27b-mlx` = completion/vision/tools/thinking, `gemma4:12b-mlx` = completion/vision/**audio**/tools/thinking, `ornith-1.5:9b` = tools/thinking/completion/vision. One request covers every model. |
| Audio through the current model | `input_audio` content part -> HTTP 400 `At most 0 audio(s) may be provided in one prompt.` The deployment has no audio encoder. |
| Audio through Pi | Input modalities are `text | image` only (`model-config.js:146` and `:158`); no audio content type exists in Pi's message types. Unreachable regardless of what a server declares. |

| Decision | Reason |
| --- | --- |
| Do not read `/api/tags` or `/api/show` | Recognising Ollama means special-casing base URLs or adding a provider flag. That is where a generic OpenAI-compatible selector stops being generic, and the benefit -- skipping a one-time question and a one-time eight-request probe -- does not pay for it. |
| Keep probing as the single mechanism | One code path answers the same question on vLLM, Ollama, llama.cpp, LM Studio and anything else that speaks the API, instead of a table of server quirks. |
| Recorded anyway | The measured capability lists are the clearest available statement of what those servers know about their own models, and they confirm the probe is right: the two Ollama models that declare `thinking` accept all seven `reasoning_effort` values. |
| Audio needs no decision here | It is out of reach at the Pi layer, so no capability plumbing would help even if the model had an encoder. |

### Follow-up — the measurement reported nothing on screen, and why
The user ran `/measure-thinking-levels` and saw no log and no notification. Reading Pi's TUI showed two
separate causes, both in how Pi renders extension output.

| Pi behaviour | Code | Effect on this extension |
| --- | --- | --- |
| `ui.notify(msg, "info")` calls `showStatus`, which **replaces one dim status line in place** | `interactive-mode.js:2878-2886` | The two info notifications this extension emitted overwrote each other; only the last existed, in dim colour. The measured level map was therefore invisible. |
| `ui.notify(msg, "warning" / "error")` **appends** a persistent line | `interactive-mode.js:3525-3528` | Warnings survive; successes do not. Explains why the fallback path was visible and the happy path was not. |
| `setWorkingMessage` updates the text only if a working indicator is already active, and `setWorkingVisible(true)` shows it only when `session.isStreaming` | `interactive-mode.js:1663-1673`, `1905-1910` | A command handler is not a streaming turn, so the "Measuring..." working message was dead code that could never render. |

| Decision | Reason |
| --- | --- |
| Say everything in **one** info line per command | Two info lines are one line in practice. The composed line carries the mapping, the values the server rejects, whether the server thinks by default, and the pointer to `/thinking`. |
| Emit a status line **before** probing | Replaces the unrenderable spinner. It is then replaced by the result, which is the "Measuring... then result" sequence the user asked for. |
| Group levels that share a server value (`minimal/low=low`, `high/xhigh/max=xhigh`) | Everything has to fit one wrapped dim line; grouping cut the mapping roughly in half without losing a level. |
| Keep warnings appended, successes in the status line | Matches how Pi renders them rather than fighting it. |
| Remove the `setWorkingMessage` calls rather than guard them | Proven unable to render outside a streaming turn; keeping a call that cannot draw anything is decoration. |

Verified by extending the scripted harness: the pre-probe line appears first and names the request
count, the final line contains the grouped mapping and the `/thinking` pointer, the grouped form matches
`off=none minimal/low=low medium=medium high/xhigh/max=xhigh` exactly, and no working-indicator call is
made at all. Type check still clean.

## 2026-09-27 — SYSTEM.md: three-sentence reporting rule, prose boxes removed
The user supplied a reporting guide — reports must stay compact, ideally three sentences,
structured Cause / Progress / Conclusion, because long prose is not human-readable — and
asked for it in an appropriate place, in corrected English. The draft conflicted with the
existing Report Format Template (five sections, "up to 10 sentences" of prose), so the
conflict had to be resolved first.

| Decision | Reason |
| --- | --- |
| Three sentences govern prose; the five-section template stays | User's chosen option. Section 1 Executive Summary carries the whole prose: one Cause, one Progress, one Conclusion sentence. Sections 2, 3, 5 keep their slots but carry no prose — the three sentences already say them. |
| Tables, diagrams, code stay exempt from the limit | They are data displays, not prose; the Visual Communication principle and the Key Results metrics table remain fully usable. |
| Rule recorded in three places: Core Principles row, step 10, Report Format Template | It constrains the report at every point a report is specified; one isolated mention would be easy to miss while filling the template. |
| Box-drawing borders removed from non-table content | User: border lines on prose are noise. Report Format Template sections now use headings and bullet points; Key Results became a real Markdown table. Box-drawn genuine tables elsewhere in the file are kept, with widths script-verified. |
| English of the draft corrected | "Cause, Progress, Concolusion will be ideal structure" → Cause / Progress / Conclusion, one sentence each; the reason (long prose is unreadable) kept as the rule's justification. |
| SYSTEM.html updated in the same commit | AGENTS.md synchronization rule: same content, English and Korean — core-principles row, step 10 row, report-format intro and cards. |

Verified by script: every box block uniform width, zero borders left inside the report
template, HTML tag balance clean, rule text present in both files.

---

## 2026-10-09 — SYSTEM.md English pass; reporting budget moved from a three-sentence total to per-section limits

The user rewrote the front matter and the Core Principles of `.pi/SYSTEM.md` in plainer
prose and asked for an English review, then for the readable page and a commit.
Fifteen items were corrected: three typos (`sicentifically`, `comprensive`,
`self-documentd`), six grammar faults (missing articles, "Focus on what are asked",
"make sure goals with user's confirmation"), and six wordings an agent could parse
two ways. Two more rules arrived from the user while the work was in flight.

| Decision | Reason |
| --- | --- |
| Front matter split into checking one's own work (internal, every step) and asking the user (only while the goal is unclear or information is missing) | User's chosen option. One sentence had covered both, so "keep self-questioning" could be read as "keep asking the user" during execution and verification, which later phases forbid. |
| Duplicate lead-in line deleted; the three requirement bullets kept as full sentences | "Your work must be" repeated bullet 1 word for word, and could not introduce bullets whose subjects are the plan and the code. |
| Core Principles table, the "Additional guidance" list, and the **Plain Naming** rule removed from `SYSTEM.html` as well | The user's edit deleted them from `.pi/SYSTEM.md`, and AGENTS.md requires the same content in both files. This reverses the 2026-09-16 decision recorded above, so it is noted here rather than left silent. |
| Reporting prose is capped per section, with no total cap: Motivation 2, Progress 1, Conclusion 2, Problem Context brief, Recommendations 3 | User's chosen option. Their edit had set per-section limits while the rule paragraph and step 10 still forbade three sentences in total; an agent cannot obey both. The tighter alternative was offered and declined. |
| Report field renamed Cause to Motivation everywhere | The user renamed it in the template. Step 10, the rule paragraph, and both HTML cards still said "cause". |
| Heading claim "the only place report prose appears" dropped from section 1 | Sections 2 and 5 now carry prose, which made the claim false. |
| The two user rules added mid-task — reviewing the user's English, and commit message size — were corrected and mirrored to HTML too | Committing them in Markdown only would have left the page out of sync on the very day the sync was the task. |
| Parity is checked by token stream, not by string equality | AGENTS.md allows the readable page to tidy a sentence. Nine prose lines differ in wording by design; each was read side by side and confirmed to carry the same rule. |
| Step 10's box-drawing row rewritten with computed padding; all seven box blocks re-measured | A hand-aligned ASCII table breaks as soon as its text length changes. |
| Left as found: the unclosed ```c fence, `## UI Design` outranking `### Logging Strategy`, and the HTML heading "User interface design with HyperText Markup Language" | None of them is an English fault and none is this task. The last is a leftover of the removed Plain Naming rule — flagged, not changed. |

Verified by script: typos and removed rules absent from both files, 114 English spans
matched by 114 Korean spans with none empty, tag balance clean, no network references,
13 of 13 table cells and 44 of 53 prose lines verbatim, the 9 residuals reviewed
manually as paraphrases.
