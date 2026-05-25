import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  // Discover and register LM Studio provider at startup
  try {
    const modelsData = await fetchLMStudioModels();
    if (modelsData && modelsData.length > 0) {
      pi.registerProvider("lm-studio", {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LM_STUDIO", // Not typically required by LM Studio
        api: "openai-completions",
        models: modelsData.map(model => ({
          id: model.id,
          name: model.name || model.id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.context_window || 128000,
          maxTokens: 4096,
        })),
      });
    }
  } catch (error) {
    console.error("Failed to register LM Studio provider:", error);
  }

  // Register the /lmstudio command
  pi.registerCommand("lmstudio", {
    description: "Select an LM Studio model",
    handler: async (args, ctx) => {
      try {
        // Attempt to fetch available models from LM Studio API
        const models = await fetchLMStudioModels();
        
        if (!models || models.length === 0) {
          ctx.ui.notify("No LM Studio models found. Is LM Studio running?", "error");
          return;
        }

        // Show model selection UI
        const selectedLabel = await ctx.ui.select(
          "Select LM Studio Model:",
          models.map(model => model.name || model.id)
        );

        if (!selectedLabel) {
          ctx.ui.notify("No model selected", "info");
          return;
        }

        const selectedModel = models.find(m => (m.name || m.id) === selectedLabel);
        const modelId = selectedModel?.id || selectedLabel;
        
        // Find the registered model in pi's registry to set it programmatically
        const model = ctx.modelRegistry.find("lm-studio", modelId);
        if (model && await pi.setModel(model)) {
          ctx.ui.notify(`Switched to LM Studio model: ${modelId}`, "info");
        } else {
          ctx.ui.notify(`Failed to switch to model: ${modelId}. It may not be registered or an API key is missing.`, "error");
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        ctx.ui.notify(`Failed to fetch models: ${errorMessage}`, "error");
        console.error("LM Studio model selection error:", error);
      }
    },
  });

  /**
   * Fetch available models from LM Studio API
   */
  async function fetchLMStudioModels(): Promise<Array<{
    id: string;
    name?: string;
    context_window?: number;
  }>> {
    try {
      // LM Studio typically runs on port 1234
      const response = await fetch("http://localhost:1234/v1/models", {
        headers: {
          "Accept": "application/json"
        },
        timeout: 3000 // 3 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to connect to LM Studio API`);
      }

      const data = await response.json();
      
      // Handle different API response formats
      if (Array.isArray(data)) {
        return data;
      } else if (data.data && Array.isArray(data.data)) {
        // OpenAI-compatible format
        return data.data.map((model: any) => ({
          id: model.id,
          name: model.name || model.id,
          context_window: model.context_window || model.max_context_length
        }));
      } else {
        throw new Error("Unexpected API response format");
      }
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes('timeout') || error.message.includes('fetch'))) {
        throw new Error("LM Studio API not accessible. Is LM Studio running?");
      }
      throw error;
    }
  }

  // Listen for model changes to update UI
  pi.on("model_select", async (event, ctx) => {
    const { model } = event;
    
    // Show notification when LM Studio model is selected
    if (model.provider === "lm-studio") {
      ctx.ui.setStatus("lmstudio", `LM Studio: ${model.id}`);
    }
  });
}