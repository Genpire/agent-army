/**
 * Coding agent CLIs the team can hand work to in repo tasks (config.engines):
 * OpenAI's Codex and Google's Gemini CLI, run headless in the task's checkout.
 * An agent whose engine is "codex" or "gemini" is a light Claude subagent
 * whose one job is to hand its assignment to that CLI and report back.
 *
 * Placeholder until the engines work package replaces it.
 */
import type { AgentDefinition, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Config, EngineId } from "./config.js";
import type { AgentSpec } from "./team.js";

/** What a repo task gets for its engine agents. */
export interface RepoTaskEngines {
  /** In-process MCP servers (Options.mcpServers, top level), by key. */
  servers: Record<string, McpServerConfig>;
  /** The subagent for an agent whose engine is not "claude"; undefined when its engine is not connected. */
  agentDefinition(agent: AgentSpec, base: AgentDefinition): AgentDefinition | undefined;
  /** Every tool name engine agents may call, for allowedTools. */
  allToolNames: string[];
  /** Lines for the orchestrator's instructions: which agents work through which CLI. */
  promptRule: string;
}

export interface EngineDeps {
  repoDir: string;
  /** A private folder next to the checkout for the CLIs' homes. */
  workRoot: string;
  redact: (text: string) => string;
  /** Adds a line to the task's timeline (the console's Activity). */
  note: (text: string) => void;
}

/** The connected engines, by id. */
export const connectedEngines = (config: Config): EngineId[] => (["codex", "gemini"] as const).filter((id) => Boolean(config.engines[id].apiKey));

/** Undefined when no enabled agent uses a connected engine. */
export async function repoTaskEngines(_config: Config, _deps: EngineDeps): Promise<RepoTaskEngines | undefined> {
  return undefined;
}
