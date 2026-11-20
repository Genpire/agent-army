/**
 * Bitbucket webhook: a change request, or a pull request comment addressed to
 * Pointer, on a pull request the team opened starts a follow-up task, the
 * same one GitHub reviews start (webhook.ts handleReviewDecision); a merged
 * or declined pull request tells its monday.com ticket (handlePrClosed).
 *
 * Deliveries are signed with the webhook's secret (X-Hub-Signature:
 * "sha256=" + the hex HMAC-SHA256 of the raw body). Payloads carry no author
 * association, so write access is read from Bitbucket (Bitbucket.association).
 * Nothing from the payload is logged except the event, the repository and
 * the outcome; its text is data for the team, never instructions here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Bitbucket, type BitbucketAccount } from "./bitbucket.js";
import type { Config } from "../../core/config.js";
import { BOT_MARKER, WRITE_ASSOCIATIONS } from "../github/github.js";
import { BITBUCKET_REPO_RE, repoId, repoPath } from "../code-hosts/repo-id.js";
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
import { configSecrets, makeRedactor } from "../../worker.js";

/** The events the review webhook subscribes to (Bitbucket's trigger names: Comment created, Changes request created, Merged, Declined). */
export const BITBUCKET_WEBHOOK_EVENTS = [
  "pullrequest:comment_created",
  "pullrequest:changes_request_created",
  "pullrequest:fulfilled",
  "pullrequest:rejected",
] as const;

/** X-Event-Key values look like "pullrequest:comment_created" or "repo:push". */
export const BITBUCKET_EVENT_RE = /^[a-z_]{1,40}:[a-z_]{1,60}$/;

/**
 * `X-Hub-Signature`: "<method>=<hex digest>" of the raw body keyed with the
 * secret, compared in constant time. Bitbucket signs with sha256 today; any
 * other method is refused rather than guessed.
 */
export function verifyBitbucketSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Safe inside a Slack link: no whitespace, "|", "<" or ">". */
const URL_RE = /^https:\/\/bitbucket\.org\/[^\s|<>]{1,480}$/;

const Account = z
  .object({
    type: z.string().max(40).optional(),
    uuid: z.string().max(64).optional(),
    account_id: z.string().max(128).optional(),
    nickname: z.string().max(200).optional(),
    display_name: z.string().max(200).optional(),
  })
  .nullish();
const Repository = z.object({ full_name: z.string().max(250) });
const PullRequest = z.object({
  id: z.number().int().positive(),
  state: z.string().max(20),
  links: z.object({ html: z.object({ href: z.string().max(500).optional() }).nullish() }).nullish(),
});
const Body = z
  .string()
  .nullish()
  .transform((s) => s ?? "");

const CommentPayload = z.object({
  actor: Account,
  repository: Repository,
  pullrequest: PullRequest,
  comment: z.object({
    content: z.object({ raw: Body }).nullish(),
    user: Account,
    deleted: z.boolean().optional(),
    pending: z.boolean().optional(),
  }),
});

const ChangesRequestPayload = z.object({
  actor: Account,
  repository: Repository,
  pullrequest: PullRequest,
  changes_request: z.object({ user: Account }).nullish(),
});

const ClosedPayload = z.object({ repository: Repository, pullrequest: PullRequest });

/** "bitbucket:workspace/repo" from a payload's repository.full_name, or undefined when it is not a valid one. */
function repoOf(payload: unknown): string | undefined {
  const parsed = z.object({ repository: Repository }).safeParse(payload);
  if (!parsed.success) return undefined;
  const id = repoId("bitbucket", parsed.data.repository.full_name);
  return BITBUCKET_REPO_RE.test(id) ? id : undefined;
}

/** The pull request's web address from the payload when it is a safe bitbucket.org one, else built from the repository. */
function prUrlOf(repo: string, pr: z.infer<typeof PullRequest>): string {
  const href = pr.links?.html?.href;
  return href && URL_RE.test(href) ? href : `https://bitbucket.org/${repoPath(repo)}/pull-requests/${pr.id}`;
}

/**
 * How the person is named in Slack and in the team's instruction: their
 * nickname (else display name) with only letters, digits, spaces and
 * "_ . ' -", at most 40 characters. Undefined when nothing is left.
 */
export function displayLogin(a: BitbucketAccount | null | undefined): string | undefined {
  const raw = a?.nickname || a?.display_name || "";
  const name = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return name || undefined;
}

