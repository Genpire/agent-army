import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/core/config.js";
import { connectionForRepo, describeAllowed, githubTokens, hasGitHub, matchesAllowList } from "../src/github-access.js";
import { isRepoAllowed } from "../src/slack/targeting.js";

const T1 = "github_pat_primary_000000000000";
const T2 = "ghp_secondtoken0000000000000000";

const config = (github: object) => ConfigSchema.parse({ github });

describe("github access", () => {
  it("allow lists accept owners and exact repos", () => {
    expect(matchesAllowList("Acme/web", ["acme"])).toBe(true);
    expect(matchesAllowList("Partner-Co/Acme", ["Acme", "partner-co/acme"])).toBe(true);
    expect(matchesAllowList("Partner-Co/other", ["Acme", "Partner-Co/Acme"])).toBe(false);
    expect(matchesAllowList("anyone/thing", [])).toBe(true);
    expect(isRepoAllowed("Partner-Co/Acme", ["Partner-Co/Acme"])).toBe(true);
  });

  it("picks the most specific connection for a repo", () => {
    const c = config({
      token: T1,
      login: "octo-dev",
      allowedOwners: ["Acme"],
      extra: [{ id: "gh-abc123", token: T2, login: "octo-dev", allowed: ["Partner-Co/Acme"] }],
    });
    expect(connectionForRepo(c, "Acme/acme-platform")?.id).toBe("primary");
    expect(connectionForRepo(c, "partner-co/acme")?.token).toBe(T2);
    expect(connectionForRepo(c, "Partner-Co/secret")).toBeUndefined();
    expect(hasGitHub(c)).toBe(true);
    expect(githubTokens(c)).toEqual([T1, T2]);
    expect(describeAllowed(c)).toBe("Acme, Partner-Co/Acme");
  });

  it("an exact repo beats a catch-all connection", () => {
    const c = config({ token: T1, allowedOwners: [], extra: [{ id: "gh-abc123", token: T2, allowed: ["acme/app"] }] });
    expect(connectionForRepo(c, "acme/app")?.id).toBe("gh-abc123");
    expect(connectionForRepo(c, "acme/other")?.id).toBe("primary");
  });

  it("existing configs without extra connections still parse", () => {
    const c = config({ token: T1, allowedOwners: ["Acme"] });
    expect(c.github.extra).toEqual([]);
    expect(connectionForRepo(c, "Acme/x")?.id).toBe("primary");
  });
});
