import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../../lib/api";
import type { ConversationList, ConversationSummary, ConversationView, ScreenshotList, Task, TaskEventsView, TaskTimeline } from "../../lib/types";
import { type ChatOptions, DEFAULT_OPTIONS, loadChatOptions } from "./files";
import { isActiveTask } from "./labels";

/**
 * Data hooks for the Chat page. Polling is a chain of timeouts (never two
 * requests in flight for the same thing) that runs only while there is
 * something live to show, and stops when the page hides it.
 */

/** Calls `load` every `everyMs` while it is a number; null stops. The first load is the caller's. */
function usePoll(load: () => Promise<void>, everyMs: number | null) {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (everyMs === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await latest.current().catch(() => undefined);
      if (!stopped) timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, everyMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [everyMs]);
}

/** GET /api/conversations, refreshed on demand and every 3 s while one of them is waiting for Pointer. */
export function useConversations() {
  const [items, setItems] = useState<ConversationSummary[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const data = await api.get<ConversationList>("/api/conversations");
      setItems(data.conversations);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  usePoll(load, items?.some((c) => c.pending) ? 3000 : null);
  return { items, error, refresh: load };
}

export type ConversationState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; error: string }
  | { status: "ready"; view: ConversationView };

/**
 * One conversation, polled every second while Pointer answers and every two
 * while a repo task started in it runs. `onSettled` runs when Pointer's answer
 * arrives (so the list can update its "answering" marker).
 */
export function useConversation(id: string, onSettled?: () => void) {
  const [state, setState] = useState<ConversationState>({ status: "loading" });
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const wasPending = useRef(false);

  const load = useCallback(async () => {
    try {
      const view = await api.get<ConversationView>(`/api/conversations/${encodeURIComponent(id)}`);
      const pending = view.conversation.pending || Boolean(view.live);
      if (wasPending.current && !pending) settled.current?.();
      wasPending.current = pending;
      setState({ status: "ready", view });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setState({ status: "missing" });
      else setState((s) => (s.status === "ready" ? s : { status: "error", error: errorMessage(err) }));
    }
  }, [id]);

  useEffect(() => {
    setState({ status: "loading" });
    wasPending.current = false;
    void load();
  }, [load]);

  const view = state.status === "ready" ? state.view : undefined;
  const answering = Boolean(view && (view.conversation.pending || view.live));
  const working = Boolean(view?.tasks.some(isActiveTask));
  usePoll(load, answering ? 1000 : working ? 2000 : null);

  /** Shows a just-sent message right away (the server's answer is the conversation). */
  const replace = useCallback((conversation: ConversationView["conversation"]) => {
    wasPending.current = conversation.pending;
    setState((s) => (s.status === "ready" ? { status: "ready", view: { ...s.view, conversation } } : s));
  }, []);

  return { state, refresh: load, replace };
}

/** A task's timeline (GET /api/tasks/:id/events), polled every 2 s while the task runs and `enabled`. */
export function useTaskTimeline(task: Pick<Task, "id" | "status">, enabled: boolean) {
  const [timeline, setTimeline] = useState<TaskTimeline | null>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const data = await api.get<TaskEventsView>(`/api/tasks/${encodeURIComponent(task.id)}/events`);
      setTimeline(data.timeline);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [task.id]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, task.status]);
  usePoll(load, enabled && isActiveTask(task) ? 2000 : null);
  return { timeline, error };
}

export interface Shot {
  name: string;
  size: number;
  src: string;
}

/** A task's screenshots, re-read whenever the task says it has more. */
export function useScreenshots(taskId: string, count: number | undefined) {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    if (!count) return;
    let cancelled = false;
    api
      .get<ScreenshotList>(`/api/tasks/${encodeURIComponent(taskId)}/screenshots`)
      .then((data) => {
        if (cancelled) return;
        setShots(
          data.screenshots.map((s) => ({
            ...s,
            src: `/api/tasks/${encodeURIComponent(taskId)}/screenshots/${encodeURIComponent(s.name)}`,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, count]);
  return shots;
}

/** GET /api/chat/options: the file limits and the voice transcription service, read once per mount. */
export function useChatOptions(): ChatOptions {
  const [options, setOptions] = useState<ChatOptions>(DEFAULT_OPTIONS);
  useEffect(() => {
    let cancelled = false;
    loadChatOptions()
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

/** Recent tasks (GET /api/tasks), for repository suggestions. Loaded once when asked for. */
export function useRecentTasks(enabled: boolean) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<{ tasks: Task[] }>("/api/tasks")
      .then((data) => {
        if (!cancelled) setTasks(data.tasks);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return tasks;
}