const excerptOf = (body: string): string => {
  const text = body.replace(/\r\n/g, "\n").trim();
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…` : text;
};

export interface BitbucketTriggerOptions {
  pointerName: string;
  /** The connected token's account: its own comments never start anything. */
  ownAccountId?: string;
  /** The person's access to the repository, in GitHub's author_association words (Bitbucket.association). */
  association: (repo: string, account: BitbucketAccount | null | undefined) => Promise<string>;
}

/**
 * Whether a delivery should start a follow-up. Starts for a change request,
 * and for a new pull request comment (inline or not) addressed to Pointer,
 * by a person with write access, on an open pull request. Bots (app users),
 * the token's own account and the platform's own comments are ignored. Write
 * access is asked last, so most deliveries cost no API call. The allow list
 * and the pull request's thread are checked by handleReviewDecision.
 */
export async function bitbucketReviewTrigger(event: string, payload: unknown, opts: BitbucketTriggerOptions): Promise<ReviewDecision> {
  const repo = repoOf(payload);
  const no = (reason: string): ReviewDecision => ({ start: false, reason, ...(repo ? { repo } : {}) });

  let fields: { kind: ReviewKind; pr: z.infer<typeof PullRequest>; body: string; author: BitbucketAccount | null | undefined; actor: BitbucketAccount | null | undefined };
  if (event === "pullrequest:comment_created") {
    const parsed = CommentPayload.safeParse(payload);
    if (!parsed.success || !repo) return no("unexpected payload");
    const p = parsed.data;
    if (p.comment.deleted || p.comment.pending) return no("comment deleted or not published");
    const body = p.comment.content?.raw ?? "";
    if (!addressesPointer(body, opts.pointerName)) return no("comment does not address Pointer");
    fields = { kind: "asked", pr: p.pullrequest, body, author: p.comment.user ?? p.actor, actor: p.actor };
  } else if (event === "pullrequest:changes_request_created") {
    const parsed = ChangesRequestPayload.safeParse(payload);
    if (!parsed.success || !repo) return no("unexpected payload");
    const p = parsed.data;
    fields = { kind: "changes_requested", pr: p.pullrequest, body: "", author: p.changes_request?.user ?? p.actor, actor: p.actor };
  } else {
    return no("event not handled");
  }

  const isBot = (a: BitbucketAccount | null | undefined) => Boolean(a?.type && a.type !== "user");
  if (isBot(fields.author) || isBot(fields.actor)) return no("sent by a bot");
  if (opts.ownAccountId && fields.author?.account_id === opts.ownAccountId) return no("posted by the platform");
  if (fields.body.includes(BOT_MARKER)) return no("posted by the platform");
  if (fields.pr.state.toUpperCase() !== "OPEN") return no("pull request is not open");
  const login = displayLogin(fields.author);
  if (!login) return no("unexpected payload");
  const association = await opts.association(repo, fields.author);
  if (!WRITE_ASSOCIATIONS.has(association.toUpperCase())) return no("author has no write access");
  return {
    start: true,
    repo,
    prNumber: fields.pr.id,
    prUrl: prUrlOf(repo, fields.pr),
    login,
    kind: fields.kind,
    excerpt: excerptOf(fields.body),
  };
}

/** A merged (pullrequest:fulfilled) or declined (pullrequest:rejected) pull request, or undefined for anything else. */
export function bitbucketClosedPr(event: string, payload: unknown): ClosedPr | undefined {
  if (event !== "pullrequest:fulfilled" && event !== "pullrequest:rejected") return undefined;
  const parsed = ClosedPayload.safeParse(payload);
  const repo = repoOf(payload);
  if (!parsed.success || !repo) return undefined;
  const pr = parsed.data.pullrequest;
  return { repo, prNumber: pr.id, url: prUrlOf(repo, pr), merged: event === "pullrequest:fulfilled" };
}

export interface BitbucketWebhookDeps extends WebhookDeps {
  /** Test seam: the Bitbucket client write access is read with. */
  bitbucket?: (config: Config) => Pick<Bitbucket, "association">;
}

/**
 * Handles one verified delivery: a follow-up for feedback, the ticket for a
 * closed pull request. Never throws; every outcome is logged without payload
 * content.
 */
export async function handleBitbucketWebhook(event: string, payload: unknown, deps: BitbucketWebhookDeps): Promise<void> {
  let redact = (text: string) => text;
  try {
    if (event === "pullrequest:fulfilled" || event === "pullrequest:rejected") {
      const closed = bitbucketClosedPr(event, payload);
      if (!closed) return log(event, repoOf(payload), "ignored: unexpected payload");
      return await handlePrClosed(event, closed, deps);
    }
    const config = await deps.configRepo.load();
    redact = makeRedactor(configSecrets(config));
    const { token, email, accountId } = config.bitbucket;
    if (!token) return log(event, repoOf(payload), "ignored: Bitbucket not connected");
    const client = deps.bitbucket?.(config) ?? new Bitbucket({ token, ...(email ? { email } : {}) });
    const decision = await bitbucketReviewTrigger(event, payload, {
      pointerName: config.team.pointer.name,
      ...(accountId ? { ownAccountId: accountId } : {}),
      association: (repo, account) => client.association(repo, account),
    });
    await handleReviewDecision(event, decision, deps);
  } catch (err) {
    console.error(`[bitbucket] ${event} failed:`, redact(err instanceof Error ? err.message : String(err)));
  }
}

function log(event: string, where: string | undefined, outcome: string): void {
  console.log(`[bitbucket] ${event}${where ? ` ${where}` : ""}: ${outcome}`);
}
