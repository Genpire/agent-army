import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_MARKER, FILE_MAX_CHARS, LOG_MAX_CHARS, type CheckInfo, isHumanFeedback } from "../src/github.js";
import { GitLab, GitLabError, associationForAccess, draftTitle, isGitLabBot, neutralizeQuickActions, stripDraft } from "../src/gitlab.js";

const TOKEN = "glpat-test-token-0123456789abcdef";
const BASE = "https://gitlab.example.com";
const API = `${BASE}/api/v4`;
const REPO = "gitlab:acme/platform/web";
const PROJECT = "acme%2Fplatform%2Fweb";

interface Call {
  method: string;
  /** Path and query after /api/v4. */
  path: string;
  headers: Headers;
  body?: unknown;
}

interface Route {
  method?: string;
  /** Exact path and query after /api/v4, or a pattern over it. */
  path: string | RegExp;
  status?: number;
  body?: unknown;
  /** A raw body instead of JSON. */
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
}

/** A fake GitLab API: each call gets the first matching route (404 when none), and is recorded. */
function fakeGitLab(routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(API)).toBe(true);
    const path = url.slice(API.length);
    const method = init?.method ?? "GET";
    calls.push({ method, path, headers: new Headers(init?.headers), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes.find(
      (r) => (r.method ?? "GET") === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)),
    );
    if (!route) return new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 });
    const body = route.raw ?? JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return calls;
}

const client = () => new GitLab({ token: TOKEN, baseUrl: `${BASE}/` });

const mr = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  project_id: 11,
  source_project_id: 11,
  title: "Add login",
  state: "opened",
  draft: false,
  web_url: `${BASE}/acme/platform/web/-/merge_requests/7`,
  source_branch: "army/login-abc123",
  target_branch: "main",
  sha: "abc123",
  author: { id: 5, username: "octo-dev" },
  updated_at: "2026-11-01T10:00:00Z",
  merged_at: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("GitLab helpers", () => {
  it("maps roles to GitHub's author associations", () => {
    expect(associationForAccess(50)).toBe("OWNER");
    expect(associationForAccess(40)).toBe("OWNER");
    expect(associationForAccess(30)).toBe("MEMBER");
    expect(associationForAccess(25)).toBe("NONE");
    expect(associationForAccess(20)).toBe("NONE");
    expect(associationForAccess(undefined)).toBe("NONE");
  });

  it("recognises token users and service accounts as bots", () => {
    expect(isGitLabBot({ username: "project_12_bot_3f9a1c" })).toBe(true);
    expect(isGitLabBot({ username: "group_4_bot_ab12" })).toBe(true);
    expect(isGitLabBot({ username: "service_account_group_4_ab12" })).toBe(true);
    expect(isGitLabBot({ username: "octo-dev", bot: true })).toBe(true);
    expect(isGitLabBot({ username: "octo-dev" })).toBe(false);
    expect(isGitLabBot({ username: "project_lead" })).toBe(false);
    expect(isGitLabBot(null)).toBe(false);
  });

  it("adds and strips draft prefixes", () => {
    expect(draftTitle("Add login")).toBe("Draft: Add login");
    expect(draftTitle("Draft: Add login")).toBe("Draft: Add login");
    for (const t of ["Draft: Add login", "[Draft] Add login", "(Draft) Add login", "draft:Add login", "Draft: [Draft] Add login", "WIP: Add login"]) {
      expect(stripDraft(t), t).toBe("Add login");
    }
    expect(stripDraft("Drafting the login")).toBe("Drafting the login");
  });
});

