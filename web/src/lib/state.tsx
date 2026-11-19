import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, onUnauthorized } from "./api";
import type { AppState, PublicConfig } from "./types";

interface AppStateValue {
  /** Undefined until the first load. */
  state: AppState | undefined;
  /** Error from the last load, when the server could not be reached. */
  loadError: string | undefined;
  /** Re-reads /api/state; call it after every save so the page shows what the server stored. */
  refresh: () => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>();
  const [loadError, setLoadError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setState(await api.get<AppState>("/api/state"));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onUnauthorized(() => setState((s) => (s ? { ...s, authed: false, config: undefined } : s)));
  }, [refresh]);

  const value = useMemo(() => ({ state, loadError, refresh }), [state, loadError, refresh]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState must be used inside AppStateProvider");
  return value;
}

/** The signed-in configuration. Pages render only when signed in, so it is always there for them. */
export function useConfig(): { config: PublicConfig; state: AppState; refresh: () => Promise<void> } {
  const { state, refresh } = useAppState();
  if (!state?.config) throw new Error("useConfig is only available when signed in");
  return { config: state.config, state, refresh };
}
