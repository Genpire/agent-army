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

/** A pull request as the worker needs it. */
export interface PrRef {
  number: number;
  html_url: string;
  /** GraphQL id, for marking a draft ready for review. */
  node_id: string;
  draft: boolean;
}

export interface PullDetail {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  nodeId: string;
  headRef: string;
  headSha: string;
  url: string;
}

/** A check run on a commit (GitHub Actions jobs, apps such as Vercel). */
export interface CheckInfo {
  id: number;
  name: string;
  /** queued, in_progress, completed (also waiting, requested, pending). */
  status: string;
  /** When completed: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale. */
  conclusion: string | null;
  detailsUrl: string | null;
  title: string | null;
  summary: string | null;
  text: string | null;
  /** Slug of the app that created it, e.g. "github-actions" or "vercel". */
  app: string | null;
}

/** A commit status (the older API some services use, e.g. Vercel deployments). */
export interface StatusInfo {
  context: string;
  state: "error" | "failure" | "pending" | "success";
  description: string | null;
  targetUrl: string | null;
}

export interface Annotation {
  path: string;
  startLine: number;
  level: string;
  title: string | null;
  message: string;
}

/** One piece of feedback on a pull request: a review, an inline review comment, or a conversation comment. */
export interface PrFeedback {
  kind: "review" | "inline" | "comment";
  id: number;
  author: string;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE… */
  association: string;
  bot: boolean;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state?: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
  url: string;
}

/** Appended to everything the platform posts on GitHub, so its own comments never count as feedback. */
export const BOT_MARKER = "<!-- agent-army -->";

/** Who may steer the team from a pull request: people with write access to the repository. */
export const WRITE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Feedback a human with write access gave, after `since` (ISO) when set.
 * Approvals without a comment and pending (unsubmitted) reviews are not feedback.
 */
export function isHumanFeedback(f: PrFeedback, since?: string): boolean {
  if (f.bot || !WRITE_ASSOCIATIONS.has(f.association) || f.body.includes(BOT_MARKER)) return false;
  if (since && f.createdAt <= since) return false;
  if (f.kind === "review" && (f.state === "PENDING" || f.state === "DISMISSED")) return false;
  if (f.kind === "review" && !f.body.trim() && f.state !== "CHANGES_REQUESTED") return false;
  return true;
}

