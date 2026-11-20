import { afterEach, describe, expect, it, vi } from "vitest";
import { Bitbucket, PIPELINES_APP, bitbucketRepo, bitbucketStatus, syntheticId } from "../../../src/integrations/bitbucket/bitbucket.js";
import { BOT_MARKER, type CheckInfo, FALLBACK_COMMIT_EMAIL, LOG_MAX_CHARS, isHumanFeedback } from "../../../src/integrations/github/github.js";

const TOKEN = "ATATT-test-token-0123456789abcdef";
const EMAIL = "bot@example.com";
const REPO = "bitbucket:acme/web";
const API = "/2.0/repositories/acme/web";

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}
type Route = unknown | ((call: Call) => Response | Promise<Response>);

/** Answers Bitbucket calls from `routes`, keyed "METHOD /path" (or with the query string); anything else is a 404. */
function mockBitbucket(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const call = { method, url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
      if (route === undefined) return Response.json({ type: "error", error: { message: `No route ${method} ${url.pathname}` } }, { status: 404 });
      if (typeof route === "function") return (route as (c: Call) => Response | Promise<Response>)(call);
      return Response.json(route);
    }),
  );
  return calls;
}

const status = (code: number, message = "nope") => () => Response.json({ type: "error", error: { message } }, { status: code });
const apiToken = () => new Bitbucket({ token: TOKEN, email: EMAIL });
const accessToken = () => new Bitbucket({ token: TOKEN });
const basic = (user: string) => Buffer.from(`${user}:${TOKEN}`).toString("base64");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Bitbucket credentials", () => {
  it("sends Basic email:token for API tokens and Bearer for access tokens", async () => {
    const calls = mockBitbucket({ [`GET ${API}`]: { mainbranch: { name: "main" } } });
    await apiToken().defaultBranch(REPO);
    await accessToken().defaultBranch(REPO);
    expect(calls[0]!.headers.get("authorization")).toBe(`Basic ${basic(EMAIL)}`);
    expect(calls[1]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url.origin).toBe("https://api.bitbucket.org");
  });

  it("gives git Bitbucket's static username for each kind of token, never in a URL", () => {
    expect(apiToken().gitAuthArgs()).toEqual(["-c", `http.https://bitbucket.org/.extraheader=Authorization: Basic ${basic("x-bitbucket-api-token-auth")}`]);
    expect(accessToken().gitAuthArgs()).toEqual(["-c", `http.https://bitbucket.org/.extraheader=Authorization: Basic ${basic("x-token-auth")}`]);
    expect(apiToken().cloneUrl(REPO)).toBe("https://bitbucket.org/acme/web.git");
    expect(apiToken().prWebUrl(REPO, 7)).toBe("https://bitbucket.org/acme/web/pull-requests/7");
    expect(apiToken().secrets()).toEqual(expect.arrayContaining([TOKEN, basic("x-bitbucket-api-token-auth"), basic(EMAIL)]));
    expect(accessToken().secrets()).toEqual(expect.arrayContaining([TOKEN, basic("x-token-auth")]));
  });

  it("reads repository ids with or without the prefix and refuses others", () => {
    expect(bitbucketRepo("bitbucket:Acme/Web")).toMatchObject({ id: "bitbucket:Acme/Web", path: "Acme/Web", api: "/repositories/acme/web" });
    expect(bitbucketRepo("acme/web").id).toBe(REPO);
    expect(() => bitbucketRepo("gitlab:acme/web")).toThrow(/Not a Bitbucket repository/);
    expect(() => bitbucketRepo("bitbucket:acme/../x")).toThrow();
  });

  it("puts the HTTP status in errors and never the token", async () => {
    mockBitbucket({ [`GET ${API}`]: () => Response.json({ type: "error", error: { message: `bad credentials ${TOKEN}` } }, { status: 401 }) });
    const err = await apiToken().defaultBranch(REPO).catch((e: unknown) => e as Error);
    expect(err.message).toContain("(HTTP 401)");
    expect(err.message).not.toContain(TOKEN);
    expect(bitbucketStatus(err)).toBe(401);
  });

  it("never sends the token to a next link outside api.bitbucket.org", async () => {
    const calls = mockBitbucket({
      [`GET ${API}/pullrequests/7`]: { id: 7, participants: [], links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } } },
      [`GET ${API}/pullrequests/7/comments`]: { values: [], next: "https://evil.example.com/steal" },
    });
    await expect(apiToken().prFeedback(REPO, 7)).rejects.toThrow(/outside api.bitbucket.org/);
    for (const next of ["https://api.bitbucket.org.evil.example.com/2.0/x", "https://user@api.bitbucket.org/2.0/x", "https://api.bitbucket.org/3.0/x"]) {
      mockBitbucket({ [`GET ${API}/pullrequests/7/comments`]: { values: [], next } });
      await expect(apiToken().issueComments(REPO, 7)).rejects.toThrow(/outside api.bitbucket.org/);
    }
    expect(calls.every((c) => c.url.hostname === "api.bitbucket.org")).toBe(true);
  });
});

