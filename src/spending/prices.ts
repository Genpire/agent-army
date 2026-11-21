import type { ModelPrice } from "../ai/ai-presets.js";
import { presetFor } from "../ai/ai-presets.js";
import { AI_PROVIDER_IDS, type AiProviderId, ENGINE_IDS, type EngineId } from "../core/config.js";

/**
 * Prices for sharing a cost between agents (attribution.ts) and for
 * estimating what Codex and Gemini CLI runs cost (they report tokens, never
 * dollars). USD per million tokens, list prices checked on 2026-11-21; they
 * change often. Claude Code reports Claude's own cost itself (per model, in
 * the result's modelUsage): these Claude prices only split that cost between
 * agents, or estimate it when no result came. An engine model missing here
 * has no dollar figure: its tokens are counted, and the console says so.
 */

/** Claude's list prices on Anthropic's API (cache writes at the 5-minute rate). */
export const CLAUDE_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/** Claude Code's model aliases, as the current models. */
const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
};

/**
 * A model id without what providers add around it: "[1m]", a region and
 * "anthropic." prefix (Bedrock), a version ("-v1:0") or date ("-20251001",
 * "@20251001", "-2025-08-07"), "-preview…" and "-latest".
 */
export function baseModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "")
    .replace(/[-:]v\d+(?::\d+)?$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-preview(?:-[\w-]+)?$/, "")
    .replace(/-latest$/, "");
}

/** Claude's list price for a model id or alias, or undefined. */
export function claudePrice(model: string): ModelPrice | undefined {
  const id = baseModelId(model);
  return CLAUDE_PRICES[CLAUDE_ALIASES[id] ?? id];
}

/** Prices by model id (a provider's modelPricing rows), then Claude's list prices. */
export function priceLookup(overrides: Record<string, ModelPrice> = {}): (model: string) => ModelPrice | undefined {
  const own = new Map(Object.entries(overrides).map(([id, p]) => [baseModelId(id), p]));
  return (model) => overrides[model] ?? own.get(baseModelId(model)) ?? claudePrice(model);
}

/** The prices a provider's queries are costed at: its modelPricing rows (ai-providers.ts), then Claude's list prices. */
export const runtimePrices = (runtime: { managedSettings?: { modelPricing?: { overrides?: Record<string, ModelPrice> } } }) =>
  priceLookup(runtime.managedSettings?.modelPricing?.overrides ?? {});

/** A coding agent CLI's model price: input, cached input and output, USD per million tokens. */
export interface EnginePrice {
  input: number;
  cachedInput: number;
  output: number;
}

/** OpenAI's (Codex) and Google's (Gemini CLI) list prices; Gemini Pro at the rates for prompts up to 200K tokens. */
export const ENGINE_PRICES: Readonly<Record<EngineId, Readonly<Record<string, EnginePrice>>>> = {
  codex: {
    "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
    "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
    "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5.1-codex-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
    "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
    "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
    "codex-mini": { input: 1.5, cachedInput: 0.375, output: 6 },
    "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 },
    o3: { input: 2, cachedInput: 0.5, output: 8 },
    "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
    "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  },
  gemini: {
    "gemini-3-pro": { input: 2, cachedInput: 0.2, output: 12 },
    "gemini-3-flash": { input: 0.5, cachedInput: 0.05, output: 3 },
    "gemini-2.5-pro": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gemini-2.5-flash": { input: 0.3, cachedInput: 0.03, output: 2.5 },
    "gemini-2.5-flash-lite": { input: 0.1, cachedInput: 0.01, output: 0.4 },
  },
};

/** The engine model's price, matched exactly (after baseModelId): a model not listed has none, never a near one's. */
export function enginePrice(engine: EngineId, model: string | undefined): EnginePrice | undefined {
  if (!model?.trim()) return undefined;
  return ENGINE_PRICES[engine][baseModelId(model)];
}

/** Tokens as the CLIs report them: input includes the cached part. */
export interface EngineTokens {
  input: number;
  output: number;
  cached?: number;
}

/** An engine run's estimated USD from its tokens, or undefined when its model has no price here. */
export function engineUsd(engine: EngineId, model: string | undefined, tokens: EngineTokens): number | undefined {
  const price = enginePrice(engine, model);
  if (!price) return undefined;
  const cached = Math.min(Math.max(0, tokens.cached ?? 0), Math.max(0, tokens.input));
  const fresh = Math.max(0, tokens.input) - cached;
  return (fresh * price.input + cached * price.cachedInput + Math.max(0, tokens.output) * price.output) / 1_000_000;
}

/** The ids a monthly provider cap can have: the AI providers chat and repo tasks run on, and the coding agent CLIs. */
export const BUDGET_PROVIDER_IDS = [...AI_PROVIDER_IDS, ...ENGINE_IDS] as const;
export type BudgetProviderId = (typeof BUDGET_PROVIDER_IDS)[number];

export const isEngineId = (id: string): id is EngineId => (ENGINE_IDS as readonly string[]).includes(id);
export const isBudgetProviderId = (id: string): id is BudgetProviderId => (BUDGET_PROVIDER_IDS as readonly string[]).includes(id);

/** The engines' names (as engines.ts ENGINES has them; that module is not imported here, it imports the worker). */
const ENGINE_LABELS: Record<EngineId, string> = { codex: "Codex", gemini: "Gemini CLI" };

/** "Claude", "Kimi", "Codex"… for messages; the id itself when unknown. */
export function providerLabel(id: string): string {
  if (isEngineId(id)) return ENGINE_LABELS[id];
  if ((AI_PROVIDER_IDS as readonly string[]).includes(id)) return presetFor(id as AiProviderId).short;
  return id;
}
