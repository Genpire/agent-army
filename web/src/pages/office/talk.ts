/**
 * Real talk in the office: when two or three people sit down to chat, share a
 * coffee, play a game or watch one, the page asks the server
 * (POST /api/office/talk) for what they say, written by an AI model (Gemini
 * or the chat model, under Office talk's settings). The answer is the same
 * for everyone who opens the office: the server keeps it by the activity's
 * id. This file is the pure part: what to ask, the answer's lines cleaned,
 * when each line is said (in turn, each long enough to read, inside the
 * activity's `together` window) and the activity with those lines in its
 * people's bubbles instead of the canned ones. useOfficeTalk.ts asks; the
 * page never waits for it: until the lines come, and when none do, the
 * canned lines play.
 */
import type { Activity, ActivityKind, Say } from "./life";

/** The activities that talk, by the kind the server knows them by. */
export const TALK_KINDS = ["chat", "coffee", "foosball", "pingpong", "pinball"] as const satisfies readonly ActivityKind[];
export type TalkKind = (typeof TALK_KINDS)[number];

export interface TalkLine {
  /** A person's id ("pointer" for the lead). */
  speaker: string;
  text: string;
}

/** POST /api/office/talk's body. */
export interface TalkRequest {
  activityId: string;
  kind: TalkKind;
  people: string[];
}

/** Why there is no talk right now: switched off, the day's limit (or the rate limit) reached, or no model to ask. */
export type TalkReason = "off" | "limit" | "unavailable";
export type TalkProviderUsed = "gemini" | "chat";

/** POST /api/office/talk's answer: the lines, or none and why. */
export interface TalkAnswer {
  lines: TalkLine[];
  provider?: TalkProviderUsed;
  model?: string;
  reason?: TalkReason;
}

export type TalkProvider = "auto" | TalkProviderUsed;

/** Office talk's settings (POST /api/office/talk/settings). */
export interface TalkSettings {
  enabled: boolean;
  provider: TalkProvider;
  /** "" for the provider's default model. */
  model: string;
  /** Conversations a day, at most. */
  dailyMax: number;
}

/** GET /api/office/talk/settings: the settings, today's use and which providers can answer. */
export interface TalkSettingsView extends TalkSettings {
  usedToday: number;
  available: { gemini: boolean; chat: boolean };
}

export const TALK_PATH = "/api/office/talk";
export const TALK_SETTINGS_PATH = "/api/office/talk/settings";
/** The longest line the server sends. */
export const TALK_TEXT_MAX = 140;
export const DAILY_MAX_LIMIT = 500;
/** An activity id the server takes. */
const ACTIVITY_ID = /^[A-Za-z0-9:._-]{1,120}$/;

/** A line stays up this long at least, and at most, whatever its length. */
export const READ_MIN_MS = 2_200;
export const READ_MAX_MS = 6_500;
/** Squeezed to fit a short window, a line still stays up this long. */
const SQUEEZED_MS = 1_600;
/** Between one line and the next. */
const PAUSE_MS = 350;
/** A line the answer arrived too late for (less than this left to read) is not shown. */
const MIN_LEFT_MS = 1_200;

/** What to ask the server about an activity, or undefined when it has no talk (a walk, a solo outing, a game for one). */
export function talkRequest(a: Pick<Activity, "id" | "kind" | "people" | "together">): TalkRequest | undefined {
  if (!a.together || a.people.length < 2 || a.people.length > 3) return undefined;
  const kind = TALK_KINDS.find((k) => k === a.kind);
  if (!kind) return undefined;
  // The plan's id is the slot; its people make it this conversation's (two viewers who saw different people never share one).
  const activityId = `${a.id}:${a.people.join(".")}`;
  return ACTIVITY_ID.test(activityId) ? { activityId, kind, people: [...a.people] } : undefined;
}

/**
 * What to ask now: one request per activity with talk whose window is not
 * over yet (an outing replayed from the past that has ended asks nothing)
 * and whose id is not in `asked` (each conversation is asked once).
 */
export function talkDue(activities: Pick<Activity, "id" | "kind" | "people" | "together">[], now: number, asked: ReadonlySet<string>): { request: TalkRequest; window: { t0: number; t1: number } }[] {
  return activities.flatMap((a) => {
    const request = talkRequest(a);
    if (!request || !a.together || a.together.t1 <= now || asked.has(request.activityId)) return [];
    return [{ request, window: a.together }];
  });
}

/**
 * The answer's lines as the page uses them: each said by one of the people,
 * one line of plain text, at most TALK_TEXT_MAX characters, at most eight.
 * Fewer than two usable lines is no conversation: none.
 */
