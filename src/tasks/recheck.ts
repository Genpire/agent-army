import type { RecheckContext } from "../team/agents.js";

/**
 * The platform's own run of the checks after the team finishes: the agents'
 * report says which checks passed; the worker runs them again (or the owner's
 * test command) and shows the real results next to the claims. (Contract
 * stub: the runner and the prompt section are filled in by the recheck work.)
 */

/** The orchestrator prompt's section on the checks the platform runs again; "" when it does not. */
export function recheckSection(recheck: RecheckContext | undefined): string {
  if (!recheck) return "";
  return "";
}
