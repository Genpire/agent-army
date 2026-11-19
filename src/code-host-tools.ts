/**
 * Pointer's read-only GitLab and Bitbucket tools (gitlab_*, bitbucket_*), the
 * counterparts of the github_* tools in pointer-tools.ts. Placeholder until the
 * code-host tools work package replaces it.
 */
import type { ChatIntegration, ChatIntegrationContext } from "./chat-integrations.js";
import type { Config } from "./config.js";

export function codeHostChatIntegrations(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration[] {
  return [];
}
