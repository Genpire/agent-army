import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Config, ConfigRepo } from "../../../src/core/config.js";
import { deriveKey } from "../../../src/core/crypto.js";
import { BOT_MARKER } from "../../../src/integrations/github/github.js";
import type * as GitlabWebhook from "../../../src/integrations/gitlab/gitlab-webhook.js";
import { createApp } from "../../../src/server.js";
import { FsStore } from "../../../src/core/store.js";
import { TaskRepo, newTaskId } from "../../../src/tasks/tasks.js";
import { EXCERPT_MAX_CHARS, resetWebhookStateForTests } from "../../../src/integrations/code-hosts/webhook.js";

// The route hands verified deliveries to handleGitlabDelivery; record them there
// (and never settle) so the HTTP tests prove the route answers without waiting.
const handled = vi.hoisted(() => [] as Array<{ event: string; payload: unknown }>);
vi.mock("../../../src/integrations/gitlab/gitlab-webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitlabWebhook>();
  return {
    ...actual,
    handleGitlabDelivery: (event: string, payload: unknown) => {
      handled.push({ event, payload });
      return new Promise<void>(() => {});
    },
  };
});
const { gitlabReviewDecision, gitlabClosedPr, handleGitlabDelivery, verifyGitlabToken, GITLAB_MR_EVENT, GITLAB_NOTE_EVENT } =
  await vi.importActual<typeof GitlabWebhook>("../../../src/integrations/gitlab/gitlab-webhook.js");

const BASE = "https://gitlab.example.com";
const REPO = "gitlab:acme/web";
const MR_URL = `${BASE}/acme/web/-/merge_requests/7`;
const SELF_ID = 99;

// ---------- payloads ----------
interface Who {
  id?: number;
  username?: string;
}

function notePayload(opts: { note?: string; action?: string | null; system?: boolean; noteable?: string; state?: string; path?: string; user?: Who; iid?: number } = {}) {
  const user = { id: 5, username: "octo-dev", ...opts.user };
  return {
    object_kind: "note",
    event_type: "note",
    user: { ...user, name: "Octo Dev", email: "[REDACTED]" },
    project: { id: 1, path_with_namespace: opts.path ?? "acme/web", web_url: "https://elsewhere.example.com/acme/web" },
    object_attributes: {
      id: 301,
      note: opts.note ?? "@pointer please add a test for the empty case",
      noteable_type: opts.noteable ?? "MergeRequest",
      author_id: user.id,
      system: opts.system ?? false,
      ...(opts.action === null ? {} : { action: opts.action ?? "create" }),
      url: "https://elsewhere.example.com/acme/web/-/merge_requests/7#note_301",
    },
    merge_request: { iid: opts.iid ?? 7, state: opts.state ?? "opened", url: "https://elsewhere.example.com/x" },
  };
}

function reviewPayload(opts: { before?: string; after?: string; action?: string; state?: string; user?: Who; reviewerId?: number; shape?: "tuple" | "object" } = {}) {
  const user = { id: 5, username: "octo-dev", ...opts.user };
  const reviewer = (state: string) => [{ id: opts.reviewerId ?? user.id, username: user.username, state, re_requested: false }];
  const previous = reviewer(opts.before ?? "review_started");
  const current = reviewer(opts.after ?? "requested_changes");
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user,
    project: { id: 1, path_with_namespace: "acme/web" },
    object_attributes: { iid: 7, state: opts.state ?? "opened", action: opts.action ?? "update", url: MR_URL },
    changes: { reviewers: opts.shape === "object" ? { previous, current } : [previous, current] },
  };
}

function closedPayload(action: string, state = action === "merge" ? "merged" : "closed") {
  return { object_kind: "merge_request", user: { id: 5, username: "octo-dev" }, project: { path_with_namespace: "acme/web" }, object_attributes: { iid: 7, state, action } };
}

// ---------- the pure decision ----------
describe("verifyGitlabToken", () => {
  it("accepts only the configured secret token", () => {
    const secret = "s3cret-token-0123456789abcdef";
    expect(verifyGitlabToken(secret, secret)).toBe(true);
    expect(verifyGitlabToken(secret, `${secret}x`)).toBe(false);
    expect(verifyGitlabToken(secret, undefined)).toBe(false);
    expect(verifyGitlabToken(secret, "")).toBe(false);
    expect(verifyGitlabToken(undefined, secret)).toBe(false);
    expect(verifyGitlabToken(secret, "x".repeat(600))).toBe(false);
  });
});

