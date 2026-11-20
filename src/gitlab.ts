/**
 * GitLab client (gitlab.com or a self-managed instance, REST API v4): the
 * CodeHost a repo task needs (code-host.ts), mapped onto the GitHub client's
 * shapes (github.ts), plus what the GitLab routes use (a member's role, a
 * path's kind, project webhooks).
 *
 * - Repository ids are "gitlab:group/sub/project"; the path without the
 *   prefix, URL-encoded as a whole ("acme%2Fweb"), is the project id in API paths.
 * - A merge request's number is its iid (the number in its URL). PrRef.node_id
 *   and PullDetail.nodeId hold the iid as a string: GitLab needs no other id.
 * - A draft is a title prefix ("Draft: "): the API has no draft field to set.
 * - Roles map to GitHub's author_association (Developer = MEMBER, Maintainer
 *   and Owner = OWNER), so isHumanFeedback and WRITE_ASSOCIATIONS keep one rule.
 * - Every title, description and comment it posts has its quick actions
 *   neutralised (agents write them; GitLab would run "/merge" as the token's user).
 * - With an allow list (GitLabOptions.allowed), a project is checked by the
 *   path GitLab gives it, since GitLab follows renamed and moved projects.
 * - Errors read "GitLab <METHOD> <path> failed (HTTP <status>): …", the shape
 *   ci.ts and preview.ts read the status from. They never contain the token.
 */
import type { CodeHost, HostViewer } from "./code-host.js";
import { matchesPathAllowList } from "./code-host-access.js";
import {
  type Annotation,
  BOT_MARKER,
  type CheckInfo,
  type CodeHit,
  type CommitInfo,
  type DeploymentInfo,
  type DeploymentStatusInfo,
  FALLBACK_COMMIT_EMAIL,
  FILE_MAX_CHARS,
  type FileContent,
  type IssueComment,
  type IssueInfo,
  type ItemState,
  LOG_MAX_CHARS,
  type PrFeedback,
  type PrRef,
  type PullDetail,
  type PullInfo,
  type RepoInfo,
  type StatusInfo,
  encodePath,
} from "./github.js";
import { parseRepo, repoHost, repoId, repoPath } from "./repo-id.js";

export const GITLAB_DEFAULT_URL = "https://gitlab.com";

export interface GitLabOptions {
  token: string;
  /** https://gitlab.com (default) or a self-managed instance's address, without /api/v4. */
  baseUrl?: string;
  /**
   * The connection's allow list (groups and projects, see matchesPathAllowList).
   * When set, every project is looked up before it is used, and refused when
   * it moved or GitLab's own path for it is not covered. Repo tasks set it.
   */
  allowed?: string[];
}

/** GitLab's roles as access levels. */
export const GITLAB_ACCESS = { guest: 10, planner: 15, reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const;

/**
 * A role as GitHub's author_association: Maintainer and Owner are OWNER,
 * Developer is MEMBER (both may push), anything below or no membership NONE.
 */
export function associationForAccess(level: number | undefined): "OWNER" | "MEMBER" | "NONE" {
  if (level === undefined) return "NONE";
  if (level >= GITLAB_ACCESS.maintainer) return "OWNER";
  if (level >= GITLAB_ACCESS.developer) return "MEMBER";
  return "NONE";
}

/** The users behind project and group access tokens, and service accounts. */
const BOT_USERNAME_RE = /^(?:(?:project|group)_\d+_bot(?:_[A-Za-z0-9]+)?|service_account_[A-Za-z0-9_]+)$/;

/** True for bot accounts: `bot` where the API gives it, else the usernames GitLab gives token users and service accounts. */
export function isGitLabBot(user: { username?: string | null; bot?: boolean | null } | null | undefined): boolean {
  if (!user) return false;
  return user.bot === true || BOT_USERNAME_RE.test(user.username ?? "");
}

/** Title prefixes GitLab reads as "draft" ("Draft:", "[Draft]", "(Draft)"; "WIP" ones on older instances). */
const DRAFT_PREFIX_RE = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-\s+|\[wip\]|wip:)\s*/i;

/** The title without its draft prefixes: marking a merge request ready is removing them. */
export function stripDraft(title: string): string {
  let t = title;
  while (DRAFT_PREFIX_RE.test(t)) t = t.replace(DRAFT_PREFIX_RE, "");
  return t.trim() || title.trim();
}

/** The title of a draft merge request. */
export const draftTitle = (title: string): string => `Draft: ${stripDraft(title)}`;

/** A slash that starts a line, after any spaces or tabs. */
const LINE_START_SLASH_RE = /(^|[\r\n])([^\S\r\n]*)\//g;

/**
 * GitLab runs quick actions (/merge, /approve, /close, /target_branch…) that
 * start a line of a description or comment, as the token's user. Agents write
 * these texts from requests, tickets and files, so every slash that starts a
 * line gets a zero-width space before it: the text reads the same and nothing
 * runs. GitLab does not document that code blocks are exempt, so lines inside
 * them are treated the same. Applying it twice changes nothing more.
 */
