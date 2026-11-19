import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as BitbucketWebhook from "../src/bitbucket-webhook.js";
import { type Config, ConfigRepo } from "../src/config.js";
import { deriveKey } from "../src/crypto.js";
import { BOT_MARKER } from "../src/github.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/store.js";
import { TaskRepo, newTaskId } from "../src/tasks.js";
import type { TicketClient } from "../src/ticket-sync.js";
import { EXCERPT_MAX_CHARS, resetWebhookStateForTests } from "../src/webhook.js";

// The route hands verified deliveries to handleBitbucketWebhook; record them there
// (and never settle) so the HTTP tests prove the route answers without waiting.
const handled = vi.hoisted(() => [] as Array<{ event: string; payload: unknown }>);
vi.mock("../src/bitbucket-webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BitbucketWebhook>();
  return {
    ...actual,
    handleBitbucketWebhook: (event: string, payload: unknown) => {
      handled.push({ event, payload });
      return new Promise<void>(() => {});
    },
  };
});
const { handleBitbucketWebhook, bitbucketReviewTrigger, bitbucketClosedPr, verifyBitbucketSignature, displayLogin } =
  await vi.importActual<typeof BitbucketWebhook>("../src/bitbucket-webhook.js");

const TOKEN = "ATCTT-bitbucket-secret-token-0123456789";
const REPO = "bitbucket:acme/web";
const PR_URL = "https://bitbucket.org/acme/web/pull-requests/7";

// ---------- payloads ----------
const person = (over: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: "{0b1f0000-0000-0000-0000-000000000001}",
  account_id: "557058:octo",
  nickname: "octo-dev",
  display_name: "Octo Dev",
  ...over,
});

function pullrequest(opts: { id?: number; state?: string; href?: string; repo?: string } = {}) {
  const id = opts.id ?? 7;
  return { id, state: opts.state ?? "OPEN", draft: false, links: { html: { href: opts.href ?? `https://bitbucket.org/${opts.repo ?? "acme/web"}/pull-requests/${id}` } } };
}

function commentPayload(opts: { body?: string; state?: string; author?: Record<string, unknown>; repo?: string; id?: number; href?: string; deleted?: boolean } = {}) {
  const repo = opts.repo ?? "acme/web";
  const author = person(opts.author);
  return {
    actor: author,
    repository: { type: "repository", full_name: repo, uuid: "{0b1f0000-0000-0000-0000-0000000000aa}" },
    pullrequest: pullrequest({ ...opts, repo }),
    comment: {
      id: 99,
      content: { raw: opts.body ?? "@pointer please add a test for the empty case", markup: "markdown" },
      user: author,
      inline: { path: "src/a.ts", from: null, to: 3 },
      ...(opts.deleted ? { deleted: true } : {}),
    },
  };
}

const changesPayload = (opts: { author?: Record<string, unknown>; state?: string } = {}) => ({
  actor: person(opts.author),
  repository: { full_name: "acme/web" },
  pullrequest: pullrequest({ state: opts.state }),
  changes_request: { date: "2026-11-19T10:00:00+00:00", user: person(opts.author) },
});

const closedPayload = (opts: { state?: string; id?: number } = {}) => ({ actor: person(), repository: { full_name: "acme/web" }, pullrequest: pullrequest(opts) });

