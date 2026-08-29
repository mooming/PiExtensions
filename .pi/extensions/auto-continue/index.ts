import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Auto-Continue Extension
 *
 * The coding agent sometimes halts with "Response was truncated before completion."
 * (assistant `stopReason === "length"`). This happens most often when the model hits a
 * provider-imposed output limit (`maxTokens`) rather than finishing its turn — a case the
 * SDK's own overflow recovery does NOT retry.
 *
 * This extension detects that halt and, on behalf of the user, submits the prompt below so
 * the agent resumes and completes its work. Truncation is treated as a continuation, never
 * as a request for user input.
 */

/**
 * Maximum number of automatic continuations before the extension stops.
 * A bound is required because `sendUserMessage()` re-enters `agent_settled`; without it a
 * model that perpetually truncates would loop forever.
 */
const DEFAULT_MAX_AUTO_CONTINUATIONS = 256;

/** Prompt submitted on behalf of the user when a response was truncated. */
const CONTINUE_PROMPT = "Continue if you hasn't completed your planned tasks yet.";

/** Config file location (all values optional; missing/invalid file falls back to defaults). */
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "auto-continue.json");

interface AutoContinueConfig {
  maxAutoContinuations: number;
}

/**
 * Return the `stopReason` of the most recent assistant message in the branch,
 * or `undefined` when there is none.
 */
function getLastAssistantStopReason(branch: SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") {
      continue;
    }
    if (entry.message.role === "assistant") {
      return entry.message.stopReason;
    }
  }
  return undefined;
}

/** Read optional overrides from the config file, defaulting otherwise. */
function readConfig(): AutoContinueConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return { maxAutoContinuations: DEFAULT_MAX_AUTO_CONTINUATIONS };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["maxAutoContinuations"] : undefined;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return { maxAutoContinuations: value };
    }
  } catch {
    // Invalid JSON: fall back to defaults.
  }

  return { maxAutoContinuations: DEFAULT_MAX_AUTO_CONTINUATIONS };
}

export default async function (pi: ExtensionAPI) {
  const { maxAutoContinuations } = readConfig();
  let autoContinuations = 0;

  pi.on("agent_settled", async (_event, ctx) => {
    const stopReason = getLastAssistantStopReason(ctx.sessionManager.getBranch());

    // Only a "length" stop means "Response was truncated before completion."
    if (stopReason !== "length") {
      return;
    }

    if (autoContinuations >= maxAutoContinuations) {
      ctx.ui.notify(
        `Auto-continue reached the limit (${maxAutoContinuations}); the task may be incomplete.`,
        "warning",
      );
      return;
    }

    autoContinuations += 1;
    if (autoContinuations === 1) {
      // Kick-off notice (only once, even across many continuations).
      ctx.ui.notify("Response was truncated — continuing automatically…", "info");
    } else if (autoContinuations % 10 === 0) {
      // Periodic progress so a long chain stays visible without spamming.
      ctx.ui.notify(`Continuing… (auto-continue ${autoContinuations}/${maxAutoContinuations})`, "info");
    }

    // Triggers a new turn that runs to completion; its own `agent_settled` continues the chain.
    await pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
  });
}
