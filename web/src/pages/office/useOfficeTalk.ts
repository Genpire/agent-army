import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { Activity } from "./life";
import { TALK_PATH, type TalkAnswer, type TalkEntry, type TalkLine, type TalkRequest, cleanLines, leftThePlan, plannedTalk, shownLines, talkDue } from "./talk";

/** After an answer without lines (talk off, the limit reached, no model), the page stops asking this long. */
const QUIET_MS = 2 * 60_000;
/** Conversations kept for the drawer. */
const KEEP = 100;

/** A conversation the server sent: its lines, its window, when it arrived (its lines replace the canned ones from then) and when its outing left the plan. */
export interface Heard extends Omit<TalkEntry, "lines"> {
  said: TalkLine[];
  window: { t0: number; t1: number };
  arrivedAt: number;
  /** When the outing stopped being planned (it ended, or someone got work and it was cut short): nothing is said after. */
  leftAt?: number;
}

/**
 * This session's talk, shared by the scene and the drawer: every activity id
 * asked (at most once each), the conversations heard, and a pause after an
 * answer without lines. A module store, so leaving the Office page and coming
 * back asks nothing again.
 */
const asked = new Set<string>();
const heard = new Map<string, Heard>();
/** The talk ids of the outings planned now, while the office is open (undefined when it is not, or not planned yet). */
let planned: ReadonlySet<string> | undefined;
let quietUntil = 0;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask again right away (the settings were just saved: talk may be on now). */
export function resumeOfficeTalk(): void {
  quietUntil = 0;
}

async function ask(request: TalkRequest, window: { t0: number; t1: number }) {
  try {
    const answer = await api.post<TalkAnswer>(TALK_PATH, request);
    const lines = cleanLines(answer.lines, request.people);
    if (!lines.length || !("provider" in answer)) {
      quietUntil = Date.now() + QUIET_MS;
      return;
    }
    const now = Date.now();
    heard.set(request.activityId, {
      activityId: request.activityId,
      kind: request.kind,
      people: request.people,
      said: lines,
      window,
      arrivedAt: now,
      // Cut short while the answer was on its way: none of it is said.
      ...(planned && !planned.has(request.activityId) ? { leftAt: now } : {}),
      provider: answer.provider,
      model: answer.model,
    });
    // A long session keeps its last conversations only.
    for (const id of heard.keys()) if (heard.size > KEEP) heard.delete(id);
    changed();
  } catch {
    // The canned lines play; this activity is not asked again.
  }
}

/**
 * Asks for the talk of every activity that has some and has not been asked
 * yet: never while `isActive` is false (a hidden tab, reduced motion, the
 * list view), never for one whose talk window is already over (replayed from
 * the past), and not for a while after an answer without lines. Never waits:
 * the conversations heard come back through the store (the returned version
 * changes when one arrives). It also notes when a conversation's outing
 * leaves the plan (`activities` is undefined until the director has run),
 * so the drawer never lists a line said after it.
 */
export function useOfficeTalk(activities: Activity[] | undefined, isActive: boolean): { heard: ReadonlyMap<string, Heard>; version: number } {
  const current = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  useEffect(() => {
    if (!activities) return;
    const now = Date.now();
    const ids = plannedTalk(activities);
    let isChanged = false;
    for (const id of planned ? leftThePlan(planned, ids) : []) {
      const h = heard.get(id);
      if (h && h.leftAt === undefined) {
        h.leftAt = now;
        isChanged = true;
      }
    }
    planned = ids;
    if (isChanged) changed();
  }, [activities]);
  // Closed, the office plans nothing: coming back replays the plan, and a conversation under way goes on.
  useEffect(
    () => () => {
      planned = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!isActive || !activities) return;
    const now = Date.now();
    if (now < quietUntil) return;
    for (const { request, window } of talkDue(activities, now, asked)) {
      asked.add(request.activityId);
      void ask(request, window);
    }
  }, [activities, isActive]);
  return { heard, version: current };
}

/** Every conversation heard this session, with the lines that were on screen (for the drawer), kept in step with the store. */
export function useTalkLog(): TalkEntry[] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return [...heard.values()].map(({ said, window, arrivedAt, leftAt, ...entry }) => ({ ...entry, lines: shownLines(said, window, arrivedAt, leftAt) }));
}