describe("gitlabReviewDecision", () => {
  const levels = new Map<number, number>([
    [5, 30],
    [6, 40],
    [7, 20],
  ]);
  const lookups: number[] = [];
  const decide = (event: string, payload: unknown, over: Partial<Parameters<typeof gitlabReviewDecision>[2]> = {}) =>
    gitlabReviewDecision(event, payload, {
      pointerName: "Pointer",
      baseUrl: `${BASE}/`,
      selfUserId: SELF_ID,
      accessLevel: async (_repo, id) => {
        lookups.push(id);
        return levels.get(id);
      },
      ...over,
    });
  afterEach(() => void (lookups.length = 0));

  it("starts for a merge request comment addressed to Pointer by someone with write access", async () => {
    expect(await decide(GITLAB_NOTE_EVENT, notePayload())).toEqual({
      start: true,
      repo: REPO,
      prNumber: 7,
      prUrl: MR_URL,
      login: "octo-dev",
      kind: "asked",
      excerpt: "@pointer please add a test for the empty case",
    });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ note: "/pointer fix the typo", user: { id: 6, username: "lead-dev" } }))).toMatchObject({ start: true, login: "lead-dev" });
    // Older instances send no action: a new comment.
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ action: null }))).toMatchObject({ start: true });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ path: "acme/platform/web" }))).toMatchObject({ start: true, repo: "gitlab:acme/platform/web" });
  });

  it("ignores comments that are not for Pointer, edits, system notes and other noteables", async () => {
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ note: "Looks good to me" }))).toEqual({ start: false, reason: "comment does not address Pointer", repo: REPO });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ action: "update" }))).toMatchObject({ start: false, reason: "comment not created" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ system: true }))).toMatchObject({ start: false, reason: "system note" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ noteable: "Issue" }))).toMatchObject({ start: false, reason: "comment not on a merge request" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ state: "merged" }))).toMatchObject({ start: false, reason: "merge request is not open" });
    expect(await decide("Push Hook", notePayload())).toMatchObject({ start: false, reason: "event not handled" });
    expect(await decide(GITLAB_NOTE_EVENT, { object_kind: "note" })).toEqual({ start: false, reason: "unexpected payload" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ path: "acme/../etc" }))).toEqual({ start: false, reason: "unexpected payload" });
    expect(lookups).toEqual([]);
  });

  it("ignores bots, the token's own user, the platform's comments and people without write access", async () => {
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ user: { id: 50, username: "project_1_bot_3f9a" } }))).toMatchObject({ start: false, reason: "sent by a bot" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ user: { id: SELF_ID, username: "army-bot" } }))).toMatchObject({ start: false, reason: "posted by the platform" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ note: `@pointer done\n\n${BOT_MARKER}` }))).toMatchObject({ start: false, reason: "posted by the platform" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ user: { id: 7, username: "viewer" } }))).toMatchObject({ start: false, reason: "author has no write access" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ user: { id: 8, username: "drive-by" } }))).toMatchObject({ start: false, reason: "author has no write access" });
    expect(await decide(GITLAB_NOTE_EVENT, notePayload({ user: { id: 5, username: "<!channel>" } }))).toMatchObject({ start: false, reason: "unexpected payload" });
    const failing = await decide(GITLAB_NOTE_EVENT, notePayload(), {
      accessLevel: async () => {
        throw new Error("GitLab GET /projects/acme%2Fweb/members/all/5 failed (HTTP 500)");
      },
    });
    expect(failing).toMatchObject({ start: false, reason: "could not check the author's access" });
  });

  it("caps the excerpt", async () => {
    const decision = await decide(GITLAB_NOTE_EVENT, notePayload({ note: `@pointer ${"a".repeat(EXCERPT_MAX_CHARS * 2)}` }));
    expect(decision.start && decision.excerpt.length).toBe(EXCERPT_MAX_CHARS);
  });

  it("starts when a reviewer submits a review that requests changes or comments", async () => {
    expect(await decide(GITLAB_MR_EVENT, reviewPayload())).toEqual({
      start: true,
      repo: REPO,
      prNumber: 7,
      prUrl: MR_URL,
      login: "octo-dev",
      kind: "changes_requested",
      excerpt: "",
    });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ after: "reviewed" }))).toMatchObject({ start: true, kind: "commented" });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ shape: "object" }))).toMatchObject({ start: true, kind: "changes_requested" });
  });

  it("ignores approvals, unchanged states, other people's states and other merge request updates", async () => {
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ after: "approved" }))).toMatchObject({ start: false, reason: "review approved" });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ before: "requested_changes" }))).toMatchObject({ start: false, reason: "merge request not reviewed" });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ reviewerId: 6 }))).toMatchObject({ start: false, reason: "merge request not reviewed" });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ action: "open" }))).toMatchObject({ start: false });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ state: "closed" }))).toMatchObject({ start: false, reason: "merge request is not open" });
    expect(await decide(GITLAB_MR_EVENT, reviewPayload({ user: { id: 7, username: "viewer" } }))).toMatchObject({ start: false, reason: "author has no write access" });
    expect(await decide(GITLAB_MR_EVENT, { ...reviewPayload(), changes: {} })).toMatchObject({ start: false, reason: "merge request not reviewed" });
  });
});

