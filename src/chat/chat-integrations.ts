/**
 * The integrations Pointer uses in chat beyond its own tool server
 * (pointer-tools.ts: GitHub, memory, notes, monday.com, repo tasks): GitLab
 * and Bitbucket code tools, Jira and Confluence, Miro, and apps connected
 * through their MCP servers. Each one brings an MCP server (in-process or
 * remote), the tool names Pointer may call, the read-only ones its chat
 * subagents may call, and a rule for Pointer's instructions.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { appChatIntegrations } from "../integrations/apps/apps.js";
import { codeHostChatIntegrations } from "../integrations/code-hosts/code-host-tools.js";
import type { Config, ConfigRepo } from "../core/config.js";
import { jiraChatIntegration } from "../integrations/jira/jira.js";
import { miroChatIntegration } from "../integrations/miro/miro.js";
import type { AddAttachment } from "./pointer-types.js";

export interface ChatIntegration {
  /** The MCP server's key in Options.mcpServers; tool names are mcp__<key>__<tool>. */
  key: string;
  /** Absent when the integration is not connected: only its rule goes into the prompt. */
  server?: McpServerConfig;
  /** Full tool names (mcp__<key>__<tool>) Pointer may call. */
  allToolNames: string[];
  /** Full tool names chat subagents may call: read-only ones only. */
  readOnlyToolNames: string[];
  /** One or more "- …" lines for the Rules section of Pointer's instructions. */
  promptRule: string;
  /**
   * Team agents (ids) that also get this integration's read-only tools as
   * subagents in chat; absent = every agent gets readOnlyToolNames.
   */
  agentIds?: string[];
}

export interface ChatIntegrationContext {
  configRepo: ConfigRepo;
  /** Who is asking (Slack user name or id, or the console's owner): recorded on tickets and stickies created. */
  requester: string;
  /** Stores a file in this conversation (e.g. a Jira issue's attachments); absent = not available here. */
  addAttachment?: AddAttachment;
  redact: (text: string) => string;
}

/**
 * Every integration beyond Pointer's own tool server. An integration that
 * cannot be built (an app's sign-in expired, a server unreachable) is left
 * out with its reason as a prompt rule, so one broken app never breaks chat.
 */
export async function chatIntegrations(config: Config, ctx: ChatIntegrationContext): Promise<ChatIntegration[]> {
  const out: ChatIntegration[] = [];
  const add = async (name: string, build: () => ChatIntegration | ChatIntegration[] | undefined | Promise<ChatIntegration | ChatIntegration[] | undefined>) => {
    try {
      const built = await build();
      if (!built) return;
      out.push(...(Array.isArray(built) ? built : [built]));
    } catch (err) {
      console.warn(`[pointer] ${name} tools not available:`, ctx.redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
    }
  };
  await add("GitLab/Bitbucket", () => codeHostChatIntegrations(config, ctx));
  await add("Jira", () => jiraChatIntegration(config, ctx));
  await add("Miro", () => miroChatIntegration(config, ctx));
  await add("apps", () => appChatIntegrations(config, ctx));
  return out;
}

/** Tool names a chat subagent may call from these integrations. */
export function subagentIntegrationTools(integrations: ChatIntegration[], agentId?: string): string[] {
  return integrations.filter((i) => !i.agentIds || (agentId !== undefined && i.agentIds.includes(agentId))).flatMap((i) => i.readOnlyToolNames);
}