// ---------- the pure decision ----------
describe("bitbucketReviewTrigger", () => {
  const asked: string[] = [];
  const decide = (event: string, payload: unknown, opts: { access?: string; ownAccountId?: string; pointerName?: string } = {}) =>
    bitbucketReviewTrigger(event, payload, {
      pointerName: opts.pointerName ?? "Pointer",
      ...(opts.ownAccountId ? { ownAccountId: opts.ownAccountId } : {}),
      association: async (repo) => {
        asked.push(repo);
        return opts.access ?? "COLLABORATOR";
      },
    });
  afterEach(() => void (asked.length = 0));

  it("starts for a comment addressed to Pointer by a writer", async () => {
    expect(await decide("pullrequest:comment_created", commentPayload())).toEqual({
      start: true,
      repo: REPO,
      prNumber: 7,
      prUrl: PR_URL,
      login: "octo-dev",
      kind: "asked",
      excerpt: "@pointer please add a test for the empty case",
    });
    expect(asked).toEqual([REPO]);
    expect(await decide("pullrequest:comment_created", commentPayload({ body: "/scoutbot fix it" }), { pointerName: "Scout Bot" })).toMatchObject({ start: true });
    expect(await decide("pullrequest:comment_created", commentPayload(), { access: "OWNER" })).toMatchObject({ start: true });
    expect(await decide("pullrequest:comment_created", commentPayload(), { access: "MEMBER" })).toMatchObject({ start: true });
  });

  it("starts for a change request, with no excerpt", async () => {
    expect(await decide("pullrequest:changes_request_created", changesPayload())).toEqual({
      start: true,
      repo: REPO,
      prNumber: 7,
      prUrl: PR_URL,
      login: "octo-dev",
      kind: "changes_requested",
      excerpt: "",
    });
  });

  it("ignores comments not addressed to Pointer, deleted ones and other events, without asking Bitbucket", async () => {
    expect(await decide("pullrequest:comment_created", commentPayload({ body: "Looks good" }))).toEqual({
      start: false,
      reason: "comment does not address Pointer",
      repo: REPO,
    });
    expect(await decide("pullrequest:comment_created", commentPayload({ body: "> @pointer fix\nno" }))).toMatchObject({ start: false });
    expect(await decide("pullrequest:comment_created", commentPayload({ deleted: true }))).toMatchObject({ start: false, reason: "comment deleted or not published" });
    expect(await decide("pullrequest:approved", commentPayload())).toMatchObject({ start: false, reason: "event not handled" });
    expect(await decide("pullrequest:comment_created", { repository: { full_name: "acme/web" } })).toEqual({ start: false, reason: "unexpected payload", repo: REPO });
    expect(await decide("pullrequest:comment_created", commentPayload({ repo: "acme/../web" }))).toEqual({ start: false, reason: "unexpected payload" });
    expect(await decide("pullrequest:comment_created", null)).toMatchObject({ start: false });
    expect(asked).toEqual([]);
  });

  it("filters bots, the token's own account, the platform's posts and closed pull requests", async () => {
    expect(await decide("pullrequest:comment_created", commentPayload({ author: { type: "app_user" } }))).toMatchObject({ start: false, reason: "sent by a bot" });
    expect(await decide("pullrequest:comment_created", commentPayload(), { ownAccountId: "557058:octo" })).toMatchObject({
      start: false,
      reason: "posted by the platform",
    });
    expect(await decide("pullrequest:comment_created", commentPayload({ body: `@pointer done\n\n[//]: # (${BOT_MARKER})` }))).toMatchObject({
      start: false,
      reason: "posted by the platform",
    });
    expect(await decide("pullrequest:comment_created", commentPayload({ state: "DECLINED" }))).toMatchObject({ start: false, reason: "pull request is not open" });
    expect(await decide("pullrequest:changes_request_created", changesPayload({ state: "MERGED" }))).toMatchObject({ start: false });
    expect(asked).toEqual([]);
  });

  it("ignores people without write access", async () => {
    expect(await decide("pullrequest:comment_created", commentPayload(), { access: "NONE" })).toEqual({
      start: false,
      reason: "author has no write access",
      repo: REPO,
    });
    expect(await decide("pullrequest:changes_request_created", changesPayload(), { access: "NONE" })).toMatchObject({ start: false });
  });

  it("keeps the excerpt to 2000 characters, falls back to a safe link and a safe name", async () => {
    const long = await decide("pullrequest:comment_created", commentPayload({ body: `@pointer ${"x".repeat(5000)}` }));
    expect(long.start && long.excerpt.length).toBe(EXCERPT_MAX_CHARS);
    expect(long.start && long.excerpt.endsWith("…")).toBe(true);
    const unsafe = await decide("pullrequest:comment_created", commentPayload({ href: "https://evil.example.com/x|<b>" }));
    expect(unsafe).toMatchObject({ start: true, prUrl: PR_URL });
    const odd = await decide("pullrequest:comment_created", commentPayload({ author: { nickname: "<@U123|boss> *now*" } }));
    expect(odd).toMatchObject({ start: true, login: "U123boss now" });
    expect(await decide("pullrequest:comment_created", commentPayload({ author: { nickname: "", display_name: "<>" } }))).toMatchObject({
      start: false,
      reason: "unexpected payload",
    });
    expect(displayLogin({ nickname: "a".repeat(80) })).toHaveLength(40);
    expect(displayLogin({ display_name: "Zoë  Ñoño" })).toBe("Zoë Ñoño");
  });
});

