import type { PublicConfig } from "../../lib/types";

/**
 * Client-side checks for the Projects page. They mirror REPO_RE and
 * REPO_FORMAT_HINT in src/repo-id.ts, and CHANNEL_RE, ENV_KEY_RE,
 * RESERVED_ENV_KEYS and the repo setup limits in src/config.ts and
 * src/server.ts (the browser bundle takes nothing from the server's modules).
 * The server validates everything again; these only give a faster, clearer error.
 */

/** One path segment: letters, digits, "_", "." and "-", never "." or "..". */
const SEG = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]+`;
/** A repository on any code host: owner/repo (GitHub), gitlab:group/project (nested groups allowed) or bitbucket:workspace/repo. */
export const REPO_RE = new RegExp(`^${SEG}/${SEG}$|^gitlab:${SEG}(?:/${SEG}){1,20}$|^bitbucket:${SEG}/${SEG}$`);
/** A GitHub repository, owner/repo. */
export const GITHUB_REPO_RE = new RegExp(`^${SEG}/${SEG}$`);
export const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "CI",
  "ANTHROPIC_API_KEY",
  "MASTER_KEY",
  "SETUP_TOKEN",
  "TASK_B64",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "PLAYWRIGHT_BROWSERS_PATH",
]);
export const REPO_SETUP_MAX_ENV = 100;
export const ENV_VALUE_MAX = 10_000;
export const SETUP_COMMAND_MAX = 2000;
export const START_COMMAND_MAX = 500;
export const APP_URL_MAX = 300;
const APP_URL_RE = /^https?:\/\/\S+$/;
const CHANNEL_LINK_RE = /\/archives\/([A-Z0-9]+)/;

export const REPO_ERROR = "Repositories look like owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo.";
/** Where a repository input says what to type. */
export const REPO_PLACEHOLDER = "owner/repo or gitlab:group/project";
export const CHANNEL_ERROR = "Channel IDs look like C012ABCDEF.";

/** The saved key for a repo, matched without case (repository names are case-insensitive on the code hosts). */
export function findRepo(repos: Iterable<string>, repo: string): string | undefined {
  const wanted = repo.trim().toLowerCase();
  for (const r of repos) if (r.toLowerCase() === wanted) return r;
  return undefined;
}

/**
 * The exact repositories in the code hosts' allow lists, as repository ids:
 * GitHub's owner/repo entries, Bitbucket's workspace/repo entries, and GitLab's
 * entries below a group (group/project; a subgroup entry looks the same and is
 * offered too). Owner, workspace and top-level group entries are not repositories.
 */
export function allowListRepos(config: PublicConfig): string[] {
  const github = [...config.github.allowedOwners, ...config.github.extra.flatMap((x) => x.allowed)].filter((x) => GITHUB_REPO_RE.test(x));
  const gitlab = config.gitlab.allowed.filter((x) => x.includes("/")).map((x) => `gitlab:${x}`);
  const bitbucket = config.bitbucket.allowed.map((x) => `bitbucket:${x}`);
  return [...github, ...gitlab, ...bitbucket].filter((x) => REPO_RE.test(x));
}

/**
 * A channel ID from what was typed or pasted: the ID itself, or a channel link
 * (`https://acme.slack.com/archives/C012ABCDEF`). Returns undefined when neither.
 */
export function parseChannelId(input: string): string | undefined {
  const text = input.trim();
  const fromLink = text.match(CHANNEL_LINK_RE)?.[1];
  const id = fromLink ?? text;
  return CHANNEL_RE.test(id) ? id : undefined;
}

/** Undefined when the URL is empty or valid, else the message to show. */
export function appUrlError(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  if (u.length > APP_URL_MAX) return `The app URL is limited to ${APP_URL_MAX} characters.`;
  return APP_URL_RE.test(u) ? undefined : "The app URL must start with http:// or https://.";
}

export interface ParsedEnv {
  env: Record<string, string>;
  /** One message per bad line. They name the line and the variable, never the value. */
  errors: string[];
}

/**
 * `NAME=value` lines into variables. Blank lines and `#` comments are skipped;
 * a leading `export ` and quotes around a value are dropped, as in a .env file.
 */
export function parseEnvLines(text: string): ParsedEnv {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = `Line ${i + 1}`;
    const eq = line.indexOf("=");
    if (eq < 0) {
      errors.push(`${at}: write NAME=value.`);
      return;
    }
    const name = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!ENV_KEY_RE.test(name)) {
      const shown = name.length > 40 ? `${name.slice(0, 40)}…` : name;
      errors.push(`${at}: “${shown}” is not a variable name (letters, digits and _, not starting with a digit).`);
      return;
    }
    if (RESERVED_ENV_KEYS.has(name)) {
      errors.push(`${at}: ${name} is set by the platform and cannot be changed here.`);
      return;
    }
    if (name in env) {
      errors.push(`${at}: ${name} is listed twice.`);
      return;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (!value) {
      errors.push(`${at}: ${name} has no value. To remove a saved variable, use its Remove button.`);
      return;
    }
    if (value.length > ENV_VALUE_MAX) {
      errors.push(`${at}: the value of ${name} is longer than ${ENV_VALUE_MAX.toLocaleString()} characters.`);
      return;
    }
    env[name] = value;
  });
  return { env, errors };
}

/** The first few errors as one message. */
export function joinErrors(errors: string[], max = 3): string {
  const shown = errors.slice(0, max).join(" ");
  return errors.length > max ? `${shown} (and ${errors.length - max} more)` : shown;
}
