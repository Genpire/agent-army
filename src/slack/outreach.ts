import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../chat/pointer-types.js";
import type { Config, ConfigRepo } from "../core/config.js";
import { formatRunTime } from "../routines/cron.js";
import type { InboxItem } from "./inbox.js";
import { isPersonMessage, isThreadReply } from "./listen.js";
import { type RawMessage, pointerPostKind, pointerPostMetadata, slackErrorCode, tsAfter, tsDate } from "./slack.js";

/**
 * Messages Pointer sends for the owner, and what people answer it.
 *
 * When the owner asks Pointer, in their own conversation with it (the console
 * or their DM with Pointer: ownerConversation in user-account.ts), to message
 * someone and Pointer sends it as itself (slack_send_message, not as "me"),
 * the message is an outreach, kept in the owner's encrypted inbox (inbox.ts):
 * where it went, to whom, what it said. A message sent as the owner is not:
 * answers to it reach their own account, so their inbox, already. A post in a
 * channel is one only where the owner is a member. The message itself says
 * that replies are passed on to the owner (slack-tools.ts).
 *
 * Only answers to an outreach are passed to the owner:
 * - in Pointer's DM with the person it wrote to, at the DM's top level: their
 *   first message after it, within 7 days, and what they add within 30
 *   minutes of their last answer (each answer starts those 30 minutes again),
 *   as long as the outreach is still what the DM is about. Anything else
 *   Pointer posts there after it (a message sent at someone else's request, a
 *   routine's report: every post but its own chat replies, told apart by the
 *   posts' metadata) ends that (outreachStillCurrent). After that their
 *   messages to Pointer are their own conversation again (never passed on),
 *   until another outreach to them. A reply in another thread of the DM never
 *   answers it;
 * - in the outreach's own thread (replies to a channel post, or to the DM
 *   message in its thread): every reply within 7 days, from anyone.
 * Never the owner's own messages, Pointer's, or another bot's; at most 20 per
 * outreach. An answer edited or deleted is changed or removed with it, in a
 * notice still waiting too. Everything is tied to the owner's account being
 * connected with "Read what reaches me" on (listen): outreaches and answers
 * are kept in their inbox, and turning it off deletes them with it.
 *
 * Each answer is an item of the owner's inbox (where "to_pointer"), listed by
 * slack_my_inbox under the outreach it answers; with notifyAnswers on, Pointer
 * also DMs the owner: one message per outreach per burst (about a minute)
 * with every answer that came in (AnswerNotifier). That DM is marked as
 * outside content (its metadata): a reply after it in the owner's DM starts
 * as if it had read the inbox (pointer.ts).
 */

export const OUTREACH_LIMITS = {
  /** Characters of what Pointer sent, as kept. */
  text: 500,
  items: 1_000,
  /** Kept as long as the inbox keeps the answers (INBOX_LIMITS.days): an outreach and its answers go together. */
  days: 14,
  /** Open for answers this long after it was sent. */
  openDays: 7,
  /** In the DM, what the person adds within this time after an answer is part of it. */
  followUpMinutes: 30,
  /** Answers kept per outreach: a busy thread stops there. */
  answers: 20,
  /** Answers kept in all, apart from what reached the owner's own account: they never push it out. */
  allAnswers: 2_000,
} as const;

const DAY_MS = 24 * 60 * 60_000;
const OPEN_MS = OUTREACH_LIMITS.openDays * DAY_MS;
const FOLLOW_UP_MS = OUTREACH_LIMITS.followUpMinutes * 60_000;

/** A message Pointer sent as itself for the owner. */
export interface Outreach {
  /** `channel:ts` of the message. */
  id: string;
  /** Where it was posted: Pointer's DM with the person (D…), or a channel. */
  channel: string;
  ts: string;
  /** "dm": Pointer's DM with one person; "channel": a post in a channel. */
  where: "dm" | "channel";
  /** The person written to (their user id), the channel's id, or a DM's id when only that was given. */
  recipient: string;
  /** Their name, "#channel", or the id when Slack gave no name. */
  recipientName: string;
  /** Who asked, as the message's own line names them ("Sent by Pointer at …'s request"): the owner. */
  requester: string;
  /** What Pointer sent, redacted and clipped. */
  text: string;
}

/** A message that may answer an outreach. */
export interface AnswerCandidate {
  channel: string;
  ts: string;
  threadTs?: string;
  userId: string;
}

