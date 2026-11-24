import { describe, expect, it } from "vitest";
import { GMAIL_PAGE_SIZE, MAX_THREADS, fromPerson, gmailLink, gmailSource, inboxQuery, parseFrom, plainSnippet } from "../../../src/integrations/google/gmail.js";
import { BACKOFF_MS, GoogleApiError, GoogleNotConnectedError, MAX_RETRIES } from "../../../src/integrations/google/google-api.js";
import { type FakeMessage, type FakeThread, HOUR, NOW, OWNER, configRepoWith, fakeGoogle, googleApp, googleError } from "./fake-google.js";

const SINCE = new Date(NOW.getTime() - 48 * HOUR);
const at = (hoursAgo: number) => NOW.getTime() - hoursAgo * HOUR;
const msg = (id: string, from: string, hoursAgo: number, patch: Partial<FakeMessage> = {}): FakeMessage => ({ id, from, at: at(hoursAgo), ...patch });
const thread = (id: string, ...messages: FakeMessage[]): FakeThread => ({ id, messages });

async function source(threads: FakeThread[], opts: Parameters<typeof fakeGoogle>[0] = {}, app = googleApp("gmail"), patch?: (c: Parameters<Parameters<typeof configRepoWith>[0]>[0]) => void) {
  const google = fakeGoogle({ threads, ...opts });
  const repo = await configRepoWith((c) => {
    c.apps = [app];
    patch?.(c);
  });
  const sleeps: number[] = [];
  const src = gmailSource({ configRepo: repo, fetch: google.fetch, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
  return { src, google, repo, sleeps };
}

describe("telling mail from people apart", () => {
  it("parses From headers and formats them as Name <address>", () => {
    expect(parseFrom('"Fadi S." <Fadi@Partner.example>')).toEqual({ name: "Fadi S.", address: "fadi@partner.example" });
    expect(parseFrom("Sam Lee <sam@x.example>")).toEqual({ name: "Sam Lee", address: "sam@x.example" });
    expect(parseFrom("rita@x.example")).toEqual({ name: "", address: "rita@x.example" });
    expect(parseFrom("Evil\r\nBcc: x <e@x.example>").name).toBe("Evil Bcc: x");
  });

  it("skips no-reply, mailer-daemon and notifications senders, and lists, bulk and automated mail", () => {
    const m = (from: string, headers: Record<string, string> = {}) => ({ payload: { headers: [{ name: "From", value: from }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))] } });
    expect(fromPerson(m("Fadi <fadi@partner.example>"))).toBe(true);
    for (const from of ["Acme <no-reply@acme.example>", "noreply@acme.example", "do-not-reply@x.example", "MAILER-DAEMON@mx.example", "notifications+abc@code.example", "notification@x.example", "postmaster@x.example"]) {
      expect(fromPerson(m(from)), from).toBe(false);
    }
    expect(fromPerson(m("News <news@shop.example>", { "List-Unsubscribe": "<mailto:u@shop.example>" }))).toBe(false);
    expect(fromPerson(m("Team <team@x.example>", { "List-Id": "<team.x.example>" }))).toBe(false);
    expect(fromPerson(m("Bot <bot@x.example>", { Precedence: "bulk" }))).toBe(false);
    expect(fromPerson(m("Away <away@x.example>", { "Auto-Submitted": "auto-replied" }))).toBe(false);
    expect(fromPerson(m("Person <p@x.example>", { "Auto-Submitted": "no" }))).toBe(true);
    expect(fromPerson(m(""))).toBe(false);
  });

  it("turns Gmail's snippet into clipped plain text", () => {
    expect(plainSnippet("Can we move the &quot;Q3&quot; call? I&#39;m free &amp; ready&#x21;")).toBe('Can we move the "Q3" call? I\'m free & ready!');
    const long = plainSnippet("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("searches the inbox and sent mail since a time, outside the other tabs, and links to the thread in the owner's account", () => {
    const q = inboxQuery(SINCE);
    expect(q).toContain(`after:${Math.floor(SINCE.getTime() / 1000)}`);
    expect(q).toContain("{in:inbox in:sent}");
    for (const tab of ["promotions", "social", "updates", "forums"]) expect(q).toContain(`-category:${tab}`);
    expect(gmailLink("18c2f0a1b2", OWNER)).toBe("https://mail.google.com/mail/?authuser=owner%40example.com#all/18c2f0a1b2");
    expect(gmailLink("18c2f0a1b2")).toBe("https://mail.google.com/mail/u/0/#all/18c2f0a1b2");
  });
});

describe("gmailSource: threadsSince", () => {
  const threads = [
    thread("t-person", msg("m1", "Fadi S <fadi@partner.example>", 2, { subject: "Q3 invoice", snippet: "Can you approve the &quot;Q3&quot; invoice?" })),
    thread("t-answered", msg("m2", "Sam Lee <sam@x.example>", 30), msg("m3", `Owner <${OWNER}>`, 1, { labels: ["SENT"], snippet: "Done, thanks" })),
    thread("t-noreply", msg("m4", "Acme <no-reply@acme.example>", 3)),
    thread("t-list", msg("m5", "News <news@shop.example>", 3, { headers: { "List-Unsubscribe": "<mailto:u@shop.example>" } })),
    thread("t-bulk", msg("m6", "Bot <bot@x.example>", 3, { headers: { Precedence: "bulk" } })),
    thread("t-auto", msg("m7", "Away <away@x.example>", 3, { headers: { "Auto-Submitted": "auto-replied" } })),
    thread("t-promo", msg("m8", "Shop <sales@shop.example>", 3, { labels: ["INBOX", "CATEGORY_PROMOTIONS"] })),
    thread("t-updates", msg("m8b", "Bank <alerts@bank.example>", 3, { labels: ["INBOX", "CATEGORY_UPDATES"] })),
    thread("t-old", msg("m9", "Old <old@x.example>", 120)),
    thread("t-mine", msg("m10", `Owner <${OWNER}>`, 2, { labels: ["SENT"] })),
    thread("t-draft", msg("m11", "Rita <rita@x.example>", 3), msg("m12", `Owner <${OWNER}>`, 1, { labels: ["DRAFT"] })),
    thread("t-archived", msg("m13", "Dana <dana@x.example>", 3, { labels: ["CATEGORY_PERSONAL"] })),
    thread("t-mailer", msg("m14", "Mail Delivery <mailer-daemon@mx.example>", 3)),
    thread("t-by-address", msg("m15", "Lee <lee@x.example>", 10), msg("m16", OWNER, 4, { labels: ["INBOX"] })),
    thread("t-spam", msg("m17", "Prince <p@x.example>", 3, { labels: ["SPAM"] })),
  ];

  it("keeps threads from people, marks those the owner answered last, newest first", async () => {
    const { src, google } = await source(threads);
    const out = await src.threadsSince(SINCE);
    expect(out.map((t) => t.id)).toEqual(["t-answered", "t-person", "t-draft", "t-by-address"]);
    const [answered, person, draft, byAddress] = out;
    expect(person).toEqual({
      id: "t-person",
      subject: "Q3 invoice",
      from: "Fadi S <fadi@partner.example>",
      at: new Date(at(2)).toISOString(),
      snippet: 'Can you approve the "Q3" invoice?',
      ownerRepliedLast: false,
      link: "https://mail.google.com/mail/?authuser=owner%40example.com#all/t-person",
    });
    // The owner sent the latest message: answered, the other person still named.
    expect(answered).toMatchObject({ ownerRepliedLast: true, from: "Sam Lee <sam@x.example>", snippet: "Done, thanks", at: new Date(at(1)).toISOString() });
    // A draft is not a reply.
    expect(draft).toMatchObject({ ownerRepliedLast: false, from: "Rita <rita@x.example>" });
    // The owner's own address counts even without the SENT label.
    expect(byAddress).toMatchObject({ ownerRepliedLast: true, from: "Lee <lee@x.example>" });

    // Only Gmail's fixed host, with the token; metadata format with only the headers needed.
    expect(google.calls.every((c) => c.url.host === "gmail.googleapis.com" && c.auth === "Bearer access-1")).toBe(true);
    const list = google.calls.find((c) => c.url.pathname.endsWith("/threads"))!;
    expect(list.url.searchParams.get("q")).toBe(inboxQuery(SINCE));
    expect(Number(list.url.searchParams.get("maxResults"))).toBeLessThanOrEqual(GMAIL_PAGE_SIZE);
    const get = google.calls.find((c) => c.url.pathname.endsWith("/threads/t-person"))!;
    expect(get.url.searchParams.get("format")).toBe("metadata");
    expect(get.url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"]);
  });

  it("looks up the owner's address once, and says whether more threads matched than one read covers", async () => {
    const many = Array.from({ length: 130 }, (_, i) => thread(`t${String(i).padStart(3, "0")}`, msg(`m${i}`, `P${i} <p${i}@x.example>`, 1 + i / 100)));
    const { src, google } = await source(many, { getDelayMs: 2 });
    const first = await src.inbox(SINCE);
    expect(first.threads).toHaveLength(MAX_THREADS);
    expect(first.more).toBe(true);
    expect(first.owner).toBe(OWNER);
    const lists = google.calls.filter((c) => c.url.pathname.endsWith("/threads"));
    expect(lists.map((c) => [c.url.searchParams.get("maxResults"), c.url.searchParams.get("pageToken")])).toEqual([
      ["50", null],
      ["50", "50"],
    ]);
    expect(google.calls.filter((c) => /\/threads\/t\d+$/.test(c.url.pathname))).toHaveLength(MAX_THREADS);
    // A few at a time.
    expect(google.maxInFlight()).toBeLessThanOrEqual(4);
    expect(google.maxInFlight()).toBeGreaterThan(1);
    await src.inbox(SINCE);
    expect(google.calls.filter((c) => c.url.pathname.endsWith("/profile"))).toHaveLength(1);

    // Fewer than the limit: every page, nothing more.
    const few = await source(many.slice(0, 70));
    const all = await few.src.inbox(SINCE);
    expect(all.threads).toHaveLength(70);
    expect(all.more).toBe(false);
  });

  it("renews a token about to expire before reading, and once after a 401", async () => {
    // About to expire: refreshed first, saved, and used.
    const expiring = await source(threads.slice(0, 1), {}, googleApp("gmail", { expiresAt: NOW.getTime() + 30_000 }));
    await expiring.src.threadsSince(SINCE);
    const refreshes = expiring.google.calls.filter((c) => c.url.host === "oauth2.googleapis.com");
    expect(refreshes).toHaveLength(1);
    expect(expiring.google.calls.filter((c) => c.url.host === "gmail.googleapis.com").every((c) => c.auth === "Bearer access-2")).toBe(true);
    const saved = (await expiring.repo.load(true)).apps[0]!.auth;
    expect(saved.type === "oauth" && saved.oauth.tokens?.access_token).toBe("access-2");

    // Valid by its expiry but refused (revoked elsewhere): renewed once, then it works.
    const revoked = await source(threads.slice(0, 1), { valid: [] });
    expect(await revoked.src.threadsSince(SINCE)).toHaveLength(1);
    expect(revoked.google.calls.filter((c) => c.url.host === "oauth2.googleapis.com")).toHaveLength(1);

    // The renewal refused: sign in again.
    const gone = await source(threads.slice(0, 1), { valid: [], refreshRefused: true });
    await expect(gone.src.threadsSince(SINCE)).rejects.toThrow(/Sign in again/);
  });

  it("waits and tries again when Google asks to slow down, then gives up", async () => {
    let limited = 0;
    const script = (url: URL) => {
      if (!url.pathname.endsWith("/threads") || limited >= 2) return undefined;
      limited++;
      return limited === 1 ? googleError(429, ["rateLimitExceeded"], { "Retry-After": "3" }) : googleError(403, ["userRateLimitExceeded"]);
    };
    const slow = await source(threads.slice(0, 1), { script });
    expect(await slow.src.threadsSince(SINCE)).toHaveLength(1);
    expect(slow.sleeps).toEqual([3000, BACKOFF_MS * 2]);

    const always = await source(threads.slice(0, 1), { script: (url) => (url.pathname.endsWith("/threads") ? googleError(429, ["rateLimitExceeded"]) : undefined) });
    const err = await always.src.threadsSince(SINCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as Error).message).toBe("Gmail asked to slow down; try again in a minute.");
    expect(always.sleeps).toEqual(Array.from({ length: MAX_RETRIES }, (_, i) => BACKOFF_MS * 2 ** i));
  });

  it("says what to enable when the Gmail API is off, and what to allow when the sign-in cannot read mail", async () => {
    const off = await source(threads, { script: () => googleError(403, ["accessNotConfigured", "SERVICE_DISABLED"]) });
    const message = await off.src.threadsSince(SINCE).catch((e: Error) => e.message);
    expect(message).toContain("gmail.googleapis.com");
    expect(message).toContain("Google Cloud project that owns the OAuth client");
    expect(message).not.toContain("never shown");

    const scope = await source(threads, { script: () => googleError(403, ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]) });
    expect(await scope.src.threadsSince(SINCE).catch((e: Error) => e.message)).toBe("The Gmail sign-in does not allow reading mail (gmail.readonly). Sign in again and allow it.");

    // A token granted only compose: refused before any request.
    const compose = await source(threads, {}, googleApp("gmail", { scope: "https://www.googleapis.com/auth/gmail.compose" }));
    const err = await compose.src.threadsSince(SINCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleNotConnectedError);
    expect(compose.google.calls).toHaveLength(0);
  });

  it("finds the Gmail app: the first enabled one with its preset, never a turned-off one or an unsigned one", async () => {
    const google = fakeGoogle({ threads: threads.slice(0, 1) });
    const repo = await configRepoWith((c) => {
      c.apps = [
        googleApp("gmail", { id: "app-gmail-off", enabled: false, accessToken: "off-token" }),
        googleApp("gmail", { id: "app-gmail-work" }),
        googleApp("gmail", { id: "app-gmail-other", accessToken: "other-token" }),
      ];
    });
    await gmailSource({ configRepo: repo, fetch: google.fetch, now: () => NOW }).threadsSince(SINCE);
    expect(google.calls.every((c) => c.auth === "Bearer access-1")).toBe(true);

    const none = await configRepoWith((c) => void (c.apps = []));
    await expect(gmailSource({ configRepo: none, fetch: google.fetch }).threadsSince(SINCE)).rejects.toThrow(/Gmail is not connected/);
    const unsigned = googleApp("gmail");
    if (unsigned.auth.type === "oauth") unsigned.auth.oauth.tokens = undefined;
    const signedOut = await configRepoWith((c) => void (c.apps = [unsigned]));
    await expect(gmailSource({ configRepo: signedOut, fetch: google.fetch }).threadsSince(SINCE)).rejects.toThrow(/not signed in/);
  });
});

describe("gmailSource: ready", () => {
  it("is ready when Gmail is followed, signed in and answers, and remembers it briefly", async () => {
    const { src, google } = await source([]);
    expect(await src.ready()).toBe(true);
    expect(await src.ready()).toBe(true);
    expect(google.calls.filter((c) => c.url.pathname.endsWith("/profile"))).toHaveLength(1);

    const off = await source([], {}, googleApp("gmail"), (c) => void (c.followups.trackGmail = false));
    expect(await off.src.ready()).toBe(false);
    expect(off.google.calls).toHaveLength(0);

    const refused = await source([], { valid: [], refreshRefused: true });
    expect(await refused.src.ready()).toBe(false);
  });
});
