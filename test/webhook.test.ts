import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Config, ConfigRepo } from "../src/config.js";
import { deriveKey } from "../src/crypto.js";
import { BOT_MARKER } from "../src/github.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/store.js";
import { type Task, TaskRepo, newTaskId } from "../src/tasks.js";
import type * as Webhook from "../src/webhook.js";

// The server hands verified deliveries to handleGithubWebhook; record them there
// (and never settle) so the HTTP tests prove the route answers without waiting.
const handled = vi.hoisted(() => [] as Array<{ event: string; payload: unknown }>);
vi.mock("../src/webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Webhook>();
  return {
    ...actual,
    handleGithubWebhook: (event: string, payload: unknown) => {
      handled.push({ event, payload });
      return new Promise<void>(() => {});
    },
  };
});
const { handleGithubWebhook, reviewTrigger, addressesPointer, reviewInstruction, verifyGithubSignature, resetWebhookStateForTests, EXCERPT_MAX_CHARS } =
  await vi.importActual<typeof Webhook>("../src/webhook.js");

const SECRET = "whsec-test-0123456789abcdef";
const PR_URL = "https://github.com/acme/web/pull/7";

// ---------- payloads ----------
interface Who {
  login?: string;
  type?: string;
  association?: string;
}

function reviewPayload(opts: { state?: string; action?: string; body?: string | null; prState?: string; repo?: string; number?: number; sender?: Who; author?: Who } = {}) {
  const repo = opts.repo ?? "acme/web";
  const number = opts.number ?? 7;
  const author = { login: "octocat", type: "User", association: "MEMBER", ...opts.author };
  return {
    action: opts.action ?? "submitted",
    review: {
      id: 1,
      state: opts.state ?? "changes_requested",
      body: opts.body === undefined ? "Please rename the helper." : opts.body,
      user: { login: author.login, type: author.type },
      author_association: author.association,
      html_url: `https://github.com/${repo}/pull/${number}#pullrequestreview-1`,
    },
    pull_request: { number, state: opts.prState ?? "open", html_url: `https://github.com/${repo}/pull/${number}` },
    repository: { full_name: repo },
    sender: { login: author.login, type: author.type, ...opts.sender },
  };
}

function commentPayload(opts: { body?: string; action?: string; onIssue?: boolean; prState?: string; repo?: string; number?: number; author?: Who } = {}) {
  const repo = opts.repo ?? "acme/web";
  const number = opts.number ?? 7;
  const author = { login: "octocat", type: "User", association: "OWNER", ...opts.author };
  return {
    action: opts.action ?? "created",
    issue: {
      number,
      state: opts.prState ?? "open",
      html_url: `https://github.com/${repo}/${opts.onIssue ? "issues" : "pull"}/${number}`,
      ...(opts.onIssue ? {} : { pull_request: { html_url: `https://github.com/${repo}/pull/${number}` } }),
    },
    comment: { id: 2, body: opts.body ?? "@pointer please add a test for the empty case", user: { login: author.login, type: author.type }, author_association: author.association },
    repository: { full_name: repo },
    sender: { login: author.login, type: author.type },
  };
}

