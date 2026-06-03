import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Model Unloader Extension
 *
 * This extension allows unloading a model from a provider.
 * It reads provider definitions from models.json and uses a specific
 * /models/unload REST API to unload the selected model.
 */
export default async function (pi: ExtensionAPI)
{
  // Load provider definitions from models.json (expected at ~/.pi/agent/models.json or project root)
  const pathsToTry = [
    path.join(os.homedir(), ".pi", "agent", "models.json"),
    path.resolve(process.cwd(), "models.json"),
  ];

  let providerDefs: Array<{
    id: string;
    baseUrl: string;
    apiKey?: string;
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

  // Helper to fetch loaded models from a provider.
  // Since the specific "list loaded models" API wasn't provided, 
  // we try /models which often lists loaded/available models in local servers.
  async function fetchLoadedModels(baseUrl: string, apiKey?: string)
  {
    const url = `${baseUrl.replace(/\/*$/, "")}/models`;
    const headers: Record<string, string> = { 
      "Accept": "application/json",
      "Content-Type": "application/json"
    };

    if (apiKey)
    {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { headers, timeout: 5000 });
    if (!response.ok) {
      throw new Error(`Failed to fetch models from ${url}: ${response.statusText}`);
    }

    const data = await response.json();

    // Handle both OpenAI-like { data: [...] } and simple array [ ... ]
    const models = data?.data ?? (Array.isArray(data) ? data : []);

    // Filter for models that are actually loaded
    return models
      .filter((m: any) => m.status && m.status.value === "loaded")
      .map((m: any) => m.id || m.name || "Unknown Model");
  }

  // Helper to unload a model from a provider.
  async function unloadModel(baseUrl: string, modelId: string, apiKey?: string)
  {
    // Use /models/unload endpoint (under root path, not /v1)
    // baseUrl may include /v1 (OpenAI-compatible prefix), so we remove it first
    const baseUrlWithoutV1 = baseUrl.replace(/\/v1$/, "").replace(/\/*$/, "");
    const url = `${baseUrlWithoutV1}/models/unload`;
    const headers: Record<string, string> = { 
      "Content-Type": "application/json"
    };

    if (apiKey)
    {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelId }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`Failed to unload model ${modelId} from ${url}: ${response.statusText}`);
    }

    return await response.json();
  }

  // Register the /unload-model command
  pi.registerCommand("unload-model",
    {
      description: "Unload a model from a configured provider",
      handler: async (args, ctx) => {
        // 1. Select Provider
        const providers = providerDefs.map(p => p.id);
        const providerChoice = await ctx.ui.select("Select Provider to unload model from", providers);
        if (!providerChoice) {
          return;
        }

        const provider = providerDefs.find(p => p.id === providerChoice);
        if (!provider) {
          ctx.ui.notify(`Provider ${providerChoice} not found in configuration`, "error");
          return;
        }

        try {
          // 2. Show list of loaded models
          ctx.ui.notify(`Fetching loaded models from ${providerChoice}...`, "info");
          const loadedModels = await fetchLoadedModels(provider.baseUrl, provider.apiKey);

          if (!loadedModels || loadedModels.length === 0) {
            ctx.ui.notify(`No loaded models found for provider ${providerChoice}`, "info");
            return;
          }

          // 3. Select a model
          const modelToUnload = await ctx.ui.select(
            `Select model to unload from ${providerChoice}`,
            loadedModels
          );

          if (!modelToUnload) {
            return;
          }

          // 4. Unload
          ctx.ui.notify(`Unloading ${modelToUnload}...`, "info");
          const result = await unloadModel(provider.baseUrl, modelToUnload, provider.apiKey);

          if (result && result.success) {
            ctx.ui.notify(`Successfully unloaded ${modelToUnload}`, "info");
          } else {
            ctx.ui.notify(`Failed to unload ${modelToUnload}: ${JSON.stringify(result)}`, "error");
          }
        } catch (err: any) {
          ctx.ui.notify(`Error: ${err.message}`, "error");
        }
      }
    }
  );
}
