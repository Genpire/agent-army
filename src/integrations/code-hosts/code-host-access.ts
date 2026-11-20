/**
 * Which code host serves a repository and whether the platform may work on it,
 * across GitHub (github-access.ts, several connections), GitLab and Bitbucket
 * (one connection each, with an allow list of groups/workspaces or exact
 * repositories). The one rule every entry point uses: repo tasks, review
 * follow-ups, channel bindings, ticket automations, Pointer's tools.
 */
import type { Config } from "../../core/config.js";
import { connectionForRepo, describeAllowed as describeGitHubAllowed, hasGitHub } from "../github/github-access.js";
import { type CodeHostKind, HOST_TERMS, repoHost, repoPath } from "./repo-id.js";

/**
 * True when `path` is covered by an allow list of path prefixes: an entry is a
 * group, workspace or owner ("acme", "acme/platform") covering everything under
 * it, or an exact repository path. Case-insensitive. Empty allows all.
 */
export function matchesPathAllowList(path: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const p = path.toLowerCase();
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
    return Boolean(e) && (p === e || p.startsWith(`${e}/`));
  });
}

/** Whether the host of `kind` is connected at all. */
export function isHostConnected(c: Config, kind: CodeHostKind): boolean {
  switch (kind) {
    case "gitlab":
      return Boolean(c.gitlab.token);
    case "bitbucket":
      return Boolean(c.bitbucket.token);
    default:
      return hasGitHub(c);
  }
}

/** The connected code hosts, in a stable order. */
export function connectedHosts(c: Config): CodeHostKind[] {
  return (["github", "gitlab", "bitbucket"] as const).filter((k) => isHostConnected(c, k));
}

/** True when a connection of the repository's host may work on it. */
export function isRepoAllowedOnHost(c: Config, repo: string): boolean {
  const kind = repoHost(repo);
  switch (kind) {
    case "gitlab":
      return Boolean(c.gitlab.token) && matchesPathAllowList(repoPath(repo), c.gitlab.allowed);
    case "bitbucket":
      return Boolean(c.bitbucket.token) && matchesPathAllowList(repoPath(repo), c.bitbucket.allowed);
    default:
      return connectionForRepo(c, repo) !== undefined;
  }
}

/** For messages: what the platform may work on on the repository's host. */
export function describeAllowedOnHost(c: Config, kind: CodeHostKind): string {
  const name = HOST_TERMS[kind].name;
  const list = (allowed: string[]) => (allowed.length === 0 ? `any repository the ${name} token can reach` : allowed.join(", "));
  switch (kind) {
    case "gitlab":
      return c.gitlab.token ? list(c.gitlab.allowed) : `no ${name} connection`;
    case "bitbucket":
      return c.bitbucket.token ? list(c.bitbucket.allowed) : `no ${name} connection`;
    default:
      return describeGitHubAllowed(c);
  }
}

/**
 * Why the platform may not work on `repo`, or undefined when it may: its host
 * is not connected, or the host's allow list does not cover it. Written for
 * Pointer and the person.
 */
export function repoAccessError(c: Config, repo: string): string | undefined {
  const kind = repoHost(repo);
  const name = HOST_TERMS[kind].name;
  if (!isHostConnected(c, kind)) return `${name} is not connected. Ask the owner to connect it on the admin page.`;
  if (!isRepoAllowedOnHost(c, repo)) {
    return `Not allowed to work on ${repo}. Allowed on ${name}: ${describeAllowedOnHost(c, kind)}.`;
  }
  return undefined;
}
