/**
 * Which AI provider each kind of work runs on, in order (config.ai.routes),
 * and when a provider has failed in a way the next one can make up for.
 *
 * A route is an ordered list of providers. The first one that can run does:
 * connected and complete (providerProblem), and under its monthly cap (the
 * caller's capProblem). When a run on it fails for the provider's own reasons
 * (providerFailure: a rate limit, credit used up, a rejected key, the service
 * down or overloaded, a model it does not have, a request it would not take),
 * the caller may hand the work to the next one. Whether that is safe is the
 * caller's to decide: a chat reply only before any tool ran, a repo task from
 * the checkout as the failed run left it.
 *
 * A kind with no route of its own runs on config.ai.chatProvider (chat;
 * routines and light work follow the chat route) or config.ai.taskProvider
 * (tasks) alone, as before routes existed.
 */
import type { SDKAssistantMessageError, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AiProviderId, Config, WorkKind } from "../core/config.js";
import { type ProviderRuntime, buildRuntime, connectionOf, presetFor, providerProblem } from "./ai-providers.js";

/** The providers of a kind of work, in order, without repeats. Never empty. */
export function routeFor(config: Pick<Config, "ai">, kind: WorkKind): AiProviderId[] {
  const own = config.ai.routes?.[kind];
  if (own?.length) return [...new Set(own)];
  if (kind === "chat") return [config.ai.chatProvider];
  if (kind === "tasks") return [config.ai.taskProvider];
  // Routines and light work follow chat.
  return routeFor(config, "chat");
}

/** One provider of a route, for people: why it is skipped, when it is. */
export interface RouteStep {
  provider: AiProviderId;
  /** "Gemini", "Claude"… */
  name: string;
  /** Why it cannot run now (not connected, incomplete, its monthly cap used up); undefined = it can. */
  problem?: string;
}

export interface RouteOptions {
  /** Why a provider's monthly cap stops it now (budget.ts), or undefined. Default: no cap is checked. */
  capProblem?: (provider: AiProviderId) => string | undefined;
}

/** Each provider of the route with why it would be skipped now. */
export function routeSteps(config: Config, kind: WorkKind, opts: RouteOptions = {}): RouteStep[] {
  return routeFor(config, kind).map((provider) => {
    const problem = providerProblem(config, provider) ?? opts.capProblem?.(provider);
    return { provider, name: presetFor(provider).short, ...(problem ? { problem } : {}) };
  });
}

/** The route's providers that can run now, in order (at least one), or why none can. */
export type RouteResult =
  | { ok: true; runtimes: ProviderRuntime[]; skipped: RouteStep[] }
  | { ok: false; error: string; skipped: RouteStep[] };

export function routeRuntimes(config: Config, kind: WorkKind, opts: RouteOptions = {}): RouteResult {
  const steps = routeSteps(config, kind, opts);
  const usable = steps.filter((s) => !s.problem);
  const skipped = steps.filter((s) => s.problem);
  if (!usable.length) {
    // One provider: its own message, as before routes. Several: each one's.
    const error = skipped.length === 1 && skipped[0] ? (skipped[0].problem ?? "") : `No AI provider can run this. ${skipped.map((s) => `${s.name}: ${s.problem}`).join(" ")}`;
    return { ok: false, error, skipped };
  }
  return { ok: true, runtimes: usable.map((s) => buildRuntime(s.provider, connectionOf(config, s.provider)!)), skipped };
}

/** The route has at least one provider that can run (connected and complete; caps are not checked). */
export const isRouteReady = (config: Config, kind: WorkKind): boolean => routeSteps(config, kind).some((s) => !s.problem);

// ---------- Failures the next provider can make up for ----------

/** A failure of the provider itself, for people ("rate limited", "out of credit"). */
export interface ProviderFailure {
  /** The SDK's error class, or "http" when only a status or an error's text said so. */
  kind: SDKAssistantMessageError | "http";
  /** Short, for a status line: "rate limited". */
  reason: string;
}

/** The SDK's error classes that are the provider's, not the work's, with how to say them. */
const FALLBACK_ERRORS: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: "its key was rejected",
  oauth_org_not_allowed: "its account is not allowed",
  account_on_hold: "its account is on hold",
  verification_required: "its account needs verification",
  billing_error: "out of credit",
  rate_limit: "rate limited",
  overloaded: "overloaded",
  server_error: "a server error",
  model_not_found: "it does not have the model",
  cloud_credential_error: "its cloud credentials failed",
  // A request one provider will not take (a translated one most often) another may.
  invalid_request: "it refused the request",
};

/** HTTP statuses of a provider failing (not the work): auth, payment, not found, timeouts, rate limits, server errors. */
const FALLBACK_STATUS: Record<number, string> = {
  400: "it refused the request",
  401: "its key was rejected",
  402: "out of credit",
  403: "its key was refused",
  404: "it does not have the model",
  408: "timed out",
  429: "rate limited",
  500: "a server error",
  502: "a server error",
  503: "unavailable",
  504: "timed out",
  529: "overloaded",
};

/**
 * Whether this message says the provider failed (not the work): an assistant
 * message carrying one of FALLBACK_ERRORS, or an error result with a failing
 * HTTP status. Undefined for everything else, including the platform's own
 * stops (turn and budget limits) and the work's own errors.
 */
export function providerFailure(message: SDKMessage): ProviderFailure | undefined {
  if (message.type === "assistant" && message.error) {
    const reason = FALLBACK_ERRORS[message.error];
    return reason ? { kind: message.error, reason } : undefined;
  }
  if (message.type === "result" && message.is_error && (message.subtype === "success" || message.subtype === "error_during_execution")) {
    const status = "api_error_status" in message ? message.api_error_status : undefined;
    const reason = typeof status === "number" ? FALLBACK_STATUS[status] : undefined;
    if (reason) return { kind: "http", reason };
  }
  return undefined;
}

/** The text of a thrown error that names a provider failure ("API Error: 429 …", "Credit balance is too low"), or undefined. */
export function errorFailure(err: unknown): ProviderFailure | undefined {
  const text = err instanceof Error ? err.message : String(err);
  if (/credit balance is too low|insufficient[_ ]quota|billing/i.test(text)) return { kind: "billing_error", reason: "out of credit" };
  if (/RESOURCE_EXHAUSTED|rate[_ ]limit/i.test(text)) return { kind: "rate_limit", reason: "rate limited" };
  if (/overloaded/i.test(text)) return { kind: "overloaded", reason: "overloaded" };
  const status = text.match(/API Error:?\s*(\d{3})\b/i)?.[1];
  const reason = status ? FALLBACK_STATUS[Number(status)] : undefined;
  return reason ? { kind: "http", reason } : undefined;
}

/** What happened when work moved to the next provider, for the reply's record and the console. */
export interface FallbackNote {
  from: AiProviderId;
  to: AiProviderId;
  reason: string;
}

/** "Gemini failed (rate limited); Claude answered instead." */
export const fallbackLine = (n: FallbackNote, did = "answered"): string =>
  `${presetFor(n.from).short} failed (${n.reason}); ${presetFor(n.to).short} ${did} instead.`;
