/**
 * Repository ids across code hosts. A repository is stored and shown as one
 * string everywhere (tasks, threads, bindings, notes, budgets, repo setup):
 *
 *   owner/repo                     GitHub (no prefix, as before)
 *   gitlab:group/project           GitLab, nested groups allowed (gitlab:group/sub/project)
 *   bitbucket:workspace/repo       Bitbucket Cloud
 *
 * Each code host's client takes the id as stored and strips its own prefix.
 */

export const CODE_HOST_KINDS = ["github", "gitlab", "bitbucket"] as const;
export type CodeHostKind = (typeof CODE_HOST_KINDS)[number];

/** One path segment: letters, digits, "_", "." and "-", never "." or "..". */
const SEG = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]+`;

/** owner/repo; "." and ".." are rejected as either part so a repo can never traverse API paths. */
export const GITHUB_REPO_RE = new RegExp(`^${SEG}/${SEG}$`);
/** gitlab:group/project, with up to 20 levels of groups. */
export const GITLAB_REPO_RE = new RegExp(`^gitlab:${SEG}(?:/${SEG}){1,20}$`);
/** bitbucket:workspace/repo. */
export const BITBUCKET_REPO_RE = new RegExp(`^bitbucket:${SEG}/${SEG}$`);
/** Any repository id the platform can work on. */
export const REPO_RE = new RegExp(`${GITHUB_REPO_RE.source}|${GITLAB_REPO_RE.source}|${BITBUCKET_REPO_RE.source}`);

/** For validation messages. */
export const REPO_FORMAT_HINT = "Repositories look like owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo.";

export const REPO_ID_MAX = 300;

export interface RepoRef {
  host: CodeHostKind;
  /** The id as stored, e.g. "gitlab:acme/web". */
  id: string;
  /** The id without the host prefix, e.g. "acme/web". */
  path: string;
}

const PREFIX: Record<CodeHostKind, string> = { github: "", gitlab: "gitlab:", bitbucket: "bitbucket:" };

/** The host of a stored id; ids without a known prefix are GitHub's. */
export function repoHost(id: string): CodeHostKind {
  if (id.startsWith(PREFIX.gitlab)) return "gitlab";
  if (id.startsWith(PREFIX.bitbucket)) return "bitbucket";
  return "github";
}

/** The id without its host prefix. */
export function repoPath(id: string): string {
  return id.slice(PREFIX[repoHost(id)].length);
}

/** A stored id from a host and a path: repoId("gitlab", "acme/web") → "gitlab:acme/web". */
export function repoId(host: CodeHostKind, path: string): string {
  return `${PREFIX[host]}${path.replace(/^\/+|\/+$/g, "")}`;
}

/** The parts of a valid id, or null when it is not one. */
export function parseRepo(id: string): RepoRef | null {
  if (id.length > REPO_ID_MAX || !REPO_RE.test(id)) return null;
  return { host: repoHost(id), id, path: repoPath(id) };
}

export const isRepoId = (id: string): boolean => parseRepo(id) !== null;

/** What hosts call a change request, for messages. */
export const HOST_TERMS: Record<CodeHostKind, { name: string; pr: string; prShort: string }> = {
  github: { name: "GitHub", pr: "pull request", prShort: "PR" },
  gitlab: { name: "GitLab", pr: "merge request", prShort: "MR" },
  bitbucket: { name: "Bitbucket", pr: "pull request", prShort: "PR" },
};

/** The repository's web page. GitLab's base URL is the configured one (self-managed instances). */
export function repoWebUrl(id: string, gitlabBaseUrl = "https://gitlab.com"): string {
  const path = repoPath(id);
  switch (repoHost(id)) {
    case "gitlab":
      return `${gitlabBaseUrl.replace(/\/+$/, "")}/${path}`;
    case "bitbucket":
      return `https://bitbucket.org/${path}`;
    default:
      return `https://github.com/${path}`;
  }
}

/**
 * A repository from what someone typed: an id, "owner/repo.git", or a web or
 * clone URL on github.com, gitlab.com (or `gitlabHost`, a self-managed
 * instance's host name) or bitbucket.org. Null when it is none of these.
 */
export function repoFromInput(input: string, gitlabHost?: string): string | null {
  const text = input.trim().replace(/[.,;]+$/, "");
  const url = text.match(/^(?:https?:\/\/|git@)([^/:\s]+)[/:]([^\s?#]+)/i);
  let candidate = text;
  if (url) {
    const host = url[1]!.toLowerCase().replace(/^www\./, "");
    // Everything up to GitLab's "/-/" (tree, merge_requests…) or GitHub/Bitbucket's 3rd segment is the repository.
    const rawPath = url[2]!.replace(/\.git$/, "").replace(/\/+$/, "");
    if (host === "github.com") candidate = rawPath.split("/").slice(0, 2).join("/");
    else if (host === "bitbucket.org") candidate = repoId("bitbucket", rawPath.split("/").slice(0, 2).join("/"));
    else if (host === "gitlab.com" || (gitlabHost && host === gitlabHost.toLowerCase())) candidate = repoId("gitlab", rawPath.split("/-/")[0]!);
    else return null;
  }
  candidate = candidate.replace(/\.git$/, "");
  return parseRepo(candidate)?.id ?? null;
}
