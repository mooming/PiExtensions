/**
 * Thinking-capability discovery for OpenAI-compatible servers.
 *
 * Why this exists: Pi only offers a thinking level when the model is registered with
 * `reasoning: true` (`getSupportedThinkingLevels` returns `["off"]` for anything else), and it only
 * sends a thinking control field when `reasoning` is true. `GET /v1/models` carries no reasoning
 * information on any server in practice -- vLLM reports `max_model_len` only, Ollama reports
 * identifiers only -- so the capability has to be established another way.
 *
 * The way that is verifiable is asking the server: an OpenAI-compatible endpoint either accepts a
 * `reasoning_effort` value or rejects it, and a model either emits a reasoning field or does not.
 * Both are observable with a tiny request. Anything inferred without that observation (model-name
 * patterns, hardcoded `false`) is a guess that silently mis-registers the model.
 *
 * Per-server vocabulary matters. The vLLM Qwen3.8 deployment measured during development accepts
 * `none`, `low`, `medium`, `xhigh` and answers HTTP 400 for `minimal`, `high` and `max`, while
 * Ollama accepts all seven. A model registered `reasoning: true` *without* a `thinkingLevelMap`
 * therefore makes Pi send its own level names, and every request carrying `high` fails outright.
 * The map is not a refinement of `reasoning: true`; shipping them together is the minimum correct
 * unit.
 */

/** Pi's thinking levels, in ascending order of effort. `off` means "no thinking". */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Levels that mean "think", i.e. everything Pi can name except `off`. */
const ON_LEVELS = THINKING_LEVELS.filter((level) => level !== "off");

/** A value Pi writes into `reasoning_effort`; `null` marks the level unsupported by this server. */
export type ThinkingLevelValue = string | number | boolean | null;

/** Maps Pi level -> server value, exactly Pi's `thinkingLevelMap` shape (`model-config.js`). */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, ThinkingLevelValue>>;

/** Every vocabulary value probed: Pi's names plus the `none` most servers use for `off`. */
export const PROBED_VALUES = ["none", ...ON_LEVELS];

/** Requests a full probe sends: one baseline plus one per candidate value. */
export const PROBE_REQUEST_COUNT = PROBED_VALUES.length + 1;

/** What one probe request told us. */
export type ProbeObservation = {
  /** `reasoning_effort` sent, or undefined for the baseline request. */
  sent: string | undefined;
  httpStatus: number;
  /** Characters of reasoning content the server returned (0 when it returned none). */
  thinkingChars: number;
  /** Server error text, kept verbatim for the fallback prompt and the notification. */
  errorText?: string;
};

export type ProbeVerdict =
  | {
      status: "measured";
      reasoning: boolean;
      /** Absent when `reasoning` is false. */
      thinkingLevelMap?: ThinkingLevelMap;
      /** Values the server accepted, in probe order -- the evidence behind the map. */
      accepted: string[];
      rejected: string[];
      /** Whether the server thought without being asked, i.e. its default. */
      thinkingByDefault: boolean;
    }
  | { status: "inconclusive"; reason: string; accepted: string[]; rejected: string[] };

/**
 * Build Pi's `thinkingLevelMap` from the values one server accepted.
 *
 * Each Pi level takes its own name when the server accepts that spelling, because that is the
 * only mapping that cannot misrepresent what the user chose. When it does not, the level rounds
 * **up** to the nearest accepted value: Pi's own `clampThinkingLevel` searches upward first, so
 * rounding up keeps the extension and Pi in agreement, and it errs towards thinking more rather
 * than silently doing less than the user asked. If nothing is higher, the highest accepted value
 * is used.
 *
 * `off` is only claimed when the server accepts a dedicated value for it. Guessing `off` would
 * register a level that does not stop anything, which is the exact defect this module replaces.
 *
 * @param onLevels Accepted values among Pi's non-`off` level names, any order.
 * @param offValue The accepted value that disables thinking, or null when none was found.
 * @returns null when no `on` level is accepted -- there is then no thinking to configure.
 */
export function buildThinkingLevelMap(
  onLevels: readonly string[],
  offValue: string | null,
): ThinkingLevelMap | null
{
  const acceptedOn = ON_LEVELS.filter((level) => onLevels.includes(level));
  if (acceptedOn.length === 0) return null;

  const map: ThinkingLevelMap = { off: offValue };
  for (let index = 0; index < ON_LEVELS.length; index++) {
    const level = ON_LEVELS[index];
    if (acceptedOn.includes(level)) {
      map[level] = level;
      continue;
    }
    const higher = acceptedOn.find((value) => ON_LEVELS.indexOf(value) > index);
    map[level] = higher ?? acceptedOn[acceptedOn.length - 1];
  }
  return map;
}

/**
 * Turn probe observations into a capability declaration.
 *
 * @param observations One per probed value plus the baseline (`sent: undefined`).
 */
