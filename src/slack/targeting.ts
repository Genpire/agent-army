import { matchesAllowList } from "../github-access.js";
import { repoFromInput } from "../repo-id.js";

export type Command =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "bind"; repo: string }
  | { kind: "unbind" }
  | { kind: "listen" }
  | { kind: "unlisten" };

const cleanRepo = (s: string) => s.replace(/\.git$/, "").replace(/[.,:;]+$/, "");
const SLACK_LINK = /<(https?:\/\/[^|>]+)(\|[^>]*)?>/g;

/** Slack sends links as <https://url|label> and mentions as <@U123>. Commands ignore every mention. */
export function normalizeSlackText(text: string): string {
  return text
    .replace(/<@[UW][A-Z0-9]+(\|[^>]*)?>/g, " ")
    .replace(SLACK_LINK, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The text Pointer reads: its own mention removed, links unwrapped, other
 * people's mentions kept as <@U123> so Pointer can mention them back.
 */
export function messageText(text: string, botUserId?: string): string {
  const own = botUserId && /^[UW][A-Z0-9]+$/.test(botUserId) ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g") : null;
  return (own ? text.replace(own, " ") : text)
    .replace(SLACK_LINK, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * The few things Pointer does without thinking. Everything else, including
 * "in owner/repo: …" requests, goes to the brain, which understands them.
 * `gitlabBaseUrl` (config.gitlab.baseUrl) lets `bind` take a self-managed GitLab's URLs.
 */
export function parseCommand(rawText: string, gitlabBaseUrl?: string): Command | null {
  const text = normalizeSlackText(rawText).replace(/[.!]+$/, "");
  if (/^(help|\?)$/i.test(text)) return { kind: "help" };
  if (/^status$/i.test(text)) return { kind: "status" };
  if (/^unbind$/i.test(text)) return { kind: "unbind" };
  if (/^listen( here)?$/i.test(text)) return { kind: "listen" };
  if (/^(stop listening|unlisten)$/i.test(text)) return { kind: "unlisten" };
  const bind = text.match(/^bind\s+(\S+)$/i);
  const repo = bind ? repoFromToken(bind[1]!, gitlabBaseUrl) : null;
  return repo ? { kind: "bind", repo } : null;
}

/**
 * A repository id from what someone typed: an id ("owner/repo",
 * "gitlab:group/project", "bitbucket:workspace/repo"), "owner/repo.git", or a
 * web or clone URL on GitHub, Bitbucket, gitlab.com or the GitLab instance at
 * `gitlabBaseUrl`. Null when it is none of these.
 */
export function repoFromToken(token: string, gitlabBaseUrl?: string): string | null {
  const text = cleanRepo(token.trim());
  const gitlab = gitlabAddress(gitlabBaseUrl);
  // A GitLab served on a port or under a path (https://host:8443/gitlab): what follows it is the project.
  const prefix = gitlab?.prefix;
  const local = gitlab && prefix && text.toLowerCase().startsWith(prefix) ? `https://${gitlab.host}/${text.slice(prefix.length)}` : text;
  return repoFromInput(local, gitlab?.host);
}

/** The host name of a GitLab address, and its URL prefix when it has a port or a path. */
function gitlabAddress(baseUrl: string | undefined): { host: string; prefix?: string } | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    return { host: url.hostname.toLowerCase(), ...(base !== `https://${url.hostname}`.toLowerCase() ? { prefix: `${base}/` } : {}) };
  } catch {
    return undefined;
  }
}

/** Project precedence: named explicitly > this thread's repo > the channel's default. */
export function resolveRepo(opts: {
  override?: string;
  threadRepo?: string;
  channelRepo?: string;
}): string | undefined {
  return opts.override ?? opts.threadRepo ?? opts.channelRepo;
}

/** Owner entries ("your-org") or exact repo entries ("owner/repo"); empty allows all. */
export function isRepoAllowed(repo: string, allowedOwners: string[]): boolean {
  return matchesAllowList(repo, allowedOwners);
}

export function helpText(name: string): string {
  return [
    `*${name}*: just talk to me. I answer questions, look things up on the web, read GitHub (and GitLab or Bitbucket when connected), remember what you ask me to, and put the team on code changes.`,
    "• I answer every message in DMs and in channels where I'm listening, and I follow threads I'm in. Elsewhere, mention me.",
    "• Code changes go to the team: they work on a branch and open a pull request (a merge request on GitLab) for a human to review and merge.",
    "• `bind owner/repo` sets this channel's default project; on GitLab or Bitbucket, `bind gitlab:group/project` or `bind bitbucket:workspace/repo` (a repository link works too) · `unbind` · `status`",
    "• `listen here` makes me answer every message in this channel · `stop listening` undoes it",
  ].join("\n");
}
