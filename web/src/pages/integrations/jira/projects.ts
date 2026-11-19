/**
 * Jira projects on the admin page: the projects from /api/jira/projects as
 * Typeahead items, a project's statuses, the webhook's answer, and the
 * project-key checks (the server checks everything again).
 */
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import type { JiraProject, JiraStatus } from "../../../../../src/jira.js";
import { api } from "../../../lib/api";
import type { PublicConfig } from "../../../lib/types";
import { REPO_RE, allowListRepos } from "../../projects/validation";

export type { JiraProject, JiraStatus };
export type ProjectItem = SearchableItem<JiraProject>;
export type ProjectAutomation = PublicConfig["jira"]["automation"]["projects"][string];

/** GET /api/jira/statuses */
export interface StatusesResponse {
  project: { key: string; name: string };
  statuses: JiraStatus[];
}

/** POST /api/jira/automation/webhook */
export interface WebhookResponse {
  ok: boolean;
  /** The address Jira calls; it holds the secret. */
  url: string;
  secret: string;
  /** The webhook's filter: the automated projects. */
  jql: string;
  /** Registered in Jira (needs the Administer Jira permission). */
  registered: boolean;
  /** An earlier registration was still there and is kept. */
  kept?: boolean;
  error?: string;
  /** How to add the webhook in Jira by hand, when it could not be registered. */
  manualSteps?: string[];
}

export const projectItem = (p: JiraProject): ProjectItem => ({ id: p.key, label: p.name, auxiliaryData: p });
export const projectDescription = (p: JiraProject | undefined, key: string) => [`Key ${key}`, p?.type].filter(Boolean).join(" · ");

/** Projects whose key or name matches, most recently active first, from the server. */
export async function fetchProjects(query: string): Promise<JiraProject[]> {
  const { projects } = await api.get<{ projects: JiraProject[] }>(`/api/jira/projects${query ? `?search=${encodeURIComponent(query)}` : ""}`);
  return projects;
}

// Mirrors JIRA_KEY_RE in src/config.ts.
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,49}$/;

/** The first problem with a list of project keys (already upper-cased). */
export function projectKeysError(keys: string[]): string | undefined {
  const bad = keys.find((k) => !PROJECT_KEY_RE.test(k));
  if (bad !== undefined) return `"${bad}" is not a project key. Project keys look like ACME.`;
  if (keys.length > 200) return "Allow at most 200 projects.";
  return undefined;
}

/**
 * Searches projects for a picker: only `allowed` ones when that list is set,
 * and a typed key is offered as it is, so a project can be picked even when
 * Jira does not list it.
 */
export function projectSource(opts: {
  allowed: string[];
  exclude: string[];
  known: Map<string, JiraProject>;
  onError: (message: string | undefined) => void;
}): SearchSource<ProjectItem> {
  const { allowed, exclude, known, onError } = opts;
  const fits = (key: string) => (!allowed.length || allowed.includes(key)) && !exclude.includes(key);
  const load = async (query: string): Promise<ProjectItem[]> => {
    let projects: JiraProject[] = [];
    try {
      projects = await fetchProjects(query);
      projects.forEach((p) => known.set(p.key, p));
      onError(undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't load projects.");
    }
    const found = projects.filter((p) => fits(p.key));
    const typed = query.toUpperCase();
    const extra = [...(allowed.length && !query ? allowed : []), ...(PROJECT_KEY_RE.test(typed) ? [typed] : [])].filter((k) => fits(k) && !found.some((p) => p.key === k));
    const named = [...new Set(extra)].map((key) => known.get(key) ?? { id: "", key, name: key });
    return [...found, ...named].map(projectItem);
  };
  return { search: (q) => load(q.trim()), bootstrap: () => load("") };
}

/** Repositories the console already knows: channel bindings, repo setups, exact repos in the code hosts' allow lists, other automations. */
export function knownRepos(config: PublicConfig): string[] {
  const repos = [
    ...Object.values(config.bindings),
    ...Object.keys(config.repoSetup),
    ...allowListRepos(config),
    ...Object.values(config.monday.automation.boards).map((b) => b.repo),
    ...Object.values(config.jira.automation.projects).map((p) => p.repo),
  ].filter((r) => REPO_RE.test(r));
  return [...new Map(repos.map((r) => [r.toLowerCase(), r])).values()].sort((a, b) => a.localeCompare(b));
}
