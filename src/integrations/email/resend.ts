/**
 * Sending through Resend's API (https://resend.com/docs/api-reference):
 * POST /emails with the API key as a Bearer token, and GET /domains to check
 * a key before it is saved. Resend refuses requests without a User-Agent.
 * The key is only ever sent to api.resend.com; errors never contain it.
 */
import { randomUUID } from "node:crypto";

export const RESEND_API_URL = "https://api.resend.com";
const USER_AGENT = "agent-army-pointer";
const TIMEOUT_MS = 20_000;

/** Resend keys start with "re_". */
export const looksLikeResendKey = (key: string) => /^re_[A-Za-z0-9_-]{8,200}$/.test(key);

interface ResendReply {
  status: number;
  data: Record<string, unknown>;
}

async function call(fetchFn: typeof fetch, apiKey: string, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ResendReply> {
  const res = await fetchFn(`${RESEND_API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, data: typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {} };
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const KEY_REFUSED = "Resend refused the API key. Create a new one on resend.com under API Keys and save it again.";

/** A sentence for a refused request, from Resend's { statusCode, name, message }. */
export function resendErrorMessage({ status, data }: ResendReply): string {
  const name = typeof data.name === "string" ? data.name : "";
  const message = typeof data.message === "string" ? oneLine(data.message, 300) : "";
  if (name === "missing_api_key" || name === "invalid_api_key" || /api key is invalid/i.test(message)) return KEY_REFUSED;
  if (name === "suspended_api_key" || (name === "restricted_api_key" && status === 403)) return `Resend says this API key is not active${message ? `: ${message}` : "."}`;
  if (status === 429) return `Resend's sending limit was reached${message ? `: ${message}` : "."} Try again later.`;
  if (status === 403 && /not verified/i.test(message)) return `${message} Add and verify the domain on resend.com under Domains.`;
  if (status === 403 && message) return `Resend refused the email: ${message}`;
  return `Resend refused the request (HTTP ${status})${message ? `: ${message}` : "."}`;
}

const is2xx = (status: number) => status >= 200 && status < 300;

const unreachable = (err: unknown) => {
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "Resend didn't answer in time. Try again.";
  return `Couldn't reach Resend${e?.message ? ` (${oneLine(e.message, 120)})` : ""}.`;
};

/** Domain statuses that cannot send yet. */
const NOT_READY = new Set(["not_started", "pending", "failed"]);

/**
 * Checks a key, and the From address's domain when the key may list domains:
 * a full-access key lists them, a sending-only key is refused with
 * restricted_api_key (which still proves the key is real).
 */
export async function verifyResend(apiKey: string, fromAddress: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true; detail?: string } | { ok: false; error: string }> {
  let reply: ResendReply;
  try {
    reply = await call(fetchFn, apiKey, "GET", "/domains");
  } catch (err) {
    return { ok: false, error: unreachable(err) };
  }
  if (reply.status === 401 && reply.data.name === "restricted_api_key") {
    return { ok: true, detail: "The key may only send, so the From domain wasn't checked: send a test email to be sure." };
  }
  if (!is2xx(reply.status)) return { ok: false, error: resendErrorMessage(reply) };

  const domain = fromAddress.split("@").pop()!.toLowerCase();
  if (domain === "resend.dev") return { ok: true, detail: "resend.dev is Resend's test domain: it only delivers to your own Resend account's address." };
  const list = Array.isArray(reply.data.data) ? (reply.data.data as { name?: unknown; status?: unknown }[]) : [];
  const found = list.find((d) => typeof d.name === "string" && (domain === d.name.toLowerCase() || domain.endsWith(`.${d.name.toLowerCase()}`)));
  if (!found) return { ok: false, error: `${domain} is not a domain in this Resend account. Add and verify it on resend.com under Domains, or send from a verified domain.` };
  const status = typeof found.status === "string" ? found.status : "";
  if (NOT_READY.has(status)) {
    return { ok: false, error: `${String(found.name)} is not verified in Resend yet (${status.replace(/_/g, " ")}). Add the DNS records it lists under Domains, then verify it.` };
  }
  return { ok: true };
}

export async function sendResend(
  apiKey: string,
  mail: { from: string; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> },
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  let reply: ResendReply;
  try {
    // A key per send: if the request is retried on the way, Resend sends the email once.
    reply = await call(fetchFn, apiKey, "POST", "/emails", mail, { "idempotency-key": randomUUID() });
  } catch (err) {
    return { ok: false, error: unreachable(err) };
  }
  if (!is2xx(reply.status)) return { ok: false, error: resendErrorMessage(reply) };
  return typeof reply.data.id === "string" ? { ok: true, id: reply.data.id } : { ok: true };
}
