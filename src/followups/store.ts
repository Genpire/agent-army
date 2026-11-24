/**
 * The owner's follow-ups (types.ts), kept in the store: one encrypted blob
 * with the items, the next number, and what the reminders remember
 * (reminders.ts: the day of the last morning brief, the meeting reminders
 * sent, the console conversation they are kept in).
 *
 * - Items are numbered `n` from 1, never reused, also after an item is
 *   pruned: "done 12" always means the same item.
 * - One thing is one item: adding an open item's `ref` again changes nothing
 *   the item already says (its title, link, reminder, snooze stay), at most
 *   fills in a detail, a sender or a link it lacked when the add names the
 *   same source as the item; a closed one stays closed. Only
 *   the owner reopens an item (the console: reopen), never an add, whatever
 *   time it claims the thing happened again: what Pointer adds comes from
 *   what it read, and that may be someone's planted message.
 * - At most 2 000 items; closed ones are kept 60 days after they were
 *   closed, then dropped, the oldest first when the list is full. Open items
 *   are never dropped: a new one is refused while 2 000 are open.
 * - Texts are clipped; a source's text is outside content (detail).
 *
 * - The list is one person's: the Slack user it belongs to (`owner`) is
 *   recorded on every connect of the owner's account, and the list is
 *   emptied for another person (routes/slack-account.ts). The reminders
 *   send nothing while it is not the account connected (reminders.ts).
 *
 * Changes are written at most about once a second (Cloud Storage takes about
 * one write per second per object): the first after a quiet second at once,
 * the ones that come within the second collected and written together. One
 * write at a time in this process (the web service is the only writer), each
 * on what is stored now. A change that changes nothing writes nothing.
 * Nothing of an item is logged.
 */
import { decrypt, encrypt } from "../core/crypto.js";
import type { Store } from "../core/store.js";
import { FOLLOWUP_SOURCES, type FollowupItem, type FollowupSource } from "./types.js";

export const FOLLOWUP_LIMITS = {
  items: 2_000,
  /** Days a closed item is kept. */
  doneDays: 60,
  title: 200,
  detail: 2_000,
  from: 120,
  link: 500,
  ref: 200,
  /** Repeating reminders: at least this often apart, at most a week (minutes). */
  minRepeatMin: 10,
  maxRepeatMin: 7 * 24 * 60,
  /** Reminders remembered as sent (meeting reminders), and for how long. */
  sentKeys: 2_000,
  sentDays: 3,
} as const;

const KEY = "followups/items.enc";
const DAY_MS = 24 * 60 * 60_000;
const WRITE_BATCH_MS = 1_000;

/** What the reminders remember between ticks and restarts. */
export interface ReminderState {
  /** The local day ("YYYY-MM-DD", config.timezone) the last morning brief went out. */
  briefDay?: string;
  /** Reminders sent, by key ("meeting:<eventId>:<start>"), with when: none goes twice. */
  sent: Record<string, string>;
  /** The console conversation the reminders are kept in. */
  conversationId?: string;
  /** When Gmail was last checked for threads the owner answered. */
  gmailCheckedAt?: string;
}

interface FollowupData {
  version: 1;
  /** The number the next item gets. */
  nextN: number;
  items: FollowupItem[];
  reminders: ReminderState;
  /**
   * The Slack user whose list this is (config.slack.user.userId): recorded
   * on every connect (setOwner) and when the list is emptied for someone
   * (reset), and kept across a disconnect, so that connecting another person
   * later is still seen as a switch (routes/slack-account.ts). Absent on a
   * list kept before it was recorded: whose it is is then unknown.
   */
  owner?: string;
}

/** A new item, or the fields an open item with its ref may still lack. */
export interface NewFollowup {
  title: string;
  detail?: string;
  source: FollowupSource;
  ref?: string;
  from?: string;
  link?: string;
  remindAt?: string;
  repeatMin?: number;
}

export type AddResult =
  | { status: "added"; item: FollowupItem }
  /** An open item has the same ref: left as it is, but for the empty fields named in `filled`. */
  | { status: "tracked"; item: FollowupItem; filled: FillableField[] }
  /** The same ref was closed by the owner: left closed (only the owner reopens it). */
  | { status: "closed"; item: FollowupItem }
  /** The list holds FOLLOWUP_LIMITS.items open items. */
  | { status: "full" };

