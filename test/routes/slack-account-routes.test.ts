import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Store } from "../../src/core/store.js";
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
};

function fakeSlack(token: string) {
  if (token.startsWith("xoxb-")) {
    return { auth: { test: async () => ({ ok: true, user_id: "UTESTBOT", team_id: "T1" }) }, users: { info: async () => ({ user: {} }) } };
  }
  const account = ACCOUNTS[token];
  return {
    auth: {
      test: async () => {
        if (!account) throw slackError("invalid_auth");
        if (typeof account.auth === "string") throw slackError(account.auth);
        return { ok: true, ...account.auth };
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
    expect(s.config.slack.user).toMatchObject({ connected: true, userId: "UOWN", userName: "dana", key: "••••1111", listen: true, sendAsMe: true });
    expect(JSON.stringify(s)).not.toContain("xoxp-good-token-1111");
  });

  it("turns listening and sending as the owner on and off, and keeps them on a reconnect", async () => {
    expect((await (await post("/api/slack/user/settings", {})).json()).error).toBe("Send listen or sendAsMe.");
    expect((await post("/api/slack/user/settings", { listen: "yes" })).status).toBe(400);
    expect((await post("/api/slack/user/settings", { sendAsMe: false })).status).toBe(200);
    expect((await post("/api/slack/user/settings", { listen: false })).status).toBe(200);
    expect(await account()).toMatchObject({ listen: false, sendAsMe: false });
    await connect("xoxp-good-token-1111");
    expect(await account()).toMatchObject({ listen: false, sendAsMe: false });
    expect((await (await get("/api/slack/user/report")).json()).blocked).toMatch(/^Turn on reading what reaches you/);
    expect((await post("/api/slack/user/report", {})).status).toBe(400);
    await post("/api/slack/user/settings", { listen: true, sendAsMe: true });
  });

  it("creates the attention report once, on weekdays, to the owner's DM and the console", async () => {
    expect((await post("/api/settings", { timezone: "Europe/London" })).status).toBe(200);
    expect(await (await get("/api/slack/user/report")).json()).toEqual({ routine: null, blocked: null });
    const res = await post("/api/slack/user/report", {});
    expect(res.status).toBe(200);
    const { routine } = await res.json();
    expect(routine).toMatchObject({
      name: "What needs my attention on Slack",
      schedule: { cron: "0 9,13,17 * * 1-5", timezone: "Europe/London" },
      deliver: { email: [], slack: "UOWN", console: true },
      scheduleText: "Weekdays at 09:00, 13:00 and 17:00",
      enabled: true,
    });
    expect(routine.instruction).toContain("slack_my_inbox");
    const status = await (await get("/api/slack/user/report")).json();
    expect(status).toEqual({ routine: { id: routine.id, name: routine.name }, blocked: 'It already exists: "What needs my attention on Slack" on the Routines page.' });
    const again = await post("/api/slack/user/report", {});
    expect(again.status).toBe(409);
    expect((await (await get("/api/routines")).json()).routines).toHaveLength(1);
  });

  it("starts an empty inbox for another person's account, and empties it on disconnect", async () => {
    await store.put("slack/inbox.enc", "x");
    await connect("xoxp-good-token-1111");
    expect(await inboxBlob()).toBe(1);
    expect((await connect("xoxp-second-person-6666")).status).toBe(200);
    expect(await inboxBlob()).toBe(0);
    expect(await account()).toMatchObject({ userId: "UNEW", userName: "sam" });

    await store.put("slack/inbox.enc", "x");
    expect((await post("/api/slack/user/disconnect", {})).status).toBe(200);
    expect(await inboxBlob()).toBe(0);
    expect(await account()).toEqual({ connected: false });
    expect((await post("/api/slack/user/settings", { listen: true })).status).toBe(404);
    expect((await (await get("/api/slack/user/report")).json()).blocked).toBe("Connect your Slack account first.");
  });
});
