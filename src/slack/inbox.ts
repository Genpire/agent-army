import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../chat/pointer-types.js";
import type { Config } from "../core/config.js";
import { decrypt, encrypt } from "../core/crypto.js";
import type { Store } from "../core/store.js";
import { isPersonMessage, isThreadReply, mentionsUser, messageRevision } from "./listen.js";
import {
  type AnswerCandidate,
  type AnswerMatch,
  type AnswerRevision,
  OUTREACH_LIMITS,
  type Outreach,
  answerCandidate,
  matchAnswer,
  outreachOpen,
  outreachStillCurrent,
} from "./outreach.js";
import { slackErrorCode, slackFileRefs, tsAfter, tsDate, userName } from "./slack.js";

/**
 * The owner's Slack inbox: what reaches their own Slack account
 * (config.slack.user with listen on), kept so Pointer can say what needs
 * their reply or action (slack_my_inbox in inbox-tools.ts, and the attention
 * report routine).
 *
 * Kept, from other people only (never the owner, Pointer's bot or other
 * bots): DMs and group DMs to the owner, channel messages that mention them,
 * and replies in threads they started or replied in. The owner's own messages
 * are not kept: each one marks its conversation or thread as answered at that
 * time, which closes what came before it there, and makes the thread one to
 * follow.
 *
 * Each conversation is checked with the owner's own token: one they are not
 * in (Pointer's DMs with colleagues, a channel they are not a member of)
 * never reaches their inbox, and neither does their DM with Pointer (those
 * are requests to Pointer).
 *
 * Also the messages Pointer sent for the owner as itself, and the answers
 * people gave it (outreach.ts): an answer is an item with where "to_pointer",
 * kept with the outreach it answers. Those come from Pointer's own
 * conversations (its bot's events), never from the owner's token. A message
 * edited or deleted is changed or removed here with it (revise).
 *
 * One encrypted blob in the store; texts redacted and clipped; kept 14 days,
 * at most 3 000 items that reached the owner's account and, apart from them,
 * 2 000 answers (20 per outreach) and 1 000 outreaches; what is older is
 * dropped on every read and write.
 * Changes are collected for about a second and written at once, one write at
 * a time in this process (Cloud Storage takes about one write per second per
 * object); a change that changes nothing writes nothing. clear() empties it,
 * drops every change that started before it, and tells its listeners (the
 * notices still waiting go too: server.ts).
 */

export const INBOX_LIMITS = {
  /** Characters of one message's text. */
  text: 1_500,
  items: 3_000,
  /** Conversations and threads whose last answer is remembered. */
  answered: 10_000,
  days: 14,
} as const;

const INBOX_KEY = "slack/inbox.enc";
const DAY_MS = 24 * 60 * 60_000;
/** Mentions of people in one message resolved to names; the rest stay as ids. */
const MAX_NAMED_MENTIONS = 10;
/**
 * The owner's channel memberships are looked up again after this; a DM or
 * group DM Slack describes never changes. A miss or a refusal is looked up
 * again sooner: they may join, or reconnect with the scope that was missing.
 */
const MEMBER_TTL_MS = 10 * 60_000;
const OUTSIDE_TTL_MS = 60_000;
const MAX_KNOWN_CONVERSATIONS = 5_000;
/** Changes collected before one write. */
const WRITE_BATCH_MS = 1_000;
/** Edits and deletions remembered for messages still on their way to a write. */
const REVISION_TTL_MS = 10 * 60_000;
const MAX_REVISIONS = 1_000;
/** Answers to "is the outreach still what the DM is about?" remembered per message. */
const MAX_KNOWN_CHECKS = 500;

/** An edit (`message`: how it reads now) or a deletion, remembered until `until`. */
interface Revision {
  deleted: boolean;
  message?: SlackMessageEvent;
  until: number;
}

/**
 * Where a message reached the owner; "to_pointer": an answer to a message
 * Pointer sent for them (in Pointer's DM with that person, or the thread of
 * its post).
 */
export type InboxWhere = "dm" | "group_dm" | "channel" | "to_pointer";

export interface InboxItem {
  /** `channel:ts` */
  id: string;
  channel: string;
  /** "#ops", the other person's name for a DM, "group DM (alice, bob)" for a group DM. */
  channelName: string;
  where: InboxWhere;
  ts: string;
  /** The thread it is in; absent for a top-level message. */
  threadTs?: string;
  userId: string;
  userName: string;
  /** It mentions the owner. */
  mentioned: boolean;
  /** A reply in a thread the owner started or replied in. */
  followed: boolean;
  text: string;
  /** where "to_pointer": the outreach it answers (Outreach.id). */
  outreachId?: string;
}

/** An item as listed: whether the owner answered after it, and whether it waits for them. */
export interface InboxEntry extends InboxItem {
  answered: boolean;
  /** A DM, a mention or a reply in their thread: it waits for their reply. The rest is FYI. */
  waiting: boolean;
}