/** A person's new message, not the owner's, Pointer's or a bot's (nor an edit or a join); else undefined. Pure. */
export function answerCandidate(e: SlackMessageEvent, ownerId: string, botUserId: string | undefined): AnswerCandidate | undefined {
  if (!isPersonMessage(e) || e.user === ownerId || e.user === botUserId) return undefined;
  return { channel: e.channel, ts: e.ts, userId: e.user, ...(isThreadReply(e) ? { threadTs: e.thread_ts! } : {}) };
}

/** Still open for answers at `now`: sent in the last 7 days. */
export const outreachOpen = (o: Pick<Outreach, "ts">, now: Date): boolean => now.getTime() - tsDate(o.ts).getTime() <= OPEN_MS;

/** The outreach a message answers, and by which rule. */
export interface AnswerMatch {
  outreach: Outreach;
  /**
   * "thread": a reply in the outreach's own thread. "dm": a top-level message
   * in Pointer's DM with the person, an answer only while the outreach is
   * still what the DM is about (outreachStillCurrent, from `since` on).
   */
  rule: "thread" | "dm";
  /** The outreach's ts, or the last answer to it before this message. */
  since: string;
}

/**
 * The outreach a message may answer (see the file's comment), and how, or
 * undefined. By the DM rule it answers only if Pointer posted nothing else
 * in the DM since (outreachStillCurrent, which asks Slack). `answers` are the
 * inbox's items: the ones that answer an outreach say so (outreachId). Pure:
 * the same message gives the same outreach before and after it is kept,
 * since only earlier answers count.
 */
export function matchAnswer(
  m: AnswerCandidate,
  outreach: readonly Outreach[],
  answers: readonly Pick<InboxItem, "ts" | "outreachId">[],
): AnswerMatch | undefined {
  const sinceMs = (from: string) => tsDate(m.ts).getTime() - tsDate(from).getTime();
  const open = (o: Outreach) => tsAfter(m.ts, o.ts) && sinceMs(o.ts) <= OPEN_MS;
  if (m.threadTs) {
    // A reply in a thread answers only the outreach that thread is on: another thread of the DM is another conversation.
    const inThread = outreach.find((o) => o.channel === m.channel && o.ts === m.threadTs);
    return inThread && open(inThread) ? { outreach: inThread, rule: "thread", since: inThread.ts } : undefined;
  }
  // Pointer's DM with the person, at its top level: the latest outreach there decides.
  let latest: Outreach | undefined;
  for (const o of outreach) {
    if (o.where !== "dm" || o.channel !== m.channel || !open(o)) continue;
    // Sent to a person: only they answer (a DM given only by its id has no one else in it either).
    if (o.recipient !== o.channel && o.recipient !== m.userId) continue;
    if (!latest || tsAfter(o.ts, latest.ts)) latest = o;
  }
  if (!latest) return undefined;
  let last: string | undefined;
  for (const a of answers) {
    if (a.outreachId === latest.id && tsAfter(m.ts, a.ts) && (!last || tsAfter(a.ts, last))) last = a.ts;
  }
  if (last && sinceMs(last) > FOLLOW_UP_MS) return undefined;
  return { outreach: latest, rule: "dm", since: last ?? latest.ts };
}

/** The outreach a message may answer (matchAnswer), without how. Pure. */
export function answeredOutreach(
  m: AnswerCandidate,
  outreach: readonly Outreach[],
  answers: readonly Pick<InboxItem, "ts" | "outreachId">[],
): Outreach | undefined {
  return matchAnswer(m, outreach, answers)?.outreach;
}

/** The call the check below makes with the bot's token: a WebClient, or a fake in tests. */
export interface HistoryClient {
  conversations: Pick<WebClient["conversations"], "history">;
}

/** Posts read between an outreach (or its last answer) and a message; more than this and the message answers it not. */
const BETWEEN_MAX = 100;

/**
 * Whether a DM outreach is still what the DM is about when `m` arrives:
 * Pointer posted nothing at the DM's top level after `match.since` but its own
 * chat replies (their metadata says so: slack.ts). Anything else it posted
 * there (a message sent at someone else's request, a routine's report, a post
 * with no metadata) means `m` answers that, not the outreach. Read with the
 * bot's token; false when Slack could not say: nothing is passed on then.
 * Logged without any text.
 */
