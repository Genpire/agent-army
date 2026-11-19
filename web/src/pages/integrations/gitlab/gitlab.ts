/**
 * The GitLab pane's input checks (the server validates again, see
 * src/routes/gitlab.ts), the instance's token page, and the API's answers.
 */
import type { GitlabConnectResponse, GitlabHookResult, GitlabWebhookInfo, GitlabWebhookResponse } from "../../../../../src/routes/gitlab.js";

export type { GitlabConnectResponse, GitlabHookResult, GitlabWebhookInfo, GitlabWebhookResponse };

export const GITLAB_DEFAULT_URL = "https://gitlab.com";

// Mirrors BASE_URL_RE in src/routes/gitlab.ts.
const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;
// Mirrors PATH_RE in src/routes/gitlab.ts.
const PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,20}$/;

/** "https://gitlab.example.com/" → "https://gitlab.example.com". */
export const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** The problem with an instance's address, or undefined. */
export function baseUrlError(url: string): string | undefined {
  if (!url) return "Enter the GitLab address, like https://gitlab.com.";
  if (!BASE_URL_RE.test(url)) return "The GitLab address starts with https://, like https://gitlab.com or https://gitlab.example.com.";
  return undefined;
}

/** An allow-list entry as the server stores it: "gitlab:acme/web", "/acme/web/" and "acme/web.git" are acme/web. */
export const normalizeEntry = (entry: string): string =>
  entry
    .trim()
    .replace(/^gitlab:/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");

/** The first problem with a list of groups and projects, or undefined. */
export function gitlabAllowListError(entries: string[]): string | undefined {
  const bad = entries.find((e) => !PATH_RE.test(e) || e.split("/").some((s) => s === "." || s === ".."));
  if (bad !== undefined) return `"${bad}" is not a group (acme, acme/platform) or a project (acme/web).`;
  if (entries.length > 200) return "Allow at most 200 groups or projects.";
  return undefined;
}

/** The instance's page for a new personal access token, with its name and scopes filled in. */
export const tokenPageUrl = (baseUrl: string): string =>
  `${normalizeBaseUrl(baseUrl)}/-/user_settings/personal_access_tokens?name=Agent+Army&scopes=api,write_repository`;