/** What changes on an item; null clears a field. */
export interface FollowupPatch {
  title?: string;
  detail?: string;
  from?: string | null;
  link?: string | null;
  remindAt?: string | null;
  repeatMin?: number | null;
}

export interface DoneResult {
  closed: FollowupItem[];
  /** Already closed before. */
  alreadyDone: FollowupItem[];
  notFound: number[];
}

export type SnoozeResult = { ok: true; item: FollowupItem } | { ok: false; reason: "not-found" | "closed" };

const clip = (text: string, max: number) => {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " "), max);
const isoOrUndefined = (s: string | undefined) => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined);
const repeat = (min: number | undefined) =>
  min && min > 0 ? Math.min(FOLLOWUP_LIMITS.maxRepeatMin, Math.max(FOLLOWUP_LIMITS.minRepeatMin, Math.round(min))) : undefined;

const empty = (): FollowupData => ({ version: 1, nextN: 1, items: [], reminders: { sent: {} } });

/** Why a write failed, for the log: never an item. */
const writeError = (err: unknown): string =>
  err instanceof SyntaxError ? "the stored follow-ups could not be read" : (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** The open items in the order the owner sees them: overdue first (the most overdue first), then the oldest. */
export function byUrgency(items: FollowupItem[], now: Date): FollowupItem[] {
  const due = (i: FollowupItem) => {
    const at = i.remindAt ? Date.parse(i.remindAt) : NaN;
    const snoozed = i.snoozedUntil ? Date.parse(i.snoozedUntil) > now.getTime() : false;
    return Number.isFinite(at) && at <= now.getTime() && !snoozed ? at : undefined;
  };
  return [...items].sort((a, b) => {
    const [da, db] = [due(a), due(b)];
    if (da !== undefined || db !== undefined) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      if (da !== db) return da - db;
    }
    return a.createdAt.localeCompare(b.createdAt) || a.n - b.n;
  });
}

interface Pending {
  apply: (data: FollowupData) => boolean;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface FollowupStoreOptions {
  now?: () => Date;
  /** How long changes are collected before one write (tests use 0). */
  batchMs?: number;
}

export class FollowupStore {
  /** Serialises the blob's reads and writes. */
  private chain: Promise<unknown> = Promise.resolve();
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last write started (this process's clock): the next one waits until a batch's time has passed. */
  private lastFlush = 0;
  private readonly now: () => Date;
  private readonly batchMs: number;

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
    opts: FollowupStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.batchMs = opts.batchMs ?? WRITE_BATCH_MS;
  }

  // ---------- Reading ----------

