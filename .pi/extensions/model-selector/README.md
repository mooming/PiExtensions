# Model Selector Extension

Generic provider + model selector for Pi. It reads provider definitions from `models.json`,
discovers each provider's models through the OpenAI-compatible `/v1/models` endpoint, registers
them with Pi, and lets you pick one with `/select-model` — including models served by
vLLM / llama.cpp / Ollama / LM Studio or any other OpenAI-compatible server.

## Commands

| Command | What it does |
| --- | --- |
| `/select-model` | Pick a provider, then a model. Loaded models sort first and are tagged `[loaded]`; models that accept images are tagged `[vision]`. The choice becomes Pi's **default model** and survives a restart. |
| `/set-context-limit` | Set a max-context-length override for a provider, persisted back into `models.json` as `maxContextLength`. |

## Does the selection survive a restart?

Yes — and this is the extension's reason for existing.

Pi **0.84.3** changed `setModel()` to be session-scoped unless called with `{ persist: true }`
(see the Pi changelog: *"`/model` and `/thinking` selections being persisted globally unless
explicitly saved with Ctrl+S"*). `ExtensionAPI.setModel()` exposes no such option, so an
extension cannot ask Pi to save a selection.

This extension therefore writes the same two keys Pi itself would write — `defaultProvider` and
`defaultModel` — into `<agent dir>/settings.json`, so Pi resolves your model at startup.

* Re-read immediately before writing, and only those two keys are touched, so unrelated settings
  are preserved. Pi's own lock on the file is not reachable from an extension
  (`proper-lockfile`), which is why the write is re-read-scoped rather than locked.
* A corrupt, non-object, or unwritable `settings.json` is **never** overwritten. You get
  `Switched to … for this session only - <reason>` instead, and the model still works for
  the current session.
* If the selection cannot be activated at all (no auth for that provider) you get an error
  notification, and nothing is saved.

> Pi's built-in `/model` picker also works, but persistence there is a separate action:
> **Enter** applies for the session, **Ctrl+S** saves it as the default.

## Configuration

`models.json`, read from the agent directory (Pi's own `getAgentDir()`, so it honours
`PI_CODING_AGENT_DIR` on every OS) or `./models.json` in the project root. Both shapes work:

```jsonc
{
  "providers": {
    "my-vllm": {
      "baseUrl": "http://vllm.example:8000",      // /v1 is appended if absent
      "apiKey": "optional",
      "maxContextLength": 262144,                 // optional override
      "vision": true,                             // optional: every model here takes images
      "models": {                                 // optional per-model exceptions
        "some-text-only-model": { "vision": false }
      }
    },
    "Local Ollama": { "baseUrl": "http://127.0.0.1:11434/v1" }
  }
}
```

```jsonc
[ { "id": "my-vllm", "baseUrl": "http://vllm.example:8000", "apiKey": "optional" } ]
```

### Context window precedence

1. `max_model_len` reported by the server (source of truth for vLLM and compatible servers)
2. `maxContextLength` from `models.json`
3. `262144`

`/select-model` also offers a per-session custom context length. Note that this override is
**session-only** — it is not written to disk, so use `/set-context-limit` to make it permanent.

### Vision and reasoning

`vision` decides whether Pi sends image content to the model at all. Pi checks
`model.input.includes("image")` and, when it is absent, replaces every image with
`(image omitted: model does not support images)` — a wrong `false` does not error, it just blinds
the model. `reasoning` opts the model into Pi sending `reasoning_effort`; leave it off unless you
have confirmed the server accepts that parameter.

Precedence, most specific first:

1. `models["<model id>"].vision` from `models.json`
2. provider-level `vision` from `models.json`
3. `supported_modalities` reported by the server — only vLLM ≥ 0.9 emits it for multimodal
   checkpoints, and only for those; llama.cpp, Ollama and LM Studio report nothing
4. `false`

An explicit `false` at either config level overrides a server that over-reports. Because nothing
in `/v1/models` reliably reports vision, **declare it yourself** for models you know can see:

```jsonc
"my-vllm": {
  "baseUrl": "http://localhost:8000",
  "models": { "Qwen/Qwen2.5-VL-7B-Instruct": { "vision": true } }
}
```

Per-model entries are preferred over a provider-level `true`: a vLLM instance swaps checkpoints,
and a stale provider-level claim would keep promising vision on a text-only model.

## Requirements

* Pi (extension API with `registerCommand` / `registerProvider`)
* A reachable OpenAI-compatible server. Model discovery is bounded by a 5 s timeout per request,
  so an unreachable server logs `Failed to register provider …` and simply does not appear in the
  provider list, rather than blocking startup.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| A provider is missing from `/select-model` | Its `/v1/models` call failed or timed out. Check the server is up and `baseUrl` is reachable. |
| `Switched to … for this session only - …` | `settings.json` could not be written (permissions, or it is not valid JSON). The message names the reason; the current session still uses your model. |
| Starts on a different model than you picked | The saved `defaultModel` is no longer served by the provider — vLLM only serves what is loaded. Pi falls back **silently**; run `/select-model` again to re-save. |
| `Failed to read models.json in …` | No config found. Create `models.json` in the agent directory or the project root. |
| `(image omitted: model does not support images)` on a model that can see | The model is registered `input: ["text"]`. Declare `vision` in `models.json` (see **Vision and reasoning**) and restart — capability is resolved at provider registration, so `/reload` or a new session is required. |
| `[vision]` missing in `/select-model` for a model you declared | The id in `models` must match the server's id exactly, including casing and the org prefix. |
