/**
 * A team member's line of engines in repo tasks: its own engine, then its
 * fallback in order (AgentSpec.fallback), then Claude, the last resort.
 *
 * Which step works is decided when the task starts (engines.ts: connected,
 * installed, allowed to run here; budget.ts drops a CLI whose monthly cap is
 * used up) and again while it runs: a CLI run that fails for the engine's own
 * reasons (engineFailure: a rate limit, quota or credit used up, a rejected
 * key or account, the service down or overloaded, a model it does not have)
 * hands the assignment to the next step, and that engine stays down for the
 * rest of the task. A run that failed because of the work itself, timed out
 * on it, or was stopped by its agent's budget or the task never moves.
 */
import type { EngineId } from "../core/config.js";
import type { AgentSpec } from "../team/team.js";

/** One CLI of an agent's line, and the model it runs (empty = the engine's own). */
export interface LineStep {
  engine: EngineId;
  model: string;
}

/**
 * The CLI steps of an agent's line, in order: its own engine, then its
 * fallback up to Claude (nothing after Claude ever runs), each engine once.
 * `claude`: the line names Claude itself (so Claude's own model takes over).
 */
export function agentLine(agent: Pick<AgentSpec, "engine" | "engineModel"> & { fallback?: AgentSpec["fallback"] }): { steps: LineStep[]; claude: boolean } {
  const steps: LineStep[] = [];
  for (const s of [{ engine: agent.engine, model: agent.engineModel }, ...(agent.fallback ?? [])]) {
    if (s.engine === "claude") return { steps, claude: true };
    if (steps.some((x) => x.engine === s.engine)) continue;
    steps.push({ engine: s.engine, model: s.model.trim() });
  }
  return { steps, claude: false };
}

// ---------- Failures of the engine, not of the work ----------

export const ENGINE_FAILURE_KINDS = ["auth", "billing", "quota", "rate_limit", "model", "unavailable", "cannot_run"] as const;
export type EngineFailureKind = (typeof ENGINE_FAILURE_KINDS)[number];

/** Why a CLI could not do the work, for its own reasons. */
export interface EngineFailure {
  kind: EngineFailureKind;
  /** Short, in brackets after the engine's name: "rate limited". */
  reason: string;
  /** The CLI's own words, one line and capped, when it gave any. */
  detail?: string;
}

const REASONS: Record<EngineFailureKind, string> = {
  auth: "its key or account was refused",
  billing: "out of credit",
  quota: "its quota is used up",
  rate_limit: "rate limited",
  model: "it does not have the model",
  unavailable: "the service was unavailable",
  cannot_run: "it could not run here",
};

/** As a sentence after the engine's name, for the timeline: "Gemini CLI was rate limited". */
export const FAILURE_SAID: Record<EngineFailureKind, string> = {
  auth: "had its key or account refused",
  billing: "is out of credit",
  quota: "has used up its quota",
  rate_limit: "was rate limited",
  model: "does not have the model",
  unavailable: "was unavailable",
  cannot_run: "could not run here",
};

/**
 * How far a failure reaches: a refused key or no credit is the whole engine's
 * (every model on that key), a rate limit, quota, outage or missing model is
 * that model's (another model of the engine may still work), and a CLI that
 * could not run here is that line's (the checkout or the mode refused it).
 */
export function failureScope(kind: EngineFailureKind): "engine" | "model" | "line" {
  if (kind === "auth" || kind === "billing") return "engine";
  return kind === "cannot_run" ? "line" : "model";
}

export const engineFailureOf = (kind: EngineFailureKind, detail?: string): EngineFailure => ({ kind, reason: REASONS[kind], ...(detail ? { detail } : {}) });

/** The work's own trouble, whatever else the text says: never handed over. */
const WORK_OWN = /content_filter|context window|context_length_exceeded|maximum context length|max session turns/i;

/**
 * The texts of each kind, first match wins, as the CLIs and their APIs say
 * them: Gemini CLI reports "[API Error: <message> (Status: <status>)]" with
 * Google's message and status (RESOURCE_EXHAUSTED, UNAVAILABLE…), its error
 * classes (TerminalQuotaError…) and exit 41 for a failed sign-in; Codex says
 * "unexpected status 401 Unauthorized: <body>", "exceeded retry limit, last
 * status: 429 Too Many Requests", "Quota exceeded. Check your plan and billing
 * details.", "Selected model is at capacity…". HTTP statuses count only with
 * "status"/"code" before them or their reason phrase after, so a number in the
 * work's own words does not.
 */
