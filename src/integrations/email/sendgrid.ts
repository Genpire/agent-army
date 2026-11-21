/**
 * Sending through SendGrid's v3 API (https://www.twilio.com/docs/sendgrid/api-reference):
 * POST /v3/mail/send with the API key as a Bearer token, answered 202 when
 * SendGrid accepts the email. Before a key is saved, GET /v3/scopes proves it
 * works and that it has mail.send, and the account's verified senders and
 * authenticated domains are read to check the From address when the key may.
 * EU regional subusers use api.eu.sendgrid.com instead of api.sendgrid.com.
 * The key is only ever sent to the chosen SendGrid host; errors never contain it.
 */
import type { EmailConfig } from "../../core/config.js";

export type SendgridRegion = EmailConfig["sendgrid"]["region"];

export const SENDGRID_API_URLS: Record<SendgridRegion, string> = { global: "https://api.sendgrid.com", eu: "https://api.eu.sendgrid.com" };
const USER_AGENT = "agent-army-pointer";
const TIMEOUT_MS = 20_000;

/** SendGrid keys are "SG.", an id, a dot and the secret. */
export const looksLikeSendgridKey = (key: string) => /^SG\.[A-Za-z0-9_-]{8,100}\.[A-Za-z0-9_-]{8,200}$/.test(key);

interface SendgridReply {
  status: number;
  data: unknown;
  messageId?: string;
}

async function call(fetchFn: typeof fetch, apiKey: string, region: SendgridRegion, method: "GET" | "POST", path: string, body?: unknown): Promise<SendgridReply> {
  const res = await fetchFn(`${SENDGRID_API_URLS[region]}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // A 202 from mail/send has no body.
  const text = await res.text().catch(() => "");
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  const messageId = res.headers.get("x-message-id") ?? undefined;
  return { status: res.status, data, ...(messageId ? { messageId } : {}) };
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What SendGrid said, from its { errors: [{ message, field, help }] }. */
function errorText(data: unknown): string {
  const errors = (data as { errors?: unknown })?.errors;
  if (!Array.isArray(errors)) return "";
  const messages = errors.map((e) => (typeof (e as { message?: unknown })?.message === "string" ? oneLine((e as { message: string }).message, 200) : "")).filter(Boolean);
  return oneLine([...new Set(messages)].slice(0, 3).join(" "), 300);
}

/** Never lets the key through, even if SendGrid repeats it. */
const scrub = (text: string, apiKey: string) => (apiKey ? text.split(apiKey).join("[redacted]") : text);

const keyRefused = (region: SendgridRegion) =>
  `SendGrid refused the API key. Create a new one with the Mail Send permission under Settings → API Keys and save it again.${region === "global" ? " A key of an EU regional subuser needs the EU region." : ""}`;

const SENDER_HELP = "Verify the sender or authenticate its domain under Settings → Sender Authentication.";

/** A sentence for a refused send. */
export function sendgridErrorMessage({ status, data }: Pick<SendgridReply, "status" | "data">, region: SendgridRegion): string {
  const said = errorText(data);
  switch (status) {
    case 400:
      return `SendGrid refused the email${said ? `: ${said}` : " as invalid."}`;
    case 401:
      return keyRefused(region);
    case 403:
      if (/sender identity|from address/i.test(said)) return `SendGrid refused the From address: it is not a verified sender or on an authenticated domain. ${SENDER_HELP}`;
      if (/access forbidden|permission|scope/i.test(said) || !said) return "The API key may not send email. Give it the Mail Send permission under Settings → API Keys, or create a new one.";
      return `SendGrid refused the email: ${said}`;
    case 413:
      return "The email is too large for SendGrid.";
    case 429:
      return "SendGrid's rate limit was reached. Try again later.";
    default:
      return `SendGrid refused the request (HTTP ${status})${said ? `: ${said}` : "."}`;
  }
}

const is2xx = (status: number) => status >= 200 && status < 300;

const unreachable = (err: unknown) => {
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "SendGrid didn't answer in time. Try again.";
  return `Couldn't reach SendGrid${e?.message ? ` (${oneLine(e.message, 120)})` : ""}.`;
};

type Verified = { ok: true; detail?: string } | { ok: false; error: string };

/** Whether a list of senders or domains has the From address, and verified; undefined when the key may not read the list. */
function lookUp(list: unknown, matches: (entry: Record<string, unknown>) => boolean, verified: (entry: Record<string, unknown>) => boolean): { listed: boolean; verified: boolean } | undefined {
  if (!Array.isArray(list)) return undefined;
  const found = list.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && matches(e as Record<string, unknown>));
  return { listed: found.length > 0, verified: found.some(verified) };
}

