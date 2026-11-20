import { afterEach, describe, expect, it, vi } from "vitest";
import { Bitbucket } from "../../../src/integrations/bitbucket/bitbucket.js";
import { allHostSecrets, codeHostFor } from "../../../src/integrations/code-hosts/code-host-factory.js";
import { ConfigSchema } from "../../../src/core/config.js";
import { type CheckInfo, GitHub } from "../../../src/integrations/github/github.js";
import { GitLab } from "../../../src/integrations/gitlab/gitlab.js";

const PRIMARY = "github_pat_primary_0000000000000";
const EXTRA = "ghp_extra_connection_000000000000";
const GITLAB = "glpat-gitlab-token-000000000000";
const BITBUCKET = "ATATT-bitbucket-token-000000000";

const config = (over: object = {}) =>
  ConfigSchema.parse({
    github: {
      token: PRIMARY,
      allowedOwners: ["Acme"],
      extra: [{ id: "gh-abc123", token: EXTRA, login: "octo-dev", allowed: ["Partner-Co/Acme"] }],
    },
    ...over,
  });

const tokenOf = (r: ReturnType<typeof codeHostFor>) => (r.ok ? r.host.secrets()[0] : undefined);

describe("codeHostFor", () => {
  it("serves a GitHub repository with the connection whose allow list covers it, as before", () => {
    const c = config();
    const primary = codeHostFor(c, "Acme/web");
    expect(primary.ok && primary.host).toBeInstanceOf(GitHub);
    expect(primary.ok && primary.host.kind).toBe("github");
    expect(tokenOf(primary)).toBe(PRIMARY);
    expect(tokenOf(codeHostFor(c, "partner-co/acme"))).toBe(EXTRA);
    expect(tokenOf(codeHostFor(ConfigSchema.parse({ github: { token: PRIMARY } }), "anyone/thing"))).toBe(PRIMARY);
  });

  it("refuses a GitHub repository no connection may work on, or GitHub not connected", () => {
    expect(codeHostFor(config(), "Partner-Co/other")).toEqual({
      ok: false,
      error: "Not allowed to work on Partner-Co/other. Allowed on GitHub: Acme, Partner-Co/Acme.",
    });
    expect(codeHostFor(ConfigSchema.parse({}), "Acme/web")).toEqual({
      ok: false,
      error: "GitHub is not connected. Ask the owner to connect it on the admin page.",
    });
  });

  it("serves gitlab: and bitbucket: repositories with their own clients, within their allow lists", () => {
    const c = config({
      gitlab: { token: GITLAB, baseUrl: "https://gitlab.example.com", allowed: ["acme/platform"] },
      bitbucket: { token: BITBUCKET, email: "octo-dev@example.com", allowed: ["acme"] },
    });
    const gitlab = codeHostFor(c, "gitlab:acme/platform/web");
    expect(gitlab.ok && gitlab.host).toBeInstanceOf(GitLab);
    expect(gitlab.ok && gitlab.host.kind).toBe("gitlab");
    // The allow list goes to the client too, which checks each project's real path against it.
    expect(gitlab.ok && (gitlab.host as GitLab).options).toEqual({ token: GITLAB, baseUrl: "https://gitlab.example.com", allowed: ["acme/platform"] });

    const bitbucket = codeHostFor(c, "bitbucket:acme/web");
    expect(bitbucket.ok && bitbucket.host).toBeInstanceOf(Bitbucket);
    expect(bitbucket.ok && (bitbucket.host as Bitbucket).options).toEqual({ token: BITBUCKET, email: "octo-dev@example.com" });

    expect(codeHostFor(c, "gitlab:acme/other")).toEqual({
      ok: false,
      error: "Not allowed to work on gitlab:acme/other. Allowed on GitLab: acme/platform.",
    });
    expect(codeHostFor(config(), "bitbucket:acme/web")).toEqual({
      ok: false,
      error: "Bitbucket is not connected. Ask the owner to connect it on the admin page.",
    });
  });

  it("sends a Bitbucket access token without an email", () => {
    const r = codeHostFor(config({ bitbucket: { token: BITBUCKET, email: "  " } }), "bitbucket:acme/web");
    expect(r.ok && (r.host as Bitbucket).options).toEqual({ token: BITBUCKET });
  });

  it("refuses anything that is not a repository id", () => {
    for (const repo of ["../etc", "acme/web/extra", "gitlab:", "bitbucket:acme", "https://github.com/acme/web", "acme/.."]) {
      const r = codeHostFor(config(), repo);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("is not a repository");
    }
  });
});

describe("allHostSecrets", () => {
  it("has every GitHub connection's token, git header and Basic value, and the other hosts' client secrets", () => {
    const c = config({ gitlab: { token: GITLAB }, bitbucket: { token: BITBUCKET } });
    const secrets = allHostSecrets(c);
    for (const token of [PRIMARY, EXTRA]) {
      const header = new GitHub(token).gitAuthHeader();
      expect(secrets).toEqual(expect.arrayContaining([token, header, header.split(" ").pop()]));
    }
    expect(secrets).toEqual(expect.arrayContaining([GITLAB, BITBUCKET]));
    expect(allHostSecrets(ConfigSchema.parse({}))).toEqual([]);
  });
});

describe("the GitHub client as a code host", () => {
  afterEach(() => vi.unstubAllGlobals());
  const gh = new GitHub("ghp_codehost_token_00000000000");
  const check = (over: Partial<CheckInfo>): CheckInfo => ({
    id: 99,
    name: "test",
    status: "completed",
    conclusion: "failure",
    detailsUrl: null,
    title: null,
    summary: null,
    text: null,
    app: "github-actions",
    ...over,
  });

  it("clones from github.com with the header scoped to github.com, never in the URL", () => {
    expect(gh.kind).toBe("github");
    expect(gh.cloneUrl("acme/web")).toBe("https://github.com/acme/web.git");
    expect(gh.gitAuthArgs()).toEqual(["-c", `http.https://github.com/.extraheader=${gh.gitAuthHeader()}`]);
    expect(gh.secrets()).toEqual(["ghp_codehost_token_00000000000", gh.gitAuthHeader(), gh.gitAuthHeader().split(" ").pop()]);
    expect(gh.prWebUrl("acme/web", 7)).toBe("https://github.com/acme/web/pull/7");
  });

  it("reads annotations by the check's id, a job log only for GitHub Actions, and marks a draft ready by its node id", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (url.endsWith("/logs")) return new Response("##[error] boom", { status: 200 });
        if (url.endsWith("/graphql")) return Response.json({ data: {} });
        return Response.json([{ path: "src/a.ts", start_line: 3, annotation_level: "failure", title: null, message: "boom" }]);
      }),
    );
    expect(await gh.checkAnnotations("acme/web", check({}))).toEqual([{ path: "src/a.ts", startLine: 3, level: "failure", title: null, message: "boom" }]);
    expect(await gh.jobLog("acme/web", check({}))).toBe("##[error] boom");
    expect(await gh.jobLog("acme/web", check({ app: "vercel" }))).toBeUndefined();
    await gh.markReady("acme/web", { number: 4, html_url: "https://github.com/acme/web/pull/4", node_id: "PR_kwDO123", draft: true });
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/web/check-runs/99/annotations?per_page=50",
      "https://api.github.com/repos/acme/web/actions/jobs/99/logs",
      "https://api.github.com/graphql",
    ]);
    expect(bodies).toEqual([expect.objectContaining({ variables: { id: "PR_kwDO123" } })]);
  });
});
