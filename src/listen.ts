import type { SlackMessageEvent } from "./pointer-types.js";

/**
 * Where Pointer listens, and the small in-memory machinery that keeps a
 * conversation in order. Pure: no Slack calls here.
 */

export type RespondDecision = "yes" | "no" | "if-pointer-in-thread";

/** Subtypes that are still a person talking; everything else (edits, joins, bot posts) is ignored. */
const HUMAN_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

export const isDm = (e: SlackMessageEvent): boolean => e.channel_type === "im";

const isThreadReply = (e: SlackMessageEvent): boolean => Boolean(e.thread_ts && e.thread_ts !== e.ts);

export function isExplicitMention(e: SlackMessageEvent, botUserId: string | undefined): boolean {
  if (e.type === "app_mention") return true;
  if (!botUserId || !e.text) return false;
  return e.text.includes(`<@${botUserId}>`) || e.text.includes(`<@${botUserId}|`);
}

/** Spec §1 rules 1–4. "if-pointer-in-thread" needs a Slack lookup, so the caller decides. */
export function shouldRespond(
  e: SlackMessageEvent,
  opts: { botUserId?: string; pointerChannels: string[] },
): RespondDecision {
  if (e.type !== "message" && e.type !== "app_mention") return "no";
  if (!e.channel || !e.ts || !e.user || e.bot_id || e.user === opts.botUserId) return "no";
  if (e.subtype && !HUMAN_SUBTYPES.has(e.subtype)) return "no";
  if (isDm(e) || isExplicitMention(e, opts.botUserId) || opts.pointerChannels.includes(e.channel)) return "yes";
  if (isThreadReply(e)) return "if-pointer-in-thread";
  return "no";
}

/** A mention in a channel arrives as both `app_mention` and `message`, with different event ids. */
export const dedupeKey = (e: SlackMessageEvent): string => `${e.channel}:${e.ts}`;

/** One queue per thread; a DM's top level is one conversation; each top-level channel message starts its own thread. */
export function queueKey(e: SlackMessageEvent): string {
  if (isThreadReply(e)) return `${e.channel}:${e.thread_ts}`;
  if (isDm(e)) return `${e.channel}`;
  return `${e.channel}:${e.ts}`;
}

/** Chat replies: threaded in channels, flat in DMs unless the DM message is itself in a thread. */
export const replyThreadTs = (e: SlackMessageEvent): string | undefined => (isDm(e) ? e.thread_ts : (e.thread_ts ?? e.ts));

/** Repo-task progress always lives in a thread: the existing one, or one on this message. */
export const taskThreadTs = (e: SlackMessageEvent): string => (e.thread_ts ?? e.ts)!;

/** Runs jobs one at a time per key. A failing job never blocks the next; idle keys are dropped. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.tails.size;
  }
}

/** At most `max` jobs at once; the rest wait in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter so late arrivals cannot jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** A bounded set that forgets its oldest entries. */
export class RecentSet {
  private readonly items = new Set<string>();

  constructor(private readonly max = 5000) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  add(key: string): void {
    this.items.delete(key);
    this.items.add(key);
    while (this.items.size > this.max) this.items.delete(this.items.values().next().value!);
  }

  clear(): void {
    this.items.clear();
  }
}