describe("gitlabClosedPr", () => {
  it("reports merged and closed merge requests with a link on the instance", () => {
    expect(gitlabClosedPr(GITLAB_MR_EVENT, closedPayload("merge"), BASE)).toEqual({ repo: REPO, prNumber: 7, url: MR_URL, merged: true });
    expect(gitlabClosedPr(GITLAB_MR_EVENT, closedPayload("close"), BASE)).toEqual({ repo: REPO, prNumber: 7, url: MR_URL, merged: false });
    expect(gitlabClosedPr(GITLAB_MR_EVENT, closedPayload("update", "opened"), BASE)).toBeUndefined();
    expect(gitlabClosedPr(GITLAB_NOTE_EVENT, closedPayload("merge"), BASE)).toBeUndefined();
    expect(gitlabClosedPr(GITLAB_MR_EVENT, { object_kind: "merge_request" }, BASE)).toBeUndefined();
  });
});

// ---------- the delivery handler, through webhook.ts's follow-up ----------
interface Post {
  channel: string;
  thread_ts?: string;
  text: string;
}

async function setup(configure?: (c: Config) => void) {
  resetWebhookStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-gitlab-webhook-")));
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = { botToken: "xoxb-secret-token", signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    c.gitlab = { token: "glpat-secret-token-0123456789", baseUrl: BASE, username: "army-bot", userId: SELF_ID, allowed: ["acme"], webhookSecret: "w".repeat(30) };
    configure?.(c);
  });
  const tasks = new TaskRepo(store);
  const posts: Post[] = [];
  const launched: string[] = [];
  const slack = {
    chat: {
      postMessage: async (m: Post) => {
        posts.push(m);
        return { ok: true, ts: `900.${posts.length}` };
      },
    },
  };
  const memberLookups: string[] = [];
  const deps = {
    configRepo,
    tasks,
    runner: { kind: "local" as const, launch: async (id: string) => void launched.push(id) },
    slack: () => slack as never,
    gitlab: (opts: { token: string; baseUrl: string }) => ({
      memberAccess: async (repo: string, id: number) => {
        memberLookups.push(`${opts.baseUrl} ${repo} ${id}`);
        return id === 5 ? 30 : undefined;
      },
    }),
  };
  const seedMr = async () => {
    await tasks.savePrThread(REPO, 7, { channel: "C1", threadTs: "100.1" });
    await tasks.saveThread("C1", "100.1", { repo: REPO, branch: "army/login-abc123", prUrl: MR_URL, prNumber: 7, requester: "U_REQ", lastRunAt: new Date().toISOString() });
    const now = new Date().toISOString();
    await tasks.save({ id: newTaskId(Date.now() - 60_000), createdAt: now, updatedAt: now, status: "done", repo: REPO, channel: "C1", threadTs: "100.1", userId: "U_TASK", instruction: "add login" });
  };
  const newTasks = async () => (await tasks.recent()).filter((t) => t.trigger === "review");
  return { configRepo, tasks, posts, launched, deps, seedMr, newTasks, memberLookups };
}

