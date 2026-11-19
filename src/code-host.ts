/**
 * What a repo task needs from a code host (GitHub, GitLab, Bitbucket): clone
 * and push credentials, pull/merge requests, their checks and feedback,
 * preview deployments, and the read-only calls Pointer's tools make.
 *
 * Every method takes the repository id as stored (see repo-id.ts: "owner/repo",
 * "gitlab:group/project", "bitbucket:workspace/repo"); each client strips its
 * own prefix. The shapes are the GitHub client's (github.ts), which every
 * host maps its own API onto, so the worker, ci.ts and preview.ts stay host
 * agnostic. Ids that are not numbers on a host (Bitbucket pipeline steps) go
 * in CheckInfo.ref.
 */
import type {
  Annotation,
  CheckInfo,
  CodeHit,
  CommitInfo,
  DeploymentInfo,
  DeploymentStatusInfo,
  FileContent,
  IssueComment,
  IssueInfo,
  ItemState,
  PrFeedback,
  PrRef,
  PullDetail,
  PullInfo,
  RepoInfo,
  StatusInfo,
} from "./github.js";
import type { CodeHostKind } from "./repo-id.js";

export type { CodeHostKind };

/** Who a token belongs to. */
export interface HostViewer {
  id: number | string;
  login: string;
  /** A display name, when the host has one. */
  name?: string;
  /** The address commits are authored with, when the host gives one. */
  email?: string;
}

/** The read-only calls behind Pointer's code tools (github_*, gitlab_*, bitbucket_*). */
export interface CodeHostReader {
  listRepos(owner?: string): Promise<RepoInfo[]>;
  recentCommits(repo: string, opts?: { branch?: string; limit?: number }): Promise<CommitInfo[]>;
  listPulls(repo: string, opts?: { state?: ItemState; limit?: number }): Promise<PullInfo[]>;
  listIssues(repo: string, opts?: { state?: ItemState; limit?: number }): Promise<IssueInfo[]>;
  readFile(repo: string, path: string, ref?: string): Promise<FileContent>;
  searchCode(query: string, repo?: string): Promise<CodeHit[]>;
}

export interface CodeHost extends CodeHostReader {
  readonly kind: CodeHostKind;

  // ---------- git ----------
  /** The HTTPS clone URL, without credentials. */
  cloneUrl(repo: string): string;
  /**
   * `git` arguments that authenticate clone, fetch and push to this host
   * without writing the token into .git/config, e.g.
   * ["-c", "http.https://github.com/.extraheader=Authorization: Basic …"].
   */
  gitAuthArgs(): string[];
  /** Every form of the credential that could appear in output (token, header, Basic value), for redaction. */
  secrets(): string[];
  viewer(): Promise<HostViewer>;
  /** Who the task's commits are authored by, so the host (and Vercel…) attribute them to the token's account. */
  commitIdentity(pointerName: string, viewer: HostViewer | undefined): { name: string; email: string };
  defaultBranch(repo: string): Promise<string>;

  // ---------- pull / merge requests ----------
  findOpenPr(repo: string, branch: string): Promise<PrRef | null>;
  createPr(repo: string, opts: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PrRef>;
  commentOnPr(repo: string, number: number, body: string): Promise<void>;
  updatePr(repo: string, number: number, patch: { title?: string; body?: string }): Promise<void>;
  /** A draft becomes ready for review. */
  markReady(repo: string, pr: PrRef): Promise<void>;
  getPull(repo: string, number: number): Promise<PullDetail>;
  /** Reviews, inline comments and conversation comments, oldest first; the platform's own (BOT_MARKER) included. */
  prFeedback(repo: string, number: number): Promise<PrFeedback[]>;
  /** The conversation comments of a pull request (previews posted by bots, e.g. Vercel's). */
  issueComments(repo: string, number: number): Promise<IssueComment[]>;
  /** The pull request's web URL from its number (for messages when a payload has none). */
  prWebUrl(repo: string, number: number): string;

  // ---------- checks ----------
  /** CI jobs (GitHub check runs, GitLab pipeline jobs, Bitbucket pipeline steps) and commit statuses on a commit. */
  checksFor(repo: string, sha: string): Promise<{ checks: CheckInfo[]; statuses: StatusInfo[] }>;
  /** File and line annotations of a failed check; [] where the host has none. */
  checkAnnotations(repo: string, check: CheckInfo): Promise<Annotation[]>;
  /** The log of a failed CI job, or undefined when the check has no log on this host (an external app's check). */
  jobLog(repo: string, check: CheckInfo): Promise<string | undefined>;

  // ---------- preview deployments ----------
  /** Deployments of a commit (GitHub deployments, GitLab environments); [] where the host has none. */
  deploymentsFor(repo: string, sha: string): Promise<DeploymentInfo[]>;
  deploymentStatuses(repo: string, deploymentId: number): Promise<DeploymentStatusInfo[]>;
}

/** Thrown by the placeholder clients until a host's client is written. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
