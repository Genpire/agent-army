import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/agents.js";
import { type CheckInfo, type DeploymentInfo, type DeploymentStatusInfo, GitHub, type IssueComment, type StatusInfo } from "../src/github.js";
import {
  BYPASS_COOKIE_PARAM,
  BYPASS_PARAM,
  PREVIEW_BUDGET_MAX_USD,
  PREVIEW_RUN_MAX_MS,
  PREVIEW_WAIT_MAX_MS,
  type PreviewCheckDeps,
  type PreviewHost,
  bypassUrl,
  checkPreview,
  deploymentState,
  findPreview,
  firstSentences,
  isProductionDeployment,
  isVisibleFile,
  netlifyPreviewFromComment,
  parsePreviewReport,
  previewBudgetUsd,
  previewComment,
  previewDecision,
  previewEventText,
  previewPrompt,
  previewRunMs,
  previewSlackLine,
  previewWaitMs,
  previewsFromStatuses,
  startBypassRedirect,
  touchesVisible,
  vercelPreviewFromComment,
} from "../src/preview.js";
import { estimateRange, previewStatus, sizeDetail, sizeLine } from "../web/src/pages/chat/labels.js";

const SHA = "8a4674fe39e8526675dcd078271f535d55012932";

const deployment = (id: number, environment: string, over: Partial<DeploymentInfo> = {}): DeploymentInfo => ({
  id,
  sha: SHA,
  environment,
  originalEnvironment: environment,
  production: false,
  transient: false,
  createdAt: new Date(Date.UTC(2026, 10, 19, 12, 0, id % 60)).toISOString(),
  creator: "vercel[bot]",
  ...over,
});

let statusId = 1000;
const status = (state: DeploymentStatusInfo["state"], environmentUrl: string | null = null, createdAt = "2026-11-19T12:05:00Z"): DeploymentStatusInfo => ({
  id: (statusId += 1),
  state,
  environmentUrl,
  createdAt,
});

const http = (code: number, detail = "Resource not accessible by personal access token") =>
  new Error(`GitHub GET /repos/acme/web/deployments failed (HTTP ${code}): ${detail}`);

type Script<T> = (T | Error)[];

