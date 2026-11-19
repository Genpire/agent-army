/**
 * The code host client a repo task works through: GitHub (the connection whose
 * allow list covers the repository), GitLab or Bitbucket, chosen by the
 * repository id's prefix (repo-id.ts). Everything after this is host agnostic
 * (the CodeHost interface): the worker, ci.ts and preview.ts.
 */
import { Bitbucket } from "./bitbucket.js";
import type { CodeHost } from "./code-host.js";
import { repoAccessError } from "./code-host-access.js";
import type { Config } from "./config.js";
import { GitHub } from "./github.js";
import { connectionForRepo, githubTokens } from "./github-access.js";
import { GitLab } from "./gitlab.js";
import { REPO_FORMAT_HINT, parseRepo } from "./repo-id.js";

export type CodeHostResult = { ok: true; host: CodeHost } | { ok: false; error: string };

/**
 * The client for `repo`, or why the platform may not work on it: not a
 * repository id, its host not connected, or not allowed by the host's allow
 * list (the same rule as every other entry point, code-host-access.ts).
 */
export function codeHostFor(config: Config, repo: string): CodeHostResult {
  const ref = parseRepo(repo);
  if (!ref) return { ok: false, error: `"${repo}" is not a repository. ${REPO_FORMAT_HINT}` };
  const denied = repoAccessError(config, repo);
  if (denied) return { ok: false, error: denied };
  switch (ref.host) {
    case "gitlab": {
      const token = config.gitlab.token;
      if (!token) return { ok: false, error: "GitLab is not connected. Ask the owner to connect it on the admin page." };
      return { ok: true, host: new GitLab({ token, baseUrl: config.gitlab.baseUrl }) };
    }
    case "bitbucket": {
      const token = config.bitbucket.token;
      if (!token) return { ok: false, error: "Bitbucket is not connected. Ask the owner to connect it on the admin page." };
      const email = config.bitbucket.email?.trim();
      return { ok: true, host: new Bitbucket({ token, ...(email ? { email } : {}) }) };
    }
    default: {
      // The most specific connection wins (github-access.ts), so the token matches the allow list that let it through.
      const token = connectionForRepo(config, repo)?.token;
      if (!token) return { ok: false, error: `No GitHub connection is allowed to work on ${repo}; add one on the admin page.` };
      return { ok: true, host: new GitHub(token) };
    }
  }
}

/**
 * Every form in which a code host credential could appear in output, from
 * each host's own client: every GitHub connection's token, header and Basic
 * value, and whatever the GitLab and Bitbucket clients send. For
 * makeRedactor; never throws (a client that cannot be built adds nothing, its
 * raw token is still in integrationSecrets).
 */
export function allHostSecrets(config: Config): string[] {
  const clients: (() => CodeHost)[] = [
    ...githubTokens(config).map((token) => () => new GitHub(token)),
    ...(config.gitlab.token ? [() => new GitLab({ token: config.gitlab.token!, baseUrl: config.gitlab.baseUrl })] : []),
    ...(config.bitbucket.token
      ? [() => new Bitbucket({ token: config.bitbucket.token!, ...(config.bitbucket.email?.trim() ? { email: config.bitbucket.email.trim() } : {}) })]
      : []),
  ];
  return clients.flatMap((make) => {
    try {
      return make().secrets().filter((s) => typeof s === "string" && s.length > 0);
    } catch {
      return [];
    }
  });
}
