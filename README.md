# PiExtensions

A collection of useful extensions for **Pi Coding Agent** – small, friendly add‑ons that make Pi even more helpful.

## Structure
- Extensions live under `.pi/extensions/<extension-id>/`.
- Each extension must export a default async function from an `index.ts` file:
  ```ts
  export default async function (pi: ExtensionAPI) { /* … */ }
  ```
- **Available extensions**:
  - `model-selector`: A gentle, generalized model selector. It reads a `models.json` file in `~/.pi/agent/`, discovers the providers you’ve listed, fetches their available models, and registers them with Pi. After that you can use the **/select‑model** command to pick a provider and a model from a friendly UI.

## How `model‑selector` works (in plain language)
1. **Read your configuration** – it looks for `~/.pi/agent/models.json` (or a `models.json` in the project root) and parses the JSON.
2. **Ask each provider** – for every provider defined, it calls the provider’s `/v1/models` endpoint to obtain a list of models.
3. **Register with Pi** – the discovered providers and their models become first‑class citizens inside Pi, so the rest of Pi (commands, UI, etc.) can treat them like built‑in models.
4. **Select a model** – when you run the `/select‑model` command, Pi shows a list of providers, then a list of models for the chosen provider. Picking one instantly switches the session to that model.

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
   model: anav96-llama: bartowski/google_gemma-4-31B-it-GGUF:Q8_0
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