/** A fake GitHub answering each call from a script (the last answer repeats), and a clock that sleep moves. */
function fake(o: {
  deployments?: Script<DeploymentInfo[]>;
  statuses?: Record<number, Script<DeploymentStatusInfo[]>>;
  comments?: IssueComment[] | Error;
}) {
  let t = 0;
  const calls = { deployments: 0, statuses: new Map<number, number>() };
  const next = <T>(script: Script<T>, i: number): T => {
    const answer = script[Math.min(i, script.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const github = {
    deploymentsFor: vi.fn(async (_repo: string, _sha: string) => next(o.deployments ?? [[]], calls.deployments++)),
    deploymentStatuses: vi.fn(async (_repo: string, id: number) => {
      const i = calls.statuses.get(id) ?? 0;
      calls.statuses.set(id, i + 1);
      return next(o.statuses?.[id] ?? [[]], i);
    }),
    issueComments: vi.fn(async (_repo: string, _n: number) => {
      if (o.comments instanceof Error) throw o.comments;
      return o.comments ?? [];
    }),
    commentOnPr: vi.fn(async (_repo: string, _n: number, _body: string) => {}),
  };
  return { github, now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
}

const find = (f: ReturnType<typeof fake>, over: Partial<Parameters<typeof findPreview>[3]> = {}) =>
  findPreview(f.github, "acme/web", SHA, { prNumber: 12, waitMs: PREVIEW_WAIT_MAX_MS, pollMs: 15_000, now: f.now, sleep: f.sleep, ...over });

/** The metadata line of a real Vercel bot comment (Nov 2026), with the project's state set. */
const vcMeta = (previewUrl: string, nextCommitStatus: string) =>
  `[vc]: #y73kyealTeM+KtBtH/wrHG5Q5zEl1cYp+JDIQlZEkw4=:${Buffer.from(
    JSON.stringify({ isMonorepo: true, type: "github", projects: [{ name: "web", previewUrl, nextCommitStatus, rootDirectory: "apps/web" }] }),
  ).toString("base64")}`;

const vercelComment = (body: string, updatedAt = "2026-11-19T12:10:00Z", over: Partial<IssueComment> = {}): IssueComment => ({
  id: 1,
  author: "vercel[bot]",
  bot: true,
  body,
  createdAt: "2026-11-19T11:00:00Z",
  updatedAt,
  ...over,
});

const READY_TABLE = [
  "The latest updates on your projects. Learn more about [Vercel for GitHub](https://vercel.link/github-learn-more).",
  "",
  "| Project | Deployment | Actions | Updated |",
  "| :--- | :----- | :------ | :------ |",
  "| [web](https://vercel.com/acme/web) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/acme/web/53Cc) | [Preview](https://web-git-army-sidebar-acme.vercel.app) | Nov 19, 2026 |",
].join("\n");

describe("finding the preview deployment", () => {
  it("waits for a pending deployment, then uses its success status's environment URL", async () => {
    const f = fake({
      deployments: [[deployment(7, "Preview – web")]],
      statuses: {
        7: [[], [status("pending")], [status("in_progress"), status("pending")], [status("success", "https://web-abc123-acme.vercel.app", "2026-11-19T12:06:00Z"), status("in_progress")]],
      },
    });
    const found = await find(f);
    expect(found).toEqual({
      ok: true,
      found: { url: "https://web-abc123-acme.vercel.app/", environment: "Preview – web", source: "deployment", vercel: true, others: [] },
    });
    expect(f.elapsed()).toBe(45_000);
    expect(f.github.issueComments).not.toHaveBeenCalled();
  });

  it("ignores production deployments, Vercel's included (production_environment false)", async () => {
    const f = fake({
      deployments: [[deployment(9, "Production – web"), deployment(8, "Preview – web")]],
      statuses: {
        9: [[status("success", "https://web.acme.com")]],
        8: [[status("success", "https://web-preview-acme.vercel.app")]],
      },
    });
    const found = await find(f);
    expect(found.ok && found.found.url).toBe("https://web-preview-acme.vercel.app/");
    expect(f.github.deploymentStatuses).not.toHaveBeenCalledWith("acme/web", 9);

    const onlyProduction = fake({ deployments: [[deployment(9, "Production – web")]], statuses: { 9: [[status("success", "https://web.acme.com")]] } });
    expect(await find(onlyProduction, { graceMs: 0 })).toEqual({ ok: false, note: "No preview deployment was found for this commit." });
    expect(isProductionDeployment({ environment: "production", originalEnvironment: null, production: false })).toBe(true);
    expect(isProductionDeployment({ environment: "github-pages", originalEnvironment: null, production: false })).toBe(true);
    expect(isProductionDeployment({ environment: "staging", originalEnvironment: null, production: true })).toBe(true);
    expect(isProductionDeployment({ environment: "Preview – production-tools", originalEnvironment: null, production: false })).toBe(false);
  });

  it("is unavailable with a note when the token may not read deployments (403) and no bot comment helps", async () => {
    const f = fake({ deployments: [http(403)] });
    expect(await find(f)).toEqual({ ok: false, note: "GitHub refused to list the deployments: the token needs Deployments: read to find the preview." });
    expect(f.github.deploymentsFor).toHaveBeenCalledTimes(1);
    expect(f.elapsed()).toBe(0);
  });

  it("retries a rate limit and server errors", async () => {
    const f = fake({
      deployments: [http(403, "API rate limit exceeded"), http(502, "Bad Gateway"), [deployment(3, "Preview")]],
      statuses: { 3: [[status("success", "https://acme-web-x1.vercel.app")]] },
    });
    const found = await find(f);
    expect(found.ok && found.found.url).toBe("https://acme-web-x1.vercel.app/");
    expect(f.github.deploymentsFor).toHaveBeenCalledTimes(3);
  });

  it("uses the last success of a deployment another pull request made inactive", () => {
    expect(
      deploymentState([status("inactive", "https://web-old.vercel.app", "2026-11-19T12:10:00Z"), status("success", "https://web-x1.vercel.app", "2026-11-19T12:05:00Z")]),
    ).toEqual({ state: "ready", url: "https://web-x1.vercel.app/" });
    expect(deploymentState([status("success", "javascript:alert(1)")])).toEqual({ state: "none" });
    expect(deploymentState([status("success", "https://user:pw@web.vercel.app")])).toEqual({ state: "none" });
    expect(deploymentState([status("error", null, "2026-11-19T12:10:00Z"), status("in_progress", null, "2026-11-19T12:05:00Z")])).toEqual({ state: "failed" });
    expect(deploymentState([])).toEqual({ state: "pending" });
  });

  it("says when the deployment failed or is still building when time runs out", async () => {
    const failed = fake({ deployments: [[deployment(4, "Preview – web")]], statuses: { 4: [[status("failure")]] } });
    expect(await find(failed)).toEqual({ ok: false, note: "The preview deployment failed (Preview – web)." });

    const building = fake({ deployments: [[deployment(5, "Preview")]], statuses: { 5: [[status("in_progress")]] } });
    expect(await find(building, { waitMs: 2 * 60_000 })).toEqual({ ok: false, note: "The preview deployment was still building after 2 min." });
    expect(building.elapsed()).toBe(2 * 60_000);
  });

  it("prefers the monorepo project the change touches and lists the other previews", async () => {
    const f = fake({
      deployments: [[deployment(21, "Preview – docs"), deployment(20, "Preview – web")]],
      statuses: { 21: [[status("success", "https://docs-x.vercel.app")]], 20: [[status("success", "https://web-x.vercel.app")]] },
    });
    const found = await find(f, { files: ["apps/web/app/page.tsx"] });
    expect(found.ok && found.found).toMatchObject({ url: "https://web-x.vercel.app/", environment: "Preview – web", others: ["https://docs-x.vercel.app/"] });
  });

  it("falls back to the Vercel bot's comment when there is no deployment, or the token may not read them", async () => {
    const none = fake({ deployments: [[]], comments: [vercelComment(`${vcMeta("web-git-army-sidebar-acme.vercel.app", "DEPLOYED")}\n${READY_TABLE}`)] });
    expect(await find(none, { graceMs: 30_000 })).toEqual({
      ok: true,
      found: { url: "https://web-git-army-sidebar-acme.vercel.app/", source: "comment", vercel: true, others: [] },
    });
    expect(none.elapsed()).toBe(30_000);

    const denied = fake({ deployments: [http(404, "Not Found")], comments: [vercelComment(READY_TABLE)] });
    const found = await find(denied);
    expect(found.ok && found.found.url).toBe("https://web-git-army-sidebar-acme.vercel.app/");
  });

  it("ignores a bot comment from before the head commit, other authors, and comments it cannot read", async () => {
    const stale = fake({ deployments: [[]], comments: [vercelComment(READY_TABLE, "2026-11-19T09:00:00Z")] });
    expect(await find(stale, { graceMs: 0, since: "2026-11-19T12:00:00+02:00" })).toMatchObject({ ok: false });
    // 12:00+02:00 is 10:00Z: a comment updated at 10:30Z describes this push.
    const fresh = fake({ deployments: [[]], comments: [vercelComment(READY_TABLE, "2026-11-19T10:30:00Z")] });
    expect(await find(fresh, { graceMs: 0, since: "2026-11-19T12:00:00+02:00" })).toMatchObject({ ok: true });

    const human = fake({ deployments: [[]], comments: [vercelComment(READY_TABLE, undefined, { author: "mallory", bot: false })] });
    expect(await find(human, { graceMs: 0 })).toMatchObject({ ok: false });
    const unreadable = fake({ deployments: [[]], comments: new Error("GitHub GET … failed (HTTP 403): no") });
    expect(await find(unreadable, { graceMs: 0 })).toEqual({ ok: false, note: "No preview deployment was found for this commit." });
  });
});

describe("the Vercel bot's comment", () => {
  it("reads the preview from the metadata only when deployed", () => {
    expect(vercelPreviewFromComment(vcMeta("web-git-x-acme.vercel.app", "DEPLOYED"))).toBe("https://web-git-x-acme.vercel.app/");
    expect(vercelPreviewFromComment(vcMeta("web-git-x-acme.vercel.app", "PENDING"))).toBeUndefined();
  });

  it("reads a Ready table row, new and old formats, and skips rows still building", () => {
    expect(vercelPreviewFromComment(READY_TABLE)).toBe("https://web-git-army-sidebar-acme.vercel.app/");
    const old = "| **web** | ✅ Ready ([Inspect](https://vercel.com/acme/web/AbC)) | [Visit Preview](https://web-git-x-acme.vercel.app) | Jan 1, 2026 |";
    expect(vercelPreviewFromComment(old)).toBe("https://web-git-x-acme.vercel.app/");
    const building = "| web | ![Building](https://vercel.com/static/status/building.svg) [Building](https://vercel.com/acme/web/x) | [Preview](https://web-git-x-acme.vercel.app) | Nov 19 |";
    expect(vercelPreviewFromComment(building)).toBeUndefined();
    expect(vercelPreviewFromComment("Your Vercel team is not permitted to deploy from this git repository.")).toBeUndefined();
  });
});

/** Netlify's deploy preview comment (format as Netlify posts it; not checked against a live account). */
const NETLIFY_READY_COMMENT = [
  '### <span aria-hidden="true">✅</span> Deploy Preview for *acme-web* ready!',
  "",
  "|  Name | Link |",
  "|:-:|------------------------|",
  '|<span aria-hidden="true">🔨</span> Latest commit | 8a4674f |',
  '|<span aria-hidden="true">🔍</span> Latest deploy log | https://app.netlify.com/sites/acme-web/deploys/6740 |',
  '|<span aria-hidden="true">😎</span> Deploy Preview | [https://deploy-preview-12--acme-web.netlify.app](https://deploy-preview-12--acme-web.netlify.app) |',
].join("\n");
const NETLIFY_URL = "https://deploy-preview-12--acme-web.netlify.app/";

const commitStatus = (context: string, targetUrl: string | null, state: StatusInfo["state"] = "success"): StatusInfo => ({
  context,
  state,
  description: null,
  targetUrl,
});
const ciCheck = (name: string, detailsUrl: string | null, over: Partial<CheckInfo> = {}): CheckInfo => ({
  id: 1,
  name,
  status: "completed",
  conclusion: "success",
  detailsUrl,
  title: null,
  summary: null,
  text: null,
  app: null,
  ...over,
});

/** A code host without deployments (as Bitbucket), its commit's statuses and checks and the request's comments given. */
function hostWithout(o: { kind?: "github" | "gitlab" | "bitbucket"; statuses?: StatusInfo[]; checks?: CheckInfo[]; comments?: IssueComment[]; denied?: boolean }) {
  return {
    ...(o.kind ? { kind: o.kind } : {}),
    deploymentsFor: vi.fn(async (): Promise<DeploymentInfo[]> => {
      if (o.denied) throw new Error("GitLab GET /projects/acme%2Fweb/deployments failed (HTTP 403): Forbidden");
      return [];
    }),
    deploymentStatuses: vi.fn(async (): Promise<DeploymentStatusInfo[]> => []),
    issueComments: vi.fn(async () => o.comments ?? []),
    checksFor: vi.fn(async () => ({ checks: o.checks ?? [], statuses: o.statuses ?? [] })),
  } satisfies PreviewHost;
}
const findOn = (host: PreviewHost, repo = "gitlab:acme/web") => findPreview(host, repo, SHA, { prNumber: 12, waitMs: PREVIEW_WAIT_MAX_MS, graceMs: 0 });

describe("finding the preview on any code host", () => {
  it("uses a successful commit status or check that links a preview platform, where the host has no deployments", async () => {
    const host = hostWithout({
      kind: "bitbucket",
      statuses: [
        commitStatus("ci/build", "https://ci.example.com/builds/1"),
        commitStatus("Vercel", "https://vercel.com/acme/web/AbCd"),
        commitStatus("pages", "https://9f1c.web-x.pages.dev", "pending"),
        commitStatus("netlify/acme-web/deploy-preview", "https://deploy-preview-12--acme-web.netlify.app"),
      ],
      checks: [ciCheck("Cloudflare Pages", "https://3f2a.docs-x.pages.dev"), ciCheck("Vercel – web", "https://web-x.vercel.app", { conclusion: "failure" })],
    });
    expect(await findOn(host, "bitbucket:acme/web")).toEqual({
      ok: true,
      found: { url: NETLIFY_URL, source: "status", vercel: false, others: ["https://3f2a.docs-x.pages.dev/"] },
    });
    expect(host.issueComments).not.toHaveBeenCalled();
  });

  it("lets a status's Vercel preview have the bypass: setting statuses takes write access", async () => {
    const host = hostWithout({ kind: "gitlab", statuses: [commitStatus("Vercel", "https://web-git-army-x-acme.vercel.app")] });
    const found = await findOn(host);
    expect(found.ok && found.found).toMatchObject({ url: "https://web-git-army-x-acme.vercel.app/", source: "status", vercel: true });
  });

  it("reads statuses only as links on the preview platforms, successful, without credentials", () => {
    expect(
      previewsFromStatuses({
        checks: [ciCheck("deploy", "https://user:pw@web-x.vercel.app"), ciCheck("pending", "https://a.pages.dev", { status: "in_progress", conclusion: null })],
        statuses: [
          commitStatus("a", "https://evil.example.com/?next=web.vercel.app"),
          commitStatus("b", "javascript:alert(1)"),
          commitStatus("c", "https://web.vercel.app.evil.example.com"),
          commitStatus("d", "https://x.netlify.app", "failure"),
          commitStatus("e", null),
        ],
      }),
    ).toEqual([]);
  });

  it("on GitLab and Bitbucket, reads Vercel's and Netlify's comments by any author, on their preview domains only", async () => {
    const byPerson = { author: "octo-dev", bot: false };
    const vercel = await findOn(hostWithout({ kind: "gitlab", comments: [vercelComment(READY_TABLE, undefined, byPerson)] }));
    // The integrations comment through the account that connected them: a person's comment never gets the bypass.
    expect(vercel).toEqual({ ok: true, found: { url: "https://web-git-army-sidebar-acme.vercel.app/", source: "comment", vercel: false, others: [] } });

    const byBot = await findOn(hostWithout({ kind: "gitlab", comments: [vercelComment(READY_TABLE, undefined, { author: "project_12_bot", bot: true })] }));
    expect(byBot.ok && byBot.found.vercel).toBe(true);

    const elsewhere = vercelComment(vcMeta("preview.evil.example.com", "DEPLOYED"), undefined, byPerson);
    expect(await findOn(hostWithout({ kind: "gitlab", comments: [elsewhere] }))).toEqual({ ok: false, note: "No preview deployment was found for this commit." });

    const netlify = await findOn(hostWithout({ kind: "bitbucket", comments: [vercelComment(NETLIFY_READY_COMMENT, undefined, byPerson)] }), "bitbucket:acme/web");
    expect(netlify).toEqual({ ok: true, found: { url: NETLIFY_URL, source: "comment", vercel: false, others: [] } });
  });

  it("on GitHub, reads the Netlify bot's comment, never a person's", async () => {
    const bot = await findOn(hostWithout({ comments: [vercelComment(NETLIFY_READY_COMMENT, undefined, { author: "netlify[bot]" })] }), "acme/web");
    expect(bot).toEqual({ ok: true, found: { url: NETLIFY_URL, source: "comment", vercel: false, others: [] } });
    const person = await findOn(hostWithout({ comments: [vercelComment(NETLIFY_READY_COMMENT, undefined, { author: "mallory", bot: false })] }), "acme/web");
    expect(person.ok).toBe(false);
  });

  it("names the host in its notes", async () => {
    expect(await findOn(hostWithout({ kind: "gitlab", denied: true }))).toEqual({
      ok: false,
      note: "GitLab refused to list the deployments: the token needs read access to the project's environments to find the preview.",
    });
    const silent = { ...hostWithout({ kind: "bitbucket" }), deploymentsFor: vi.fn(async (): Promise<DeploymentInfo[]> => {
      throw new Error("Bitbucket GET … failed (HTTP 502): Bad Gateway");
    }) };
    let t = 0;
    const note = await findPreview(silent, "bitbucket:acme/web", SHA, { prNumber: 12, waitMs: 60_000, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(note).toEqual({ ok: false, note: "The deployments could not be read: Bitbucket did not answer." });
  });
});

describe("Netlify's comment", () => {
  it("reads the deploy preview once it is ready, never the deploy log", () => {
    expect(netlifyPreviewFromComment(NETLIFY_READY_COMMENT)).toBe(NETLIFY_URL);
    const building = NETLIFY_READY_COMMENT.replace("✅</span> Deploy Preview for *acme-web* ready!", "👷</span> Deploy Preview for *acme-web* processing.");
    expect(netlifyPreviewFromComment(building)).toBeUndefined();
    expect(netlifyPreviewFromComment("Deploy Preview for *x* ready!\n| Deploy Preview | https://evil.example.com |")).toBeUndefined();
  });
});

describe("when to check the preview", () => {
  it("counts markup, styles, assets and page or component code as visible, not tests", () => {
    for (const file of [
      "src/components/Sidebar.tsx",
      "web/src/App.vue",
      "src/routes/+page.svelte",
      "styles/globals.css",
      "src/theme/tokens.ts",
      "public/logo.svg",
      "app/dashboard/page.ts",
      "app/views/users/show.html.erb",
      "tailwind.config.ts",
      "src/pages/docs/intro.mdx",
    ]) {
      expect(isVisibleFile(file), file).toBe(true);
    }
    for (const file of [
      "src/components/Sidebar.test.tsx",
      "test/ui.spec.ts",
      "e2e/home.spec.tsx",
      "src/components/__tests__/Button.tsx",
      "src/Button.stories.tsx",
      "src/server.ts",
      "app/api/users/route.ts",
      "README.md",
      "package.json",
      "src/types.d.ts",
    ]) {
      expect(isVisibleFile(file), file).toBe(false);
    }
    expect(touchesVisible(["src/server.ts", "test/server.test.ts"])).toBe(false);
    expect(touchesVisible(["src/server.ts", "src/components/Nav.jsx"])).toBe(true);
  });

  it("skips when off, always checks when always, and checks visible changes only by default", () => {
    const backend = ["src/server.ts"];
    const ui = ["src/components/Nav.tsx"];
    expect(previewDecision("off", ui)).toEqual({ check: false, result: { state: "skipped", note: "Preview checks are turned off." } });
    expect(previewDecision("always", backend)).toEqual({ check: true });
    expect(previewDecision("visible", ui)).toEqual({ check: true });
    expect(previewDecision("visible", backend)).toEqual({ check: false, result: { state: "skipped", note: "The change does not touch what people see." } });
    expect(previewDecision("visible", ["src/components/Nav.test.tsx"])).toMatchObject({ check: false });
  });

  it("budgets at most $2 of what is left and never under $0.50", () => {
    expect(previewBudgetUsd(15, 3)).toBe(PREVIEW_BUDGET_MAX_USD);
    expect(previewBudgetUsd(15, 13.8)).toBe(1.2);
    expect(previewBudgetUsd(15, 14.6)).toBeNull();
  });

  it("bounds the wait and the check by the deadline", () => {
    const now = 1_000_000;
    expect(previewWaitMs(undefined, now)).toBe(PREVIEW_WAIT_MAX_MS);
    expect(previewWaitMs(now + 30 * 60_000, now)).toBe(PREVIEW_WAIT_MAX_MS);
    expect(previewWaitMs(now + 6 * 60_000, now)).toBe(2 * 60_000);
    expect(previewWaitMs(now + 3 * 60_000, now)).toBeNull();
    expect(previewRunMs(undefined, now)).toBe(PREVIEW_RUN_MAX_MS);
    expect(previewRunMs(now + 7 * 60_000, now)).toBe(7 * 60_000);
    expect(previewRunMs(now + 3 * 60_000, now)).toBeNull();
  });
});

const SECRET = "vErCeLbYpAsS0123456789abcdefABCD";

const promptOptions = {
  url: "https://web-abc123-acme.vercel.app/",
  environment: "Preview – web",
  title: "Collapse the sidebar on small screens",
  summary: "The sidebar collapses into a menu button under 768px.",
  files: ["src/components/Sidebar.tsx", "src/styles/sidebar.css"],
  base: "main",
  branch: "army/sidebar-abc123",
  request: "Make the sidebar collapsible on mobile",
};

describe("the preview round's prompt", () => {
  it("gives the URL, what changed, the verdict line, and forbids changes", () => {
    const prompt = previewPrompt(promptOptions);
    expect(prompt).toContain("https://web-abc123-acme.vercel.app/");
    expect(prompt).toContain("Preview – web");
    expect(prompt).toContain("Collapse the sidebar on small screens");
    expect(prompt).toContain("- src/components/Sidebar.tsx");
    expect(prompt).toContain("Make the sidebar collapsible on mobile");
    expect(prompt).toContain("nobody changes code");
    expect(prompt).toContain('kind "answer"');
    expect(prompt).toContain('"Preview: checked"');
    expect(prompt).toContain('"Preview: problems"');
    expect(prompt).toContain("browser_console_messages");
    expect(prompt).toContain("390 wide");
    expect(prompt).toContain("do not start it locally");
    // Without the secret: how to get past a login wall.
    expect(prompt).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(prompt).toContain("report it as blocked");
  });

  it("with the bypass, points to the local redirect and names the variable, never its value", () => {
    const prompt = previewPrompt({ ...promptOptions, bypassEntryUrl: "http://127.0.0.1:4321/abc" });
    expect(prompt).toContain("Open http://127.0.0.1:4321/abc first");
    expect(prompt).toContain('curl -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"');
    expect(prompt).toContain("Never print, echo or log it");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain("report it as blocked and say that the owner");
  });

  it("lists at most 60 changed files", () => {
    const files = Array.from({ length: 75 }, (_, i) => `src/components/C${i}.tsx`);
    const prompt = previewPrompt({ ...promptOptions, files });
    expect(prompt).toContain("Changed files (75):");
    expect(prompt).toContain("- …and 15 more");
    expect(prompt).not.toContain("C60.tsx");
  });
});

describe("the bypass redirect", () => {
  it("adds the bypass and cookie parameters, only on the preview's own origin", () => {
    const url = new URL(bypassUrl("https://web-x.vercel.app/", "/settings?tab=2", SECRET)!);
    expect(url.origin).toBe("https://web-x.vercel.app");
    expect(url.pathname).toBe("/settings");
    expect(url.searchParams.get("tab")).toBe("2");
    expect(url.searchParams.get(BYPASS_PARAM)).toBe(SECRET);
    expect(url.searchParams.get(BYPASS_COOKIE_PARAM)).toBe("true");
    expect(bypassUrl("https://web-x.vercel.app/", "//evil.example/x", SECRET)).toBeNull();
    expect(bypassUrl("https://web-x.vercel.app/", "/\\evil.example/x", SECRET)).toBeNull();
    expect(bypassUrl("https://web-x.vercel.app/", "https://evil.example/", SECRET)).toBeNull();
  });

  it("serves the redirect on 127.0.0.1 under a random path only", async () => {
    const redirect = await startBypassRedirect("https://web-x.vercel.app/", SECRET);
    try {
      expect(redirect.entryUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{24}$/);
      expect(redirect.entryUrl).not.toContain(SECRET);
      const res = await fetch(`${redirect.entryUrl}/pricing`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.href).toBe(`https://web-x.vercel.app/pricing?${BYPASS_PARAM}=${SECRET}&${BYPASS_COOKIE_PARAM}=true`);
      expect((await fetch(new URL(redirect.entryUrl).origin + "/other", { redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${redirect.entryUrl}//evil.example/`, { redirect: "manual" })).status).toBe(404);
    } finally {
      redirect.close();
    }
  });
});

const report = (over: Partial<Report>): Report => ({ kind: "answer", title: "Preview check", summary: "", verification: "", risks: "", projectNotes: "", ...over });
const URL_ = "https://web-x.vercel.app/";

describe("reading the preview round's report", () => {
  it("takes the verdict line and the next sentences as the note", () => {
    const ok = parsePreviewReport(
      report({
        summary: "Preview: checked\nThe sidebar collapses into a menu button at 390 wide. The desktop layout is unchanged. Console was clean on all pages.",
        verification: "Opened /, /settings at 1280 and 390.",
      }),
      URL_,
    );
    expect(ok.result).toEqual({ state: "checked", url: URL_, note: "The sidebar collapses into a menu button at 390 wide. The desktop layout is unchanged." });
    expect(ok.details).toContain("Console was clean");
    expect(ok.details).toContain("**Verification:** Opened /, /settings");
    expect(ok.details).not.toMatch(/Preview: checked/);

    const bad = parsePreviewReport(report({ summary: "**Preview:** problems — the menu button overlaps the logo at 390 wide.\n\nMore details." }), URL_);
    expect(bad.result).toEqual({ state: "problems", url: URL_, note: "the menu button overlaps the logo at 390 wide. More details." });
  });

  it("reads a verdict in the title, a blocked report, and a report without a verdict", () => {
    expect(parsePreviewReport(report({ title: "Preview: problems", summary: "The page 404s." }), URL_).result.state).toBe("problems");
    expect(parsePreviewReport(report({ kind: "blocked", summary: "The preview asks for a Vercel login." }), URL_).result).toEqual({
      state: "unavailable",
      url: URL_,
      note: "The preview asks for a Vercel login.",
    });
    expect(parsePreviewReport(report({ summary: "The settings page is broken on mobile." }), URL_).result.state).toBe("problems");
    expect(parsePreviewReport(report({ summary: "Everything looks right." }), URL_).result.state).toBe("checked");
    expect(parsePreviewReport(report({ summary: "Preview: checked" }), URL_).result.note).toBe("The change looked right on the preview.");
  });

  it("keeps notes to two sentences of plain text", () => {
    expect(firstSentences("One. Two! Three?")).toBe("One. Two!");
    expect(firstSentences("x".repeat(400)).length).toBe(300);
    const linked = parsePreviewReport(report({ summary: "Preview: checked\nOpened [the settings page](https://web-x.vercel.app/settings) and `Nav`." }), URL_);
    expect(linked.result.note).toBe("Opened the settings page and Nav.");
  });
});

describe("reporting the preview", () => {
  it("comments on the pull request with the URL, the note and the screenshot count", () => {
    const checked = previewComment({ result: { state: "checked", url: URL_, note: "Looks right." }, screenshots: 2, where: "slack", details: "Opened /." });
    expect(checked).toContain(`**Checked the preview at ${URL_}:** Looks right.`);
    expect(checked).toContain("2 screenshots from the preview are in the Slack thread.");
    expect(checked).toContain("<details><summary>What was checked</summary>");
    const problems = previewComment({ result: { state: "problems", url: URL_, note: "The button overlaps." }, screenshots: 1, where: "web" });
    expect(problems).toContain(`**Checked the preview at ${URL_} and found problems:** The button overlaps.`);
    expect(problems).toContain("1 screenshot from the preview is in the admin console");
    expect(problems).toContain("Nothing was changed for them");
  });

  it("adds a Preview line to the Slack result, except when skipped", () => {
    expect(previewSlackLine({ state: "checked", url: URL_, note: "Looks right." })).toBe(`*Preview:* :white_check_mark: Checked <${URL_}|the preview>: Looks right.`);
    expect(previewSlackLine({ state: "problems", url: URL_, note: "A <b> tag shows." })).toContain(":warning: Problems found on");
    expect(previewSlackLine({ state: "problems", url: URL_, note: "A <b> tag shows." })).toContain("A &lt;b&gt; tag shows.");
    // A repository without preview deployments gets no line in Slack.
    expect(previewSlackLine({ state: "unavailable", note: "No preview deployment was found for this commit." })).toBe("");
    expect(previewSlackLine({ state: "unavailable", note: "The token cannot read deployments." })).toBe(
      "*Preview:* :grey_question: The token cannot read deployments.",
    );
    expect(previewSlackLine({ state: "skipped", note: "Preview checks are turned off." })).toBe("");
    expect(previewEventText({ state: "problems", note: "Overlap." })).toBe("Problems on the preview: Overlap.");
  });
});

describe("checkPreview", () => {
  afterEach(() => vi.restoreAllMocks());

  function deps(over: Partial<PreviewCheckDeps> = {}, f = fake({ deployments: [[deployment(7, "Preview – web")]], statuses: { 7: [[status("success", URL_)]] } })) {
    const events: { text: string; ok?: boolean; url?: string }[] = [];
    const stages: string[] = [];
    const prompts: string[] = [];
    const d: PreviewCheckDeps = {
      mode: "visible",
      files: ["src/components/Sidebar.tsx"],
      browser: true,
      budget: { maxUsd: 15, spentUsd: 4 },
      deadline: undefined,
      host: f.github,
      repo: "acme/web",
      sha: SHA,
      prNumber: 12,
      checksFollowed: true,
      report: { title: "Collapse the sidebar", summary: "Collapses under 768px." },
      base: "main",
      branch: "army/sidebar",
      where: "slack",
      redact: (t) => t,
      onStage: async (text) => void stages.push(text),
      onEvent: (e) => void events.push(e),
      runRound: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return { report: report({ summary: "Preview: checked\nThe sidebar collapses at 390 wide." }) };
      }),
      postScreenshots: vi.fn(async () => 2),
      now: f.now,
      find: { sleep: f.sleep },
      ...over,
    };
    return { d, f, events, stages, prompts };
  }

  it("skips without cost when the change is not visible or checks are off", async () => {
    for (const over of [{ files: ["src/server.ts"] }, { mode: "off" as const }]) {
      const { d, f, events } = deps(over);
      expect((await checkPreview(d)).state).toBe("skipped");
      expect(d.runRound).not.toHaveBeenCalled();
      expect(f.github.deploymentsFor).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    }
  });

  it("is unavailable without a browser, budget or time, before looking", async () => {
    const cases: [Partial<PreviewCheckDeps>, string][] = [
      [{ browser: false }, "This worker has no browser, so the preview could not be opened."],
      [{ budget: { maxUsd: 15, spentUsd: 14.8 } }, "Not enough of the task's budget was left to check the preview."],
      [{ deadline: 2 * 60_000 }, "Not enough time was left to check the preview."],
    ];
    for (const [over, note] of cases) {
      const { d, f, events } = deps(over);
      expect(await checkPreview(d)).toEqual({ state: "unavailable", note });
      expect(f.github.deploymentsFor).not.toHaveBeenCalled();
      expect(events).toEqual([{ text: note, ok: false }]);
    }
  });

  it("opens the preview, comments on the pull request and records the events", async () => {
    const { d, f, events, stages, prompts } = deps();
    const result = await checkPreview(d);
    expect(result).toEqual({ state: "checked", url: URL_, note: "The sidebar collapses at 390 wide." });
    expect(d.runRound).toHaveBeenCalledWith(expect.any(String), { budgetUsd: 2, runMs: PREVIEW_RUN_MAX_MS });
    expect(prompts[0]).toContain(URL_);
    expect(stages).toEqual(["Looking for the pull request's preview deployment", "Checking the preview deployment in the browser"]);
    expect(events).toEqual([
      { text: `Opening the preview at ${URL_} (Preview – web)`, url: URL_ },
      { text: "Checked the preview: The sidebar collapses at 390 wide.", ok: true, url: URL_ },
    ]);
    expect(f.github.commentOnPr).toHaveBeenCalledTimes(1);
    const [repo, number, body] = f.github.commentOnPr.mock.calls[0]!;
    expect([repo, number]).toEqual(["acme/web", 12]);
    expect(body).toContain(`**Checked the preview at ${URL_}:** The sidebar collapses at 390 wide.`);
    expect(body).toContain("2 screenshots from the preview are in the Slack thread.");
  });

  it("words the stage and the prompt for the host: a merge request on GitLab", async () => {
    const f = fake({ deployments: [[deployment(7, "Preview – web")]], statuses: { 7: [[status("success", URL_)]] } });
    const { d, stages, prompts } = deps({ host: { ...f.github, kind: "gitlab" }, repo: "gitlab:acme/web" }, f);
    expect((await checkPreview(d)).state).toBe("checked");
    expect(stages[0]).toBe("Looking for the merge request's preview deployment");
    expect(prompts[0]).toContain("The merge request is open and its checks have finished.");
    expect(prompts[0]).not.toContain("pull request");
    expect(f.github.commentOnPr.mock.calls[0]![0]).toBe("gitlab:acme/web");
  });

  it("reports problems plainly and starts no fix", async () => {
    const { d, f } = deps({
      runRound: vi.fn(async () => ({ report: report({ summary: "Preview: problems\nThe menu button overlaps the logo at 390 wide." }) })),
    });
    const result = await checkPreview(d);
    expect(result.state).toBe("problems");
    expect(d.runRound).toHaveBeenCalledTimes(1);
    expect(f.github.commentOnPr.mock.calls[0]![2]).toContain("and found problems:** The menu button overlaps the logo at 390 wide.");
  });

  it("with the bypass secret, briefs the local redirect and keeps the secret out of the prompt and the comment", async () => {
    const { d, f, prompts } = deps({
      bypassSecret: SECRET,
      runRound: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        // The redirect is live while the round runs.
        const entry = prompt.match(/Open (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+) first/)![1]!;
        const res = await fetch(entry, { redirect: "manual" });
        expect(new URL(res.headers.get("location")!).searchParams.get(BYPASS_PARAM)).toBe(SECRET);
        return { report: report({ summary: `Preview: checked\nOpened ${URL_}?${BYPASS_PARAM}=${SECRET} fine.` }) };
      }),
    });
    const result = await checkPreview(d);
    expect(prompts[0]).toMatch(/Open http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+ first/);
    expect(prompts[0]).not.toContain(SECRET);
    expect(result.note).not.toContain(SECRET);
    expect(result.note).toContain("[redacted]");
    expect(f.github.commentOnPr.mock.calls[0]![2]).not.toContain(SECRET);
  });

  it("sends the secret only to Vercel's previews", async () => {
    const netlify = fake({
      deployments: [[deployment(7, "deploy-preview", { creator: "netlify[bot]" })]],
      statuses: { 7: [[status("success", "https://deploy-preview-12--acme.netlify.app")]] },
    });
    const { d, prompts } = deps({ bypassSecret: SECRET }, netlify);
    await checkPreview(d);
    expect(prompts[0]).toContain("https://deploy-preview-12--acme.netlify.app/");
    expect(prompts[0]).not.toContain("127.0.0.1");
  });

  it("is unavailable without a comment when no preview is found or the round stops early", async () => {
    const none = deps({}, fake({ deployments: [http(403)] }));
    expect(await checkPreview(none.d)).toEqual({
      state: "unavailable",
      note: "GitHub refused to list the deployments: the token needs Deployments: read to find the preview.",
    });
    expect(none.d.runRound).not.toHaveBeenCalled();

    const stopped = deps({ runRound: vi.fn(async () => ({ failure: "Timed out after 12 minutes." })) });
    expect(await checkPreview(stopped.d)).toEqual({ state: "unavailable", url: URL_, note: "The preview check stopped early: Timed out after 12 minutes." });
    expect(stopped.f.github.commentOnPr).not.toHaveBeenCalled();
    expect(stopped.d.postScreenshots).toHaveBeenCalled();
  });
});

describe("GitHub deployments client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists a commit's deployments and statuses, and the pull request's comments", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname + new URL(url).search;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (path === `/repos/acme/web/deployments?sha=${SHA}&per_page=30`) {
        return json([
          {
            id: 6893611949,
            sha: SHA,
            environment: "Preview – web",
            original_environment: "Preview – web",
            transient_environment: false,
            production_environment: false,
            created_at: "2026-10-06T19:43:07Z",
            creator: { login: "vercel[bot]" },
          },
        ]);
      }
      if (path === "/repos/acme/web/deployments/6893611949/statuses?per_page=30") {
        return json([
          { id: 2, state: "inactive", environment_url: "", created_at: "2026-10-20T23:10:21Z" },
          { id: 1, state: "success", environment_url: "https://web-r957jz6qk.vercel.sh", created_at: "2026-10-06T19:43:07Z" },
        ]);
      }
      if (path === "/repos/acme/web/issues/12/comments?per_page=100") {
        return json([{ id: 5, user: { login: "vercel[bot]", type: "Bot" }, body: "hi", created_at: "2026-10-06T19:44:53Z", updated_at: "2026-10-06T19:50:00Z" }]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gh = new GitHub("ghp_test");
    expect(await gh.deploymentsFor("acme/web", SHA)).toEqual([
      {
        id: 6893611949,
        sha: SHA,
        environment: "Preview – web",
        originalEnvironment: "Preview – web",
        production: false,
        transient: false,
        createdAt: "2026-10-06T19:43:07Z",
        creator: "vercel[bot]",
      },
    ]);
    const statuses = await gh.deploymentStatuses("acme/web", 6893611949);
    expect(statuses).toEqual([
      { id: 2, state: "inactive", environmentUrl: null, createdAt: "2026-10-20T23:10:21Z" },
      { id: 1, state: "success", environmentUrl: "https://web-r957jz6qk.vercel.sh", createdAt: "2026-10-06T19:43:07Z" },
    ]);
    expect(deploymentState(statuses)).toEqual({ state: "ready", url: "https://web-r957jz6qk.vercel.sh/" });
    expect(await gh.issueComments("acme/web", 12)).toEqual([
      { id: 5, author: "vercel[bot]", bot: true, body: "hi", createdAt: "2026-10-06T19:44:53Z", updatedAt: "2026-10-06T19:50:00Z" },
    ]);
    await expect(gh.deploymentsFor("acme/other", SHA)).rejects.toThrow("(HTTP 404)");
  });
});

describe("the console's preview and size labels", () => {
  it("names the preview result, with its note and an http(s) link only", () => {
    expect(previewStatus({})).toBeNull();
    expect(previewStatus({ preview: { state: "checked", url: URL_, note: "Looks right." } })).toEqual({
      label: "Preview looks right",
      tone: "success",
      note: "Looks right.",
      url: URL_,
    });
    expect(previewStatus({ preview: { state: "problems", url: "javascript:alert(1)" } })).toEqual({ label: "Problems on the preview", tone: "warning" });
    expect(previewStatus({ preview: { state: "unavailable", note: "No preview deployment was found for this commit." } })?.label).toBe("Preview not checked");
    expect(previewStatus({ preview: { state: "skipped" } })?.label).toBe("Preview not needed");
  });

  it("shows the task's size and estimate when another step set them", () => {
    const size = { size: "medium" as const, model: "claude-sonnet-5-5", effort: "medium", reason: "Two components" };
    expect(sizeLine({})).toBe("");
    expect(sizeLine({ size, estimateUsd: { low: 1.2, high: 3.5 } })).toBe("Medium task · est. $1.20–$3.50");
    expect(sizeLine({ estimateUsd: { low: 2, high: 2 } })).toBe("est. $2.00");
    expect(estimateRange({ estimateUsd: { low: Number.NaN, high: 1 } })).toBe("");
    expect(sizeDetail({ size })).toBe("Medium · claude-sonnet-5-5, medium effort");
    expect(sizeDetail({ size: { ...size, size: "large", model: "" } })).toBe("Large · the configured model, medium effort");
  });
});
