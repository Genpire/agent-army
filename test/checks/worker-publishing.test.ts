import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { HostViewer } from "../../src/integrations/code-hosts/code-host.js";
import { FALLBACK_COMMIT_EMAIL, checkoutRepo, publishBranch } from "../../src/tasks/worker.js";

/**
 * The worker's checks before git runs with the host's credentials, on both
 * sides: the clone and push URL must be plain https (no user, no password),
 * and the branch it pushes to must be a plain branch name.
 */

const TOKEN = "glpat-acme-placeholder-0123456789";

const hostWith = (url: string) => ({
  cloneUrl: vi.fn(() => url),
  defaultBranch: vi.fn(async () => "main"),
  viewer: vi.fn(async (): Promise<HostViewer> => ({ id: 42, login: "octo-dev" })),
  commitIdentity: vi.fn((name: string) => ({ name, email: FALLBACK_COMMIT_EMAIL })),
});

const checkout = (url: string, git = vi.fn(async (_args: string[]) => "")) =>
  checkoutRepo({ host: hostWith(url), repo: "gitlab:acme/web", dir: "/w/repo", workRoot: "/w", git, pointerName: "Pointer", redact: (t) => t });

const push = (branch: string, url = "https://gitlab.example.com/acme/web.git", git = vi.fn(async (_args: string[]) => "")) =>
  publishBranch({ host: hostWith(url), repo: "gitlab:acme/web", repoDir: "/w/repo", branch, git, tmp: tmpdir() });

describe("plain https clone and push URLs", () => {
  const unsafe = [
    `https://${TOKEN}@gitlab.example.com/acme/web.git`,
    `https://:${TOKEN}@gitlab.example.com/acme/web.git`,
    `https://oauth2:${TOKEN}@gitlab.example.com/acme/web.git`,
    "http://gitlab.example.com/acme/web.git",
    "git@gitlab.example.com:acme/web.git",
    "file:///w/other-repo",
    "not a url",
  ];

  it("refuses a URL with a user, a password or another scheme, before running git", async () => {
    for (const url of unsafe) {
      const git = vi.fn(async (_args: string[]) => "");
      await expect(checkout(url, git), url).rejects.toThrow("not plain https");
      expect(git, url).not.toHaveBeenCalled();
    }
    for (const url of unsafe) {
      const git = vi.fn(async (_args: string[]) => "");
      await expect(push("army/fix-login-a1b2c3", url, git), url).rejects.toThrow("not plain https");
      expect(git, url).not.toHaveBeenCalled();
    }
  });

  it("clones and pushes with a plain https URL", async () => {
    const url = "https://gitlab.example.com/acme/web.git";
    const cloneGit = vi.fn(async (_args: string[]) => "");
    await expect(checkout(url, cloneGit)).resolves.toMatchObject({ base: "main" });
    expect(cloneGit.mock.calls[0]![0]).toContain(url);

    const pushGit = vi.fn(async (_args: string[]) => "");
    await push("army/fix-login-a1b2c3", url, pushGit);
    expect(pushGit.mock.calls.map((c) => c[0]).find((args) => args.includes("push"))).toContain(url);
  });
});

describe("the branch the worker pushes to", () => {
  it("refuses names git could read as an option, a refspec or a special ref", async () => {
    for (const branch of ["", "-f", "--force", "a..b", "a//b", "x.lock", "feature/", "main:other", "+main", "a b", "a~1", "a^", "a?", "a*", "a[0]", "@{1}", "a\\b", "x".repeat(201)]) {
      const git = vi.fn(async (_args: string[]) => "");
      await expect(push(branch, undefined, git), branch).rejects.toThrow("Not pushing");
      expect(git, branch).not.toHaveBeenCalled();
    }
  });

  it("pushes the worker's own and other plain branch names to the same branch", async () => {
    for (const branch of ["army/fix-login-a1b2c3", "army/task-a1b2c3", "feature/v1.2_fix", "Fix-Login", "x".repeat(200)]) {
      const git = vi.fn(async (_args: string[]) => "");
      await push(branch, undefined, git);
      const pushed = git.mock.calls.map((c) => c[0]).find((args) => args.includes("push"));
      expect(pushed, branch).toContain(`refs/heads/${branch}:refs/heads/${branch}`);
    }
  });
});
