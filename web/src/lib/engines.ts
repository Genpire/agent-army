/**
 * Who does an agent's repo-task work (AgentSpec.engine): Claude, or a coding
 * agent CLI it hands the work to (Codex, Gemini CLI; src/ai/engines.ts). Names
 * as the console shows them.
 */
import type { AgentSpec, PublicConfig } from "./types";

export type AgentEngine = AgentSpec["engine"];
/** The coding agent CLIs (config.engines). */
export type EngineId = Exclude<AgentEngine, "claude">;

export const ENGINE_NAME: Record<AgentEngine, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini CLI" };

/** What each engine is, under its name in the pickers. */
export const ENGINE_DESCRIPTION: Record<AgentEngine, string> = { claude: "The team's model", codex: "OpenAI's coding agent CLI", gemini: "Google's coding agent CLI" };

/** The engines in the order the pickers offer them (checked against the server's list). */
export const AGENT_ENGINE_OPTIONS = ["claude", "codex", "gemini"] as const satisfies readonly AgentEngine[];

/** One engine taking over from an agent's own (AgentSpec.fallback): the engine and the model its CLI runs ("" = the engine's own). */
export type AgentFallback = AgentSpec["fallback"][number];

export const isAgentEngine = (value: string): value is AgentEngine => Object.hasOwn(ENGINE_NAME, value);

/** Whether an agent on this engine works through it now: Claude always; a CLI once it is connected. */
export const engineReady = (config: PublicConfig, engine: AgentEngine): boolean => engine === "claude" || config.engines[engine].connected;

/**
 * The engine a new fallback starts on: not the agent's own and not in the
 * list yet; a connected CLI first (Claude is the last resort anyway), then
 * Claude, then a CLI that is not connected. Undefined when none is left.
 */
export function nextFallbackEngine(own: AgentEngine, taken: readonly AgentEngine[], isReady: (engine: AgentEngine) => boolean): AgentEngine | undefined {
  const free = AGENT_ENGINE_OPTIONS.filter((e) => e !== own && !taken.includes(e));
  return free.find((e) => e !== "claude" && isReady(e)) ?? free.find((e) => e === "claude") ?? free[0];
}
