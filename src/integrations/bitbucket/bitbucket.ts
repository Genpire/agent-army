/**
 * Bitbucket Cloud client (REST API 2.0, https://api.bitbucket.org/2.0): what a
 * repo task needs from a code host (code-host.ts), mapped onto the GitHub
 * client's shapes, plus the read-only lookups behind Pointer's tools.
 *
 * Two kinds of token (BitbucketConfigSchema in config.ts):
 *  - an Atlassian API token with Bitbucket scopes, used with the account's
 *    email: REST calls send Basic email:token, git sends Basic
 *    x-bitbucket-api-token-auth:token;
 *  - a workspace, project or repository access token (no email): REST calls
 *    send it as a Bearer token, git sends Basic x-token-auth:token. These
 *    tokens have no user, so GET /user refuses them.
 *
 * Repository ids are "bitbucket:workspace/repo" (repo-id.ts). Pull requests
 * keep their id as the number; the platform's comments carry BOT_MARKER
 * inside a Markdown link definition, which Bitbucket does not render.
 * Pipelines steps are the checks (CheckInfo.ref = "<pipeline uuid>/<step uuid>").
 * Errors carry the HTTP status ("(HTTP 403)", as github.ts errors do) and
 * never the token.
 */
import { createHash } from "node:crypto";
import type { CodeHost, HostViewer } from "../code-hosts/code-host.js";
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
} from "../github/github.js";
import { BITBUCKET_REPO_RE, repoFromInput, repoId, repoPath } from "../code-hosts/repo-id.js";

export interface BitbucketOptions {
  token: string;
  /** The Atlassian account email of an API token; absent for access tokens. */
  email?: string;
}

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";
export const BITBUCKET_WEB = "https://bitbucket.org";
/** CheckInfo.app of Pipelines steps. */
export const PIPELINES_APP = "bitbucket-pipelines";
/** The username git sends with an API token, and with an access token (Bitbucket's documented static usernames). */
export const GIT_USER_API_TOKEN = "x-bitbucket-api-token-auth";
export const GIT_USER_ACCESS_TOKEN = "x-token-auth";

/** A Bitbucket API error: the message names the call and the HTTP status, never the token. */
export class BitbucketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

/** The HTTP status of a failed Bitbucket call, or undefined for other errors (network, parsing). */
export const bitbucketStatus = (err: unknown): number | undefined => (err instanceof BitbucketApiError ? err.status : undefined);

// ---------- API shapes (only the fields read here) ----------

interface Link {
  href?: string;
}
interface Page<T> {
  values?: T[];
  next?: string;
}
/** A user, an app user (bots: Vercel, access tokens…) or a team. */
export interface BitbucketAccount {
  type?: string;
  uuid?: string;
  account_id?: string;
  nickname?: string;
  display_name?: string;
  username?: string;
}
interface Pull {
  id: number;
  title?: string;
  description?: string;
  state?: string;
  draft?: boolean;
  author?: BitbucketAccount | null;
  source?: { branch?: { name?: string }; commit?: { hash?: string } | null };
  destination?: { branch?: { name?: string } };
  links?: { html?: Link };
  created_on?: string;
  updated_on?: string;
  participants?: { user?: BitbucketAccount | null; state?: string | null; approved?: boolean; participated_on?: string | null }[];
  reviewers?: { uuid?: string }[];
}
interface Comment {
  id: number;
  content?: { raw?: string | null } | null;
  user?: BitbucketAccount | null;
  deleted?: boolean;
  pending?: boolean;
  inline?: { path?: string; from?: number | null; to?: number | null } | null;
  created_on: string;
  updated_on?: string;
  links?: { html?: Link };
}
interface Pipeline {
  uuid: string;
  build_number?: number;
  state?: { name?: string; stage?: { name?: string } | null; result?: { name?: string } | null };
  target?: { selector?: { type?: string; pattern?: string } | null; ref_name?: string };
}
interface Step {
  uuid: string;
  name?: string;
  state?: { name?: string; result?: { name?: string; error?: { message?: string } | null } | null };
}
interface CommitStatus {
  key?: string;
  name?: string;
  state?: string;
  description?: string | null;
  url?: string | null;
}
interface Repository {
  full_name: string;
  is_private?: boolean;
  description?: string | null;
  mainbranch?: { name?: string } | null;
  updated_on?: string;
  links?: { html?: Link };
}

// ---------- helpers ----------

