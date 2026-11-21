import nodemailer, { type SMTPTransportOptions } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { type Config, ConfigSchema, integrationSecrets, publicView } from "../../../src/core/config.js";
import {
  EMAIL_LIMITS,
  SendLimiter,
  checkMessage,
  emailReady,
  formatFrom,
  isEmailAddress,
  parseFrom,
  sendEmail,
  testEmail,
  verifyEmailConfig,
} from "../../../src/integrations/email/email.js";
import { RESEND_API_URL, looksLikeResendKey } from "../../../src/integrations/email/resend.js";
import { type SmtpTransportFactory, smtpErrorMessage, smtpOptions } from "../../../src/integrations/email/smtp.js";

const PASS = "smtp-secret-pass-0001";
const KEY = "re_TestKey_0123456789abcdef";

function config(email: Record<string, unknown>, extra: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ orgName: "Acme", email, ...extra });
}

const smtpConfig = (smtp: Record<string, unknown> = {}) =>
  config({ provider: "smtp", from: "Pointer <pointer@example.com>", smtp: { host: "smtp.example.com", port: 587, secure: false, user: "pointer@example.com", pass: PASS, ...smtp } });
const resendConfig = (from = "Pointer <pointer@example.com>") => config({ provider: "resend", from, resend: { apiKey: KEY } });

const message = { to: ["alex@example.com", "sam@example.org"], subject: "Weekly report", markdown: "# Signups\n\n**Up 12%**, see [the dashboard](https://example.com/d)." };

/** Fresh, roomy rate limit per test. */
const roomy = () => new SendLimiter(1000);

/** nodemailer's JSON transport (nothing is sent): the SMTP options it was asked for, and each message as composed. */
function jsonTransport() {
  const seen: SMTPTransportOptions[] = [];
  const sent: Record<string, unknown>[] = [];
  const factory: SmtpTransportFactory = (options) => {
    seen.push(options);
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    return {
      sendMail: async (mail: Parameters<typeof transporter.sendMail>[0]) => {
        const info = await transporter.sendMail(mail);
        sent.push(JSON.parse(info.message as string) as Record<string, unknown>);
        return info;
      },
      verify: async () => true,
      close: () => transporter.close(),
    } as unknown as ReturnType<SmtpTransportFactory>;
  };
  return { factory, seen, sent };
}

/** A transporter whose send or verify fails with the given error. */
function failingTransport(err: unknown) {
  const transporter = { sendMail: vi.fn(async () => Promise.reject(err)), verify: vi.fn(async () => Promise.reject(err)), close: vi.fn() };
  return { factory: (() => transporter) as unknown as SmtpTransportFactory, transporter };
}

