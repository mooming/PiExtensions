# Model Selector Extension

Generic provider + model selector for Pi. It reads provider definitions from `models.json`,
discovers each provider's models through the OpenAI-compatible `/v1/models` endpoint, registers
them with Pi, and lets you pick one with `/select-model` — including models served by
vLLM / llama.cpp / Ollama / LM Studio or any other OpenAI-compatible server.

## Commands

| Command | What it does |
| --- | --- |
| `/select-model` | Pick a provider, then a model, then answer "Accepts image input?" (the remembered answer is preselected). Loaded models sort first and are tagged `[loaded]`; models that accept images are tagged `[vision]`. The choice becomes Pi's **default model** and survives a restart. |
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

### Vision: asked once, remembered in the extension's own file

Pi reads images only when the model's `input` contains `"image"`; otherwise it silently replaces
every image with `(image omitted: model does not support images)`. Nothing in `/v1/models` tells you
which models qualify: vLLM reports `supported_modalities` for multimodal checkpoints only (most
builds omit the field), and llama.cpp, Ollama and LM Studio report nothing at all. So the extension
asks you, once, and remembers:

```jsonc
// <agent dir>/model-capabilities.json — written by /select-model, owned by this extension
{
  "my-vllm": { "Qwen/Qwen2.5-VL-7B-Instruct": { "vision": true } }
}
```

Precedence: **what you answered** → **what the server reported** → `text only`. Answering **No**
therefore vetoes a server that over-reports, and deleting the file is always safe: capabilities fall
back to the server, then to text-only, and `/select-model` asks again.

To confirm a model really sees before answering, send one request with a `text` part and an
`image_url` part directly to `/v1/chat/completions` and check the reply describes the picture.

To change an answer, run `/select-model` on the same model, pick it again, and answer the other way
— the provider is re-registered immediately.

> **`models.json` stays Pi's.** This extension writes nothing into it, and you should not either for
> this purpose. Pi validates that file against `ProviderConfigSchema` (`model-config.js`), where
> `models` must be an **array** of model definitions: putting an object there does not get ignored,
> it fails validation, and Pi then loads **no** providers from the file, so every provider seems to
> have vanished. Unknown scalar keys such as `maxContextLength` are tolerated; keys Pi already owns
> structurally are not. Pi does have its own per-model layer, `modelOverrides`
> (`input: override.input ?? model.input`, applied after this extension), if you prefer config over
> the file above — it is not needed here, and an error in that file costs every provider. Check any
> hand-edit against Pi's schema, not merely `python3 -c "import json;json.load(...)"`: valid JSON is
> not the same as valid config.

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
| `(image omitted: model does not support images)` on a model that can see | The model's `input` lacks `"image"`. Answer **Yes** to "Accepts image input?" in `/select-model`, then reload — capability is resolved when the provider is registered, so `/reload` or a new session is required. |
| `[vision]` missing in `/select-model` for a model you answered Yes for | The answer is keyed by the exact model id the server reports, so a renamed or re-deployed checkpoint looks like a brand new model. Answer again for that id. |
| `Invalid models.json schema: providers.<id>.models: must be array` | Something other than Pi's array of model definitions was written into `models` — a key this extension never writes. While the file is invalid Pi loads **no** providers from it, so every provider seems to vanish. |
