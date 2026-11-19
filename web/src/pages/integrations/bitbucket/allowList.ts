/**
 * The Bitbucket allow list as typed on the pane: workspaces ("acme") or exact
 * repositories ("acme/web"), with or without "bitbucket:". Mirrors ALLOW_LIST
 * in src/routes/bitbucket.ts (the server validates again).
 */
import { parseList } from "../catalog";

const SEG = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]{1,100}`;
const ENTRY_RE = new RegExp(`^${SEG}(?:/${SEG})?$`);
const MAX_ALLOWED = 50;

/** "bitbucket:acme/web, acme" → ["acme/web", "acme"], deduplicated. */
export function parseBitbucketAllowList(text: string): string[] {
  return [...new Set(parseList(text).map((s) => s.replace(/^bitbucket:/i, "").replace(/^\/+|\/+$/g, "")).filter(Boolean))];
}

/** The first problem with an allow list, or undefined when every entry is a workspace or an exact repository. */
export function bitbucketAllowListError(entries: string[]): string | undefined {
  const bad = entries.find((x) => !ENTRY_RE.test(x));
  if (bad !== undefined) return `"${bad}" is not a workspace (your-workspace) or a repository (your-workspace/your-repo).`;
  if (entries.length > MAX_ALLOWED) return `Allow at most ${MAX_ALLOWED} workspaces or repositories.`;
  return undefined;
}

/** The exact repositories of an allow list: the ones a webhook can be added to from the page. */
export const exactRepos = (entries: string[]): string[] => entries.filter((x) => x.includes("/"));