describe("Bitbucket pull requests", () => {
  const pr = (over: Record<string, unknown> = {}) => ({
    id: 7,
    title: "Rename the helper",
    state: "OPEN",
    draft: true,
    source: { branch: { name: "army/rename" }, commit: { hash: "abcdef012345" } },
    destination: { branch: { name: "main" } },
    links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } },
    reviewers: [{ uuid: "{11111111-1111-1111-1111-111111111111}" }],
    ...over,
  });

  it("opens a draft pull request and maps it to a PrRef", async () => {
    const calls = mockBitbucket({ [`POST ${API}/pullrequests`]: pr() });
    const ref = await apiToken().createPr(REPO, { title: "Rename", body: "Why and how", head: "army/rename", base: "main", draft: true });
    expect(ref).toEqual({ number: 7, html_url: "https://bitbucket.org/acme/web/pull-requests/7", node_id: "7", draft: true });
    expect(calls[0]!.body).toEqual({
      title: "Rename",
      description: "Why and how",
      source: { branch: { name: "army/rename" } },
      destination: { branch: { name: "main" } },
      draft: true,
    });
  });

  it("marks a draft ready by clearing its draft flag, keeping its title and reviewers", async () => {
    const calls = mockBitbucket({ [`GET ${API}/pullrequests/7`]: pr(), [`PUT ${API}/pullrequests/7`]: pr({ draft: false }) });
    await apiToken().markReady(REPO, { number: 7, html_url: "", node_id: "7", draft: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.body).toEqual({ title: "Rename the helper", draft: false, reviewers: [{ uuid: "{11111111-1111-1111-1111-111111111111}" }] });

    await apiToken().markReady(REPO, { number: 7, html_url: "", node_id: "7", draft: false });
    expect(calls).toHaveLength(2);
  });

  it("updates the description alone, and finds the open pull request of a branch", async () => {
    const calls = mockBitbucket({
      [`GET ${API}/pullrequests/7`]: pr(),
      [`PUT ${API}/pullrequests/7`]: pr(),
      [`GET ${API}/pullrequests`]: { values: [pr()] },
    });
    await apiToken().updatePr(REPO, 7, { body: "New body" });
    expect(calls[1]!.body).toEqual({ title: "Rename the helper", description: "New body", reviewers: [{ uuid: "{11111111-1111-1111-1111-111111111111}" }] });

    expect(await apiToken().findOpenPr(REPO, "army/rename")).toMatchObject({ number: 7, draft: true });
    expect(calls[2]!.url.searchParams.get("q")).toBe('source.branch.name="army/rename" AND state="OPEN"');
  });

  it("comments with the platform's marker hidden in a link definition", async () => {
    const calls = mockBitbucket({ [`POST ${API}/pullrequests/7/comments`]: { id: 1 } });
    await apiToken().commentOnPr(REPO, 7, "Checks pass now.");
    expect(calls[0]!.body).toEqual({ content: { raw: `Checks pass now.\n\n[//]: # (${BOT_MARKER})` } });
  });

  it("reads a merged pull request with its full head commit", async () => {
    mockBitbucket({
      [`GET ${API}/pullrequests/7`]: pr({ state: "MERGED", draft: false }),
      [`GET ${API}/commit/abcdef012345`]: { hash: "abcdef0123456789abcdef0123456789abcdef01" },
    });
    expect(await apiToken().getPull(REPO, 7)).toEqual({
      number: 7,
      state: "closed",
      draft: false,
      merged: true,
      nodeId: "7",
      headRef: "army/rename",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      url: "https://bitbucket.org/acme/web/pull-requests/7",
    });
  });
});

