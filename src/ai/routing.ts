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
 * A run does not have to end for that: Claude Code retries a failing request
 * itself (up to ten times, a request that hangs until a deadline included),
 * and says so in api_retry messages. When they show the provider in trouble
 * (RETRY_TROUBLE), a caller that can hand the work on stops the run instead
 * of waiting out the retries; with no next provider, the run waits as before.
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

/** No provider of the route can run, and the route is Claude alone: callers say how to connect Claude in their own words. */
export const onlyClaudeMissing = (skipped: RouteStep[]): boolean => skipped.length === 1 && skipped[0]?.provider === "anthropic";

/** The route has at least one provider that can run (connected and complete; caps are not checked). */
export const isRouteReady = (config: Config, kind: WorkKind): boolean => routeSteps(config, kind).some((s) => !s.problem);

/** A provider's problem without the sentence telling people to ask the owner (the owner reads these). */
export const ownerProblem = (problem: string): string => problem.replace(/ Ask the owner to .*$/, "");

/** One kind of work's route as the console shows it (publicView's ai.routes, POST /api/ai/routes). */
export interface RouteView {
  /** The owner set this kind's route (config.ai.routes); else it follows the chat or the task provider. */
  custom: boolean;
  /** Its providers in order, caps not checked; `problem` says why one cannot run. */
  steps: { provider: AiProviderId; name: string; ready: boolean; problem?: string }[];
}

export function routeView(config: Config, kind: WorkKind): RouteView {
  return {
    custom: Boolean(config.ai.routes?.[kind]?.length),
    steps: routeSteps(config, kind).map((s) => ({
      provider: s.provider,
      name: s.name,
      ready: !s.problem,
      ...(s.problem ? { problem: ownerProblem(s.problem) } : {}),
    })),
  };
}

/**
 * The route's providers that are connected and complete, in order, for the
 * spending caps (budget.ts): the work runs on the first of them whose cap is
 * not used up. All of them when none is (the work is refused for that, not
 * for a cap).
 */
export function routeProviders(config: Config, kind: WorkKind): AiProviderId[] {
  const steps = routeSteps(config, kind);
  const usable = steps.filter((s) => !s.problem);
  return (usable.length ? usable : steps).map((s) => s.provider);
}

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

// ---------- Watching a run, and calls that can move on ----------

/** Content blocks that are a tool being used. */
const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
/** The results a provider failure ends a run with; any other (a success, the platform's own limits) clears one seen before. */
const FAILED_RESULTS = new Set(["success", "error_during_execution"]);

/**
 * A tool call whose effect reaches past the run's own workspace (a repo
 * task's checkout), so running the work again could repeat it: an app's tool
 * that changes things, or a browser action on a page (a click, typing, a form).
 */
export type OutsideEffect = "app" | "browser";

/** The calls with effects outside a run, by kind: each tool once, in the order first called, with how many times. */
export type OutsideCalls = Record<OutsideEffect, { tool: string; count: number }[]>;

/** Calls of each kind a watch keeps, at most (each tool once): enough to name them. */
const OUTSIDE_MAX = 20;

/**
 * When Claude Code's retries of a failing request (system/api_retry
 * messages) say the provider is in trouble now, so that the route's next
 * provider should take over instead of the run waiting out the rest of them
 * (Claude Code retries up to ten times, each retry of a request that hangs
 * waiting until a deadline again):
 * - `count` retries in a row, with no answer from the provider between them;
 * - or one of the provider's own errors (TROUBLE_ERRORS) that asks for a wait
 *   of `longDelayMs` or more;
 * - or one after the run heard nothing for `quietMs`: the failed request hung
 *   that long, and its retry is likely to.
 * A rate limit that asks for a pause of `briefMs` or less does not count: too
 * many requests at once (the Gemini bridge answers a session so past its
 * requests in flight), a queue rather than an outage.
 */
export const RETRY_TROUBLE = { count: 2, longDelayMs: 30_000, quietMs: 3 * 60_000, briefMs: 2_000 } as const;

/** The retried errors that are the provider's own trouble. */
const TROUBLE_ERRORS = new Set<SDKAssistantMessageError>(["rate_limit", "overloaded", "server_error", "authentication_failed", "billing_error"]);

type ApiRetry = Extract<SDKMessage, { type: "system"; subtype: "api_retry" }>;

/** A retry as a failure to move on with: "overloaded, 2 retries", "rate limited, asked to wait 60 s", "a server error, no answer for 10 min". */
function retryFailure(m: ApiRetry, retries: number, why: "count" | "long" | "quiet", quietMs: number): ProviderFailure {
  const base = FALLBACK_ERRORS[m.error] ?? (m.error_status !== null ? FALLBACK_STATUS[m.error_status] : undefined) ?? "its requests kept failing";
  const detail =
    why === "quiet"
      ? `no answer for ${Math.max(1, Math.round(quietMs / 60_000))} min`
      : why === "long"
        ? `asked to wait ${Math.round(m.retry_delay_ms / 1000)} s`
        : `${retries} ${retries === 1 ? "retry" : "retries"}`;
  return { kind: m.error, reason: `${base}, ${detail}` };
}

