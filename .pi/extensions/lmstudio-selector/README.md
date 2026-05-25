# LM Studio Model Selector Extension

This PI extension provides a `/lmstudio` command that allows you to select and switch between models available in LM Studio.

## Features

- `/lmstudio` command to open model selection UI
- Fetches available models from LM Studio API (localhost:1234/v1/models)
- Shows model names and context window information
- Immediately switches to selected model when chosen

## Installation

Place this extension in `~/.pi/agent/extensions/lmstudio-selector/` or `.pi/extensions/lmstudio-selector/`

## Usage

1. Ensure LM Studio is running with its API server active
2. Type `/lmstudio` in PI to open the model selector
3. Select a model from the list
4. The extension will immediately switch to that model

## Requirements

- LM Studio running with API server enabled (default port 1234)
- PI version supporting extension commands and model switching

## Notes

The extension automatically detects when a LM Studio model is selected and updates the status bar. If you don't see any models, make sure LM Studio is running with its API server enabled.