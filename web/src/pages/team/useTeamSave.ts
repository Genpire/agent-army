import { useCallback, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { Team } from "../../lib/types";

/**
 * Saves the team. POST /api/team replaces the whole team, so every change is
 * applied to the latest team: saves run one after another, each on the result
 * of the one before, and toggling two agents quickly cannot undo the first
 * toggle. Throws the server's error (for useAction's toast); re-reads the
 * configuration after each save.
 */
export function useTeamSave(): (change: (team: Team) => Team) => Promise<void> {
  const { config, refresh } = useConfig();
  const latest = useRef<Team>(config.team);
  const running = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (running.current === 0) latest.current = config.team;
  }, [config.team]);

  return useCallback(
    async (change) => {
      running.current++;
      const job = queue.current.then(async () => {
        const next = change(latest.current);
        await api.post("/api/team", { pointer: next.pointer, agents: next.agents });
        latest.current = next;
      });
      queue.current = job.catch(() => undefined);
      try {
        await job;
      } finally {
        running.current--;
      }
      await refresh();
    },
    [refresh],
  );
}
