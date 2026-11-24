/**
 * The owner's Google account through the connected Gmail and Google Calendar
 * apps (config.apps with presetId "gmail" / "google-calendar"): their OAuth
 * tokens (apps-oauth.ts freshAccessToken) read the Gmail and Calendar APIs
 * directly, for follow-ups (src/followups/types.ts) and Pointer's tools.
 *
 * Contract stubs: google/gmail.ts and google/calendar.ts fill these in.
 */
import type { ChatIntegration, ChatIntegrationContext } from "../../chat/chat-integrations.js";
import type { Config, ConfigRepo } from "../../core/config.js";
import type { CalendarSource, EmailSource } from "../../followups/types.js";

export interface GoogleDeps {
  configRepo: ConfigRepo;
  /** Tests: a fake. Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** The owner's calendar, through the connected Google Calendar app. */
export function googleCalendarSource(_deps: GoogleDeps): CalendarSource {
  return {
    ready: async () => false,
    eventsBetween: async () => {
      throw new Error("Google Calendar is not available yet.");
    },
  };
}

/** The owner's mail, through the connected Gmail app. */
export function gmailSource(_deps: GoogleDeps): EmailSource {
  return {
    ready: async () => false,
    threadsSince: async () => {
      throw new Error("Gmail is not available yet.");
    },
  };
}

/** Pointer's Gmail and Calendar tools, for the owner's own conversations. */
export function googleChatIntegrations(_config: Config, _ctx: ChatIntegrationContext): ChatIntegration[] {
  return [];
}
