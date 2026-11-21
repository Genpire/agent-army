/**
 * Routines: work Pointer does on its own on a schedule (config.routines).
 * The scheduler runs due routines through Pointer's brain (read-only), and
 * delivers each report by email, Slack and the console. Placeholder until
 * the routines work package replaces it.
 */
import type { ChatIntegration, ChatIntegrationContext } from "../chat/chat-integrations.js";
import type { Config } from "../core/config.js";

/** Pointer's tools to create, list, change and run routines from a conversation. */
export function routinesChatIntegration(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration | undefined {
  return undefined;
}