describe("Bitbucket feedback", () => {
  const alice = { type: "user", account_id: "557058:alice", nickname: "alice" };
  const bob = { type: "user", account_id: "557058:bob", nickname: "bob" };
  const carol = { type: "user", account_id: "557058:carol", nickname: "carol" };
  const vercel = { type: "app_user", account_id: "557058:vercel", nickname: "Vercel" };
  const permissions: Record<string, string> = { "557058:alice": "admin", "557058:bob": "write", "557058:carol": "read" };

  const routes = (overrides: Record<string, Route> = {}) => ({
    [`GET ${API}/pullrequests/7`]: {
      id: 7,
      updated_on: "2026-11-01T10:00:00+00:00",
      links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } },
      participants: [
        { user: alice, state: "changes_requested", participated_on: "2026-11-01T09:00:00+00:00" },
        { user: bob, state: "approved", approved: true, participated_on: "2026-11-01T09:30:00+00:00" },
        { user: carol, state: null, participated_on: "2026-11-01T09:40:00+00:00" },
      ],
    },
    [`GET ${API}/pullrequests/7/comments`]: {
      values: [
        { id: 11, user: bob, content: { raw: "Use a map here" }, inline: { path: "src/a.ts", from: null, to: 12 }, created_on: "2026-11-01T08:00:00+00:00", links: { html: { href: "https://bitbucket.org/c/11" } } },
        { id: 12, user: carol, content: { raw: "Nice" }, created_on: "2026-11-01T08:10:00+00:00" },
        { id: 13, user: vercel, content: { raw: "Preview: https://web-git-x.vercel.app" }, created_on: "2026-11-01T08:20:00+00:00", updated_on: "2026-11-01T08:25:00+00:00" },
        { id: 14, user: alice, content: { raw: "gone" }, deleted: true, created_on: "2026-11-01T08:30:00+00:00" },
        { id: 15, user: alice, content: { raw: "draft" }, pending: true, created_on: "2026-11-01T08:31:00+00:00" },
      ],
    },
    "GET /2.0/workspaces/acme/permissions/repositories/web": (c: Call) => {
      const id = c.url.searchParams.get("q")?.match(/"(.+)"/)?.[1] ?? "";
      return Response.json({ values: permissions[id] ? [{ permission: permissions[id] }] : [] });
    },
    ...overrides,
  });

  it("maps approvals, change requests, inline and conversation comments, with write access from permissions", async () => {
    const calls = mockBitbucket(routes());
    const feedback = await apiToken().prFeedback(REPO, 7);
    expect(feedback.map((f) => [f.kind, f.author, f.association, f.bot, f.state ?? null])).toEqual([
      ["inline", "bob", "COLLABORATOR", false, null],
      ["comment", "carol", "NONE", false, null],
      ["comment", "Vercel", "NONE", true, null],
      ["review", "alice", "OWNER", false, "CHANGES_REQUESTED"],
      ["review", "bob", "COLLABORATOR", false, "APPROVED"],
    ]);
    expect(feedback[0]).toMatchObject({ id: 11, path: "src/a.ts", line: 12, body: "Use a map here", url: "https://bitbucket.org/c/11" });
    expect(feedback[3]).toMatchObject({ body: "", createdAt: "2026-11-01T09:00:00+00:00", url: "https://bitbucket.org/acme/web/pull-requests/7" });
    expect(feedback[3]!.id).toBe(syntheticId("review:557058:alice:CHANGES_REQUESTED"));
    // What the worker keeps: the writer's inline comment and the change request, not the approval or others' comments.
    expect(feedback.filter((f) => isHumanFeedback(f)).map((f) => f.id)).toEqual([11, feedback[3]!.id]);
    // One permission lookup per person.
    expect(calls.filter((c) => c.url.pathname.includes("/permissions/")).length).toBe(4);
  });

  it("counts workspace members as members when the token may not read permissions, and others as none", async () => {
    mockBitbucket(
      routes({
        "GET /2.0/workspaces/acme/permissions/repositories/web": status(403),
        "GET /2.0/workspaces/acme/members/557058%3Abob": { user: bob },
      }),
    );
    const feedback = await accessToken().prFeedback(REPO, 7);
    const by = (name: string) => [...new Set(feedback.filter((f) => f.author === name).map((f) => f.association))];
    expect(by("bob")).toEqual(["MEMBER"]);
    expect(by("alice")).toEqual(["NONE"]);
    expect(by("carol")).toEqual(["NONE"]);
  });

  it("lists conversation comments (not inline ones) for preview bots", async () => {
    mockBitbucket(routes());
    const comments = await apiToken().issueComments(REPO, 7);
    expect(comments).toEqual([
      { id: 12, author: "carol", bot: false, body: "Nice", createdAt: "2026-11-01T08:10:00+00:00", updatedAt: "2026-11-01T08:10:00+00:00" },
      { id: 13, author: "Vercel", bot: true, body: "Preview: https://web-git-x.vercel.app", createdAt: "2026-11-01T08:20:00+00:00", updatedAt: "2026-11-01T08:25:00+00:00" },
    ]);
  });
});

