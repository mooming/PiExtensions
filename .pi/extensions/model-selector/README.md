# Model Selector Extension

Generic provider + model selector for Pi. It reads provider definitions from `models.json`,
discovers each provider's models through the OpenAI-compatible `/v1/models` endpoint, registers
them with Pi, and lets you pick one with `/select-model` — including models served by
vLLM / llama.cpp / Ollama / LM Studio or any other OpenAI-compatible server.

## Commands

| Command | What it does |
| --- | --- |
| `/select-model` | Pick a provider, then a model, then answer "Accepts image input?" and "Supports thinking?" (remembered answers are preselected; thinking is measured against the server rather than guessed). Loaded models sort first and are tagged `[loaded]`; models that accept images are tagged `[vision]`; models with thinking levels are tagged `[thinking]`. The choice becomes Pi's **default model** and survives a restart. |
| `/measure-thinking-levels` | Re-measure the **current** model's thinking levels against its server and apply the result to this session — no re-selection, no re-asking about images or context length. Use it after changing the server's reasoning flags, swapping a checkpoint, or upgrading Ollama. |
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

### Thinking: measured against the server, not guessed

Pi offers a thinking level only when the model is registered with `reasoning: true`, and it sends a
thinking control field only then. `/v1/models` carries no reasoning information — vLLM reports
`max_model_len` and nothing else, Ollama reports identifiers and nothing else — so vision and
thinking look like the same problem. They are not: **vision has to be asked, thinking can be
measured.** An OpenAI-compatible endpoint answers `200` or `400` to each `reasoning_effort` value.

Choosing **Measure against the server** in `/select-model` sends eight requests with `max_tokens: 16`
to `/v1/chat/completions` — one without `reasoning_effort`, then one per candidate value — records
which were accepted, and stores the result:

```jsonc
// <agent dir>/model-capabilities.json — written by /select-model, owned by this extension
{
  "my-vllm": {
    "Qwen/Qwen3.8-Flash-Next": {
      "vision": true,
      "reasoning": true,
      "thinkingLevelMap": {
        "off": "none", "minimal": "low", "low": "low", "medium": "medium",
        "high": "xhigh", "xhigh": "xhigh", "max": "xhigh"
      }
    }
  }
}
```

That entry is what a vLLM Qwen3.8 deployment actually measured: it accepts `none`, `low`, `medium`,
`xhigh` and answers **HTTP 400** — `Unexpected reasoning effort high. Supported types are xhigh
(default), medium, and low.` — to `minimal`, `high` and `max`, which are three of Pi's own level
names. Two consequences explain the design:

* **`reasoning: true` without a map is broken, not merely coarse.** Pi sends its own level names, so
  with `defaultThinkingLevel: high` *every request* would fail. The map and the flag are stored and
  written as one unit for this reason.
* **Registering `reasoning: false` does not switch thinking off either.** This server thinks unless
  it is told not to: measured `144`–`3559` characters of reasoning with no control field sent, `0`
  with `reasoning_effort: "none"`. A hardcoded `false` therefore hides an active, uncontrolled cost.

Mapping rules (`thinking-probe.ts`): a level takes its own name when the server accepts that
spelling; otherwise it rounds **up** to the nearest accepted value, matching the direction of Pi's
own `clampThinkingLevel` and erring towards thinking more rather than silently doing less. `off` is
claimed only when the server has a value that truly disables thinking — otherwise it is set to `null`
and disappears from the level list, because a level that stops nothing is worse than no level.

**If the probe cannot read the server** — no auth, offline, or a body the server rejects for
unrelated reasons — the extension says why and asks you to pick a vocabulary (OpenAI style,
Qwen/vLLM style, all-levels, or none). It never substitutes a guess, since a map of values that
server rejects breaks every request.

Cost: eight tiny requests, once per model id, then remembered. A cold local model made it take ~26 s
on Ollama, ~5 s on a remote vLLM.

To re-measure after changing a server's flags (`--reasoning-parser`, a new checkpoint, an Ollama
upgrade), run **`/measure-thinking-levels`** — it measures the current model and applies the result to
the session immediately. `/select-model` → **Measure against the server** does the same thing while you
are choosing a model.

> The stored measurement is a cache of one deployment's behaviour, and nothing can detect that
> deployment changing from the client side: the model id stays the same when a flag changes, and a
> rejected `reasoning_effort` surfaces as a failed request, not as an event Pi exposes. That is why
> re-measuring is a command rather than an automatic prompt.

> **Server-specific capability endpoints are deliberately not used.** Ollama's native `/api/tags` and
> `/api/show` do declare per-model `capabilities` — `vision`, `thinking`, even `audio` — and reading
> them would remove both the question and the measurement for Ollama models. Declined: this extension
> speaks the OpenAI-compatible API only, and deciding "is this Ollama?" means special-casing base URLs,
> which is the point where a generic selector stops being generic. Probing answers the same question on
> every server, at eight short requests per model, once.

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
| `/thinking` offers only `off` | The model is registered `reasoning: false`, which is the default for anything not yet measured. Run `/select-model`, pick the model, choose **Measure against the server**. |
| Thinking happens although the level says `off` | The model was registered `reasoning: false`, so Pi sends no control field and the server applies its own default (vLLM Qwen thinks unless told otherwise). Measuring gives you an `off` that sends a real disable value. |
| Every request fails: `Unexpected reasoning effort …` HTTP 400 | A stored `thinkingLevelMap` contains values this server rejects — it was picked from the fallback list, or the server changed. Re-measure with `/select-model`. |
| `Could not measure thinking levels: …` | The probe could not read the server (auth, unreachable, or a request shape it rejects). Pick a vocabulary in the dialog that follows; nothing is guessed for you. |
| `<provider> is not configured in models.json` from `/measure-thinking-levels` | The active model is not one this extension discovered (a built-in provider, or a provider removed from `models.json`). Nothing is measured. |
| `[thinking]` missing although the model thinks | Measured `reasoning: false` means the server accepted no thinking value. Check the server's reasoning flags (`--reasoning-parser`) and re-measure. |
| `Invalid models.json schema: providers.<id>.models: must be array` | Something other than Pi's array of model definitions was written into `models` — a key this extension never writes. While the file is invalid Pi loads **no** providers from it, so every provider seems to vanish. |
