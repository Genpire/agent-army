import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderRuntime, configuredModel } from "../ai/ai-providers.js";
import { type ProviderFailure, RunWatch, acrossRoute, fallbackLine, isRouteReady, routeRuntimes } from "../ai/routing.js";
import { TRANSCRIPTION } from "../chat/transcribe.js";
import type { QueryFn } from "../chat/pointer.js";
import type { AiProviderId, Config } from "../core/config.js";
import { engineUsd } from "../spending/prices.js";
import { SIZING_MODEL } from "../tasks/sizing.js";
import { talkSchema } from "./talk-prompt.js";
import type { TalkProviderId } from "./talk-types.js";

/**
 * Who writes an office conversation, and the one call it takes:
 *
 * - "gemini": the Gemini API with the Gemini CLI engine's key
 *   (config.engines.gemini.apiKey), as voice messages are transcribed
 *   (transcribe.ts): generateContent, its cheapest models in turn when the
 *   owner chose none, a timeout, and the API's JSON response mode. Priced from
 *   the tokens it reports at Google's list prices (prices.ts); a model with no
 *   price there counts at $0.
 * - "chat": the light work route's AI providers through the Agent SDK
 *   (routing.ts: the next one when one fails for its own reasons), as a repo
 *   task's size is estimated (sizing.ts): no tools, one turn, a JSON-schema
 *   answer, a tiny budget, an isolated folder and environment, on the
 *   cheapest model (its small tier on another provider) when the owner chose none.
 *
 * Neither call ever throws; errors carry the provider's message, never a key.
 */

/** Far more than a few short lines from the cheapest model cost; a runaway call stops here. */
export const TALK_BUDGET_USD = 0.05;
export const TALK_TIMEOUT_MS = 45_000;
/** Room for the JSON answer, and for a model's thinking where it thinks. */
const GEMINI_MAX_OUTPUT_TOKENS = 4096;

/** Gemini with its key, or the light work route: `runtimes` in order (routing.ts), `runtime` the first of them. */
export type TalkChoice = { id: "gemini"; key: string } | { id: "chat"; runtime: ProviderRuntime; runtimes: ProviderRuntime[] };

/** What each provider has: the Gemini key, a provider of the light work route connected and complete. */
export const talkAvailability = (config: Config): Record<TalkProviderId, boolean> => ({
  gemini: Boolean(config.engines.gemini.apiKey),
  chat: isRouteReady(config, "light"),
});

/** The provider the settings choose, if it is there: "auto" is Gemini when its key is connected, else the light work route. */
export function chooseTalkProvider(config: Config): TalkChoice | undefined {
  const wanted = config.office.talk.provider;
  const key = config.engines.gemini.apiKey;
  if (key && wanted !== "chat") return { id: "gemini", key };
  if (wanted === "gemini") return undefined;
  const route = routeRuntimes(config, "light");
  return route.ok ? { id: "chat", runtime: route.runtimes[0]!, runtimes: route.runtimes } : undefined;
}

export interface TalkCall {
  system: string;
  prompt: string;
  /** The people's ids: the only speakers the answer may have. */
  speakers: string[];
  /** The owner's model id; empty = the provider's default. */
  model: string;
}

export interface TalkOutcome {
  /** The answer: the structured object, or text holding its JSON. Absent when the call failed. */
  raw?: unknown;
  /** The model that answered (or was asked). */
  model: string;
  costUsd: number;
  tokens: number;
  error?: string;
  /** "chat" only: the provider that answered (or was asked last), whose spend the call is. */
  provider?: AiProviderId;
  /** "chat" only: what each provider asked spent of costUsd, when more than one was (a failed one's on its own cap). */
  providerCosts?: Record<string, number>;
}

export interface TalkCallOptions {
  /** Tests pass a fake for Gemini. */
  fetch?: typeof fetch;
  /** Tests pass a fake for the Agent SDK. */
  queryFn?: QueryFn;
  timeoutMs?: number;
}

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** Gemini's answer schema (its OpenAPI subset): the lines, each speaker one of the ids. */
function geminiSchema(speakers: string[]) {
  return {
    type: "OBJECT",
    properties: {
      lines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { speaker: { type: "STRING", format: "enum", enum: speakers }, text: { type: "STRING" } },
          required: ["speaker", "text"],
          propertyOrdering: ["speaker", "text"],
        },
      },
    },
    required: ["lines"],
  };
}