const NOT_CHECKED = "The key may only send, so the From address wasn't checked: send a test email to be sure.";

/**
 * Checks a key: GET /v3/scopes must answer, with mail.send among the scopes.
 * Then the From address, when the key may read them: a verified sender with
 * that address, or a valid authenticated domain it is on. A sending-only key
 * is refused those reads, which still leaves the key proven.
 */
export async function verifySendgrid(apiKey: string, region: SendgridRegion, fromAddress: string, fetchFn: typeof fetch = fetch): Promise<Verified> {
  let scopes: SendgridReply;
  try {
    scopes = await call(fetchFn, apiKey, region, "GET", "/v3/scopes");
  } catch (err) {
    return { ok: false, error: scrub(unreachable(err), apiKey) };
  }
  if (scopes.status === 401) return { ok: false, error: keyRefused(region) };
  if (scopes.status === 403) return { ok: true, detail: "SendGrid didn't let the key list its permissions, so they and the From address weren't checked: send a test email to be sure." };
  if (scopes.status === 429) return { ok: false, error: "SendGrid's rate limit was reached. Try again in a minute." };
  if (!is2xx(scopes.status)) {
    const said = errorText(scopes.data);
    return { ok: false, error: scrub(`SendGrid refused the request (HTTP ${scopes.status})${said ? `: ${said}` : "."}`, apiKey) };
  }
  const list = (scopes.data as { scopes?: unknown })?.scopes;
  const granted = new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []);
  if (!granted.has("mail.send")) {
    return { ok: false, error: "This SendGrid API key may not send email. Give it the Mail Send permission under Settings → API Keys, or create a new one." };
  }

  const address = fromAddress.toLowerCase();
  const domain = address.split("@").pop()!;
  const read = async (path: string): Promise<unknown> => {
    try {
      const reply = await call(fetchFn, apiKey, region, "GET", path);
      return is2xx(reply.status) ? reply.data : undefined;
    } catch {
      return undefined;
    }
  };
  // Authenticated domains need whitelabel.read: a key without it is not asked.
  const [senders, domains] = await Promise.all([read("/v3/verified_senders"), granted.has("whitelabel.read") ? read("/v3/whitelabel/domains") : Promise.resolve(undefined)]);

  const sender = lookUp(
    (senders as { results?: unknown })?.results,
    (s) => typeof s.from_email === "string" && s.from_email.toLowerCase() === address,
    (s) => s.verified === true,
  );
  const domainCheck = lookUp(
    domains,
    (d) => typeof d.domain === "string" && (domain === d.domain.toLowerCase() || domain.endsWith(`.${d.domain.toLowerCase()}`)),
    (d) => d.valid === true,
  );

  if (sender?.verified || domainCheck?.verified) return { ok: true };
  if (!sender || !domainCheck) return { ok: true, detail: NOT_CHECKED };
  if (domainCheck.listed) {
    return { ok: false, error: `${domain} is authenticated in SendGrid, but its DNS records aren't valid yet. Add the records it lists under Settings → Sender Authentication and verify them, or verify ${address} as a single sender.` };
  }
  if (sender.listed) {
    return { ok: false, error: `${address} is a sender in SendGrid but isn't verified yet: open the link in the email SendGrid sent to it, or authenticate ${domain} under Settings → Sender Authentication.` };
  }
  return { ok: false, error: `${address} is not a verified sender in this SendGrid account, and ${domain} is not an authenticated domain. ${SENDER_HELP}` };
}

export async function sendSendgrid(
  apiKey: string,
  region: SendgridRegion,
  mail: { from: { name?: string; address: string }; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> },
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const body = {
    personalizations: [{ to: mail.to.map((email) => ({ email })) }],
    from: mail.from.name ? { email: mail.from.address, name: mail.from.name } : { email: mail.from.address },
    subject: mail.subject,
    // SendGrid wants text/plain before text/html.
    content: [
      { type: "text/plain", value: mail.text },
      { type: "text/html", value: mail.html },
    ],
    ...(mail.headers ? { headers: mail.headers } : {}),
  };
  let reply: SendgridReply;
  try {
    reply = await call(fetchFn, apiKey, region, "POST", "/v3/mail/send", body);
  } catch (err) {
    return { ok: false, error: scrub(unreachable(err), apiKey) };
  }
  if (!is2xx(reply.status)) return { ok: false, error: scrub(sendgridErrorMessage(reply, region), apiKey) };
  return reply.messageId ? { ok: true, id: reply.messageId } : { ok: true };
}