const MAX_ITEMS = 20;
const limitOf = (limit: number | undefined, fallback = 10) => Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_ITEMS);
/** Files above this are not read through the API (the same bound as GitHub's contents API). */
const FILE_MAX_BYTES = 1_000_000;
/** Pull request comments read for feedback: 3 pages of 100. */
const COMMENT_PAGES = 3;
/** Pipelines of one commit looked at (the newest of each kind: branch, pull request, custom…). */
const MAX_PIPELINES = 5;
const HASH_RE = /^[0-9a-f]{7,40}$/i;
const UUID_RE = /^\{[0-9a-f-]{36}\}$/i;
const ACCOUNT_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}$/;
/** Pipelines' own commit statuses link to its results page; its steps are reported as checks instead. */
const PIPELINES_STATUS_URL = /^https:\/\/bitbucket\.org\/[^/]+\/[^/]+\/(?:addon\/pipelines\/home#!\/results\/|pipelines\/results\/)/i;

/** The workspace and slug of a stored id ("bitbucket:acme/web"; a bare "acme/web" is read as Bitbucket's), for API paths. */
export function bitbucketRepo(repo: string): { id: string; path: string; workspace: string; slug: string; api: string } {
  const id = repo.startsWith("bitbucket:") ? repo : repoId("bitbucket", repo);
  if (!BITBUCKET_REPO_RE.test(id)) throw new Error(`Not a Bitbucket repository: ${repo.slice(0, 100)}`);
  const path = repoPath(id);
  const [workspace, slug] = path.split("/") as [string, string];
  // Workspace ids and repository slugs are lowercase on Bitbucket.
  return { id, path, workspace, slug, api: `/repositories/${encodeURIComponent(workspace.toLowerCase())}/${encodeURIComponent(slug.toLowerCase())}` };
}

/** A stable positive number for an id that is not one (pipeline steps, approvals), below 2^48. */
export function syntheticId(text: string): number {
  return createHash("sha256").update(text).digest().readUIntBE(0, 6) + 1;
}

/** A BBQL string literal. */
const bbql = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

const isBot = (a: BitbucketAccount | null | undefined) => Boolean(a?.type && a.type !== "user");
const nameOf = (a: BitbucketAccount | null | undefined) => a?.nickname || a?.display_name || "unknown";
/** The id permissions are looked up by: the Atlassian account id, else the Bitbucket UUID. */
const accountKey = (a: BitbucketAccount | null | undefined): string | undefined => {
  if (a?.account_id && ACCOUNT_ID_RE.test(a.account_id)) return a.account_id;
  if (a?.uuid && UUID_RE.test(a.uuid)) return a.uuid;
  return undefined;
};

/** "Jane Doe <jane@example.com>" → "Jane Doe": commit authors without their address. */
const authorName = (raw: string | undefined) => (raw ?? "").replace(/\s*<[^>]*>\s*$/, "").trim() || "unknown";

const cap = (text: string): FileContent =>
  text.length > FILE_MAX_CHARS ? { text: text.slice(0, FILE_MAX_CHARS), truncated: true } : { text, truncated: false };

/** The end of a response body, read in chunks so a long log is never held whole. */
async function tailText(res: Response, maxChars: number): Promise<string> {
  const keep = maxChars * 4;
  const reader = res.body?.getReader();
  if (!reader) return "";
  let chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size > keep * 2) {
      const all = Buffer.concat(chunks);
      chunks = [all.subarray(all.length - keep)];
      size = keep;
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** A Pipelines step in GitHub's check vocabulary. Waiting steps of a finished or paused pipeline will not run on their own. */
function stepState(step: Step, pipeline: Pipeline): { status: string; conclusion: string | null } {
  const name = step.state?.name?.toUpperCase();
  if (name === "COMPLETED") {
    const conclusion: Record<string, string> = {
      SUCCESSFUL: "success",
      FAILED: "failure",
      ERROR: "failure",
      STOPPED: "cancelled",
      NOT_RUN: "skipped",
      EXPIRED: "cancelled",
    };
    return { status: "completed", conclusion: conclusion[step.state?.result?.name?.toUpperCase() ?? ""] ?? "neutral" };
  }
  if (name === "IN_PROGRESS") return { status: "in_progress", conclusion: null };
  const pipelineState = pipeline.state?.name?.toUpperCase();
  const stage = pipeline.state?.stage?.name?.toUpperCase();
  if (pipelineState === "COMPLETED") return { status: "completed", conclusion: "skipped" };
  // A manual step: the pipeline waits for a person to run it.
  if (stage === "PAUSED" || stage === "HALTED") return { status: "completed", conclusion: "action_required" };
  return { status: "queued", conclusion: null };
}

const STATUS_STATE: Record<string, StatusInfo["state"]> = {
  SUCCESSFUL: "success",
  FAILED: "failure",
  INPROGRESS: "pending",
  STOPPED: "error",
};

const PR_STATES: Record<ItemState, string[]> = {
  open: ["OPEN"],
  closed: ["MERGED", "DECLINED", "SUPERSEDED"],
  all: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
};

/** Minimal Bitbucket Cloud client: what the worker needs, plus read-only lookups for Pointer's chat tools. */
export class Bitbucket implements CodeHost {
  readonly kind = "bitbucket" as const;
  private readonly branches = new Map<string, Promise<string>>();
  private readonly associations = new Map<string, Promise<string>>();

  constructor(readonly options: BitbucketOptions) {}

  /** "api-token" with an Atlassian account email, else "access-token". */
  get tokenKind(): "api-token" | "access-token" {
    return this.options.email ? "api-token" : "access-token";
  }

  private authorization(): string {
    const { token, email } = this.options;
    return email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
  }

  /**
   * One API call. Only api.bitbucket.org/2.0 gets the token: a `next` link
   * pointing elsewhere is refused. Redirects (logs in long-term storage, LFS
   * files) are followed; fetch drops the Authorization header on the
   * cross-origin hop.
   */
  private async send(
    method: string,
    pathOrUrl: string,
    init: { body?: unknown; accept?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${BITBUCKET_API}${pathOrUrl}`;
    const parsed = URL.parse(url);
    if (!parsed || parsed.origin !== new URL(BITBUCKET_API).origin || !parsed.pathname.startsWith("/2.0/") || parsed.username || parsed.password) {
      throw new Error("Refusing to call a Bitbucket link outside api.bitbucket.org.");
    }
    const shown = url.slice(BITBUCKET_API.length).split("?")[0];
    const res = await fetch(url, {
      method,
      headers: {
        authorization: this.authorization(),
        accept: init.accept ?? "application/json",
        "user-agent": "agent-army",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BitbucketApiError(`Bitbucket ${method} ${shown} failed (HTTP ${res.status}): ${this.scrub(errorDetail(text))}`, res.status);
    }
    return res;
  }

  private async call<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const res = await this.send(method, pathOrUrl, body === undefined ? {} : { body });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A paginated list, following `next` for at most `pages` pages. */
  private async collect<T>(path: string, pages: number): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let i = 0; next && i < pages; i++) {
      const page: Page<T> = await this.call<Page<T>>("GET", next);
      items.push(...(page.values ?? []));
      next = page.next;
    }
    return items;
  }

  /** The token never appears in an error, even if Bitbucket echoed it. */
  private scrub(text: string): string {
    return this.secrets().reduce((acc, s) => (s.length >= 6 ? acc.split(s).join("[redacted]") : acc), text);
  }

  // ---------- git ----------

  cloneUrl(repo: string): string {
    return `${BITBUCKET_WEB}/${bitbucketRepo(repo).path}.git`;
  }

  /** Basic auth with Bitbucket's static git username for the token's kind, so the token never lands in .git/config. */
  gitAuthArgs(): string[] {
    return ["-c", `http.${BITBUCKET_WEB}/.extraheader=Authorization: Basic ${this.gitBasic()}`];
  }

  private gitBasic(): string {
    const user = this.options.email ? GIT_USER_API_TOKEN : GIT_USER_ACCESS_TOKEN;
    return Buffer.from(`${user}:${this.options.token}`).toString("base64");
  }

  secrets(): string[] {
    const { token, email } = this.options;
    const basics = [this.gitBasic(), ...(email ? [Buffer.from(`${email}:${token}`).toString("base64")] : [])];
    return [token, ...basics].filter((s) => s.length > 0);
  }

  /**
   * The account behind an API token (GET /user): its Atlassian account id,
   * username and name, and its primary confirmed email when Bitbucket shows
   * it. Access tokens have no user: this throws for them (HTTP 401).
   */
  async viewer(): Promise<HostViewer> {
    const u = await this.call<BitbucketAccount>("GET", "/user");
    const email = await this.call<Page<{ email?: string; is_primary?: boolean; is_confirmed?: boolean }>>("GET", "/user/emails")
      .then((p) => p.values?.find((e) => e.is_primary && e.is_confirmed)?.email)
      .catch(() => undefined);
    return {
      id: u.account_id ?? u.uuid ?? "",
      login: u.username || u.nickname || u.display_name || "",
      ...(u.display_name ? { name: u.display_name } : {}),
      ...(email && EMAIL_RE.test(email) ? { email } : {}),
    };
  }

  /**
   * "Pointer (via <username>)" with the account's own address, so Bitbucket
   * links the commits to the account that pushes them. Without one (access
   * tokens, or an account whose emails the token may not read) a reserved
   * domain that links them to nobody.
   */
  commitIdentity(pointerName: string, viewer: HostViewer | undefined): { name: string; email: string } {
    const login = viewer?.login && /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,59}$/u.test(viewer.login) ? viewer.login : undefined;
    const email = viewer?.email && EMAIL_RE.test(viewer.email) ? viewer.email : FALLBACK_COMMIT_EMAIL;
    return { name: login ? `${pointerName} (via ${login})` : pointerName, email };
  }

  /** The repository's main branch, asked once per client. */
  async defaultBranch(repo: string): Promise<string> {
    const { api } = bitbucketRepo(repo);
    let pending = this.branches.get(api);
    if (!pending) {
      pending = this.call<Repository>("GET", `${api}?fields=mainbranch.name`).then((r) => {
        if (!r.mainbranch?.name) throw new Error(`Bitbucket repository ${repo} has no main branch yet.`);
        return r.mainbranch.name;
      });
      pending.catch(() => this.branches.delete(api));
      this.branches.set(api, pending);
    }
    return pending;
  }

  // ---------- pull requests ----------

  private prRef(p: Pull): PrRef {
    return { number: p.id, html_url: p.links?.html?.href ?? "", node_id: String(p.id), draft: Boolean(p.draft) };
  }

  prWebUrl(repo: string, number: number): string {
    return `${BITBUCKET_WEB}/${bitbucketRepo(repo).path}/pull-requests/${number}`;
  }

  /** The open pull request (draft or not) from `branch`, if any. */
  async findOpenPr(repo: string, branch: string): Promise<PrRef | null> {
    const { api } = bitbucketRepo(repo);
    const q = `source.branch.name=${bbql(branch)} AND state="OPEN"`;
    const page = await this.call<Page<Pull>>("GET", `${api}/pullrequests?q=${encodeURIComponent(q)}&pagelen=1`);
    const pr = page.values?.[0];
    return pr ? this.prRef(pr) : null;
  }

  /** Opens a pull request; `draft` opens it as a draft (unfinished work). */
  async createPr(repo: string, opts: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PrRef> {
    const { api } = bitbucketRepo(repo);
    const pr = await this.call<Pull>("POST", `${api}/pullrequests`, {
      title: opts.title,
      description: opts.body,
      source: { branch: { name: opts.head } },
      destination: { branch: { name: opts.base } },
      ...(opts.draft ? { draft: true } : {}),
    });
    return this.prRef(pr);
  }

  /** Comments on the pull request. The platform's marker is appended (hidden in a link definition) so the comment is never read back as feedback. */
  async commentOnPr(repo: string, number: number, body: string): Promise<void> {
    const { api } = bitbucketRepo(repo);
    await this.call("POST", `${api}/pullrequests/${number}/comments`, { content: { raw: `${body}\n\n[//]: # (${BOT_MARKER})` } });
  }

  /**
   * PUT replaces the pull request, so the current title and reviewers are sent
   * along with the change (a PUT without reviewers would drop them).
   */
  private async putPull(repo: string, number: number, patch: { title?: string; description?: string; draft?: boolean }): Promise<void> {
    const { api } = bitbucketRepo(repo);
    const current = await this.call<Pull>("GET", `${api}/pullrequests/${number}`);
    const reviewers = (current.reviewers ?? []).filter((r) => r.uuid).map((r) => ({ uuid: r.uuid }));
    await this.call("PUT", `${api}/pullrequests/${number}`, {
      title: patch.title ?? current.title,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
      ...(current.reviewers ? { reviewers } : {}),
    });
  }

  async updatePr(repo: string, number: number, patch: { title?: string; body?: string }): Promise<void> {
    if (patch.title === undefined && patch.body === undefined) return;
    await this.putPull(repo, number, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.body !== undefined ? { description: patch.body } : {}) });
  }

  /** A draft becomes ready for review: its draft flag is cleared. */
  async markReady(repo: string, pr: PrRef): Promise<void> {
    if (!pr.draft) return;
    await this.putPull(repo, pr.number, { draft: false });
  }

  /** The full hash of a commit; pull requests and webhooks give 12-character ones. */
  private async fullHash(repo: string, sha: string): Promise<string> {
    if (sha.length === 40 || !HASH_RE.test(sha)) return sha;
    const { api } = bitbucketRepo(repo);
    const commit = await this.call<{ hash?: string }>("GET", `${api}/commit/${encodeURIComponent(sha)}?fields=hash`);
    return commit.hash ?? sha;
  }

  async getPull(repo: string, number: number): Promise<PullDetail> {
    const { api } = bitbucketRepo(repo);
    const p = await this.call<Pull>("GET", `${api}/pullrequests/${number}`);
    const state = (p.state ?? "").toUpperCase();
    const head = p.source?.commit?.hash ?? "";
    return {
      number: p.id,
      state: state === "OPEN" ? "open" : "closed",
      draft: Boolean(p.draft),
      merged: state === "MERGED",
      nodeId: String(p.id),
      headRef: p.source?.branch?.name ?? "",
      headSha: head ? await this.fullHash(repo, head) : "",
      url: p.links?.html?.href ?? this.prWebUrl(repo, p.id),
    };
  }

  /** Comments of a pull request, oldest first, without deleted ones and others' unpublished drafts. */
  private async comments(repo: string, number: number): Promise<Comment[]> {
    const { api } = bitbucketRepo(repo);
    const all = await this.collect<Comment>(`${api}/pullrequests/${number}/comments?pagelen=100&sort=created_on`, COMMENT_PAGES);
    return all.filter((c) => !c.deleted && !c.pending);
  }

  /**
   * Who may steer the team, in GitHub's author_association words so
   * isHumanFeedback and WRITE_ASSOCIATIONS work unchanged: "OWNER" (admin on
   * the repository), "COLLABORATOR" (write), "NONE" (read or nothing). Read
   * from the repository's effective permissions, which only repository admins
   * may see; when the token may not, a member of the repository's workspace
   * counts as "MEMBER" (as an organisation member does on GitHub), and anyone
   * else as "NONE". Asked once per account and repository per client.
   */
  association(repo: string, account: BitbucketAccount | null | undefined): Promise<string> {
    const key = accountKey(account);
    if (!key) return Promise.resolve("NONE");
    const { api, workspace, slug } = bitbucketRepo(repo);
    const cacheKey = `${api}#${key}`;
    let pending = this.associations.get(cacheKey);
    if (!pending) {
      pending = this.lookUpAssociation(workspace.toLowerCase(), slug.toLowerCase(), key).catch(() => "NONE");
      this.associations.set(cacheKey, pending);
    }
    return pending;
  }

  private async lookUpAssociation(workspace: string, slug: string, key: string): Promise<string> {
    const ws = encodeURIComponent(workspace);
    const field = UUID_RE.test(key) ? "user.uuid" : "user.account_id";
    try {
      const page = await this.call<Page<{ permission?: string }>>(
        "GET",
        `/workspaces/${ws}/permissions/repositories/${encodeURIComponent(slug)}?q=${encodeURIComponent(`${field}=${bbql(key)}`)}`,
      );
      const permission = page.values?.[0]?.permission;
      return permission === "admin" ? "OWNER" : permission === "write" ? "COLLABORATOR" : "NONE";
    } catch (err) {
      const status = bitbucketStatus(err);
      if (status !== 401 && status !== 403) return "NONE";
    }
    try {
      await this.call("GET", `/workspaces/${ws}/members/${encodeURIComponent(key)}`);
      return "MEMBER";
    } catch {
      return "NONE";
    }
  }

  /**
   * Approvals and change requests (from the pull request's participants),
   * inline comments and conversation comments, oldest first. Change requests
   * and approvals have no text; the date is when the person last took part.
   */
  async prFeedback(repo: string, number: number): Promise<PrFeedback[]> {
    const { api } = bitbucketRepo(repo);
    const [pull, comments] = await Promise.all([this.call<Pull>("GET", `${api}/pullrequests/${number}`), this.comments(repo, number)]);
    const prUrl = pull.links?.html?.href ?? this.prWebUrl(repo, number);
    const reviews = (pull.participants ?? []).flatMap((p) => {
      const state = p.state === "changes_requested" ? "CHANGES_REQUESTED" : p.state === "approved" || (!p.state && p.approved) ? "APPROVED" : undefined;
      return state ? [{ user: p.user, state, createdAt: p.participated_on ?? pull.updated_on ?? "" }] : [];
    });
    const people = [...reviews.map((r) => r.user), ...comments.map((c) => c.user)];
    const associations = new Map<string, string>();
    await Promise.all(
      people.map(async (u) => {
        const key = accountKey(u);
        if (key && !associations.has(key)) associations.set(key, await this.association(repo, u));
      }),
    );
    const who = (u: BitbucketAccount | null | undefined) => ({
      author: nameOf(u),
      bot: isBot(u),
      association: associations.get(accountKey(u) ?? "") ?? "NONE",
    });
    const all: PrFeedback[] = [
      ...reviews.map((r) => ({
        kind: "review" as const,
        id: syntheticId(`review:${accountKey(r.user) ?? nameOf(r.user)}:${r.state}`),
        ...who(r.user),
        state: r.state,
        body: "",
        createdAt: r.createdAt,
        url: prUrl,
      })),
      ...comments.map((c) => {
        const line = c.inline ? (c.inline.to ?? c.inline.from) : undefined;
        return {
          kind: c.inline?.path ? ("inline" as const) : ("comment" as const),
          id: c.id,
          ...who(c.user),
          body: c.content?.raw ?? "",
          ...(c.inline?.path ? { path: c.inline.path } : {}),
          ...(line ? { line } : {}),
          createdAt: c.created_on,
          url: c.links?.html?.href ?? prUrl,
        };
      }),
    ];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The pull request's conversation comments (not inline ones), oldest first: previews posted by bots such as Vercel's. */
  async issueComments(repo: string, number: number): Promise<IssueComment[]> {
    return (await this.comments(repo, number))
      .filter((c) => !c.inline?.path)
      .map((c) => ({
        id: c.id,
        author: nameOf(c.user),
        bot: isBot(c.user),
        body: c.content?.raw ?? "",
        createdAt: c.created_on,
        updatedAt: c.updated_on ?? c.created_on,
      }));
  }

  // ---------- checks ----------

  /**
   * The steps of the commit's newest pipeline of each kind (branch, pull
   * request, custom…) as checks, and its commit statuses (Vercel, other CI).
   * Pipelines' own statuses are left out when its steps could be read, so a
   * failure is reported once. Without the pipeline scope, only statuses.
   */
  async checksFor(repo: string, sha: string): Promise<{ checks: CheckInfo[]; statuses: StatusInfo[] }> {
    const { api } = bitbucketRepo(repo);
    const hash = await this.fullHash(repo, sha);
    const [checks, statuses] = await Promise.all([
      this.pipelineChecks(repo, hash).catch((err: unknown) => {
        const status = bitbucketStatus(err);
        if (status === 401 || status === 403 || status === 404) return undefined;
        throw err;
      }),
      this.collect<CommitStatus>(`${api}/commit/${encodeURIComponent(hash)}/statuses?pagelen=100`, 1),
    ]);
    return {
      checks: checks ?? [],
      statuses: statuses
        .filter((s) => !(checks && s.url && PIPELINES_STATUS_URL.test(s.url)))
        .map((s) => ({
          context: s.name || s.key || "status",
          state: STATUS_STATE[(s.state ?? "").toUpperCase()] ?? "pending",
          description: s.description ?? null,
          targetUrl: s.url ?? null,
        })),
    };
  }

  private async pipelineChecks(repo: string, hash: string): Promise<CheckInfo[]> {
    const { api, path } = bitbucketRepo(repo);
    const page = await this.call<Page<Pipeline>>("GET", `${api}/pipelines?target.commit.hash=${encodeURIComponent(hash)}&sort=-created_on&pagelen=20`);
    // Newest first: the first pipeline of each kind is the one that counts (a rerun replaces the earlier run).
    const latest = new Map<string, Pipeline>();
    for (const p of page.values ?? []) {
      const kind = `${p.target?.selector?.type ?? ""}:${p.target?.selector?.pattern ?? ""}`;
      if (!latest.has(kind) && latest.size < MAX_PIPELINES) latest.set(kind, p);
    }
    const pipelines = [...latest.values()];
    const runs = await Promise.all(
      pipelines.map(async (p) => ({ p, steps: await this.collect<Step>(`${api}/pipelines/${encodeURIComponent(p.uuid)}/steps?pagelen=100`, 1) })),
    );
    return runs.flatMap(({ p, steps }) => {
      const label = pipelines.length > 1 ? `${p.target?.selector?.pattern || p.target?.selector?.type || "pipeline"}: ` : "";
      // A step run again keeps its name: the last run counts.
      const byName = new Map<string, Step>();
      steps.forEach((s, i) => byName.set(s.name || `Step ${i + 1}`, s));
      return [...byName.entries()].map(([name, step]) => {
        const { status, conclusion } = stepState(step, p);
        const build = p.build_number;
        return {
          id: syntheticId(step.uuid),
          name: `${label}${name}`,
          status,
          conclusion,
          detailsUrl: build ? `${BITBUCKET_WEB}/${path}/pipelines/results/${build}/steps/${encodeURIComponent(step.uuid)}` : null,
          title: build ? `Pipeline #${build}` : null,
          summary: step.state?.result?.error?.message ?? null,
          text: null,
          app: PIPELINES_APP,
          ref: `${p.uuid}/${step.uuid}`,
        };
      });
    });
  }

  /** Pipelines has no file and line annotations on steps (Code Insights reports are per commit): none. */
  async checkAnnotations(_repo: string, _check: CheckInfo): Promise<Annotation[]> {
    return [];
  }

  /** The end of a Pipelines step's log (at most LOG_MAX_CHARS), from CheckInfo.ref; undefined for other checks or a step without a log. */
  async jobLog(repo: string, check: CheckInfo): Promise<string | undefined> {
    if (check.app !== PIPELINES_APP || !check.ref) return undefined;
    const [pipeline, step, extra] = check.ref.split("/");
    if (!pipeline || !step || extra !== undefined || !UUID_RE.test(pipeline) || !UUID_RE.test(step)) return undefined;
    const { api } = bitbucketRepo(repo);
    let res: Response;
    try {
      res = await this.send("GET", `${api}/pipelines/${encodeURIComponent(pipeline)}/steps/${encodeURIComponent(step)}/log`, {
        accept: "application/octet-stream, text/plain, */*",
        // Only the end is kept: ask for it (servers that ignore Range send it all, which tailText bounds).
        headers: { range: `bytes=-${LOG_MAX_CHARS * 4}` },
      });
    } catch (err) {
      if (bitbucketStatus(err) === 404) return undefined;
      if (bitbucketStatus(err) === 416) return "";
      throw err;
    }
    return tailText(res, LOG_MAX_CHARS);
  }

  /** Bitbucket deployments are Pipelines environments, not previews per commit: none. */
  async deploymentsFor(_repo: string, _sha: string): Promise<DeploymentInfo[]> {
    return [];
  }

  async deploymentStatuses(_repo: string, _deploymentId: number): Promise<DeploymentStatusInfo[]> {
    return [];
  }

  // ---------- webhooks ----------

  /**
   * Adds the review webhook to a repository, or updates the one already
   * pointing at `url` (a new secret, the events). Needs the webhook scopes
   * and admin on the repository.
   */
  async ensureWebhook(repo: string, hook: { url: string; secret: string; events: string[]; description: string }): Promise<"created" | "updated"> {
    const { api } = bitbucketRepo(repo);
    const existing = (await this.collect<{ uuid?: string; url?: string }>(`${api}/hooks?pagelen=100`, 3)).find((h) => h.url === hook.url && h.uuid);
    const body = { description: hook.description, url: hook.url, active: true, secret: hook.secret, events: hook.events };
    if (existing?.uuid) {
      await this.call("PUT", `${api}/hooks/${encodeURIComponent(existing.uuid)}`, body);
      return "updated";
    }
    await this.call("POST", `${api}/hooks`, body);
    return "created";
  }

  /** Throws (with the HTTP status) unless the token reaches a workspace's repositories ("acme") or one repository ("acme/web"). */
  async checkReach(entry: string): Promise<void> {
    const path = entry.includes("/") ? bitbucketRepo(entry).api : `/repositories/${encodeURIComponent(entry.toLowerCase())}?pagelen=1`;
    await this.call("GET", path);
  }

  // ---------- read-only lookups (Pointer's chat tools) ----------

  private repoInfo(r: Repository): RepoInfo {
    return {
      fullName: repoId("bitbucket", r.full_name),
      private: Boolean(r.is_private),
      description: r.description || null,
      defaultBranch: r.mainbranch?.name ?? "",
      updatedAt: r.updated_on ?? "",
      url: r.links?.html?.href ?? `${BITBUCKET_WEB}/${r.full_name}`,
    };
  }

  /** The workspaces the token's account belongs to. Access tokens have no account: `what` says what to name instead. */
  private async workspaces(max: number, what: string): Promise<string[]> {
    try {
      const page = await this.call<Page<{ workspace?: { slug?: string } }>>("GET", `/user/workspaces?pagelen=${Math.min(max, 100)}`);
      return (page.values ?? []).map((w) => w.workspace?.slug ?? "").filter(Boolean).slice(0, max);
    } catch (err) {
      throw new Error(`Name a Bitbucket ${what}: this token cannot list its workspaces (${(err as Error).message})`);
    }
  }

  /** Repositories the token can reach, most recently updated first: one workspace's, or those of the account's workspaces. */
  async listRepos(owner?: string): Promise<RepoInfo[]> {
    const one = owner?.replace(/^bitbucket:/, "").split("/")[0]?.trim() || undefined;
    if (one !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/.test(one)) throw new Error(`Not a Bitbucket workspace: ${one.slice(0, 100)}`);
    const workspaces = one ? [one] : await this.workspaces(5, "workspace");
    const lists = await Promise.all(
      workspaces.map((ws) => this.call<Page<Repository>>("GET", `/repositories/${encodeURIComponent(ws.toLowerCase())}?sort=-updated_on&pagelen=30`)),
    );
    return lists
      .flatMap((p) => p.values ?? [])
      .sort((a, b) => (b.updated_on ?? "").localeCompare(a.updated_on ?? ""))
      .slice(0, 30)
      .map((r) => this.repoInfo(r));
  }

  async recentCommits(repo: string, opts: { branch?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const { api } = bitbucketRepo(repo);
    const params = new URLSearchParams({ pagelen: String(limitOf(opts.limit)) });
    // include= takes any ref name, slashes too (a path segment would not).
    if (opts.branch) params.set("include", opts.branch);
    const page = await this.call<Page<{ hash: string; date?: string; message?: string; author?: { raw?: string; user?: BitbucketAccount | null } }>>(
      "GET",
      `${api}/commits?${params}`,
    );
    return (page.values ?? []).slice(0, limitOf(opts.limit)).map((c) => ({
      sha: c.hash,
      author: c.author?.user ? nameOf(c.author.user) : authorName(c.author?.raw),
      date: c.date ?? "",
      message: c.message ?? "",
    }));
  }

  async listPulls(repo: string, opts: { state?: ItemState; limit?: number } = {}): Promise<PullInfo[]> {
    const { api } = bitbucketRepo(repo);
    const params = new URLSearchParams({ sort: "-updated_on", pagelen: String(limitOf(opts.limit)) });
    for (const s of PR_STATES[opts.state ?? "open"]) params.append("state", s);
    const page = await this.call<Page<Pull>>("GET", `${api}/pullrequests?${params}`);
    return (page.values ?? []).slice(0, limitOf(opts.limit)).map((p) => {
      const state = (p.state ?? "").toLowerCase();
      return {
        number: p.id,
        title: p.title ?? "",
        state,
        draft: Boolean(p.draft),
        author: nameOf(p.author),
        head: p.source?.branch?.name ?? "",
        base: p.destination?.branch?.name ?? "",
        url: p.links?.html?.href ?? this.prWebUrl(repo, p.id),
        updatedAt: p.updated_on ?? "",
        // Bitbucket has no merge date on a pull request; a merged one was last updated by its merge.
        mergedAt: state === "merged" ? (p.updated_on ?? null) : null,
      };
    });
  }

  /** Bitbucket Cloud removed its issue tracker (and its API) in August 2026. */
  async listIssues(repo: string, _opts: { state?: ItemState; limit?: number } = {}): Promise<IssueInfo[]> {
    throw new Error(`Bitbucket Cloud has no issue tracker any more, so ${bitbucketRepo(repo).id} has no issues to list. Its work is tracked elsewhere, for example in Jira.`);
  }

  /** A commit or a ref name the src endpoint takes in its path: names with "/" are resolved to their commit first. */
  private async revision(repo: string, ref: string | undefined): Promise<string> {
    const name = ref?.trim() || (await this.defaultBranch(repo));
    if (HASH_RE.test(name) || !name.includes("/")) return name;
    const { api } = bitbucketRepo(repo);
    const page = await this.call<Page<{ hash: string }>>("GET", `${api}/commits?${new URLSearchParams({ include: name, pagelen: "1" })}`);
    const hash = page.values?.[0]?.hash;
    if (!hash) throw new Error(`No commit found for ${name.slice(0, 100)} in ${repo}.`);
    return hash;
  }

  /** A file's text (capped at FILE_MAX_CHARS) or, for a directory or the empty path, its listing. */
  async readFile(repo: string, path: string, ref?: string): Promise<FileContent> {
    const { api } = bitbucketRepo(repo);
    const rev = encodeURIComponent(await this.revision(repo, ref));
    const encoded = encodePath(path);
    const base = `${api}/src/${rev}/${encoded}`;
    if (encoded) {
      const meta = await this.call<{ type?: string; size?: number }>("GET", `${base}?format=meta`);
      if (meta.type === "commit_file") {
        if ((meta.size ?? 0) > FILE_MAX_BYTES) return { text: `(file too large to read through the API: ${meta.size} bytes)`, truncated: true };
        const text = await (await this.send("GET", base, { accept: "*/*" })).text();
        if (text.includes("\u0000")) return { text: `(binary file, ${meta.size ?? text.length} bytes)`, truncated: false };
        return cap(text);
      }
      if (meta.type !== "commit_directory") return { text: `(${meta.type ?? "unknown entry"}: not a file or directory)`, truncated: false };
    }
    const entries = await this.collect<{ path: string; type?: string; size?: number }>(`${base}${encoded ? "/" : ""}?pagelen=100`, 3);
    const lines = entries.map((e) => (e.type === "commit_directory" ? `${e.path}/` : `${e.path}${e.size !== undefined ? ` (${e.size} bytes)` : ""}`));
    return cap(lines.join("\n") || "(empty directory)");
  }

  /**
   * Code search (the workspace code search API, POST /workspaces/{ws}/codesearch);
   * with `repo`, only inside that repository, else in the account's
   * workspaces. At most 20 hits. Needs search turned on for the workspace.
   */
  async searchCode(query: string, repo?: string): Promise<CodeHit[]> {
    const target = repo ? bitbucketRepo(repo) : undefined;
    const workspaces = target ? [target.workspace.toLowerCase()] : await this.workspaces(3, "repository to search in");
    const results = await Promise.all(
      workspaces.map(async (ws) => {
        const data = await this.call<{
          matched_files?: { path?: string; url?: string; version?: string }[];
          repositories?: { ns?: string; name?: string }[];
        }>("POST", `/workspaces/${encodeURIComponent(ws)}/codesearch`, {
          query: { search_term: query.slice(0, 1024), ...(target ? { filters: { attribute: "repository", eq: target.slug.toLowerCase() } } : {}) },
          config: { max_results: MAX_ITEMS },
        });
        const onlyRepo = data.repositories?.length === 1 && data.repositories[0]?.ns && data.repositories[0]?.name ? `${data.repositories[0].ns}/${data.repositories[0].name}` : undefined;
        return (data.matched_files ?? []).flatMap((f) => {
          if (!f.path) return [];
          const fromUrl = f.url ? (repoFromInput(f.url) ?? f.url.match(/\/repositories\/([^/]+\/[^/]+)\//)?.[1]) : undefined;
          const found = target?.id ?? (fromUrl ? (fromUrl.startsWith("bitbucket:") ? fromUrl : repoId("bitbucket", fromUrl)) : onlyRepo ? repoId("bitbucket", onlyRepo) : undefined);
          if (!found || !BITBUCKET_REPO_RE.test(found)) return [];
          const web = f.url?.startsWith(`${BITBUCKET_WEB}/`) ? f.url : `${BITBUCKET_WEB}/${repoPath(found)}/src/${f.version ?? "HEAD"}/${f.path}`;
          return [{ repo: found, path: f.path, url: web }];
        });
      }),
    );
    return results.flat().slice(0, MAX_ITEMS);
  }
}

/** The useful part of a Bitbucket error body ({"error": {"message", "detail"}}), at most 300 characters. */
function errorDetail(text: string): string {
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown; detail?: unknown } };
    const message = typeof data.error?.message === "string" ? data.error.message : "";
    const detail = typeof data.error?.detail === "string" ? data.error.detail : "";
    const joined = [message, detail].filter(Boolean).join(": ");
    if (joined) return joined.slice(0, 300);
  } catch {
    // Not JSON: the text itself.
  }
  return text.slice(0, 300);
}
