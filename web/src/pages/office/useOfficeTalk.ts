import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { Activity } from "./life";
import { TALK_PATH, type TalkAnswer, type TalkEntry, type TalkRequest, cleanLines, talkDue, talkSchedule } from "./talk";

/** After an answer without lines (talk off, the limit reached, no model), the page stops asking this long. */
const QUIET_MS = 2 * 60_000;
/** Conversations kept for the drawer. */
const KEEP = 100;

/** A conversation the server sent, and when it arrived (its lines replace the canned ones from then). */
export interface Heard extends TalkEntry {
  arrivedAt: number;
}

/**
 * This session's talk, shared by the scene and the drawer: every activity id
 * asked (at most once each), the conversations heard, and a pause after an
 * answer without lines. A module store, so leaving the Office page and coming
 * back asks nothing again.
 */
const asked = new Set<string>();
const heard = new Map<string, Heard>();
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
    if (!lines.length) {
      quietUntil = Date.now() + QUIET_MS;
      return;
    }
    heard.set(request.activityId, {
      activityId: request.activityId,
      kind: request.kind,
      people: request.people,
      lines: talkSchedule(lines, window),
      provider: answer.provider,
      model: answer.model,
      arrivedAt: Date.now(),
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
 * changes when one arrives).
 */
export function useOfficeTalk(activities: Activity[], isActive: boolean): { heard: ReadonlyMap<string, Heard>; version: number } {
  const current = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  useEffect(() => {
    if (!isActive) return;
    const now = Date.now();
    if (now < quietUntil) return;
    for (const { request, window } of talkDue(activities, now, asked)) {
      asked.add(request.activityId);
      void ask(request, window);
    }
  }, [activities, isActive]);
  return { heard, version: current };
}

/** Every conversation heard this session (for the drawer), kept in step with the store. */
export function useTalkLog(): TalkEntry[] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return [...heard.values()];
}
