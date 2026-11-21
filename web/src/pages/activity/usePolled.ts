import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import type { UsageView } from "../../../../src/spending/budget.js";
import type { Task } from "../../lib/types";

export interface Polled<T> {
  /** Undefined until the first answer. */
  data: T | undefined;
  /** The last load's error, when it failed (the previous data is kept). */
  error: string | undefined;
  /** When the data was last read, in ms. */
  loadedAt: number | undefined;
  reload: () => Promise<void>;
}

/**
 * GETs `path` now and every `everyMs` while the page is open and visible
 * (a hidden tab skips its turns and reloads as soon as it is shown again).
 */
export function usePolled<T>(path: string, everyMs: number): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<number>();
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await api.get<T>(path));
      setError(undefined);
      setLoadedAt(Date.now());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
    }
  }, [path]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, everyMs);
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, everyMs]);

  return { data, error, loadedAt, reload };
}

/** How often the pages re-read the tasks: running tasks update their progress about this often. */
export const TASKS_EVERY_MS = 10_000;
/** Spend changes only when a task or chat reply finishes. */
export const USAGE_EVERY_MS = 60_000;

/** GET /api/tasks: the 30 most recent repo tasks, newest first. */
export function useTasks(): Polled<Task[]> {
  const polled = usePolled<{ tasks: Task[] }>("/api/tasks", TASKS_EVERY_MS);
  return { ...polled, data: polled.data?.tasks };
}

/** GET /api/usage: Claude spend this calendar month (UTC), per agent and provider too. */
export const useUsage = (): Polled<UsageView> => usePolled<UsageView>("/api/usage", USAGE_EVERY_MS);