export function classifyProbe(observations: readonly ProbeObservation[]): ProbeVerdict
{
  const baseline = observations.find((entry) => entry.sent === undefined);
  if (!baseline) return { status: "inconclusive", reason: "no baseline observation", accepted: [], rejected: [] };
  if (baseline.httpStatus < 200 || baseline.httpStatus >= 300)
  {
    // The endpoint would not answer a plain request, so a 400 later proves nothing about vocabulary.
    return {
      status: "inconclusive",
      reason: `baseline request failed (HTTP ${baseline.httpStatus}${baseline.errorText ? `: ${baseline.errorText}` : ""})`,
      accepted: [],
      rejected: [],
    };
  }

  const probes = observations.filter((entry) => entry.sent !== undefined);
  const accepted = probes.filter((entry) => entry.httpStatus >= 200 && entry.httpStatus < 300).map((entry) => entry.sent as string);
  const rejected = probes.filter((entry) => entry.httpStatus === 400).map((entry) => entry.sent as string);

  if (accepted.length === 0 && rejected.length === 0)
  {
    return {
      status: "inconclusive",
      reason: "the server answered neither accept nor reject for any value",
      accepted,
      rejected,
    };
  }
  if (accepted.length === 0)
  {
    // Rejecting the whole vocabulary is implausible for a working endpoint; more likely the body was
    // wrong for this server (a required field we did not send). Do not build a map on that.
    return {
      status: "inconclusive",
      reason: `every value was rejected (first response: ${rejected.length ? probes.find((entry) => entry.httpStatus === 400)?.errorText ?? "HTTP 400" : "unknown"})`,
      accepted,
      rejected,
    };
  }

  const offValue = accepted.includes("none") ? "none" : null;
  const onLevels = accepted.filter((value) => value !== "none");
  const thinkingLevelMap = buildThinkingLevelMap(onLevels, offValue);

  if (!thinkingLevelMap)
  {
    // Only an off-value was accepted: nothing can switch thinking on, so the model is registered
    // without reasoning -- and the reason is reported rather than hidden.
    return {
      status: "measured",
      reasoning: false,
      accepted,
      rejected,
      thinkingByDefault: baseline.thinkingChars > 0,
    };
  }

  return {
    status: "measured",
    reasoning: true,
    thinkingLevelMap,
    accepted,
    rejected,
    thinkingByDefault: baseline.thinkingChars > 0,
  };
}

/**
 * Chat-completions URL for a provider base URL, mirroring how the model list endpoint is built:
 * a base already ending in `/v1` is used as-is, otherwise `/v1` is appended.
 */
export function chatCompletionsUrl(baseUrl: string): string
{
  const base = baseUrl.replace(/\/*$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** Content of a chat-completions response, reduced to what the probe needs. */
export type ChatProbeResponse = { httpStatus: number; thinkingChars: number; errorText?: string };

/**
 * Send one minimal chat request, optionally with `reasoning_effort`, and report what came back.
 *
 * `max_tokens` is deliberately tiny: the probe asks only whether the server tolerates the value, and
 * a reasoning phase shares that budget with the answer, so the request stays cheap and fast.
 *
 * Reasoning content is read from every field name in circulation because the ecosystem never agreed
 * on one: `reasoning_content` (llama.cpp, vLLM's default), `reasoning` (vLLM with an alternate
 * parser -- what this deployment uses), `reasoning_text`.
 */
export async function requestReasoningProbe(input: {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}): Promise<ChatProbeResponse>
{
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (input.apiKey) headers["Authorization"] = `Bearer ${input.apiKey}`;

  const body: Record<string, unknown> = {
    model: input.modelId,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    max_tokens: 16,
  };
  if (input.reasoningEffort !== undefined) body.reasoning_effort = input.reasoningEffort;

  const response = await fetch(chatCompletionsUrl(input.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 30000),
  });
  const text = await response.text();

  let thinkingChars = 0;
  let errorText: string | undefined;
  try
  {
    const parsed = JSON.parse(text);
    const message = parsed?.choices?.[0]?.message ?? parsed?.choices?.[0]?.delta ?? {};
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"])
    {
      if (typeof message[field] === "string" && message[field].length > 0)
      {
        thinkingChars = message[field].length;
        break;
      }
    }
    if (typeof parsed?.error?.message === "string") errorText = String(parsed.error.message).slice(0, 200);
  }
  catch
  {
    errorText = text.slice(0, 200);
  }
  return { httpStatus: response.status, thinkingChars, errorText };
}

/**
 * Probe every candidate value against one model.
 *
 * Returns an inconclusive verdict rather than a wrong one: a server that does not answer the
 * baseline, or that never answers 200/400, tells us nothing, and the caller then falls back to a
 * human choice. A guessed map is worse than no map, because `reasoning: true` with the wrong values
 * fails every request instead of merely offering fewer levels.
 */
export async function probeThinkingCapability(input: {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  timeoutMs?: number;
  /** Values to try; `undefined` (baseline) is always sent first. Exposed for tests. */
  candidates?: readonly string[];
  /** Injectable transport so the classification can be exercised without a server. */
  send?: (reasoningEffort: string | undefined) => Promise<ChatProbeResponse>;
}): Promise<ProbeVerdict>
{
  const send =
    input.send ??
    ((reasoningEffort: string | undefined) =>
      requestReasoningProbe({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
        reasoningEffort,
        timeoutMs: input.timeoutMs,
      }));
  const candidates = input.candidates ?? PROBED_VALUES;

  const observations: ProbeObservation[] = [];
  for (const candidate of [undefined, ...candidates])
  {
    let response: ChatProbeResponse;
    try
    {
      response = await send(candidate);
    }
    catch (e)
    {
      return {
        status: "inconclusive",
        reason: `probe request for ${candidate ?? "<baseline>"} could not be sent: ${(e as Error).message}`,
        accepted: [],
        rejected: [],
      };
    }
    observations.push({ sent: candidate, httpStatus: response.httpStatus, thinkingChars: response.thinkingChars, errorText: response.errorText });
    // A dead endpoint makes the rest pointless and slow.
    if (candidate === undefined && (response.httpStatus === 401 || response.httpStatus === 403 || response.httpStatus >= 500))
    {
      return {
        status: "inconclusive",
        reason: `server refused the probe (HTTP ${response.httpStatus}${response.errorText ? `: ${response.errorText}` : ""})`,
        accepted: [],
        rejected: [],
      };
    }
  }
  return classifyProbe(observations);
}
