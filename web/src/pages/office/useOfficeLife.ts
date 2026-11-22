import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SceneLayout } from "./layout";
import { type Activity, type LifeNote, type LifeState, type Track, advance, lifeNote, lifePeople, nextEvent } from "./life";
import type { OfficeView } from "./model";
import { talkRequest, withTalk } from "./talk";
import { useOfficeTalk } from "./useOfficeTalk";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the tab is hidden (then the office's life pauses). */
export function usePageHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.hidden,
    () => false,
  );
}

/** Who is out of their seat, and on which outing. */
export interface OfficeLife {
  activities: Activity[];
  /** Each person's part, by person id. */
  parts: Map<string, { activity: Activity; track: Track }>;
  /** What a person is doing, in words, at time `now` (for the list and the reduced-motion bubbles). */
  noteOf: (personId: string, now: number) => LifeNote | undefined;
  /** The tab is hidden: animations pause. */
  isPaused: boolean;
}

/**
 * The office's life (life.ts) for the page: the director steps whenever the
 * office is re-read and wakes up only at its next event (an outing that
 * starts or ends), never per frame. A hidden tab stops it; when the tab is
 * shown again it catches up with the clock. With `canTalk` (the picture is
 * shown, with motion), the conversations get real talk when the server has
 * some (useOfficeTalk): the activities come back with those lines in their
 * people's bubbles; the director's own plan never changes.
 */
export function useOfficeLife(view: OfficeView | undefined, layout: SceneLayout | undefined, canTalk = false): OfficeLife {
  const isPaused = usePageHidden();
  const people = useMemo(() => (view && layout ? lifePeople(view, layout) : undefined), [view, layout]);
  const [state, setState] = useState<LifeState>();

  useEffect(() => {
    if (!people || !layout || isPaused) return;
    setState((prev) => advance(prev, people, layout, Date.now()));
  }, [people, layout, isPaused]);

  useEffect(() => {
    if (!state || !people || !layout || isPaused) return;
    const wait = Math.max(50, nextEvent(state) - Date.now() + 20);
    const timer = setTimeout(() => setState((prev) => advance(prev, people, layout, Date.now())), wait);
    return () => clearTimeout(timer);
  }, [state, people, layout, isPaused]);

  const planned = state?.activities;
  const talk = useOfficeTalk(planned ?? [], canTalk && !isPaused);
  const activities = useMemo(
    () =>
      (planned ?? []).map((a) => {
        const heard = talk.heard.get(talkRequest(a)?.activityId ?? "");
        return heard ? withTalk(a, heard.lines, heard.arrivedAt) : a;
      }),
    // The store's version says when a conversation arrived (the map itself is the same one).
    [planned, talk.heard, talk.version],
  );
  return useMemo(() => {
    const parts = new Map(activities.flatMap((activity) => activity.tracks.map((track) => [track.personId, { activity, track }] as const)));
    const names = new Map(view?.people.map((p) => [p.id, p.name]));
    const noteOf = (personId: string, now: number) => {
      const part = parts.get(personId);
      return part ? lifeNote(part.activity, personId, (id) => names.get(id), now) : undefined;
    };
    return { activities, parts, noteOf, isPaused };
  }, [activities, view?.people, isPaused]);
}
