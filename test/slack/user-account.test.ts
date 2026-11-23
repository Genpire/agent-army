import { describe, expect, it } from "vitest";
import { ConfigSchema, publicView } from "../../src/core/config.js";
import { ownSlackAccount, ownerConversation, ownerRoutine } from "../../src/slack/user-account.js";

const OWNER = "U0OWNER01";
const withAccount = (patch: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    slack: {
      botToken: "xoxb-bot",
      signingSecret: "s",
      user: { token: "xoxp-owner-secret-123456", userId: OWNER, userName: "dana", connectedAt: "2026-11-23T10:00:00Z", ...patch },
    },
  });

describe("the owner's own Slack account", () => {
  it("is the owner's alone: the console, their DM with Pointer, and their own routines", () => {
    const config = withAccount();
    expect(ownSlackAccount(config, { surface: "web", userId: "admin" })).toMatchObject({ userId: OWNER, sendAsMe: true, listen: true });
    expect(ownSlackAccount(config, { surface: "slack", userId: OWNER, channelType: "im" })).toMatchObject({ token: "xoxp-owner-secret-123456" });
    expect(ownSlackAccount(config, { userId: OWNER, channelType: "im" })).toBeDefined();
    // Anyone else on Slack never gets it, in a DM or anywhere.
    expect(ownSlackAccount(config, { surface: "slack", userId: "U0SOMEONE", channelType: "im" })).toBeUndefined();
    expect(ownSlackAccount(config, { userId: "U0SOMEONE", channelType: "im" })).toBeUndefined();
    // A routine the runner found the owner's reads, never sends as the owner.
    expect(ownSlackAccount(config, { surface: "routine", userId: "routine", ownerRoutine: true })).toMatchObject({ sendAsMe: false, listen: true });
  });

  it("is not the owner's in a channel thread or a group DM, even from the owner: other people's messages are in the prompt there", () => {
    const config = withAccount();
    for (const channelType of ["channel", "group", "mpim", "unknown"] as const) {
      expect(ownSlackAccount(config, { surface: "slack", userId: OWNER, channelType }), channelType).toBeUndefined();
      expect(ownerConversation(config, { surface: "slack", userId: OWNER, channelType }), channelType).toBe(false);
    }
    // Without a channel type, a Slack request is not known to be their DM.
    expect(ownSlackAccount(config, { userId: OWNER })).toBeUndefined();
  });

  it("is never a routine's unless the runner found the routine the owner's", () => {
    const config = withAccount();
    expect(ownSlackAccount(config, { surface: "routine", userId: "routine" })).toBeUndefined();
    expect(ownSlackAccount(config, { surface: "routine", userId: "routine", ownerRoutine: false })).toBeUndefined();
    // ownerRoutine means nothing outside a routine run: a Slack request still needs the owner's DM.
    expect(ownSlackAccount(config, { surface: "slack", userId: "U0SOMEONE", channelType: "channel", ownerRoutine: true })).toBeUndefined();
  });

  it("follows the owner's switches, and is absent when not connected", () => {
    expect(ownSlackAccount(withAccount({ sendAsMe: false }), { surface: "web", userId: "admin" })?.sendAsMe).toBe(false);
    expect(ownSlackAccount(ConfigSchema.parse({}), { surface: "web", userId: "admin" })).toBeUndefined();
    expect(ownSlackAccount(ConfigSchema.parse({}), { surface: "routine", userId: "routine", ownerRoutine: true })).toBeUndefined();
  });

  it("never shows the token to the browser", () => {
    const view = publicView(withAccount());
    expect(JSON.stringify(view)).not.toContain("xoxp-owner-secret-123456");
    expect(view.slack.user).toMatchObject({ connected: true, userId: OWNER, userName: "dana" });
    expect(publicView(ConfigSchema.parse({})).slack.user).toEqual({ connected: false });
  });
});

describe("the owner's own conversation", () => {
  it("is the console, or the owner's DM with Pointer; never a routine run", () => {
    const config = withAccount();
    expect(ownerConversation(config, { surface: "web", userId: "admin" })).toBe(true);
    expect(ownerConversation(config, { surface: "slack", userId: OWNER, channelType: "im" })).toBe(true);
    expect(ownerConversation(config, { surface: "slack", userId: "U0MALLORY", channelType: "im" })).toBe(false);
    expect(ownerConversation(config, { surface: "routine", userId: "routine", ownerRoutine: true })).toBe(false);
    // Not connected: the console is still the owner's, Slack is nobody's.
    expect(ownerConversation(ConfigSchema.parse({}), { surface: "web", userId: "admin" })).toBe(true);
    expect(ownerConversation(ConfigSchema.parse({}), { surface: "slack", userId: OWNER, channelType: "im" })).toBe(false);
  });
});

describe("the owner's routine", () => {
  const deliver = (patch: Partial<{ email: string[]; slack: string; console: boolean }> = {}) => ({ email: [], slack: "", console: true, ...patch });

  it("is marked ownerOnly and reports to the owner alone: their own Slack id or none, the console, no email", () => {
    const config = withAccount();
    expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver() })).toBe(true);
    expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver({ slack: OWNER }) })).toBe(true);
    expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver({ slack: OWNER, console: false }) })).toBe(true);
  });

  it("is not without the mark, with anyone else on Slack, or with any email recipient", () => {
    const config = withAccount();
    expect(ownerRoutine(config, { deliver: deliver({ slack: OWNER }) })).toBe(false);
    expect(ownerRoutine(config, { ownerOnly: false, deliver: deliver({ slack: OWNER }) })).toBe(false);
    for (const slack of ["U0MALLORY", "C0GENERAL", "D0OWNERDM"]) {
      expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver({ slack }) }), slack).toBe(false);
    }
    expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver({ email: ["owner@example.com"] }) })).toBe(false);
    expect(ownerRoutine(config, { ownerOnly: true, deliver: deliver({ slack: OWNER, email: ["mallory@example.com"] }) })).toBe(false);
    // No account connected: nothing to read.
    expect(ownerRoutine(ConfigSchema.parse({}), { ownerOnly: true, deliver: deliver() })).toBe(false);
  });
});
