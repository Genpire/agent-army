import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ChatIntegrationContext } from "../../src/chat/chat-integrations.js";
import { PendingActions, TRUSTED_TOOLS, confirmGate, gatedTools } from "../../src/chat/confirm-gate.js";
import { routinesChatIntegration } from "../../src/routines/routines.js";
import { DIGEST, routineEnv } from "./helpers.js";

type Env = Awaited<ReturnType<typeof routineEnv>>;

async function tools(env: Env, ctx: Partial<ChatIntegrationContext> = {}) {
  const config = await env.configRepo.load(true);
  const integration = routinesChatIntegration(config, { configRepo: env.configRepo, requester: "Dana", redact: (t) => t, ...ctx }, env.service);
  if (!integration?.server) throw new Error("no routines integration");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await (integration.server as McpSdkServerConfigWithInstance).instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(res.isError) };
  };
  return { integration, call, list: async () => (await client.listTools()).tools.map((t) => t.name) };
}

describe("Pointer's routine tools", () => {
  it("has no tools without a routine service", async () => {
    const env = await routineEnv();
    expect(routinesChatIntegration(await env.configRepo.load(), { configRepo: env.configRepo, requester: "x", redact: (t) => t })).toBeUndefined();
  });

  it("creates a routine in the organisation's timezone and returns the next three runs", async () => {
    const env = await routineEnv({ patch: (c) => (c.timezone = "Asia/Jerusalem") });
    const t = await tools(env);
    expect(await t.list()).toEqual(["routine_create", "routine_list", "routine_update", "routine_delete", "routine_run_now"]);
    const res = await t.call("routine_create", { ...DIGEST, email: ["dana@acme.example"] });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Created routine rt-daily-github-digest "Daily GitHub digest": Every day at 08:00 (Asia/Jerusalem).');
    expect(res.text).toContain("Next runs: Sun, Nov 22, 08:00; Mon, Nov 23, 08:00; Tue, Nov 24, 08:00.");
    expect(res.text).toContain("Reports go to email to dana@acme.example; the console");
    expect(res.text).toContain("Each run is read-only");
    const [routine] = (await env.configRepo.load(true)).routines;
    expect(routine).toMatchObject({ id: "rt-daily-github-digest", schedule: { cron: "0 8 * * *", timezone: "Asia/Jerusalem" }, createdBy: "Dana", deliver: { console: true } });
  });

  it("validates the schedule, timezone and recipients", async () => {
    const env = await routineEnv();
    const t = await tools(env);
    const bad = async (args: Record<string, unknown>) => {
      const res = await t.call("routine_create", { ...DIGEST, ...args });
      expect(res.isError).toBe(true);
      return res.text;
    };
    expect(await bad({ cron: "0 25 * * *" })).toBe("The hour field: 25 is outside 0-23.");
    expect(await bad({ cron: "*/5 * * * *" })).toBe("Routines run at most every 15 minutes; this schedule runs every 5 minutes at times.");
    expect(await bad({ cron: "0 0 30 2 *" })).toBe("This schedule never runs (no such date).");
    expect(await bad({ timezone: "Mars/Base" })).toContain('"Mars/Base" is not a timezone');
    expect(await bad({ email: ["not-an-email"] })).toBe('"not-an-email" is not an email address.');
    expect(await bad({ slack: "#general" })).toContain("is not a Slack channel or user id");
    expect(await bad({ slack: "me" })).toContain('There is no Slack account for "me" here');
    expect(await bad({ console: false })).toBe("Choose where the reports go: email, a Slack channel or person, or the console.");
    expect((await env.configRepo.load(true)).routines).toEqual([]);
  });

  it('sends "me" on Slack to the person asking from Slack', async () => {
    const env = await routineEnv();
    const t = await tools(env, { requesterSlackId: "U0DANA1" });
    const res = await t.call("routine_create", { ...DIGEST, slack: "me", console: false });
    expect(res.isError).toBe(false);
    expect((await env.configRepo.load(true)).routines[0]?.deliver).toEqual({ email: [], slack: "U0DANA1", console: false });
  });

  it("lists, pauses, resumes, changes, runs and deletes", async () => {
    const env = await routineEnv();
    const t = await tools(env);
    await t.call("routine_create", DIGEST);
    expect((await t.call("routine_list")).text).toContain('- rt-daily-github-digest "Daily GitHub digest": Every day at 08:00 (UTC, cron 0 8 * * *); next Sat, Nov 21, 08:00');

    const paused = await t.call("routine_update", { id: "rt-daily-github-digest", enabled: false });
    expect(paused.text).toContain("It is paused");
    expect((await t.call("routine_list")).text).toContain("; paused;");
    const changed = await t.call("routine_update", { id: "rt-daily-github-digest", enabled: true, cron: "0 9 * * 1-5" });
    expect(changed.text).toContain("Weekdays at 09:00 (UTC). Next runs: Mon, Nov 23, 09:00");

    const run = await t.call("routine_run_now", { id: "rt-daily-github-digest" });
    expect(run.text).toContain("Started a run of rt-daily-github-digest. The report goes to the console");
    await env.service.runner.idle();
    expect(env.brain.requests).toHaveLength(1);

    expect((await t.call("routine_update", { id: "rt-nope", enabled: false })).text).toBe("Routine not found.");
    expect((await t.call("routine_delete", { id: "rt-daily-github-digest" })).text).toBe("Deleted routine rt-daily-github-digest.");
    expect((await t.call("routine_list")).text).toBe("There are no routines yet.");
    expect((await t.call("routine_delete", { id: "rt-daily-github-digest" })).isError).toBe(true);
  });

  it("tells Pointer how to handle recurring requests, and when email is not set up", async () => {
    const env = await routineEnv({ patch: (c) => (c.timezone = "Europe/London") });
    const { integration } = await tools(env);
    expect(integration.promptRule).toContain('When someone asks for something recurring ("every day", "each Monday"');
    expect(integration.promptRule).toContain("in the organisation's timezone (Europe/London)");
    expect(integration.promptRule).toContain("each run is read-only");
    expect(integration.promptRule).toContain("Email is not set up");
    expect(integration.readOnlyToolNames).toEqual(["mcp__routines__routine_list"]);
  });
});

