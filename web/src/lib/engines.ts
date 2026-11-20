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

export const isAgentEngine = (value: string): value is AgentEngine => Object.hasOwn(ENGINE_NAME, value);

/** Whether an agent on this engine works through it now: Claude always; a CLI once it is connected. */
export const engineReady = (config: PublicConfig, engine: AgentEngine): boolean => engine === "claude" || config.engines[engine].connected;
