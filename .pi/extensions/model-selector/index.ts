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

  // Helper to fetch models from a generic provider using the OpenAI‑compatible schema.
  async function fetchProviderModels(baseUrl: string, apiKey?: string)
  {
    // Construct the models endpoint. If baseUrl already ends with "/v1", use it directly.
    const url = baseUrl.replace(/\/*$/, "").endsWith("/v1")
      ? `${baseUrl.replace(/\/*$/, "")}/models`
      : `${baseUrl.replace(/\/*$/, "")}/v1/models`;
    const headers: Record<string, string> = { "Accept": "application/json" };
  
    if (apiKey)
    {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    
    const response = await fetch(url, { headers, timeout: 5000 });
    if (!response.ok)
    {
      throw new Error(`Failed to fetch models from ${url}: ${response.status}`);
    }
  
    const data = await response.json();

    // Expected OpenAI format: { data: [{ id: string, ... }], object: "list" }
    const models = data?.data ?? [];

    return models.map((m: any) => ({
      id: m.id,
      name: m.id,
      // OpenAI does not expose reasoning or vision flags; default to false.
      reasoning: false,
      vision: false,
      // Context window is not provided; use a sensible default.
      context_window: 128000,
    }));
  }

  // Register each provider and its models
  for (const provider of providerDefs)
  {
    try
    {
      const modelsData = await fetchProviderModels(provider.baseUrl, provider.apiKey);
   
      if (modelsData && modelsData.length > 0)
      {
        // Register provider, ensuring we don't duplicate a trailing /v1 in the base URL
        const normalizedBase = provider.baseUrl.replace(/\/*$/, "");
        const finalBaseUrl = normalizedBase.endsWith("/v1")
          ? normalizedBase
          : `${normalizedBase}/v1`;
        pi.registerProvider(provider.id, {
          baseUrl: finalBaseUrl,
          apiKey: provider.apiKey ?? "",
          api: "openai-completions",
          models: modelsData.map(model => ({
            id: model.id,
            name: model.name || model.id,
            reasoning: model.reasoning || false,
            input: model.vision ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: model.context_window || 128000,
            maxTokens: 4096,
          })),
        });
        console.log(`Registered provider ${provider.id} with ${modelsData.length} models`);
      }
    } catch (err) {
      console.error(`Failed to register provider ${provider.id}:`, err);
    }
  }

  // Register a generic command to select a model from any registered provider
  pi.registerCommand("select-model",
    {
      description: "Select a model from any configured provider",
      handler: async (args, ctx) => {
        // Build a list of providers that have models registered
        const providers = providerDefs.map(p => p.id);
        const providerChoice = await ctx.ui.select("Select Provider", providers);
        if (!providerChoice)
        {
          return;
        }

        const registry = ctx.modelRegistry;
        const allModels = await registry.getAvailable();
        const available = allModels.filter(m => m.provider === providerChoice);
        if (!available || available.length === 0)
        {
          ctx.ui.notify(`No models found for provider ${providerChoice}`, "error");
          return;
        }

        const modelLabel = await ctx.ui.select(
          `Select Model from ${providerChoice}`,
          available.map(m => `${m.name} (${m.id})`)
        );
        
        if (!modelLabel)
        {
          return;
        }

        const selected = available.find(m => `${m.name} (${m.id})` === modelLabel);
        if (selected)
        {
          await pi.setModel(selected);
          ctx.ui.notify(`Switched to ${selected.id} from ${providerChoice}`,
            "info");
        }
        else
        {
          ctx.ui.notify(`Model selection failed.`, "error");
        }
      }
    }
  );

  // Update UI status when a model from any provider is selected
  pi.on("model_select", async (event, ctx) => {
    const { model } = event;
    ctx.ui.setStatus("model", `${model.provider}: ${model.id}`);
  });
}
