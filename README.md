# PiExtensions

A collection of useful extensions for Pi Coding Agent.

## Structure
- Extensions are located in `.pi/extensions/<extension-id>/`.
- Every extension must have an `index.ts` that exports a default async function:
  `export default async function (pi: ExtensionAPI) { ... }`

## Development
- **Types**: Use `@earendil-works/pi-coding-agent` for the `ExtensionAPI`.
- **Verification**: Verify by loading extensions into the Pi Coding Agent.
- **Documentation**: Include a `README.md` in each extension folder describing features and usage.

## Installation
Extensions can be installed by placing them in:
- `.pi/extensions/` (repo local)
- `~/.pi/agent/extensions/` (global)