export function neutralizeQuickActions(text: string): string {
  return text.replace(LINE_START_SLASH_RE, "$1$2​/");
}

/** A title on one line, which cannot start with a quick action either. */
const safeTitle = (title: string): string => neutralizeQuickActions(title.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, " ").trim());

/** A merge request's web address on an instance, from a stored id or a project path. */
export function mergeRequestWebUrl(baseUrl: string, repo: string, iid: number): string {
  const path = repoHost(repo) === "gitlab" ? repoPath(repo) : repo;
  return `${baseUrl.trim().replace(/\/+$/, "")}/${path}/-/merge_requests/${Math.trunc(iid)}`;
}

/** A failed GitLab API call. `status` is 0 when GitLab could not be reached. */
export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitLabError";
  }
}

/** The HTTP status of a GitLab client error, if it is one. */
export const gitlabStatus = (err: unknown): number | undefined => (err instanceof GitLabError ? err.status : undefined);

const MAX_ITEMS = 20;
const clampLimit = (limit: number | undefined, fallback = 10) => Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_ITEMS);
/** Pages read of lists that can be long (notes, discussions): 3 × 100. */
const LIST_PAGES = 3;
/** Distinct authors whose role prFeedback looks up; later ones count as NONE. */
const ROLE_LOOKUPS = 30;
/** Pipelines of one commit whose jobs are read: the newest per ref (branch, merge request). */
const PIPELINES_PER_SHA = 3;

/** Group and project paths: segments of letters, digits, "_", "." and "-", never "." or "..". */
const NAMESPACE_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,20}$/;

// ---------- API shapes (only the fields used) ----------

interface GlUser {
  id: number;
  username: string;
  name?: string | null;
  bot?: boolean | null;
}

interface GlMergeRequest {
  iid: number;
  project_id: number;
  source_project_id?: number;
  title: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  author?: GlUser | null;
  updated_at: string;
  merged_at?: string | null;
}

interface GlNote {
  id: number;
  type?: string | null;
  body: string | null;
  author?: GlUser | null;
  system?: boolean;
  created_at: string;
  updated_at?: string | null;
  position?: { new_path?: string | null; old_path?: string | null; new_line?: number | null; old_line?: number | null } | null;
}

interface GlPipeline {
  id: number;
  ref: string;
  source?: string | null;
}

interface GlJob {
  id: number;
  name: string;
  stage?: string | null;
  status: string;
  allow_failure?: boolean;
  web_url?: string | null;
  failure_reason?: string | null;
}

interface GlCommitStatus {
  id: number;
  name: string;
  status: string;
  description?: string | null;
  target_url?: string | null;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  visibility?: string;
  description?: string | null;
  default_branch?: string | null;
  last_activity_at?: string;
  updated_at?: string;
  web_url: string;
}

interface GlDeployment {
  id: number;
  sha: string;
  status: string;
  created_at: string;
  updated_at?: string | null;
  user?: { username?: string } | null;
  environment?: { name?: string; external_url?: string | null; tier?: string | null } | null;
}

// ---------- Mappings to the GitHub shapes ----------

/** A pipeline job as a check run, in GitHub's status/conclusion vocabulary. */
function jobCheck(job: GlJob): CheckInfo {
  const done = (conclusion: string) => ({ status: "completed", conclusion });
  const state = ((): { status: string; conclusion: string | null } => {
    switch (job.status) {
      case "success":
        return done("success");
      case "failed":
        // A job allowed to fail does not fail the pipeline.
        return done(job.allow_failure ? "neutral" : "failure");
      case "canceled":
        return done("cancelled");
      case "skipped":
        return done("skipped");
      case "manual":
        // Waits for someone to start it: neither a failure nor something to wait for.
        return done("action_required");
      case "running":
      case "canceling":
        return { status: "in_progress", conclusion: null };
      case "scheduled":
        return { status: "waiting", conclusion: null };
      default:
        // created, pending, preparing, waiting_for_resource, waiting_for_callback
        return { status: "queued", conclusion: null };
    }
  })();
  return {
    id: job.id,
    name: job.name,
    ...state,
    detailsUrl: job.web_url ?? null,
    title: job.failure_reason ? `Failed: ${job.failure_reason.replace(/_/g, " ")}` : null,
    summary: job.stage ? `Stage: ${job.stage}` : null,
    text: null,
    app: "gitlab-ci",
  };
}

/** An external commit status (Vercel…) in GitHub's commit status vocabulary; skipped and manual ones are left out. */
function commitStatus(s: GlCommitStatus): StatusInfo | undefined {
  const state = ((): StatusInfo["state"] | undefined => {
    switch (s.status) {
      case "success":
        return "success";
      case "failed":
        return "failure";
      case "canceled":
        return "error";
      case "skipped":
      case "manual":
        return undefined;
      default:
        return "pending";
    }
  })();
  return state ? { context: s.name, state, description: s.description ?? null, targetUrl: s.target_url ?? null } : undefined;
}

