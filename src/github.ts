export type ItemState = "open" | "closed" | "all";

export interface RepoInfo {
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string;
  url: string;
}

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface PullInfo {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  url: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  comments: number;
  url: string;
  updatedAt: string;
}

export interface FileContent {
  text: string;
  truncated: boolean;
}

export interface CodeHit {
  repo: string;
  path: string;
  url: string;
}

export const FILE_MAX_CHARS = 20_000;
const MAX_ITEMS = 20;

const clampLimit = (limit: number | undefined, fallback = 10) =>
  Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_ITEMS);

/** Each path segment encoded on its own, so "/" stays a separator. "." and ".." are refused: fetch would resolve them and escape the repo. */
export const encodePath = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || /%2e/i.test(s))) throw new Error(`Invalid path: ${path}`);
  return segments.map(encodeURIComponent).join("/");
};

/** Minimal GitHub REST client: what the worker needs, plus read-only lookups for Pointer's chat tools. */
export class GitHub {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-army",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${path} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** The account that owns this token (GET /user): its numeric id and login. */
  async viewer(): Promise<{ id: number; login: string }> {
    const data = await this.call<{ id: number; login: string }>("GET", "/user");
    return { id: data.id, login: data.login };
  }

  async defaultBranch(repo: string): Promise<string> {
    const data = await this.call<{ default_branch: string }>("GET", `/repos/${repo}`);
    return data.default_branch;
  }

  async findOpenPr(repo: string, branch: string): Promise<{ number: number; html_url: string } | null> {
    const owner = repo.split("/")[0]!;
    const prs = await this.call<{ number: number; html_url: string }[]>(
      "GET",
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return prs[0] ?? null;
  }

  async createPr(repo: string, opts: { title: string; body: string; head: string; base: string }) {
    return this.call<{ number: number; html_url: string }>("POST", `/repos/${repo}/pulls`, opts);
  }

  async commentOnPr(repo: string, number: number, body: string): Promise<void> {
    await this.call("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  // ---------- Read-only lookups (Pointer's chat tools) ----------

  /** Repos the token can reach, most recently updated first; optionally only one owner's. */
  async listRepos(owner?: string): Promise<RepoInfo[]> {
    // Ask for a full page when filtering, so an owner's repos aren't crowded out by others.
    const perPage = owner ? 100 : 30;
    const data = await this.call<
      {
        full_name: string;
        private: boolean;
        description: string | null;
        default_branch: string;
        updated_at: string;
        html_url: string;
      }[]
    >("GET", `/user/repos?sort=updated&per_page=${perPage}&affiliation=owner,collaborator,organization_member`);
    const wanted = owner?.toLowerCase();
    return data
      .filter((r) => !wanted || r.full_name.split("/")[0]!.toLowerCase() === wanted)
      .slice(0, 30)
      .map((r) => ({
        fullName: r.full_name,
        private: r.private,
        description: r.description,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
        url: r.html_url,
      }));
  }

  async recentCommits(repo: string, opts: { branch?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ per_page: String(clampLimit(opts.limit)) });
    if (opts.branch) params.set("sha", opts.branch);
    const data = await this.call<
      { sha: string; commit: { author?: { name?: string; date?: string } | null; message: string }; author?: { login?: string } | null }[]
    >("GET", `/repos/${repo}/commits?${params}`);
    return data.map((c) => ({
      sha: c.sha,
      author: c.commit.author?.name ?? c.author?.login ?? "unknown",
      date: c.commit.author?.date ?? "",
      message: c.commit.message,
    }));
  }

  async listPulls(repo: string, opts: { state?: ItemState; limit?: number } = {}): Promise<PullInfo[]> {
    const params = new URLSearchParams({
      state: opts.state ?? "open",
      sort: "updated",
      direction: "desc",
      per_page: String(clampLimit(opts.limit)),
    });
    const data = await this.call<
      {
        number: number;
        title: string;
        state: string;
        draft?: boolean;
        user?: { login?: string } | null;
        head: { ref: string };
        base: { ref: string };
        html_url: string;
        updated_at: string;
        merged_at: string | null;
      }[]
    >("GET", `/repos/${repo}/pulls?${params}`);
    return data.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      draft: Boolean(p.draft),
      author: p.user?.login ?? "unknown",
      head: p.head.ref,
      base: p.base.ref,
      url: p.html_url,
      updatedAt: p.updated_at,
      mergedAt: p.merged_at,
    }));
  }

  /** Issues only: the issues API also returns pull requests, which are dropped here. */
  async listIssues(repo: string, opts: { state?: ItemState; limit?: number } = {}): Promise<IssueInfo[]> {
    const limit = clampLimit(opts.limit);
    // Over-fetch because pull requests are filtered out afterwards.
    const params = new URLSearchParams({ state: opts.state ?? "open", sort: "updated", direction: "desc", per_page: "50" });
    const data = await this.call<
      {
        number: number;
        title: string;
        state: string;
        user?: { login?: string } | null;
        labels: (string | { name?: string })[];
        comments: number;
        html_url: string;
        updated_at: string;
        pull_request?: unknown;
      }[]
    >("GET", `/repos/${repo}/issues?${params}`);
    return data
      .filter((i) => !i.pull_request)
      .slice(0, limit)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login ?? "unknown",
        labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        comments: i.comments,
        url: i.html_url,
        updatedAt: i.updated_at,
      }));
  }

  /** A file's text (capped at FILE_MAX_CHARS) or, for a directory, its listing. */
  async readFile(repo: string, path: string, ref?: string): Promise<FileContent> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    type Entry = { name: string; path: string; type: string; size?: number };
    const data = await this.call<
      Entry[] | (Entry & { encoding?: string; content?: string; target?: string; submodule_git_url?: string })
    >("GET", `/repos/${repo}/contents/${encodePath(path)}${query}`);

    if (Array.isArray(data)) {
      const lines = data.map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path}${e.size !== undefined ? ` (${e.size} bytes)` : ""}`));
      return cap(lines.join("\n") || "(empty directory)");
    }
    if (data.type === "symlink") return { text: `(symlink to ${data.target ?? "unknown"})`, truncated: false };
    if (data.type === "submodule") return { text: `(git submodule: ${data.submodule_git_url ?? "unknown"})`, truncated: false };
    if (data.encoding !== "base64" || data.content === undefined) {
      // The contents API leaves `content` empty for files over 1 MB.
      return { text: `(file too large to read through the API: ${data.size ?? "?"} bytes)`, truncated: true };
    }
    const text = Buffer.from(data.content, "base64").toString("utf8");
    if (text.includes("\u0000")) return { text: `(binary file, ${data.size ?? text.length} bytes)`, truncated: false };
    return cap(text);
  }

  /** Code search; with `repo`, only inside that repository. At most 20 hits. */
  async searchCode(query: string, repo?: string): Promise<CodeHit[]> {
    const q = repo ? `${query} repo:${repo}` : query;
    const data = await this.call<{ items: { path: string; html_url: string; repository: { full_name: string } }[] }>(
      "GET",
      `/search/code?q=${encodeURIComponent(q)}&per_page=${MAX_ITEMS}`,
    );
    return data.items.slice(0, MAX_ITEMS).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url }));
  }

  /** Header git uses for clone/fetch/push, so the token never lands in .git/config. */
  gitAuthHeader(): string {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return `Authorization: Basic ${basic}`;
  }
}

function cap(text: string): FileContent {
  return text.length > FILE_MAX_CHARS ? { text: text.slice(0, FILE_MAX_CHARS), truncated: true } : { text, truncated: false };
}
