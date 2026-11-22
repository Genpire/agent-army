/**
 * Real talk in the office: when two or three people sit down to chat, share a
 * coffee, play a game (a video game on the beanbags too) or watch one, the
 * page asks the server
 * (POST /api/office/talk) for what they say, written by an AI model (Gemini
 * or the chat model, under Office talk's settings). The answer is the same
 * for everyone who opens the office: the server keeps it by the activity's
 * id. This file is the pure part: what to ask, the answer's lines cleaned,
 * when each line is said (in turn, each long enough to read, inside the
 * activity's `together` window) and the activity with those lines in its
 * people's bubbles instead of the canned ones. useOfficeTalk.ts asks; the
 * page never waits for it: until the lines come, and when none do, the
 * canned lines play.
 *
 * The API's shapes are the server's own, imported type-only (like model.ts),
 * so the page and the server cannot drift apart.
 */
import type { OfficeTalkSettings } from "../../../../src/core/config.js";
import type {
  TalkAnswer,
  TalkKind as ServerTalkKind,
  TalkLine,
  TalkProviderId,
  TalkReason,
  TalkRequest as ServerTalkRequest,
  TalkSettingsView,
} from "../../../../src/office/talk-types.js";
import type { Activity, ActivityKind, Say } from "./life";

/**
 * The server's kinds with "gaming", which joins them in this round (the
 * server's list takes it in the same change); once it has, these two are
 * the server's TalkKind and TalkRequest exactly.
 */
export type TalkKind = ServerTalkKind | "gaming";
export type TalkRequest = Omit<ServerTalkRequest, "kind"> & { kind: TalkKind };
export type { TalkAnswer, TalkLine, TalkProviderId, TalkReason, TalkSettingsView };
/** Office talk's settings (POST /api/office/talk/settings): config.office.talk. A model is set only with "gemini" or "chat". */
export type TalkSettings = OfficeTalkSettings;
export type TalkProvider = TalkSettings["provider"];

/** The activities that talk, by the kind the server knows them by. A video game for one has no talk (it takes two). */
export const TALK_KINDS = ["chat", "coffee", "foosball", "pingpong", "pinball", "gaming"] as const satisfies readonly (TalkKind & ActivityKind)[];

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
export const MIN_LEFT_MS = 1_200;

/** What to ask the server about an activity, or undefined when it has no talk (a walk, a solo outing, a game for one). */
export function talkRequest(a: Pick<Activity, "id" | "kind" | "people" | "together">): TalkRequest | undefined {
  if (!a.together || a.people.length < 2 || a.people.length > 3) return undefined;
  const kind = TALK_KINDS.find((k) => k === a.kind);
  if (!kind) return undefined;
  // The plan's id is the slot; its people make it this conversation's (two viewers who saw different people never share one).
  const activityId = `${a.id}:${a.people.join(".")}`;
  return ACTIVITY_ID.test(activityId) ? { activityId, kind, people: [...a.people] } : undefined;
}

/** The conversations planned now, by their talk id. */
export const plannedTalk = (activities: Pick<Activity, "id" | "kind" | "people" | "together">[]): Set<string> =>
  new Set(activities.flatMap((a) => talkRequest(a)?.activityId ?? []));

/** The conversations that have left the plan since the director's last step (it ended, or was cut short when someone got work): planned then, not now. */
export const leftThePlan = (was: ReadonlySet<string>, now: ReadonlySet<string>): string[] => [...was].filter((id) => !now.has(id));

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
 * The lines that are really on screen: scheduled in the window
 * (talkSchedule), each from when the answer arrived (`since`) at the
 * earliest, none with less than MIN_LEFT_MS left by then, and none that
 * starts once the outing has left the plan (`until`: someone got work and
 * walked back, so the conversation stopped). The bubbles (withTalk) and the
 * person drawer's "Said in the office" both use it.
 */
export function shownLines(lines: TalkLine[], window: { t0: number; t1: number }, since: number, until = Number.POSITIVE_INFINITY): TimedLine[] {
  return talkSchedule(lines, window)
    .map((l) => ({ ...l, t0: Math.max(l.t0, since) }))
    .filter((l) => l.t1 - l.t0 >= MIN_LEFT_MS && l.t0 < until);
}

/**
 * The activity with real talk in its people's bubbles. Inside the `together`
 * window, the lines on screen (shownLines) replace the canned ones from the
 * moment the answer arrived (`since`): a canned line already showing ends
 * then. Lines outside the window (a game's "gg!", a coffee's "thanks!")
 * stay. Unchanged without a window or a line to show.
 */
export function withTalk(a: Activity, lines: TalkLine[], since: number): Activity {
  const window = a.together;
  if (!window) return a;
  const shown = shownLines(lines, window, since);
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
  /** When it was said, line by line: the lines that were on screen (shownLines). */
  lines: TimedLine[];
  provider?: TalkProviderId;
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

/** A model is set only with Gemini or the chat provider: Auto always uses the default models (the server refuses a model with it). */
export const picksModel = (provider: TalkProvider): provider is TalkProviderId => provider !== "auto";

/** The settings as the dialog edits them: a model left from before on Auto is dropped, so saving them is never refused. */
export const settingsDraft = (v: TalkSettings): TalkSettings => ({ enabled: v.enabled, provider: v.provider, model: picksModel(v.provider) ? v.model : "", dailyMax: v.dailyMax });

/** The settings with another provider: its model starts at the default (a model id belongs to one provider, and Auto takes none). */
export const withProvider = (settings: TalkSettings, provider: TalkProvider): TalkSettings => ({ ...settings, provider, model: "" });

/** "Ping pong with Omar", "Coffee with Omar and Lina": what a conversation was, from one person's side. */
export function talkTitle(entry: Pick<TalkEntry, "kind" | "people">, personId: string, nameOf: (id: string) => string): string {
  const others = entry.people.filter((id) => id !== personId).map(nameOf);
  const withWhom = others.length ? ` with ${others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0]}` : "";
  const what: Record<TalkKind, string> = { chat: "Chat", coffee: "Coffee", foosball: "Foosball", pingpong: "Ping pong", pinball: "Pinball", gaming: "Video games" };
  return `${what[entry.kind]}${withWhom}`;
}
