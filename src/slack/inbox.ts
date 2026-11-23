import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../chat/pointer-types.js";
import type { Config } from "../core/config.js";
import { decrypt, encrypt } from "../core/crypto.js";
import type { Store } from "../core/store.js";
import { isPersonMessage, isThreadReply, mentionsUser } from "./listen.js";
import { OUTREACH_LIMITS, type Outreach, answerCandidate, answeredOutreach, outreachOpen } from "./outreach.js";
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
 * conversations (its bot's events), never from the owner's token.
 *
 * One encrypted blob in the store; texts redacted and clipped; kept 14 days,
 * at most 3 000 items (and 1 000 outreaches), and what is older is dropped on
 * every read and write.
 * Changes are collected for about a second and written at once, one write at
 * a time in this process (Cloud Storage takes about one write per second per
 * object); a change that changes nothing writes nothing. clear() empties it
 * and drops every change that started before it.
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

/** The Slack calls the inbox makes. */
export interface InboxSlackClient {
  users: Pick<WebClient["users"], "info">;
  conversations: Pick<WebClient["conversations"], "info">;
}

export interface CaptureContext {
  config: Config;
  /**
   * A Slack client for a token, made only for a message the inbox may keep:
   * the bot's names people; the owner's says which conversations are theirs.
   */
  client: (token: string) => InboxSlackClient;
  redact: (text: string) => string;
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
  done: () => void;
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
    const facts = await this.facts(ctx.client(account.token), ownerId, signal.channel, account.userName, generation);
    // Not theirs (or Slack could not say), or their DM with Pointer: never an inbox item.
    if (!facts?.member || (facts.dmWith && facts.dmWith === ctx.config.slack.botUserId)) return;

    const bot = ctx.client(botToken);
    const sender = await userName(bot, e.user!);
    const text = await this.readable(e, bot, ctx.redact);
    await this.write(ownerId, generation, (data) => {
      const id = `${signal.channel}:${signal.ts}`;
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
   * Keeps a message Pointer sent for the owner as itself (outreach.ts), so
   * that answers to it reach the owner; resolves once it is written. The
   * caller has checked that the request is the owner's and that listening is on.
   */
  async recordOutreach(ownerId: string, outreach: Outreach): Promise<void> {
    const kept: Outreach = { ...outreach, text: clip(outreach.text, OUTREACH_LIMITS.text) };
    await this.write(
      ownerId,
      this.generation,
      (data) => {
        if (data.outreach.some((o) => o.id === kept.id)) return false;
        data.outreach.push(kept);
        return true;
      },
      [],
      false,
    );
  }

  /** The outreach this message answers (outreach.ts), without keeping anything: for Pointer's reply to it. */
  async answering(e: SlackMessageEvent, config: Config): Promise<Outreach | undefined> {
    const account = config.slack.user;
    if (!account?.listen) return undefined;
    const m = answerCandidate(e, account.userId, config.slack.botUserId);
    if (!m) return undefined;
    const data = this.last?.ownerId === account.userId ? this.last : await this.read(account.userId);
    return data.outreach.length ? answeredOutreach(m, data.outreach, data.items) : undefined;
  }

  /**
   * Keeps a message that answers an outreach (outreach.ts) as an item of the
   * owner's inbox, and resolves with it once written; undefined when it
   * answers none (most messages: decided from what is in memory, without
   * asking Slack). A clear() while it runs drops it.
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
    if (!data.outreach.length || !answeredOutreach(m, data.outreach, data.items)) return undefined;

    const bot = ctx.client(botToken);
    const [sender, text] = await Promise.all([userName(bot, m.userId), this.readable(e, bot, ctx.redact)]);
    const out: { captured?: CapturedAnswer } = {};
    await this.write(
      ownerId,
      generation,
      (d) => {
        // Decided again on what is stored now: another answer may have been kept since.
        const outreach = answeredOutreach(m, d.outreach, d.items);
        const id = `${m.channel}:${m.ts}`;
        if (!outreach || d.items.some((i) => i.id === id)) return false;
        const item: InboxItem = {
          id,
          channel: m.channel,
          channelName: outreach.where === "dm" ? sender : outreach.recipientName,
          where: "to_pointer",
          ts: m.ts,
          ...(m.threadTs ? { threadTs: m.threadTs } : {}),
          userId: m.userId,
          userName: sender,
          mentioned: false,
          followed: false,
          text,
          outreachId: outreach.id,
        };
        d.items.push(item);
        out.captured = { outreach, item };
        return true;
      },
      [],
      false,
    );
    return out.captured;
  }

  /**
   * Forgets everything (the account was disconnected or replaced, or reading
   * what reaches the owner was turned off): the stored inbox, what is queued,
   * what is known of the owner's conversations, and every change that started
   * before (a capture still waiting on Slack writes nothing).
   */
  clear(): Promise<void> {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const p of this.pending.splice(0)) this.settle(p);
    this.marking.clear();
    this.known.clear();
    this.last = undefined;
    return this.exclusive(async () => {
      await this.store.put(INBOX_KEY, "");
      this.last = undefined;
    });
  }

  /** Writes the queued changes now, in one write; a write that fails twice is logged with how many were lost. Never throws. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.exclusive(async () => {
      const batch = this.pending.splice(0);
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
        if (!changed && !starts) return;
        if (starts) data.startedAt = this.now().toISOString();
        this.prune(data);
        await this.put(data);
      } catch (err) {
        console.error(`[slack] inbox write failed, ${batch.length} change${batch.length === 1 ? "" : "s"} not kept:`, writeError(err));
      } finally {
        for (const p of batch) this.settle(p);
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
   * is written or dropped. `marks`: threads the owner wrote in. `starts`:
   * something that reached the owner's own account (PendingChange.starts).
   */
  private write(ownerId: string, generation: number, change: (data: InboxData) => boolean, marks: string[] = [], starts = true): Promise<void> {
    if (generation !== this.generation) return Promise.resolve();
    const held = marks.map((key) => markKey(ownerId, key));
    for (const key of held) this.marking.set(key, (this.marking.get(key) ?? 0) + 1);
    return new Promise((done) => {
      this.pending.push({ ownerId, generation, change, starts, marks: held, done });
      this.timer ??= setTimeout(() => void this.flush(), this.batchMs);
    });
  }

  /** A queued change is written or dropped: its marks go, its capture resolves. */
  private settle(p: PendingChange): void {
    for (const key of p.marks) {
      const left = (this.marking.get(key) ?? 0) - 1;
      if (left > 0) this.marking.set(key, left);
      else this.marking.delete(key);
    }
    p.done();
  }

  /**
   * Drops what is older than 14 days, then the oldest beyond the limits; an
   * answer goes with the outreach it answers. True when it dropped anything.
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
    data.items = data.items
      .filter((i) => recent(i.ts) && (!i.outreachId || kept.has(i.outreachId)))
      .sort((a, b) => byTs(a.ts, b.ts))
      .slice(-INBOX_LIMITS.items);
    const answered = Object.entries(data.answered)
      .filter(([, ts]) => recent(ts))
      .sort(([, a], [, b]) => byTs(a, b))
      .slice(-INBOX_LIMITS.answered);
    data.answered = Object.fromEntries(answered);
    return size() < before;
  }

  /** Whether the owner is in a conversation and what to call it, from their own token (cached per owner). */
  private async facts(client: InboxSlackClient, ownerId: string, channel: string, ownerHandle: string, generation: number): Promise<Facts | undefined> {
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
