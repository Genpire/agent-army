/**
 * The owner's Google account through the connected Gmail and Google Calendar
 * apps (config.apps with presetId "gmail" / "google-calendar"): their OAuth
 * tokens (apps-oauth.ts freshAccessToken) read the Gmail and Calendar APIs
 * directly, for follow-ups (src/followups/types.ts) and Pointer's tools.
 *
 * - gmail.ts: the inbox threads from people, and whether the owner answered.
 * - calendar.ts: the events of the primary calendar in a range.
 * - tools.ts: gmail_my_inbox and calendar_agenda, for the owner's own requests.
 * - workspace-mcp.ts: what Google's Workspace MCP servers need when they refuse a signed-in app.
 */
import type { ChatIntegration, ChatIntegrationContext } from "../../chat/chat-integrations.js";
import type { Config } from "../../core/config.js";
import { type GoogleCalendarSource, googleCalendarSource as calendarSource } from "./calendar.js";
import { type GmailSource, gmailSource as mailSource } from "./gmail.js";
import type { GoogleDeps } from "./google-api.js";
import { googleToolIntegrations } from "./tools.js";

export type { GoogleDeps } from "./google-api.js";
export type { GmailSource, GmailInbox } from "./gmail.js";
export type { GoogleCalendarSource } from "./calendar.js";

/** The owner's calendar, through the connected Google Calendar app. */
export function googleCalendarSource(deps: GoogleDeps): GoogleCalendarSource {
  return calendarSource(deps);
}

/** The owner's mail, through the connected Gmail app. `ready()` is false while following Gmail is off (config.followups.trackGmail). */
export function gmailSource(deps: GoogleDeps): GmailSource {
  return mailSource(deps);
}

/** Pointer's Gmail and Calendar tools, for the owner's own conversations and routines. `deps` replaces the network in tests. */
export function googleChatIntegrations(config: Config, ctx: ChatIntegrationContext, deps: Omit<GoogleDeps, "configRepo"> = {}): ChatIntegration[] {
  return googleToolIntegrations(config, ctx, deps);
}
