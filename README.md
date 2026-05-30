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
      "apiKey": "YOUR_API_KEY"
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
*Happy extending!*
