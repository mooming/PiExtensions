import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Generic Provider Selector Extension
 *
 * This extension reads a `models.json` file that defines multiple providers.
 * For each provider it queries the standard `/v1/models` endpoint to discover
 * available models and registers them with Pi. It also registers a command
 * `select-model` that lets the user pick a provider and then a model.
 */
export default async function (pi: ExtensionAPI)
{
  // Load provider definitions from models.json (expected at ~/.pi/agent/models.json or project root)
  const pathsToTry = [
    path.join(os.homedir(), ".pi", "agent", "models.json"),
    path.resolve(process.cwd(), "models.json"),
  ];

  let providerDefs: Array<{
    id: string; // provider identifier, used as Pi provider ID
    baseUrl: string; // base URL without trailing slash, e.g., "http://localhost:1234"
    apiKey?: string; // optional API key for the provider
    description?: string;
    // Optional maximum context length (tokens) for models from this provider.
    maxContextLength?: number;
  }> = [];
  let foundPath: string | null = null;

  for (const p of pathsToTry)
  {
    try
    {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed))
      {
        providerDefs = parsed;
        foundPath = p;
        break;
      }
      else if (parsed && typeof parsed === "object" && parsed.providers)
      {
        // Support { "providers": { "id": { ... }, ... } } format
        const providersObj = parsed.providers;
        if (typeof providersObj === "object" && providersObj !== null)
        {
          providerDefs = Object.entries(providersObj).map(([id, def]: [string, any]) => ({
            id,
            ...def,
          }));
          foundPath = p;
          break;
        }
      }
    }
    catch (e)
    {
      // Continue to next possible path
    }
  }

  if (!foundPath)
  {
    console.error(`Failed to read models.json in ${pathsToTry.join(", ")}`);
    return;
  }

  // Helper to fetch models from a generic provider using the OpenAI-compatible schema.
