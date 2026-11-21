import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RESEND_API_URL } from "../../../src/integrations/email/resend.js";
import { createApp } from "../../../src/server.js";

const PASS = "route-smtp-pass-0001";
const OTHER_PASS = "route-smtp-pass-0002";
const KEY = "re_RouteTestKey_0123456789";
const NEW_KEY = "re_RouteTestKey_abcdefghij";

/** The email admin routes through the real HTTP API (Resend faked; SMTP only saved, with SKIP_VALIDATION). */
describe("Email admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const state = async () => (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  const email = async () => (await state()).config.email;
  const error = async (path: string, input: unknown) => {
    const res = await post(path, input);
    return { status: res.status, error: (await res.json()).error as string };
  };

  /** Answers Resend API calls with `reply`; everything else (this test's own requests) goes through. */
  function stubResend(reply: (path: string, init: RequestInit) => Response) {
    const realFetch = globalThis.fetch;
    const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.origin !== RESEND_API_URL) return realFetch(input, init);
      calls.push({ method: init.method ?? "GET", path: url.pathname, auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return reply(url.pathname, init);
    });
    return calls;
  }

  const smtp = (over: Record<string, unknown> = {}) => ({ provider: "smtp", from: "Pointer <pointer@example.com>", smtp: { host: "smtp.example.com", port: 587, secure: false, user: "pointer@example.com", ...over } });

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-email-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    vi.unstubAllGlobals();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    expect((await post("/api/email", smtp({ pass: PASS }), false)).status).toBe(401);
    expect((await post("/api/email/test", { to: "a@example.com" }, false)).status).toBe(401);
    expect((await post("/api/email/disconnect", {}, false)).status).toBe(401);
  });

  it("starts unset, and sends nothing until set up", async () => {
    expect(await email()).toEqual({
      provider: "none",
      from: "",
      configured: false,
      smtp: { host: "", port: 587, secure: false, user: "", pass: null },
      resend: { key: null },
      checkedAt: null,
    });
    expect(await error("/api/email/test", { to: "a@example.com" })).toEqual({ status: 400, error: "Set up email first." });
  });

  it("validates the settings", async () => {
    expect(await error("/api/email", { provider: "carrier-pigeon", from: "p@example.com" })).toEqual({ status: 400, error: "Choose SMTP or Resend." });
    expect(await error("/api/email", { ...smtp({ pass: PASS }), from: "not an address" })).toEqual({
      status: 400,
      error: "Enter the From address, like Pointer <pointer@example.com> or reports@example.com.",
    });
    expect(await error("/api/email", { provider: "smtp", from: "p@example.com" })).toEqual({ status: 400, error: "Enter the SMTP server's host, like smtp.gmail.com." });
    expect((await error("/api/email", smtp({ host: "smtps://smtp.example.com", pass: PASS }))).error).toBe("Enter the host name only, like smtp.gmail.com, and the port in its own field.");
    expect((await error("/api/email", smtp({ host: "smtp example.com", pass: PASS }))).error).toBe('"smtp example.com" is not a host name.');
    expect((await error("/api/email", smtp({ port: 70000, pass: PASS }))).status).toBe(400);
    expect(await error("/api/email", smtp())).toEqual({ status: 400, error: "Enter the SMTP password (for Gmail, an app password)." });
    expect(await error("/api/email", smtp({ user: "", pass: PASS }))).toEqual({ status: 400, error: "Enter the user name the password belongs to." });
    expect(await error("/api/email", { provider: "resend", from: "p@example.com", resend: { apiKey: "sk_not_resend" } })).toEqual({
      status: 400,
      error: "That doesn't look like a Resend API key: it starts with re_.",
    });
    expect(await error("/api/email", { provider: "resend", from: "p@example.com" })).toEqual({ status: 400, error: "Paste a Resend API key." });
    expect((await email()).configured).toBe(false);
  });

  it("saves SMTP and never shows the password", async () => {
    const res = await post("/api/email", smtp({ pass: PASS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, email: { provider: "smtp", configured: true } });
    expect(JSON.stringify(body)).not.toContain(PASS);
    expect(await email()).toEqual({
      provider: "smtp",
      from: "Pointer <pointer@example.com>",
      configured: true,
      smtp: { host: "smtp.example.com", port: 587, secure: false, user: "pointer@example.com", pass: "••••0001" },
      resend: { key: null },
      // Not checked: SKIP_VALIDATION=1.
      checkedAt: null,
    });
    expect(JSON.stringify(await state())).not.toContain(PASS);
  });

  it("keeps the saved password for the same server and user only", async () => {
    // Same host and user: an empty password keeps the saved one, whatever else changes.
    expect((await post("/api/email", smtp({ host: "SMTP.example.com", port: 465, secure: true, pass: "" }))).status).toBe(200);
    expect((await email()).smtp).toEqual({ host: "smtp.example.com", port: 465, secure: true, user: "pointer@example.com", pass: "••••0001" });

    // Another host or user must not receive the saved password.
    expect(await error("/api/email", smtp({ host: "smtp.evil.example" }))).toEqual({
      status: 400,
      error: "Enter the password again: the saved one is only used with the server and user it was saved for.",
    });
    expect((await error("/api/email", smtp({ user: "someone@example.com" }))).status).toBe(400);
    expect((await email()).smtp.host).toBe("smtp.example.com");

    expect((await post("/api/email", smtp({ host: "smtp.other.example", pass: OTHER_PASS }))).status).toBe(200);
    expect((await email()).smtp).toMatchObject({ host: "smtp.other.example", port: 587, secure: false, pass: "••••0002" });
  });

  it("checks a Resend key before saving, keeps a saved key, and redacts Resend's errors", async () => {
    delete process.env.SKIP_VALIDATION;
    let domains: unknown = { object: "list", has_more: false, data: [{ id: "d1", name: "example.com", status: "verified" }] };
    let status = 200;
    const calls = stubResend((path) => {
      expect(path).toBe("/domains");
      return Response.json(domains, { status });
    });
    try {
      const res = await post("/api/email", { provider: "resend", from: "Reports <reports@example.com>", resend: { apiKey: ` ${KEY} ` } });
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ method: "GET", path: "/domains", auth: `Bearer ${KEY}`, body: undefined }]);
      const saved = await email();
      expect(saved).toMatchObject({ provider: "resend", from: "Reports <reports@example.com>", configured: true, resend: { key: "••••6789" } });
      expect(saved.checkedAt).toEqual(expect.any(String));
      // The SMTP settings stay for switching back; their password is still never shown.
      expect(saved.smtp).toMatchObject({ host: "smtp.other.example", pass: "••••0002" });

      // No key typed: the saved one is checked again.
      expect((await post("/api/email", { provider: "resend", from: "reports@example.com" })).status).toBe(200);
      expect(calls[1]!.auth).toBe(`Bearer ${KEY}`);

      // A domain that isn't verified is refused, and the old settings stay.
      domains = { data: [{ name: "example.com", status: "pending" }] };
      expect(await error("/api/email", { provider: "resend", from: "reports@example.com", resend: { apiKey: NEW_KEY } })).toEqual({
        status: 400,
        error: "example.com is not verified in Resend yet (pending). Add the DNS records it lists under Domains, then verify it.",
      });

      // Resend's message is passed on without the key in it.
      status = 403;
      domains = { statusCode: 403, name: "invalid_permission", message: `Key ${NEW_KEY} lacks a scope; saved ${KEY}` };
      const leak = await error("/api/email", { provider: "resend", from: "reports@example.com", resend: { apiKey: NEW_KEY } });
      expect(leak.status).toBe(400);
      expect(leak.error).toBe("Resend refused the email: Key [redacted] lacks a scope; saved [redacted]");
      expect((await email()).resend.key).toBe("••••6789");
    } finally {
      vi.unstubAllGlobals();
      process.env.SKIP_VALIDATION = "1";
    }
  });

  it("sends a test email", async () => {
    let reply = () => Response.json({ id: "email-123" });
    const calls = stubResend(() => reply());
    try {
      const res = await post("/api/email/test", { to: "alex@example.com, sam@example.org" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: "email-123" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", path: "/emails", auth: `Bearer ${KEY}` });
      const sent = calls[0]!.body as { from: string; to: string[]; subject: string; html: string; text: string };
      expect(sent.from).toBe("reports@example.com");
      expect(sent.to).toEqual(["alex@example.com", "sam@example.org"]);
      expect(sent.subject).toBe("Test email from Pointer");
      expect(sent.html).toContain("Email works");
      expect(sent.text).toContain("Sent with | Resend");

      expect(await error("/api/email/test", { to: "nope" })).toEqual({ status: 400, error: '"nope" is not an email address.' });
      expect((await error("/api/email/test", { to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) })).error).toBe("Send to at most 20 recipients.");

      reply = () => Response.json({ name: "validation_error", message: `You can only send testing emails to your own email address (${KEY})` }, { status: 403 });
      const refused = await error("/api/email/test", { to: ["alex@example.com"] });
      expect(refused.status).toBe(400);
      expect(refused.error).not.toContain(KEY);
      expect(refused.error).toMatch(/^Resend refused the email: You can only send testing emails/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disconnects: forgets the password and key, keeps the rest", async () => {
    const res = await post("/api/email/disconnect", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await email()).toEqual({
      provider: "none",
      from: "reports@example.com",
      configured: false,
      smtp: { host: "smtp.other.example", port: 587, secure: false, user: "pointer@example.com", pass: null },
      resend: { key: null },
      checkedAt: null,
    });
    expect(await error("/api/email/test", { to: "a@example.com" })).toEqual({ status: 400, error: "Set up email first." });
    // The password is gone for good: the same server needs it again.
    expect(await error("/api/email", { ...smtp({ host: "smtp.other.example" }) })).toEqual({ status: 400, error: "Enter the SMTP password (for Gmail, an app password)." });
  });
});