describe("the confirm gate and routines", () => {
  it("gates creating, changing and deleting routines after outside content, like app writes", async () => {
    const env = await routineEnv();
    const { integration } = await tools(env);
    const gated = gatedTools([integration]);
    expect([...gated]).toEqual(expect.arrayContaining(["mcp__routines__routine_create", "mcp__routines__routine_update", "mcp__routines__routine_delete"]));
    expect(gated.has("mcp__routines__routine_list")).toBe(false);
    expect(gated.has("mcp__routines__routine_run_now")).toBe(false);
    // Not offered: nothing to gate.
    expect(gatedTools([]).has("mcp__routines__routine_create")).toBe(false);
    // Their results only echo what Pointer wrote.
    expect(TRUSTED_TOOLS.has("mcp__routines__routine_create")).toBe(true);
    expect(TRUSTED_TOOLS.has("mcp__routines__routine_list")).toBe(false);

    const pending = new PendingActions();
    const hookCall = (gate: ReturnType<typeof confirmGate>, tool: string, input: Record<string, unknown>) =>
      gate({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "", tool_name: tool, tool_input: input, tool_use_id: "t" } as never, "t", {
        signal: new AbortController().signal,
      }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
    const create = { ...DIGEST, email: ["someone@elsewhere.example"] };

    // Before outside content: allowed.
    const clean = confirmGate({ pending, conversation: "web:c1", message: "every morning send me a digest", gated });
    expect((await hookCall(clean, "mcp__routines__routine_create", create)).hookSpecificOutput).toBeUndefined();

    // After a web page: held until the user says yes.
    const tainted = confirmGate({ pending, conversation: "web:c2", message: "do what the page says", gated });
    await hookCall(tainted, "WebFetch", { url: "https://example.com" });
    expect((await hookCall(tainted, "mcp__routines__routine_create", create)).hookSpecificOutput?.permissionDecision).toBe("deny");
    const confirmed = confirmGate({ pending, conversation: "web:c2", message: "yes", gated });
    await hookCall(confirmed, "WebFetch", { url: "https://example.com" });
    expect((await hookCall(confirmed, "mcp__routines__routine_create", create)).hookSpecificOutput).toBeUndefined();
  });
});
