import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/core/config.js";
import { isRepoAllowedOnHost, matchesPathAllowList, repoAccessError } from "../../src/integrations/code-hosts/code-host-access.js";
import { REPO_ID_MAX, isRepoId, repoFromInput } from "../../src/integrations/code-hosts/repo-id.js";
import { connectionForRepo, matchesAllowList } from "../../src/integrations/github/github-access.js";

/**
 * Which repositories the platform may work on, on both sides: an allow
 * list entry covers its own group or owner and what is under it, never a
 * name that only starts the same way; a repository id is refused when it is
 * too long, has a dot segment, or comes from a host the platform does not
 * know.
 */

describe("allow lists of groups, workspaces and repositories", () => {
  it("covers the entry itself and everything under it, in any case", () => {
    for (const path of ["acme/web", "Acme/Web", "acme/platform/web"]) expect(matchesPathAllowList(path, ["acme"]), path).toBe(true);
    expect(matchesPathAllowList("acme/platform/web", ["acme/platform"])).toBe(true);
    expect(matchesPathAllowList("acme/platform", ["acme/platform"])).toBe(true);
    expect(matchesPathAllowList("acme/web", [" /acme/ "])).toBe(true);
    expect(matchesPathAllowList("acme/web", [])).toBe(true);
  });

  it("never covers a name that only starts like an entry, a parent, or anything through an empty entry", () => {
    for (const path of ["acme-evil/web", "acmeweb/x", "other/acme", "acme"]) expect(matchesPathAllowList(path, ["acme/web", "acme/platform"]), path).toBe(false);
    for (const path of ["acme-evil/web", "acmeweb/x", "other/acme/web"]) expect(matchesPathAllowList(path, ["acme"]), path).toBe(false);
    expect(matchesPathAllowList("acme/platform-x/web", ["acme/platform"])).toBe(false);
    expect(matchesPathAllowList("other/web", ["", "  ", "/"])).toBe(false);
  });

  it("matches GitHub owners and exact repositories the same way", () => {
    expect(matchesAllowList("Acme/web", ["acme"])).toBe(true);
    expect(matchesAllowList("acme/web", ["Acme/Web"])).toBe(true);
    for (const repo of ["acme-evil/web", "acmeweb/x", "acme/web-2"]) expect(matchesAllowList(repo, ["acme/web", "partner"]), repo).toBe(false);
    expect(matchesAllowList("acme-evil/web", ["acme"])).toBe(false);
    expect(matchesAllowList("other/web", ["", " "])).toBe(false);
  });
});

describe("repoAccessError", () => {
  const config = () =>
    ConfigSchema.parse({
      github: { token: "ghp_acme_placeholder_000000000000", allowedOwners: ["acme"] },
      gitlab: { token: "glpat-acme-placeholder", allowed: ["acme/platform"] },
    });

  it("allows the repositories each host's allow list covers", () => {
    const c = config();
    for (const repo of ["acme/web", "ACME/api", "gitlab:acme/platform/web"]) expect(repoAccessError(c, repo), repo).toBeUndefined();
  });

  it("refuses the others, and a host that is not connected", () => {
    const c = config();
    for (const repo of ["acme-evil/web", "other/web", "gitlab:acme/other", "gitlab:acme/platform-x/web"]) {
      expect(repoAccessError(c, repo), repo).toMatch(/^Not allowed to work on /);
    }
    expect(repoAccessError(c, "bitbucket:acme/web")).toBe("Bitbucket is not connected. Ask the owner to connect it on the admin page.");
    expect(repoAccessError(ConfigSchema.parse({}), "acme/web")).toBe("GitHub is not connected. Ask the owner to connect it on the admin page.");
  });

  it("allows nothing on a host whose token is gone, even with its allow list still saved", () => {
    const saved = { gitlab: { allowed: ["acme"] }, bitbucket: { allowed: ["acme-ws"] } };
    const disconnected = ConfigSchema.parse(saved);
    expect(isRepoAllowedOnHost(disconnected, "gitlab:acme/web")).toBe(false);
    expect(isRepoAllowedOnHost(disconnected, "bitbucket:acme-ws/api")).toBe(false);
    const connected = ConfigSchema.parse({ gitlab: { ...saved.gitlab, token: "glpat-acme-placeholder" }, bitbucket: { ...saved.bitbucket, token: "ATATT-acme-placeholder" } });
    expect(isRepoAllowedOnHost(connected, "gitlab:acme/web")).toBe(true);
    expect(isRepoAllowedOnHost(connected, "bitbucket:acme-ws/api")).toBe(true);
  });

  it("finds no GitHub connection for a repository outside every allow list", () => {
    const c = ConfigSchema.parse({
      github: { token: "ghp_acme_placeholder_000000000000", allowedOwners: ["acme"], extra: [{ id: "gh-abc123", token: "ghp_partner_placeholder_0000000", allowed: ["partner/app"] }] },
    });
    expect(connectionForRepo(c, "other/web")).toBeUndefined();
    expect(connectionForRepo(c, "partner/app")?.id).toBe("gh-abc123");
    expect(connectionForRepo(c, "acme/web")?.id).toBe("primary");
  });
});

describe("repository ids", () => {
  it("refuses ids that are too long, have a dot segment, or come from another host", () => {
    const long = `acme/${"r".repeat(REPO_ID_MAX)}`;
    for (const id of [long, "acme/..", "../web", "acme/.", "gitlab:acme/../web", "gitlab:acme/./web", "bitbucket:../web"]) expect(isRepoId(id), id).toBe(false);
    for (const input of ["https://evil.example.com/acme/web", "https://github.com.evil.example/acme/web", "git@evil.example:acme/web.git"]) expect(repoFromInput(input), input).toBeNull();
  });

  it("accepts the ids and links of the hosts it knows, dots inside names included", () => {
    for (const id of [`acme/${"r".repeat(REPO_ID_MAX - 5)}`, "acme/.github", "acme/web.app", "gitlab:acme/platform/web", "bitbucket:acme-ws/api"]) expect(isRepoId(id), id).toBe(true);
    expect(repoFromInput("https://github.com/acme/web/pull/12")).toBe("acme/web");
    expect(repoFromInput("https://gitlab.com/acme/platform/web/-/merge_requests/3")).toBe("gitlab:acme/platform/web");
    expect(repoFromInput("https://code.acme.example/acme/web", "code.acme.example")).toBe("gitlab:acme/web");
  });
});
