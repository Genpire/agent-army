/**
 * Apps connected through their remote MCP servers (config.apps): what Pointer
 * and the agents get in chat and in repo tasks. Placeholder until the Apps
 * work package replaces it.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ChatIntegration, ChatIntegrationContext } from "./chat-integrations.js";
import type { Config, ConfigRepo } from "./config.js";

/** The apps of a repo task: one MCP server per app, and which full tool names each agent may call. */
export interface RepoTaskApps {
  /** Server key (mcp__<key>__…) → server config. */
  servers: Record<string, McpServerConfig>;
  /** Full tool names an agent (by id) may call; [] when it has no apps. */
  toolsFor(agentId: string): string[];
  /** Every tool name any agent may call, for allowedTools. */
  allToolNames: string[];
  /** Lines for the orchestrator's instructions: which apps exist and who has them. */
  promptRule: string;
}

export async function appChatIntegrations(_config: Config, _ctx: ChatIntegrationContext): Promise<ChatIntegration[]> {
  return [];
}

/** Undefined when no enabled app is assigned to an enabled agent. */
export async function repoTaskApps(_config: Config, _deps: { configRepo?: ConfigRepo; redact: (text: string) => string }): Promise<RepoTaskApps | undefined> {
  return undefined;
}