export function cleanLines(lines: unknown, people: readonly string[]): TalkLine[] {
  if (!Array.isArray(lines)) return [];
  const out: TalkLine[] = [];
  for (const line of lines.slice(0, 8)) {
    if (!line || typeof line !== "object") continue;
    const { speaker, text } = line as { speaker?: unknown; text?: unknown };
    if (typeof speaker !== "string" || !people.includes(speaker) || typeof text !== "string") continue;
    const plain = text.replace(/\s+/g, " ").trim();
    if (!plain) continue;
    out.push({ speaker, text: plain.length > TALK_TEXT_MAX ? `${plain.slice(0, TALK_TEXT_MAX - 1).trimEnd()}…` : plain });
  }
  return out.length >= 2 ? out : [];
}

/** How long a line stays up: long enough to read it. */
export const readMs = (text: string): number => Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, 1_200 + 55 * text.length));

export interface TimedLine extends TalkLine {
  t0: number;
  t1: number;
}

/**
 * When each line is said in a window: in turn from its start, each for its
 * reading time with a short pause between. When they do not fit, every line
 * is shortened alike (never below SQUEEZED_MS) and the talk ends before the
 * first line still past the window's end.
 */
export function talkSchedule(lines: TalkLine[], window: { t0: number; t1: number }): TimedLine[] {
  const reads = lines.map((l) => readMs(l.text));
  const total = reads.reduce((sum, ms) => sum + ms + PAUSE_MS, 0);
  const squeeze = Math.min(1, (window.t1 - window.t0) / total);
  const out: TimedLine[] = [];
  let t = window.t0;
  for (const [i, line] of lines.entries()) {
    const ms = Math.max(SQUEEZED_MS, Math.round(reads[i]! * squeeze));
    // The conversation stops at the first line that does not fit: never a later line without the one before it.
    if (t + ms > window.t1) break;
    out.push({ ...line, t0: t, t1: t + ms });
    t += ms + Math.round(PAUSE_MS * squeeze);
  }
  return out;
}

/**
 * The activity with real talk in its people's bubbles. Inside the `together`
 * window, the lines (scheduled by talkSchedule) replace the canned ones from
 * the moment the answer arrived (`since`): a canned line already showing ends
 * then, and a talk line with too little time left is skipped. Lines outside
 * the window (a game's "gg!", a coffee's "thanks!") stay. Unchanged without
 * a window or a line to show.
 */
export function withTalk(a: Activity, lines: TalkLine[], since: number): Activity {
  const window = a.together;
  if (!window) return a;
  const shown = talkSchedule(lines, window)
    .map((l) => ({ ...l, t0: Math.max(l.t0, since) }))
    .filter((l) => l.t1 - l.t0 >= MIN_LEFT_MS);
  if (!shown.length) return a;
  const from = shown[0]!.t0;
  const inWindow = (s: Say) => s.t0 >= window.t0 && s.t0 < window.t1;
  const tracks = a.tracks.map((track) => {
    const kept = track.says.flatMap((s): Say[] => {
      if (!inWindow(s) || s.t1 <= from) return [s];
      return s.t0 < from ? [{ ...s, t1: from }] : [];
    });
    const talk = shown.filter((l) => l.speaker === track.personId).map((l): Say => ({ t0: l.t0, t1: l.t1, text: l.text, isTalk: true }));
    return { ...track, says: [...kept, ...talk].sort((p, q) => p.t0 - q.t0) };
  });
  return { ...a, tracks };
}

/** One conversation heard this session, for the person drawer. */
export interface TalkEntry {
  activityId: string;
  kind: TalkKind;
  people: string[];
  /** When it was said, line by line. */
  lines: TimedLine[];
  provider?: TalkProviderUsed;
  model?: string;
}

/** A person's conversations that have started by `now`, newest first, with the lines said so far. */
export function talksOf(entries: Iterable<TalkEntry>, personId: string, now: number, max = 5): TalkEntry[] {
  return [...entries]
    .filter((e) => e.people.includes(personId) && e.lines.length > 0 && e.lines[0]!.t0 <= now)
    .map((e) => ({ ...e, lines: e.lines.filter((l) => l.t0 <= now) }))
    .sort((p, q) => q.lines[0]!.t0 - p.lines[0]!.t0)
    .slice(0, max);
}

/** "Ping pong with Omar", "Coffee with Omar and Lina": what a conversation was, from one person's side. */
export function talkTitle(entry: Pick<TalkEntry, "kind" | "people">, personId: string, nameOf: (id: string) => string): string {
  const others = entry.people.filter((id) => id !== personId).map(nameOf);
  const withWhom = others.length ? ` with ${others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0]}` : "";
  const what: Record<TalkKind, string> = { chat: "Chat", coffee: "Coffee", foosball: "Foosball", pingpong: "Ping pong", pinball: "Pinball" };
  return `${what[entry.kind]}${withWhom}`;
}