/**
 * Follows one run's messages: whether a tool may have run (a tool use by the
 * main agent or by a subagent, so running the work again could repeat it),
 * the calls with effects outside the run (`effectOf` says which tools have
 * them), and the provider failure the run ended on, if it ended on one. A
 * call counts once the model asked for it: whether it ran cannot be told, so
 * it is taken to have. A subagent's failure goes back to the main agent,
 * which may carry on: only the main agent's and the result's count.
 *
 * It also follows Claude Code's retries (RETRY_TROUBLE): `retryTrouble` says
 * when they show the provider in trouble, and a caller that can hand the work
 * to the next provider stops the run (stopForRetries), which then ends on
 * that failure.
 */
export class RunWatch {
  toolRan = false;
  readonly outside: OutsideCalls = { app: [], browser: [] };
  private seen: ProviderFailure | undefined;
  private ended = false;
  /** Retries that count, since the provider last answered. */
  private retries = 0;
  private trouble: ProviderFailure | undefined;
  private stopped = false;
  private readonly now: () => number;
  private lastAt: number;

  constructor(
    private readonly effectOf?: (toolName: string) => OutsideEffect | undefined,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.lastAt = this.now();
  }

  /** Whether any call with an effect outside the run was made. */
  get reachedOutside(): boolean {
    return this.outside.app.length > 0 || this.outside.browser.length > 0;
  }

  private called(name: unknown): void {
    if (typeof name !== "string" || !this.effectOf) return;
    const kind = this.effectOf(name);
    if (!kind) return;
    const calls = this.outside[kind];
    const known = calls.find((c) => c.tool === name);
    if (known) known.count += 1;
    else if (calls.length < OUTSIDE_MAX) calls.push({ tool: name, count: 1 });
  }

  private retried(m: ApiRetry, quietMs: number): void {
    if (m.error === "rate_limit" && m.retry_delay_ms <= RETRY_TROUBLE.briefMs) return;
    this.retries += 1;
    const why =
      quietMs >= RETRY_TROUBLE.quietMs
        ? "quiet"
        : TROUBLE_ERRORS.has(m.error) && m.retry_delay_ms >= RETRY_TROUBLE.longDelayMs
          ? "long"
          : this.retries >= RETRY_TROUBLE.count
            ? "count"
            : undefined;
    if (why) this.trouble = retryFailure(m, this.retries, why, quietMs);
  }

  feed(message: SDKMessage): void {
    const at = this.now();
    const quietMs = at - this.lastAt;
    this.lastAt = at;
    if (message.type === "system" && message.subtype === "api_retry") {
      this.retried(message, quietMs);
      return;
    }
    // A whole answer (a block of it) from the provider: the requests before it went through in the end.
    if (message.type === "assistant" && !message.error) {
      this.retries = 0;
      this.trouble = undefined;
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_start" && TOOL_BLOCKS.has(event.content_block.type)) this.toolRan = true;
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (!TOOL_BLOCKS.has(block.type)) continue;
        this.toolRan = true;
        // A call's name is in the whole message (a stream's start event may come without it).
        if ("name" in block) this.called(block.name);
      }
      const failure = message.parent_tool_use_id === null ? providerFailure(message) : undefined;
      if (failure) this.seen = failure;
      return;
    }
    if (message.type === "result") {
      this.ended = true;
      if (this.stopped) return;
      const failure = providerFailure(message);
      if (failure) this.seen = failure;
      else if (!message.is_error || !FAILED_RESULTS.has(message.subtype)) this.seen = undefined;
    }
  }

  /** The query threw: before any result, its text may name a provider failure. */
  thrown(err: unknown): void {
    if (!this.ended) this.seen ??= errorFailure(err);
  }

  /** Claude Code's retries show the provider in trouble now (RETRY_TROUBLE): the failure to move on with, or undefined. */
  get retryTrouble(): ProviderFailure | undefined {
    return this.trouble;
  }

  /**
   * The caller stops the run over its retries (it aborts the query next): the
   * run ends on that failure, whatever the stop throws or the result says.
   * Undefined, and nothing changes, when the retries show no trouble.
   */
  stopForRetries(): ProviderFailure | undefined {
    if (!this.trouble) return undefined;
    this.seen = this.trouble;
    this.stopped = true;
    return this.trouble;
  }

  /** Whether the caller stopped the run over its retries. */
  get stoppedForRetries(): boolean {
    return this.stopped;
  }

  /** The provider failure the run ended on, or undefined. */
  get failure(): ProviderFailure | undefined {
    return this.seen;
  }
}

/** One attempt of a call on one provider: what it gave, and the provider failure it ended on, if any. */
export interface Attempt<T> {
  value: T;
  failure?: ProviderFailure;
}

/**
 * A call without side effects (a review, a search, a few lines of talk) on the
 * route's runtimes in order: while one fails for the provider's own reasons,
 * the next is asked. Returns the last attempt's value, the runtime that gave
 * it, and the fallbacks on the way.
 */
export async function acrossRoute<T>(
  runtimes: ProviderRuntime[],
  call: (runtime: ProviderRuntime) => Promise<Attempt<T>>,
): Promise<{ value: T; runtime: ProviderRuntime; fallback: FallbackNote[] }> {
  if (!runtimes.length) throw new Error("A route has at least one provider.");
  const fallback: FallbackNote[] = [];
  for (let i = 0; ; i += 1) {
    const runtime = runtimes[i]!;
    const attempt = await call(runtime);
    const next = runtimes[i + 1];
    if (!attempt.failure || !next) return { value: attempt.value, runtime, fallback };
    fallback.push({ from: runtime.provider, to: next.provider, reason: attempt.failure.reason });
  }
}