interface InboxData {
  version: 1;
  /** Whose inbox: a new account starts an empty one. */
  ownerId: string;
  /** When the inbox started (the first message it saw from the account). */
  startedAt: string;
  items: InboxItem[];
  /**
   * The owner's last message per conversation (`channel`, top level: it
   * answers DMs and group DMs) and per thread (`channel:threadTs`, a message
   * they started counting as theirs there), as a Slack ts. A thread key here
   * is a thread they follow.
   */
  answered: Record<string, string>;
  /** Messages Pointer sent for the owner as itself (outreach.ts); absent in an inbox from before them. */
  outreach: Outreach[];
}

/** A message Pointer sent for the owner, as listed: whether it is still open for answers, and its answers. */
export interface OutreachEntry extends Outreach {
  /** Sent in the last 7 days: an answer still reaches the owner. */
  open: boolean;
  /** Oldest first. */
  answers: InboxItem[];
}

/** An answer to an outreach, just kept. */
export interface CapturedAnswer {
  outreach: Outreach;
  item: InboxItem;
}

/**
 * The Slack calls the inbox makes: the bot's token names people and reads
 * Pointer's DM between an outreach and its answer (outreachStillCurrent); the
 * owner's says which conversations are theirs.
 */
export interface InboxSlackClient {
  users: Pick<WebClient["users"], "info">;
  conversations: Pick<WebClient["conversations"], "info" | "history">;
}

/** What the owner's token is asked about a conversation. */
export type OwnerConversationsClient = { conversations: Pick<WebClient["conversations"], "info"> };

export interface CaptureContext {
  config: Config;
  /**
   * A Slack client for a token, made only for a message the inbox may keep:
   * the bot's names people; the owner's says which conversations are theirs.
   */
  client: (token: string) => InboxSlackClient;
  redact: (text: string) => string;
}

/**
 * Whose inbox an outreach goes to, as it was when the request that sends it
 * started (outreachTicket): it is kept only if nothing cleared the inbox
 * since, and the account is still that owner's, listening.
 */
export interface OutreachTicket {
  ownerId: string;
  generation: number;
}

/** What recordOutreach checks against now: the current config, and a client for the owner's token. */
export interface OutreachContext {
  config: Config;
  ownerClient: (token: string) => OwnerConversationsClient;
}

/** What one Slack event is for the inbox. */
export type InboxSignal =
  | { kind: "skip" }
  | { kind: "owner"; channel: string; ts: string; threadTs?: string }
  | { kind: "message"; channel: string; ts: string; threadTs?: string; where: InboxWhere; mentioned: boolean };

const WHERE: Record<string, InboxWhere> = { im: "dm", mpim: "group_dm", channel: "channel", group: "channel" };

/**
 * Sorts an event: the owner's own message, a message from someone else that
 * may be for the owner, or nothing for the inbox (edits, joins, bots,
 * Pointer, `app_mention` duplicates). Pure.
 */
export function inboxSignal(e: SlackMessageEvent, ownerId: string, botUserId: string | undefined): InboxSignal {
  if (!isPersonMessage(e) || e.user === botUserId) return { kind: "skip" };
  const threadTs = isThreadReply(e) ? e.thread_ts : undefined;
  const at = { channel: e.channel, ts: e.ts, ...(threadTs ? { threadTs } : {}) };
  if (e.user === ownerId) return { kind: "owner", ...at };
  const where = WHERE[e.channel_type ?? ""];
  if (!where) return { kind: "skip" };
  return { kind: "message", ...at, where, mentioned: mentionsUser(e.text, ownerId) };
}

export { tsAfter, tsDate };

/** Oldest first, by Slack ts. */
const byTs = (a: string, b: string) => (tsAfter(a, b) ? 1 : tsAfter(b, a) ? -1 : 0);