// ---------- the pure decision ----------
describe("reviewTrigger", () => {
  const decide = (event: string, payload: unknown, pointerName = "Pointer") => reviewTrigger(event, payload, { pointerName });

  it("starts for a submitted review that requests changes or comments", () => {
    expect(decide("pull_request_review", reviewPayload())).toEqual({
      start: true,
      repo: "acme/web",
      prNumber: 7,
      prUrl: PR_URL,
      login: "octocat",
      kind: "changes_requested",
      excerpt: "Please rename the helper.",
    });
    expect(decide("pull_request_review", reviewPayload({ state: "commented", body: null }))).toMatchObject({ start: true, kind: "commented", excerpt: "" });
    expect(decide("pull_request_review", reviewPayload({ state: "CHANGES_REQUESTED" }))).toMatchObject({ start: true, kind: "changes_requested" });
  });

  it("ignores approvals, dismissals, other review actions and inline comments", () => {
    expect(decide("pull_request_review", reviewPayload({ state: "approved" }))).toMatchObject({ start: false, repo: "acme/web" });
    expect(decide("pull_request_review", reviewPayload({ state: "dismissed" }))).toMatchObject({ start: false });
    expect(decide("pull_request_review", reviewPayload({ action: "edited" }))).toMatchObject({ start: false });
    expect(decide("pull_request_review", reviewPayload({ action: "dismissed" }))).toMatchObject({ start: false });
    expect(decide("pull_request_review_comment", { action: "created", repository: { full_name: "acme/web" } })).toEqual({
      start: false,
      reason: "inline comments arrive with their review",
      repo: "acme/web",
    });
    expect(decide("push", { repository: { full_name: "acme/web" } })).toMatchObject({ start: false, reason: "event not handled" });
    expect(decide("pull_request_review", { action: "submitted" })).toEqual({ start: false, reason: "unexpected payload" });
    expect(decide("pull_request_review", null)).toMatchObject({ start: false });
  });

  it("starts for a pull request comment only when it addresses Pointer", () => {
    expect(decide("issue_comment", commentPayload())).toEqual({
      start: true,
      repo: "acme/web",
      prNumber: 7,
      prUrl: PR_URL,
      login: "octocat",
      kind: "asked",
      excerpt: "@pointer please add a test for the empty case",
    });
    expect(decide("issue_comment", commentPayload({ body: "Looks good to me" }))).toMatchObject({ start: false, reason: "comment does not address Pointer" });
    expect(decide("issue_comment", commentPayload({ onIssue: true }))).toMatchObject({ start: false, reason: "comment on an issue, not a pull request" });
    expect(decide("issue_comment", commentPayload({ action: "edited" }))).toMatchObject({ start: false });
    expect(decide("issue_comment", commentPayload({ action: "deleted" }))).toMatchObject({ start: false });
  });

  it("recognises /pointer and @pointer in any case, and the configured name", () => {
    for (const body of ["/pointer fix the typo", "  /POINTER fix it", "/Pointer", "hey @Pointer, rename this", "@pointer: please", "(@pointer) see above", "cc @pointer."]) {
      expect(addressesPointer(body, "Pointer"), body).toBe(true);
    }
    for (const body of ["pointer is a great name", "/pointers", "@pointerbot fix", "@pointer-bot fix", "mail me@pointer.dev", "see `/pointer`?", "x /pointer fix", "> @pointer fix this\nI disagree"]) {
      expect(addressesPointer(body, "Pointer"), body).toBe(false);
    }
    expect(addressesPointer("@scoutbot please fix", "Scout Bot")).toBe(true);
    expect(addressesPointer("/SCOUTBOT fix", "Scout Bot")).toBe(true);
    expect(addressesPointer("@pointer still works", "Scout Bot")).toBe(true);
    expect(addressesPointer("@scout fix", "Scout Bot")).toBe(false);
    expect(addressesPointer("@a.b fix", "A.B")).toBe(true);
    expect(addressesPointer("@axb fix", "A.B")).toBe(false);
  });

  it("filters bots, people without write access, the platform's own posts and closed pull requests", () => {
    const review = (opts: Parameters<typeof reviewPayload>[0]) => decide("pull_request_review", reviewPayload(opts));
    expect(review({ sender: { type: "Bot" } })).toMatchObject({ start: false, reason: "sent by a bot" });
    expect(review({ author: { login: "renovate[bot]", type: "Bot" } })).toMatchObject({ start: false, reason: "sent by a bot" });
    for (const association of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", ""]) {
      expect(review({ author: { association } })).toMatchObject({ start: false, reason: "author has no write access" });
      expect(decide("issue_comment", commentPayload({ author: { association } }))).toMatchObject({ start: false, reason: "author has no write access" });
    }
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(review({ author: { association } })).toMatchObject({ start: true });
    expect(review({ body: `Fixed in abc123\n\n${BOT_MARKER}` })).toMatchObject({ start: false, reason: "posted by the platform" });
    expect(decide("issue_comment", commentPayload({ body: `@pointer done ${BOT_MARKER}` }))).toMatchObject({ start: false, reason: "posted by the platform" });
    expect(review({ prState: "closed" })).toMatchObject({ start: false, reason: "pull request is not open" });
    expect(decide("issue_comment", commentPayload({ prState: "closed" }))).toMatchObject({ start: false, reason: "pull request is not open" });
  });

  it("keeps the excerpt to 2000 characters and falls back to a safe PR link", () => {
    const long = decide("pull_request_review", reviewPayload({ body: "a".repeat(5000) }));
    if (!long.start) throw new Error(long.reason);
    expect(long.excerpt).toHaveLength(EXCERPT_MAX_CHARS);
    expect(long.excerpt.endsWith("…")).toBe(true);

    const payload = reviewPayload();
    payload.pull_request.html_url = "https://evil.example/x|<!channel>";
    expect(decide("pull_request_review", payload)).toMatchObject({ start: true, prUrl: PR_URL });
    expect(decide("pull_request_review", reviewPayload({ author: { login: "<!channel>" } }))).toMatchObject({ start: false });
    expect(decide("pull_request_review", reviewPayload({ repo: "../etc" }))).toMatchObject({ start: false, reason: "unexpected payload" });
  });

  it("builds the follow-up instruction with the quoted feedback", () => {
    expect(reviewInstruction({ login: "octocat", prNumber: 7, excerpt: "Rename it.\n\nAnd add a test." })).toBe(
      "Address the feedback from octocat on pull request #7 (GitHub).\n\n> Rename it.\n>\n> And add a test.",
    );
    expect(reviewInstruction({ login: "octocat", prNumber: 7, excerpt: "" })).toBe("Address the feedback from octocat on pull request #7 (GitHub).");
  });
});

