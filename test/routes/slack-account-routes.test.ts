import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Store } from "../../src/core/store.js";
import type { FollowupStore } from "../../src/followups/store.js";
import { createApp } from "../../src/server.js";
import { SLACK_USER_SCOPES } from "../../src/slack/user-account.js";

const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

/** Slack as each token sees it: the bot's workspace is T1. */
const ACCOUNTS: Record<string, { auth: Record<string, unknown> | string; person?: Record<string, unknown> }> = {
  "xoxp-good-token-1111": {
    auth: { user_id: "UOWN", user: "dana", team_id: "T1", response_metadata: { scopes: SLACK_USER_SCOPES.filter((s) => s !== "mpim:history") } },
    person: { name: "dana" },
  },
  "xoxp-other-workspace-2222": { auth: { user_id: "UOWN", team_id: "T2" } },
  "xoxp-looks-like-bot-3333": { auth: { user_id: "UB0T", team_id: "T1", bot_id: "B1" } },
  "xoxp-revoked-token-4444": { auth: "token_revoked" },
  "xoxp-workflow-bot-5555": { auth: { user_id: "UWF", team_id: "T1" }, person: { is_bot: true } },
  "xoxp-second-person-6666": { auth: { user_id: "UNEW", user: "sam", team_id: "T1", response_metadata: { scopes: [...SLACK_USER_SCOPES] } }, person: { name: "sam" } },
  // Slack does not answer when this one is revoked.
  "xoxp-stubborn-token-7777": { auth: { user_id: "USTB", user: "rita", team_id: "T1", response_metadata: { scopes: [...SLACK_USER_SCOPES] } }, person: { name: "rita" } },
};

/** The user tokens auth.revoke was called with. */
const revoked: string[] = [];

function fakeSlack(token: string) {
  if (token.startsWith("xoxb-")) {
    return {
      auth: { test: async () => ({ ok: true, user_id: "UTESTBOT", team_id: "T1" }), revoke: async () => Promise.reject(new Error("the bot's token is never revoked")) },
      users: { info: async () => ({ user: {} }) },
    };
  }
  const account = ACCOUNTS[token];
  return {
    auth: {
      test: async () => {
        if (!account) throw slackError("invalid_auth");
        if (typeof account.auth === "string") throw slackError(account.auth);
        return { ok: true, ...account.auth };
      },
      revoke: async () => {
        revoked.push(token);
        if (token === "xoxp-stubborn-token-7777") throw slackError("ratelimited");
        return { ok: true, revoked: true };
      },
    },
    users: { info: async () => ({ ok: true, user: account?.person ?? {} }) },
  };
}

