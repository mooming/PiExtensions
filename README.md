# PiExtensions

A collection of useful extensions for **Pi Coding Agent** – small, friendly add‑ons that make Pi even more helpful.

## Structure
- Extensions live under `.pi/extensions/<extension-id>/`.
- Each extension must export a default async function from an `index.ts` file:
  ```ts
  export default async function (pi: ExtensionAPI) { /* … */ }
  ```
- **Available extensions**:
  - `model-selector`: A gentle, generalized model selector. It reads a `models.json` file in `~/.pi/agent/`, discovers the providers you’ve listed, fetches their available models, and registers them with Pi. After that you can use the **/select‑model** command to pick a provider and a model from a friendly UI. It also settles what `/v1/models` cannot report: vision is asked once, and thinking levels are **measured against the server** and remembered, so `/thinking` offers the levels your server actually accepts. Re-run that measurement any time with **/measure-thinking-levels**. Your choice is saved as Pi's default model, so it survives a restart (Pi ≥ 0.84.3 made `setModel()` session-scoped, which this extension works around). [Docs](.pi/extensions/model-selector/README.md).
  - `auto-continue`: Detects when the agent halts with **"Response was truncated before completion."** and automatically submits a continuation prompt on your behalf, so a cut‑off response resumes and finishes without you having to type “continue”. [Docs](.pi/extensions/auto-continue/README.md).

## How `model‑selector` works (in plain language)
1. **Read your configuration** – it looks for `~/.pi/agent/models.json` (or a `models.json` in the project root) and parses the JSON.
2. **Ask each provider** – for every provider defined, it calls the provider’s `/v1/models` endpoint to obtain a list of models.
3. **Register with Pi** – the discovered providers and their models become first‑class citizens inside Pi, so the rest of Pi (commands, UI, etc.) can treat them like built‑in models.
4. **Select a model** – when you run the `/select‑model` command, Pi shows a list of providers, then a list of models for the chosen provider. Picking one instantly switches the session to that model.
5. **Settle what the server cannot report** – vision is asked once and remembered; thinking levels are probed against the server (eight tiny chat requests, once per model), because a level the server rejects fails the request outright. Both are kept in `model-capabilities.json` in the agent directory.

### Example `models.json`
```json
{
  "providers": {
    "example-provider-1": {
      "baseUrl": "http://localhost:1234",
      "apiKey": "YOUR_API_KEY",
      "maxContextLength": 200000 // optional, overrides default context window for this provider's models
    },
    "example-provider-2": {
      "baseUrl": "http://your-host:port",
      "apiKey": "YOUR_API_KEY"
    }
  }
}
```
Place this file at `~/.pi/agent/models.json`. The extension will automatically pick it up the next time Pi starts.

## Project system prompt and its readable page

Two files hold the same working agreement, in two forms:

| File | Read by | Form |
| --- | --- | --- |
| `.pi/SYSTEM.md` | the agent | plain text: naming rules, the four-phase execution protocol, the review roles, the report format |
| `SYSTEM.html` | you | the same content laid out for a person — real tables, two hand-drawn inline SVG diagrams, and an **English / 한국어** toggle at the top right. Open it with `open SYSTEM.html`; it needs no network access and no build step |

> **Always keep the two files synchronized.** Whenever you change `.pi/SYSTEM.md`, change `SYSTEM.html` in the same commit, so both files always carry the same content. A rule, a step, or a report section that exists in only one of them is documented half — the agent would follow it and the reader would never see it, or the other way around. The page is a rendering, so a sentence may be tidied there and a Korean counterpart added: match the content, not the characters. Reader affordances that plain text cannot hold — the diagram key, section navigation, the language toggle — live in the page alone and need no counterpart.

## Development
- **Types** – import `ExtensionAPI` from `@earendil-works/pi-coding-agent` for proper typing.
- **Verification** – simply start Pi (`pi`) and ensure your extension loads without errors. Use the interactive UI to test the `/select‑model` command.
- **Documentation** – each extension’s folder should contain its own `README.md` explaining its purpose and usage.
- **Reference** – consult the official Pi docs at the [Pi Coding Agent GitHub Repository](https://github.com/earendil-works/pi-coding-agent).

## Installation
Copy the extension folder into one of the following locations so Pi can discover it:
- `.pi/extensions/` – local to this repository (good for development)
- `~/.pi/agent/extensions/` – global location for all of your Pi projects

Once placed, restart Pi and you’ll see the new `/select‑model` command ready to use!

---

## TUI usage example

Below is a quick walk‑through of how the **model‑selector** extension looks and works inside Pi’s built‑in terminal UI (TUI).

1. **Open the Pi TUI** (e.g., run `pi` in your terminal). You’ll see the usual chat area and a status bar at the bottom.
2. **Trigger the command** by typing the slash command:
   ```text
   /select-model
   ```
   The UI will pop up a selector dialog.
3. **Choose a provider** – a list appears with the providers defined in your `models.json` file.
   **Provider selection list** (example):
```
- example-provider-1
- example-provider-2
```
4. **Pick a model** – after selecting a provider, another list shows the models that were fetched from that provider’s `/v1/models` endpoint.
   **Model selection list** (example):
```
- openai/gpt-4 (ID: openai/gpt-4)
- google/gemma-4-31b (ID: google/gemma-4-31b)
```
5. **Confirm** – once you pick a model, Pi automatically switches to it and updates the status bar:
   ```text
   model: my-llama: bartowski/google_gemma-4-31B-it-GGUF:Q8_0
   ```
   The status bar now reflects the active provider and model.

You can repeat the command at any time to switch to a different model.

> **Tip:** If you don’t see any providers, double‑check that `~/.pi/agent/models.json` exists and follows the documented format. After editing the file, reload Pi (`/reload` command) to pick up the changes.

### Customising the max context length via the TUI

The extension now ships with an additional command:

```
/set-context-limit
```

Running this command opens a series of dialogs:

1. **Select a provider** – pick the provider whose context window you want to change.
2. **Enter a new value** – either choose a common size (64 k, 128 k, 256 k, 512 k) or type a custom number of tokens.
3. The new value is written back to your `models.json` file and will be used for all models from that provider.

After setting the value, you can reload the session (`/reload`) and the updated context window will be reflected in the model selector UI.

---
*Happy extending!*
