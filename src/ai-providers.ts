/**
 * Which AI provider a query runs on, and what the Claude Code process needs
 * for it: its environment (the provider's credentials and model mapping, never
 * another provider's key), the tools it cannot serve (WebSearch outside
 * Anthropic's API), managed settings (model prices, so budgets and costs are
 * right), and how agents' models and efforts map onto it.
 *
 * Every Agent SDK query the platform makes takes its provider from here:
 * Pointer's chat (scope "chat"), repo tasks (scope "task"), and the one-shot
 * calls (HR review, Skills Scout, task sizing: scope "chat").
 *
 * Placeholder: Anthropic only, as before. The providers work package adds the
 * presets (Bedrock, Vertex, Google Cloud, Foundry, DeepSeek, Qwen, Kimi, GLM,
 * custom), their connection tests and the console's routes.
 */
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { AiProviderId, Config } from "./config.js";
import type { Effort } from "./team.js";

export type ProviderScope = "chat" | "task";

export interface ProviderCapabilities {
  /** Claude Code's WebSearch (Anthropic's server-side search) works. */
  webSearch: boolean;
  /** PDFs can be sent as documents. */
  pdf: boolean;
  /** Images can be sent. */
  images: boolean;
}

export interface ProviderRuntime {
  provider: AiProviderId;
  /** For messages: "Claude", "Kimi (Moonshot)"… */
  label: string;
  /**
   * Environment entries for the Claude Code process, merged over the
   * caller's minimal environment (PATH, HOME, LANG…). Holds this provider's
   * credentials and model mapping; for a third-party provider it sets
   * ANTHROPIC_API_KEY to "" so the platform's Anthropic key never reaches it.
   */
  env: Record<string, string>;
  /** Tools the provider cannot serve, for Options.disallowedTools (e.g. WebSearch). */
  disallowedTools: string[];
  /** For Options.managedSettings: model prices (modelPricing), so costs and budgets are right. */
  managedSettings?: Settings;
  /** The model to pass for a configured model ("" = the provider's default, undefined in the options). */
  model(model: string): string | undefined;
  /** The effort to pass, as the provider accepts it (undefined = leave it out). */
  effort(effort: Effort): Effort | undefined;
  capabilities: ProviderCapabilities;
}

export type ProviderResult = { ok: true; runtime: ProviderRuntime } | { ok: false; error: string };

/** The provider for chat or repo tasks, with what its queries need; or why it cannot be used (not connected). */
export function providerRuntime(config: Config, scope: ProviderScope): ProviderResult {
  void scope;
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) return { ok: false, error: "Claude is not connected. Ask the owner to add the Anthropic API key on the admin page." };
  return {
    ok: true,
    runtime: {
      provider: "anthropic",
      label: "Claude",
      env: { ANTHROPIC_API_KEY: apiKey },
      disallowedTools: [],
      model: (model) => model || undefined,
      effort: (effort) => effort,
      capabilities: { webSearch: true, pdf: true, images: true },
    },
  };
}