describe("bitbucketClosedPr", () => {
  it("reads merged and declined pull requests", () => {
    expect(bitbucketClosedPr("pullrequest:fulfilled", closedPayload({ state: "MERGED" }))).toEqual({ repo: REPO, prNumber: 7, url: PR_URL, merged: true });
    expect(bitbucketClosedPr("pullrequest:rejected", closedPayload({ state: "DECLINED" }))).toEqual({ repo: REPO, prNumber: 7, url: PR_URL, merged: false });
    expect(bitbucketClosedPr("pullrequest:created", closedPayload())).toBeUndefined();
    expect(bitbucketClosedPr("pullrequest:fulfilled", { repository: { full_name: "acme/web" } })).toBeUndefined();
  });
});

describe("verifyBitbucketSignature", () => {
  const body = Buffer.from('{"actor":{}}');
  const sign = (b: Buffer, secret = "whsec-bitbucket-0123456789") => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("matches Atlassian's test vector", () => {
    const header = "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";
    expect(verifyBitbucketSignature("It's a Secret to Everybody", Buffer.from("Hello World!"), header)).toBe(true);
  });

  it("accepts the right signature and rejects everything else", () => {
    const secret = "whsec-bitbucket-0123456789";
    expect(verifyBitbucketSignature(secret, body, sign(body))).toBe(true);
    expect(verifyBitbucketSignature(secret, body, undefined)).toBe(false);
    expect(verifyBitbucketSignature(secret, body, "")).toBe(false);
    expect(verifyBitbucketSignature(secret, body, sign(body, "another-secret-0123456789"))).toBe(false);
    expect(verifyBitbucketSignature(secret, Buffer.from(`${body} `), sign(body))).toBe(false);
    expect(verifyBitbucketSignature(secret, body, sign(body).slice(0, -2))).toBe(false);
    expect(verifyBitbucketSignature(secret, body, sign(body).replace("sha256=", "sha1="))).toBe(false);
  });
});

// ---------- the handler, with a fake Slack, runner and Bitbucket ----------
interface Post {
  channel: string;
  thread_ts?: string;
  text: string;
}

async function setup(configure?: (c: Config) => void, access = "COLLABORATOR") {
  resetWebhookStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-bitbucket-")));
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = { botToken: "xoxb-secret-token", signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    c.bitbucket = { token: TOKEN, accountId: "557058:bot", allowed: ["acme"], webhookSecret: "whsec-bitbucket-0123456789" };
    configure?.(c);
  });
  const tasks = new TaskRepo(store);
  const posts: Post[] = [];
  const launched: string[] = [];
  const looked: string[] = [];
  const slack = {
    chat: {
      postMessage: async (m: Post) => {
        posts.push(m);
        return { ok: true, ts: `900.${posts.length}` };
      },
    },
  };
  const monday: { op: string; itemId: string; body?: string; label?: string }[] = [];
  const ticketClient: TicketClient = {
    setStatusLabel: async ({ itemId, label }) => {
      monday.push({ op: "status", itemId, label });
      return { id: itemId };
    },
    addUpdate: async (itemId, body) => {
      monday.push({ op: "update", itemId, body });
      return { id: "u1" };
    },
  };
  const deps = {
    configRepo,
    tasks,
    store,
    runner: { kind: "local" as const, launch: async (id: string) => void launched.push(id) },
    slack: () => slack as never,
    monday: () => ticketClient,
    bitbucket: () => ({
      association: async (repo: string) => {
        looked.push(repo);
        return access;
      },
    }),
  };
  /** A task the team opened PR #7 of bitbucket:acme/web with, in Slack thread C1/100.1, from a monday.com ticket. */
  const seedPr = async () => {
    await tasks.savePrThread(REPO, 7, { channel: "C1", threadTs: "100.1" });
    await tasks.saveThread("C1", "100.1", { repo: REPO, branch: "army/rename-abc123", prUrl: PR_URL, prNumber: 7, requester: "U_REQ", lastRunAt: new Date().toISOString() });
    const now = new Date().toISOString();
    await tasks.save({
      id: newTaskId(Date.now() - 60_000),
      createdAt: now,
      updatedAt: now,
      status: "done",
      repo: REPO,
      channel: "C1",
      threadTs: "100.1",
      userId: "U_TASK",
      instruction: "rename the helper",
      ticket: { boardId: "4012345678", itemId: "9001", name: "Rename" },
    });
  };
  const run = (event: string, payload: unknown) => handleBitbucketWebhook(event, payload, deps);
  const newTasks = async () => (await tasks.recent()).filter((t) => t.trigger === "review");
  return { posts, launched, looked, monday, seedPr, run, newTasks };
}

