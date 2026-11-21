/**
 * Company data sources (config.dataSources): HTTP APIs read with GET and
 * Postgres databases read in read-only transactions, as Pointer's tools.
 * Placeholder until the data sources work package replaces it.
 */
import type { ChatIntegration, ChatIntegrationContext } from "../../chat/chat-integrations.js";
import type { Config } from "../../core/config.js";

export function dataSourcesChatIntegration(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration | undefined {
  return undefined;
}
