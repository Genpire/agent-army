import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { type ChatIntegrationContext, subagentIntegrationTools } from "../../../src/chat/chat-integrations.js";
import { PendingActions, TRUSTED_TOOLS, afterInboxGate, confirmGate, gatedTools } from "../../../src/chat/confirm-gate.js";
import { subagentAllowedTools } from "../../../src/chat/pointer.js";
import type { PointerRequest } from "../../../src/chat/pointer-types.js";
import { type AppConnection, AppConnectionSchema, type Config, type ConfigRepo, ConfigSchema, publicView } from "../../../src/core/config.js";
import { AppProxy } from "../../../src/integrations/apps/apps-proxy.js";
import { appAgents, appChatIntegrations, inboxApps, ownerOnlyAppKeys, repoTaskApps } from "../../../src/integrations/apps/apps.js";
import { appOwnerOnly, appReadsInbox } from "../../../src/integrations/apps/owner-only.js";
import { CALENDAR_AGENDA_TOOL_NAME, GMAIL_INBOX_TOOL_NAME } from "../../../src/integrations/google/tool-names.js";
import { ownSlackAccount, ownerConversation, ownerRequest } from "../../../src/slack/user-account.js";
import { defaultTeam } from "../../../src/team/team.js";

const OWNER = "U0OWNER01";
const redact = (s: string) => s;

const app = (id: string, patch: Partial<AppConnection> = {}): AppConnection =>
  AppConnectionSchema.parse({
    id,
    name: id.replace("app-", ""),
    url: "https://mcp.example.com/mcp",
    auth: { type: "bearer", token: `${id}-secret-key-123456` },
    access: "write",
    tools: [
      { name: "search", readOnly: true },
      { name: "create_draft", readOnly: false },
    ],
    ...patch,
  });