describe("handleBitbucketWebhook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a follow-up for a comment addressed to Pointer, in the pull request's Slack thread", async () => {
    const t = await setup();
    await t.seedPr();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await t.run("pullrequest:comment_created", commentPayload());
    expect(t.looked).toEqual([REPO]);
    expect(t.posts).toEqual([{ channel: "C1", thread_ts: "100.1", text: `:speech_balloon: *octo-dev* asked Pointer on <${PR_URL}|PR #7>. The team is on it…` }]);
    expect(t.launched).toHaveLength(1);
    const [task] = await t.newTasks();
    expect(task).toMatchObject({
      repo: REPO,
      trigger: "review",
      userId: "U_REQ",
      instruction: "Address the feedback from octo-dev on pull request #7 (Bitbucket).\n\n> @pointer please add a test for the empty case",
    });
  });

  it("starts one for a change request too", async () => {
    const t = await setup();
    await t.seedPr();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await t.run("pullrequest:changes_request_created", changesPayload());
    expect(t.posts[0]!.text).toBe(`:speech_balloon: *octo-dev* requested changes on <${PR_URL}|PR #7>. The team is on it…`);
    expect(t.launched).toHaveLength(1);
  });

  const ignored: { what: string; payload: unknown; configure?: (c: Config) => void; access?: string }[] = [
    { what: "a reader's comment", payload: commentPayload(), access: "NONE" },
    { what: "a repository outside the allow list", payload: commentPayload(), configure: (c) => void (c.bitbucket.allowed = ["other"]) },
    { what: "a pull request the team did not open", payload: commentPayload({ id: 8 }) },
    { what: "a workspace without Bitbucket", payload: commentPayload(), configure: (c) => void (c.bitbucket.token = undefined) },
  ];
  for (const { what, payload, configure, access } of ignored) {
    it(`does nothing for ${what}, and logs no payload content`, async () => {
      const t = await setup(configure, access);
      await t.seedPr();
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      await t.run("pullrequest:comment_created", payload);
      expect(t.posts).toHaveLength(0);
      expect(t.launched).toHaveLength(0);
      expect(logs).toHaveBeenCalledTimes(1);
      const line = logs.mock.calls[0]!.map(String).join(" ");
      expect(line).toMatch(/pullrequest:comment_created \S+: ignored: /);
      expect(line).not.toMatch(/empty case|octo/);
    });
  }

  it("tells the ticket when the team's pull request is merged or declined", async () => {
    const t = await setup((c) => {
      c.monday.token = "monday-secret-token-0123456789";
      c.monday.automation = {
        enabled: true,
        boards: { "4012345678": { repo: REPO, statusColumnId: "status", startLabel: "Ready", workingLabel: "Working", reviewLabel: "Review", doneLabel: "Done", stuckLabel: "" } },
      };
    });
    await t.seedPr();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await t.run("pullrequest:fulfilled", closedPayload({ state: "MERGED" }));
    expect(t.monday[0]).toEqual({ op: "status", itemId: "9001", label: "Done" });
    expect(t.monday[1]).toMatchObject({ op: "update", itemId: "9001" });
    expect(t.monday[1]!.body).toContain(`Merged: ${PR_URL}`);
    t.monday.length = 0;
    await t.run("pullrequest:rejected", closedPayload({ state: "DECLINED" }));
    expect(t.monday.map((m) => m.op)).toEqual(["update"]);
    expect(t.monday[0]!.body).toContain(`closed without merging: ${PR_URL}`);
  });

  it("never throws, and redacts secrets from unexpected errors", async () => {
    const t = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      configRepo: { load: async () => Promise.reject(new Error("disk")) } as never,
      tasks: {} as never,
      runner: { kind: "local" as const, launch: async () => undefined },
      slack: () => ({}) as never,
    };
    await expect(handleBitbucketWebhook("pullrequest:comment_created", commentPayload(), broken)).resolves.toBeUndefined();
    expect(errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).toContain("[bitbucket] pullrequest:comment_created failed: disk");
    expect(t.posts).toHaveLength(0);
  });
});

