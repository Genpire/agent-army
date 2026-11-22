import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { AgentSpec } from "../../lib/types";
import { missingBuiltins } from "./team";

/**
 * The built-in agents the team does not have (GET /api/team/builtins, the
 * default team's agents), in the default team's order. A saved team keeps
 * its agents, so a role added in a later release, or a default the owner
 * deleted, is only offered here. Empty until loaded, and when it cannot load.
 */
export function useMissingBuiltins(takenIds: ReadonlySet<string>): AgentSpec[] {
  const [builtins, setBuiltins] = useState<AgentSpec[]>([]);

  useEffect(() => {
    let live = true;
    api
      .get<{ agents: AgentSpec[] }>("/api/team/builtins")
      .then(({ agents }) => live && setBuiltins(agents))
      // Optional: the page works without it.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => missingBuiltins(builtins, takenIds), [builtins, takenIds]);
}