  /** The items, open ones by default; open ones most urgent first (byUrgency), closed ones the latest closed first. */
  async list(opts: { status?: "open" | "done" | "all" } = {}): Promise<FollowupItem[]> {
    const data = await this.current();
    const status = opts.status ?? "open";
    const open = byUrgency(
      data.items.filter((i) => i.status === "open"),
      this.now(),
    );
    const done = data.items.filter((i) => i.status === "done").sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "") || b.n - a.n);
    return status === "open" ? open : status === "done" ? done : [...open, ...done];
  }

  async get(n: number): Promise<FollowupItem | undefined> {
    return (await this.current()).items.find((i) => i.n === n);
  }

  async reminderState(): Promise<ReminderState> {
    return (await this.current()).reminders;
  }

  // ---------- Changing ----------

  /** Adds an item; with the ref of one already there, leaves that one as it is (see the file's comment). */
  add(input: NewFollowup): Promise<AddResult> {
    return this.write<AddResult>((data) => {
      const now = this.now().toISOString();
      const ref = input.ref ? oneLine(input.ref, FOLLOWUP_LIMITS.ref) : undefined;
      const fields = cleanFields(input);
      if (ref) {
        const open = data.items.find((i) => i.ref === ref && i.status === "open");
        if (open) {
          const filled = fillEmpty(open, fields, input.source);
          return { changed: filled.length > 0, result: { status: "tracked", item: copy(open), filled } };
        }
        const closed = data.items.filter((i) => i.ref === ref && i.status === "done").sort((a, b) => b.n - a.n)[0];
        if (closed) return { changed: false, result: { status: "closed", item: copy(closed) } };
      }
      if (data.items.length >= FOLLOWUP_LIMITS.items) makeRoom(data);
      if (data.items.length >= FOLLOWUP_LIMITS.items) return { changed: false, result: { status: "full" } };
      const item: FollowupItem = {
        n: data.nextN,
        title: fields.title || "(untitled)",
        detail: fields.detail ?? "",
        source: FOLLOWUP_SOURCES.includes(input.source) ? input.source : "owner",
        ...(ref ? { ref } : {}),
        ...(fields.from ? { from: fields.from } : {}),
        ...(fields.link ? { link: fields.link } : {}),
        status: "open",
        createdAt: now,
        ...(fields.remindAt ? { remindAt: fields.remindAt } : {}),
        ...(fields.repeatMin ? { repeatMin: fields.repeatMin } : {}),
      };
      data.nextN += 1;
      data.items.push(item);
      return { changed: true, result: { status: "added", item: copy(item) } };
    });
  }

  /** Changes an item, open or closed; undefined when there is none. */
  update(n: number, patch: FollowupPatch): Promise<FollowupItem | undefined> {
    return this.write((data) => {
      const item = data.items.find((i) => i.n === n);
      if (!item) return { changed: false, result: undefined };
      const before = JSON.stringify(item);
      if (patch.title !== undefined && patch.title.trim()) item.title = oneLine(patch.title, FOLLOWUP_LIMITS.title);
      if (patch.detail !== undefined) item.detail = clip(patch.detail, FOLLOWUP_LIMITS.detail);
      setOptional(item, "from", patch.from === null ? null : patch.from !== undefined ? oneLine(patch.from, FOLLOWUP_LIMITS.from) : undefined);
      setOptional(item, "link", patch.link === null ? null : patch.link !== undefined ? oneLine(patch.link, FOLLOWUP_LIMITS.link) : undefined);
      setOptional(item, "remindAt", patch.remindAt === null ? null : patch.remindAt !== undefined ? isoOrUndefined(patch.remindAt) : undefined);
      if (patch.repeatMin !== undefined) setOptional(item, "repeatMin", repeat(patch.repeatMin ?? undefined) ?? null);
      // A new reminder time ends a snooze from before.
      if (patch.remindAt !== undefined) delete item.snoozedUntil;
      return { changed: JSON.stringify(item) !== before, result: copy(item) };
    });
  }

  /** Closes items by number; says which were closed already and which do not exist. */
  done(numbers: readonly number[]): Promise<DoneResult> {
    return this.write((data) => {
      const at = this.now().toISOString();
      const out: DoneResult = { closed: [], alreadyDone: [], notFound: [] };
      for (const n of new Set(numbers)) {
        const item = data.items.find((i) => i.n === n);
        if (!item) out.notFound.push(n);
        else if (item.status === "done") out.alreadyDone.push(copy(item));
        else {
          item.status = "done";
          item.doneAt = at;
          out.closed.push(copy(item));
        }
      }
      return { changed: out.closed.length > 0, result: out };
    });
  }

  /** Opens a closed item again; undefined when there is none. */
  reopen(n: number): Promise<FollowupItem | undefined> {
    return this.write((data) => {
      const item = data.items.find((i) => i.n === n);
      if (!item) return { changed: false, result: undefined };
      if (item.status === "open") return { changed: false, result: copy(item) };
      item.status = "open";
      delete item.doneAt;
      return { changed: true, result: copy(item) };
    });
  }

  /** Out of reminders until `until`, and reminded then (its remindAt moves there; a repeat goes on from there). */
  snooze(n: number, until: Date): Promise<SnoozeResult> {
    return this.write<SnoozeResult>((data) => {
      const item = data.items.find((i) => i.n === n);
      if (!item) return { changed: false, result: { ok: false, reason: "not-found" } };
      if (item.status !== "open") return { changed: false, result: { ok: false, reason: "closed" } };
      item.snoozedUntil = until.toISOString();
      item.remindAt = until.toISOString();
      return { changed: true, result: { ok: true, item: copy(item) } };
    });
  }

  /**
   * A source saw the owner answer what `ref` is about (they replied in Slack
   * or Gmail): its open items say so ("you replied") and stay open. Resolves
   * with how many items it marked.
   */
  answered(ref: string | readonly string[], at: string | Date): Promise<number> {
    const refs = new Set(typeof ref === "string" ? [ref] : ref);
    const when = new Date(at).toISOString();
    if (!refs.size || !Number.isFinite(Date.parse(when))) return Promise.resolve(0);
    return this.write((data) => {
      let marked = 0;
      for (const item of data.items) {
        if (item.status !== "open" || !item.ref || !refs.has(item.ref)) continue;
        if (item.answeredAt && item.answeredAt >= when) continue;
        item.answeredAt = when;
        marked += 1;
      }
      return { changed: marked > 0, result: marked };
    });
  }

  /** The items were in a reminder (the brief, their own) at `at`. */
  markReminded(numbers: readonly number[], at: Date): Promise<void> {
    const set = new Set(numbers);
    return this.write((data) => {
      let changed = false;
      for (const item of data.items) {
        if (!set.has(item.n)) continue;
        item.remindedAt = at.toISOString();
        changed = true;
      }
      return { changed, result: undefined };
    });
  }

  /**
   * Empties the list for another person (routes/slack-account.ts: their
   * Slack account was switched or disconnected): every item and what the
   * reminders remember go; numbers are still never reused. `owner` is the
   * Slack user it is emptied for (FollowupData.owner). Resolves with the
   * console conversation the reminders were kept in, for the caller to
   * delete (its copies were the person before's).
   */
  reset(owner: string): Promise<{ conversationId?: string }> {
    return this.write((data) => {
      const { conversationId } = data.reminders;
      const changed = data.items.length > 0 || JSON.stringify(data.reminders) !== JSON.stringify({ sent: {} }) || data.owner !== owner;
      data.items = [];
      data.reminders = { sent: {} };
      data.owner = owner;
      return { changed, result: conversationId ? { conversationId } : {} };
    });
  }

  /** Records whose list this is (the account connected now), keeping what is in it. */
  setOwner(owner: string): Promise<void> {
    return this.write((data) => {
      if (data.owner === owner) return { changed: false, result: undefined };
      data.owner = owner;
      return { changed: true, result: undefined };
    });
  }

  /** The Slack user whose list this is, if recorded (FollowupData.owner), and whether it holds any item, open or closed. */
  async ownership(): Promise<{ owner?: string; empty: boolean }> {
    const data = await this.current();
    return { ...(data.owner ? { owner: data.owner } : {}), empty: data.items.length === 0 };
  }

  /** Changes what the reminders remember; `change` returns false when it changes nothing. */
  updateReminders(change: (state: ReminderState) => boolean): Promise<void> {
    return this.write((data) => ({ changed: change(data.reminders), result: undefined }));
  }

  /** Writes what is queued now. A failed write rejects the changes in it; never throws itself. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.exclusive(async () => {
      const batch = this.pending.splice(0);
      if (!batch.length) return;
      this.lastFlush = Date.now();
      try {
        const data = await this.read();
        let changed = this.prune(data);
        // Each change applies to what the ones before it made.
        for (const p of batch) changed = p.apply(data) || changed;
        if (changed) await this.put(data);
        for (const p of batch) p.resolve();
      } catch (err) {
        console.error(`[followups] write failed, ${batch.length} change${batch.length === 1 ? "" : "s"} not kept:`, writeError(err));
        for (const p of batch) p.reject(err);
      }
    });
  }

  // ---------- Inside ----------

  /** The stored data after what is queued, pruned (the prune written when it dropped anything). */
  private async current(): Promise<FollowupData> {
    await this.flush();
    return this.exclusive(async () => {
      const data = await this.read();
      if (this.prune(data)) await this.put(data).catch((err) => console.error("[followups] expired items not removed yet:", writeError(err)));
      return data;
    });
  }

  private write<T>(change: (data: FollowupData) => { changed: boolean; result: T }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let result: T;
      this.pending.push({
        apply: (data) => {
          const r = change(data);
          result = r.result;
          return r.changed;
        },
        resolve: () => resolve(result),
        reject,
      });
      // At once after a quiet batch time (what comes in this turn still goes in the same write); else when it has passed.
      this.timer ??= setTimeout(() => void this.flush(), Math.max(0, this.lastFlush + this.batchMs - Date.now()));
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The stored data; empty when there is none. A blob that cannot be read throws: it is never replaced by an empty list. */
  private async read(): Promise<FollowupData> {
    const blob = await this.store.get(KEY);
    if (!blob || blob.length === 0) return empty();
    const raw = JSON.parse(decrypt(this.key, blob)) as Partial<FollowupData>;
    const items = Array.isArray(raw.items) ? raw.items : [];
    const highest = items.reduce((max, i) => Math.max(max, i.n), 0);
    return {
      version: 1,
      nextN: Math.max(typeof raw.nextN === "number" ? raw.nextN : 1, highest + 1),
      items,
      reminders: { ...(raw.reminders ?? {}), sent: { ...(raw.reminders?.sent ?? {}) } },
      ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
    };
  }

  /** Writes the data; a failed write is tried once more after a pause. */
  private async put(data: FollowupData): Promise<void> {
    const blob = encrypt(this.key, JSON.stringify(data));
    try {
      await this.store.put(KEY, blob);
    } catch (err) {
      console.warn("[followups] write failed, trying once more:", writeError(err));
      await new Promise((resolve) => setTimeout(resolve, this.batchMs));
      await this.store.put(KEY, blob);
    }
  }

  /** Drops closed items past their 60 days and reminder keys past theirs. True when it dropped anything. */
  private prune(data: FollowupData): boolean {
    const now = this.now().getTime();
    const before = data.items.length + Object.keys(data.reminders.sent).length;
    const cutoff = now - FOLLOWUP_LIMITS.doneDays * DAY_MS;
    data.items = data.items.filter((i) => i.status === "open" || Date.parse(i.doneAt ?? i.createdAt) >= cutoff);
    if (data.items.length > FOLLOWUP_LIMITS.items) makeRoom(data);
    const sentCutoff = now - FOLLOWUP_LIMITS.sentDays * DAY_MS;
    const sent = Object.entries(data.reminders.sent)
      .filter(([, at]) => Date.parse(at) >= sentCutoff)
      .sort(([, a], [, b]) => a.localeCompare(b))
      .slice(-FOLLOWUP_LIMITS.sentKeys);
    data.reminders.sent = Object.fromEntries(sent);
    return data.items.length + sent.length < before;
  }
}