describe("GitLab client: git and identity", () => {
  it("clones over HTTPS and authenticates git with a header, never a URL", () => {
    const gl = client();
    expect(gl.cloneUrl(REPO)).toBe(`${BASE}/acme/platform/web.git`);
    const basic = Buffer.from(`oauth2:${TOKEN}`).toString("base64");
    expect(gl.gitAuthArgs()).toEqual(["-c", `http.${BASE}/.extraheader=Authorization: Basic ${basic}`]);
    expect(gl.gitAuthArgs().join(" ")).not.toContain(TOKEN);
    expect(gl.cloneUrl(REPO)).not.toContain(TOKEN);
    expect(gl.secrets()).toEqual(expect.arrayContaining([TOKEN, basic, `Basic ${basic}`]));
    expect(new GitLab({ token: TOKEN }).cloneUrl("gitlab:acme/web")).toBe("https://gitlab.com/acme/web.git");
  });

  it("reads the token's user, preferring its commit email", async () => {
    const calls = fakeGitLab([
      { path: "/user", body: { id: 42, username: "octo-dev", name: "Octo Dev", email: "private@example.com", commit_email: "octo@example.com", public_email: "" } },
    ]);
    const viewer = await client().viewer();
    expect(viewer).toEqual({ id: 42, login: "octo-dev", name: "Octo Dev", email: "octo@example.com" });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers.get("user-agent")).toBe("agent-army");
    expect(calls[0]!.path).not.toContain(TOKEN);
  });

  it("authors commits as the token's user, with the instance's noreply address when it has no commit email", () => {
    const gl = client();
    expect(gl.commitIdentity("Pointer", { id: 42, login: "octo-dev", email: "octo@example.com" })).toEqual({
      name: "Pointer (via octo-dev)",
      email: "octo@example.com",
    });
    expect(gl.commitIdentity("Pointer", { id: 42, login: "octo-dev" })).toEqual({
      name: "Pointer (via octo-dev)",
      email: "42-octo-dev@users.noreply.gitlab.example.com",
    });
    expect(new GitLab({ token: TOKEN }).commitIdentity("Pointer", { id: 42, login: "octo-dev" }).email).toBe("42-octo-dev@users.noreply.gitlab.com");
    expect(gl.commitIdentity("Pointer", undefined)).toEqual({ name: "Pointer", email: "pointer@agent-army.invalid" });
    expect(gl.commitIdentity("Pointer", { id: 0, login: "octo-dev" }).email).toBe("pointer@agent-army.invalid");
    expect(gl.commitIdentity("Pointer", { id: 42, login: "<bad>" }).email).toBe("pointer@agent-army.invalid");
  });

  it("encodes the project path as one id and refuses paths that could escape it", async () => {
    const calls = fakeGitLab([{ path: `/projects/${PROJECT}`, body: { default_branch: "main" } }]);
    expect(await client().defaultBranch(REPO)).toBe("main");
    expect(calls[0]!.path).toBe(`/projects/${PROJECT}`);
    await expect(client().defaultBranch("gitlab:acme/../secrets")).rejects.toThrow(/Not a GitLab project/);
    await expect(client().defaultBranch("gitlab:acme")).rejects.toThrow(/Not a GitLab project/);
    await expect(client().readFile(REPO, "src/../../etc/passwd")).rejects.toThrow(/Invalid path/);
  });

  it("raises errors with the HTTP status and without the token", async () => {
    fakeGitLab([{ path: `/projects/${PROJECT}`, status: 403, body: { message: "403 Forbidden" } }]);
    const err = await client().defaultBranch(REPO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect((err as GitLabError).status).toBe(403);
    expect((err as Error).message).toBe(`GitLab GET /projects/${PROJECT} failed (HTTP 403): {"message":"403 Forbidden"}`);
    expect((err as Error).message).not.toContain(TOKEN);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const offline = await client().defaultBranch(REPO).catch((e: unknown) => e);
    expect((offline as GitLabError).status).toBe(0);
    expect((offline as Error).message).toContain(`could not reach ${BASE}`);
  });
});

