import type { Page } from "../../lib/router";

/**
 * Whether a page has the floating "Open chat" button: every console page but
 * Chat itself, which already is the chat. Pages that have it leave room for it
 * at the end of their scroll (see PageFrame), so it never covers their content.
 */
export function hasChatFab(page: Page): boolean {
  return page !== "chat";
}

/**
 * Whether the floating "Open chat" button shows: on every page that has it
 * (see hasChatFab), and not while the chat window is open.
 */
export function shouldShowChatFab(page: Page, isOpen: boolean): boolean {
  return hasChatFab(page) && !isOpen;
}
