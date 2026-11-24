/**
 * Follow-ups: the owner's open items, from everywhere, kept until the owner
 * says they are done, with reminders until then.
 *
 * Where items come from:
 * - the owner ("remind me to call Fadi at 3", "track this");
 * - Pointer, when it finds something that needs the owner's reply or action
 *   in their Slack inbox (slack/inbox.ts) or their Gmail (EmailSource);
 * - nothing else adds items on its own.
 *
 * An item stays open until the owner closes it ("done 12", "تم 3 و 5", the
 * console). A source may note that the owner already answered (they replied
 * in Slack or Gmail): the item says so, it does not close.
 *
 * Reminders (followups/reminders.ts): the morning brief (today's calendar and
 * the open items), the digests (what is new and what is still open), an
 * item's own time ("at 3 pm"), and a reminder before each calendar event.
 *
 * These are the shapes the follow-ups store, the Google sources and the
 * console share.
 */

/** Where an item came from. */
export const FOLLOWUP_SOURCES = ["owner", "slack", "gmail", "calendar", "pointer"] as const;
export type FollowupSource = (typeof FOLLOWUP_SOURCES)[number];

export const FOLLOWUP_STATUSES = ["open", "done"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export interface FollowupItem {
  /** The owner's number for it: stable, never reused ("done 12"). */
  n: number;
  /** One line: "Reply to Fadi about the Q3 invoice". */
  title: string;
  /** More context, plain text, clipped (outside content when the source is slack or gmail). */
  detail: string;
  source: FollowupSource;
  /**
   * What it is about at its source, so one thing never becomes two items:
   * "slack:<channel>:<ts>", "gmail:<threadId>", "calendar:<eventId>". Absent for the owner's own items.
   */
  ref?: string;
  /** Who it is from or with ("Fadi Shqerat", "billing@acme.example"). */
  from?: string;
  /** A link to it (Slack permalink, Gmail thread, calendar event). */
  link?: string;
  status: FollowupStatus;
  createdAt: string;
  /** When to remind the owner of it on its own (an ISO time), besides the digests. */
  remindAt?: string;
  /** After remindAt, remind again this often until it is done (minutes); 0 or absent = once. */
  repeatMin?: number;
  /** Not in reminders before this time (the owner postponed it). */
  snoozedUntil?: string;
  /** The source says the owner already answered (they replied in Slack or Gmail): shown, never closes it. */
  answeredAt?: string;
  doneAt?: string;
  /** When it was last in a reminder (digest, brief or its own). */
  remindedAt?: string;
}

/** A calendar event, as the brief and the reminders need it. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO times; for an all-day event the day's start and end in the owner's timezone. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** The video call link, else the event's page. */
  link?: string;
  /** People invited, the owner included. */
  attendees?: number;
  /** The owner declined it: left out of briefs and reminders. */
  declined?: boolean;
}

/** The owner's calendar (google/calendar.ts). */
export interface CalendarSource {
  /** Whether a calendar is connected and readable now. */
  ready(): Promise<boolean>;
  /** Events overlapping [from, to), sorted by start. Throws when the calendar cannot be read. */
  eventsBetween(from: Date, to: Date): Promise<CalendarEvent[]>;
}

/** An email thread that may need the owner's reply (google/gmail.ts). */
export interface EmailThread {
  /** Gmail's thread id. */
  id: string;
  subject: string;
  /** The other person, "Name <address>". */
  from: string;
  /** The latest message's time, ISO. */
  at: string;
  /** Short plain text of the latest message (outside content), clipped. */
  snippet: string;
  /** The owner sent the latest message in the thread. */
  ownerRepliedLast: boolean;
  /** Its page in Gmail. */
  link: string;
}

/** The owner's mail (google/gmail.ts). */
export interface EmailSource {
  ready(): Promise<boolean>;
  /** Threads in the inbox from people (not lists, no-reply or automated mail) with a message since `since`, newest first. */
  threadsSince(since: Date): Promise<EmailThread[]>;
}

/**
 * The console's API (routes/followups.ts), admin only:
 * - GET  /api/followups?status=open|done   → { items: FollowupItem[], settings: FollowupSettings }
 * - POST /api/followups                    { title, detail?, remindAt?, repeatMin? } → { ok, item }
 * - POST /api/followups/:n/done            → { ok, item }
 * - POST /api/followups/:n/reopen          → { ok, item }
 * - POST /api/followups/:n/snooze          { until } → { ok, item }
 * - POST /api/followups/settings           Partial<FollowupSettings> → { ok, settings }
 * FollowupSettings is config.followups (core/config.ts).
 */