export const FILE_MAX_CHARS = 20_000;
/** Tail of a CI job log kept for the team. */
export const LOG_MAX_CHARS = 20_000;
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

  async findOpenPr(repo: string, branch: string): Promise<PrRef | null> {
    const owner = repo.split("/")[0]!;
    const prs = await this.call<{ number: number; html_url: string; node_id: string; draft?: boolean }[]>(
      "GET",
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    const pr = prs[0];
    return pr ? { number: pr.number, html_url: pr.html_url, node_id: pr.node_id, draft: Boolean(pr.draft) } : null;
  }

  /** Opens a pull request; `draft` opens it as a draft (unfinished work). */
  async createPr(repo: string, opts: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PrRef> {
    const pr = await this.call<{ number: number; html_url: string; node_id: string; draft?: boolean }>(
      "POST",
      `/repos/${repo}/pulls`,
      opts,
    );
    return { number: pr.number, html_url: pr.html_url, node_id: pr.node_id, draft: Boolean(pr.draft) };
  }

  /** Comments on the pull request's conversation. The platform's marker is appended so the comment is never read back as feedback. */
  async commentOnPr(repo: string, number: number, body: string): Promise<void> {
    await this.call("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${body}\n\n${BOT_MARKER}` });
  }

  async getPull(repo: string, number: number): Promise<PullDetail> {
    const p = await this.call<{
      number: number;
      state: string;
      draft?: boolean;
      merged?: boolean;
      node_id: string;
      head: { ref: string; sha: string };
      html_url: string;
    }>("GET", `/repos/${repo}/pulls/${number}`);
    return {
      number: p.number,
      state: p.state,
      draft: Boolean(p.draft),
      merged: Boolean(p.merged),
      nodeId: p.node_id,
      headRef: p.head.ref,
      headSha: p.head.sha,
      url: p.html_url,
    };
  }

  /** Turns a draft pull request into one ready for review (GraphQL only; REST cannot). */
  async markReadyForReview(nodeId: string): Promise<void> {
    const data = await this.call<{ errors?: { message?: string }[] }>("POST", "/graphql", {
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: nodeId },
    });
    if (data.errors?.length) throw new Error(`GitHub GraphQL failed: ${data.errors.map((e) => e.message ?? "error").join("; ")}`);
  }

  // ---------- Checks on a commit (CI loop) ----------

  /** The latest check runs and commit statuses of a commit. Needs Checks: read and Commit statuses: read on fine-grained tokens. */
  async checksFor(repo: string, sha: string): Promise<{ checks: CheckInfo[]; statuses: StatusInfo[] }> {
    const ref = encodeURIComponent(sha);
    const [runs, combined] = await Promise.all([
      this.call<{
        check_runs: {
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          details_url: string | null;
          output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
          app?: { slug?: string } | null;
        }[];
      }>("GET", `/repos/${repo}/commits/${ref}/check-runs?per_page=100&filter=latest`),
      this.call<{ statuses: { context: string; state: StatusInfo["state"]; description: string | null; target_url: string | null }[] }>(
        "GET",
        `/repos/${repo}/commits/${ref}/status?per_page=100`,
      ),
    ]);
    return {
      checks: runs.check_runs.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        detailsUrl: r.details_url,
        title: r.output?.title ?? null,
        summary: r.output?.summary ?? null,
        text: r.output?.text ?? null,
        app: r.app?.slug ?? null,
      })),
      statuses: combined.statuses.map((s) => ({
        context: s.context,
        state: s.state,
        description: s.description,
        targetUrl: s.target_url,
      })),
    };
  }

  /** A check run's annotations (file, line, message), at most 50. */
  async checkAnnotations(repo: string, checkRunId: number): Promise<Annotation[]> {
    const data = await this.call<
      { path: string; start_line: number; annotation_level: string; title: string | null; message: string }[]
    >("GET", `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=50`);
    return data.map((a) => ({ path: a.path, startLine: a.start_line, level: a.annotation_level, title: a.title, message: a.message }));
  }

  /**
   * The end of a GitHub Actions job's log (its check run id is the job id), at most LOG_MAX_CHARS.
   * Needs Actions: read on fine-grained tokens. GitHub redirects to a signed URL; fetch drops our
   * Authorization header on that cross-origin redirect.
   */
  async actionsJobLog(repo: string, jobId: number): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-army",
      },
    });
    if (!res.ok) throw new Error(`GitHub GET job ${jobId} logs failed (HTTP ${res.status})`);
    const text = await res.text();
    return text.length > LOG_MAX_CHARS ? text.slice(-LOG_MAX_CHARS) : text;
  }

  // ---------- Feedback on a pull request (reviews and comments) ----------

  /** Reviews, inline review comments and conversation comments, oldest first (up to 100 of each). */
  async prFeedback(repo: string, number: number): Promise<PrFeedback[]> {
    type User = { login?: string; type?: string } | null | undefined;
    const who = (u: User) => ({ author: u?.login ?? "unknown", bot: u?.type === "Bot" });
    const [reviews, inline, comments] = await Promise.all([
      this.call<
        { id: number; user: User; body: string | null; state: string; submitted_at?: string | null; author_association: string; html_url: string }[]
      >("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100`),
      this.call<
        {
          id: number;
          user: User;
          body: string;
          path: string;
          line?: number | null;
          original_line?: number | null;
          created_at: string;
          author_association: string;
          html_url: string;
        }[]
      >("GET", `/repos/${repo}/pulls/${number}/comments?per_page=100`),
      this.call<{ id: number; user: User; body: string | null; created_at: string; author_association: string; html_url: string }[]>(
        "GET",
        `/repos/${repo}/issues/${number}/comments?per_page=100`,
      ),
    ]);
    const all: PrFeedback[] = [
      ...reviews.map((r) => ({
        kind: "review" as const,
        id: r.id,
        ...who(r.user),
        association: r.author_association,
        state: r.state,
        body: r.body ?? "",
        createdAt: r.submitted_at ?? "",
        url: r.html_url,
      })),
      ...inline.map((c) => ({
        kind: "inline" as const,
        id: c.id,
        ...who(c.user),
        association: c.author_association,
        body: c.body,
        path: c.path,
        ...((c.line ?? c.original_line) ? { line: (c.line ?? c.original_line) as number } : {}),
        createdAt: c.created_at,
        url: c.html_url,
      })),
      ...comments.map((c) => ({
        kind: "comment" as const,
        id: c.id,
        ...who(c.user),
        association: c.author_association,
        body: c.body ?? "",
        createdAt: c.created_at,
        url: c.html_url,
      })),
    ];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