/** Drops the closed items closed longest ago until the list has room for one more. */
function makeRoom(data: FollowupData): void {
  const over = data.items.length - FOLLOWUP_LIMITS.items + 1;
  if (over <= 0) return;
  const oldest = data.items
    .filter((i) => i.status === "done")
    .sort((a, b) => (a.doneAt ?? "").localeCompare(b.doneAt ?? ""))
    .slice(0, over);
  const drop = new Set(oldest.map((i) => i.n));
  data.items = data.items.filter((i) => !drop.has(i.n));
}

/** An input's fields, clipped and checked. */
interface Fields {
  title: string;
  detail?: string;
  from?: string;
  link?: string;
  remindAt?: string;
  repeatMin?: number;
}

function cleanFields(input: NewFollowup): Fields {
  const fields: Fields = { title: oneLine(input.title ?? "", FOLLOWUP_LIMITS.title) };
  if (input.detail?.trim()) fields.detail = clip(input.detail, FOLLOWUP_LIMITS.detail);
  if (input.from?.trim()) fields.from = oneLine(input.from, FOLLOWUP_LIMITS.from);
  if (input.link?.trim()) fields.link = oneLine(input.link, FOLLOWUP_LIMITS.link);
  const remindAt = isoOrUndefined(input.remindAt);
  if (remindAt) fields.remindAt = remindAt;
  const every = repeat(input.repeatMin);
  if (every) fields.repeatMin = every;
  return fields;
}