// Allows an optional contextWindowOverride to customize max context length per provider.
  async function fetchProviderModels(baseUrl: string, apiKey?: string, contextWindowOverride?: number)
  {
    // Construct the models endpoint. If baseUrl already ends with "/v1", use it directly.
    const primaryUrl = baseUrl.replace(/\/*$/, "").endsWith("/v1")
      ? `${baseUrl.replace(/\/*$/, "")}/models`
      : `${baseUrl.replace(/\/*$/, "")}/v1/models`;
    const fallbackUrl = `${baseUrl.replace(/\/*$/, "")}/models`;
    const headers: Record<string, string> = { "Accept": "application/json" };

    if (apiKey)
    {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // Try primary URL first, then fallback if it fails (e.g., provider doesn't use /v1 prefix).
    let response;
    try {
      response = await fetch(primaryUrl, { headers, timeout: 5000 });
      if (!response.ok) throw new Error();
    } catch (e) {
      // Try fallback URL
      response = await fetch(fallbackUrl, { headers, timeout: 5000 });
      if (!response.ok) {
        throw new Error(`Failed to fetch models from ${primaryUrl} and fallback ${fallbackUrl}`);
      }
    }

    const data = await response.json();

    // Expected OpenAI format: { data: [{ id: string, ... }], object: "list" }
    const models = data?.data ?? [];

    return models.map((m: any) => ({
      id: m.id,
      name: m.id,
      status: m.status?.value || "unloaded", // Track if model is loaded
      // OpenAI does not expose reasoning or vision flags; default to false.
      reasoning: false,
      vision: false,
      // Context window is not provided; use a sensible default, but allow override.
      context_window: typeof contextWindowOverride === 'number' ? contextWindowOverride : 128000,
    }));
  }

  // Helper to register a single provider (used at start and after context‑length changes)
  async function registerProvider(provider: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    maxContextLength?: number;
  }) {
    try {
      const modelsData = await fetchProviderModels(
        provider.baseUrl,
        provider.apiKey,
        provider.maxContextLength
      );

      if (modelsData && modelsData.length > 0) {
        const normalizedBase = provider.baseUrl.replace(/\/*$/, "");
        const finalBaseUrl = normalizedBase.endsWith("/v1")
          ? normalizedBase
          : `${normalizedBase}/v1`;
        pi.registerProvider(provider.id, {
          baseUrl: finalBaseUrl,
          apiKey: provider.apiKey ?? "",
          api: "openai-completions",
          models: modelsData.map(m => ({
            id: m.id,
            name: m.name || m.id,
            isLoaded: m.status === "loaded", // Track if model is loaded for sorting
            reasoning: m.reasoning || false,
            input: m.vision ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.context_window || 128000,
            maxTokens: 4096,
          })),
        });
        console.log(`Registered provider ${provider.id} with ${modelsData.length} models`);
      }
    } catch (err) {
      console.error(`Failed to register provider ${provider.id}:`, err);
    }
  }

  // Register each provider initially
  for (const provider of providerDefs) {
    await registerProvider(provider);
  }

  // Register a generic command to select a model from any registered provider
  pi.registerCommand("select-model",
    {
      description: "Select a model from any configured provider",
      handler: async (args, ctx) => {
        // Build a list of providers that have models registered
        const providers = providerDefs.map(p => p.id);
        const providerChoice = await ctx.ui.select("Select Provider", providers);
        if (!providerChoice) {
          return;
        }

        const registry = ctx.modelRegistry;
        const allModels = await registry.getAvailable();
        const available = allModels.filter(m => m.provider === providerChoice);
        if (!available || available.length === 0) {
          ctx.ui.notify(`No models found for provider ${providerChoice}`, "error");
          return;
        }

        // Sort: loaded models first, then unloaded
        available.sort((a, b) => (b.isLoaded ? 1 : 0) - (a.isLoaded ? 1 : 0));

        // Display models with [loaded] tag for loaded models
        const modelOptions = available.map(m => 
          `${m.isLoaded ? "[loaded] " : ""}${m.name} (${m.id})`
        );

        const modelLabel = await ctx.ui.select(
          `Select Model from ${providerChoice}`,
          modelOptions
        );
        if (!modelLabel) {
          return;
        }

        // Remove the [loaded] tag if present to find the model
        const selected = available.find(m => {
          const label = m.isLoaded ? `[loaded] ${m.name} (${m.id})` : `${m.name} (${m.id})`;
          return label === modelLabel;
        });
        if (selected) {
          // Ask user whether to keep the auto‑detected context window or set a custom one
          const contextOption = await ctx.ui.select("Set max context length?", ["Auto", "Custom"]);
          if (contextOption === "Custom") {
            let input: string | undefined;
            if (ctx.ui.input) {
              input = await ctx.ui.input("Enter max context length (tokens)", { placeholder: "e.g. 200000" });
            } else {
              const common = ["65536", "131072", "262144", "524288", "Custom"]; // common sizes
              const choice = await ctx.ui.select("Pick a size (or Custom)", common);
              if (!choice) return;
              if (choice === "Custom") {
                input = await ctx.ui.input("Enter max context length (tokens)", { placeholder: "e.g. 200000" });
              } else {
                input = choice;
              }
            }
            const value = Number(input);
            if (!isNaN(value) && value > 0) {
              // Override the model's contextWindow for this session only
              selected.contextWindow = value;
            } else {
              ctx.ui.notify("Invalid number entered – using auto context length.", "error");
            }
          }
          await pi.setModel(selected);
          ctx.ui.notify(`Switched to ${selected.id} from ${providerChoice}`, "info");
        } else {
          ctx.ui.notify(`Model selection failed.`, "error");
        }
      }
    }
  );

  // Register a command to customize the max context length for a provider via the TUI
  pi.registerCommand("set-context-limit", {
    description: "Set custom max context length (tokens) for a provider",
    handler: async (args, ctx) => {
      // Choose which provider to configure
      const providerIds = providerDefs.map(p => p.id);
      const chosen = await ctx.ui.select("Select Provider to set context length", providerIds);
      if (!chosen) return;

      // Prompt for a numeric value
      let input: string | undefined;
      if (ctx.ui.input) {
        // Newer API provides a free‑text input dialog
        input = await ctx.ui.input("Enter max context length (tokens)", { placeholder: "e.g. 200000" });
      } else {
        // Fallback: present a list of common sizes
        const common = ["65536", "131072", "262144", "524288", "Custom"]; // 64k, 128k, 256k, 512k
        const choice = await ctx.ui.select("Pick a size (or Custom)", common);
        if (!choice) return;
        if (choice === "Custom") {
          input = await ctx.ui.input("Enter max context length (tokens)", { placeholder: "e.g. 200000" });
        } else {
          input = choice;
        }
      }

      const value = Number(input);
      if (isNaN(value) || value <= 0) {
        ctx.ui.notify("Invalid number entered.", "error");
        return;
      }

      // Update the in‑memory definition
      const provider = providerDefs.find(p => p.id === chosen);
      if (provider) {
        provider.maxContextLength = value;
      }

      // Persist back to the models.json file we originally loaded (foundPath)
      if (foundPath) {
        try {
          const original = JSON.parse(fs.readFileSync(foundPath, "utf-8"));
          // Ensure we keep the original shape (array or {providers: {...}})
          if (Array.isArray(original)) {
            // Find entry by id and replace
            const idx = original.findIndex((e: any) => e.id === chosen);
            if (idx >= 0) {
              original[idx].maxContextLength = value;
            } else {
              // Append a new entry if it wasn't there (unlikely)
              original.push({ id: chosen, maxContextLength: value });
            }
          } else if (original && typeof original === "object") {
            if (!original.providers) original.providers = {};
            if (!original.providers[chosen]) original.providers[chosen] = {};
            original.providers[chosen].maxContextLength = value;
          }
          fs.writeFileSync(foundPath, JSON.stringify(original, null, 2), "utf-8");
          // Unregister the old provider definition before re‑registering with the new context length
          pi.unregisterProvider(chosen);
          // Re‑register the provider so the new context length takes effect immediately
          await registerProvider(provider);
          ctx.ui.notify(`Set max context length for ${chosen} to ${value}`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed to write back to ${foundPath}: ${e}`, "error");
        }
      }
    }
  });

  // Update UI status when a model from any provider is selected
  pi.on("model_select", async (event, ctx) => {
    const { model } = event;
    ctx.ui.setStatus("model", `${model.provider}: ${model.id}`);
  });
}
