/**
 * Errors as Claude Code expects them from the Anthropic Messages API:
 * `{type: "error", error: {type, message}}` with Anthropic's status codes.
 * The status matters beyond the message: Claude Code turns it into its error
 * classes (rate_limit, overloaded, authentication_failed…), retries the ones
 * that pass, and routing.ts hands the work to the next provider on them.
 *
 * Gemini answers `{error: {code, message, status, details}}`; its codes map
 * to Anthropic's as below. Two are not the plain status: a key Google does not
 * know comes back as 400 INVALID_ARGUMENT (reason API_KEY_INVALID), which is
 * an authentication error here, and 503 UNAVAILABLE is Anthropic's 529
 * overloaded_error, which is what Claude Code waits out and retries.
 *
 * No answer at all is one of two things: Gemini sent nothing for too long
 * (the bridge's own deadline, or the connection's), a 529 overloaded_error
 * (silenceError), or Gemini could not be reached (a refused, reset or
 * unresolved connection), a 500 api_error. Both name the network error's code
 * (ECONNRESET, UND_ERR_BODY_TIMEOUT) for the log, never what it said.
 */

/** Anthropic's error types (https://platform.claude.com/docs/en/api/errors). */
export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

/** An error to answer with: its HTTP status, Anthropic type, and a message that holds no secret. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    readonly type: AnthropicErrorType,
    message: string,
    /** Extra response headers (retry-after). */
    readonly headers: Record<string, string> = {},
    /** For the log only: the network error's code (ECONNRESET, UND_ERR_BODY_TIMEOUT), never anything it said. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const errorBody = (type: AnthropicErrorType, message: string) => ({ type: "error" as const, error: { type, message } });

/** Gemini's HTTP status → Anthropic's status and type. Other 4xx are invalid requests, other 5xx server errors. */
const STATUS_MAP: Record<number, [number, AnthropicErrorType]> = {
  400: [400, "invalid_request_error"],
  401: [401, "authentication_error"],
  402: [402, "billing_error"],
  403: [403, "permission_error"],
  404: [404, "not_found_error"],
  408: [504, "timeout_error"],
  413: [413, "request_too_large"],
  429: [429, "rate_limit_error"],
  500: [500, "api_error"],
  503: [529, "overloaded_error"],
  504: [504, "timeout_error"],
};

const MESSAGE_MAX = 500;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Gemini's error body parts, whatever shape it came in (a JSON object, a list of one, plain text). */
function errorParts(body: unknown): { message: string; status: string; reasons: string[]; retryDelay?: string } {
  const root = Array.isArray(body) ? body[0] : body;
  const error = isObject(root) && isObject(root.error) ? root.error : isObject(root) ? root : {};
  const message = typeof error.message === "string" ? error.message : typeof body === "string" ? body : "";
  // v1beta says it in `status` (RESOURCE_EXHAUSTED); newer bodies in a snake_case `code`.
  const status = typeof error.status === "string" ? error.status : typeof error.code === "string" ? error.code : "";
  const details = Array.isArray(error.details) ? error.details.filter(isObject) : [];
  const reasons = details.map((d) => d.reason).filter((r): r is string => typeof r === "string");
  const retryDelay = details.map((d) => d.retryDelay).find((r): r is string => typeof r === "string");
  return { message, status, reasons, ...(retryDelay ? { retryDelay } : {}) };
}

/** "33s" or "1.5s" (google.rpc.RetryInfo) → whole seconds for retry-after. */
function retryAfterSeconds(delay: string | undefined, header: string | null): string | undefined {
  if (header && /^\d{1,6}$/.test(header.trim())) return header.trim();
  const seconds = delay?.match(/^(\d{1,6}(?:\.\d+)?)s$/)?.[1];
  return seconds ? String(Math.max(1, Math.ceil(Number(seconds)))) : undefined;
}

/**
 * Gemini's error answer as the error to send back. `redact` hides the key and
 * the session token in case Google ever repeats them.
 */
export function geminiError(status: number, body: unknown, redact: (text: string) => string, retryAfterHeader: string | null = null): BridgeError {
  const { message, status: googleStatus, reasons, retryDelay } = errorParts(body);
  const text = message.replace(/\s+/g, " ").trim();
  const badKey = reasons.includes("API_KEY_INVALID") || /API key not valid|API_KEY_INVALID/i.test(text);
  const [code, type]: [number, AnthropicErrorType] = badKey
    ? [401, "authentication_error"]
    : (STATUS_MAP[status] ?? (status >= 500 ? [500, "api_error"] : [400, "invalid_request_error"]));
  const label = googleStatus ? ` (${googleStatus})` : "";
  const out = redact(`Gemini API error ${status}${label}: ${text || "no message"}`).slice(0, MESSAGE_MAX);
  const retryAfter = code === 429 || code === 529 ? retryAfterSeconds(retryDelay, retryAfterHeader) : undefined;
  return new BridgeError(code, type, out, retryAfter ? { "retry-after": retryAfter } : {});
}

/** A network error's code as Node and fetch give it (on the error, or on its cause): capitals, digits and underscores only. */
export function errorCode(err: unknown): string | undefined {
  let at: unknown = err;
  for (let depth = 0; depth < 3 && isObject(at); depth += 1) {
    if (typeof at.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(at.code)) return at.code;
    at = at.cause;
  }
  return undefined;
}

/** Codes of a wait that ran out (undici's headers and body timeouts, a socket's), not of a refused or broken connection. */
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);

/**
 * Gemini sent nothing for too long: 529 overloaded_error. That is what Claude
 * Code waits out and retries, and what it calls "overloaded" both as a status
 * (before a stream starts) and as a stream's error event (which has no status:
 * Claude Code reads overloaded_error from its text, and has no such reading
 * for timeout_error), so routing.ts sees the provider's trouble either way.
 */
export const silenceError = (message: string, code?: string): BridgeError => new BridgeError(529, "overloaded_error", message, {}, code);

/** Anything thrown while calling Gemini (no answer, a timeout, a bug) as an error to send back. */
export function toBridgeError(err: unknown, redact: (text: string) => string = (t) => t): BridgeError {
  if (err instanceof BridgeError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError") return silenceError("The Gemini API did not answer in time.");
  const code = errorCode(err);
  if (code && TIMEOUT_CODES.has(code)) return silenceError(`The Gemini API sent nothing for too long, and the connection gave up waiting (${code}).`, code);
  const text = err instanceof Error ? err.message : String(err);
  const out = redact(`Could not reach the Gemini API${code ? ` (${code})` : ""}: ${text}`).replace(/\s+/g, " ").slice(0, MESSAGE_MAX);
  return new BridgeError(500, "api_error", out, {}, code);
}
