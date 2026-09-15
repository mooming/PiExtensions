# Plan: persist the last selected model in model-selector

## 1. Goal (confirmed)
`/select-model` must survive a Pi restart, as it did before Pi 0.84.3.
Chosen design: **Option A** — the extension writes Pi's own `defaultProvider` / `defaultModel`
into `settings.json`, so Pi resolves the model itself at startup.

## 2. Root cause (already verified, not re-litigated here)
| Layer | Finding |
| --- | --- |
| Regression point | Pi **0.84.3** (2026-08-24). `setModel(model)` → `setModel(model, options={})` and the write became `if (options.persist)`. Bisected against npm 0.84.2 / 0.84.3. |
| Why extensions broke | The extension-facing action is unchanged in both releases: `setModel: async (model) => { await this.setModel(model) }` — no `options`, so `persist` is always `undefined`. |
| No API escape | `ExtensionAPI.setModel(model): Promise<boolean>` (`types.d.ts:1006`) exposes no options; `ExtensionAPI` has no settings surface at all. |
| Secondary | The persisted id went stale (`old-provider/…` no longer served) → `findInitialModel` step 3 fails **silently** → fallback to `anthropic/claude-opus-4-8`. |

## 3. Scope
### In
| # | Change | File |
| --- | --- | --- |
| S1 | Resolve config paths with Pi's own `getAgentDir()` (public export, aliased for extensions) instead of hardcoded `os.homedir()/.pi/agent`. Honors `PI_CODING_AGENT_DIR` on every OS. | `index.ts:19-23` |
| S2 | `persistDefaultModel(provider, modelId)` — re-read → patch only `defaultProvider`/`defaultModel` → write. | new helper |
| S3 | Call it **only when `pi.setModel()` returns `true`**; on `false`, notify failure instead of the current unconditional `"Switched to …"`. | `index.ts:291-292` |
| S4 | Replace the no-op `fetch(…, { timeout: 5000 })` with `AbortSignal.timeout(5000)`. | `index.ts:110,114` |
| S5 | Rewrite `README.md` — it documents `/lmstudio` + LM Studio on port 1234, a removed extension, and omits `/select-model`, `/set-context-limit`, and the new persistence. | `model-selector/README.md` |

### Out (explicitly, to prevent scope creep)
- Per-session custom context-window persistence — needs its own key/format decision.
- `maxTokens === contextWindow` zero-output-headroom (`8110a51`) — separate defect.
- Auto-fallback when a persisted id vanishes from the server — masks real drift.
- Three-OS CI matrix — offered, not selected.

## 4. Design notes
| Decision | Rationale |
| --- | --- |
| Write via `getAgentDir()` rather than `os.homedir()` | `config.js:421` has no `win32` branch, so `%USERPROFILE%\.pi\agent` on Windows; using Pi's resolver makes OS drift and `PI_CODING_AGENT_DIR` divergence structurally impossible. Verified: exported from `index.js:4`, aliased at `loader.js:48`, and **not** resolvable standalone — the alias is what makes it work. |
| Re-read immediately before writing | Pi locks `settings.json` with `proper-lockfile`, which is **not resolvable from an extension** (verified `MODULE_NOT_FOUND`), so we cannot take the lock. Re-read-patch-write keeps the stale-window to microseconds and preserves keys we don't own. |
| Touch only `defaultProvider` / `defaultModel` | Pi rewrites these two only via `/model` + Ctrl+S, so a real collision needs a simultaneous Ctrl+S. |
| Never write on parse failure | A corrupt `settings.json` must produce a notify, not a blind overwrite of the user's config. |
| Gate persistence on the `setModel()` return | Not scope creep: without it we would persist a model Pi refused to activate (`agent-session.js:2051` returns `false` when auth is unconfigured). |
| Path logic isolated in one small function | Lets the Node type-stripped test stub it, since the aliased import cannot resolve outside Pi. |

## 5. Verification
1. **Logic test** — Node native type-stripping harness (no compiler in repo, same approach as
   `auto-continue`) over a temp `settings.json`:
   - file absent → created with both keys + parent dir
   - existing file with unrelated keys (`theme`, `packages`, …) → all preserved
   - existing `defaultModel` → replaced, `defaultProvider` consistent
   - malformed JSON → no write, error surfaced
   - `setModel()` returning `false` → no write
2. **Signature test** — assert against installed `.d.ts`: `getAgentDir` export,
   `setModel(model): Promise<boolean>`, `AbortSignal.timeout`.
3. **Real end-to-end (the only test that matters)** — after implementing, run `/select-model`,
   confirm `settings.json` `defaultModel` changed, then confirm a fresh Pi start resolves to it.

## 6. Git
Branch `fix/model-selector-persist-default`; commit per meaningful boundary
(S1 path fix → S4 timeout → S2/S3 persistence), docs + JOURNAL last.

## 7. Known limitation
Windows and Linux columns of the platform matrix are **code-path reasoning, not executed tests**.
Verified behavior here is macOS + Node v26 only.
