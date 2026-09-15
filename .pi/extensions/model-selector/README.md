# Model Selector Extension

Generic provider + model selector for Pi. It reads provider definitions from `models.json`,
discovers each provider's models through the OpenAI-compatible `/v1/models` endpoint, registers
them with Pi, and lets you pick one with `/select-model` — including models served by
vLLM / llama.cpp / Ollama / LM Studio or any other OpenAI-compatible server.

## Commands

| Command | What it does |
| --- | --- |
| `/select-model` | Pick a provider, then a model. Loaded models sort first and are tagged `[loaded]`. The choice becomes Pi's **default model** and survives a restart. |
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
      "maxContextLength": 262144                  // optional override
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
