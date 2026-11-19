/**
 * Jira Cloud and Confluence: the client and Pointer's jira_* / confluence_*
 * tools. Placeholder until the Jira work package replaces it.
 */
import type { ChatIntegration, ChatIntegrationContext } from "./chat-integrations.js";
import type { Config } from "./config.js";

export function jiraChatIntegration(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration | undefined {
  return undefined;
}