/** A fake Resend API: answers each call with `reply`, records method, path, headers and body. */
function fakeResend(reply: (path: string, init: RequestInit) => Response) {
  const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(RESEND_API_URL);
    calls.push({ method: init.method ?? "GET", path: url.pathname, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url.pathname, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("addresses", () => {
  it("accepts plain addresses and refuses the rest", () => {
    for (const ok of ["a@example.com", "first.last+tag@sub.example.co.uk", "o'neil@example.io"]) expect(isEmailAddress(ok), ok).toBe(true);
    for (const bad of ["", "a", "a@b", "a@@example.com", "a@example..com", ".a@example.com", "a b@example.com", "Name <a@example.com>", "a@example.com\r\nBcc: x@evil.example", `${"a".repeat(65)}@example.com`]) {
      expect(isEmailAddress(bad), bad).toBe(false);
    }
  });

  it("reads the From address with or without a name", () => {
    expect(parseFrom("pointer@example.com")).toEqual({ address: "pointer@example.com" });
    expect(parseFrom("Pointer <pointer@example.com>")).toEqual({ name: "Pointer", address: "pointer@example.com" });
    expect(parseFrom('"Acme, Reports" <reports@example.com>')).toEqual({ name: "Acme, Reports", address: "reports@example.com" });
    expect(parseFrom("Pointer <not-an-address>")).toBeUndefined();
    expect(parseFrom("Pointer\r\nBcc: x@evil.example <p@example.com>")).toBeUndefined();
    expect(parseFrom("")).toBeUndefined();
    expect(formatFrom({ name: "Acme, Reports", address: "r@example.com" })).toBe('"Acme, Reports" <r@example.com>');
    expect(formatFrom({ name: "Pointer", address: "p@example.com" })).toBe("Pointer <p@example.com>");
  });
});

describe("checkMessage", () => {
  it("cleans the recipients and subject", () => {
    expect(checkMessage({ to: [" Alex@Example.com ", "alex@example.com", "sam@example.org"], subject: " Weekly\r\nBcc: x@evil.example ", markdown: "x" })).toEqual({
      ok: true,
      to: ["Alex@Example.com", "sam@example.org"],
      subject: "Weekly Bcc: x@evil.example",
      markdown: "x",
    });
  });

  it("refuses bad or too many recipients, and an empty or oversized subject or body", () => {
    const base = { to: ["a@example.com"], subject: "s", markdown: "m" };
    expect(checkMessage({ ...base, to: [] })).toEqual({ ok: false, error: "Add at least one recipient." });
    expect(checkMessage({ ...base, to: ["nope"] })).toEqual({ ok: false, error: '"nope" is not an email address.' });
    expect(checkMessage({ ...base, to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) })).toEqual({ ok: false, error: "Send to at most 20 recipients." });
    expect(checkMessage({ ...base, to: Array.from({ length: 20 }, (_, i) => `u${i}@example.com`) }).ok).toBe(true);
    expect(checkMessage({ ...base, subject: "  " })).toEqual({ ok: false, error: "The email needs a subject." });
    expect(checkMessage({ ...base, subject: "s".repeat(201) })).toEqual({ ok: false, error: "The subject is at most 200 characters." });
    expect(checkMessage({ ...base, markdown: " \n" })).toEqual({ ok: false, error: "The email has no text." });
    expect(checkMessage({ ...base, markdown: "m".repeat(EMAIL_LIMITS.maxMarkdownChars + 1) })).toEqual({ ok: false, error: "The email is at most 100 000 characters of Markdown." });
  });
});

describe("readiness", () => {
  it("needs a provider, its server or key, and a From address", () => {
    expect(emailReady(config({}))).toBe(false);
    expect(emailReady(smtpConfig())).toBe(true);
    expect(emailReady(resendConfig())).toBe(true);
    expect(emailReady(config({ provider: "resend", from: "p@example.com" }))).toBe(false);
    expect(emailReady(config({ provider: "smtp", from: "", smtp: { host: "smtp.example.com" } }))).toBe(false);
  });

  it("never puts the password or key in the public view, and lists them as secrets", () => {
    const c = config({ provider: "smtp", from: "p@example.com", smtp: { host: "smtp.example.com", user: "u", pass: PASS }, resend: { apiKey: KEY } });
    expect(JSON.stringify(publicView(c))).not.toContain(PASS);
    expect(JSON.stringify(publicView(c))).not.toContain(KEY);
    expect(publicView(c).email.smtp.pass).toBe("••••0001");
    expect(integrationSecrets(c)).toEqual(expect.arrayContaining([PASS, KEY]));
  });

  it("explains when email is not set up, without sending", async () => {
    const resend = fakeResend(() => Response.json({ id: "x" }));
    expect(await sendEmail(config({}), message, { fetch: resend.fetch, limiter: roomy() })).toEqual({ ok: false, error: "Email is not set up. Connect SMTP, Resend or SendGrid on Integrations → Email." });
    expect(resend.calls).toHaveLength(0);
  });
});

describe("SMTP", () => {
  it("uses STARTTLS on 587 (required with a password), TLS on 465, timeouts, and no logging", () => {
    const plain = smtpOptions(smtpConfig().email.smtp);
    expect(plain).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true, auth: { user: "pointer@example.com", pass: PASS }, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, tls: { minVersion: "TLSv1.2" } });
    expect(plain.connectionTimeout).toBeLessThanOrEqual(30_000);
    expect(plain.socketTimeout).toBeLessThanOrEqual(60_000);
    expect(smtpOptions(smtpConfig({ port: 465, secure: true }).email.smtp)).toMatchObject({ port: 465, secure: true, requireTLS: false });
    // A relay without sign-in: STARTTLS when offered, no auth.
    const open = smtpOptions(smtpConfig({ user: "", pass: undefined }).email.smtp);
    expect(open.requireTLS).toBe(false);
    expect(open.auth).toBeUndefined();
  });

  it("sends HTML with a plain-text part, from the named address, marked as automatic", async () => {
    const t = jsonTransport();
    const result = await sendEmail(smtpConfig(), message, { smtpTransport: t.factory, limiter: roomy() });
    expect(result.ok).toBe(true);
    expect(t.seen[0]).toMatchObject({ host: "smtp.example.com", requireTLS: true });
    const sent = t.sent[0]!;
    expect(sent.from).toEqual({ address: "pointer@example.com", name: "Pointer" });
    expect(sent.to).toEqual([{ address: "alex@example.com", name: "" }, { address: "sam@example.org", name: "" }]);
    expect(sent.subject).toBe("Weekly report");
    expect(sent.headers).toEqual({ "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" });
    expect(sent.html).toContain('<a href="https://example.com/d"');
    expect(sent.html).toContain("Sent by Pointer for Acme.");
    expect(sent.text).toContain("Up 12%, see the dashboard (https://example.com/d).");
    expect(sent.text).toContain("Sent by Pointer for Acme.");
  });

  it("builds a multipart/alternative message", async () => {
    let raw = "";
    const factory: SmtpTransportFactory = () => {
      const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
      return {
        sendMail: async (mail: Parameters<typeof transporter.sendMail>[0]) => {
          const info = await transporter.sendMail(mail);
          raw = (info.message as Buffer).toString("utf8");
          return info;
        },
        verify: async () => true,
        close: () => transporter.close(),
      } as unknown as ReturnType<SmtpTransportFactory>;
    };
    expect((await sendEmail(smtpConfig(), message, { smtpTransport: factory, limiter: roomy() })).ok).toBe(true);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type: text\/plain/i);
    expect(raw).toMatch(/Content-Type: text\/html/i);
    expect(raw).toMatch(/^Auto-Submitted: auto-generated/im);
    expect(raw).not.toContain(PASS);
  });

  it("explains failures without the password", async () => {
    const b64 = Buffer.from(PASS).toString("base64");
    const plain = Buffer.from(`\u0000pointer@example.com\u0000${PASS}`).toString("base64");
    const auth = failingTransport(Object.assign(new Error(`Invalid login: 535 rejected ${PASS}`), { code: "EAUTH", response: `535 5.7.8 bad credentials ${b64} ${plain}` }));
    const result = await sendEmail(smtpConfig({ host: "smtp.gmail.com" }), message, { smtpTransport: auth.factory, limiter: roomy() });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toMatch(/^The SMTP server refused the user name or password\. Gmail needs an app password/);
    expect(error).not.toContain(PASS);
    expect(error).not.toContain(b64);
    expect(error).not.toContain(plain);
    expect(error).toContain("[redacted]");
    expect(auth.transporter.close).toHaveBeenCalled();
  });

  it("names the usual causes of a failed connection", () => {
    const smtp = smtpConfig().email.smtp;
    expect(smtpErrorMessage({ code: "EDNS", message: "getaddrinfo ENOTFOUND" }, smtp)).toBe("Couldn't find the SMTP server smtp.example.com. Check the host name.");
    expect(smtpErrorMessage({ code: "ETIMEDOUT", message: "Connection timeout" }, smtp)).toMatch(/^smtp\.example\.com:587 didn't answer in time/);
    expect(smtpErrorMessage({ code: "ESOCKET", message: "1234:error:wrong version number" }, smtp)).toMatch(/Port 465 needs "TLS from the start" on; port 587 needs it off/);
    expect(smtpErrorMessage({ code: "ESOCKET", message: "connect ECONNREFUSED 10.0.0.1:587" }, smtp)).toBe("Couldn't connect to smtp.example.com:587 (connect ECONNREFUSED 10.0.0.1:587). Check the host and port.");
    expect(smtpErrorMessage({ code: "EENVELOPE", response: "554 Message rejected: Email address is not verified." }, smtp)).toMatch(/refused the sender or a recipient\. The server said: "554 Message rejected/);
    expect(smtpErrorMessage(new Error("boom"), smtp)).toBe("Sending through smtp.example.com:587 failed: boom");
  });

  it("verifies by connecting and signing in", async () => {
    const ok = { sendMail: vi.fn(), verify: vi.fn(async () => true as const), close: vi.fn() };
    expect(await verifyEmailConfig(smtpConfig().email, { smtpTransport: (() => ok) as unknown as SmtpTransportFactory })).toEqual({ ok: true });
    expect(ok.verify).toHaveBeenCalledOnce();
    expect(ok.close).toHaveBeenCalledOnce();
    const bad = failingTransport(Object.assign(new Error("Invalid login"), { code: "EAUTH" }));
    expect(await verifyEmailConfig(smtpConfig().email, { smtpTransport: bad.factory })).toEqual({ ok: false, error: "The SMTP server refused the user name or password." });
    expect(await verifyEmailConfig({ ...smtpConfig().email, from: "nope" })).toEqual({ ok: false, error: "Enter the From address, like Pointer <pointer@example.com> or reports@example.com." });
  });
});

describe("Resend", () => {
  it("recognises its keys", () => {
    expect(looksLikeResendKey(KEY)).toBe(true);
    expect(looksLikeResendKey("sk_live_123456789")).toBe(false);
    expect(looksLikeResendKey("re_ with space")).toBe(false);
  });

  it("posts the email with a Bearer key, a User-Agent and an idempotency key", async () => {
    const resend = fakeResend(() => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const result = await sendEmail(resendConfig('"Acme, Reports" <reports@example.com>'), message, { fetch: resend.fetch, limiter: roomy() });
    expect(result).toEqual({ ok: true, id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const call = resend.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/emails");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.headers.get("user-agent")).toBeTruthy();
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.body).toMatchObject({
      from: '"Acme, Reports" <reports@example.com>',
      to: ["alex@example.com", "sam@example.org"],
      subject: "Weekly report",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    const body = call.body as { html: string; text: string };
    expect(body.html).toContain("<strong>Up 12%</strong>");
    expect(body.text).toContain("Up 12%");
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it("explains refusals without the key", async () => {
    const reply = (status: number, body: unknown) => fakeResend(() => Response.json(body, { status }));
    const send = (f: ReturnType<typeof fakeResend>) => sendEmail(resendConfig(), message, { fetch: f.fetch, limiter: roomy() });
    expect(await send(reply(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" }))).toEqual({
      ok: false,
      error: "Resend refused the API key. Create a new one on resend.com under API Keys and save it again.",
    });
    expect(await send(reply(403, { statusCode: 403, name: "validation_error", message: "The example.com domain is not verified. Please, add and verify your domain." }))).toEqual({
      ok: false,
      error: "The example.com domain is not verified. Please, add and verify your domain. Add and verify the domain on resend.com under Domains.",
    });
    expect((await send(reply(429, { name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." }))).ok).toBe(false);
    const leaky = await send(reply(422, { name: "invalid_parameter", message: `Bad key ${KEY} in request` }));
    expect(leaky).toEqual({ ok: false, error: "Resend refused the request (HTTP 422): Bad key [redacted] in request" });
    const down = fakeResend(() => {
      throw new TypeError(`fetch failed for ${KEY}`);
    });
    const failed = await send(down);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it("verifies the key, and the From domain when the key may list domains", async () => {
    const domains = (list: unknown[]) => fakeResend(() => Response.json({ object: "list", has_more: false, data: list }));
    const check = (from: string, f: ReturnType<typeof fakeResend>) => verifyEmailConfig(resendConfig(from).email, { fetch: f.fetch });

    const verified = domains([{ id: "1", name: "example.com", status: "verified" }]);
    expect(await check("Pointer <p@example.com>", verified)).toEqual({ ok: true });
    expect(verified.calls[0]).toMatchObject({ method: "GET", path: "/domains" });
    expect(verified.calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(await check("p@mail.example.com", domains([{ name: "example.com", status: "verified" }]))).toEqual({ ok: true });

    expect(await check("p@example.com", domains([{ name: "example.com", status: "pending" }]))).toEqual({
      ok: false,
      error: "example.com is not verified in Resend yet (pending). Add the DNS records it lists under Domains, then verify it.",
    });
    expect((await check("p@other.example", domains([{ name: "example.com", status: "verified" }]))).ok).toBe(false);
    expect((await check("onboarding@resend.dev", domains([]))) as { ok: boolean; detail?: string }).toMatchObject({ ok: true, detail: expect.stringMatching(/test domain/) });

    const sendingOnly = fakeResend(() => Response.json({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }));
    expect(await check("p@example.com", sendingOnly)).toMatchObject({ ok: true, detail: expect.stringMatching(/may only send/) });

    const invalid = fakeResend(() => Response.json({ statusCode: 400, name: "validation_error", message: "API key is invalid" }, { status: 400 }));
    expect(await check("p@example.com", invalid)).toEqual({ ok: false, error: "Resend refused the API key. Create a new one on resend.com under API Keys and save it again." });
  });
});

describe("rate limit", () => {
  it("allows at most max sends in the window", () => {
    let now = 0;
    const limiter = new SendLimiter(30, 60_000, () => now);
    for (let i = 0; i < 30; i++) expect(limiter.take().ok).toBe(true);
    expect(limiter.take()).toEqual({ ok: false, retryInMs: 60_000 });
    now = 59_999;
    expect(limiter.take().ok).toBe(false);
    now = 60_000;
    expect(limiter.take().ok).toBe(true);
  });

  it("refuses sends over the limit without calling the provider, and checks the message first", async () => {
    const resend = fakeResend(() => Response.json({ id: "x" }));
    const limiter = new SendLimiter(2);
    const deps = { fetch: resend.fetch, limiter };
    // An invalid message does not use up a slot.
    expect((await sendEmail(resendConfig(), { ...message, to: [] }, deps)).ok).toBe(false);
    expect((await sendEmail(resendConfig(), message, deps)).ok).toBe(true);
    expect((await sendEmail(resendConfig(), message, deps)).ok).toBe(true);
    const third = await sendEmail(resendConfig(), message, deps);
    expect(third).toEqual({ ok: false, error: expect.stringMatching(/^Too many emails: at most 2 a minute\. Try again in \d+ seconds\.$/) });
    expect(resend.calls).toHaveLength(2);
  });

  it("is 30 a minute by default", () => {
    expect(new SendLimiter().max).toBe(30);
    expect(EMAIL_LIMITS.sendsPerMinute).toBe(30);
  });
});

describe("test email", () => {
  it("says what it was sent with, escaped as Markdown", () => {
    const c = smtpConfig();
    c.team.pointer.name = "Po*inter";
    const m = testEmail(c, ["a@example.com"]);
    expect(m.subject).toBe("Test email from Po*inter");
    expect(m.markdown).toContain("**Po\\*inter**");
    expect(m.markdown).toContain("| Sent with | SMTP (smtp.example.com:587, STARTTLS) |");
    expect(m.markdown).toContain("| From | Pointer \\<pointer@example.com\\> |");
    expect(checkMessage(m).ok).toBe(true);
  });
});