/** The fields an add may fill in on an item already tracked, when it has none. */
export type FillableField = "detail" | "from" | "link";

/**
 * Fills in what an item already tracked lacks (a detail, a sender, a link),
 * only when the add names the same source as the item: what Pointer found in
 * Slack never fills in the owner's own item, nor one from Gmail. Never its
 * title, link, reminder, repeat or snooze: changing those is
 * followups_update's, which needs the owner's yes after outside content.
 * Returns the fields filled.
 */
function fillEmpty(item: FollowupItem, fields: Fields, source: FollowupSource): FillableField[] {
  const filled: FillableField[] = [];
  if (source !== item.source) return filled;
  if (fields.detail && !item.detail) {
    item.detail = fields.detail;
    filled.push("detail");
  }
  if (fields.from && !item.from) {
    item.from = fields.from;
    filled.push("from");
  }
  if (fields.link && !item.link) {
    item.link = fields.link;
    filled.push("link");
  }
  return filled;
}

type OptionalKey = "from" | "link" | "remindAt" | "repeatMin";

/** Sets an optional field (a value), clears it (null), or leaves it (undefined). */
function setOptional<K extends OptionalKey>(item: FollowupItem, key: K, value: FollowupItem[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") delete item[key];
  else item[key] = value;
}

const copy = (item: FollowupItem): FollowupItem => structuredClone(item);