/** A deployment's status as a GitHub deployment status. */
function deploymentState(status: string): DeploymentStatusInfo["state"] {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
      return "in_progress";
    case "created":
      return "queued";
    case "blocked":
      return "pending";
    default:
      // canceled, skipped
      return "inactive";
  }
}

/** opened (and locked, which is a merge in progress) → open; closed and merged → closed. */
const pullState = (state: string) => (state === "opened" || state === "locked" ? "open" : "closed");
const isDraft = (m: { draft?: boolean; work_in_progress?: boolean }) => Boolean(m.draft ?? m.work_in_progress);
const prRef = (m: GlMergeRequest): PrRef => ({ number: m.iid, html_url: m.web_url, node_id: String(m.iid), draft: isDraft(m) });

/** A plausible email address, for commit authors. */
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** GitLab usernames, as they may appear in a noreply address. */
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

export class GitLab implements CodeHost {
  readonly kind = "gitlab" as const;
  /** The instance's address without a trailing slash, e.g. https://gitlab.com. */
  readonly baseUrl: string;
  private readonly apiUrl: string;

  constructor(readonly options: GitLabOptions) {
    this.baseUrl = (options.baseUrl ?? GITLAB_DEFAULT_URL).trim().replace(/\/+$/, "");
    this.apiUrl = `${this.baseUrl}/api/v4`;
  }

  private get token(): string {
    return this.options.token;
  }

  // ---------- HTTP ----------

