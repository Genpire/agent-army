/**
 * Who may use the bridge: one random token per provider session (each query's
 * ProviderRuntime.session()), standing for that connection's Gemini key and
 * tier models until dispose(). Claude Code gets only the token; the key stays
 * in this process. Tokens are 32 random bytes, looked up by their SHA-256 and
 * compared in constant time, and die with the session.
 *
 * Each session also remembers its tool calls' thought signatures: Gemini 3 and
 * later return an opaque signature on a step's first function call and refuse
 * the next turn (400) when it is not sent back with that call
 * (https://aistudio.google.com/docs/thought-signatures.md?generate-content=true).
 * Anthropic's format has nowhere to keep it, so the bridge keeps it here by
 * the tool_use id it made up, with Gemini's own call id.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ModelTier } from "../../core/config.js";

/** What a call remembers between turns. */
export interface RememberedCall {
  signature?: string;
  /** Gemini's own id for the call, sent back with its call and response. */
  callId?: string;
}

/** Calls kept per session, and the characters their signatures may take, before the oldest are forgotten. */
const MAX_CALLS = 4096;
const MAX_SIGNATURE_CHARS = 16 * 1024 * 1024;
/** One signature larger than this is not kept (a bad answer, not a signature). */
const MAX_ONE_SIGNATURE = 256 * 1024;

/** Tool calls by tool_use id, oldest first, bounded in count and size. */
export class ToolCallMemory {
  private readonly calls = new Map<string, RememberedCall>();
  private chars = 0;

  constructor(
    private readonly maxCalls = MAX_CALLS,
    private readonly maxChars = MAX_SIGNATURE_CHARS,
  ) {}

  remember(toolUseId: string, call: RememberedCall): void {
    const signature = call.signature && call.signature.length <= MAX_ONE_SIGNATURE ? call.signature : undefined;
    const callId = call.callId && call.callId.length <= 200 ? call.callId : undefined;
    if (!signature && !callId) return;
    this.forget(toolUseId);
    this.calls.set(toolUseId, { ...(signature ? { signature } : {}), ...(callId ? { callId } : {}) });
    this.chars += signature?.length ?? 0;
    for (const oldest of this.calls.keys()) {
      if (this.calls.size <= this.maxCalls && this.chars <= this.maxChars) break;
      this.forget(oldest);
    }
  }

  recall(toolUseId: string): RememberedCall | undefined {
    return this.calls.get(toolUseId);
  }

  get size(): number {
    return this.calls.size;
  }

  private forget(toolUseId: string): void {
    const old = this.calls.get(toolUseId);
    if (!old) return;
    this.chars -= old.signature?.length ?? 0;
    this.calls.delete(toolUseId);
  }
}

/**
 * What a session has asked of the bridge: its requests in flight now, and
 * all it has made. The token is in the environment of whatever the query
 * runs (a repo task's shell too, where the checkout's own code runs), so the
 * bridge limits both per session (server.ts), not only Claude Code's own use.
 */
export interface SessionLoad {
  inFlight: number;
  requests: number;
}

/** A session as the bridge serves it. */
export interface BridgeSession {
  readonly apiKey: string;
  /** The model each tier runs on: where a Claude model id or alias that reaches the bridge goes. */
  readonly models: Readonly<Record<ModelTier, string>>;
  readonly calls: ToolCallMemory;
  /** Hides the key and the token in text that leaves the bridge. */
  readonly redact: (text: string) => string;
  readonly load: SessionLoad;
}

const TOKEN_PREFIX = "gbr_";
const digestOf = (token: string): Buffer => createHash("sha256").update(token).digest();
/** Compared against when no session matches, so a miss takes as long as a hit. */
const NO_MATCH = digestOf("no session");

export class SessionRegistry {
  private readonly byDigest = new Map<string, { digest: Buffer; session: BridgeSession }>();

  /** A new session for this key and these models; close() ends it. */
  open(apiKey: string, models: Record<ModelTier, string>): { token: string; close(): void } {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const digest = digestOf(token);
    const needles = [apiKey, token].filter((s) => s.length >= 6);
    const session: BridgeSession = {
      apiKey,
      models: { ...models },
      calls: new ToolCallMemory(),
      redact: (text) => needles.reduce((acc, s) => acc.split(s).join("[redacted]"), text),
      load: { inFlight: 0, requests: 0 },
    };
    const key = digest.toString("hex");
    this.byDigest.set(key, { digest, session });
    return { token, close: () => void this.byDigest.delete(key) };
  }

  /** The session a token stands for, or undefined. */
  authenticate(token: string | undefined): BridgeSession | undefined {
    if (!token || token.length > 512) return undefined;
    const digest = digestOf(token);
    const entry = this.byDigest.get(digest.toString("hex"));
    const ok = timingSafeEqual(entry?.digest ?? NO_MATCH, digest);
    return entry && ok ? entry.session : undefined;
  }

  get size(): number {
    return this.byDigest.size;
  }
}
