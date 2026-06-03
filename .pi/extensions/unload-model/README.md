# Model Unloader Extension

This extension provides a command to unload models from configured LLM providers.

## Usage

Run the command `/unload-model` in Pi.

## Workflow

1. **Select Provider**: Choose a provider from your `models.json` configuration.
2. **Select Model**: The extension will fetch the list of loaded models from the provider and ask you to select one.
3. **Unload**: The extension sends a `POST /models/unload` request to the provider to free up resources.

## Configuration

This extension relies on the same `models.json` used by the `model-selector` extension, located at:
- `~/.pi/agent/models.json`
- Or the project root `models.json`

## API

### GET /models: List loaded models

Returns information about loaded models. The response includes a `status` object with `value` field indicating whether the model is loaded, unloaded, loading, sleeping, or failed.

### POST /models/unload: Unload a model

Unload a model

Payload:
```json
{
  "model": "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M",
}
```

Response:
```json
{
  "success": true
}
```

## API errors

llama-server returns errors in the same format as OAI: https://github.com/openai/openai-openapi

Example of an error:
```json
{
    "error": {
        "code": 401,
        "message": "Invalid API Key",
        "type": "authentication_error"
    }
}
```