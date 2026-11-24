import { linkSource } from "./links.js";

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
 * message) cannot close or hide the owner's items. Adding is gated only for
 * some inputs (followupAddNeedsYes).
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

/** Where an item Pointer found came from: what an add may say without the owner's yes after outside content. */
const FOUND_SOURCES: ReadonlySet<string> = new Set(["slack", "gmail", "calendar", "pointer"]);

/**
 * Whether followups_add with this input needs the owner's yes once the turn
 * has read outside content (confirm-gate.ts, in the owner's conversation):
 * when it adds the item as the owner's own (source "owner", or none, which
 * means the owner), so it would be shown without a source like one they
 * asked for; with a reminder (remind_at, repeat_min), so it would nag them
 * on its own; or with a link that is not a real source's (a Slack
 * permalink, a Gmail thread, a calendar event: links.ts), so a planted
 * message cannot put its own link in the brief as something Pointer found.
 * What Pointer found, labelled with its source, without a reminder and
 * linking to where it is, goes straight in: listing it is what reading the
 * inbox is for. A routine run never gets this far: its tool refuses
 * "owner", sets no reminder and leaves such a link out (tools.ts).
 */
export function followupAddNeedsYes(input: unknown): boolean {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof args.source !== "string" || !FOUND_SOURCES.has(args.source)) return true;
  if (args.remind_at !== undefined && args.remind_at !== null && String(args.remind_at).trim() !== "") return true;
  if (args.link !== undefined && args.link !== null && args.link !== "" && linkSource(String(args.link)) === undefined) return true;
  return args.repeat_min !== undefined && args.repeat_min !== null && args.repeat_min !== 0;
}
