/**
 * GitLab webhook deliveries (POST /gitlab/webhook, see routes/gitlab.ts) as
 * what webhook.ts acts on for every code host: a ReviewDecision for feedback
 * addressed to the team, a ClosedPr when a merge request is merged or closed.
 * The rules are reviewTrigger's: only people with write access (Developer or
 * above) steer the team; bots, the token's own user and the platform's own
 * comments (BOT_MARKER) are ignored; nothing from the payload is logged.
 *
 * - Note Hook on a merge request: a new comment that starts with /pointer or
 *   mentions @pointer → "asked".
 * - Merge Request Hook: a reviewer submits a review that requests changes →
 *   "changes_requested", or one that comments → "commented" (GitLab reports
 *   both as an update of the reviewer's state); merged or closed → ClosedPr.
 *
 * GitLab's payloads do not carry the author's role, so it is looked up with
 * the connection's token (members API) once the cheaper checks pass.
 */
import { z } from "zod";
import { configSecrets, makeRedactor } from "../../tasks/worker.js";
import { safeEqual } from "../../core/crypto.js";
import { BOT_MARKER, WRITE_ASSOCIATIONS } from "../github/github.js";
import { GitLab, associationForAccess, isGitLabBot, mergeRequestWebUrl } from "./gitlab.js";
import { REPO_ID_MAX, parseRepo, repoId } from "../code-hosts/repo-id.js";
import {
  type ClosedPr,
  EXCERPT_MAX_CHARS,
  type ReviewDecision,
  type ReviewKind,
  type WebhookDeps,
  addressesPointer,
  handlePrClosed,
  handleReviewDecision,
} from "../code-hosts/webhook.js";

/** X-Gitlab-Event values handled; GitLab sends others too when more events are ticked. */
export const GITLAB_NOTE_EVENT = "Note Hook";
export const GITLAB_MR_EVENT = "Merge Request Hook";
export const GITLAB_EVENTS = new Set([GITLAB_NOTE_EVENT, GITLAB_MR_EVENT]);

/** `X-Gitlab-Token`: the secret token set on the webhook, sent as is; compared in constant time. */
export function verifyGitlabToken(secret: string | undefined, header: string | undefined): boolean {
  if (!secret || !header || header.length > 500) return false;
  return safeEqual(header, secret);
}

/** GitLab usernames; also safe inside Slack text (no "<", ">", "|" or spaces). */
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

const Body = z
  .string()
  .max(1_000_000)
  .nullish()
  .transform((s) => s ?? "");
const User = z.object({ id: z.number().int().positive(), username: z.string().max(255), bot: z.boolean().nullish() });
const Project = z.object({ path_with_namespace: z.string().max(REPO_ID_MAX) });
const Iid = z.number().int().positive();

const NotePayload = z.object({
  object_kind: z.literal("note"),
  user: User,
  project: Project,
  object_attributes: z.object({
    note: Body,
    noteable_type: z.string().max(40),
    system: z.boolean().nullish(),
    /** "create" or "update"; absent on older instances, which send only new comments. */
    action: z.string().max(20).nullish(),
  }),
  merge_request: z.object({ iid: Iid, state: z.string().max(20) }).nullish(),
});

const Reviewer = z.object({ id: z.number().int(), state: z.string().max(40).nullish() });
/** `changes.reviewers`: [previous, current] (an object with those keys is read too). */
const ReviewerChange = z.union([
  z.tuple([z.array(Reviewer), z.array(Reviewer)]).transform(([previous, current]) => ({ previous, current })),
  z.object({ previous: z.array(Reviewer).nullish(), current: z.array(Reviewer).nullish() }).transform((c) => ({
    previous: c.previous ?? [],
    current: c.current ?? [],
  })),
]);

const MergeRequestPayload = z.object({
  object_kind: z.literal("merge_request"),
  user: User.nullish(),
  project: Project,
  object_attributes: z.object({ iid: Iid, state: z.string().max(20), action: z.string().max(40).nullish() }),
  changes: z.object({ reviewers: ReviewerChange.nullish() }).nullish(),
});

/** The stored id of the payload's project, when it is a valid one. */
function repoOf(payload: unknown): string | undefined {
  const parsed = z.object({ project: Project }).safeParse(payload);
  return parsed.success ? parseRepo(repoId("gitlab", parsed.data.project.path_with_namespace))?.id : undefined;
}