// ---------- the HTTP routes ----------
describe("Bitbucket routes", () => {
  let base = "";
  let cookie = "";
  let close: () => void;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-bitbucket-http-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local", PUBLIC_URL: "https://army.example.com" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "setup-123", password: "longpassword1" }),
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => close());
  afterEach(() => {
    handled.length = 0;
    vi.unstubAllGlobals();
    process.env.SKIP_VALIDATION = "1";
  });

  const post = (path: string, payload: unknown) =>
    realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(payload) });
  const state = async () => ((await (await realFetch(`${base}/api/state`, { headers: { cookie } })).json()) as { config: { bitbucket: Record<string, unknown> } }).config.bitbucket;
  let secret = "";
  const deliver = (event: string, payload: unknown, opts: { request?: string; secret?: string; signature?: string | null; raw?: string } = {}) => {
    const body = opts.raw ?? JSON.stringify(payload);
    const signature = opts.signature === undefined ? `sha256=${createHmac("sha256", opts.secret ?? secret).update(body).digest("hex")}` : opts.signature;
    return realFetch(`${base}/bitbucket/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-key": event,
        "x-request-uuid": opts.request ?? crypto.randomUUID(),
        ...(signature === null ? {} : { "x-hub-signature": signature }),
      },
      body,
    });
  };

  it("needs an admin session", async () => {
    const res = await realFetch(`${base}/api/bitbucket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
    expect(res.status).toBe(401);
  });

  it("connects an access token only with a named workspace or repository, and never returns the token", async () => {
    const bare = await post("/api/bitbucket", { token: TOKEN });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toMatch(/access token/);
    expect((await post("/api/bitbucket", { token: TOKEN, allowed: ["acme/../x"] })).status).toBe(400);
    expect((await post("/api/bitbucket", { token: TOKEN, email: "not-an-email", allowed: ["acme"] })).status).toBe(400);

    const ok = await post("/api/bitbucket", { token: TOKEN, allowed: ["bitbucket:acme/web", "acme/web", "partner-co"] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, username: null, tokenKind: "access-token" });
    const view = await state();
    expect(view).toMatchObject({ connected: true, tokenKind: "access-token", allowed: ["acme/web", "partner-co"], key: "••••6789" });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("changes the allow list without the token, and verifies an API token with Bitbucket", async () => {
    expect((await post("/api/bitbucket", { allowed: ["acme"] })).status).toBe(200);
    expect((await state()).allowed).toEqual(["acme"]);

    delete process.env.SKIP_VALIDATION;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.bitbucket.org/")) return realFetch(input, init);
      seen.push(`${new URL(url).pathname} ${new Headers(init?.headers).get("authorization")?.split(" ")[0]}`);
      if (url.endsWith("/2.0/user")) return Response.json({ account_id: "557058:bot", username: "acme-bot", display_name: "Acme Bot" });
      if (url.endsWith("/2.0/user/emails")) return Response.json({ values: [] });
      if (url.includes("/2.0/repositories/acme")) return Response.json({ values: [] });
      return Response.json({ type: "error", error: { message: "no" } }, { status: 404 });
    });
    const res = await post("/api/bitbucket", { token: TOKEN, email: "bot@example.com", allowed: ["acme", "private-co/app"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("This token cannot reach private-co/app.");

    const ok = await post("/api/bitbucket", { token: TOKEN, email: "bot@example.com", allowed: ["acme"] });
    expect(await ok.json()).toEqual({ ok: true, username: "acme-bot", tokenKind: "api-token" });
    expect(seen).toContain("/2.0/user Basic");
    expect(await state()).toMatchObject({ username: "acme-bot", tokenKind: "api-token" });
  });

  it("refuses deliveries until a secret is made, then shows the secret once", async () => {
    expect((await deliver("pullrequest:comment_created", commentPayload(), { secret: "whatever-secret-0123456789" })).status).toBe(404);
    const res = await post("/api/bitbucket/webhook", {});
    const body = (await res.json()) as { url: string; secret: string };
    expect(body.url).toBe("https://army.example.com/bitbucket/webhook");
    expect(body.secret.length).toBeGreaterThanOrEqual(40);
    secret = body.secret;
    expect(await state()).toMatchObject({ webhook: { configured: true } });
    expect(JSON.stringify(await state())).not.toContain(secret);
  });

  it("rejects a missing or wrong signature, a bad event key or bad JSON", async () => {
    expect((await deliver("pullrequest:comment_created", commentPayload(), { signature: null })).status).toBe(401);
    expect((await deliver("pullrequest:comment_created", commentPayload(), { secret: "wrong-secret-0123456789abcd" })).status).toBe(401);
    expect((await deliver("pullrequest:comment_created", commentPayload(), { signature: "sha1=0123456789abcdef0123456789abcdef01234567" })).status).toBe(401);
    expect((await deliver("Not An Event", commentPayload())).status).toBe(400);
    expect((await deliver("pullrequest:comment_created", undefined, { raw: "{not json" })).status).toBe(400);
    expect(handled).toHaveLength(0);
  });

  it("answers at once and hands each delivery on once per request id", async () => {
    const started = Date.now();
    const res = await deliver("pullrequest:comment_created", commentPayload(), { request: "r-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(handled).toEqual([{ event: "pullrequest:comment_created", payload: commentPayload() }]);
    const again = await deliver("pullrequest:comment_created", commentPayload(), { request: "r-1" });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect((await deliver("pullrequest:fulfilled", closedPayload(), { request: "r-2" })).status).toBe(200);
    expect(handled.map((h) => h.event)).toEqual(["pullrequest:comment_created", "pullrequest:fulfilled"]);
  });

  it("adds the webhook to the allowed repositories with a new secret and reports failures", async () => {
    expect((await post("/api/bitbucket", { allowed: ["acme/web", "acme/api", "partner-co"] })).status).toBe(200);
    const hooks: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.bitbucket.org/")) return realFetch(input, init);
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      hooks.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (path === "/2.0/repositories/acme/web/hooks" && method === "GET")
        return Response.json({ values: [{ uuid: "{0b1f0000-0000-0000-0000-0000000000ff}", url: "https://army.example.com/bitbucket/webhook" }] });
      if (path.startsWith("/2.0/repositories/acme/web/hooks/")) return Response.json({});
      return Response.json({ type: "error", error: { message: `denied ${TOKEN}` } }, { status: 403 });
    });
    const res = await post("/api/bitbucket/webhook", { createHooks: true });
    const body = (await res.json()) as { secret: string; hooks: unknown[] };
    expect(body.hooks).toEqual([
      { repo: "bitbucket:acme/web", result: "updated" },
      { repo: "bitbucket:acme/api", result: "failed", error: "The token may not manage this repository's webhooks (it needs the webhook scopes and admin on the repository)." },
    ]);
    const put = hooks.find((h) => h.method === "PUT")!;
    expect(put.path).toBe(`/2.0/repositories/acme/web/hooks/${encodeURIComponent("{0b1f0000-0000-0000-0000-0000000000ff}")}`);
    expect(put.body).toEqual({
      description: "Agent Army: pull request reviews",
      url: "https://army.example.com/bitbucket/webhook",
      active: true,
      secret: body.secret,
      events: ["pullrequest:comment_created", "pullrequest:changes_request_created", "pullrequest:fulfilled", "pullrequest:rejected"],
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    // The old secret no longer verifies.
    expect((await deliver("pullrequest:comment_created", commentPayload())).status).toBe(401);
    secret = body.secret;
    expect((await deliver("pullrequest:comment_created", commentPayload())).status).toBe(200);
  });

  it("removes the secret, and forgets the token on disconnect", async () => {
    expect((await post("/api/bitbucket/webhook", { remove: true })).status).toBe(200);
    expect((await deliver("pullrequest:comment_created", commentPayload())).status).toBe(404);
    expect((await post("/api/bitbucket/disconnect", {})).status).toBe(200);
    expect(await state()).toMatchObject({ connected: false, username: null, key: null, allowed: ["acme/web", "acme/api", "partner-co"] });
    expect((await post("/api/bitbucket", { allowed: ["acme"] })).status).toBe(400);
  });
});