export async function outreachStillCurrent(
  client: HistoryClient,
  match: Pick<AnswerMatch, "since">,
  m: Pick<AnswerCandidate, "channel" | "ts">,
  botUserId: string | undefined,
): Promise<boolean> {
  try {
    const res = await client.conversations.history({
      channel: m.channel,
      oldest: match.since,
      latest: m.ts,
      inclusive: false,
      limit: BETWEEN_MAX,
      include_all_metadata: true,
    });
    if (res.has_more) return false;
    const posts = (res.messages ?? []) as RawMessage[];
    const between = posts.filter((p) => p.ts && tsAfter(p.ts, match.since) && tsAfter(m.ts, p.ts));
    const pointers = (p: RawMessage) => Boolean(p.bot_id) || (botUserId !== undefined && p.user === botUserId);
    return !between.some((p) => pointers(p) && pointerPostKind(p) !== "reply");
  } catch (err) {
    const code = slackErrorCode(err);
    console.warn(`[slack] could not tell whether a message answers one sent for the owner: ${code ? code.slice(0, 60) : err instanceof Error ? err.name : "unknown error"}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Telling the owner

/** Characters of the quotes in a notice: short, the rest is in the inbox. */
const QUOTE = { sent: 100, answer: 160 } as const;
/** Answers listed in one notice; the rest are counted. */
const MAX_NOTICE_ANSWERS = 10;
/** A burst: answers to one outreach collected before one notice. */
const BURST_MS = 60_000;
/** Bursts waiting at once; beyond, the oldest is sent at once. */
const MAX_BURSTS = 200;
/** Edits and deletions remembered for answers still on their way to a notice. */
const REVISION_TTL_MS = 10 * 60_000;
const MAX_REVISIONS = 1_000;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
/** Text other people wrote, as plain text in mrkdwn: no links, mentions or formatting of its own. */
const plain = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quote = (text: string, max: number) => plain(clip(oneLine(text), max)) || "(no text)";

/** "Sam Lee", "Sam Lee and Rita Oz", "Sam Lee, Rita Oz and Dan". */
function names(list: string[]): string {
  const unique = [...new Set(list)];
  return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

/**
 * The DM to the owner: who answered which message Pointer sent for them (a
 * short quote), each answer quoted short, and the thread's link for a channel
 * post. What people wrote is plain text here: it can neither link nor mention.
 */
export function answerNotice(o: Outreach, answers: Pick<InboxItem, "ts" | "userName" | "text">[], timeZone: string, link?: string): string {
  const who = plain(names(answers.map((a) => a.userName)));
  const sent = formatRunTime(tsDate(o.ts), timeZone);
  const head =
    o.where === "dm"
      ? `*${who}* answered the message I sent for you (${sent}):`
      : `*${who}* replied to the post I made for you in ${plain(o.recipientName)} (${sent}):`;
  const shown = answers.slice(-MAX_NOTICE_ANSWERS);
  const lines = [head, `> ${quote(o.text, QUOTE.sent)}`];
  const earlier = answers.length - shown.length;
  if (earlier > 0) lines.push(`_${earlier} earlier ${earlier === 1 ? "answer is" : "answers are"} in your Slack inbox._`);
  for (const a of shown) lines.push(`• *${plain(a.userName)}*, ${formatRunTime(tsDate(a.ts), timeZone)}: ${quote(a.text, QUOTE.answer)}`);
  if (link) lines.push(`<${link}|Open the thread>`);
  return lines.join("\n");
}

/** The calls a notice makes with the bot's token: a WebClient, or a fake in tests. */
export interface AnswerNoticeClient {
  chat: Pick<WebClient["chat"], "postMessage" | "getPermalink">;
}

export interface AnswerNotifierOptions {
  configRepo: Pick<ConfigRepo, "load">;
  slack: (token: string) => AnswerNoticeClient;
  /** How long answers to one outreach are collected before the notice; about a minute by default. */
  burstMs?: number;
  now?: () => number;
}

/** An answer edited (`text`: how it reads now, as the inbox keeps it) or deleted. */
export interface AnswerRevision {
  /** The answer's id (`channel:ts`). */
  id: string;
  deleted: boolean;
  text?: string;
}

interface Burst {
  ownerId: string;
  outreach: Outreach;
  answers: InboxItem[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tells the owner right away when someone answers an outreach: one DM from
 * Pointer per outreach per burst, with every answer that came in, as it reads
 * when the notice goes (an answer deleted meanwhile is left out). Checked
 * again when it is sent: nothing goes out once notifyAnswers or listening is
 * off, the account is disconnected, or another account replaced it; clear()
 * (the inbox was emptied) drops what waits. The DM is marked as outside
 * content. Never throws; a failure is logged without any text.
 */
export class AnswerNotifier {
  private readonly bursts = new Map<string, Burst>();
  /** Edits and deletions seen lately, by answer id: an answer that reaches add() after its own edit still uses it. */
  private readonly revisions = new Map<string, AnswerRevision & { until: number }>();
  private readonly burstMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: AnswerNotifierOptions) {
    this.burstMs = opts.burstMs ?? BURST_MS;
    this.now = opts.now ?? Date.now;
  }

  /** An answer was kept: the owner hears of it at the end of its burst, when they want to. */
  add(config: Config, outreach: Outreach, answer: InboxItem): void {
    const user = config.slack.user;
    if (!user?.listen || !user.notifyAnswers) return;
    const revised = this.revisionOf(answer.id);
    if (revised?.deleted) return;
    const item = revised?.text !== undefined ? { ...answer, text: revised.text } : answer;
    const key = `${user.userId}|${outreach.id}`;
    const burst = this.bursts.get(key);
    if (burst) {
      burst.answers.push(item);
      return;
    }
    if (this.bursts.size >= MAX_BURSTS) void this.send(this.bursts.keys().next().value!);
    const timer = setTimeout(() => void this.send(key), this.burstMs);
    timer.unref?.();
    this.bursts.set(key, { ownerId: user.userId, outreach, answers: [item], timer });
  }

  /** An answer was edited or deleted: a notice still waiting uses the new text, or leaves it out (and goes nowhere when nothing is left). */
  revise(revision: AnswerRevision): void {
    this.revisions.delete(revision.id);
    this.revisions.set(revision.id, { ...revision, until: this.now() + REVISION_TTL_MS });
    for (const oldest of this.revisions.keys()) {
      if (this.revisions.size <= MAX_REVISIONS) break;
      this.revisions.delete(oldest);
    }
    for (const [key, burst] of this.bursts) {
      const i = burst.answers.findIndex((a) => a.id === revision.id);
      if (i < 0) continue;
      if (revision.deleted) burst.answers.splice(i, 1);
      else if (revision.text !== undefined) burst.answers[i] = { ...burst.answers[i]!, text: revision.text };
      if (burst.answers.length) continue;
      clearTimeout(burst.timer);
      this.bursts.delete(key);
    }
  }

  /** Drops every notice still waiting: the owner's inbox was emptied (listening off, disconnected, another account). */
  clear(): void {
    for (const burst of this.bursts.values()) clearTimeout(burst.timer);
    this.bursts.clear();
    this.revisions.clear();
  }

  /** Sends what is still collected now (the server is stopping). */
  async flush(): Promise<void> {
    await Promise.all([...this.bursts.keys()].map((key) => this.send(key)));
  }

  private revisionOf(id: string): AnswerRevision | undefined {
    const hit = this.revisions.get(id);
    if (!hit) return undefined;
    if (hit.until > this.now()) return hit;
    this.revisions.delete(id);
    return undefined;
  }

  private async send(key: string): Promise<void> {
    const burst = this.bursts.get(key);
    if (!burst) return;
    this.bursts.delete(key);
    clearTimeout(burst.timer);
    try {
      const config = await this.opts.configRepo.load();
      const user = config.slack.user;
      const token = config.slack.botToken;
      if (!token || user?.userId !== burst.ownerId || !user.listen || !user.notifyAnswers) return;
      const client = this.opts.slack(token);
      const answers = [...burst.answers].sort((a, b) => (tsAfter(a.ts, b.ts) ? 1 : tsAfter(b.ts, a.ts) ? -1 : 0));
      // A link only to a channel's thread: the owner cannot open Pointer's DM with someone else.
      const link = burst.outreach.where === "channel" ? await threadLink(client, burst.outreach) : undefined;
      await client.chat.postMessage({
        channel: burst.ownerId,
        text: answerNotice(burst.outreach, answers, config.timezone, link),
        // What other people wrote: a reply after this in the owner's DM starts as if it had read their inbox.
        metadata: pointerPostMetadata("outside", "answer_notice", "inbox"),
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (err) {
      // Slack's error code or the error's kind: never a message that could carry what people wrote.
      const code = slackErrorCode(err);
      console.error(`[slack] could not tell the owner of an answer: ${code ? code.slice(0, 60) : err instanceof Error ? err.name : "unknown error"}`);
    }
  }
}

async function threadLink(client: AnswerNoticeClient, o: Outreach): Promise<string | undefined> {
  try {
    return (await client.chat.getPermalink({ channel: o.channel, message_ts: o.ts })).permalink || undefined;
  } catch {
    return undefined;
  }
}
