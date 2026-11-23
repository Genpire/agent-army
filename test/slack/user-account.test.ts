import { describe, expect, it } from "vitest";
import { ConfigSchema, publicView } from "../../src/core/config.js";
import { ownSlackAccount } from "../../src/slack/user-account.js";

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
  it("is the owner's alone: the console, routines, and Slack only from that same user", () => {
    const config = withAccount();
    expect(ownSlackAccount(config, { surface: "web", userId: "admin" })).toMatchObject({ userId: OWNER, sendAsMe: true, listen: true });
    expect(ownSlackAccount(config, { surface: "slack", userId: OWNER })).toMatchObject({ token: "xoxp-owner-secret-123456" });
    expect(ownSlackAccount(config, { userId: OWNER })).toBeDefined();
    // Anyone else on Slack never gets it.
    expect(ownSlackAccount(config, { surface: "slack", userId: "U0SOMEONE" })).toBeUndefined();
    expect(ownSlackAccount(config, { userId: "U0SOMEONE" })).toBeUndefined();
    // A routine reads, never sends as the owner.
    expect(ownSlackAccount(config, { surface: "routine", userId: "routine" })).toMatchObject({ sendAsMe: false, listen: true });
  });

  it("follows the owner's switches, and is absent when not connected", () => {
    expect(ownSlackAccount(withAccount({ sendAsMe: false }), { surface: "web", userId: "admin" })?.sendAsMe).toBe(false);
    expect(ownSlackAccount(ConfigSchema.parse({}), { surface: "web", userId: "admin" })).toBeUndefined();
  });

  it("never shows the token to the browser", () => {
    const view = publicView(withAccount());
    expect(JSON.stringify(view)).not.toContain("xoxp-owner-secret-123456");
    expect(view.slack.user).toMatchObject({ connected: true, userId: OWNER, userName: "dana" });
    expect(publicView(ConfigSchema.parse({})).slack.user).toEqual({ connected: false });
  });
});