describe("Bitbucket checks", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const P1 = "{aaaaaaaa-0000-0000-0000-000000000001}";
  const P0 = "{aaaaaaaa-0000-0000-0000-000000000000}";
  const P2 = "{aaaaaaaa-0000-0000-0000-000000000002}";
  const step = (n: number, name: string, state: Record<string, unknown>) => ({ uuid: `{bbbbbbbb-0000-0000-0000-00000000000${n}}`, name, state });
  const enc = encodeURIComponent;

  const routes = (overrides: Record<string, Route> = {}) => ({
    [`GET ${API}/pipelines`]: {
      values: [
        { uuid: P1, build_number: 42, state: { name: "COMPLETED", result: { name: "FAILED" } }, target: { selector: { type: "branches", pattern: "army/*" } } },
        { uuid: P0, build_number: 41, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } }, target: { selector: { type: "branches", pattern: "army/*" } } },
        { uuid: P2, build_number: 43, state: { name: "IN_PROGRESS", stage: { name: "PAUSED" } }, target: { selector: { type: "custom", pattern: "deploy" } } },
      ],
    },
    [`GET ${API}/pipelines/${enc(P1)}/steps`]: {
      values: [
        step(1, "Build", { name: "COMPLETED", result: { name: "SUCCESSFUL" } }),
        step(2, "Test", { name: "COMPLETED", result: { name: "FAILED", error: { message: "Exit code 1" } } }),
        step(3, "Lint", { name: "COMPLETED", result: { name: "NOT_RUN" } }),
      ],
    },
    [`GET ${API}/pipelines/${enc(P2)}/steps`]: {
      values: [step(4, "Smoke", { name: "IN_PROGRESS" }), step(5, "Release", { name: "PENDING" })],
    },
    [`GET ${API}/commit/${SHA}/statuses`]: {
      values: [
        { key: "pipe-1", name: "Pipeline #42 for army/rename", state: "FAILED", url: "https://bitbucket.org/acme/web/pipelines/results/42" },
        { key: "vercel", name: "Vercel", state: "INPROGRESS", description: "Building", url: "https://vercel.com/acme/web/abc" },
        { key: "old-ci", name: "Old CI", state: "STOPPED" },
      ],
    },
    ...overrides,
  });

  it("maps the newest pipeline of each kind to checks, and commit statuses without Pipelines' own", async () => {
    const calls = mockBitbucket(routes());
    const { checks, statuses } = await apiToken().checksFor(REPO, SHA);
    expect(calls[0]!.url.searchParams.get("target.commit.hash")).toBe(SHA);
    expect(checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["army/*: Build", "completed", "success"],
      ["army/*: Test", "completed", "failure"],
      ["army/*: Lint", "completed", "skipped"],
      ["deploy: Smoke", "in_progress", null],
      ["deploy: Release", "completed", "action_required"],
    ]);
    const test = checks[1]!;
    expect(test).toMatchObject({
      id: syntheticId("{bbbbbbbb-0000-0000-0000-000000000002}"),
      app: PIPELINES_APP,
      ref: `${P1}/{bbbbbbbb-0000-0000-0000-000000000002}`,
      title: "Pipeline #42",
      summary: "Exit code 1",
      detailsUrl: `https://bitbucket.org/acme/web/pipelines/results/42/steps/${enc("{bbbbbbbb-0000-0000-0000-000000000002}")}`,
    });
    expect(Number.isSafeInteger(test.id) && test.id > 0).toBe(true);
    expect(statuses).toEqual([
      { context: "Vercel", state: "pending", description: "Building", targetUrl: "https://vercel.com/acme/web/abc" },
      { context: "Old CI", state: "error", description: null, targetUrl: null },
    ]);
    // The superseded run of the same kind is not read.
    expect(calls.some((c) => c.url.pathname.includes(enc(P0)))).toBe(false);
  });

  it("keeps Pipelines' statuses when its steps cannot be read, and resolves a short hash first", async () => {
    mockBitbucket(
      routes({
        [`GET ${API}/pipelines`]: status(403),
        [`GET ${API}/commit/0123456789ab`]: { hash: SHA },
      }),
    );
    const { checks, statuses } = await apiToken().checksFor(REPO, "0123456789ab");
    expect(checks).toEqual([]);
    expect(statuses.map((s) => [s.context, s.state])).toEqual([
      ["Pipeline #42 for army/rename", "failure"],
      ["Vercel", "pending"],
      ["Old CI", "error"],
    ]);
  });

  it("reads a step's log from the check's ref, keeping its end", async () => {
    const STEP = "{bbbbbbbb-0000-0000-0000-000000000002}";
    const long = `${"x".repeat(LOG_MAX_CHARS)}\nnpm ERR! test failed`;
    const calls = mockBitbucket({ [`GET ${API}/pipelines/${enc(P1)}/steps/${enc(STEP)}/log`]: () => new Response(long) });
    const check: CheckInfo = { id: 1, name: "Test", status: "completed", conclusion: "failure", detailsUrl: null, title: null, summary: null, text: null, app: PIPELINES_APP, ref: `${P1}/${STEP}` };
    const log = await apiToken().jobLog(REPO, check);
    expect(log).toHaveLength(LOG_MAX_CHARS);
    expect(log!.endsWith("npm ERR! test failed")).toBe(true);
    expect(calls[0]!.headers.get("range")).toMatch(/^bytes=-\d+$/);

    expect(await apiToken().jobLog(REPO, { ...check, app: "vercel" })).toBeUndefined();
    expect(await apiToken().jobLog(REPO, { ...check, ref: "../../user" })).toBeUndefined();
    expect(await apiToken().jobLog(REPO, { ...check, ref: `${P1}/{bbbbbbbb-0000-0000-0000-000000000009}` })).toBeUndefined();
    expect(await apiToken().checkAnnotations(REPO, check)).toEqual([]);
    expect(await apiToken().deploymentsFor(REPO, SHA)).toEqual([]);
  });
});

