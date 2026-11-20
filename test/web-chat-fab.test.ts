import { describe, expect, it } from "vitest";
import { hasChatFab, shouldShowChatFab } from "../web/src/pages/chat/fab.js";
import { PAGES } from "../web/src/lib/router.js";

describe("the floating chat button", () => {
  const elsewhere = ["overview", "office", "team", "skills", "integrations", "projects", "activity", "memory", "settings"] as const;

  it.each(elsewhere)("shows on %s", (page) => {
    expect(shouldShowChatFab(page, false)).toBe(true);
  });

  it("shows on every console page but Chat", () => {
    expect(PAGES.filter((page) => shouldShowChatFab(page, false))).toEqual([...elsewhere].sort((a, b) => PAGES.indexOf(a) - PAGES.indexOf(b)));
  });

  it("hides on the Chat page, which already is the chat", () => {
    expect(shouldShowChatFab("chat", false)).toBe(false);
  });

  it("hides while the chat window is open, wherever it was opened", () => {
    for (const page of PAGES) expect(shouldShowChatFab(page, true)).toBe(false);
  });

  it("leaves room for itself on exactly the pages it shows on, whether or not the window is open", () => {
    for (const page of PAGES) expect(hasChatFab(page)).toBe(shouldShowChatFab(page, false));
  });
});