const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`;
const markKey = (ownerId: string, key: string) => `${ownerId}|${key}`;
/** Answers kept for an outreach. */
const answerCount = (data: Pick<InboxData, "items">, outreachId: string) => data.items.reduce((n, i) => n + Number(i.outreachId === outreachId), 0);

/**
 * The owner answered after this item: in its thread (a top-level message's
 * own thread included), or, in a DM or group DM, at the top level. A post of
 * theirs elsewhere in a channel answers nothing there.
 */
export function isAnswered(item: Pick<InboxItem, "channel" | "ts" | "threadTs" | "where">, answered: Record<string, string>): boolean {
  const later = (key: string) => {
    const at = answered[key];
    return at !== undefined && tsAfter(at, item.ts);
  };
  if (item.threadTs) return later(threadKey(item.channel, item.threadTs));
  return later(threadKey(item.channel, item.ts)) || (item.where !== "channel" && later(item.channel));
}

/** What the owner's token says about a conversation; undefined when Slack could not say. */
interface Facts {
  /** The owner is in it. */
  member: boolean;
  name: string;
  /** For a DM: the other person. */
  dmWith?: string;
}

const OUTSIDE_ERRORS = new Set(["channel_not_found", "not_in_channel", "missing_scope", "method_not_supported_for_channel_type"]);

/** "mpdm-alice--bob--dana-1" → "group DM (alice, bob)", without the owner's handle when known. */
function groupDmName(name: string | undefined, ownerHandle: string): string {
  const handles = (name ?? "")
    .replace(/^mpdm-/, "")
    .replace(/-\d+$/, "")
    .split("--")
    .filter((h) => h && h !== ownerHandle);
  return handles.length ? `group DM (${handles.join(", ")})` : "group DM";
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** A change waiting for the next write. */
interface PendingChange {
  ownerId: string;
  /** clear() had run this many times when the change started. */
  generation: number;
  /** Returns false when it changes nothing. */
  change: (data: InboxData) => boolean;
  /**
   * It is something that reached the owner's own account: the first one
   * starts the inbox (startedAt). Pointer's outreaches and the answers to
   * them come from its own conversations, so they do not.
   */
  starts: boolean;
  /** The marks it holds in `marking`. */
  marks: string[];
  /** `kept`: it was applied and is stored (written, or nothing to write); false when dropped or the write failed. */
  done: (kept: boolean) => void;
}

/** Why a write failed, for the log: never the inbox's content. */
const writeError = (err: unknown): string =>
  err instanceof SyntaxError ? "the stored inbox could not be read" : (err instanceof Error ? err.message : String(err)).slice(0, 200);

export interface SlackInboxOptions {
  now?: () => Date;
  /** How long changes are collected before one write (tests use 0). */
  batchMs?: number;
}

export class SlackInbox {
  /** Serialises the blob's reads and writes so concurrent ones don't lose each other. */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * The last data read or written, for the quick checks before a write ("is
   * this a thread they follow?", "does this answer a message Pointer sent?").
   */
  private last: InboxData | undefined;
  /** Writes so far: a read that a write overtook does not replace `last` with older data. */
  private writes = 0;
  /** What the owner's token said about a conversation, per owner and conversation. */
  private readonly known = new Map<string, { facts: Facts; until: number }>();
  /** Bumped by clear(): a change that started before it is never written. */
  private generation = 0;
  private pending: PendingChange[] = [];
  /** Threads the owner wrote in (`owner|key`) whose mark waits for its write, counted. */
  private readonly marking = new Map<string, number>();
  /** Messages on their way to a write (`channel:ts`), counted: an edit or deletion that arrives meanwhile still finds them. */
  private readonly inFlight = new Map<string, number>();
  /**
   * Edits and deletions seen lately, by message id (`channel:ts`): an answer
   * whose capture was still on its way is kept as it reads now, or not at all.
   */
  private readonly revisions = new Map<string, { deleted: boolean; message?: SlackMessageEvent; until: number }>();
  /** outreachStillCurrent per outreach and message: a message's route and capture ask Slack once. */
  private readonly current = new Map<string, Promise<boolean>>();
  /** Told when clear() runs. */
  private readonly clearListeners: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => Date;
  private readonly batchMs: number;

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
    opts: SlackInboxOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.batchMs = opts.batchMs ?? WRITE_BATCH_MS;
  }

  /** Calls `listener` whenever clear() runs (the notices still waiting for the owner go with the inbox). */
  onClear(listener: () => void): void {
    this.clearListeners.push(listener);
  }

  /**
   * Keeps one Slack event when it is for the owner (see the file's comment),
   * and resolves once it is written. Slack may throw; the caller logs the
   * reason, never the text. A clear() while it runs drops it.
   */
  async capture(e: SlackMessageEvent, ctx: CaptureContext): Promise<void> {
    const generation = this.generation;
    const account = ctx.config.slack.user;
    if (!account?.listen) return;
    const ownerId = account.userId;
    const signal = inboxSignal(e, ownerId, ctx.config.slack.botUserId);
    if (signal.kind === "skip") return;

    if (signal.kind === "owner") {
      const keys = signal.threadTs ? [threadKey(signal.channel, signal.threadTs)] : [signal.channel, threadKey(signal.channel, signal.ts)];
      const mark = (data: InboxData) => {
        let changed = false;
        for (const key of keys) {
          const at = data.answered[key];
          if (at !== undefined && !tsAfter(signal.ts, at)) continue;
          data.answered[key] = signal.ts;
          changed = true;
        }
        return changed;
      };
      await this.write(ownerId, generation, mark, keys);
      return;
    }

    // A channel message is for the owner when it mentions them or replies in a thread they follow.
    const followedKey = signal.threadTs ? threadKey(signal.channel, signal.threadTs) : undefined;
    if (signal.where === "channel" && !signal.mentioned) {
      if (!followedKey) return;
      if (!this.marking.has(markKey(ownerId, followedKey))) {
        const data = this.last?.ownerId === ownerId ? this.last : await this.read(ownerId);
        if (data.answered[followedKey] === undefined) return;
      }
    }

    const botToken = ctx.config.slack.botToken;
    if (!botToken) return;
    const id = `${signal.channel}:${signal.ts}`;
    this.hold(id, 1);
    try {
      const facts = await this.facts(ctx.client(account.token), ownerId, signal.channel, account.userName, generation);
      // Not theirs (or Slack could not say), or their DM with Pointer: never an inbox item.
      if (!facts?.member || (facts.dmWith && facts.dmWith === ctx.config.slack.botUserId)) return;

      const bot = ctx.client(botToken);
      // Edited or deleted before it was kept: kept as it reads now, or not at all.
      const used = this.revisionOf(id);
      if (used?.deleted) return;
      const sender = await userName(bot, e.user!);
      const text = await this.readable(used?.message ?? e, bot, ctx.redact);
      const kept = await this.write(ownerId, generation, (data) => {
        if (data.items.some((i) => i.id === id)) return false;
        const followed = followedKey !== undefined && data.answered[followedKey] !== undefined;
        if (signal.where === "channel" && !signal.mentioned && !followed) return false;
        data.items.push({
          id,
          channel: signal.channel,
          channelName: signal.where === "dm" ? sender : facts.name,
          where: signal.where,
          ts: signal.ts,
          ...(signal.threadTs ? { threadTs: signal.threadTs } : {}),
          userId: e.user!,
          userName: sender,
          mentioned: signal.mentioned,
          followed,
          text,
        });
        return true;
      });
      if (kept) await this.reviseLate(ownerId, generation, id, used, bot, ctx.redact);
    } finally {
      this.hold(id, -1);
    }
  }

  /**
   * The items since `since` (oldest first), all or only those the owner has
   * not answered; and every kept outreach (newest first) with all its
   * answers, whatever `since` says. Writes what is queued first.
   */
  async list(opts: { since: Date; openOnly: boolean; ownerId: string }): Promise<{ startedAt?: string; entries: InboxEntry[]; outreach: OutreachEntry[] }> {
    await this.flush();
    const data = await this.exclusive(async () => {
      const stored = await this.read(opts.ownerId);
      // Retention holds while nothing new arrives too: what passed 14 days goes when read.
      if (this.prune(stored)) {
        await this.put(stored).catch((err) => console.error("[slack] inbox write failed, expired messages not removed yet:", writeError(err)));
      }
      return stored;
    });
    const from = opts.since.getTime();
    const entries = data.items
      .filter((i) => !i.outreachId && tsDate(i.ts).getTime() >= from)
      .map((i) => ({ ...i, answered: isAnswered(i, data.answered), waiting: i.where === "dm" || i.mentioned || i.followed }))
      .filter((i) => !opts.openOnly || !i.answered)
      .sort((a, b) => byTs(a.ts, b.ts));
    const answers = new Map<string, InboxItem[]>();
    for (const i of data.items) if (i.outreachId) answers.set(i.outreachId, [...(answers.get(i.outreachId) ?? []), i]);
    const now = this.now();
    const outreach = data.outreach
      .map((o) => ({ ...o, open: outreachOpen(o, now), answers: (answers.get(o.id) ?? []).sort((a, b) => byTs(a.ts, b.ts)) }))
      .sort((a, b) => byTs(b.ts, a.ts));
    return { ...(data.startedAt ? { startedAt: data.startedAt } : {}), entries, outreach };
  }

  /**
   * Taken when a request that may send a message for the owner starts
   * (slack-tools.ts): recordOutreach keeps nothing once the inbox was cleared
   * after it, or the account is no longer that owner's.
   */
  outreachTicket(ownerId: string): OutreachTicket {
    return { ownerId, generation: this.generation };
  }

  /**
   * Whether a message Pointer sends for the owner to this place would be kept
   * as an outreach, checked now: nothing cleared the inbox since the request
   * started, the account is still that owner's with listening on, and a
   * channel is one the owner is a member of (their own token says so; a DM,
   * D…, is Pointer's with someone). `channel` is absent for a DM to a person.
   * With the channel's name when Slack gave it. Never throws.
   */
  async outreachPlace(ticket: OutreachTicket, ctx: OutreachContext, channel: string | undefined): Promise<{ keep: boolean; name?: string }> {
    const account = this.outreachAccount(ticket, ctx.config);
    if (!account) return { keep: false };
    if (!channel || channel.startsWith("D")) return { keep: true };
    try {
      const facts = await this.facts(ctx.ownerClient(account.token), account.userId, channel, account.userName, ticket.generation);
      return facts?.member ? { keep: true, name: facts.name } : { keep: false };
    } catch {
      return { keep: false };
    }
  }

  /** The owner's account when an outreach taken with this ticket may still be kept. */
  private outreachAccount(ticket: OutreachTicket, config: Config): NonNullable<Config["slack"]["user"]> | undefined {
    const account = config.slack.user;
    if (ticket.generation !== this.generation || !config.slack.botToken) return undefined;
    return account?.listen && account.userId === ticket.ownerId ? account : undefined;
  }

  /**
   * Keeps a message Pointer sent for the owner as itself (outreach.ts), so
   * that answers to it reach the owner; resolves true once it is written.
   * Checked again here against `ctx` (outreachPlace): never after the inbox
   * was cleared since the request started (listening turned off, the account
   * disconnected or replaced), never to the owner themselves, and a channel
   * only where the owner is a member.
   */
  async recordOutreach(ticket: OutreachTicket, outreach: Outreach, ctx: OutreachContext): Promise<boolean> {
    if (outreach.recipient === ticket.ownerId) return false;
    const place = await this.outreachPlace(ticket, ctx, outreach.where === "channel" ? outreach.channel : undefined);
    if (!place.keep) return false;
    const kept: Outreach = { ...outreach, text: clip(outreach.text, OUTREACH_LIMITS.text) };
    return this.write(
      ticket.ownerId,
      ticket.generation,
      (data) => {
        if (data.outreach.some((o) => o.id === kept.id)) return false;
        data.outreach.push(kept);
        return true;
      },
      [],
      false,
    );
  }

  /**
   * The outreach this message answers (outreach.ts), without keeping
   * anything: for Pointer's reply to it. `bot` (the bot's token) reads
   * Pointer's DM when the DM rule decides (outreachStillCurrent).
   */
  async answering(e: SlackMessageEvent, config: Config, bot: InboxSlackClient): Promise<Outreach | undefined> {
    const account = config.slack.user;
    if (!account?.listen) return undefined;
    const m = answerCandidate(e, account.userId, config.slack.botUserId);
    if (!m) return undefined;
    const data = this.last?.ownerId === account.userId ? this.last : await this.read(account.userId);
    const match = data.outreach.length ? matchAnswer(m, data.outreach, data.items) : undefined;
    return match && (await this.stillCurrent(bot, match, m, config.slack.botUserId)) ? match.outreach : undefined;
  }

  /**
   * Keeps a message that answers an outreach (outreach.ts) as an item of the
   * owner's inbox, and resolves with it once written; undefined when it
   * answers none (most messages: decided from what is in memory, without
   * asking Slack), the outreach has its 20 answers, or it was deleted on the
   * way. An edit that came on the way is kept. A clear() while it runs drops it.
   */
  async captureAnswer(e: SlackMessageEvent, ctx: CaptureContext): Promise<CapturedAnswer | undefined> {
    const generation = this.generation;
    const account = ctx.config.slack.user;
    const botToken = ctx.config.slack.botToken;
    if (!account?.listen || !botToken) return undefined;
    const ownerId = account.userId;
    const m = answerCandidate(e, ownerId, ctx.config.slack.botUserId);
    if (!m) return undefined;
    const data = this.last?.ownerId === ownerId ? this.last : await this.read(ownerId);
    const match = data.outreach.length ? matchAnswer(m, data.outreach, data.items) : undefined;
    if (!match || answerCount(data, match.outreach.id) >= OUTREACH_LIMITS.answers) return undefined;

    const id = `${m.channel}:${m.ts}`;
    this.hold(id, 1);
    try {
      const bot = ctx.client(botToken);
      if (!(await this.stillCurrent(bot, match, m, ctx.config.slack.botUserId))) return undefined;
      // Edited or deleted before it was kept: kept as it reads now, or not at all.
      const used = this.revisionOf(id);
      if (used?.deleted) return undefined;
      const [sender, text] = await Promise.all([userName(bot, m.userId), this.readable(used?.message ?? e, bot, ctx.redact)]);
      const out: { captured?: CapturedAnswer } = {};
      await this.write(
        ownerId,
        generation,
        (d) => {
          // Decided again on what is stored now: another answer may have been kept since, or another outreach sent.
          const again = matchAnswer(m, d.outreach, d.items);
          if (again?.outreach.id !== match.outreach.id || d.items.some((i) => i.id === id)) return false;
          if (this.revisionOf(id)?.deleted || answerCount(d, match.outreach.id) >= OUTREACH_LIMITS.answers) return false;
          const item: InboxItem = {
            id,
            channel: m.channel,
            channelName: again.outreach.where === "dm" ? sender : again.outreach.recipientName,
            where: "to_pointer",
            ts: m.ts,
            ...(m.threadTs ? { threadTs: m.threadTs } : {}),
            userId: m.userId,
            userName: sender,
            mentioned: false,
            followed: false,
            text,
            outreachId: again.outreach.id,
          };
          d.items.push(item);
          out.captured = { outreach: again.outreach, item };
          return true;
        },
        [],
        false,
      );
      const captured = out.captured;
      if (!captured) return undefined;
      // An edit or deletion that came while it was written applies now.
      const late = await this.reviseLate(ownerId, generation, id, used, bot, ctx.redact);
      if (late?.deleted) return undefined;
      return late?.text !== undefined ? { ...captured, item: { ...captured.item, text: late.text } } : captured;
    } finally {
      this.hold(id, -1);
    }
  }

  /**
   * An edit or deletion (Slack's message_changed and message_deleted, read by
   * messageRevision): a kept message, an answer or what reached the owner, is
   * changed or removed with it, and an answer on its way to a write is kept as
   * it reads now, or not at all. Resolves with what a notice still waiting
   * should do (AnswerNotifier.revise): every deletion, and an edit of a kept
   * message with its new text; undefined for anything else. Never logs text.
   */
  async revise(e: SlackMessageEvent, ctx: CaptureContext): Promise<AnswerRevision | undefined> {
    const generation = this.generation;
    const account = ctx.config.slack.user;
    const botToken = ctx.config.slack.botToken;
    if (!account?.listen || !botToken) return undefined;
    const r = messageRevision(e);
    if (!r) return undefined;
    const id = `${r.channel}:${r.ts}`;
    const deleted = r.kind === "deleted";
    const revision = this.remember(id, deleted ? { deleted } : { deleted, message: r.message });
    const gone: AnswerRevision | undefined = deleted ? { id, deleted } : undefined;
    // On its way to a write: the capture applies it once written.
    if (this.inFlight.has(id)) return gone;
    const ownerId = account.userId;
    const data = this.last?.ownerId === ownerId ? this.last : await this.read(ownerId);
    const stored = data.items.find((i) => i.id === id);
    if (!stored || (r.kind === "edited" && r.user !== stored.userId)) return gone;
    const text = await this.applyRevision(ownerId, generation, id, revision, ctx.client(botToken), ctx.redact);
    return deleted ? gone : { id, deleted, ...(text !== undefined ? { text } : {}) };
  }

  /**
   * Forgets everything (the account was disconnected or replaced, or reading
   * what reaches the owner was turned off): the stored inbox, what is queued,
   * what is known of the owner's conversations, and every change that started
   * before (a capture still waiting on Slack writes nothing); then tells the
   * listeners (onClear).
   */
  clear(): Promise<void> {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const p of this.pending.splice(0)) this.settle(p, false);
    this.marking.clear();
    this.known.clear();
    this.revisions.clear();
    this.current.clear();
    this.last = undefined;
    for (const listener of this.clearListeners) {
      try {
        listener();
      } catch (err) {
        console.error("[slack] a listener of the inbox's clear failed:", writeError(err));
      }
    }
    return this.exclusive(async () => {
      await this.store.put(INBOX_KEY, "");
      this.last = undefined;
    });
  }

  /** A thread's reply answers; a DM message only while the outreach is still what the DM is about, asked of Slack once per message. */
  private stillCurrent(bot: InboxSlackClient, match: AnswerMatch, m: AnswerCandidate, botUserId: string | undefined): Promise<boolean> {
    if (match.rule === "thread") return Promise.resolve(true);
    const key = `${match.outreach.id}|${match.since}|${m.channel}:${m.ts}`;
    const hit = this.current.get(key);
    if (hit) return hit;
    const asked = outreachStillCurrent(bot, match, m, botUserId);
    this.current.set(key, asked);
    for (const oldest of this.current.keys()) {
      if (this.current.size <= MAX_KNOWN_CHECKS) break;
      this.current.delete(oldest);
    }
    return asked;
  }

  /** A capture of this message starts (+1) or ends (-1). */
  private hold(id: string, by: 1 | -1): void {
    const left = (this.inFlight.get(id) ?? 0) + by;
    if (left > 0) this.inFlight.set(id, left);
    else this.inFlight.delete(id);
  }

  /** Remembers an edit or deletion for a while (REVISION_TTL_MS); returns what it remembered. */
  private remember(id: string, r: { deleted: boolean; message?: SlackMessageEvent }): Revision {
    const revision: Revision = { ...r, until: this.now().getTime() + REVISION_TTL_MS };
    this.revisions.delete(id);
    this.revisions.set(id, revision);
    for (const oldest of this.revisions.keys()) {
      if (this.revisions.size <= MAX_REVISIONS) break;
      this.revisions.delete(oldest);
    }
    return revision;
  }

  private revisionOf(id: string): Revision | undefined {
    const hit = this.revisions.get(id);
    if (!hit) return undefined;
    if (hit.until > this.now().getTime()) return hit;
    this.revisions.delete(id);
    return undefined;
  }

  /** After a message was written: an edit or deletion newer than the one it was written with applies now. */
  private async reviseLate(
    ownerId: string,
    generation: number,
    id: string,
    used: Revision | undefined,
    bot: InboxSlackClient,
    redact: (text: string) => string,
  ): Promise<{ deleted: boolean; text?: string } | undefined> {
    const now = this.revisionOf(id);
    if (!now || now === used) return undefined;
    const text = await this.applyRevision(ownerId, generation, id, now, bot, redact);
    return { deleted: now.deleted, ...(text !== undefined ? { text } : {}) };
  }

  /** Removes a kept message, or gives it its edited text (only its author's edit); resolves with that text. */
  private async applyRevision(
    ownerId: string,
    generation: number,
    id: string,
    r: Pick<Revision, "deleted" | "message">,
    bot: InboxSlackClient,
    redact: (text: string) => string,
  ): Promise<string | undefined> {
    const edited = r.deleted ? undefined : r.message;
    const text = edited ? await this.readable(edited, bot, redact) : undefined;
    await this.write(
      ownerId,
      generation,
      (d) => {
        const i = d.items.findIndex((x) => x.id === id);
        if (i < 0) return false;
        if (r.deleted) return d.items.splice(i, 1).length > 0;
        const item = d.items[i]!;
        if (text === undefined || item.userId !== edited?.user || item.text === text) return false;
        d.items[i] = { ...item, text };
        return true;
      },
      [],
      false,
    );
    return text;
  }

  /** Writes the queued changes now, in one write; a write that fails twice is logged with how many were lost. Never throws. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.exclusive(async () => {
      const batch = this.pending.splice(0);
      /** The changes applied and stored. */
      const kept = new Set<PendingChange>();
      try {
        // Changes from before a clear() are dropped; so are another owner's (a new account starts empty).
        const current = batch.filter((p) => p.generation === this.generation);
        const ownerId = current.at(-1)?.ownerId;
        const changes = current.filter((p) => p.ownerId === ownerId);
        if (!ownerId || !changes.length) return;
        const data = await this.read(ownerId);
        let changed = false;
        for (const p of changes) changed = p.change(data) || changed;
        const starts = !data.startedAt && changes.some((p) => p.starts);
        if (changed || starts) {
          if (starts) data.startedAt = this.now().toISOString();
          this.prune(data);
          await this.put(data);
        }
        for (const p of changes) kept.add(p);
      } catch (err) {
        console.error(`[slack] inbox write failed, ${batch.length} change${batch.length === 1 ? "" : "s"} not kept:`, writeError(err));
      } finally {
        for (const p of batch) this.settle(p, kept.has(p));
      }
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The stored inbox when it is this owner's; an empty one otherwise. */
  private async read(ownerId: string): Promise<InboxData> {
    const generation = this.generation;
    const writes = this.writes;
    const blob = await this.store.get(INBOX_KEY);
    // The store has no delete: a cleared inbox is an empty blob.
    const stored = blob && blob.length > 0 ? (JSON.parse(decrypt(this.key, blob)) as InboxData) : undefined;
    const data: InboxData = stored?.ownerId === ownerId ? stored : { version: 1, ownerId, startedAt: "", items: [], answered: {}, outreach: [] };
    data.outreach ??= [];
    if (generation === this.generation && writes === this.writes) this.last = data;
    return data;
  }

  /** Writes the inbox; a failed write is tried once more after a pause, and logged without the content. */
  private async put(data: InboxData): Promise<void> {
    const blob = encrypt(this.key, JSON.stringify(data));
    try {
      await this.store.put(INBOX_KEY, blob);
    } catch (err) {
      console.warn("[slack] inbox write failed, trying once more:", writeError(err));
      await new Promise((resolve) => setTimeout(resolve, this.batchMs));
      await this.store.put(INBOX_KEY, blob);
    }
    this.writes++;
    this.last = data;
  }

  /**
   * Queues a change for the next write (in about a second); resolves once it
   * is written (true; also when it changed nothing) or dropped (false: a
   * clear() came first, another owner's change won, or the write failed).
   * `marks`: threads the owner wrote in. `starts`: something that reached the
   * owner's own account (PendingChange.starts).
   */
  private write(ownerId: string, generation: number, change: (data: InboxData) => boolean, marks: string[] = [], starts = true): Promise<boolean> {
    if (generation !== this.generation) return Promise.resolve(false);
    const held = marks.map((key) => markKey(ownerId, key));
    for (const key of held) this.marking.set(key, (this.marking.get(key) ?? 0) + 1);
    return new Promise((done) => {
      this.pending.push({ ownerId, generation, change, starts, marks: held, done });
      this.timer ??= setTimeout(() => void this.flush(), this.batchMs);
    });
  }

  /** A queued change is written or dropped: its marks go, its capture resolves. */
  private settle(p: PendingChange, kept: boolean): void {
    for (const key of p.marks) {
      const left = (this.marking.get(key) ?? 0) - 1;
      if (left > 0) this.marking.set(key, left);
      else this.marking.delete(key);
    }
    p.done(kept);
  }

  /**
   * Drops what is older than 14 days, then the oldest beyond the limits; an
   * answer goes with the outreach it answers. What reached the owner's own
   * account and the answers to Pointer's messages have limits of their own:
   * answers never push the owner's messages out. True when it dropped anything.
   */
  private prune(data: InboxData): boolean {
    const size = () => data.items.length + Object.keys(data.answered).length + data.outreach.length;
    const before = size();
    const cutoff = this.now().getTime() - INBOX_LIMITS.days * DAY_MS;
    const recent = (ts: string) => tsDate(ts).getTime() >= cutoff;
    const outreachCutoff = this.now().getTime() - OUTREACH_LIMITS.days * DAY_MS;
    data.outreach = data.outreach
      .filter((o) => tsDate(o.ts).getTime() >= outreachCutoff)
      .sort((a, b) => byTs(a.ts, b.ts))
      .slice(-OUTREACH_LIMITS.items);
    const kept = new Set(data.outreach.map((o) => o.id));
    const live = data.items.filter((i) => recent(i.ts) && (!i.outreachId || kept.has(i.outreachId))).sort((a, b) => byTs(a.ts, b.ts));
    data.items = [
      ...live.filter((i) => !i.outreachId).slice(-INBOX_LIMITS.items),
      ...live.filter((i) => i.outreachId).slice(-OUTREACH_LIMITS.allAnswers),
    ].sort((a, b) => byTs(a.ts, b.ts));
    const answered = Object.entries(data.answered)
      .filter(([, ts]) => recent(ts))
      .sort(([, a], [, b]) => byTs(a, b))
      .slice(-INBOX_LIMITS.answered);
    data.answered = Object.fromEntries(answered);
    return size() < before;
  }

  /** Whether the owner is in a conversation and what to call it, from their own token (cached per owner). */
  private async facts(client: OwnerConversationsClient, ownerId: string, channel: string, ownerHandle: string, generation: number): Promise<Facts | undefined> {
    const cacheKey = `${ownerId}:${channel}`;
    const hit = this.known.get(cacheKey);
    if (hit && hit.until > this.now().getTime()) return hit.facts;
    let facts: Facts;
    // Only what Slack described is known for good: a refusal may change with a reconnect.
    let forever = false;
    try {
      const { channel: info } = await client.conversations.info({ channel });
      if (info?.is_im) {
        // Slack only describes a DM to the people in it; `user` is the other one.
        const other = (info as { user?: unknown }).user;
        facts = { member: true, name: "DM", ...(typeof other === "string" ? { dmWith: other } : {}) };
        forever = true;
      } else if (info?.is_mpim) {
        facts = { member: true, name: groupDmName(info.name, ownerHandle) };
        forever = true;
      } else {
        facts = { member: Boolean(info?.is_member), name: info?.name ? `#${info.name}` : channel };
      }
    } catch (err) {
      const code = slackErrorCode(err);
      if (!code || !OUTSIDE_ERRORS.has(code)) return undefined;
      facts = { member: false, name: channel };
    }
    // Asked before a clear(): not remembered for whoever comes next.
    if (generation !== this.generation) return facts;
    this.known.delete(cacheKey);
    this.known.set(cacheKey, { facts, until: forever ? Number.POSITIVE_INFINITY : this.now().getTime() + (facts.member ? MEMBER_TTL_MS : OUTSIDE_TTL_MS) });
    for (const oldest of this.known.keys()) {
      if (this.known.size <= MAX_KNOWN_CONVERSATIONS) break;
      this.known.delete(oldest);
    }
    return facts;
  }

  /** The message as the owner would read it: names for mentions, links unwrapped, files listed; redacted and clipped. */
  private async readable(e: SlackMessageEvent, bot: InboxSlackClient, redact: (text: string) => string): Promise<string> {
    const raw = e.text ?? "";
    const ids = [...new Set([...raw.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))].slice(0, MAX_NAMED_MENTIONS);
    const names = new Map(await Promise.all(ids.map(async (id) => [id, await userName(bot, id)] as const)));
    let text = raw
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
      .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
      .replace(/<!([^|>]*)(?:\|([^>]*))?>/g, (_m, kind: string, label?: string) => label || `@${kind.split("^")[0]}`)
      .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) => (label && label !== url ? `${label} (${url})` : url))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
    const files = slackFileRefs(e.files).map((f) => (f.name || f.title || "file").replace(/[\r\n[\]]+/g, " ").slice(0, 80));
    if (files.length) text = `${text}${text ? "\n" : ""}[files: ${files.join(", ")}]`;
    return clip(redact(text), INBOX_LIMITS.text);
  }
}
