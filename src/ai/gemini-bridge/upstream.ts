/**
 * The bridge's calls to the Gemini API: always https://generativelanguage.googleapis.com
 * (nothing a request says can change the host), the key in the
 * x-goog-api-key header (never in the URL, which proxies and logs keep), no
 * redirects followed, and a deadline: the whole call for generateContent and
 * countTokens, the wait for the answer to start and then each gap between
 * chunks for a stream.
 *
 * Those deadlines are the only time limits. The calls go over node:https
 * (geminiFetch), not Node's global fetch: its undici client gives up on an
 * answer whose headers, or whose next bytes, take more than 300 s
 * (headersTimeout and bodyTimeout), and a Gemini model thinking that long
 * sends nothing until it is done. Each such call failed after five minutes
 * as "fetch failed", and Claude Code's retries failed the same way. The
 * `undici` package (which could give fetch a client with other limits) is not
 * a dependency, and Node's own copy cannot be imported.
 */
import { type FetchLike, pinnedFetch } from "../../integrations/apps/apps-net.js";
import { BridgeError, errorCode, geminiError, silenceError } from "./errors.js";

export const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";

export type GeminiMethod = "generateContent" | "streamGenerateContent" | "countTokens";

/** The method's URL for a model id resolveModel checked (letters, digits, dots, dashes, underscores). */
export const geminiUrl = (model: string, method: GeminiMethod): string =>
  `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(model)}:${method}${method === "streamGenerateContent" ? "?alt=sse" : ""}`;

export interface UpstreamOptions {
  fetch: FetchLike;
  /** A whole call, or the wait for a stream to start. */
  timeoutMs: number;
  /** The longest gap between a stream's chunks. */
  idleTimeoutMs: number;
}

/**
 * The fetch for Gemini calls: over node:https, which has no time limit of its
 * own (the bridge's deadlines stop a call), with the network guard's lookup
 * (apps-net.ts: the address checked is the one connected to; Google's are
 * public). It follows no redirect: one comes back as an error answer.
 */
export const geminiFetch = (): FetchLike => pinnedFetch();

/** "600 s", "1.5 s": for the deadlines' messages. */
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/** A deadline that can be pushed back (each chunk of a stream), on top of the caller's own abort. */
export class Deadline {
  readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;

  constructor(parent?: AbortSignal) {
    if (parent?.aborted) this.controller.abort(parent.reason);
    else parent?.addEventListener("abort", () => this.controller.abort(parent.reason), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Aborts with a TimeoutError saying `message` in `ms` unless pushed back again. */
  arm(ms: number, message = "The Gemini API did not answer in time."): void {
    this.clear();
    this.timer = setTimeout(() => this.controller.abort(new DOMException(message, "TimeoutError")), ms);
    this.timer.unref();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * POSTs to Gemini and returns the answer when it is a success; Gemini's
 * error answers become BridgeErrors (errors.ts). The deadline is armed for
 * `opts.timeoutMs` and left armed: the caller pushes it back or clears it.
 */
export async function callGemini(
  opts: UpstreamOptions,
  apiKey: string,
  model: string,
  method: GeminiMethod,
  body: unknown,
  deadline: Deadline,
  redact: (text: string) => string,
): Promise<Response> {
  // A stream's answer starts when Gemini has something to say; a whole answer comes at the end.
  deadline.arm(
    opts.timeoutMs,
    method === "streamGenerateContent"
      ? `The Gemini API sent nothing for ${seconds(opts.timeoutMs)}.`
      : `The Gemini API did not answer within ${seconds(opts.timeoutMs)}.`,
  );
  let res: Response;
  try {
    res = await opts.fetch(geminiUrl(model, method), {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      redirect: "error",
      signal: deadline.signal,
    });
  } catch (err) {
    throw timeoutOr(err, deadline, redact);
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a proxy's page): the text is the message.
  }
  deadline.clear();
  throw geminiError(res.status, parsed, redact, res.headers.get("retry-after"));
}

/** An abort by the deadline as Gemini's silence (errors.ts silenceError, with the deadline's words); anything else as it was. */
export function timeoutOr(err: unknown, deadline: Deadline, redact: (text: string) => string): unknown {
  const reason: unknown = deadline.signal.aborted ? deadline.signal.reason : undefined;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return silenceError(reason.message);
  if (err instanceof BridgeError || !(err instanceof Error)) return err;
  // A fetch error can quote what it was given: only its redacted text goes on, and its code (for the log).
  const code = errorCode(err);
  const out = new Error(redact(err.message), code ? { cause: { code } } : undefined);
  out.name = err.name;
  return out;
}

/** The longest event a stream may send (a chunk is one event); anything longer is not Gemini. */
const MAX_EVENT_CHARS = 32 * 1024 * 1024;

/**
 * The JSON of each `data:` event of a server-sent event stream, the deadline
 * pushed back by `idleTimeoutMs` at every chunk read.
 */
export async function* sseJson(body: ReadableStream<Uint8Array>, deadline: Deadline, idleTimeoutMs: number): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  const events = function* (final: boolean): Generator<unknown> {
    // A "\r" at the very end may be the first half of a "\r\n": kept until the next chunk says.
    const tail = !final && buffer.endsWith("\r") ? "\r" : "";
    buffer = (tail ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0 || (final && buffer.trim())) {
      const raw = at >= 0 ? buffer.slice(0, at) : buffer;
      buffer = at >= 0 ? buffer.slice(at + 2) : "";
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as unknown;
      } catch {
        throw new BridgeError(500, "api_error", "The Gemini API sent a stream event that is not JSON.");
      }
    }
    buffer += tail;
  };
  // A read waiting on a body that never ends must end with the deadline too, whatever fetch made the body.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  deadline.signal.addEventListener("abort", onAbort, { once: true });
  const silent = `The Gemini API sent nothing for ${seconds(idleTimeoutMs)} in the middle of its answer.`;
  try {
    for (;;) {
      deadline.arm(idleTimeoutMs, silent);
      const { done, value } = await reader.read();
      if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error("The Gemini stream was stopped.");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_CHARS) throw new BridgeError(500, "api_error", "The Gemini API sent a stream event too large to read.");
      yield* events(false);
    }
    buffer += decoder.decode();
    yield* events(true);
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
    deadline.clear();
    reader.releaseLock();
  }
}
