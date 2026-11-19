/**
 * Miro: the client and Pointer's miro_* tools. Placeholder until the Miro
 * work package replaces it.
 */
import type { ChatIntegration, ChatIntegrationContext } from "./chat-integrations.js";
import type { Config } from "./config.js";

export function miroChatIntegration(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration | undefined {
  return undefined;
}
