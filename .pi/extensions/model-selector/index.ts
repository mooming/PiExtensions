import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

/** Fallback context window (tokens) used when neither the server nor config provides one. */
const DEFAULT_CONTEXT_WINDOW = 262144;

/**
 * Per-request timeout for model discovery.
 * Node's fetch silently ignores a `timeout` init property (only `signal` is honoured), so a
 * stalled endpoint would otherwise block startup forever -- Pi awaits the extension factory.
 */
const DISCOVERY_TIMEOUT_MS = 5000;

/** A model's declared input modalities and reasoning support, as written in models.json. */
type ModelCapability = {
  /** Accepts image content. Drives Pi's `input: ["text", "image"]`. */
  vision?: boolean;
  /** Emits reasoning content, so Pi may request a thinking level. */
  reasoning?: boolean;
};

/** One entry of models.json: a provider plus optional capability declarations. */
type ProviderDef = {
  id: string; // provider identifier, used as Pi provider ID
  baseUrl: string; // base URL without trailing slash, e.g., "http://localhost:1234"
  apiKey?: string; // optional API key for the provider
  description?: string;
  // Optional maximum context length (tokens) for models from this provider.
  maxContextLength?: number;
  // Capability default for every model this provider serves. See resolveCapabilities().
  vision?: boolean;
  reasoning?: boolean;
  // Per-model exceptions, keyed by the exact model id the server reports.
  models?: Record<string, ModelCapability>;
};

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
  // Load provider definitions from models.json.
  // getAgentDir() is Pi's own resolver, so the location stays correct on every OS and
  // honours PI_CODING_AGENT_DIR (hardcoding ~/.pi/agent here would silently miss it).
  const pathsToTry = [
    path.join(getAgentDir(), "models.json"),
    path.resolve(process.cwd(), "models.json"),
  ];

  let providerDefs: ProviderDef[] = [];
  let foundPath: string | null = null;

  async function loadProviderDefs()
  {
    providerDefs = [];
    foundPath = null;

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
  }

  await loadProviderDefs();

  if (!foundPath)
  {
    console.error(`Failed to read models.json in ${pathsToTry.join(", ")}`);
    return;
  }

  // Map to store loading status for models: { [providerId]: { [modelId]: isLoaded } }
  const providerModelsMap: Record<string, Record<string, boolean>> = {};

  /**
   * Resolve what a model can actually ingest.
   *
   * Pi reads images only when `input` contains "image" (pi-ai transform-messages.js:
   * `downgradeUnsupportedImages` replaces image blocks with a placeholder otherwise), so a wrong
   * answer here is not cosmetic -- it silently blinds the model.
   *
   * `/v1/models` cannot be trusted as the sole source: vLLM reports `supported_modalities` for
   * multimodal checkpoints but omits the field entirely for most builds, and llama.cpp,
   * Ollama and LM Studio report nothing. Precedence, most specific first:
   *
   *   models.json `models["<id>"].vision`  >  provider-level `vision`  >  server-reported  >  false
   *
   * `??` (not `||`) so an explicit `false` can veto a server that over-reports.
   */
  function resolveCapabilities(model: any, provider: ProviderDef): Required<ModelCapability>
  {
    const declared: ModelCapability = provider.models?.[model?.id] ?? {};
    const serverVision =
      Array.isArray(model?.supported_modalities) && model.supported_modalities.includes("image");
    return {
      vision: declared.vision ?? provider.vision ?? serverVision,
      reasoning: declared.reasoning ?? provider.reasoning ?? false,
    };
  }

  // Helper to fetch models from a generic provider using the OpenAI-compatible schema.
  // Takes the whole provider definition: context length and capabilities are both per-provider config.
  async function fetchProviderModels(provider: ProviderDef)
  {
    const { baseUrl, apiKey, maxContextLength: contextWindowOverride } = provider;
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
      response = await fetch(primaryUrl, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!response.ok) throw new Error();
    } catch (e) {
      // Try fallback URL
      response = await fetch(fallbackUrl, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`Failed to fetch models from ${primaryUrl} and fallback ${fallbackUrl}`);
      }
    }

    const data = await response.json();

    // Expected OpenAI format: { data: [{ id: string, ... }], object: "list" }
    const models = data?.data ?? [];

    return models.map((m: any) => {
      const capabilities = resolveCapabilities(m, provider);
      return {
        id: m.id,
        name: m.id,
        status: m.status?.value || "unloaded", // Track if model is loaded
        reasoning: capabilities.reasoning,
        vision: capabilities.vision,
        // Resolve the effective context window. Precedence:
        //   server max_model_len  >  config override (maxContextLength)  >  DEFAULT_CONTEXT_WINDOW.
        // A vLLM/compatible server reports max_model_len, which is the source of truth.
        context_window: resolveContextWindow(m.max_model_len, contextWindowOverride),
      };
    });
  }

  /**
   * Resolve an effective context window in tokens.
   * Precedence: server-reported max_model_len > config override > DEFAULT_CONTEXT_WINDOW.
   */
  function resolveContextWindow(serverMaxModelLen: unknown, override: number | undefined): number {
    if (typeof serverMaxModelLen === 'number' && serverMaxModelLen > 0) return serverMaxModelLen;
    if (typeof override === 'number' && override > 0) return override;
    return DEFAULT_CONTEXT_WINDOW;
  }

  function isModelLoaded(status: any): boolean {
    return typeof status === 'string' ? status === 'loaded' : status?.value === 'loaded';
  }

  // Helper to register a single provider (used at start and after context‑length changes)
  async function registerProvider(provider: ProviderDef) {
    try {
      const modelsData = await fetchProviderModels(provider);

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
            isLoaded: isModelLoaded(m.status), // Track if model is loaded for sorting
            reasoning: m.reasoning || false,
            // What makes Pi send image content at all -- see resolveCapabilities().
            input: m.vision ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.context_window,
            maxTokens: m.context_window,
          })),
        });

        // Store loading status locally because pi.registerProvider might not preserve custom properties
        providerModelsMap[provider.id] = {};
        for (const m of modelsData) {
          providerModelsMap[provider.id][m.id] = isModelLoaded(m.status);
        }

        console.log(`Registered provider ${provider.id} with ${modelsData.length} models`);
      }
    } catch (err) {
      console.warn(`Failed to register provider ${provider.id}: ${err.message}`);
    }
  }

  // Register each provider initially
  for (const provider of providerDefs) {
    await registerProvider(provider);
  }

  /**
   * Persist a selection as Pi's global default model.
   *
   * Since Pi 0.84.3, setModel() is session-scoped unless called with `{ persist: true }`,
   * and ExtensionAPI.setModel() exposes no options at all -- so an extension can never ask
   * Pi to save the default. We therefore write the very two keys Pi itself would write
   * (settings-manager.ts setDefaultModelAndProvider), letting Pi resolve the model at startup.
   *
   * Pi guards this file with `proper-lockfile`, which an extension cannot resolve, so instead
   * of locking we re-read immediately before writing and touch only those two keys. That keeps
   * the stale window tiny and preserves every key we do not own.
   *
   * Failures are returned rather than logged: Pi leaves stdout/stderr unguarded in interactive
   * mode, so console output here would draw over the TUI (the reason commit 5a33a9f landed).
   *
   * @returns null when the default is saved and reads back, otherwise the reason it was not.
   */
  function persistDefaultModel(providerId: string, modelId: string): string | null
  {
    const settingsPath = path.join(getAgentDir(), "settings.json");
    try
    {
      let settings: Record<string, unknown>;
      try
      {
        const raw = fs.readFileSync(settingsPath, "utf-8");
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        {
          throw new Error("not a JSON object");
        }
        settings = parsed as Record<string, unknown>;
      }
      catch (e)
      {
        // Absent file is normal on a fresh install; anything else must not be clobbered.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        settings = {};
      }

      settings.defaultProvider = providerId;
      settings.defaultModel = modelId;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

      // Confirm it landed: a read-only or concurrently rewritten file must not be reported as saved.
      const readBack = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return readBack?.defaultProvider === providerId && readBack?.defaultModel === modelId
        ? null
        : `${settingsPath} was not updated`;
    }
    catch (e)
    {
      return `could not write ${settingsPath}: ${(e as Error).message}`;
    }
  }

  // Register a generic command to select a model from any registered provider
  pi.registerCommand("select-model",
    {
      description: "Select a model from any configured provider",
      handler: async (args, ctx) => {
        // Refresh provider definitions and registrations
        const oldProviderIds = providerDefs.map(p => p.id);
        await loadProviderDefs();
        
        // Unregister providers that are no longer in the new providerDefs
        const newProviderIds = providerDefs.map(p => p.id);
        for (const id of oldProviderIds) {
          if (!newProviderIds.includes(id)) {
            pi.unregisterProvider(id);
          }
        }

        // Re-register (or update) all providers in the new providerDefs
        for (const provider of providerDefs) {
          await registerProvider(provider);
        }

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
        available.sort((a, b) => {
          const aLoaded = providerModelsMap[providerChoice]?.[a.id] ?? false;
          const bLoaded = providerModelsMap[providerChoice]?.[b.id] ?? false;
          return (bLoaded ? 1 : 0) - (aLoaded ? 1 : 0);
        });

        // One label builder, used for both the list and the lookup back -- re-parsing tags
        // separately is how a new tag would silently break selection.
        const modelLabelOf = (m: any) => {
          const isLoaded = providerModelsMap[providerChoice]?.[m.id] ?? false;
          const hasVision = Array.isArray(m.input) && m.input.includes("image");
          return `${isLoaded ? "[loaded] " : ""}${hasVision ? "[vision] " : ""}${m.name} (${m.id})`;
        };

        const modelOptions = available.map(modelLabelOf);

        const modelLabel = await ctx.ui.select(
          `Select Model from ${providerChoice}`,
          modelOptions
        );
        if (!modelLabel) {
          return;
        }

        const selected = available.find(m => modelLabelOf(m) === modelLabel);
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
          const applied = await pi.setModel(selected);
          if (!applied)
          {
            ctx.ui.notify(`Could not activate ${selected.id} from ${providerChoice} (no auth configured).`, "error");
            return;
          }
          // pi.setModel() is session-only in Pi >= 0.84.3, so save the default ourselves.
          const saveError = persistDefaultModel(providerChoice, selected.id);
          ctx.ui.notify(
            saveError === null
              ? `Default model: ${providerChoice}/${selected.id}`
              : `Switched to ${selected.id} for this session only - ${saveError}`,
            saveError === null ? "info" : "warning",
          );
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
          if (provider) await registerProvider(provider);
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