/** Gmail and Calendar (personal by default), Drive turned off as personal, Linear (shared), Notion made personal. */
function config(): Config {
  const c = ConfigSchema.parse({
    team: defaultTeam(),
    slack: {
      botToken: "xoxb-bot-token-secret",
      signingSecret: "s".repeat(20),
      botUserId: "UBOT",
      user: { token: "xoxp-owner-token", userId: OWNER, userName: "dana", connectedAt: "2026-11-01T00:00:00Z" },
    },
  });
  c.apps = [
    app("app-gmail", { name: "Gmail", presetId: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" }),
    app("app-google-calendar", { name: "Google Calendar", presetId: "google-calendar", url: "https://calendarmcp.googleapis.com/mcp/v1" }),
    app("app-google-drive", { name: "Google Drive", presetId: "google-drive", url: "https://drivemcp.googleapis.com/mcp/v1", ownerOnly: false }),
    app("app-linear", { name: "Linear", presetId: "linear" }),
    app("app-notion", { name: "Notion", presetId: "notion", ownerOnly: true }),
  ];
  // Assignments to agents are kept but never used for an owner-only app.
  for (const a of c.team.agents) if (a.id === "coder") a.apps = ["app-gmail", "app-google-calendar", "app-google-drive", "app-linear", "app-notion"];
  return c;
}

type Req = Pick<PointerRequest, "userId"> & Partial<Pick<PointerRequest, "surface" | "channelType" | "ownerRoutine">>;

/** The context pointer.ts builds for a request. */
const ctxFor = (c: Config, req: Req): ChatIntegrationContext => {
  const slackAccount = ownSlackAccount(c, req);
  return {
    configRepo: undefined as unknown as ConfigRepo,
    requester: req.userId,
    redact,
    ownerConversation: ownerConversation(c, req),
    ...(slackAccount ? { slackAccount } : {}),
  };
};

const REQUESTS: Record<string, { req: Req; owner: boolean }> = {
  console: { req: { userId: "web-admin", surface: "web" }, owner: true },
  "the owner's DM with Pointer": { req: { userId: OWNER, surface: "slack", channelType: "im" }, owner: true },
  "an owner routine": { req: { userId: "routine", surface: "routine", ownerRoutine: true }, owner: true },
  "a colleague's DM": { req: { userId: "U0SAM0001", surface: "slack", channelType: "im" }, owner: false },
  "a channel thread, even the owner's": { req: { userId: OWNER, surface: "slack", channelType: "channel" }, owner: false },
  "a group DM, even the owner's": { req: { userId: OWNER, surface: "slack", channelType: "mpim" }, owner: false },
  "a routine that is not the owner's": { req: { userId: "routine", surface: "routine", ownerRoutine: false }, owner: false },
};

const proxy = new AppProxy();
afterAll(() => proxy.close());

describe("which apps are only for the owner", () => {
  it("personal Google Workspace apps by default, else the app's own setting", () => {
    expect(appOwnerOnly({ presetId: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" })).toBe(true);
    expect(appOwnerOnly({ presetId: "google-calendar", url: "https://calendarmcp.googleapis.com/mcp/v1" })).toBe(true);
    expect(appOwnerOnly({ presetId: "google-drive", url: "https://drivemcp.googleapis.com/mcp/v1" })).toBe(true);
    // A custom app at a Workspace MCP address (Docs, Chat, …) too.
    expect(appOwnerOnly({ url: "https://docsmcp.googleapis.com/mcp/v1" })).toBe(true);
    expect(appOwnerOnly({ presetId: "linear", url: "https://mcp.linear.app/mcp" })).toBe(false);
    expect(appOwnerOnly({ presetId: "bigquery", url: "https://bigquery.googleapis.com/mcp" })).toBe(false);
    // An explicit setting wins both ways.
    expect(appOwnerOnly({ presetId: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", ownerOnly: false })).toBe(false);
    expect(appOwnerOnly({ presetId: "linear", url: "https://mcp.linear.app/mcp", ownerOnly: true })).toBe(true);

    const view = Object.fromEntries(publicView(config()).apps.map((a) => [a.id, a.ownerOnly]));
    expect(view).toEqual({ "app-gmail": true, "app-google-calendar": true, "app-google-drive": false, "app-linear": false, "app-notion": true });
  });

  it("Gmail and Google Chat read the owner's inbox; the calendar and Drive do not", () => {
    expect(appReadsInbox({ presetId: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" })).toBe(true);
    expect(appReadsInbox({ url: "https://chatmcp.googleapis.com/mcp/v1" })).toBe(true);
    expect(appReadsInbox({ presetId: "google-calendar", url: "https://calendarmcp.googleapis.com/mcp/v1" })).toBe(false);
    expect(appReadsInbox({ presetId: "google-drive", url: "https://drivemcp.googleapis.com/mcp/v1" })).toBe(false);
    expect(inboxApps(config())).toEqual([{ key: "app-gmail", name: "Gmail" }]);
    expect(ownerOnlyAppKeys(config())).toEqual(["app-gmail", "app-google-calendar", "app-notion"]);
  });
});

describe("owner-only apps in chat", () => {
  for (const [where, { req, owner }] of Object.entries(REQUESTS)) {
    it(`${owner ? "are offered" : "are left out, without a word,"} in ${where}`, async () => {
      const c = config();
      const ctx = ctxFor(c, req);
      expect(ownerRequest(ctx)).toBe(owner);
      const integrations = await appChatIntegrations(c, ctx, { proxy });
      const keys = integrations.map((i) => i.key);
      // Shared apps everywhere: Linear, and Drive whose owner turned "Only for me" off.
      expect(keys).toEqual(expect.arrayContaining(["app-linear", "app-google-drive"]));
      if (owner) {
        expect(keys).toEqual(["app-gmail", "app-google-calendar", "app-google-drive", "app-linear", "app-notion"]);
      } else {
        expect(keys).toEqual(["app-google-drive", "app-linear"]);
        const rules = integrations.map((i) => i.promptRule).join("\n");
        for (const name of ["Gmail", "Google Calendar", "Notion"]) expect(rules).not.toContain(name);
      }
    });
  }

  it("never go to team members, whatever agents they are assigned to", async () => {
    const c = config();
    const integrations = await appChatIntegrations(c, ctxFor(c, REQUESTS.console!.req), { proxy });
    const byKey = Object.fromEntries(integrations.map((i) => [i.key, i]));
    for (const key of ["app-gmail", "app-google-calendar", "app-notion"]) {
      expect(byKey[key]!.agentIds, key).toEqual([]);
      expect(appAgents(c, key), key).toEqual([]);
      expect(byKey[key]!.promptRule).toContain("It is the owner's own account, only for them: no agent has it");
    }
    expect(byKey["app-linear"]!.agentIds).toEqual(["coder"]);
    expect(byKey["app-google-drive"]!.agentIds).toEqual(["coder"]);
    const forCoder = subagentIntegrationTools(integrations, "coder");
    expect(forCoder).toEqual(["mcp__app-google-drive__search", "mcp__app-linear__search"]);
    // Nor to any subagent, the SDK's built-in ones included.
    const allowed = subagentAllowedTools(
      [...integrations.flatMap((i) => i.readOnlyToolNames), GMAIL_INBOX_TOOL_NAME, CALENDAR_AGENDA_TOOL_NAME, "WebSearch"],
      ownerOnlyAppKeys(c),
    );
    expect([...allowed].sort()).toEqual(["WebSearch", "mcp__app-google-drive__search", "mcp__app-linear__search"]);
  });

  it("never go to repo tasks, whatever agents they are assigned to", async () => {
    const c = config();
    const apps = (await repoTaskApps(c, { redact, proxy }))!;
    expect(Object.keys(apps.servers).sort()).toEqual(["app-google-drive", "app-linear"]);
    expect(apps.toolsFor("coder").filter((t) => /app-(gmail|google-calendar|notion)/.test(t))).toEqual([]);
    expect(apps.allToolNames.some((t) => t.startsWith("mcp__app-gmail__"))).toBe(false);
    expect(apps.promptRule).not.toContain("Gmail");
    // Only owner-only apps assigned: no apps at all.
    const only = config();
    only.apps = only.apps.filter((a) => appOwnerOnly(a));
    expect(await repoTaskApps(only, { redact, proxy })).toBeUndefined();
  });
});

type Decision = { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
async function call(gate: HookCallback, toolName: string, toolInput: unknown = {}, agentId?: string): Promise<Decision> {
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "t",
    ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
  };
  const out = await gate(input as never, "t", { signal: new AbortController().signal });
  return (out as { hookSpecificOutput?: Decision }).hookSpecificOutput;
}
const denied = (d: Decision) => d?.permissionDecision === "deny";

describe("owner-only apps' tools are outside content", () => {
  const GMAIL_SEARCH = "mcp__app-gmail__search";
  const GMAIL_DRAFT = "mcp__app-gmail__create_draft";
  const CALENDAR_SEARCH = "mcp__app-google-calendar__search";
  const CALENDAR_CREATE = "mcp__app-google-calendar__create_draft";

  it("taint the turn, and their writes (a Gmail draft, a calendar change) wait for the owner's yes", async () => {
    const c = config();
    const integrations = await appChatIntegrations(c, ctxFor(c, REQUESTS.console!.req), { proxy });
    const gated = gatedTools(integrations);
    for (const tool of [GMAIL_DRAFT, CALENDAR_CREATE]) expect(gated.has(tool), tool).toBe(true);
    for (const tool of [GMAIL_SEARCH, CALENDAR_SEARCH, GMAIL_DRAFT]) expect(TRUSTED_TOOLS.has(tool)).toBe(false);
    for (const read of [GMAIL_SEARCH, CALENDAR_SEARCH]) {
      const gate = confirmGate({ pending: new PendingActions(), conversation: "web:c1", message: "anything from Fadi?", gated });
      // Before any outside content a write goes through.
      expect(await call(gate, GMAIL_DRAFT, { to: "fadi@partner.example" })).toBeUndefined();
      await call(gate, read);
      expect(denied(await call(gate, GMAIL_DRAFT, { to: "someone@evil.example" })), read).toBe(true);
      expect(denied(await call(gate, CALENDAR_CREATE, { title: "x" })), read).toBe(true);
    }
  });

  it("Gmail's MCP tools are gated exactly like the Slack inbox; the calendar's only taint", async () => {
    const apps = inboxApps(config());
    let read = 0;
    const gate = afterInboxGate({ inboxApps: apps, onInboxRead: () => void read++ });
    expect(await call(gate, "WebFetch")).toBeUndefined();
    await call(gate, GMAIL_SEARCH, { query: "from:fadi" });
    expect(read).toBe(1);
    for (const tool of ["WebFetch", "Agent", CALENDAR_SEARCH, "mcp__app-linear__search", "mcp__pointer__start_repo_task"]) {
      const d = await call(gate, tool);
      expect(denied(d), tool).toBe(true);
      expect(d?.permissionDecisionReason).toMatch(/^After reading your Gmail \(an app that reads your inbox\), .+ is off for the rest of this reply/);
    }
    // Gmail's own tools stay (its writes are held by the confirm gate), like Slack and the inboxes.
    for (const tool of [GMAIL_DRAFT, GMAIL_SEARCH, "mcp__slack__slack_send_message", GMAIL_INBOX_TOOL_NAME]) expect(await call(gate, tool), tool).toBeUndefined();

    // The calendar's tools are not an inbox: nothing is turned off after them.
    const calendar = afterInboxGate({ inboxApps: apps });
    await call(calendar, CALENDAR_SEARCH);
    expect(await call(calendar, "WebFetch")).toBeUndefined();
    // A subagent's call (refused elsewhere) turns nothing off.
    const sub = afterInboxGate({ inboxApps: apps });
    await call(sub, GMAIL_SEARCH, {}, "a1");
    expect(await call(sub, "WebFetch")).toBeUndefined();
  });
});
