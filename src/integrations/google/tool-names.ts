/**
 * The names of Pointer's Gmail and Calendar tools (tools.ts), apart so the
 * confirmation gate and the brain can name them without loading the tools.
 */

export const GMAIL_SERVER_KEY = "gmail_inbox";
export const GMAIL_INBOX_TOOL = "gmail_my_inbox";
export const GMAIL_INBOX_TOOL_NAME = `mcp__${GMAIL_SERVER_KEY}__${GMAIL_INBOX_TOOL}`;

export const CALENDAR_SERVER_KEY = "google_calendar";
export const CALENDAR_AGENDA_TOOL = "calendar_agenda";
export const CALENDAR_AGENDA_TOOL_NAME = `mcp__${CALENDAR_SERVER_KEY}__${CALENDAR_AGENDA_TOOL}`;

/** The owner's own mail and calendar: read by Pointer itself, never by a subagent. */
export const GOOGLE_OWNER_TOOL_NAMES: readonly string[] = [GMAIL_INBOX_TOOL_NAME, CALENDAR_AGENDA_TOOL_NAME];
