import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import {
  buildThinkingLevelMap,
  probeThinkingCapability,
  type ProbeVerdict,
  type ThinkingLevelMap,
} from "./thinking-probe.ts";

/** Fallback context window (tokens) used when neither the server nor config provides one. */
const DEFAULT_CONTEXT_WINDOW = 262144;

/**
 * Per-request timeout for model discovery.
 * Node's fetch silently ignores a `timeout` init property (only `signal` is honoured), so a
 * stalled endpoint would otherwise block startup forever -- Pi awaits the extension factory.
 */
const DISCOVERY_TIMEOUT_MS = 5000;

/** One entry of models.json. */
type ProviderDef = {
  id: string; // provider identifier, used as Pi provider ID
  baseUrl: string; // base URL without trailing slash, e.g., "http://localhost:1234"
  apiKey?: string; // optional API key for the provider
  description?: string;
  // Optional maximum context length (tokens) for models from this provider.
  maxContextLength?: number;
};

/**
 * Generic Provider Selector Extension
 *
 * This extension reads a `models.json` file that defines multiple providers.
 * For each provider it queries the standard `/v1/models` endpoint to discover
 * available models and registers them with Pi. It also registers a command
 * `select-model` that lets the user pick a provider and then a model.
 *
 * Vision cannot come from `/v1/models` on most servers, so `/select-model` asks the user once and
 * remembers it in this extension's own `model-capabilities.json` -- never in `models.json`, which
 * Pi validates and would refuse to load. See README "Vision".
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
   * What has been established about one model -- by a human answer, or by probing the server.
   *
   * `thinkingLevelMap` is not optional decoration on `reasoning`. Pi sends its own level names as
   * `reasoning_effort` unless a map overrides them, and servers reject spellings they do not know:
   * the vLLM Qwen3.8 deployment answers HTTP 400 to `high`, which is Pi's configured default level
   * here. `reasoning: true` without a map therefore fails every request instead of merely adding
   * levels. The pair is stored together for that reason.
   */
  type StoredCapability = { vision?: boolean; reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap };
  /** providerId -> modelId -> confirmed capability. */
  type CapabilityStore = Record<string, Record<string, StoredCapability>>;

  /** Fallback level vocabularies, offered only when a probe cannot read the server. */
  const THINKING_PRESETS: { label: string; onLevels: string[] | null }[] = [
    { label: "OpenAI style - off, low, medium, high", onLevels: ["low", "medium", "high"] },
    { label: "vLLM/Qwen style - off, low, medium, xhigh", onLevels: ["low", "medium", "xhigh"] },
    { label: "Every level accepted (Ollama style)", onLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    { label: "No thinking - text only", onLevels: null },
  ];

  /** Compact human-readable summary of what is known about a model's thinking. */
  function thinkingSummary(cap: StoredCapability): string
  {
    if (cap.reasoning === undefined) return "unknown: Pi will offer only 'off'";
    if (!cap.reasoning) return "no";
    const values = Array.from(
      new Set(Object.values(cap.thinkingLevelMap ?? {}).filter((v) => typeof v === "string")),
    );
    return values.length > 0 ? `yes (${values.join("/")})` : "yes";
  }

  /** Pi level -> server value in Pi's level order, e.g. "off=none low=low high=xhigh". */
  function describeThinkingLevelMap(map: ThinkingLevelMap): string
  {
    return Object.entries(map).map(([level, value]) => `${level}=${value}`).join(" ");
  }

  /**
   * Measure one model against its own server and turn the answer into a capability declaration.
   *
   * Shared by `/select-model` and `/measure-thinking-levels` on purpose: a probe and its fallback
   * dialog that exist twice drift apart, and the failure mode here (a value the server rejects)
   * costs every later request.
   *
   * @returns the payload to store, or null when the person cancelled the fallback dialog.
   */
  async function measureThinkingCapability(input: {
    baseUrl: string;
    apiKey?: string;
    modelId: string;
  }, ctx: ExtensionCommandContext): Promise<StoredCapability | null>
  {
    ctx.ui.setWorkingMessage?.("Measuring thinking levels: a few short requests to this server...");
    let verdict: ProbeVerdict;
    try
    {
      verdict = await probeThinkingCapability({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
      });
    }
    finally
    {
      ctx.ui.setWorkingMessage?.(undefined);
    }

    if (verdict.status === "measured")
    {
      ctx.ui.notify(
        verdict.reasoning
          ? `Measured thinking levels: ${describeThinkingLevelMap(verdict.thinkingLevelMap!)}`
            + `${verdict.rejected.length ? `; server rejects ${verdict.rejected.join("/")}` : ""}`
            + `${verdict.thinkingByDefault ? "; server thinks unless told not to" : ""}`
          : "Measured: this server accepts no thinking level, so the model is registered without reasoning",
        "info",
      );
      return { reasoning: verdict.reasoning, thinkingLevelMap: verdict.thinkingLevelMap };
    }

    // Nothing is guessed in the server's place: a map full of values it rejects breaks every request,
    // so an unreadable server means handing the choice to a person.
    ctx.ui.notify(`Could not measure thinking levels: ${verdict.reason}`, "warning");
    const presetLabel = await ctx.ui.select(
      "Pick a thinking level vocabulary",
      THINKING_PRESETS.map(p => p.label),
    );
    if (!presetLabel) return null;
    const preset = THINKING_PRESETS.find(p => p.label === presetLabel);
    return preset?.onLevels
      ? { reasoning: true, thinkingLevelMap: buildThinkingLevelMap(preset.onLevels, "none") ?? undefined }
      : { reasoning: false, thinkingLevelMap: undefined };
  }

  /**
   * Where confirmed capabilities live: a file this extension owns, never models.json.
   *
   * models.json belongs to Pi, which validates it against ProviderConfigSchema and, on any
   * mismatch, loads *no* providers at all -- one invented key there blinds every provider, not just
   * the model it was about. And `/v1/models` answers the question for almost nobody: vLLM reports
   * `supported_modalities` for multimodal checkpoints only (most builds omit it entirely), and
   * llama.cpp, Ollama and LM Studio report nothing. So this is the one place left where "can this
   * model see?" can be recorded without touching Pi's namespace.
   *
   * Deleting the file costs nothing: every model falls back to what the server reports, then to
   * text-only, and `/select-model` asks again.
   */
  const capabilityStorePath = () => path.join(getAgentDir(), "model-capabilities.json");

  function loadCapabilities(): CapabilityStore
  {
    try
    {
      const parsed = JSON.parse(fs.readFileSync(capabilityStorePath(), "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as CapabilityStore;
    }
    catch
    {
      // Absent or corrupt is "nothing known yet", never an error worth interrupting a selection for.
      return {};
    }
  }

  /**
   * Remember one model's capability.
   *
   * Read-modify-write of a file only this extension writes, so no lock is needed; the read-back
   * guard means a write that silently does not land is reported rather than believed.
   *
   * @returns null when stored and read back, otherwise the reason it was not.
   */
  function saveCapability(providerId: string, modelId: string, cap: StoredCapability): string | null
  {
    const storePath = capabilityStorePath();
    try
    {
      const store = loadCapabilities();
      // Merge, never replace: the vision answer and the thinking answer are written by different
      // prompts, and overwriting the whole entry would silently lose whichever was saved first.
      store[providerId] = {
        ...store[providerId],
        [modelId]: { ...store[providerId]?.[modelId], ...cap },
      };
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
      // Confirm it landed, over exactly the keys this call owns. Comparing only one field would let a
      // write that dropped the thinking map, or the vision answer, be reported as saved.
      const stored = loadCapabilities()[providerId]?.[modelId] ?? {};
      return (Object.keys(cap) as (keyof StoredCapability)[]).every(
        (key) => JSON.stringify(stored[key]) === JSON.stringify(cap[key]),
      )
        ? null
        : `${storePath} was not updated`;
    }
    catch (e)
    {
      return `could not write ${storePath}: ${(e as Error).message}`;
    }
  }

  // Helper to fetch models from a generic provider using the OpenAI-compatible schema.
  // contextWindowOverride customizes max context length per provider; `declared` carries what the
  // user confirmed for this provider's models (see loadCapabilities).
  async function fetchProviderModels(
    baseUrl: string,
    apiKey?: string,
    contextWindowOverride?: number,
    declared: Record<string, StoredCapability> = {},
  )
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
      // Vision precedence: what the user confirmed > what this server reports > text only.
      // Pi reads images only when `input` contains "image" (pi-ai transform-messages.js replaces
      // image blocks with a placeholder otherwise), so a wrong answer silences the model quietly.
      const serverVision =
        Array.isArray(m.supported_modalities) && m.supported_modalities.includes("image");
      return {
        id: m.id,
        name: m.id,
        status: m.status?.value || "unloaded", // Track if model is loaded
        // `/v1/models` reports no reasoning flags on any server in practice, so what is known comes
        // from probing that server once (see thinking-probe.ts) and is remembered here. Unknown stays
        // false: an unregistered capability costs one extra question, a wrong one costs every request.
        reasoning: declared[m.id]?.reasoning ?? false,
        thinkingLevelMap: declared[m.id]?.thinkingLevelMap,
        vision: declared[m.id]?.vision ?? serverVision,
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
      const modelsData = await fetchProviderModels(
        provider.baseUrl,
        provider.apiKey,
        provider.maxContextLength,
        loadCapabilities()[provider.id] ?? {},
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
          models: modelsData.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            isLoaded: isModelLoaded(m.status), // Track if model is loaded for sorting
            reasoning: m.reasoning || false,
            // Passed through so Pi offers only the levels this server will accept; omitting it lets Pi
            // send its own names and get HTTP 400 from servers with a different vocabulary.
            thinkingLevelMap: m.thinkingLevelMap,
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
      console.warn(`Failed to register provider ${provider.id}: ${(err as Error).message}`);
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
          return `${isLoaded ? "[loaded] " : ""}${hasVision ? "[vision] " : ""}${m.reasoning ? "[thinking] " : ""}${m.name} (${m.id})`;
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
          const providerDef = providerDefs.find(p => p.id === providerChoice);
          const known = loadCapabilities()[providerChoice]?.[selected.id] ?? {};
          // Answers are collected and written once, and the provider is re-registered once, because
          // `reasoning` and `thinkingLevelMap` have to land in the same entry: the pair is the smallest
          // unit that cannot break a request.
          const pending: StoredCapability = {};

          // Most servers cannot report vision, so ask once and remember it (see loadCapabilities).
          // Pi silently drops image content for models registered text-only, which is exactly the
          // failure this prompt exists to prevent -- and it is answered here, not in models.json.
          const visionAnswer = await ctx.ui.select(
            `Accepts image input? ${
              known.vision === undefined ? "(unknown: Pi will omit images)"
              : known.vision ? "(currently yes)" : "(currently no)"}`,
            known.vision === true ? ["Yes", "No"] : ["No", "Yes"],
          );
          if (!visionAnswer) {
            return;
          }
          const vision = visionAnswer === "Yes";
          if (vision !== known.vision) {
            pending.vision = vision;
          }

          // Thinking is not in /v1/models either, but unlike vision it can be *measured*: an
          // OpenAI-compatible endpoint answers 200 or 400 for each `reasoning_effort` value. Measuring
          // is offered first because the answer is not a yes/no -- it is which levels this server accepts,
          // and getting that wrong fails every request rather than merely offering fewer choices.
          const thinkingAnswer = await ctx.ui.select(
            `Supports thinking? (currently ${thinkingSummary(known)})`,
            known.reasoning === undefined
              ? ["Measure against the server", "No - text only"]
              : ["Measure against the server", "Keep current answer", "No - text only"],
          );
          if (!thinkingAnswer) {
            return;
          }
          if (thinkingAnswer === "Measure against the server") {
            if (!providerDef)
            {
              ctx.ui.notify(`${providerChoice} is no longer configured - cannot measure.`, "error");
              return;
            }
            const measured = await measureThinkingCapability(
              { baseUrl: providerDef.baseUrl, apiKey: providerDef.apiKey, modelId: selected.id },
              ctx,
            );
            if (!measured) {
              return;
            }
            pending.reasoning = measured.reasoning;
            pending.thinkingLevelMap = measured.thinkingLevelMap;
          } else if (thinkingAnswer === "No - text only") {
            if (known.reasoning !== false) {
              pending.reasoning = false;
              pending.thinkingLevelMap = undefined;
            }
          }

          if (Object.keys(pending).length > 0) {
            const capError = saveCapability(providerChoice, selected.id, pending);
            if (capError) ctx.ui.notify(capError, "warning");
            // Re-register so the flags are in Pi's registry before the model is activated.
            pi.unregisterProvider(providerChoice);
            if (providerDef) await registerProvider(providerDef);
          }
          // The registry entry may have been replaced by that re-registration; work from the live one.
          const active = (await ctx.modelRegistry.getAvailable())
            .find(m => m.provider === providerChoice && m.id === selected.id) ?? selected;

          // Ask user whether to keep the auto‑detected context window or set a custom one
          const contextOption = await ctx.ui.select("Set max context length?", ["Auto", "Custom"]);
          if (contextOption === "Custom") {
            let input: string | undefined;
            if (ctx.ui.input) {
              input = await ctx.ui.input("Enter max context length (tokens)", "e.g. 200000");
            } else {
              const common = ["65536", "131072", "262144", "524288", "Custom"]; // common sizes
              const choice = await ctx.ui.select("Pick a size (or Custom)", common);
              if (!choice) return;
              if (choice === "Custom") {
                input = await ctx.ui.input("Enter max context length (tokens)", "e.g. 200000");
              } else {
                input = choice;
              }
            }
            const value = Number(input);
            if (!isNaN(value) && value > 0) {
              // Override the model's contextWindow for this session only
              active.contextWindow = value;
            } else {
              ctx.ui.notify("Invalid number entered – using auto context length.", "error");
            }
          }
          const applied = await pi.setModel(active);
          if (!applied)
          {
            ctx.ui.notify(`Could not activate ${active.id} from ${providerChoice} (no auth configured).`, "error");
            return;
          }
          // pi.setModel() is session-only in Pi >= 0.84.3, so save the default ourselves.
          const saveError = persistDefaultModel(providerChoice, active.id);
          ctx.ui.notify(
            saveError === null
              ? `Default model: ${providerChoice}/${active.id}`
              : `Switched to ${active.id} for this session only - ${saveError}`,
            saveError === null ? "info" : "warning",
          );
        } else {
          ctx.ui.notify(`Model selection failed.`, "error");
        }
      }
    }
  );

  /**
   * Re-measure the *current* model, without walking the model-selection prompts again.
   *
   * Needed because a stored map is a cache of one server deployment's behaviour, and that deployment
   * changes underneath it: a `--reasoning-parser` flag added, a checkpoint swapped, an Ollama upgrade.
   * `/select-model` can do this too, but it also re-asks about images and context length, which makes
   * the common case -- "the server changed" -- feel like re-selecting the model.
   */
  pi.registerCommand("measure-thinking-levels", {
    description: "Re-measure the current model's thinking levels against its server",
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!model)
      {
        ctx.ui.notify("No model is active, so there is nothing to measure.", "error");
        return;
      }
      const provider = providerDefs.find(p => p.id === model.provider);
      if (!provider)
      {
        ctx.ui.notify(`${model.provider} is not configured in models.json, so this extension cannot measure it.`, "error");
        return;
      }

      const measured = await measureThinkingCapability(
        { baseUrl: model.baseUrl ?? provider.baseUrl, apiKey: provider.apiKey, modelId: model.id },
        ctx,
      );
      if (!measured) {
        return;
      }
      const capError = saveCapability(provider.id, model.id, measured);
      if (capError) ctx.ui.notify(capError, "warning");

      // Re-register, then re-bind the session to the live registry entry. The session keeps the Model
      // object it was handed, so updating the registry alone does not change what the next request
      // sends -- this is the same reason /select-model re-reads the entry before activating it.
      pi.unregisterProvider(provider.id);
      await registerProvider(provider);
      const live = (await ctx.modelRegistry.getAvailable())
        .find(m => m.provider === provider.id && m.id === model.id);
      if (!live)
      {
        ctx.ui.notify(`${model.id} is no longer served by ${provider.id}; the measurement is saved but cannot be applied.`, "warning");
        return;
      }
      const applied = await pi.setModel(live);
      ctx.ui.notify(
        applied
          ? `Applied to ${provider.id}/${model.id} for this session.`
          : `Saved, but ${model.id} could not be re-activated (no auth configured).`,
        applied ? "info" : "warning",
      );
    },
  });

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
        input = await ctx.ui.input("Enter max context length (tokens)", "e.g. 200000");
      } else {
        // Fallback: present a list of common sizes
        const common = ["65536", "131072", "262144", "524288", "Custom"]; // 64k, 128k, 256k, 512k
        const choice = await ctx.ui.select("Pick a size (or Custom)", common);
        if (!choice) return;
        if (choice === "Custom") {
          input = await ctx.ui.input("Enter max context length (tokens)", "e.g. 200000");
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
