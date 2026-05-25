# PiExtensions Agents Guide

## Structure
- **Extensions**: Located in `.pi/extensions/<extension-id>/`.
- **Entry Point**: Every extension must have an `index.ts` that exports a default async function:
  `export default async function (pi: ExtensionAPI) { ... }`

## Development
- **Types**: Use `@earendil-works/pi-coding-agent` for the `ExtensionAPI`.
- **Verification**: No local test suite or build commands. Verify by loading extensions into the Pi Coding Agent.
- **Documentation**: Include a `README.md` in each extension folder describing features and usage.

## Installation
Extensions can be installed by placing them in:
- `.pi/extensions/` (repo local)
- `~/.pi/agent/extensions/` (global)