describe("handleGitlabDelivery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a follow-up in the merge request's Slack thread for a comment addressed to Pointer", async () => {
    const t = await setup();
    await t.seedMr();
    await handleGitlabDelivery(GITLAB_NOTE_EVENT, notePayload(), t.deps);
    expect(t.memberLookups).toEqual([`${BASE} ${REPO} 5`]);
    expect(t.posts).toEqual([{ channel: "C1", thread_ts: "100.1", text: `:speech_balloon: *octo-dev* asked Pointer on <${MR_URL}|PR #7>. The team is on it…` }]);
    const [task] = await t.newTasks();
    expect(task).toMatchObject({
      id: t.launched[0],
      status: "queued",
      repo: REPO,
      userId: "U_REQ",
      instruction: "Address the feedback from octo-dev on merge request #7 (GitLab).\n\n> @pointer please add a test for the empty case",
    });
  });

  it("starts a follow-up when a reviewer requests changes", async () => {
    const t = await setup();
    await t.seedMr();
    await handleGitlabDelivery(GITLAB_MR_EVENT, reviewPayload(), t.deps);
    expect(t.posts[0]!.text).toBe(`:speech_balloon: *octo-dev* requested changes on <${MR_URL}|PR #7>. The team is on it…`);
    expect(await t.newTasks()).toHaveLength(1);
  });

  it("does nothing for merge requests the team did not open, outside the allow list, or without a connection", async () => {
    const t = await setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGitlabDelivery(GITLAB_NOTE_EVENT, notePayload(), t.deps);
    await handleGitlabDelivery(GITLAB_NOTE_EVENT, notePayload({ path: "other/web" }), t.deps);
    await t.configRepo.update((c) => void (c.gitlab.token = undefined));
    await handleGitlabDelivery(GITLAB_NOTE_EVENT, notePayload(), t.deps);
    expect(t.posts).toEqual([]);
    expect(t.launched).toEqual([]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[github] gitlab note gitlab:acme/web#7: ignored: not a pull request the team opened");
    expect(lines).toContain("[github] gitlab note gitlab:other/web#7: ignored: repository not allowed");
    expect(lines).toContain("[gitlab] gitlab note: ignored: GitLab not connected");
  });

  it("hands merged merge requests on as closed pull requests", async () => {
    const t = await setup();
    await t.seedMr();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGitlabDelivery(GITLAB_MR_EVENT, closedPayload("merge"), t.deps);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain("[github] gitlab merge_request gitlab:acme/web#7: ignored: no ticket");
    expect(t.memberLookups).toEqual([]);
    expect(t.posts).toEqual([]);
  });
});

