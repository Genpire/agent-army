import { describe, expect, it, vi } from "vitest";
import { type Config, ConfigSchema, EmailConfigSchema, integrationSecrets, publicView } from "../../../src/core/config.js";
import { SendLimiter, emailReady, sendEmail, testEmail, verifyEmailConfig } from "../../../src/integrations/email/email.js";
import { SENDGRID_API_URLS, type SendgridRegion, looksLikeSendgridKey } from "../../../src/integrations/email/sendgrid.js";

const KEY = "SG.TestKeyId_0123456789.TestKeySecret_abcdefghijklmnopqrstuvwxyz0123";

function config(email: Record<string, unknown>): Config {
  return ConfigSchema.parse({ orgName: "Acme", email });
}

const sendgridConfig = (from = "Pointer <pointer@example.com>", region: SendgridRegion = "global") => config({ provider: "sendgrid", from, sendgrid: { apiKey: KEY, region } });

const message = { to: ["alex@example.com", "sam@example.org"], subject: "Weekly report", markdown: "# Signups\n\n**Up 12%**, see [the dashboard](https://example.com/d)." };

const roomy = () => new SendLimiter(1000);

/** A fake SendGrid API: answers each call with `reply`, records origin, method, path, headers and body. */
function fakeSendgrid(reply: (path: string, init: RequestInit) => Response) {
  const calls: { origin: string; method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(Object.values(SENDGRID_API_URLS)).toContain(url.origin);
    calls.push({ origin: url.origin, method: init.method ?? "GET", path: url.pathname, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url.pathname, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const accepted = (id?: string) => new Response(null, { status: 202, headers: id ? { "x-message-id": id } : {} });
const errors = (status: number, ...messages: string[]) => Response.json({ errors: messages.map((m) => ({ message: m, field: null, help: null })) }, { status });

describe("SendGrid config", () => {
  it("loads configs saved before SendGrid, with the global region", () => {
    const old = EmailConfigSchema.parse({ provider: "resend", from: "p@example.com", smtp: { host: "" }, resend: { apiKey: "re_old_key_123456" } });
    expect(old.sendgrid).toEqual({ region: "global" });
    expect(ConfigSchema.parse({}).email.sendgrid).toEqual({ region: "global" });
  });

  it("is ready with a key and a From address, masks the key and lists it as a secret", () => {
    expect(emailReady(sendgridConfig())).toBe(true);
    expect(emailReady(config({ provider: "sendgrid", from: "p@example.com" }))).toBe(false);
    expect(emailReady(config({ provider: "sendgrid", from: "", sendgrid: { apiKey: KEY } }))).toBe(false);
    const c = sendgridConfig("p@example.com", "eu");
    expect(publicView(c).email).toMatchObject({ provider: "sendgrid", configured: true, sendgrid: { key: `••••${KEY.slice(-4)}`, region: "eu" } });
    expect(JSON.stringify(publicView(c))).not.toContain(KEY);
    expect(integrationSecrets(c)).toContain(KEY);
  });

  it("recognises its keys", () => {
    expect(looksLikeSendgridKey(KEY)).toBe(true);
    expect(looksLikeSendgridKey("re_TestKey_0123456789")).toBe(false);
    expect(looksLikeSendgridKey("SG.only-one-part")).toBe(false);
    expect(looksLikeSendgridKey("SG.abc defghijk.lmnopqrstuv")).toBe(false);
  });

  it("names SendGrid and its region in the test email", () => {
    expect(testEmail(sendgridConfig(), ["a@example.com"]).markdown).toContain("| Sent with | SendGrid |");
    expect(testEmail(sendgridConfig("p@example.com", "eu"), ["a@example.com"]).markdown).toContain("| Sent with | SendGrid (EU) |");
  });
});

describe("SendGrid sending", () => {
  it("posts mail/send with a Bearer key: recipients, the parsed From, the subject, and text before HTML", async () => {
    const sg = fakeSendgrid(() => accepted("msg-14c5d75ce93"));
    const result = await sendEmail(sendgridConfig('"Acme, Reports" <reports@example.com>'), message, { fetch: sg.fetch, limiter: roomy() });
    expect(result).toEqual({ ok: true, id: "msg-14c5d75ce93" });
    expect(sg.calls).toHaveLength(1);
    const call = sg.calls[0]!;
    expect(call).toMatchObject({ origin: "https://api.sendgrid.com", method: "POST", path: "/v3/mail/send" });
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("user-agent")).toBeTruthy();
    const body = call.body as { personalizations: unknown; from: unknown; subject: string; content: { type: string; value: string }[]; headers: Record<string, string> };
    expect(body.personalizations).toEqual([{ to: [{ email: "alex@example.com" }, { email: "sam@example.org" }] }]);
    expect(body.from).toEqual({ email: "reports@example.com", name: "Acme, Reports" });
    expect(body.subject).toBe("Weekly report");
    expect(body.content.map((c) => c.type)).toEqual(["text/plain", "text/html"]);
    expect(body.content[0]!.value).toContain("Up 12%");
    expect(body.content[0]!.value).not.toContain("<strong>");
    expect(body.content[1]!.value).toContain("<strong>Up 12%</strong>");
    expect(body.headers).toEqual({ "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("sends a bare From address without a name, and an EU account to api.eu.sendgrid.com", async () => {
    const sg = fakeSendgrid(() => accepted());
    expect(await sendEmail(sendgridConfig("reports@example.com", "eu"), message, { fetch: sg.fetch, limiter: roomy() })).toEqual({ ok: true });
    expect(sg.calls[0]!.origin).toBe("https://api.eu.sendgrid.com");
    expect((sg.calls[0]!.body as { from: unknown }).from).toEqual({ email: "reports@example.com" });
  });

  it("explains each refusal in a sentence that never contains the key", async () => {
    const send = async (reply: () => Response, region: SendgridRegion = "global") => {
      const result = await sendEmail(sendgridConfig("p@example.com", region), message, { fetch: fakeSendgrid(reply).fetch, limiter: roomy() });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(KEY);
      return result.ok ? "" : result.error;
    };
    expect(await send(() => errors(400, "The subject is required. You can get around this requirement if you use a template with a subject defined."))).toBe(
      "SendGrid refused the email: The subject is required. You can get around this requirement if you use a template with a subject defined.",
    );
    expect(await send(() => errors(400))).toBe("SendGrid refused the email as invalid.");
    expect(await send(() => errors(401, "The provided authorization grant is invalid, expired, or revoked"))).toBe(
      "SendGrid refused the API key. Create a new one with the Mail Send permission under Settings → API Keys and save it again. A key of an EU regional subuser needs the EU region.",
    );
    expect(await send(() => errors(401, "authorization required"), "eu")).toBe(
      "SendGrid refused the API key. Create a new one with the Mail Send permission under Settings → API Keys and save it again.",
    );
    expect(
      await send(() =>
        errors(403, "The from address does not match a verified Sender Identity. Mail cannot be sent until this error is resolved. Visit https://sendgrid.com/docs/for-developers/sending-email/sender-identity/ to see the Sender Identity requirements"),
      ),
    ).toBe("SendGrid refused the From address: it is not a verified sender or on an authenticated domain. Verify the sender or authenticate its domain under Settings → Sender Authentication.");
    expect(await send(() => errors(403, "access forbidden"))).toBe("The API key may not send email. Give it the Mail Send permission under Settings → API Keys, or create a new one.");
    expect(await send(() => errors(403, "You are temporarily blocked from sending emails due to repeated bad requests."))).toBe(
      "SendGrid refused the email: You are temporarily blocked from sending emails due to repeated bad requests.",
    );
    expect(await send(() => errors(413, "content too large"))).toBe("The email is too large for SendGrid.");
    expect(await send(() => errors(429, "too many requests"))).toBe("SendGrid's rate limit was reached. Try again later.");
    expect(await send(() => new Response("<html>Bad gateway</html>", { status: 502 }))).toBe("SendGrid refused the request (HTTP 502).");
    // SendGrid's own words are passed on, without the key if it repeats it.
    expect(await send(() => errors(400, `Invalid key ${KEY} in request`))).toBe("SendGrid refused the email: Invalid key [redacted] in request");
    expect(
      await send(() => {
        throw new TypeError(`fetch failed for ${KEY}`);
      }),
    ).toBe("Couldn't reach SendGrid (fetch failed for [redacted]).");
  });

  it("counts against the same rate limit as every other send", async () => {
    const sg = fakeSendgrid(() => accepted());
    const deps = { fetch: sg.fetch, limiter: new SendLimiter(1) };
    expect((await sendEmail(sendgridConfig(), message, deps)).ok).toBe(true);
    expect(await sendEmail(sendgridConfig(), message, deps)).toEqual({ ok: false, error: expect.stringMatching(/^Too many emails: at most 1 a minute/) });
    expect(sg.calls).toHaveLength(1);
  });
});

describe("SendGrid verification", () => {
  /** Answers /v3/scopes, /v3/verified_senders and /v3/whitelabel/domains. */
  const account = (answers: { scopes?: () => Response; senders?: () => Response; domains?: () => Response }) =>
    fakeSendgrid((path) => {
      if (path === "/v3/scopes") return answers.scopes?.() ?? Response.json({ scopes: ["mail.send"] });
      if (path === "/v3/verified_senders") return answers.senders?.() ?? errors(403, "access forbidden");
      if (path === "/v3/whitelabel/domains") return answers.domains?.() ?? errors(403, "access forbidden");
      throw new Error(`unexpected ${path}`);
    });
  const check = (from: string, sg: ReturnType<typeof fakeSendgrid>, region: SendgridRegion = "global") => verifyEmailConfig(sendgridConfig(from, region).email, { fetch: sg.fetch });
  const full = { scopes: () => Response.json({ scopes: ["mail.send", "whitelabel.read", "alerts.read"] }) };
  const sender = (from_email: string, verified: boolean) => ({ id: 1, nickname: "Reports", from_email, from_name: "Reports", verified, locked: false });

  it("reads the key's scopes, and accepts a verified sender", async () => {
    const sg = account({ ...full, senders: () => Response.json({ results: [sender("Reports@Example.com", true)] }), domains: () => Response.json([]) });
    expect(await check("Pointer <reports@example.com>", sg)).toEqual({ ok: true });
    const paths = sg.calls.map((c) => c.path).sort();
    expect(paths).toEqual(["/v3/scopes", "/v3/verified_senders", "/v3/whitelabel/domains"]);
    for (const c of sg.calls) {
      expect(c).toMatchObject({ origin: "https://api.sendgrid.com", method: "GET" });
      expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }
  });

  it("accepts an address on a valid authenticated domain, its subdomains too", async () => {
    const domains = () => Response.json([{ id: 1, domain: "example.com", subdomain: "em123", valid: true, default: true }]);
    expect(await check("reports@example.com", account({ ...full, senders: () => Response.json({ results: [] }), domains }))).toEqual({ ok: true });
    expect(await check("reports@mail.example.com", account({ ...full, senders: () => Response.json({ results: [] }), domains }))).toEqual({ ok: true });
  });

  it("refuses a key without mail.send", async () => {
    const sg = account({ scopes: () => Response.json({ scopes: ["alerts.read", "whitelabel.read"] }) });
    expect(await check("reports@example.com", sg)).toEqual({
      ok: false,
      error: "This SendGrid API key may not send email. Give it the Mail Send permission under Settings → API Keys, or create a new one.",
    });
    expect(sg.calls.map((c) => c.path)).toEqual(["/v3/scopes"]);
  });

  it("refuses a key SendGrid does not know", async () => {
    const result = await check("reports@example.com", account({ scopes: () => errors(401, "authorization required") }), "eu");
    expect(result).toEqual({ ok: false, error: "SendGrid refused the API key. Create a new one with the Mail Send permission under Settings → API Keys and save it again." });
  });

  it("accepts a sending-only key with a note when the sender check is refused", async () => {
    const sg = account({});
    expect(await check("reports@example.com", sg, "eu")).toEqual({ ok: true, detail: "The key may only send, so the From address wasn't checked: send a test email to be sure." });
    // Without whitelabel.read, the domains are not asked for; everything went to the EU host.
    expect(sg.calls.map((c) => c.path).sort()).toEqual(["/v3/scopes", "/v3/verified_senders"]);
    expect(sg.calls.every((c) => c.origin === "https://api.eu.sendgrid.com")).toBe(true);
    // Senders readable, domains not: the address could still be on an authenticated domain.
    expect(await check("reports@example.com", account({ senders: () => Response.json({ results: [] }) }))).toMatchObject({ ok: true, detail: expect.stringMatching(/wasn't checked/) });
  });

  it("accepts a key that may not list its scopes, with a note", async () => {
    expect(await check("reports@example.com", account({ scopes: () => errors(403, "access forbidden") }))).toMatchObject({ ok: true, detail: expect.stringMatching(/send a test email/) });
  });

  it("refuses a From address that is neither a verified sender nor on an authenticated domain", async () => {
    const none = account({ ...full, senders: () => Response.json({ results: [sender("other@example.org", true)] }), domains: () => Response.json([{ domain: "example.org", valid: true }]) });
    expect(await check("reports@example.com", none)).toEqual({
      ok: false,
      error: "reports@example.com is not a verified sender in this SendGrid account, and example.com is not an authenticated domain. Verify the sender or authenticate its domain under Settings → Sender Authentication.",
    });
    const pendingSender = account({ ...full, senders: () => Response.json({ results: [sender("reports@example.com", false)] }), domains: () => Response.json([]) });
    expect(await check("reports@example.com", pendingSender)).toEqual({
      ok: false,
      error: "reports@example.com is a sender in SendGrid but isn't verified yet: open the link in the email SendGrid sent to it, or authenticate example.com under Settings → Sender Authentication.",
    });
    const pendingDomain = account({ ...full, senders: () => Response.json({ results: [] }), domains: () => Response.json([{ domain: "example.com", valid: false }]) });
    expect((await check("reports@example.com", pendingDomain)) as { error?: string }).toMatchObject({ ok: false, error: expect.stringMatching(/^example\.com is authenticated in SendGrid, but its DNS records aren't valid yet/) });
  });

  it("says when SendGrid can't be reached, without the key", async () => {
    const down = fakeSendgrid(() => {
      throw new TypeError(`connect ECONNREFUSED ${KEY}`);
    });
    const result = await check("reports@example.com", down);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