describe("verifyGithubSignature", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  const sign = (b: Buffer, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("accepts the right signature and rejects everything else", () => {
    expect(verifyGithubSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyGithubSignature(SECRET, body, sign(body).toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
    expect(verifyGithubSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, "")).toBe(false);
    expect(verifyGithubSignature(SECRET, body, sign(body, "another-secret-0123456789"))).toBe(false);
    expect(verifyGithubSignature(SECRET, Buffer.from(body.toString() + " "), sign(body))).toBe(false);
    expect(verifyGithubSignature(SECRET, body, sign(body).slice(0, -2))).toBe(false);
    expect(verifyGithubSignature(SECRET, body, `${sign(body)}00`)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, sign(body).replace("sha256=", "sha1="))).toBe(false);
  });
});

// ---------- the handler, with a fake Slack and runner ----------
interface Post {
  channel: string;
  thread_ts?: string;
  text: string;
}

async function setup(configure?: (c: Config) => void) {
  resetWebhookStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-webhook-")));
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = { botToken: "xoxb-secret-token", signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    c.github = { token: "ghp_secret_token", allowedOwners: ["acme"], extra: [], webhookSecret: SECRET };
    configure?.(c);
  });
  const tasks = new TaskRepo(store);
  const posts: Post[] = [];
  const launched: string[] = [];
  const state: { launchError?: Error } = {};
  const slack = {
    chat: {
      postMessage: async (m: Post) => {
        posts.push(m);
        return { ok: true, ts: `900.${posts.length}` };
      },
    },
  };
  const deps = {
    configRepo,
    tasks,
    runner: {
      kind: "local" as const,
      launch: async (id: string) => {
        if (state.launchError) throw state.launchError;
        launched.push(id);
      },
    },
    slack: () => slack as never,
  };
  /** A task the team opened PR #7 of acme/web with, in Slack thread C1/100.1. */
  const seedPr = async (opts: { requester?: string; status?: Task["status"]; repo?: string } = {}) => {
    const repo = opts.repo ?? "acme/web";
    await tasks.savePrThread(repo, 7, { channel: "C1", threadTs: "100.1" });
    await tasks.saveThread("C1", "100.1", {
      repo,
      branch: "army/rename-abc123",
      prUrl: `https://github.com/${repo}/pull/7`,
      prNumber: 7,
      ...(opts.requester ? { requester: opts.requester } : {}),
      lastRunAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await tasks.save({
      id: newTaskId(Date.now() - 60_000),
      createdAt: now,
      updatedAt: now,
      status: opts.status ?? "done",
      repo,
      channel: "C1",
      threadTs: "100.1",
      userId: "U_TASK",
      instruction: "rename the helper",
    });
  };
  const run = (event: string, payload: unknown) => handleGithubWebhook(event, payload, deps);
  const newTasks = async () => (await tasks.recent()).filter((t) => t.trigger === "review");
  return { configRepo, tasks, posts, launched, state, deps, seedPr, run, newTasks };
}

describe("handleGithubWebhook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a follow-up for a review that requests changes, in the PR's Slack thread", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ" });
    await t.run("pull_request_review", reviewPayload());

    expect(t.posts).toEqual([
      { channel: "C1", thread_ts: "100.1", text: `:speech_balloon: *octocat* requested changes on <${PR_URL}|PR #7>. The team is on it…` },
    ]);
    expect(t.launched).toHaveLength(1);
    const [task] = await t.newTasks();
    expect(task).toMatchObject({
      id: t.launched[0],
      status: "queued",
      trigger: "review",
      repo: "acme/web",
      channel: "C1",
      threadTs: "100.1",
      progressTs: "900.1",
      userId: "U_REQ",
      instruction: "Address the feedback from octocat on pull request #7 (GitHub).\n\n> Please rename the helper.",
    });
  });

  it("says 'commented on' for a comment review and uses the last task's requester when the thread has none", async () => {
    const t = await setup();
    await t.seedPr();
    await t.run("pull_request_review", reviewPayload({ state: "commented", body: "" }));
    expect(t.posts[0]!.text).toBe(`:speech_balloon: *octocat* commented on <${PR_URL}|PR #7>. The team is on it…`);
    const [task] = await t.newTasks();
    expect(task).toMatchObject({ userId: "U_TASK", instruction: "Address the feedback from octocat on pull request #7 (GitHub)." });
  });

  it("starts a follow-up for a pull request comment addressed to Pointer by its configured name", async () => {
    const t = await setup((c) => void (c.team.pointer.name = "Scout"));
    await t.seedPr({ requester: "U_REQ" });
    await t.run("issue_comment", commentPayload({ body: "Looks good otherwise" }));
    expect(t.posts).toHaveLength(0);

    await t.run("issue_comment", commentPayload({ body: "/scout please add a test for the empty case" }));
    expect(t.posts).toEqual([
      { channel: "C1", thread_ts: "100.1", text: `:speech_balloon: *octocat* asked Scout on <${PR_URL}|PR #7>. The team is on it…` },
    ]);
    const [task] = await t.newTasks();
    expect(task).toMatchObject({
      trigger: "review",
      userId: "U_REQ",
      instruction: "Address the feedback from octocat on pull request #7 (GitHub).\n\n> /scout please add a test for the empty case",
    });
    expect(t.launched).toEqual([task!.id]);
  });

  it("uses the thread's spelling of the repo", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ", repo: "Acme/Web" });
    await t.run("pull_request_review", reviewPayload({ repo: "acme/web" }));
    expect((await t.newTasks())[0]).toMatchObject({ repo: "Acme/Web" });
  });

  it("only notes the feedback in Slack while a task is still running in the thread", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ", status: "running" });
    await t.run("pull_request_review", reviewPayload());
    expect(t.posts).toEqual([
      {
        channel: "C1",
        thread_ts: "100.1",
        text: `:speech_balloon: octocat reviewed <${PR_URL}|PR #7> while the team is still working. When this run ends, reply here (for example "address the review") and the team will pick it up.`,
      },
    ]);
    expect(t.launched).toHaveLength(0);
    expect(await t.newTasks()).toHaveLength(0);
  });

  it("starts one follow-up for two reviews arriving together, and notes the second", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ" });
    await Promise.all([t.run("pull_request_review", reviewPayload()), t.run("issue_comment", commentPayload())]);
    expect(t.launched).toHaveLength(1);
    expect(await t.newTasks()).toHaveLength(1);
    expect(t.posts).toHaveLength(2);
    expect(t.posts.filter((p) => p.text.endsWith("The team is on it…"))).toHaveLength(1);
    expect(t.posts.filter((p) => p.text.includes("while the team is still working"))).toHaveLength(1);
  });

  const ignored: Array<{ what: string; event: string; payload: unknown; configure?: (c: Config) => void }> = [
    { what: "a bot", event: "pull_request_review", payload: reviewPayload({ sender: { type: "Bot" } }) },
    { what: "a review without write access", event: "pull_request_review", payload: reviewPayload({ author: { association: "CONTRIBUTOR" } }) },
    { what: "a comment without write access", event: "issue_comment", payload: commentPayload({ author: { association: "NONE" } }) },
    { what: "the platform's own comment", event: "issue_comment", payload: commentPayload({ body: `@pointer fixed\n${BOT_MARKER}` }) },
    { what: "an approval", event: "pull_request_review", payload: reviewPayload({ state: "approved" }) },
    { what: "a dismissed review", event: "pull_request_review", payload: reviewPayload({ state: "dismissed" }) },
    { what: "an inline comment", event: "pull_request_review_comment", payload: { action: "created", repository: { full_name: "acme/web" } } },
    { what: "a comment on an issue", event: "issue_comment", payload: commentPayload({ onIssue: true }) },
    { what: "a comment not addressed to Pointer", event: "issue_comment", payload: commentPayload({ body: "nice work" }) },
    { what: "a closed pull request", event: "pull_request_review", payload: reviewPayload({ prState: "closed" }) },
    { what: "a pull request the team did not open", event: "pull_request_review", payload: reviewPayload({ number: 8 }) },
    {
      what: "a repository outside the allow lists",
      event: "pull_request_review",
      payload: reviewPayload(),
      configure: (c) => void (c.github.allowedOwners = ["other-org"]),
    },
    { what: "a workspace without Slack", event: "pull_request_review", payload: reviewPayload(), configure: (c) => void (c.slack.botToken = undefined) },
  ];
  for (const { what, event, payload, configure } of ignored) {
    it(`does nothing for ${what}`, async () => {
      const t = await setup(configure);
      await t.seedPr({ requester: "U_REQ" });
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      await t.run(event, payload);
      expect(t.posts).toHaveLength(0);
      expect(t.launched).toHaveLength(0);
      expect(await t.newTasks()).toHaveLength(0);
      expect(logs).toHaveBeenCalledTimes(1);
      expect(String(logs.mock.calls[0]![0])).toMatch(new RegExp(`^\\[github\\] ${event}( \\S+)?: ignored: `));
    });
  }

  it("logs the event, repo and outcome, never the feedback", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ" });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await t.run("pull_request_review", reviewPayload({ body: "secret plans for the launch" }));
    await t.run("issue_comment", commentPayload({ body: "nothing for the bot here" }));
    const lines = logs.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[github\] pull_request_review acme\/web#7: started follow-up task \S+$/);
    expect(lines[1]).toBe("[github] issue_comment acme/web: ignored: comment does not address Pointer");
    expect(lines.join("\n")).not.toMatch(/secret plans|nothing for the bot|octocat/);
  });

  it("marks the follow-up failed and says so in the thread when the worker cannot start", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ" });
    t.state.launchError = new Error("quota exceeded for ghp_secret_token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await t.run("pull_request_review", reviewPayload());
    const [task] = await t.newTasks();
    expect(task).toMatchObject({ status: "failed", error: "Could not start a worker: quota exceeded for [redacted]" });
    expect(t.posts.map((p) => p.text)).toEqual([
      `:speech_balloon: *octocat* requested changes on <${PR_URL}|PR #7>. The team is on it…`,
      ":x: Could not start a worker: quota exceeded for [redacted]",
    ]);
  });

  it("never throws, and redacts secrets from unexpected errors", async () => {
    const t = await setup();
    await t.seedPr({ requester: "U_REQ" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = Object.assign(Object.create(t.tasks) as TaskRepo, {
      getPrThread: async () => Promise.reject(new Error(`disk full ${SECRET} xoxb-secret-token`)),
    });
    const broken = { ...t.deps, tasks: failing };
    await expect(handleGithubWebhook("pull_request_review", reviewPayload(), broken)).resolves.toBeUndefined();
    const line = errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(line).toContain("[github] pull_request_review failed: disk full");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("xoxb-secret-token");

    const noConfig = { ...t.deps, configRepo: { load: async () => Promise.reject(new Error("disk")) } as never };
    await expect(handleGithubWebhook("pull_request_review", reviewPayload(), noConfig)).resolves.toBeUndefined();
    expect(t.launched).toHaveLength(0);
  });
});