describe("GitLab client: merge requests", () => {
  it("opens a draft merge request with a Draft: title and maps it to a PrRef", async () => {
    const calls = fakeGitLab([{ method: "POST", path: `/projects/${PROJECT}/merge_requests`, body: mr({ title: "Draft: Add login", draft: true }) }]);
    const pr = await client().createPr(REPO, { title: "Add login", body: "What and why", head: "army/login-abc123", base: "main", draft: true });
    expect(pr).toEqual({ number: 7, html_url: `${BASE}/acme/platform/web/-/merge_requests/7`, node_id: "7", draft: true });
    expect(calls[0]!.body).toEqual({ source_branch: "army/login-abc123", target_branch: "main", title: "Draft: Add login", description: "What and why" });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("finds the open merge request of a branch, not a fork's", async () => {
    const calls = fakeGitLab([
      {
        path: `/projects/${PROJECT}/merge_requests?state=opened&source_branch=army%2Flogin-abc123&per_page=20`,
        body: [mr({ iid: 3, source_project_id: 99 }), mr()],
      },
    ]);
    expect(await client().findOpenPr(REPO, "army/login-abc123")).toMatchObject({ number: 7, draft: false });
    expect(calls).toHaveLength(1);
  });

  it("marks a draft ready by removing the prefix, and does nothing for one that is ready", async () => {
    const path = `/projects/${PROJECT}/merge_requests/7`;
    let calls = fakeGitLab([
      { path, body: mr({ title: "Draft: Add login", draft: true }) },
      { method: "PUT", path, body: mr({ title: "Add login", draft: false }) },
    ]);
    await client().markReady(REPO, { number: 7, html_url: "", node_id: "7", draft: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${path}`, `PUT ${path}`]);
    expect(calls[1]!.body).toEqual({ title: "Add login" });

    calls = fakeGitLab([{ path, body: mr() }]);
    await client().markReady(REPO, { number: 7, html_url: "", node_id: "7", draft: false });
    expect(calls).toHaveLength(1);

    fakeGitLab([
      { path, body: mr({ title: "Draft: Add login", draft: true }) },
      { method: "PUT", path, body: mr({ title: "Add login", draft: true }) },
    ]);
    await expect(client().markReady(REPO, { number: 7, html_url: "", node_id: "7", draft: true })).rejects.toThrow(/kept merge request !7 as a draft/);
  });

  it("keeps a draft a draft when its title changes", async () => {
    const path = `/projects/${PROJECT}/merge_requests/7`;
    const calls = fakeGitLab([
      { path, body: mr({ title: "Draft: Add login", draft: true }) },
      { method: "PUT", path, body: mr() },
    ]);
    await client().updatePr(REPO, 7, { title: "Add sign-in", body: "New text" });
    expect(calls[1]!.body).toEqual({ title: "Draft: Add sign-in", description: "New text" });
  });

  it("comments with the platform's marker and reads a merge request's state", async () => {
    const calls = fakeGitLab([
      { method: "POST", path: `/projects/${PROJECT}/merge_requests/7/notes`, body: { id: 1 } },
      { path: `/projects/${PROJECT}/merge_requests/7`, body: mr({ state: "merged", sha: "def456" }) },
    ]);
    await client().commentOnPr(REPO, 7, "Preview is ready");
    expect(calls[0]!.body).toEqual({ body: `Preview is ready\n\n${BOT_MARKER}` });
    expect(await client().getPull(REPO, 7)).toEqual({
      number: 7,
      state: "closed",
      draft: false,
      merged: true,
      nodeId: "7",
      headRef: "army/login-abc123",
      headSha: "def456",
      url: `${BASE}/acme/platform/web/-/merge_requests/7`,
    });
    expect(client().prWebUrl(REPO, 7)).toBe(`${BASE}/acme/platform/web/-/merge_requests/7`);
  });

  it("turns notes into feedback with roles as associations, inline positions and review outcomes", async () => {
    const note = (id: number, author: { id: number; username: string }, over: Record<string, unknown> = {}) => ({
      id,
      type: null,
      body: `note ${id}`,
      author,
      system: false,
      created_at: `2026-11-0${id}T10:00:00Z`,
      ...over,
    });
    const maintainer = { id: 1, username: "lead-dev" };
    const developer = { id: 2, username: "octo-dev" };
    const reporter = { id: 3, username: "viewer" };
    const outsider = { id: 4, username: "drive-by" };
    const bot = { id: 5, username: "project_11_bot_3f9a1c" };
    const calls = fakeGitLab([
      {
        path: `/projects/${PROJECT}/merge_requests/7/discussions?per_page=100&page=1`,
        headers: { "x-next-page": "2" },
        body: [
          { notes: [note(1, developer, { type: "DiffNote", position: { new_path: "src/login.ts", new_line: 12, old_path: "src/login.ts", old_line: null } })] },
          { notes: [note(2, maintainer), note(3, reporter)] },
        ],
      },
      {
        path: `/projects/${PROJECT}/merge_requests/7/discussions?per_page=100&page=2`,
        body: [
          { notes: [note(4, maintainer, { system: true, body: "requested changes" })] },
          { notes: [note(5, maintainer, { system: true, body: "added 1 commit" })] },
          { notes: [note(6, outsider)] },
          { notes: [note(7, bot)] },
          { notes: [note(8, developer, { body: `Preview ready\n\n${BOT_MARKER}` })] },
        ],
      },
      { path: `/projects/${PROJECT}/members/all/1`, body: { access_level: 40 } },
      { path: `/projects/${PROJECT}/members/all/2`, body: { access_level: 30 } },
      { path: `/projects/${PROJECT}/members/all/3`, body: { access_level: 20 } },
      { path: `/projects/${PROJECT}/members/all/5`, body: { access_level: 30 } },
    ]);
    const feedback = await client().prFeedback(REPO, 7);
    const url = (id: number) => `${BASE}/acme/platform/web/-/merge_requests/7#note_${id}`;
    expect(feedback).toEqual([
      { kind: "inline", id: 1, author: "octo-dev", association: "MEMBER", bot: false, body: "note 1", path: "src/login.ts", line: 12, createdAt: "2026-11-01T10:00:00Z", url: url(1) },
      { kind: "comment", id: 2, author: "lead-dev", association: "OWNER", bot: false, body: "note 2", createdAt: "2026-11-02T10:00:00Z", url: url(2) },
      { kind: "comment", id: 3, author: "viewer", association: "NONE", bot: false, body: "note 3", createdAt: "2026-11-03T10:00:00Z", url: url(3) },
      { kind: "review", id: 4, author: "lead-dev", association: "OWNER", bot: false, state: "CHANGES_REQUESTED", body: "", createdAt: "2026-11-04T10:00:00Z", url: url(4) },
      { kind: "comment", id: 6, author: "drive-by", association: "NONE", bot: false, body: "note 6", createdAt: "2026-11-06T10:00:00Z", url: url(6) },
      { kind: "comment", id: 7, author: "project_11_bot_3f9a1c", association: "MEMBER", bot: true, body: "note 7", createdAt: "2026-11-07T10:00:00Z", url: url(7) },
      { kind: "comment", id: 8, author: "octo-dev", association: "MEMBER", bot: false, body: `Preview ready\n\n${BOT_MARKER}`, createdAt: "2026-11-08T10:00:00Z", url: url(8) },
    ]);
    // Each author's role is looked up once.
    expect(calls.filter((c) => c.path.includes("/members/all/")).map((c) => c.path.split("/").pop())).toEqual(["2", "1", "3", "4", "5"]);
    // The worker's filter keeps people with write access only, without bots or the platform's own notes.
    expect(feedback.filter((f) => isHumanFeedback(f)).map((f) => f.id)).toEqual([1, 2, 4]);
    expect(feedback.filter((f) => isHumanFeedback(f, "2026-11-03T00:00:00Z")).map((f) => f.id)).toEqual([4]);
  });

  it("lists general comments (not diff or system notes) as conversation comments", async () => {
    fakeGitLab([
      {
        path: `/projects/${PROJECT}/merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=1`,
        body: [
          { id: 1, type: null, body: "Deployed to preview", author: { id: 9, username: "project_11_bot_ab" }, system: false, created_at: "t1", updated_at: "t2" },
          { id: 2, type: "DiffNote", body: "inline", author: { id: 2, username: "octo-dev" }, system: false, created_at: "t3" },
          { id: 3, type: null, body: "added 1 commit", author: { id: 2, username: "octo-dev" }, system: true, created_at: "t4" },
        ],
      },
    ]);
    expect(await client().issueComments(REPO, 7)).toEqual([
      { id: 1, author: "project_11_bot_ab", bot: true, body: "Deployed to preview", createdAt: "t1", updatedAt: "t2" },
    ]);
  });
});

describe("GitLab client: pipelines and deployments", () => {
  const pipelines = [
    { id: 30, ref: "army/login-abc123", source: "push" },
    { id: 29, ref: "refs/merge-requests/7/head", source: "merge_request_event" },
    { id: 28, ref: "army/login-abc123", source: "push" },
    { id: 27, ref: "army/login-abc123", source: "external" },
  ];
  const job = (id: number, name: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    stage: "test",
    status,
    allow_failure: false,
    web_url: `${BASE}/acme/platform/web/-/jobs/${id}`,
    failure_reason: null,
    ...over,
  });

  it("maps the jobs of the newest pipeline per ref to checks, and other statuses to commit statuses", async () => {
    const calls = fakeGitLab([
      { path: `/projects/${PROJECT}/pipelines?sha=abc123&order_by=id&sort=desc&per_page=20`, body: pipelines },
      {
        path: `/projects/${PROJECT}/pipelines/30/jobs?per_page=100`,
        body: [
          job(1, "build", "success"),
          job(2, "unit", "failed", { failure_reason: "script_failure" }),
          job(3, "lint", "failed", { allow_failure: true }),
          job(4, "e2e", "running"),
          job(5, "deploy", "manual"),
          job(6, "cleanup", "skipped"),
          job(7, "flaky", "canceled"),
          job(8, "later", "scheduled"),
          job(9, "queued", "pending"),
          job(10, "fresh", "created"),
        ],
      },
      { path: `/projects/${PROJECT}/pipelines/29/jobs?per_page=100`, body: [job(11, "mr-check", "success")] },
      {
        path: `/projects/${PROJECT}/repository/commits/abc123/statuses?per_page=100`,
        body: [
          { id: 1, name: "build", status: "success", target_url: null },
          { id: 100, name: "unit", status: "failed", target_url: null },
          { id: 101, name: "old-job", status: "success", target_url: `${BASE}/acme/platform/web/-/jobs/101` },
          { id: 102, name: "Vercel", status: "running", description: "Deploying", target_url: "https://vercel.example.com/acme/web/1" },
          { id: 103, name: "Vercel – docs", status: "failed", description: "Build failed", target_url: "https://vercel.example.com/acme/docs/2" },
          { id: 104, name: "security", status: "skipped", target_url: null },
        ],
      },
    ]);
    const { checks, statuses } = await client().checksFor(REPO, "abc123");
    expect(calls.some((c) => c.path.includes("/pipelines/28/") || c.path.includes("/pipelines/27/"))).toBe(false);
    const state = (c: CheckInfo) => `${c.name}:${c.status}:${c.conclusion}`;
    expect(checks.map(state)).toEqual([
      "build:completed:success",
      "unit:completed:failure",
      "lint:completed:neutral",
      "e2e:in_progress:null",
      "deploy:completed:action_required",
      "cleanup:completed:skipped",
      "flaky:completed:cancelled",
      "later:waiting:null",
      "queued:queued:null",
      "fresh:queued:null",
      "mr-check:completed:success",
    ]);
    expect(checks[1]).toEqual({
      id: 2,
      name: "unit",
      status: "completed",
      conclusion: "failure",
      detailsUrl: `${BASE}/acme/platform/web/-/jobs/2`,
      title: "Failed: script failure",
      summary: "Stage: test",
      text: null,
      app: "gitlab-ci",
    });
    expect(statuses).toEqual([
      { context: "Vercel", state: "pending", description: "Deploying", targetUrl: "https://vercel.example.com/acme/web/1" },
      { context: "Vercel – docs", state: "failure", description: "Build failed", targetUrl: "https://vercel.example.com/acme/docs/2" },
    ]);
  });

  it("reads the end of a job's log, and has none for statuses from elsewhere", async () => {
    const log = `${"x".repeat(LOG_MAX_CHARS)}\nthe end`;
    const calls = fakeGitLab([{ path: `/projects/${PROJECT}/jobs/2/trace`, raw: log }]);
    const check = { id: 2, name: "unit", status: "completed", conclusion: "failure", detailsUrl: null, title: null, summary: null, text: null, app: "gitlab-ci" };
    const tail = await client().jobLog(REPO, check);
    expect(tail).toHaveLength(LOG_MAX_CHARS);
    expect(tail!.endsWith("\nthe end")).toBe(true);
    expect(calls[0]!.headers.get("accept")).toBe("text/plain");
    expect(await client().jobLog(REPO, { ...check, app: "vercel" })).toBeUndefined();
    expect(await client().checkAnnotations(REPO, check)).toEqual([]);
  });

  it("finds a commit's deployments and their environment URL", async () => {
    fakeGitLab([
      {
        path: `/projects/${PROJECT}/deployments?order_by=id&sort=desc&per_page=50`,
        body: [
          { id: 5, sha: "abc123", status: "success", created_at: "t1", user: { username: "octo-dev" }, environment: { name: "review/login", external_url: "https://review.example.com" } },
          { id: 4, sha: "other", status: "success", created_at: "t0", environment: { name: "production", tier: "production" } },
          { id: 3, sha: "abc123", status: "failed", created_at: "t0", environment: { name: "production", tier: "production" } },
        ],
      },
      { path: `/projects/${PROJECT}/deployments/5`, body: { id: 5, sha: "abc123", status: "success", created_at: "t1", updated_at: "t2", environment: { external_url: "https://review.example.com" } } },
      { path: `/projects/${PROJECT}/deployments/3`, body: { id: 3, sha: "abc123", status: "running", created_at: "t1", environment: { external_url: "" } } },
    ]);
    expect(await client().deploymentsFor(REPO, "abc123")).toEqual([
      { id: 5, sha: "abc123", environment: "review/login", originalEnvironment: null, production: false, transient: false, createdAt: "t1", creator: "octo-dev" },
      { id: 3, sha: "abc123", environment: "production", originalEnvironment: null, production: true, transient: false, createdAt: "t0", creator: null },
    ]);
    expect(await client().deploymentStatuses(REPO, 5)).toEqual([{ id: 5, state: "success", environmentUrl: "https://review.example.com", createdAt: "t2" }]);
    expect(await client().deploymentStatuses(REPO, 3)).toEqual([{ id: 3, state: "in_progress", environmentUrl: null, createdAt: "t1" }]);
  });
});

describe("GitLab client: reads for Pointer's tools", () => {
  it("reads a file's text, capped", async () => {
    fakeGitLab([
      { path: `/projects/${PROJECT}/repository/files/src%2Flogin.ts/raw?ref=main`, raw: "export const login = 1;\n" },
      { path: `/projects/${PROJECT}/repository/files/big.txt/raw`, raw: "y".repeat(FILE_MAX_CHARS * 5) },
      { path: `/projects/${PROJECT}/repository/files/logo.png/raw`, raw: new Uint8Array([137, 80, 78, 71, 0, 1, 2]), headers: { "x-gitlab-size": "7" } },
    ]);
    expect(await client().readFile(REPO, "/src/login.ts", "main")).toEqual({ text: "export const login = 1;\n", truncated: false });
    const big = await client().readFile(REPO, "big.txt");
    expect(big.truncated).toBe(true);
    expect(big.text).toHaveLength(FILE_MAX_CHARS);
    expect(await client().readFile(REPO, "logo.png")).toEqual({ text: "(binary file, 7 bytes)", truncated: false });
  });

  it("lists a directory, or the root for an empty path", async () => {
    const calls = fakeGitLab([
      {
        path: `/projects/${PROJECT}/repository/tree?per_page=100&path=src`,
        body: [
          { path: "src/auth", type: "tree" },
          { path: "src/login.ts", type: "blob" },
          { path: "src/vendor", type: "commit" },
        ],
      },
      { path: `/projects/${PROJECT}/repository/tree?per_page=100`, body: [{ path: "README.md", type: "blob" }] },
      { path: `/projects/${PROJECT}/repository/tree?per_page=100&path=missing`, body: [] },
    ]);
    expect(await client().readFile(REPO, "src")).toEqual({ text: "src/auth/\nsrc/login.ts\nsrc/vendor (git submodule)", truncated: false });
    expect(calls.map((c) => c.path)).toEqual([`/projects/${PROJECT}/repository/files/src/raw`, `/projects/${PROJECT}/repository/tree?per_page=100&path=src`]);
    expect(await client().readFile(REPO, "")).toEqual({ text: "README.md", truncated: false });
    await expect(client().readFile(REPO, "missing")).rejects.toThrow(/HTTP 404/);
  });

  it("lists projects as stored ids, for a group or the token's memberships", async () => {
    const project = { id: 1, path_with_namespace: "acme/platform/web", visibility: "private", description: null, default_branch: "main", last_activity_at: "t1", web_url: `${BASE}/acme/platform/web` };
    const calls = fakeGitLab([
      { path: "/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=30", body: [project] },
      { path: "/groups/acme%2Fplatform/projects?include_subgroups=true&order_by=last_activity_at&sort=desc&per_page=30", body: [{ ...project, visibility: "public" }] },
      { path: "/users/octo-dev/projects?order_by=last_activity_at&sort=desc&per_page=30", body: [] },
    ]);
    expect(await client().listRepos()).toEqual([
      { fullName: "gitlab:acme/platform/web", private: true, description: null, defaultBranch: "main", updatedAt: "t1", url: `${BASE}/acme/platform/web` },
    ]);
    expect((await client().listRepos("gitlab:acme/platform"))[0]).toMatchObject({ fullName: "gitlab:acme/platform/web", private: false });
    expect(await client().listRepos("octo-dev")).toEqual([]);
    expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/projects", "/groups/acme%2Fplatform/projects", "/groups/octo-dev/projects", "/users/octo-dev/projects"]);
    await expect(client().listRepos("../admin")).rejects.toThrow(/Not a GitLab group/);
  });

  it("lists merge requests, with merged ones among the closed", async () => {
    const calls = fakeGitLab([
      { path: `/projects/${PROJECT}/merge_requests?state=closed&order_by=updated_at&sort=desc&per_page=2`, body: [mr({ iid: 1, state: "closed", updated_at: "2026-11-01" })] },
      {
        path: `/projects/${PROJECT}/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=2`,
        body: [mr({ iid: 2, state: "merged", updated_at: "2026-11-03", merged_at: "2026-11-03" }), mr({ iid: 3, state: "merged", updated_at: "2026-10-01" })],
      },
      { path: `/projects/${PROJECT}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=10`, body: [mr({ draft: true })] },
    ]);
    const closed = await client().listPulls(REPO, { state: "closed", limit: 2 });
    expect(closed.map((p) => [p.number, p.state, p.mergedAt])).toEqual([
      [2, "closed", "2026-11-03"],
      [1, "closed", null],
    ]);
    expect(await client().listPulls(REPO)).toEqual([
      {
        number: 7,
        title: "Add login",
        state: "open",
        draft: true,
        author: "octo-dev",
        head: "army/login-abc123",
        base: "main",
        url: `${BASE}/acme/platform/web/-/merge_requests/7`,
        updatedAt: "2026-11-01T10:00:00Z",
        mergedAt: null,
      },
    ]);
    expect(calls).toHaveLength(3);
  });

  it("lists issues and recent commits", async () => {
    fakeGitLab([
      {
        path: `/projects/${PROJECT}/issues?state=opened&order_by=updated_at&sort=desc&per_page=5`,
        body: [{ iid: 4, title: "Login fails", state: "opened", author: { username: "octo-dev" }, labels: ["bug"], user_notes_count: 2, web_url: `${BASE}/i/4`, updated_at: "t1" }],
      },
      {
        path: `/projects/${PROJECT}/repository/commits?per_page=3&ref_name=main`,
        body: [{ id: "abc123", author_name: "Octo Dev", authored_date: "t1", message: "Fix login" }],
      },
    ]);
    expect(await client().listIssues(REPO, { limit: 5 })).toEqual([
      { number: 4, title: "Login fails", state: "open", author: "octo-dev", labels: ["bug"], comments: 2, url: `${BASE}/i/4`, updatedAt: "t1" },
    ]);
    expect(await client().recentCommits(REPO, { branch: "main", limit: 3 })).toEqual([{ sha: "abc123", author: "Octo Dev", date: "t1", message: "Fix login" }]);
  });

  it("searches code in a project or across the instance, one hit per file", async () => {
    fakeGitLab([
      {
        path: `/projects/${PROJECT}/search?scope=blobs&search=login%20form&per_page=40`,
        body: [
          { path: "src/login.ts", ref: "main", startline: 10, project_id: 1 },
          { path: "src/login.ts", ref: "main", startline: 40, project_id: 1 },
        ],
      },
      { path: "/search?scope=blobs&search=login&per_page=40", body: [{ path: "a.ts", ref: "main", startline: 1, project_id: 1 }, { path: "b.ts", ref: "main", project_id: 2 }] },
      { path: "/projects/1", body: { id: 1, path_with_namespace: "acme/platform/web", web_url: "" } },
    ]);
    expect(await client().searchCode("login form", REPO)).toEqual([
      { repo: REPO, path: "src/login.ts", url: `${BASE}/acme/platform/web/-/blob/main/src/login.ts#L10` },
    ]);
    // Project 2 is not visible to the token: its hit is dropped.
    expect(await client().searchCode("login")).toEqual([{ repo: REPO, path: "a.ts", url: `${BASE}/acme/platform/web/-/blob/main/a.ts#L1` }]);
  });
});

describe("GitLab client: admin calls", () => {
  it("looks up a member's role, a path's kind and the token's scopes", async () => {
    fakeGitLab([
      { path: `/projects/${PROJECT}/members/all/2`, body: { access_level: 30 } },
      { path: `/projects/${PROJECT}`, body: { id: 1 } },
      { path: "/namespaces/acme", body: { id: 3, kind: "group" } },
      { path: "/personal_access_tokens/self", body: { scopes: ["api", "write_repository"] } },
    ]);
    const gl = client();
    expect(await gl.memberAccess(REPO, 2)).toBe(30);
    expect(await gl.memberAccess(REPO, 3)).toBeUndefined();
    expect(await gl.pathKind("acme/platform/web")).toBe("project");
    expect(await gl.pathKind("acme")).toBe("namespace");
    expect(await gl.pathKind("acme/nothing")).toBeUndefined();
    expect(await gl.tokenScopes()).toEqual(["api", "write_repository"]);
  });

  it("adds the webhook to a project, or updates the one with the same URL", async () => {
    const url = "https://army.example.com/gitlab/webhook";
    let calls = fakeGitLab([
      { path: `/projects/${PROJECT}/hooks?per_page=100`, body: [{ id: 8, url: "https://other.example.com" }] },
      { method: "POST", path: `/projects/${PROJECT}/hooks`, body: { id: 9 } },
    ]);
    expect(await client().installWebhook(REPO, url, "s3cret-value-0123456789")).toBe("created");
    expect(calls[1]!.body).toMatchObject({ url, token: "s3cret-value-0123456789", merge_requests_events: true, note_events: true, push_events: false, enable_ssl_verification: true });

    calls = fakeGitLab([
      { path: `/projects/${PROJECT}/hooks?per_page=100`, body: [{ id: 8, url }] },
      { method: "PUT", path: `/projects/${PROJECT}/hooks/8`, body: { id: 8 } },
    ]);
    expect(await client().installWebhook(REPO, url, "s3cret-value-0123456789")).toBe("updated");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });
});

describe("GitLab client: safety", () => {
  const ZWSP = "​";

  it("neutralises quick actions at the start of any line, and only there", () => {
    expect(neutralizeQuickActions("/merge")).toBe(`${ZWSP}/merge`);
    expect(neutralizeQuickActions("Done.\n  /approve\n\t/target_branch release")).toBe(`Done.\n  ${ZWSP}/approve\n\t${ZWSP}/target_branch release`);
    expect(neutralizeQuickActions("```\n/close\n```")).toBe(`\`\`\`\n${ZWSP}/close\n\`\`\``);
    expect(neutralizeQuickActions("See src/app.ts and a/b")).toBe("See src/app.ts and a/b");
    // Applying it twice changes nothing more.
    const once = neutralizeQuickActions("/merge\r\n/label ~x");
    expect(neutralizeQuickActions(once)).toBe(once);
  });

  it("never sends a description, comment or title that GitLab would run as a quick action", async () => {
    const calls = fakeGitLab([
      { method: "POST", path: `/projects/${PROJECT}/merge_requests`, body: mr() },
      { method: "POST", path: `/projects/${PROJECT}/merge_requests/7/notes`, body: { id: 1 } },
      { method: "PUT", path: `/projects/${PROJECT}/merge_requests/7`, body: mr() },
      { path: `/projects/${PROJECT}/merge_requests/7`, body: mr() },
    ]);
    await client().createPr(REPO, { title: "/merge\nnow", body: "Summary\n/merge\n /approve", head: "army/x", base: "main" });
    await client().commentOnPr(REPO, 7, "Fixed.\n/close");
    await client().updatePr(REPO, 7, { title: "/target_branch release", body: "/merge" });
    const sent = calls
      .filter((c) => c.method !== "GET")
      .flatMap((c) => Object.values((c.body ?? {}) as Record<string, unknown>))
      .filter((v): v is string => typeof v === "string");
    for (const text of sent) expect(text).not.toMatch(/(^|[\r\n])[^\S\r\n]*\//);
    expect(sent.some((t) => t.includes(`${ZWSP}/merge`))).toBe(true);
  });

  it("with an allow list, checks GitLab's own path for the project and refuses moved or uncovered projects", async () => {
    const calls = fakeGitLab([
      { path: `/projects/${PROJECT}`, body: { path_with_namespace: "acme/platform/web", default_branch: "main" } },
      { path: "/projects/acme%2Fold", body: { path_with_namespace: "elsewhere/old", default_branch: "main" } },
      { path: "/projects/other%2Fapi", body: { path_with_namespace: "other/api", default_branch: "main" } },
    ]);
    const guarded = new GitLab({ token: TOKEN, baseUrl: BASE, allowed: ["acme"] });
    // Cloning needs the check first; any project call does it.
    expect(() => guarded.cloneUrl(REPO)).toThrow(/checked against the allow list/);
    expect(await guarded.defaultBranch(REPO)).toBe("main");
    expect(guarded.cloneUrl(REPO)).toBe(`${BASE}/acme/platform/web.git`);
    // The check runs once (then it is remembered); each defaultBranch is its own call.
    await guarded.defaultBranch(REPO);
    expect(calls.filter((c) => c.path === `/projects/${PROJECT}`).length).toBe(3);
    await expect(guarded.defaultBranch("gitlab:acme/old")).rejects.toThrow(/has moved to elsewhere\/old/);
    await expect(guarded.defaultBranch("gitlab:other/api")).rejects.toThrow(/Not allowed to work on gitlab:other\/api/);
    // Without an allow list, paths are used as given.
    expect(client().cloneUrl(REPO)).toBe(`${BASE}/acme/platform/web.git`);
  });
});
