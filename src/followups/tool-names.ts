/** The names of Pointer's follow-up tools (the "followups" MCP server), for the chat integration and the confirm gate. */
export const FOLLOWUPS_SERVER_KEY = "followups";
export const FOLLOWUP_TOOLS = ["followups_list", "followups_add", "followups_done", "followups_snooze", "followups_update"] as const;
export type FollowupTool = (typeof FOLLOWUP_TOOLS)[number];

export const followupToolName = (tool: FollowupTool) => `mcp__${FOLLOWUPS_SERVER_KEY}__${tool}`;

export const FOLLOWUPS_LIST_TOOL = followupToolName("followups_list");
export const FOLLOWUPS_ADD_TOOL = followupToolName("followups_add");

/**
 * Closing, snoozing and changing an item: gated after outside content
 * (confirm-gate.ts), so that something Pointer read (an email, a Slack
 * message) cannot close or hide the owner's items. Adding is not: it only
 * adds to the owner's own list, and an item Pointer found says where from.
 */
export const FOLLOWUP_GATED_TOOLS = (["followups_done", "followups_snooze", "followups_update"] as const).map(followupToolName);

/**
 * The follow-up tools whose output is only what Pointer wrote, numbers and
 * times: calling them never taints a query. followups_list is not among
 * them: it shows titles found in other people's messages.
 */
export const FOLLOWUP_TRUSTED_TOOLS = [FOLLOWUPS_ADD_TOOL, ...FOLLOWUP_GATED_TOOLS];

/** Every follow-up tool: the owner's own list, never a subagent's. */
export const FOLLOWUP_TOOL_NAMES = FOLLOWUP_TOOLS.map(followupToolName);