const excerptOf = (body: string): string => {
  const text = body.replace(/\r\n/g, "\n").trim();
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…` : text;
};

/** Reviewer states that start a follow-up, by the kind of feedback they are. */
const REVIEW_STATES: Record<string, ReviewKind> = { requested_changes: "changes_requested", reviewed: "commented" };

export interface GitlabTriggerOptions {
  pointerName: string;
  /** The instance's address: merge request links are built from it, never taken from the payload. */
  baseUrl: string;
  /** The connection token's user: what it writes is the platform's own. */
  selfUserId?: number;
  /** A user's access level on the project; undefined when not a member. */
  accessLevel: (repo: string, userId: number) => Promise<number | undefined>;
}

/**
 * Whether a delivery should start a follow-up. The allow list, the merge
 * request's thread and Slack are checked by handleReviewDecision. Never throws.
 */
export async function gitlabReviewDecision(event: string, payload: unknown, opts: GitlabTriggerOptions): Promise<ReviewDecision> {
  const repo = repoOf(payload);
  const no = (reason: string): ReviewDecision => ({ start: false, reason, ...(repo ? { repo } : {}) });
  if (!repo) return no("unexpected payload");

  let fields: { kind: ReviewKind; iid: number; state: string; user: z.infer<typeof User>; body: string };
  if (event === GITLAB_NOTE_EVENT) {
    const parsed = NotePayload.safeParse(payload);
    if (!parsed.success) return no("unexpected payload");
    const p = parsed.data;
    const note = p.object_attributes;
    if (note.noteable_type !== "MergeRequest" || !p.merge_request) return no("comment not on a merge request");
    if (note.action && note.action !== "create") return no("comment not created");
    if (note.system) return no("system note");
    if (!addressesPointer(note.note, opts.pointerName)) return no("comment does not address Pointer");
    fields = { kind: "asked", iid: p.merge_request.iid, state: p.merge_request.state, user: p.user, body: note.note };
  } else if (event === GITLAB_MR_EVENT) {
    const parsed = MergeRequestPayload.safeParse(payload);
    if (!parsed.success) return no("unexpected payload");
    const p = parsed.data;
    if (p.object_attributes.action !== "update") return no("merge request not reviewed");
    const user = p.user;
    const change = p.changes?.reviewers;
    if (!user || !change) return no("merge request not reviewed");
    // The person who submitted the review is the one whose reviewer state changed to a review outcome.
    const before = change.previous.find((r) => r.id === user.id)?.state ?? "";
    const now = change.current.find((r) => r.id === user.id)?.state ?? "";
    const kind = REVIEW_STATES[now];
    if (!kind || before === now) return no(now === "approved" ? "review approved" : "merge request not reviewed");
    fields = { kind, iid: p.object_attributes.iid, state: p.object_attributes.state, user, body: "" };
  } else {
    return no("event not handled");
  }

  if (isGitLabBot(fields.user)) return no("sent by a bot");
  if (opts.selfUserId !== undefined && fields.user.id === opts.selfUserId) return no("posted by the platform");
  if (fields.body.includes(BOT_MARKER)) return no("posted by the platform");
  if (fields.state !== "opened") return no("merge request is not open");
  if (!USERNAME_RE.test(fields.user.username)) return no("unexpected payload");
  let level: number | undefined;
  try {
    level = await opts.accessLevel(repo, fields.user.id);
  } catch {
    return no("could not check the author's access");
  }
  if (!WRITE_ASSOCIATIONS.has(associationForAccess(level))) return no("author has no write access");
  return {
    start: true,
    repo,
    prNumber: fields.iid,
    prUrl: mergeRequestWebUrl(opts.baseUrl, repo, fields.iid),
    login: fields.user.username,
    kind: fields.kind,
    excerpt: excerptOf(fields.body),
  };
}

/** A merge request merged or closed, from a Merge Request Hook; undefined for anything else. */
export function gitlabClosedPr(event: string, payload: unknown, baseUrl: string): ClosedPr | undefined {
  if (event !== GITLAB_MR_EVENT) return undefined;
  const parsed = MergeRequestPayload.safeParse(payload);
  const repo = repoOf(payload);
  if (!parsed.success || !repo) return undefined;
  const { action, iid } = parsed.data.object_attributes;
  if (action !== "merge" && action !== "close") return undefined;
  return { repo, prNumber: iid, url: mergeRequestWebUrl(baseUrl, repo, iid), merged: action === "merge" };
}

export type GitlabDeliveryDeps = WebhookDeps & {
  /** Test seam: the GitLab client for the connection (members lookups). */
  gitlab?: (opts: { token: string; baseUrl: string }) => Pick<GitLab, "memberAccess">;
};

/**
 * Handles one verified delivery: a merge or close tells the ticket, feedback
 * addressed to the team starts a follow-up (handleReviewDecision). Never
 * throws; outcomes are logged by webhook.ts without payload content.
 */
export async function handleGitlabDelivery(event: string, payload: unknown, deps: GitlabDeliveryDeps): Promise<void> {
  const label = event === GITLAB_NOTE_EVENT ? "gitlab note" : "gitlab merge_request";
  let redact = (text: string) => text;
  try {
    const config = await deps.configRepo.load();
    redact = makeRedactor(configSecrets(config));
    const { token, baseUrl, userId } = config.gitlab;
    if (!token) return console.log(`[gitlab] ${label}: ignored: GitLab not connected`);
    const closed = gitlabClosedPr(event, payload, baseUrl);
    if (closed) return await handlePrClosed(label, closed, deps);
    const client = deps.gitlab ? deps.gitlab({ token, baseUrl }) : new GitLab({ token, baseUrl });
    const decision = await gitlabReviewDecision(event, payload, {
      pointerName: config.team.pointer.name,
      baseUrl,
      ...(userId !== undefined ? { selfUserId: userId } : {}),
      accessLevel: (repo, id) => client.memberAccess(repo, id),
    });
    await handleReviewDecision(label, decision, deps);
  } catch (err) {
    console.error(`[gitlab] ${label} failed:`, redact(err instanceof Error ? err.message : String(err)));
  }
}