/** The owner's Slack account routes through the real HTTP API (Slack faked). */
describe("the owner's Slack account API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  let store: Store;
  let followups: FollowupStore;
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie ? { cookie } : {} });
  const state = async () => (await get("/api/state")).json();
  const account = async () => (await state()).config.slack.user;
  const connect = async (token: string) => {
    const res = await post("/api/slack/user", { token });
    return { status: res.status, body: await res.json() };
  };
  const inboxBlob = async () => (await store.get("slack/inbox.enc"))?.length ?? null;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-slack-user-"));
    const app = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { slack: fakeSlack as never });
    store = app.store;
    followups = app.followups;
    const server = app.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" }, false);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    for (const path of ["/api/slack/user", "/api/slack/user/settings", "/api/slack/user/disconnect", "/api/slack/user/report"]) {
      expect((await post(path, {}, false)).status).toBe(401);
    }
    expect((await get("/api/slack/user/report", false)).status).toBe(401);
  });

  it("needs the bot connected first, then a user token", async () => {
    expect(await connect("xoxp-good-token-1111")).toEqual({ status: 400, body: { error: "Connect Slack's bot first: your account must be in the same workspace." } });
    expect((await (await get("/api/slack/user/report")).json()).blocked).toMatch(/^Connect Slack first/);

    process.env.SKIP_VALIDATION = "1";
    expect((await post("/api/slack", { botToken: "xoxb-bot-token-0000", signingSecret: "s".repeat(32) })).status).toBe(200);
    delete process.env.SKIP_VALIDATION;

    expect(await connect("xoxb-bot-token-0000")).toEqual({ status: 400, body: { error: "User tokens start with xoxp-. Copy the User OAuth Token from OAuth & Permissions." } });
    expect((await connect("xoxp-has a-space")).body.error).toBe("A Slack token has no spaces.");
    expect((await post("/api/slack/user", {})).status).toBe(400);
  });

  it("refuses tokens that are not a person's in the bot's workspace, never echoing them", async () => {
    const cases: [string, string][] = [
      ["xoxp-other-workspace-2222", "This token is for another Slack workspace than the bot's. Copy it from the same app, installed to the same workspace."],
      ["xoxp-looks-like-bot-3333", "That is a bot token. Paste the User OAuth Token (xoxp-…), not the Bot User OAuth Token."],
      ["xoxp-revoked-token-4444", "Slack rejected this token. Copy the User OAuth Token again from OAuth & Permissions."],
      ["xoxp-workflow-bot-5555", "This token does not belong to an active person in the workspace."],
    ];
    for (const [token, error] of cases) expect(await connect(token)).toEqual({ status: 400, body: { error } });
    expect(await account()).toEqual({ connected: false });
  });

  it("connects a person's token, shows it masked, and lists the scopes Slack did not grant", async () => {
    expect(await connect(" xoxp-good-token-1111 ")).toEqual({ status: 200, body: { ok: true, userId: "UOWN", userName: "dana", missingScopes: ["mpim:history"] } });
    const s = await state();
    expect(s.config.slack.user).toMatchObject({ connected: true, userId: "UOWN", userName: "dana", key: "••••1111", listen: true, sendAsMe: true, notifyAnswers: true });
    expect(JSON.stringify(s)).not.toContain("xoxp-good-token-1111");
  });

  it("turns listening and sending as the owner on and off, and keeps them on a reconnect", async () => {
    expect((await (await post("/api/slack/user/settings", {})).json()).error).toBe("Send listen, sendAsMe or notifyAnswers.");
    expect((await post("/api/slack/user/settings", { listen: "yes" })).status).toBe(400);
    expect((await post("/api/slack/user/settings", { notifyAnswers: "no" })).status).toBe(400);
    await store.put("slack/inbox.enc", "x");
    expect((await post("/api/slack/user/settings", { sendAsMe: false })).status).toBe(200);
    // Telling the owner of answers off keeps the inbox: the answers stay in it.
    expect((await post("/api/slack/user/settings", { notifyAnswers: false })).status).toBe(200);
    expect(await inboxBlob()).toBe(1);
    expect(await account()).toMatchObject({ notifyAnswers: false });
    expect(await inboxBlob()).toBe(1);
    // Reading off: what was kept is deleted.
    expect((await post("/api/slack/user/settings", { listen: false })).status).toBe(200);
    expect(await inboxBlob()).toBe(0);
    expect(await account()).toMatchObject({ listen: false, sendAsMe: false });
    // The same token again: nothing to revoke.
    expect((await connect("xoxp-good-token-1111")).body).not.toHaveProperty("previousRevoked");
    expect(revoked).toEqual([]);
    expect(await account()).toMatchObject({ listen: false, sendAsMe: false, notifyAnswers: false });
    expect((await (await get("/api/slack/user/report")).json()).blocked).toMatch(/^Turn on reading what reaches you/);
    expect((await post("/api/slack/user/report", {})).status).toBe(400);
    await post("/api/slack/user/settings", { listen: true, sendAsMe: true, notifyAnswers: true });
    expect(await account()).toMatchObject({ listen: true, sendAsMe: true, notifyAnswers: true });
  });

  it("creates the attention report once, on weekdays, to the owner's DM and the console", async () => {
    expect((await post("/api/settings", { timezone: "Europe/London" })).status).toBe(200);
    expect(await (await get("/api/slack/user/report")).json()).toEqual({ routine: null, blocked: null });
    const res = await post("/api/slack/user/report", {});
    expect(res.status).toBe(200);
    const { routine } = await res.json();
    expect(routine).toMatchObject({
      name: "Follow-ups digest",
      schedule: { cron: "0 9,13,17 * * 1-5", timezone: "Europe/London" },
      deliver: { email: [], slack: "UOWN", console: true },
      scheduleText: "Weekdays at 09:00, 13:00 and 17:00",
      enabled: true,
      ownerOnly: true,
    });
    expect(routine.instruction).toContain("slack_my_inbox");
    expect(routine.instruction).toContain("followups_add");
    const status = await (await get("/api/slack/user/report")).json();
    expect(status).toEqual({ routine: { id: routine.id, name: routine.name }, blocked: 'It already exists: "Follow-ups digest" on the Routines page.' });
    const again = await post("/api/slack/user/report", {});
    expect(again.status).toBe(409);
    const { routines } = await (await get("/api/routines")).json();
    expect(routines).toHaveLength(1);
    // Stored owner-only: only such a routine may read the owner's inbox.
    expect(routines[0]).toMatchObject({ id: routine.id, ownerOnly: true, deliver: { email: [], slack: "UOWN", console: true } });
  });

  it("starts an empty inbox for another person's account, revokes the token it replaces, and on disconnect", async () => {
    await store.put("slack/inbox.enc", "x");
    await connect("xoxp-good-token-1111");
    expect(await inboxBlob()).toBe(1);
    const second = await connect("xoxp-second-person-6666");
    expect(second).toMatchObject({ status: 200, body: { userId: "UNEW", previousRevoked: true } });
    expect(revoked).toEqual(["xoxp-good-token-1111"]);
    expect(await inboxBlob()).toBe(0);
    expect(await account()).toMatchObject({ userId: "UNEW", userName: "sam" });

    await store.put("slack/inbox.enc", "x");
    const res = await post("/api/slack/user/disconnect", {});
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(revoked).toEqual(["xoxp-good-token-1111", "xoxp-second-person-6666"]);
    expect(await inboxBlob()).toBe(0);
    expect(await account()).toEqual({ connected: false });
    expect((await post("/api/slack/user/settings", { listen: true })).status).toBe(404);
    expect((await (await get("/api/slack/user/report")).json()).blocked).toBe("Connect your Slack account first.");
  });

  it("takes the follow-ups and what the reminders remember with the account: another person starts without them, and without the calendar", async () => {
    const settings = async () => (await state()).config.followups;
    const remember = () =>
      followups.updateReminders((r) => ((r.briefDay = "2026-11-24"), (r.sent["meeting:ev:1"] = new Date().toISOString()), (r.conversationId = "c-old"), true));
    // The test before disconnected the second person: connecting the first one again is a switch.
    expect((await connect("xoxp-good-token-1111")).body).toMatchObject({ userId: "UOWN", followupsReset: true });
    await post("/api/followups/settings", { morningBrief: { enabled: true }, meetingReminderMin: 10 });
    await followups.add({ title: "Reply to Omar about the invoice", source: "slack", ref: "slack:D1:1.1" });
    await remember();

    // The same person again: nothing changes.
    expect((await connect("xoxp-good-token-1111")).body).not.toHaveProperty("followupsReset");
    expect(await followups.list()).toHaveLength(1);
    expect(await settings()).toMatchObject({ morningBrief: { enabled: true }, meetingReminderMin: 10 });

    // Another person: no follow-ups, nothing remembered, and the brief and meeting reminders (the calendar) off.
    expect((await connect("xoxp-second-person-6666")).body).toMatchObject({ userId: "UNEW", followupsReset: true });
    expect(await followups.list({ status: "all" })).toEqual([]);
    expect(await followups.reminderState()).toEqual({ sent: {} });
    expect(await settings()).toMatchObject({ morningBrief: { enabled: false }, meetingReminderMin: 0 });

    // Disconnecting empties them too, and remembers whose they were.
    await post("/api/followups/settings", { morningBrief: { enabled: true }, meetingReminderMin: 10 });
    await followups.add({ title: "Answer Rita", source: "owner" });
    await remember();
    await post("/api/slack/user/disconnect", {});
    expect(await followups.list({ status: "all" })).toEqual([]);
    expect(await followups.reminderState()).toEqual({ sent: {} });
    expect(await followups.lastOwner()).toBe("UNEW");
    // The same person back: their settings stay.
    await followups.add({ title: "Call the bank", source: "owner" });
    expect((await connect("xoxp-second-person-6666")).body).not.toHaveProperty("followupsReset");
    expect(await followups.list()).toHaveLength(1);
    expect(await settings()).toMatchObject({ morningBrief: { enabled: true }, meetingReminderMin: 10 });
    // Disconnected, then someone else connects: still another person.
    await post("/api/slack/user/disconnect", {});
    await followups.add({ title: "Added in the console meanwhile", source: "owner" });
    expect((await connect("xoxp-good-token-1111")).body).toMatchObject({ userId: "UOWN", followupsReset: true });
    expect(await followups.list({ status: "all" })).toEqual([]);
    expect(await settings()).toMatchObject({ morningBrief: { enabled: false }, meetingReminderMin: 0 });
    await post("/api/slack/user/disconnect", {});
    revoked.length = 0;
  });

  it("disconnects even when Slack does not confirm the revoke, and says so without the token", async () => {
    revoked.length = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await connect("xoxp-stubborn-token-7777")).status).toBe(200);
      // Replacing it: the new account is connected, and the page hears the old token may live on.
      expect((await connect("xoxp-good-token-1111")).body).toMatchObject({ ok: true, userId: "UOWN", previousRevoked: false });
      expect(await account()).toMatchObject({ connected: true, userId: "UOWN" });
      expect((await connect("xoxp-stubborn-token-7777")).body).toMatchObject({ ok: true, previousRevoked: true });

      const res = await post("/api/slack/user/disconnect", {});
      expect(await res.json()).toEqual({ ok: true, revoked: false });
      expect(await account()).toEqual({ connected: false });
      expect(revoked).toEqual(["xoxp-stubborn-token-7777", "xoxp-good-token-1111", "xoxp-stubborn-token-7777"]);
      const logged = warn.mock.calls.map((a) => a.join(" "));
      expect(logged.filter((l) => l.includes("revoke"))).toEqual([
        "[slack] could not revoke the owner's Slack token: ratelimited",
        "[slack] could not revoke the owner's Slack token: ratelimited",
      ]);
      expect(logged.join("\n")).not.toContain("xoxp-");
      // Nothing connected: nothing to revoke.
      expect(await (await post("/api/slack/user/disconnect", {})).json()).toEqual({ ok: true, revoked: true });
      expect(revoked).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("serves the bot's manifest without user scopes or events, and the account's with them", async () => {
    const bot = (await (await get("/api/slack/manifest")).json()).manifest;
    expect(bot.oauth_config.scopes.user).toBeUndefined();
    expect(bot.settings.event_subscriptions.user_events).toBeUndefined();
    const own = (await (await get("/api/slack/manifest?account=1")).json()).manifest;
    expect(own.oauth_config.scopes.user).toEqual([...SLACK_USER_SCOPES]);
    expect(own.settings.event_subscriptions.user_events).toEqual(["message.im", "message.mpim", "message.channels", "message.groups"]);
    expect(own.oauth_config.scopes.bot).toEqual(bot.oauth_config.scopes.bot);
    expect(own.settings.event_subscriptions.request_url).toBe(`${base}/slack/events`);
  });
});
