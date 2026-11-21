import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SENDGRID_API_URLS } from "../../../src/integrations/email/sendgrid.js";
import { createApp } from "../../../src/server.js";

const KEY = "SG.RouteKeyId_000000001.RouteKeySecret_0123456789abcdefghijklmnop0001";
const NEW_KEY = "SG.RouteKeyId_000000002.RouteKeySecret_0123456789abcdefghijklmnop0002";
const FROM = "Reports <reports@example.com>";

/** The email admin routes with SendGrid, through the real HTTP API (SendGrid faked). */
describe("Email admin API with SendGrid", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  const email = async () => (await state()).config.email;
  const error = async (path: string, input: unknown) => {
    const res = await post(path, input);
    return { status: res.status, error: (await res.json()).error as string };
  };
  const sendgrid = (over: Record<string, unknown> = {}, from = FROM) => ({ provider: "sendgrid", from, sendgrid: over });

  /** Answers SendGrid API calls with `reply`; everything else (this test's own requests) goes through. */
  function stubSendgrid(reply: (path: string, init: RequestInit) => Response) {
    const realFetch = globalThis.fetch;
    const calls: { origin: string; method: string; path: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (!Object.values(SENDGRID_API_URLS).includes(url.origin)) return realFetch(input, init);
      calls.push({ origin: url.origin, method: init.method ?? "GET", path: url.pathname, auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return reply(url.pathname, init);
    });
    return calls;
  }

  /** A SendGrid account: the key's scopes, its verified senders and its authenticated domains. */
  const account = (o: { scopes?: string[]; senders?: unknown; domains?: unknown } = {}) => (path: string) => {
    const forbidden = () => Response.json({ errors: [{ field: null, message: "access forbidden" }] }, { status: 403 });
    if (path === "/v3/scopes") return Response.json({ scopes: o.scopes ?? ["mail.send", "whitelabel.read"] });
    if (path === "/v3/verified_senders") return o.senders === undefined ? forbidden() : Response.json(o.senders);
    if (path === "/v3/whitelabel/domains") return o.domains === undefined ? forbidden() : Response.json(o.domains);
    return Response.json({ errors: [{ message: "not found" }] }, { status: 404 });
  };
  const verifiedDomain = { senders: { results: [] }, domains: [{ id: 1, domain: "example.com", valid: true }] };

  beforeAll(async () => {
    delete process.env.SKIP_VALIDATION;
    const dir = await mkdtemp(join(tmpdir(), "army-email-sg-"));
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

  it("validates the SendGrid settings", async () => {
    expect((await email()).sendgrid).toEqual({ key: null, region: "global" });
    expect(await error("/api/email", sendgrid({ apiKey: "re_not_sendgrid_123" }))).toEqual({ status: 400, error: "That doesn't look like a SendGrid API key: it starts with SG." });
    expect(await error("/api/email", sendgrid())).toEqual({ status: 400, error: "Paste a SendGrid API key." });
    expect(await error("/api/email", sendgrid({ apiKey: KEY, region: "us" }))).toEqual({ status: 400, error: 'The SendGrid region is "global" or "eu".' });
    expect((await email()).configured).toBe(false);
  });

  it("checks the key before saving, and keeps a saved key while SendGrid stays the provider", async () => {
    const calls = stubSendgrid(account(verifiedDomain));
    try {
      const res = await post("/api/email", sendgrid({ apiKey: ` ${KEY} ` }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, email: { provider: "sendgrid", from: FROM, configured: true, sendgrid: { key: "••••0001", region: "global" } } });
      expect(body.detail).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(calls.map((c) => c.path).sort()).toEqual(["/v3/scopes", "/v3/verified_senders", "/v3/whitelabel/domains"]);
      expect(calls.every((c) => c.origin === "https://api.sendgrid.com" && c.method === "GET" && c.auth === `Bearer ${KEY}`)).toBe(true);
      expect((await email()).checkedAt).toEqual(expect.any(String));
      expect(JSON.stringify(await state())).not.toContain(KEY);

      // No key typed: the saved one is checked again.
      calls.length = 0;
      expect((await post("/api/email", sendgrid({}, "reports@example.com"))).status).toBe(200);
      expect(calls.find((c) => c.path === "/v3/scopes")!.auth).toBe(`Bearer ${KEY}`);
      expect(await email()).toMatchObject({ from: "reports@example.com", sendgrid: { key: "••••0001", region: "global" } });

      // Another region is another host: the saved key is not sent there.
      calls.length = 0;
      expect(await error("/api/email", sendgrid({ region: "eu" }))).toEqual({ status: 400, error: "Paste the SendGrid API key again: the saved one is only used with the region it was saved for." });
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a sending-only key with a note, in the EU region", async () => {
    const calls = stubSendgrid(account({ scopes: ["mail.send"] }));
    try {
      const res = await post("/api/email", sendgrid({ apiKey: NEW_KEY, region: "eu" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.detail).toBe("The key may only send, so the From address wasn't checked: send a test email to be sure.");
      expect(body.email.sendgrid).toEqual({ key: "••••0002", region: "eu" });
      // Domains need whitelabel.read: not asked for. Everything went to the EU host.
      expect(calls.map((c) => c.path).sort()).toEqual(["/v3/scopes", "/v3/verified_senders"]);
      expect(calls.every((c) => c.origin === "https://api.eu.sendgrid.com" && c.auth === `Bearer ${NEW_KEY}`)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a key without Mail Send or a From address SendGrid won't send as, keeps the saved settings, and redacts SendGrid's errors", async () => {
    let reply = account({ scopes: ["alerts.read"] });
    stubSendgrid((path) => reply(path));
    try {
      expect(await error("/api/email", sendgrid({ apiKey: KEY, region: "eu" }))).toEqual({
        status: 400,
        error: "This SendGrid API key may not send email. Give it the Mail Send permission under Settings → API Keys, or create a new one.",
      });

      reply = account({ senders: { results: [] }, domains: [{ domain: "example.org", valid: true }] });
      expect(await error("/api/email", sendgrid({ apiKey: KEY, region: "eu" }))).toEqual({
        status: 400,
        error: "reports@example.com is not a verified sender in this SendGrid account, and example.com is not an authenticated domain. Verify the sender or authenticate its domain under Settings → Sender Authentication.",
      });

      // SendGrid's words are passed on without either key in them.
      reply = () => Response.json({ errors: [{ message: `Key ${KEY} rejected; saved ${NEW_KEY}` }] }, { status: 400 });
      const leak = await error("/api/email", sendgrid({ apiKey: KEY, region: "eu" }));
      expect(leak).toEqual({ status: 400, error: "SendGrid refused the request (HTTP 400): Key [redacted] rejected; saved [redacted]" });

      expect((await email()).sendgrid).toEqual({ key: "••••0002", region: "eu" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a test email through SendGrid", async () => {
    let reply = () => new Response(null, { status: 202, headers: { "x-message-id": "sg-msg-123" } });
    const calls = stubSendgrid(() => reply());
    try {
      const res = await post("/api/email/test", { to: "alex@example.com, sam@example.org" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: "sg-msg-123" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ origin: "https://api.eu.sendgrid.com", method: "POST", path: "/v3/mail/send", auth: `Bearer ${NEW_KEY}` });
      const sent = calls[0]!.body as { personalizations: { to: { email: string }[] }[]; from: unknown; subject: string; content: { type: string; value: string }[] };
      expect(sent.personalizations).toEqual([{ to: [{ email: "alex@example.com" }, { email: "sam@example.org" }] }]);
      expect(sent.from).toEqual({ email: "reports@example.com", name: "Reports" });
      expect(sent.subject).toBe("Test email from Pointer");
      expect(sent.content[0]!.value).toContain("Sent with | SendGrid (EU)");
      expect(sent.content[1]!.value).toContain("Email works");

      reply = () => Response.json({ errors: [{ field: "from", message: `The from address does not match a verified Sender Identity (${NEW_KEY})` }] }, { status: 403 });
      const refused = await error("/api/email/test", { to: ["alex@example.com"] });
      expect(refused).toEqual({
        status: 400,
        error: "SendGrid refused the From address: it is not a verified sender or on an authenticated domain. Verify the sender or authenticate its domain under Settings → Sender Authentication.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forgets the SendGrid key when another provider is saved", async () => {
    process.env.SKIP_VALIDATION = "1";
    try {
      const smtp = { provider: "smtp", from: FROM, smtp: { host: "smtp.example.com", port: 587, user: "u@example.com", pass: "route-sg-smtp-pass" } };
      expect((await post("/api/email", smtp)).status).toBe(200);
      expect((await email()).sendgrid).toEqual({ key: null, region: "eu" });
      // Switching back needs the key again.
      expect(await error("/api/email", sendgrid())).toEqual({ status: 400, error: "Paste a SendGrid API key." });
    } finally {
      delete process.env.SKIP_VALIDATION;
    }
  });

  it("disconnects: forgets the key, keeps the region", async () => {
    process.env.SKIP_VALIDATION = "1";
    try {
      expect((await post("/api/email", sendgrid({ apiKey: KEY }))).status).toBe(200);
      expect(await email()).toMatchObject({ provider: "sendgrid", configured: true, checkedAt: null, sendgrid: { key: "••••0001", region: "eu" } });
      const res = await post("/api/email/disconnect", {});
      expect(res.status).toBe(200);
      expect(await email()).toMatchObject({ provider: "none", configured: false, sendgrid: { key: null, region: "eu" } });
      expect(JSON.stringify(await state())).not.toContain(KEY);
      expect(await error("/api/email/test", { to: "a@example.com" })).toEqual({ status: 400, error: "Set up email first." });
      expect(await error("/api/email", sendgrid())).toEqual({ status: 400, error: "Paste a SendGrid API key." });
    } finally {
      delete process.env.SKIP_VALIDATION;
    }
  });
});
