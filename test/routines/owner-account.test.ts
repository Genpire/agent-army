import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MemoryRepo } from "../../src/chat/memory.js";
import { type QueryFn, createPointerBrain } from "../../src/chat/pointer.js";
import type { PointerBrain, PointerRequest } from "../../src/chat/pointer-types.js";
import { registerRoutineService } from "../../src/routines/routines.js";
import { SlackInbox } from "../../src/slack/inbox.js";
import { INBOX_SERVER_KEY, attentionReportDraft, registerSlackInbox } from "../../src/slack/inbox-tools.js";
import { KEY, configured, routineEnv, tmpStore } from "./helpers.js";

/**
 * Who a routine's runs read the owner's own Slack account for: only a
 * routine the owner made or last changed (the console, their DM with
 * Pointer) that reports to them alone, checked again on every run. Anyone
 * else who talks to Pointer can make routines too, so a routine of theirs,
 * or one of the owner's they changed, never reads the owner's inbox.
 */

const OWNER = "U0OWNER01";
const MALLORY = "U0MALLORY";
const OWNER_TOKEN = "xoxp-owner-routine-secret-424242";

type ToolResult = { text: string; isError: boolean };

/** Pointer's brain on a fake model: each message may call one tool on one of the query's servers. */
async function ownerEnv() {
  const store = await tmpStore();
  const configRepo = await configured(store, (c) => {
    c.slack.user = { token: OWNER_TOKEN, userId: OWNER, userName: "dana", scopes: [], connectedAt: "2026-11-01T00:00:00.000Z", listen: true, sendAsMe: true };
  });
  const queries: Options[] = [];
  let step: ((options: Options) => Promise<void>) | undefined;
  const queryFn: QueryFn = async function* (params) {
    const options = params.options ?? {};
    queries.push(options);
    const run = step;
    step = undefined;
    if (run) await run(options);
    yield { type: "result", subtype: "success", is_error: false, result: "## Report\nAll quiet.", total_cost_usd: 0.01, num_turns: 1, errors: [] } as unknown as SDKMessage;
  };
  const pointer = createPointerBrain({ configRepo, memory: new MemoryRepo(store, KEY) }, { queryFn });
  const requests: PointerRequest[] = [];
  const brain: PointerBrain = {
    reply(req, ctx) {
      requests.push(req);
      return pointer.reply(req, ctx);
    },
  };
  const env = await routineEnv({ store, shared: true, brain: { brain, requests } });
  registerRoutineService(configRepo, env.service);
  registerSlackInbox(configRepo, new SlackInbox(store, KEY));

  /** One chat message whose answer calls a routine tool, as Pointer would. */
  const say = async (req: Partial<PointerRequest>, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    let out: ToolResult | undefined;
    step = async (options) => {
      const server = options.mcpServers?.routines as McpSdkServerConfigWithInstance | undefined;
      if (!server) throw new Error("no routine tools");
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverSide);
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(clientSide);
      const res = (await client.callTool({ name: tool, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
      out = { text: res.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(res.isError) };
      await client.close();
    };
    const message: PointerRequest = { text: "every morning, tell me", userId: OWNER, userName: "Dana", channel: "D0OWNER01", channelType: "im", threadTs: "1700000000.000100", history: [], ...req };
    await brain.reply(message, { startRepoTask: async () => ({ ok: false, error: "unused" }) });
    if (!out) throw new Error("the tool was not called");
    return out;
  };

  /** Runs a routine now; whether that run had the owner's inbox among its tools, and what it was asked. */
  const run = async (id: string) => {
    const started = await env.service.runNow(id);
    if (!started.ok) throw new Error(started.error);
    const done = await started.done;
    const options = queries.at(-1)!;
    return {
      status: done.status,
      inbox: Object.keys(options.mcpServers ?? {}).includes(INBOX_SERVER_KEY),
      prompt: options.systemPrompt as string,
      req: requests.at(-1)!,
    };
  };

  const routine = async (id: string) => (await env.configRepo.load(true)).routines.find((r) => r.id === id)!;
  return { ...env, configRepo, say, run, routine };
}

const fromMallory = { userId: MALLORY, userName: "Mallory", channel: "D0MALLORY1" };
const fromConsole = { surface: "web" as const, channel: "web", userId: "admin", userName: "Admin", threadTs: "c-owner-1" };
const DIGEST = { name: "Morning digest", instruction: "Read my Slack inbox with slack_my_inbox and list what waits for me.", cron: "0 8 * * *" };

describe("routines and the owner's own Slack account", () => {
  it("Mallory's routine, made from her DM and reporting to her, never reads the owner's inbox", async () => {
    const env = await ownerEnv();
    const made = await env.say(fromMallory, "routine_create", { ...DIGEST, slack: "me" });
    expect(made.isError).toBe(false);
    const r = await env.routine("rt-morning-digest");
    expect(r).toMatchObject({ ownerOnly: false, deliver: { slack: MALLORY } });

    const ran = await env.run(r.id);
    expect(ran.status).toBe("succeeded");
    expect(ran.req.ownerRoutine).toBeUndefined();
    expect(ran.inbox).toBe(false);
    expect(ran.prompt).not.toContain("slack_my_inbox");
    expect(ran.prompt).not.toContain("connected their own Slack account");
    // Nor when she points it at the owner and the console: the mark is what counts, not only the recipients.
    expect((await env.say(fromMallory, "routine_update", { id: r.id, slack: OWNER })).isError).toBe(false);
    expect((await env.run(r.id)).inbox).toBe(false);
  });

  it("Mallory's routine is not the owner's even when she names herself by her email or the console", async () => {
    const env = await ownerEnv();
    await env.say(fromMallory, "routine_create", { ...DIGEST, email: ["mallory@example.com"], console: true });
    expect((await env.routine("rt-morning-digest")).ownerOnly).toBe(false);
    expect((await env.run("rt-morning-digest")).inbox).toBe(false);
  });

  it("the owner's routine reporting to the owner reads their inbox, from their DM or the console", async () => {
    const env = await ownerEnv();
    expect((await env.say({}, "routine_create", { ...DIGEST, slack: "me" })).isError).toBe(false);
    expect(await env.routine("rt-morning-digest")).toMatchObject({ ownerOnly: true, deliver: { slack: OWNER, email: [], console: true } });
    const ran = await env.run("rt-morning-digest");
    expect(ran.req.ownerRoutine).toBe(true);
    expect(ran.inbox).toBe(true);
    expect(ran.prompt).toContain("slack_my_inbox");

    expect((await env.say(fromConsole, "routine_create", { ...DIGEST, name: "Console digest", slack: OWNER, console: true })).isError).toBe(false);
    expect((await env.routine("rt-console-digest")).ownerOnly).toBe(true);
    expect((await env.run("rt-console-digest")).inbox).toBe(true);
  });

  it("the owner's routine changed by Mallory loses the mark, and reads nothing until the owner changes it again", async () => {
    const env = await ownerEnv();
    await env.say({}, "routine_create", { ...DIGEST, slack: "me" });
    expect((await env.run("rt-morning-digest")).inbox).toBe(true);

    // A rename that keeps the owner as the only recipient: still not the owner's change.
    expect((await env.say(fromMallory, "routine_update", { id: "rt-morning-digest", name: "Renamed" })).isError).toBe(false);
    expect(await env.routine("rt-morning-digest")).toMatchObject({ ownerOnly: false, deliver: { slack: OWNER } });
    const after = await env.run("rt-morning-digest");
    expect(after.req.ownerRoutine).toBeUndefined();
    expect(after.inbox).toBe(false);

    await env.say({}, "routine_update", { id: "rt-morning-digest", enabled: true });
    expect((await env.routine("rt-morning-digest")).ownerOnly).toBe(true);
    expect((await env.run("rt-morning-digest")).inbox).toBe(true);
  });

  it("the owner's routine with an email recipient, or anyone else on Slack, does not read the inbox", async () => {
    const env = await ownerEnv();
    await env.say(fromConsole, "routine_create", { ...DIGEST, slack: OWNER, email: ["dana@example.com"] });
    expect((await env.routine("rt-morning-digest")).ownerOnly).toBe(true);
    expect((await env.run("rt-morning-digest")).inbox).toBe(false);

    await env.say(fromConsole, "routine_update", { id: "rt-morning-digest", email: [], slack: "C0GENERAL1" });
    expect((await env.run("rt-morning-digest")).inbox).toBe(false);
    await env.say(fromConsole, "routine_update", { id: "rt-morning-digest", slack: "" });
    expect((await env.run("rt-morning-digest")).inbox).toBe(true);
  });

  it("a routine the owner makes in a channel thread is not marked: other people's messages are in that prompt", async () => {
    const env = await ownerEnv();
    await env.say({ channel: "C0GENERAL1", channelType: "channel" }, "routine_create", { ...DIGEST, slack: "me" });
    expect(await env.routine("rt-morning-digest")).toMatchObject({ ownerOnly: false, deliver: { slack: OWNER } });
    expect((await env.run("rt-morning-digest")).inbox).toBe(false);
  });

  it("is checked again on every run, against the current config", async () => {
    const env = await ownerEnv();
    await env.say({}, "routine_create", { ...DIGEST, slack: "me" });
    expect((await env.run("rt-morning-digest")).inbox).toBe(true);
    // Another person's account connected: the routine still reports to the old id, so it is not theirs.
    await env.configRepo.update((c) => {
      c.slack.user = { ...c.slack.user!, userId: "U0SOMEONE2" };
    });
    expect((await env.run("rt-morning-digest")).inbox).toBe(false);
  });

  it("takes the owner's mark from the admin routes that create the attention report (create with ownerOnly)", async () => {
    const env = await ownerEnv();
    const config = await env.configRepo.load(true);
    const made = await env.service.create(attentionReportDraft(config, OWNER), "Admin (console)", { ownerOnly: true });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.routine).toMatchObject({ ownerOnly: true, deliver: { slack: OWNER, email: [], console: true } });
    expect((await env.run(made.routine.id)).inbox).toBe(true);
    // Without the option, a create or a change is nobody's in particular.
    const plain = await env.service.create({ ...DIGEST, name: "Plain" }, "someone");
    expect(plain.ok && plain.routine.ownerOnly).toBe(false);
    const changed = await env.service.update(made.routine.id, { name: "Renamed report" });
    expect(changed.ok && changed.routine.ownerOnly).toBe(false);
    expect((await env.run(made.routine.id)).inbox).toBe(false);
  });
});
