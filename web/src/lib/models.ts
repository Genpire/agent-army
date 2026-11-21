/**
 * The model lists the pickers offer: an AI provider's
 * (GET /api/ai/providers/:id/models) or a coding engine's
 * (GET /api/engines/:id/models), loaded once a picker opens and shared by
 * every picker of the same source on the page. The server keeps each live
 * list for an hour; refresh reads it again.
 */
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { EngineId } from "./engines";
import type { AiProviderId, ModelList } from "./types";

/** Whose models a picker lists. */
export type ModelSource = { kind: "provider"; id: AiProviderId } | { kind: "engine"; id: EngineId };

export const sourceKey = (s: ModelSource): string => `${s.kind}:${s.id}`;

const listPath = (s: ModelSource, refresh: boolean) =>
  `${s.kind === "provider" ? `/api/ai/providers/${s.id}` : `/api/engines/${s.id}`}/models${refresh ? "?refresh=1" : ""}`;

/** One request per source for the page; a refresh replaces it, and every picker of the source hears the new list. */
const lists = new Map<string, Promise<ModelList>>();
const listeners = new Map<string, Set<(list: ModelList) => void>>();

export function loadModelList(source: ModelSource, refresh = false): Promise<ModelList> {
  const key = sourceKey(source);
  const known = lists.get(key);
  if (known && !refresh) return known;
  const request = api.get<ModelList>(listPath(source, refresh));
  lists.set(key, request);
  request.then(
    (list) => listeners.get(key)?.forEach((hear) => hear(list)),
    () => {
      if (lists.get(key) === request) lists.delete(key);
    },
  );
  return request;
}

/** Forgets the lists, after a connection changed (a new key can see other models). */
export function forgetModelLists(): void {
  lists.clear();
}

/** A source's list for one picker: nothing until load() (on open), then the list, kept in step with the other pickers. */
export function useModelList(source: ModelSource): {
  list: ModelList | undefined;
  loading: boolean;
  error: string | undefined;
  load: (refresh?: boolean) => Promise<ModelList | undefined>;
} {
  const key = sourceKey(source);
  const [state, setState] = useState<{ key: string; list?: ModelList; error?: string }>({ key });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const hear = (list: ModelList) => setState({ key, list });
    const set = listeners.get(key) ?? new Set();
    set.add(hear);
    listeners.set(key, set);
    return () => {
      set.delete(hear);
    };
  }, [key]);

  const { kind, id } = source;
  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const list = await loadModelList({ kind, id } as ModelSource, refresh);
        setState({ key, list });
        return list;
      } catch (err) {
        setState({ key, error: errorMessage(err) });
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [key, kind, id],
  );

  // A picker that switched source (another provider) shows nothing of the old one's list.
  const current = state.key === key ? state : { key };
  return { list: current.list, loading, error: current.error, load };
}