// ---------- the HTTP route ----------
describe("POST /github/webhook", () => {
  let base = "";
  let cookie = "";
  let close: () => void;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-webhook-http-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
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
  afterEach(() => void (handled.length = 0));

  const setSecret = (secret: string) =>
    fetch(`${base}/api/github/webhook`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ secret }) });
  const deliver = (event: string, payload: unknown, opts: { delivery?: string; secret?: string; signature?: string | null; contentType?: string; raw?: string } = {}) => {
    const body = opts.raw ?? JSON.stringify(payload);
    const signature = opts.signature === undefined ? `sha256=${createHmac("sha256", opts.secret ?? SECRET).update(body).digest("hex")}` : opts.signature;
    return fetch(`${base}/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": opts.contentType ?? "application/json",
        "x-github-event": event,
        "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
        ...(signature === null ? {} : { "x-hub-signature-256": signature }),
      },
      body,
    });
  };

  it("is 404 until a secret is configured", async () => {
    const res = await deliver("ping", { zen: "hi" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "GitHub webhook is not configured" });
    expect((await setSecret(SECRET)).status).toBe(200);
  });

  it("rejects a missing or wrong signature", async () => {
    const missing = await deliver("pull_request_review", reviewPayload(), { signature: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Invalid signature." });
    expect((await deliver("pull_request_review", reviewPayload(), { secret: "wrong-secret-0123456789abcd" })).status).toBe(401);
    expect((await deliver("pull_request_review", reviewPayload(), { signature: "sha256=abc" })).status).toBe(401);
    expect((await deliver("pull_request_review", reviewPayload(), { signature: "sha1=0123456789abcdef0123456789abcdef01234567" })).status).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it("answers ping without handing it on", async () => {
    const res = await deliver("ping", { zen: "Design for failure.", hook_id: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handled).toHaveLength(0);
  });

  it("answers 202 at once and hands the delivery on, once per delivery id", async () => {
    const started = Date.now();
    const res = await deliver("pull_request_review", reviewPayload(), { delivery: "d-1" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(handled).toEqual([{ event: "pull_request_review", payload: reviewPayload() }]);

    const again = await deliver("pull_request_review", reviewPayload(), { delivery: "d-1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(handled).toHaveLength(1);

    expect((await deliver("issue_comment", commentPayload(), { delivery: "d-2" })).status).toBe(202);
    expect(handled.map((h) => h.event)).toEqual(["pull_request_review", "issue_comment"]);
  });

  it("reads form-encoded deliveries and rejects bad bodies or event names", async () => {
    const raw = new URLSearchParams({ payload: JSON.stringify(commentPayload()) }).toString();
    const form = await deliver("issue_comment", undefined, { raw, contentType: "application/x-www-form-urlencoded" });
    expect(form.status).toBe(202);
    expect(handled).toEqual([{ event: "issue_comment", payload: commentPayload() }]);

    expect((await deliver("issue_comment", undefined, { raw: "{not json" })).status).toBe(400);
    expect((await deliver("Not An Event", reviewPayload())).status).toBe(400);
    expect(handled).toHaveLength(1);
  });

  it("stops accepting deliveries when the secret is removed", async () => {
    expect((await setSecret("")).status).toBe(200);
    expect((await deliver("ping", {})).status).toBe(404);
  });
});