// ---------- the routes ----------
describe("GitLab routes", () => {
  let base = "";
  let cookie = "";
  let close: () => void;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-gitlab-http-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local", PUBLIC_URL: "https://army.example.com/" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await realFetch(`${base}/api/setup`, {
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

  const post = (path: string, body: unknown) =>
    realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const state = async () => (await (await realFetch(`${base}/api/state`, { headers: { cookie } })).json()).config.gitlab;
  const deliver = (event: string | null, payload: unknown, opts: { token?: string | null; id?: string; raw?: string } = {}) =>
    realFetch(`${base}/gitlab/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(event === null ? {} : { "x-gitlab-event": event }),
        ...(opts.token === null ? {} : { "x-gitlab-token": opts.token ?? secret }),
        "webhook-id": opts.id ?? crypto.randomUUID(),
      },
      body: opts.raw ?? JSON.stringify(payload),
    });
  let secret = "";

  /** GitLab's API answers from `routes` (path after /api/v4 → [status, body]); the test's own requests pass through. */
  const stubGitLab = (routes: Record<string, [number, unknown]>) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${BASE}/api/v4`)) return realFetch(input, init);
      const key = `${init?.method ?? "GET"} ${url.slice(`${BASE}/api/v4`.length)}`;
      calls.push(key);
      const [status, body] = routes[key] ?? [404, { message: "404 Not Found" }];
      return new Response(JSON.stringify(body), { status });
    });
    return calls;
  };

  it("refuses deliveries and the webhook until GitLab is connected", async () => {
    expect((await deliver(GITLAB_NOTE_EVENT, notePayload(), { token: "x".repeat(30) })).status).toBe(404);
    const res = await post("/api/gitlab/webhook", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Connect GitLab first." });
    expect((await post("/api/gitlab/disconnect", {})).status).toBe(404);
  });

  it("validates what it saves", async () => {
    const bad = async (body: unknown, error: RegExp) => {
      const res = await post("/api/gitlab", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(error);
    };
    await bad({}, /Paste a GitLab access token/);
    await bad({ token: "short" }, /doesn't look like a GitLab token/);
    await bad({ token: "glpat-0123456789abcdefghij", baseUrl: "http://gitlab.example.com" }, /starts with https:\/\//);
    await bad({ token: "glpat-0123456789abcdefghij", baseUrl: "https://gitlab.example.com/?x=1" }, /starts with https:\/\//);
    await bad({ token: "glpat-0123456789abcdefghij", allowed: ["acme/../x"] }, /groups .* or projects/);
    await bad({ token: "glpat-0123456789abcdefghij", allowed: ["acme web"] }, /groups .* or projects/);
  });

  it("connects, normalising the address and the allow list, without returning the token", async () => {
    const res = await post("/api/gitlab", { token: " glpat-0123456789abcdefghij ", baseUrl: `${BASE}/`, allowed: ["gitlab:acme/web", "/acme/platform/", "acme/web.git"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, username: "test", baseUrl: BASE, allowed: ["acme/web", "acme/platform"] });
    expect(JSON.stringify(body)).not.toContain("glpat-");
    const gitlab = await state();
    expect(gitlab).toMatchObject({ connected: true, baseUrl: BASE, username: "test", key: "••••ghij", allowed: ["acme/web", "acme/platform"], webhook: { configured: false } });
    expect(JSON.stringify(gitlab)).not.toContain("glpat-");

    // The allow list changes without the token; the address does not.
    expect((await post("/api/gitlab", { allowed: ["acme"] })).status).toBe(200);
    expect((await state()).allowed).toEqual(["acme"]);
    const moved = await post("/api/gitlab", { baseUrl: "https://gitlab.other.example.com" });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/Paste the token again/);
  });

  it("makes a webhook secret, returns it once, and checks deliveries against it", async () => {
    const res = await post("/api/gitlab/webhook", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, url: "https://army.example.com/gitlab/webhook" });
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    secret = body.secret;
    expect((await state()).webhook).toEqual({ configured: true });
    expect(JSON.stringify(await state())).not.toContain(secret);
    const info = await (await realFetch(`${base}/api/gitlab/webhook`, { headers: { cookie } })).json();
    expect(info).toEqual({ url: "https://army.example.com/gitlab/webhook", configured: true });

    const missing = await deliver(GITLAB_NOTE_EVENT, notePayload(), { token: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Invalid token." });
    expect((await deliver(GITLAB_NOTE_EVENT, notePayload(), { token: `${secret}x` })).status).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it("answers 200 at once and hands each delivery on once", async () => {
    const started = Date.now();
    const res = await deliver(GITLAB_NOTE_EVENT, notePayload(), { id: "d-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(handled).toEqual([{ event: GITLAB_NOTE_EVENT, payload: notePayload() }]);

    const again = await deliver(GITLAB_NOTE_EVENT, notePayload(), { id: "d-1" });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect((await deliver(GITLAB_MR_EVENT, closedPayload("merge"), { id: "d-2" })).status).toBe(200);
    expect(handled.map((h) => h.event)).toEqual([GITLAB_NOTE_EVENT, GITLAB_MR_EVENT]);
  });

  it("answers other events without handing them on, and rejects bad bodies or headers", async () => {
    const push = await deliver("Push Hook", { object_kind: "push" });
    expect(push.status).toBe(200);
    expect(await push.json()).toEqual({ ok: true, ignored: true });
    expect((await deliver(null, notePayload())).status).toBe(400);
    expect((await deliver("Note Hook<script>", notePayload())).status).toBe(400);
    expect((await deliver(GITLAB_NOTE_EVENT, null, { raw: "{not json" })).status).toBe(400);
    expect(handled).toHaveLength(0);
  });

  it("adds the webhook to the allowed projects and reports the ones it could not", async () => {
    expect((await post("/api/gitlab", { allowed: ["acme/web", "acme/api", "acme", "acme/locked"] })).status).toBe(200);
    const calls = stubGitLab({
      "GET /projects/acme%2Fweb": [200, { id: 1 }],
      "GET /projects/acme%2Fweb/hooks?per_page=100": [200, []],
      "POST /projects/acme%2Fweb/hooks": [201, { id: 9 }],
      "GET /projects/acme%2Fapi": [200, { id: 2 }],
      "GET /projects/acme%2Fapi/hooks?per_page=100": [200, [{ id: 4, url: "https://army.example.com/gitlab/webhook" }]],
      "PUT /projects/acme%2Fapi/hooks/4": [200, { id: 4 }],
      "GET /namespaces/acme": [200, { id: 3, kind: "group" }],
      "GET /projects/acme%2Flocked": [200, { id: 5 }],
      "GET /projects/acme%2Flocked/hooks?per_page=100": [403, { message: "403 Forbidden" }],
    });
    const res = await post("/api/gitlab/webhook", { installHooks: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hooks).toEqual([
      { path: "acme/web", ok: true, action: "created" },
      { path: "acme/api", ok: true, action: "updated" },
      { path: "acme", ok: false, error: expect.stringMatching(/A group or user, not a project/) },
      { path: "acme/locked", ok: false, error: expect.stringMatching(/Maintainer role/) },
    ]);
    expect(calls).toContain("POST /projects/acme%2Fweb/hooks");
    secret = body.secret;
    // The old secret stopped working.
    expect((await deliver(GITLAB_NOTE_EVENT, notePayload(), { token: secret })).status).toBe(200);
  });

  it("checks a new token with GitLab before saving it", async () => {
    process.env.SKIP_VALIDATION = "0";
    stubGitLab({ "GET /user": [401, { message: "401 Unauthorized" }] });
    let res = await post("/api/gitlab", { token: "glpat-rejected-0123456789", baseUrl: BASE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/GitLab rejected this token/);

    stubGitLab({ "GET /user": [200, { id: 42, username: "army-bot" }], "GET /personal_access_tokens/self": [200, { scopes: ["read_api"] }] });
    res = await post("/api/gitlab", { token: "glpat-readonly-0123456789", baseUrl: BASE });
    expect((await res.json()).error).toMatch(/needs the api scope \(it has read_api\)/);

    stubGitLab({ "GET /user": [200, { id: 42, username: "army-bot" }], "GET /personal_access_tokens/self": [200, { scopes: ["api"] }] });
    res = await post("/api/gitlab", { token: "glpat-good-0123456789abc", baseUrl: BASE, allowed: ["acme/missing"] });
    expect((await res.json()).error).toMatch(/cannot see acme\/missing/);

    stubGitLab({
      "GET /user": [200, { id: 42, username: "army-bot" }],
      "GET /personal_access_tokens/self": [200, { scopes: ["api", "write_repository"] }],
      "GET /namespaces/acme": [200, { id: 3 }],
    });
    res = await post("/api/gitlab", { token: "glpat-good-0123456789abc", baseUrl: BASE, allowed: ["acme"] });
    expect(await res.json()).toEqual({ ok: true, username: "army-bot", baseUrl: BASE, allowed: ["acme"] });
    expect(await state()).toMatchObject({ connected: true, username: "army-bot", webhook: { configured: true } });
  });

  it("removes the webhook secret, then disconnects", async () => {
    const removed = await post("/api/gitlab/webhook", { remove: true });
    expect(await removed.json()).toEqual({ ok: true, url: "https://army.example.com/gitlab/webhook", removed: true });
    expect((await deliver(GITLAB_NOTE_EVENT, notePayload())).status).toBe(404);

    expect((await post("/api/gitlab/webhook", {})).status).toBe(200);
    expect((await post("/api/gitlab/disconnect", {})).status).toBe(200);
    expect(await state()).toMatchObject({ connected: false, username: null, key: null, baseUrl: BASE, allowed: ["acme"], webhook: { configured: false } });
    expect((await deliver(GITLAB_NOTE_EVENT, notePayload())).status).toBe(404);
  });
});
