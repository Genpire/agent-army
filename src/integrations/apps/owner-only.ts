/**
 * Apps only the owner may use ("Only for me"): an app that acts as the
 * owner's own account (their mail, calendar, files) is offered only in the
 * owner's own requests: the console, their DM with Pointer, and a routine
 * they made that reports to them alone (ownerRequest in
 * slack/user-account.ts). Never in a channel, a thread, a group DM or anyone
 * else's DM, never to a team member and never in a repo task, whatever
 * agents it is assigned to.
 *
 * The owner sets it on the app (AppConnection.ownerOnly). Unset, Google's
 * Workspace MCP servers are owner-only (they act as the signed-in person),
 * every other app is not.
 */
import type { AppConnection } from "../../core/config.js";
import { workspaceMcpProduct } from "../google/workspace-mcp.js";

/** Catalog presets that sign in as the owner's own Google account. */
export const PERSONAL_PRESETS: ReadonlySet<string> = new Set(["gmail", "google-calendar", "google-drive"]);

/** Whether only the owner may use the app: its own setting, else whether it is a personal Google Workspace server. */
export function appOwnerOnly(app: Pick<AppConnection, "ownerOnly" | "presetId" | "url">): boolean {
  if (app.ownerOnly !== undefined) return app.ownerOnly;
  return (app.presetId !== undefined && PERSONAL_PRESETS.has(app.presetId)) || workspaceMcpProduct(app.url) !== undefined;
}

/** Workspace MCP servers whose tools read messages other people sent the owner: Gmail and Google Chat. */
const INBOX_HOSTS: ReadonlySet<string> = new Set(["gmailmcp.googleapis.com", "chatmcp.googleapis.com"]);

/**
 * Whether the app reads the owner's inbox (Gmail, Google Chat): its tools
 * are then gated like the owner's Slack inbox (afterInboxGate): once one
 * is called, nothing can carry what it returned out of the reply.
 */
export function appReadsInbox(app: Pick<AppConnection, "presetId" | "url">): boolean {
  if (app.presetId === "gmail") return true;
  try {
    const u = new URL(app.url);
    return workspaceMcpProduct(app.url) !== undefined && INBOX_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
