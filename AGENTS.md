# PiExtensions Agents Guide

## Structure
- **Extensions**: Located in `.pi/extensions/<extension-id>/`.
- **Entry Point**: Every extension must have an `index.ts` that exports a default async function:
  `export default async function (pi: ExtensionAPI) { ... }`
- **Available extensions**:
  - `model-selector`: Generalized model selector that reads `~/.pi/agent/models.json`.
  - `unload-model`: Allows unloading loaded models from providers using the `/models/unload` API.


## Project system prompt
- **`.pi/SYSTEM.md`**: The project system prompt the agent is given — naming rules, the four-phase execution protocol, the review roles, and the report format. Plain text, because an agent reads it.
- **`SYSTEM.html`**: The same content laid out for a person — real tables, two hand-drawn inline SVG diagrams, and an English / Korean toggle. It opens with no network access and no build step.
- **Always keep both files synchronized**: whenever `.pi/SYSTEM.md` changes, update `SYSTEM.html` in the same commit, so the two files always carry the same content. A rule, a step, or a report section that lives in only one of them is documented half.
  Match content, not characters: the page may tidy a sentence, add the Korean counterpart, and carry reader affordances plain text cannot hold — the diagram key, section navigation, the language toggle.

## Development
- **Types**: Use `@earendil-works/pi-coding-agent` for the `ExtensionAPI`.
- **Verification**: No local test suite or build commands. Verify by loading extensions into the Pi Coding Agent.
- **Documentation**: Include a `README.md` in each extension folder describing features and usage.
- **Reference Documentation**: For official Pi documentation, refer to the [Pi Coding Agent GitHub Repository](https://github.com/earendil-works/pi-coding-agent).

## Installation
Extensions can be installed by placing them in:
- `.pi/extensions/` (repo local)
- `~/.pi/agent/extensions/` (global)