/** Gemini's own error message (never the key), one short line, and whether the next model may work. */
async function geminiFailure(res: Response): Promise<{ error: string; tryNextModel: boolean }> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown } };
  const message = typeof body.error?.message === "string" ? body.error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { error: `Gemini answered ${res.status}${message ? `: ${message}` : ""}`, tryNextModel: res.status === 404 || (res.status === 403 && /model/i.test(message)) };
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** One conversation from Gemini: the owner's model, else TRANSCRIPTION.geminiModels in turn while one is not available to the key. */
export async function geminiTalk(key: string, call: TalkCall, opts: TalkCallOptions = {}): Promise<TalkOutcome> {
  const fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const models = call.model ? [call.model.replace(/^models\//, "")] : [...TRANSCRIPTION.geminiModels];
  let error = `Gemini offers none of the models (${models.join(", ")}) to this key.`;
  for (const model of models) {
    try {
      const res = await fetchFn(`${TRANSCRIPTION.geminiBase}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: call.system }] },
          contents: [{ role: "user", parts: [{ text: call.prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: geminiSchema(call.speakers),
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TALK_TIMEOUT_MS),
      });
      if (!res.ok) {
        const failure = await geminiFailure(res);
        error = failure.error;
        if (failure.tryNextModel) continue;
        return { model, costUsd: 0, tokens: 0, error };
      }
      const data = (await res.json().catch(() => null)) as {
        candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[];
        promptFeedback?: { blockReason?: unknown };
        usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; cachedContentTokenCount?: unknown };
      } | null;
      const usage = data?.usageMetadata;
      const input = count(usage?.promptTokenCount);
      const output = count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount);
      const costUsd = engineUsd("gemini", model, { input, output, cached: count(usage?.cachedContentTokenCount) }) ?? 0;
      const spent = { model, costUsd, tokens: input + output };
      if (typeof data?.promptFeedback?.blockReason === "string") return { ...spent, error: `Gemini declined (${data.promptFeedback.blockReason}).` };
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return { ...spent, error: "Gemini answered without text." };
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text as string)
        .join("");
      return { ...spent, raw: text };
    } catch (err) {
      return { model, costUsd: 0, tokens: 0, error: timedOut(err) ? "Gemini took too long to answer." : "Gemini could not be reached." };
    }
  }
  return { model: models.at(-1) ?? "", costUsd: 0, tokens: 0, error };
}

/**
 * One conversation from the light work route (a runtime, or several in
 * order): while one fails for the provider's own reasons (rate limit, credit,
 * outage), the next is asked. Its cost and tokens are every attempt's.
 */
export async function chatTalk(route: ProviderRuntime | ProviderRuntime[], call: TalkCall, opts: TalkCallOptions = {}): Promise<TalkOutcome> {
  let costUsd = 0;
  let tokens = 0;
  // Each attempt's cost on the provider it ran on, so a failed one counts against its own cap.
  const providerCosts: Record<string, number> = {};
  const done = await acrossRoute(Array.isArray(route) ? route : [route], async (runtime) => {
    const attempt = await chatTalkOn(runtime, call, opts);
    costUsd += attempt.value.costUsd;
    tokens += attempt.value.tokens;
    if (attempt.value.costUsd > 0) providerCosts[runtime.provider] = (providerCosts[runtime.provider] ?? 0) + attempt.value.costUsd;
    return attempt;
  });
  for (const note of done.fallback) console.warn(`[office] ${fallbackLine(note, "took over")}`);
  return { ...done.value, costUsd, tokens, provider: done.runtime.provider, ...(done.fallback.length ? { providerCosts } : {}) };
}

/** One conversation from one provider, as estimateTaskSize asks for a size, and the provider failure it ended on, if any. */
async function chatTalkOn(runtime: ProviderRuntime, call: TalkCall, opts: TalkCallOptions): Promise<{ value: TalkOutcome; failure?: ProviderFailure }> {
  const queryFn: QueryFn = opts.queryFn ?? query;
  const watch = new RunWatch();
  // The owner's model, else the cheapest (also when the owner's is another provider's: the log says so once).
  const model = configuredModel(runtime, call.model, "The office's talk model") ?? runtime.model(SIZING_MODEL);
  const effort = runtime.effort("low");
  const asked = model ?? "";
  let outcome: TalkOutcome = { model: asked, costUsd: 0, tokens: 0, error: "no answer" };
  let tmp: string | undefined;
  let session: Awaited<ReturnType<ProviderRuntime["session"]>> | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? TALK_TIMEOUT_MS);
  try {
    tmp = await mkdtemp(join(tmpdir(), "office-talk-"));
    session = await runtime.session();
    const options: Options = {
      ...(model ? { model } : {}),
      systemPrompt: call.system,
      ...(effort ? { effort } : {}),
      ...(runtime.managedSettings ? { managedSettings: runtime.managedSettings } : {}),
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      // The recent work is untrusted text: never expand "@/path" references or other prompt syntax.
      verbatimPrompts: true,
      outputFormat: { type: "json_schema", schema: talkSchema(call.speakers) },
      maxTurns: 1,
      maxBudgetUsd: TALK_BUDGET_USD,
      cwd: tmp,
      abortController: abort,
      // Replaces the environment: the CLI sees none of the service's own secrets.
      env: { PATH: process.env.PATH ?? "", HOME: tmp, LANG: "C.UTF-8", ...session.env, CLAUDE_AGENT_SDK_CLIENT_APP: "agent-army-office/0.1.0" },
    };
    for await (const message of queryFn({ prompt: call.prompt, options })) {
      watch.feed(message);
      if (message.type !== "result") continue;
      const usage = Object.entries(message.modelUsage ?? {});
      const tokens = usage.reduce((sum, [, u]) => sum + count(u.inputTokens) + count(u.outputTokens) + count(u.cacheReadInputTokens) + count(u.cacheCreationInputTokens), 0);
      const spent = { model: usage[0]?.[0] ?? asked, costUsd: count(message.total_cost_usd), tokens };
      if (message.subtype === "success" && !message.is_error) outcome = { ...spent, raw: message.structured_output ?? message.result };
      else outcome = { ...spent, error: message.subtype === "success" ? "the call failed" : message.subtype };
    }
  } catch (err) {
    watch.thrown(err);
    outcome = { ...outcome, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    await session?.dispose();
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  if (abort.signal.aborted && outcome.raw === undefined) return { value: { ...outcome, error: "timed out" } };
  return { value: outcome, ...(outcome.raw === undefined && watch.failure ? { failure: watch.failure } : {}) };
}