describe("Bitbucket reads", () => {
  it("reads a file, a directory and the root, at a ref with a slash resolved to its commit", async () => {
    const HASH = "fedcba9876543210fedcba9876543210fedcba98";
    const calls = mockBitbucket({
      [`GET ${API}/commits`]: { values: [{ hash: HASH }] },
      [`GET ${API}/src/${HASH}/src/a.ts?format=meta`]: { type: "commit_file", size: 12 },
      [`GET ${API}/src/${HASH}/src/a.ts`]: () => new Response("export {};\n"),
      [`GET ${API}/src/${HASH}/src?format=meta`]: { type: "commit_directory" },
      [`GET ${API}/src/${HASH}/src/`]: { values: [{ path: "src/a.ts", type: "commit_file", size: 12 }, { path: "src/lib", type: "commit_directory" }] },
      [`GET ${API}`]: { mainbranch: { name: "main" } },
      [`GET ${API}/src/main/`]: { values: [] },
    });
    const bb = apiToken();
    expect(await bb.readFile(REPO, "src/a.ts", "feature/x")).toEqual({ text: "export {};\n", truncated: false });
    expect(calls[0]!.url.searchParams.get("include")).toBe("feature/x");
    expect(await bb.readFile(REPO, "src", "feature/x")).toEqual({ text: "src/a.ts (12 bytes)\nsrc/lib/", truncated: false });
    expect(await bb.readFile(REPO, "")).toEqual({ text: "(empty directory)", truncated: false });
    await expect(bb.readFile(REPO, "../secrets")).rejects.toThrow(/Invalid path/);
  });

  it("does not read large or binary files", async () => {
    mockBitbucket({
      [`GET ${API}/src/main/big.bin?format=meta`]: { type: "commit_file", size: 5_000_000 },
      [`GET ${API}/src/main/logo.png?format=meta`]: { type: "commit_file", size: 4 },
      [`GET ${API}/src/main/logo.png`]: () => new Response(Buffer.from([0x89, 0x00, 0x50, 0x4e])),
    });
    expect(await apiToken().readFile(REPO, "big.bin", "main")).toEqual({ text: "(file too large to read through the API: 5000000 bytes)", truncated: true });
    expect(await apiToken().readFile(REPO, "logo.png", "main")).toEqual({ text: "(binary file, 4 bytes)", truncated: false });
  });

  it("knows who the token belongs to and authors commits as that account", async () => {
    mockBitbucket({
      "GET /2.0/user": { account_id: "557058:bot", username: "acme-bot", nickname: "acme-bot", display_name: "Acme Bot" },
      "GET /2.0/user/emails": { values: [{ email: "other@example.com", is_primary: false, is_confirmed: true }, { email: EMAIL, is_primary: true, is_confirmed: true }] },
    });
    const bb = apiToken();
    const viewer = await bb.viewer();
    expect(viewer).toEqual({ id: "557058:bot", login: "acme-bot", name: "Acme Bot", email: EMAIL });
    expect(bb.commitIdentity("Pointer", viewer)).toEqual({ name: "Pointer (via acme-bot)", email: EMAIL });
    expect(bb.commitIdentity("Pointer", { id: "x", login: "acme-bot" })).toEqual({ name: "Pointer (via acme-bot)", email: FALLBACK_COMMIT_EMAIL });
    expect(bb.commitIdentity("Pointer", undefined)).toEqual({ name: "Pointer", email: FALLBACK_COMMIT_EMAIL });
  });

  it("lists repositories, commits and pull requests in GitHub's shapes", async () => {
    const calls = mockBitbucket({
      "GET /2.0/repositories/acme": {
        values: [{ full_name: "acme/web", is_private: true, description: "", mainbranch: { name: "main" }, updated_on: "2026-11-01", links: { html: { href: "https://bitbucket.org/acme/web" } } }],
      },
      [`GET ${API}/commits`]: { values: [{ hash: "abc", date: "2026-11-01", message: "Fix", author: { raw: "Jane Doe <jane@example.com>" } }] },
      [`GET ${API}/pullrequests`]: {
        values: [{ id: 3, title: "T", state: "MERGED", author: { nickname: "jane" }, source: { branch: { name: "f" } }, destination: { branch: { name: "main" } }, updated_on: "2026-11-02" }],
      },
    });
    const bb = apiToken();
    expect(await bb.listRepos("bitbucket:acme")).toEqual([
      { fullName: REPO, private: true, description: null, defaultBranch: "main", updatedAt: "2026-11-01", url: "https://bitbucket.org/acme/web" },
    ]);
    expect(await bb.recentCommits(REPO, { branch: "main", limit: 5 })).toEqual([{ sha: "abc", author: "Jane Doe", date: "2026-11-01", message: "Fix" }]);
    expect(calls[1]!.url.searchParams.get("include")).toBe("main");
    expect(await bb.listPulls(REPO, { state: "closed" })).toEqual([
      { number: 3, title: "T", state: "merged", draft: false, author: "jane", head: "f", base: "main", url: "https://bitbucket.org/acme/web/pull-requests/3", updatedAt: "2026-11-02", mergedAt: "2026-11-02" },
    ]);
    expect(calls[2]!.url.searchParams.getAll("state")).toEqual(["MERGED", "DECLINED", "SUPERSEDED"]);
    await expect(bb.listIssues(REPO)).rejects.toThrow(/no issue tracker/);
  });

  it("searches code in a repository through the workspace code search", async () => {
    const calls = mockBitbucket({
      "POST /2.0/workspaces/acme/codesearch": {
        matched_files: [{ path: "src/a.ts", url: "https://bitbucket.org/acme/web/src/abc/src/a.ts", version: "abc" }, { path: "src/b.ts" }],
        repositories: [{ ns: "acme", name: "web" }],
      },
    });
    expect(await apiToken().searchCode("useThing", REPO)).toEqual([
      { repo: REPO, path: "src/a.ts", url: "https://bitbucket.org/acme/web/src/abc/src/a.ts" },
      { repo: REPO, path: "src/b.ts", url: "https://bitbucket.org/acme/web/src/HEAD/src/b.ts" },
    ]);
    expect(calls[0]!.body).toEqual({ query: { search_term: "useThing", filters: { attribute: "repository", eq: "web" } }, config: { max_results: 20 } });
  });
});