const PATTERNS: [EngineFailureKind, RegExp][] = [
  [
    "auth",
    /API[_ ]key not valid|API_KEY_INVALID|API key expired|reported as leaked|invalid[_ ]api[_ ]key|incorrect API key|\bUNAUTHENTICATED\b|\bPERMISSION_DENIED\b|User location is not supported|FatalAuthenticationError|\bUnauthorizedError\b|(?:status|code)\W{0,4}40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|\bauth error\b/i,
  ],
  [
    "billing",
    /credit balance|out of credits?\b|insufficient[_ ](?:credits?|funds|balance)|spend (?:limit|cap)|payment required|(?:status|code)\W{0,4}402\b|enable billing|billing (?:account|is not (?:enabled|active)|not (?:enabled|active)|disabled)|billing_not_active|billing_hard_limit/i,
  ],
  ["quota", /exceeded your current quota|quota exceeded|insufficient_quota|usage limit|exhausted your|TerminalQuotaError|daily quota|\blimit: 0\b/i],
  ["rate_limit", /rate[ _-]?limit|too many requests|RESOURCE_EXHAUSTED|RetryableQuotaError|(?:status|code)\W{0,4}429\b/i],
  [
    "model",
    /model_not_found|ModelNotFoundError|\bmodel\b[^\n]{0,120}?(?:does not exist|not found|is not supported)|(?:status|code)\W{0,4}404\b|\b404 Not Found\b|\bNOT_FOUND\b|Requested entity was not found|unknown model|unsupported model/i,
  ],
  [
    "unavailable",
    /(?:status|code)\W{0,4}5(?:0[0-4]|29)\b|\b5(?:0[0-4]|29) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)|\bUNAVAILABLE\b|Status: INTERNAL\b|"status":\s*"INTERNAL"|DEADLINE_EXCEEDED|overloaded|at capacity|capacity (?:is )?unavailable|high demand|service unavailable|internal server error|exceeded retry limit|stream disconnected before completion|Error while reading the server response|Connection failed/i,
  ],
];

/** Gemini CLI's error classes (its result event's error.type). */
const GEMINI_ERROR_TYPES: Record<string, EngineFailureKind> = {
  FatalAuthenticationError: "auth",
  UnauthorizedError: "auth",
  TerminalQuotaError: "quota",
  RetryableQuotaError: "rate_limit",
  ModelNotFoundError: "model",
};

/** Gemini CLI's exit code for a failed sign-in (FatalAuthenticationError). */
const GEMINI_AUTH_EXIT = 41;

/** The line of `text` that matched, short. */
function detailOf(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l)) ?? text;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/** The kind a text names, or undefined (also when it names the work's own trouble). */
export function failureInText(text: string | undefined): EngineFailure | undefined {
  if (!text?.trim() || WORK_OWN.test(text)) return undefined;
  for (const [kind, re] of PATTERNS) if (re.test(text)) return engineFailureOf(kind, detailOf(text, re));
  return undefined;
}

/** What a failed run left to judge it by (all redacted). */
export interface CliOutcome {
  engine: EngineId;
  code: number | null;
  /** The CLI's own account of why the run failed (its failure event). */
  failure?: string;
  /** The error class it named with it (Gemini CLI's error.type). */
  failureType?: string;
  /** The last error it reported along the way (retries, warnings). */
  lastError?: string;
  /** The end of its stderr. */
  stderr?: string;
}

/** The placeholders the parsers keep when a CLI failed without saying why. */
const NO_WORDS = /^the (?:turn|run) failed$/;

/**
 * Whether a failed run failed for the engine's own reasons, from what the CLI
 * said: its failure event first (and its error class), and only when it gave
 * none, the last error it reported and its stderr. So a retry it got over
 * along the way never decides it. Undefined: the work's own failure, or one
 * the CLI did not explain.
 */
export function engineFailure(o: CliOutcome): EngineFailure | undefined {
  if (o.engine === "gemini" && o.code === GEMINI_AUTH_EXIT) return engineFailureOf("auth", o.failure ? detailOf(o.failure, /./) : undefined);
  const typed = o.failureType ? GEMINI_ERROR_TYPES[o.failureType] : undefined;
  if (typed && !WORK_OWN.test(o.failure ?? "")) return engineFailureOf(typed, o.failure ? detailOf(o.failure, /./) : undefined);
  if (o.failure && !NO_WORDS.test(o.failure.trim())) return failureInText(o.failure);
  return failureInText(o.lastError) ?? failureInText(o.stderr);
}