  /**
   * One API call. The token goes in Authorization (not PRIVATE-TOKEN): fetch
   * drops Authorization on a redirect to another host (log downloads from
   * object storage), and GitLab takes Bearer for every kind of access token.
   */
  private async request(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const where = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept,
          "user-agent": "agent-army",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GitLabError(`GitLab ${where} failed: could not reach ${this.baseUrl}`, 0);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GitLabError(`GitLab ${where} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`, res.status);
    }
    return res;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    return (await res.json()) as T;
  }

  /** A list over several pages (per_page in `path`), following X-Next-Page. */
  private async list<T>(path: string, maxPages = LIST_PAGES): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.request("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}`);
      out.push(...((await res.json()) as T[]));
      const next = res.headers.get("x-next-page");
      if (!next || !/^\d+$/.test(next) || Number(next) <= page) break;
      page = Number(next);
    }
    return out;
  }

  /** The project path from a stored id ("gitlab:acme/web" → "acme/web"); a path without the prefix is taken as is. */
  projectPath(repo: string): string {
    const path = (repoHost(repo) === "gitlab" ? repoPath(repo) : repo).replace(/^\/+|\/+$/g, "");
    if (!parseRepo(repoId("gitlab", path))) throw new Error(`Not a GitLab project: ${repo}`);
    return path;
  }

  /** The project id in API paths: its path (as GitLab names it, when checked), URL-encoded as a whole. */
  private async project(repo: string): Promise<string> {
    return encodeURIComponent(await this.checkedPath(repo));
  }

  /** Projects that passed the allow-list check, by lowercased requested path: GitLab's own spelling. */
  private readonly cleared = new Map<string, string>();
  /** Checks under way, so concurrent calls for one project share one lookup. */
  private readonly checking = new Map<string, Promise<string>>();

  /**
   * With an allow list (options.allowed), the project as GitLab names it now,
   * looked up once. GitLab follows renamed and transferred projects, so a
   * typed path could reach a project the list does not cover: a project that
   * moved is refused (its new path must be used, and allowed), and so is one
   * the list does not cover. Without an allow list, the path as given.
   */
  private async checkedPath(repo: string): Promise<string> {
    const path = this.projectPath(repo);
    const allowed = this.options.allowed;
    if (!allowed) return path;
    const key = path.toLowerCase();
    const done = this.cleared.get(key);
    if (done) return done;
    let pending = this.checking.get(key);
    if (!pending) {
      pending = (async () => {
        const project = await this.call<{ path_with_namespace?: string }>("GET", `/projects/${encodeURIComponent(path)}`);
        const actual = project.path_with_namespace ?? "";
        if (actual.toLowerCase() !== key) {
          throw new Error(`The GitLab project ${path} has moved to ${actual}. Use gitlab:${actual} instead, if the allow list covers it.`);
        }
        if (!matchesPathAllowList(actual, allowed)) {
          throw new Error(`Not allowed to work on gitlab:${actual}: GitLab's allow list is ${allowed.join(", ")}.`);
        }
        this.cleared.set(key, actual);
        return actual;
      })().finally(() => this.checking.delete(key));
      this.checking.set(key, pending);
    }
    return pending;
  }

  /** A merge request's web address. */
  mergeRequestUrl(repo: string, iid: number): string {
    return mergeRequestWebUrl(this.baseUrl, this.projectPath(repo), iid);
  }

  // ---------- git ----------

  /**
   * The project's HTTPS clone URL. With an allow list, only for a project
   * already checked (any project call does it, e.g. defaultBranch, which the
   * worker makes before cloning), with GitLab's spelling of its path.
   */
  cloneUrl(repo: string): string {
    const path = this.projectPath(repo);
    if (!this.options.allowed) return `${this.baseUrl}/${path}.git`;
    const checked = this.cleared.get(path.toLowerCase());
    if (!checked) throw new Error(`The GitLab project ${path} must be checked against the allow list before it is cloned.`);
    return `${this.baseUrl}/${checked}.git`;
  }

  /** The Basic value git sends: GitLab takes any non-blank user name with an access token as the password ("oauth2" by convention). */
  private basic(): string {
    return Buffer.from(`oauth2:${this.token}`).toString("base64");
  }

  /** An extra header for this instance's URLs only, so the token never lands in a URL or .git/config. */
  gitAuthArgs(): string[] {
    return ["-c", `http.${this.baseUrl}/.extraheader=Authorization: Basic ${this.basic()}`];
  }

  secrets(): string[] {
    return [this.token, this.basic(), `Basic ${this.basic()}`, `Bearer ${this.token}`];
  }

  /** The token's user (GET /user). `email` is the commit email the user chose, else the public one. */
  async viewer(): Promise<HostViewer> {
    const u = await this.call<GlUser & { commit_email?: string | null; public_email?: string | null }>("GET", "/user");
    const email = [u.commit_email, u.public_email].find((e): e is string => typeof e === "string" && EMAIL_RE.test(e));
    return { id: u.id, login: u.username, ...(u.name ? { name: u.name } : {}), ...(email ? { email } : {}) };
  }

  /**
   * Commits are authored by the token's user, so GitLab (and Vercel…) attribute
   * them to the account that pushes: its commit email, else its private
   * noreply address (<id>-<username>@users.noreply.<instance host>).
   */
  commitIdentity(pointerName: string, viewer: HostViewer | undefined): { name: string; email: string } {
    const id = Number(viewer?.id);
    if (!viewer || !Number.isInteger(id) || id <= 0 || !USERNAME_RE.test(viewer.login)) {
      return { name: pointerName, email: FALLBACK_COMMIT_EMAIL };
    }
    const host = new URL(this.baseUrl).hostname;
    const email = viewer.email && EMAIL_RE.test(viewer.email) ? viewer.email : `${id}-${viewer.login}@users.noreply.${host}`;
    return { name: `${pointerName} (via ${viewer.login})`, email };
  }

  async defaultBranch(repo: string): Promise<string> {
    const p = await this.call<{ default_branch?: string | null }>("GET", `/projects/${await this.project(repo)}`);
    if (!p.default_branch) throw new Error(`GitLab project ${this.projectPath(repo)} has no default branch (is it empty?)`);
    return p.default_branch;
  }

  // ---------- merge requests ----------

  /** The open merge request from `branch` of this project (not a fork's branch of the same name). */
  async findOpenPr(repo: string, branch: string): Promise<PrRef | null> {
    const mrs = await this.call<GlMergeRequest[]>(
      "GET",
      `/projects/${await this.project(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=20`,
    );
    const mr = mrs.find((m) => m.source_project_id === undefined || m.source_project_id === m.project_id);
    return mr ? prRef(mr) : null;
  }

  /**
   * Opens a merge request; `draft` prefixes its title with "Draft: ". The
   * title and description are written by agents: their quick actions are
   * neutralised (see neutralizeQuickActions), as in every text this client posts.
   */
  async createPr(repo: string, opts: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PrRef> {
    const title = safeTitle(opts.title);
    const mr = await this.call<GlMergeRequest>("POST", `/projects/${await this.project(repo)}/merge_requests`, {
      source_branch: opts.head,
      target_branch: opts.base,
      title: opts.draft ? draftTitle(title) : title,
      description: neutralizeQuickActions(opts.body),
    });
    return prRef(mr);
  }

  /** A comment (note) on the merge request, with the platform's marker so it is never read back as feedback. */
  async commentOnPr(repo: string, number: number, body: string): Promise<void> {
    await this.call("POST", `/projects/${await this.project(repo)}/merge_requests/${number}/notes`, {
      body: `${neutralizeQuickActions(body)}\n\n${BOT_MARKER}`,
    });
  }

  /** Changes the title and/or description. A draft keeps its prefix: the title alone decides whether it is a draft. */
  async updatePr(repo: string, number: number, patch: { title?: string; body?: string }): Promise<void> {
    const update: { title?: string; description?: string } = {};
    if (patch.body !== undefined) update.description = neutralizeQuickActions(patch.body);
    if (patch.title !== undefined) {
      const current = await this.call<GlMergeRequest>("GET", `/projects/${await this.project(repo)}/merge_requests/${number}`);
      const title = safeTitle(patch.title);
      update.title = isDraft(current) ? draftTitle(title) : title;
    }
    if (update.title === undefined && update.description === undefined) return;
    await this.call("PUT", `/projects/${await this.project(repo)}/merge_requests/${number}`, update);
  }

  /** Removes the draft prefixes from the title, which marks the merge request ready. */
  async markReady(repo: string, pr: PrRef): Promise<void> {
    const path = `/projects/${await this.project(repo)}/merge_requests/${pr.number}`;
    const current = await this.call<GlMergeRequest>("GET", path);
    if (!isDraft(current)) return;
    const updated = await this.call<GlMergeRequest>("PUT", path, { title: safeTitle(stripDraft(current.title)) });
    if (isDraft(updated)) throw new Error(`GitLab kept merge request !${pr.number} as a draft after its title was changed`);
  }

  async getPull(repo: string, number: number): Promise<PullDetail> {
    const m = await this.call<GlMergeRequest>("GET", `/projects/${await this.project(repo)}/merge_requests/${number}`);
    return {
      number: m.iid,
      state: pullState(m.state),
      draft: isDraft(m),
      merged: m.state === "merged",
      nodeId: String(m.iid),
      headRef: m.source_branch,
      headSha: m.sha,
      url: m.web_url,
    };
  }

  prWebUrl(repo: string, number: number): string {
    return this.mergeRequestUrl(repo, number);
  }

  /** A user's role on the project, inherited and invited memberships included; undefined when not a member. */
  async memberAccess(repo: string, userId: number): Promise<number | undefined> {
    try {
      const m = await this.call<{ access_level?: number }>("GET", `/projects/${await this.project(repo)}/members/all/${Math.trunc(userId)}`);
      return typeof m.access_level === "number" ? m.access_level : undefined;
    } catch (err) {
      if (gitlabStatus(err) === 404) return undefined;
      throw err;
    }
  }

  /**
   * Comments, inline diff comments and review outcomes, oldest first. A
   * "requested changes" review exists only as a system note, so that one is
   * kept as a review; other system notes are left out. Each author's role
   * becomes GitHub's author_association.
   */
  async prFeedback(repo: string, number: number): Promise<PrFeedback[]> {
    const discussions = await this.list<{ notes?: GlNote[] }>(
      `/projects/${await this.project(repo)}/merge_requests/${number}/discussions?per_page=100`,
    );
    const notes = discussions.flatMap((d) => d.notes ?? []);
    const mrUrl = this.mergeRequestUrl(repo, number);
    const roles = await this.roles(
      repo,
      notes.filter((n) => !n.system || isReviewNote(n)).map((n) => n.author?.id),
    );
    const out: PrFeedback[] = [];
    for (const n of notes) {
      const author = n.author;
      const base = {
        id: n.id,
        author: author?.username ?? "unknown",
        association: associationForAccess(author ? roles.get(author.id) : undefined),
        bot: isGitLabBot(author),
        createdAt: n.created_at,
        url: `${mrUrl}#note_${n.id}`,
      };
      if (n.system) {
        const state = reviewState(n);
        if (state) out.push({ ...base, kind: "review", state, body: "" });
        continue;
      }
      const body = n.body ?? "";
      const path = n.position?.new_path || n.position?.old_path;
      if (n.type === "DiffNote" && path) {
        const line = n.position?.new_line ?? n.position?.old_line;
        out.push({ ...base, kind: "inline", body, path, ...(line ? { line } : {}) });
      } else {
        out.push({ ...base, kind: "comment", body });
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Access levels of the given users on the project (looked up once each, at most ROLE_LOOKUPS). */
  private async roles(repo: string, ids: (number | undefined)[]): Promise<Map<number, number | undefined>> {
    const unique = [...new Set(ids.filter((id): id is number => typeof id === "number"))].slice(0, ROLE_LOOKUPS);
    const levels = await Promise.all(unique.map((id) => this.memberAccess(repo, id)));
    return new Map(unique.map((id, i) => [id, levels[i]]));
  }

  /** The merge request's general comments (not diff comments or system notes), oldest first: previews posted by bots, e.g. Vercel's. */
  async issueComments(repo: string, number: number): Promise<IssueComment[]> {
    const notes = await this.list<GlNote>(
      `/projects/${await this.project(repo)}/merge_requests/${number}/notes?sort=asc&order_by=created_at&per_page=100`,
    );
    return notes
      .filter((n) => !n.system && n.type !== "DiffNote")
      .map((n) => ({
        id: n.id,
        author: n.author?.username ?? "unknown",
        bot: isGitLabBot(n.author),
        body: n.body ?? "",
        createdAt: n.created_at,
        updatedAt: n.updated_at ?? n.created_at,
      }));
  }

  // ---------- checks ----------

  /**
   * The jobs of the commit's newest pipeline per ref (its branch pipeline and
   * its merge request pipeline) as check runs, and the commit's other
   * statuses (posted by services such as Vercel) as commit statuses.
   * Pipelines of a merge result (another commit) are not included.
   */
  async checksFor(repo: string, sha: string): Promise<{ checks: CheckInfo[]; statuses: StatusInfo[] }> {
    const p = await this.project(repo);
    const ref = encodeURIComponent(sha);
    const [pipelines, statuses] = await Promise.all([
      this.call<GlPipeline[]>("GET", `/projects/${p}/pipelines?sha=${ref}&order_by=id&sort=desc&per_page=20`),
      this.call<GlCommitStatus[]>("GET", `/projects/${p}/repository/commits/${ref}/statuses?per_page=100`),
    ]);
    const newestPerRef = new Map<string, GlPipeline>();
    for (const pl of pipelines) {
      // External pipelines hold only statuses posted through the API, never jobs.
      if (pl.source !== "external" && !newestPerRef.has(pl.ref)) newestPerRef.set(pl.ref, pl);
    }
    const jobLists = await Promise.all(
      [...newestPerRef.values()]
        .slice(0, PIPELINES_PER_SHA)
        .map((pl) => this.call<GlJob[]>("GET", `/projects/${p}/pipelines/${pl.id}/jobs?per_page=100`)),
    );
    const jobs = jobLists.flat();
    // The statuses list holds the jobs too (of every pipeline of the commit); what is left came from elsewhere.
    const jobIds = new Set(jobs.map((j) => j.id));
    const jobNames = new Set(jobs.map((j) => j.name));
    return {
      checks: jobs.map(jobCheck),
      statuses: statuses
        .filter((s) => !jobIds.has(s.id) && !jobNames.has(s.name) && !isJobUrl(s.target_url))
        .map(commitStatus)
        .filter((s): s is StatusInfo => s !== undefined),
    };
  }

  /** GitLab CI has no check annotations. */
  async checkAnnotations(_repo: string, _check: CheckInfo): Promise<Annotation[]> {
    return [];
  }

  /** The end of a GitLab CI job's log (its trace), at most LOG_MAX_CHARS; undefined for statuses from elsewhere. */
  async jobLog(repo: string, check: CheckInfo): Promise<string | undefined> {
    if (check.app !== "gitlab-ci") return undefined;
    const res = await this.request("GET", `/projects/${await this.project(repo)}/jobs/${Math.trunc(check.id)}/trace`, undefined, "text/plain");
    const text = await readTail(res, LOG_MAX_CHARS * 4);
    return text.length > LOG_MAX_CHARS ? text.slice(-LOG_MAX_CHARS) : text;
  }

  // ---------- preview deployments ----------

  /** The project's recent deployments (environments) of this commit. */
  async deploymentsFor(repo: string, sha: string): Promise<DeploymentInfo[]> {
    // The deployments API has no commit filter: read the newest and keep this commit's.
    const data = await this.call<GlDeployment[]>("GET", `/projects/${await this.project(repo)}/deployments?order_by=id&sort=desc&per_page=50`);
    return data
      .filter((d) => d.sha === sha)
      .slice(0, 30)
      .map((d) => ({
        id: d.id,
        sha: d.sha,
        environment: d.environment?.name ?? "",
        originalEnvironment: null,
        production: d.environment?.tier === "production",
        transient: false,
        createdAt: d.created_at,
        creator: d.user?.username ?? null,
      }));
  }

  /** A GitLab deployment has one status at a time: it, with the environment's URL. */
  async deploymentStatuses(repo: string, deploymentId: number): Promise<DeploymentStatusInfo[]> {
    const d = await this.call<GlDeployment>("GET", `/projects/${await this.project(repo)}/deployments/${Math.trunc(deploymentId)}`);
    return [
      {
        id: d.id,
        state: deploymentState(d.status),
        environmentUrl: d.environment?.external_url || null,
        createdAt: d.updated_at ?? d.created_at,
      },
    ];
  }

  // ---------- read-only lookups (Pointer's tools) ----------

  /**
   * Projects the token's user is a member of, most recently active first; with
   * `owner`, only a group's (subgroups included) or a user's. `fullName` is the
   * stored id ("gitlab:group/project"), which every other call takes.
   */
  async listRepos(owner?: string): Promise<RepoInfo[]> {
    const order = "order_by=last_activity_at&sort=desc&per_page=30";
    let data: GlProject[];
    if (owner) {
      const path = this.namespacePath(owner);
      try {
        data = await this.call<GlProject[]>("GET", `/groups/${encodeURIComponent(path)}/projects?include_subgroups=true&${order}`);
      } catch (err) {
        if (gitlabStatus(err) !== 404 || path.includes("/")) throw err;
        data = await this.call<GlProject[]>("GET", `/users/${encodeURIComponent(path)}/projects?${order}`);
      }
    } else {
      data = await this.call<GlProject[]>("GET", `/projects?membership=true&${order}`);
    }
    return data.map((p) => ({
      fullName: repoId("gitlab", p.path_with_namespace),
      private: p.visibility !== "public",
      description: p.description ?? null,
      defaultBranch: p.default_branch ?? "",
      updatedAt: p.last_activity_at ?? p.updated_at ?? "",
      url: p.web_url,
    }));
  }

  async recentCommits(repo: string, opts: { branch?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ per_page: String(clampLimit(opts.limit)) });
    if (opts.branch) params.set("ref_name", opts.branch);
    const data = await this.call<
      { id: string; author_name?: string | null; authored_date?: string | null; committed_date?: string | null; message: string }[]
    >("GET", `/projects/${await this.project(repo)}/repository/commits?${params}`);
    return data.map((c) => ({
      sha: c.id,
      author: c.author_name ?? "unknown",
      date: c.authored_date ?? c.committed_date ?? "",
      message: c.message,
    }));
  }

  /** Merge requests, most recently updated first. "closed" includes merged ones, as on GitHub. */
  async listPulls(repo: string, opts: { state?: ItemState; limit?: number } = {}): Promise<PullInfo[]> {
    const limit = clampLimit(opts.limit);
    const p = await this.project(repo);
    const fetchState = (state: string) =>
      this.call<GlMergeRequest[]>("GET", `/projects/${p}/merge_requests?state=${state}&order_by=updated_at&sort=desc&per_page=${limit}`);
    const state = opts.state ?? "open";
    const data =
      state === "closed"
        ? (await Promise.all([fetchState("closed"), fetchState("merged")])).flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        : await fetchState(state === "open" ? "opened" : "all");
    return data.slice(0, limit).map((m) => ({
      number: m.iid,
      title: m.title,
      state: pullState(m.state),
      draft: isDraft(m),
      author: m.author?.username ?? "unknown",
      head: m.source_branch,
      base: m.target_branch,
      url: m.web_url,
      updatedAt: m.updated_at,
      mergedAt: m.merged_at ?? null,
    }));
  }

  async listIssues(repo: string, opts: { state?: ItemState; limit?: number } = {}): Promise<IssueInfo[]> {
    const state = { open: "opened", closed: "closed", all: "all" }[opts.state ?? "open"];
    const data = await this.call<
      {
        iid: number;
        title: string;
        state: string;
        author?: { username?: string } | null;
        labels?: (string | { name?: string })[];
        user_notes_count?: number;
        web_url: string;
        updated_at: string;
      }[]
    >("GET", `/projects/${await this.project(repo)}/issues?state=${state}&order_by=updated_at&sort=desc&per_page=${clampLimit(opts.limit)}`);
    return data.map((i) => ({
      number: i.iid,
      title: i.title,
      state: i.state === "opened" ? "open" : "closed",
      author: i.author?.username ?? "unknown",
      labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      comments: i.user_notes_count ?? 0,
      url: i.web_url,
      updatedAt: i.updated_at,
    }));
  }

  /** A file's text (capped at FILE_MAX_CHARS) or, for a directory or an empty path, its listing. */
  async readFile(repo: string, path: string, ref?: string): Promise<FileContent> {
    const p = await this.project(repo);
    const clean = path.split("/").filter(Boolean).join("/");
    if (clean) encodePath(clean); // refuses "." and ".." segments
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    if (!clean) return this.tree(p, "", ref);

    let res: Response;
    try {
      res = await this.request("GET", `/projects/${p}/repository/files/${encodeURIComponent(clean)}/raw${refQuery}`, undefined, "*/*");
    } catch (err) {
      // The files API answers 404 for a directory: list it instead.
      if (gitlabStatus(err) === 404) {
        const listing = await this.tree(p, clean, ref).catch(() => undefined);
        if (listing && listing.text !== "(empty directory)") return listing;
      }
      throw err;
    }
    const size = Number(res.headers.get("x-gitlab-size") ?? res.headers.get("content-length") ?? NaN);
    const { bytes, more } = await readCapped(res, FILE_MAX_CHARS * 4 + 4);
    if (bytes.includes(0)) return { text: `(binary file, ${Number.isFinite(size) ? size : "?"} bytes)`, truncated: false };
    const text = new TextDecoder().decode(bytes);
    return text.length > FILE_MAX_CHARS || more ? { text: text.slice(0, FILE_MAX_CHARS), truncated: true } : { text, truncated: false };
  }

  /** A directory listing (one page of 100 entries). */
  private async tree(project: string, path: string, ref?: string): Promise<FileContent> {
    const params = new URLSearchParams({ per_page: "100" });
    if (path) params.set("path", path);
    if (ref) params.set("ref", ref);
    const entries = await this.call<{ path: string; type: string }[]>("GET", `/projects/${project}/repository/tree?${params}`);
    const lines = entries.map((e) => (e.type === "tree" ? `${e.path}/` : e.type === "commit" ? `${e.path} (git submodule)` : e.path));
    const text = lines.join("\n") || "(empty directory)";
    return text.length > FILE_MAX_CHARS ? { text: text.slice(0, FILE_MAX_CHARS), truncated: true } : { text, truncated: false };
  }

  /**
   * Code search (blobs); with `repo`, inside that project. Without it, across
   * the instance, which GitLab offers only with advanced or exact code search
   * (its error is passed on otherwise). One hit per file, at most 20.
   */
  async searchCode(query: string, repo?: string): Promise<CodeHit[]> {
    const q = `scope=blobs&search=${encodeURIComponent(query)}&per_page=${MAX_ITEMS * 2}`;
    type Hit = { path: string; ref: string; startline?: number; project_id: number };
    const hits = repo
      ? await this.call<Hit[]>("GET", `/projects/${await this.project(repo)}/search?${q}`)
      : await this.call<Hit[]>("GET", `/search?${q}`);
    // Global hits carry only a project id: look each project's path up once.
    const paths = new Map<number, string | undefined>();
    if (repo) {
      const own = await this.checkedPath(repo);
      for (const h of hits) paths.set(h.project_id, own);
    } else {
      const ids = [...new Set(hits.map((h) => h.project_id))].slice(0, MAX_ITEMS);
      const found = await Promise.all(
        ids.map((id) =>
          this.call<GlProject>("GET", `/projects/${Math.trunc(id)}`)
            .then((p) => p.path_with_namespace)
            .catch(() => undefined),
        ),
      );
      ids.forEach((id, i) => paths.set(id, found[i]));
    }
    const seen = new Set<string>();
    const out: CodeHit[] = [];
    for (const h of hits) {
      const project = paths.get(h.project_id);
      const key = `${project}:${h.path}`;
      if (!project || seen.has(key)) continue;
      seen.add(key);
      const line = h.startline ? `#L${h.startline}` : "";
      out.push({
        repo: repoId("gitlab", project),
        path: h.path,
        url: `${this.baseUrl}/${project}/-/blob/${encodeURIComponent(h.ref)}/${encodePath(h.path)}${line}`,
      });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  // ---------- admin (the GitLab routes) ----------

  /** A group, user or project path, validated (no "." or ".." segments). */
  private namespacePath(path: string): string {
    const clean = path.trim().replace(/^gitlab:/, "").replace(/^\/+|\/+$/g, "");
    if (!NAMESPACE_PATH_RE.test(clean) || clean.split("/").some((s) => s === "." || s === "..")) {
      throw new Error(`Not a GitLab group or project path: ${path}`);
    }
    return clean;
  }

  /**
   * The token's scopes (GET /personal_access_tokens/self, which personal,
   * group and project access tokens answer), or undefined when the instance
   * does not say (older versions).
   */
  async tokenScopes(): Promise<string[] | undefined> {
    try {
      const t = await this.call<{ scopes?: unknown }>("GET", "/personal_access_tokens/self");
      return Array.isArray(t.scopes) ? t.scopes.filter((s): s is string => typeof s === "string") : undefined;
    } catch {
      return undefined;
    }
  }

  /** What an allow-list entry is to this token: a project, a group or user namespace, or nothing it can see. */
  async pathKind(path: string): Promise<"project" | "namespace" | undefined> {
    const clean = encodeURIComponent(this.namespacePath(path));
    const exists = async (url: string) => {
      try {
        await this.call("GET", url);
        return true;
      } catch (err) {
        if (gitlabStatus(err) === 404) return false;
        throw err;
      }
    };
    if (clean.includes("%2F") && (await exists(`/projects/${clean}`))) return "project";
    if (await exists(`/namespaces/${clean}`)) return "namespace";
    return undefined;
  }

  /**
   * Adds this deployment's webhook to a project, or updates the one already
   * there (matched by URL): merge request and comment events only, with
   * `secret` as its secret token. Needs the Maintainer role.
   */
  async installWebhook(repo: string, url: string, secret: string): Promise<"created" | "updated"> {
    const p = await this.project(repo);
    const hooks = await this.call<{ id: number; url: string }[]>("GET", `/projects/${p}/hooks?per_page=100`);
    const settings = {
      url,
      token: secret,
      name: "Agent Army",
      description: "Merge request reviews and comments for the team (agent-army)",
      merge_requests_events: true,
      note_events: true,
      push_events: false,
      enable_ssl_verification: true,
    };
    const existing = hooks.find((h) => h.url === url);
    if (existing) {
      await this.call("PUT", `/projects/${p}/hooks/${Math.trunc(existing.id)}`, settings);
      return "updated";
    }
    await this.call("POST", `/projects/${p}/hooks`, settings);
    return "created";
  }
}

// ---------- helpers ----------

/** System notes GitLab writes for review outcomes. Their wording is GitLab's own (English, not localised). */
const REVIEW_NOTE_STATES: [RegExp, string][] = [
  [/^requested changes\b/i, "CHANGES_REQUESTED"],
  [/^approved this merge request\b/i, "APPROVED"],
];

const reviewState = (n: GlNote): string | undefined => REVIEW_NOTE_STATES.find(([re]) => re.test((n.body ?? "").trim()))?.[1];
const isReviewNote = (n: GlNote): boolean => reviewState(n) !== undefined;

/** A GitLab job's page ("…/-/jobs/123"): such statuses are pipeline jobs, already among the checks. */
const isJobUrl = (url: string | null | undefined): boolean => Boolean(url && /\/-\/jobs\/\d+\/?$/.test(url));

/** At most `maxBytes` of a response body; `more` when the body went on (the rest is not downloaded). */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; more: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), more: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let more = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > maxBytes) {
      more = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), more };
}

/** The last `maxBytes` of a response body as text, holding at most about twice that in memory. */
async function readTail(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  let chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > maxBytes * 2) {
      const kept = Buffer.concat(chunks).subarray(-maxBytes);
      chunks = [kept];
      size = kept.length;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(-maxBytes));
}
