import type { Config } from "../../core/config.js";

/**
 * Pointer can hold several GitHub connections: the primary one (config.github)
 * plus extra ones (config.github.extra), e.g. a second token for a repo owned
 * by another personal account. Each has its own allow list of owners
 * ("your-org") or exact repositories ("someone/some-repo").
 */
export interface GitHubConnection {
  id: string;
  token: string;
  login?: string;
  /** "owner" or "owner/repo" entries; empty = any repository the token can reach. */
  allowed: string[];
}

export const PRIMARY_CONNECTION_ID = "primary";

/** True when `repo` is covered by the allow list: an exact owner/repo entry or its owner. Empty list allows all. */
export function matchesAllowList(repo: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return matchStrength(repo, allowed) > 0;
}

/** 2 = exact repo entry, 1 = owner entry, 0 = no match. */
function matchStrength(repo: string, allowed: string[]): number {
  const r = repo.toLowerCase();
  const owner = r.split("/")[0]!;
  let best = 0;
  for (const entry of allowed) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e.includes("/") ? e === r : e === owner) best = Math.max(best, e.includes("/") ? 2 : 1);
  }
  return best;
}

export function githubConnections(c: Config): GitHubConnection[] {
  const out: GitHubConnection[] = [];
  if (c.github.token) {
    out.push({ id: PRIMARY_CONNECTION_ID, token: c.github.token, login: c.github.login, allowed: c.github.allowedOwners });
  }
  for (const x of c.github.extra) out.push({ id: x.id, token: x.token, login: x.login, allowed: x.allowed });
  return out;
}

export const hasGitHub = (c: Config): boolean => githubConnections(c).length > 0;

/**
 * The connection that serves `repo`: the most specific match wins (exact repo,
 * then owner, then a connection with an empty allow list). Undefined when no
 * connection is allowed to touch the repository.
 */
export function connectionForRepo(c: Config, repo: string): GitHubConnection | undefined {
  let best: { conn: GitHubConnection; score: number } | undefined;
  for (const conn of githubConnections(c)) {
    const score = conn.allowed.length === 0 ? 0.5 : matchStrength(repo, conn.allowed);
    if (score > 0 && (!best || score > best.score)) best = { conn, score };
  }
  return best?.conn;
}

export const isRepoAllowedAnywhere = (c: Config, repo: string): boolean => connectionForRepo(c, repo) !== undefined;

/** For error messages: what Pointer may work on, across all connections. */
export function describeAllowed(c: Config): string {
  const conns = githubConnections(c);
  if (conns.length === 0) return "no GitHub connection";
  if (conns.some((x) => x.allowed.length === 0)) return "any repository the GitHub tokens can reach";
  return [...new Set(conns.flatMap((x) => x.allowed))].join(", ");
}

/** Every GitHub token, for redaction. */
export const githubTokens = (c: Config): string[] => githubConnections(c).map((x) => x.token);
