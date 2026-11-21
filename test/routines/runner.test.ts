import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { MemoryRepo } from "../../src/chat/memory.js";
import { NotesRepo } from "../../src/chat/notes.js";
import { type QueryFn, createPointerBrain } from "../../src/chat/pointer.js";
import type { PointerRequest } from "../../src/chat/pointer-types.js";
import { registerRoutineService } from "../../src/routines/routines.js";
import { routineRequest } from "../../src/routines/runner.js";
import { Clock, DIGEST, KEY, SECRETS, configured, fakeBrain, routineEnv, tmpStore } from "./helpers.js";

type Call = { prompt: string | AsyncIterable<SDKUserMessage>; options: Options };

function fakeQuery(text = "## Report\nAll quiet.") {
  const calls: Call[] = [];
  const queryFn: QueryFn = async function* (params) {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    yield { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.05, num_turns: 2, errors: [] } as unknown as SDKMessage;
  };
  return { queryFn, calls };
}

/** Runs the query's PreToolUse hooks for a call by Pointer itself (no agent id): any deny wins. */
async function decision(options: Options, toolName: string, input: Record<string, unknown> = {}): Promise<"allow" | "deny"> {
  const event = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: options.cwd ?? "", tool_name: toolName, tool_input: input, tool_use_id: "t" };
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = (await hook(event as never, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (out.hookSpecificOutput?.permissionDecision === "deny") return "deny";
    }
  }
  return "allow";
}

const WRITE_TOOLS = [
  "mcp__pointer__memory_save",
  "mcp__pointer__memory_forget",
  "mcp__pointer__project_notes_add",
  "mcp__pointer__start_repo_task",
  "mcp__pointer__monday_create_item",
  "mcp__slack__slack_send_message",
  "mcp__routines__routine_create",
  "mcp__routines__routine_update",
  "mcp__routines__routine_delete",
  "mcp__routines__routine_run_now",
];

describe("a routine run is read-only", () => {
  async function brainFor() {
    const store = await tmpStore();
    const configRepo = await configured(store, (c) => {
      c.monday = { token: "monday-routine-token-777", allowedBoardIds: [], automation: { enabled: false, boards: {} } };
      c.team.pointer.budgetUsd = 2.5;
    });
    // The routine tools are offered too (as in the app), so their writes must be held back.
    const env = await routineEnv({ store, shared: true });
    registerRoutineService(configRepo, env.service);
    const { queryFn, calls } = fakeQuery();
    const brain = createPointerBrain({ configRepo, memory: new MemoryRepo(store, KEY), notes: new NotesRepo(store, KEY) }, { queryFn });
    return { brain, calls, configRepo };
  }

  const routine = {
    id: "rt-daily-github-digest",
    name: DIGEST.name,
    instruction: DIGEST.instruction,
    schedule: { cron: "0 8 * * *", timezone: "Asia/Jerusalem" },
    deliver: { email: [], slack: "", console: true },
    budgetUsd: 0.75,
    enabled: true,
    createdBy: "test",
  };

  it("offers only read-only tools, denies writes, and spends at most the routine's budget", async () => {
    const { brain, calls } = await brainFor();
    const req = routineRequest(routine, { now: new Date("2026-11-21T06:00:30Z"), trigger: "schedule", runId: "s-202611210600" });
    const startRepoTask = async () => ({ ok: true as const, taskId: "t-1", repo: "acme/web" });
    const reply = await brain.reply(req, { startRepoTask });
    expect(reply.isError).toBe(false);
    const o = calls[0]!.options;

    for (const tool of WRITE_TOOLS) {
      expect(o.allowedTools).not.toContain(tool);
      expect(o.disallowedTools).toContain(tool);
      expect(await decision(o, tool, { text: "x" })).toBe("deny");
    }
    expect(o.allowedTools).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch", "mcp__pointer__github_read_file", "mcp__pointer__monday_get_item", "mcp__slack__slack_find_user", "mcp__routines__routine_list"]),
    );
    expect(await decision(o, "mcp__pointer__github_read_file", { repo: "acme/web", path: "README.md" })).toBe("allow");
    expect(o.maxBudgetUsd).toBe(0.75);
    expect(o.permissionMode).toBe("dontAsk");
    const system = o.systemPrompt as string;
    expect(system).toContain("## This run");
    expect(system).toContain("This run is read-only");
    expect(system).toContain("a scheduled routine, running on your own");
  });

  it("puts the instruction, the date, the timezone and the window in the prompt", async () => {
    const first = routineRequest(routine, { now: new Date("2026-11-21T06:00:30Z"), trigger: "schedule", runId: "s-1" });
    expect(first.surface).toBe("routine");
    expect(first.history).toEqual([]);
    expect(first.text).toContain(DIGEST.instruction);
    expect(first.text).toContain("Now: Saturday, November 21, 2026");
    expect(first.text).toContain("in Asia/Jerusalem (2026-11-21T06:00:30.000Z)");
    expect(first.text).toContain("Window: this is the first run, so the last 24 hours: since Friday, November 20, 2026");
    const later = routineRequest(routine, { now: new Date("2026-11-22T06:00:30Z"), since: "2026-11-21T06:00:31.000Z", trigger: "manual", runId: "m-1" });
    expect(later.text).toContain("Window: since the last successful run, Saturday, November 21, 2026");
    expect(later.text).toContain("The owner asked for this run now.");
  });

  it("a chat request keeps its write tools (only routines are read-only)", async () => {
    const { brain, calls } = await brainFor();
    const chat: PointerRequest = { text: "hi", userId: "U1", channel: "C1", channelType: "channel", threadTs: "1.0", history: [] };
    await brain.reply(chat, { startRepoTask: async () => ({ ok: false, error: "unused" }) });
    expect(calls[0]!.options.allowedTools).toEqual(expect.arrayContaining(["mcp__pointer__memory_save", "mcp__pointer__start_repo_task", "mcp__routines__routine_create"]));
    expect(calls[0]!.options.maxBudgetUsd).toBe(2.5);
  });
});

describe("delivery", () => {
  it("goes only to the routine's recipients, with secrets redacted", async () => {
    const brain = fakeBrain(() => ({ text: `## acme/web\nMerged #12. Leaked token ${SECRETS.ghToken} and key ${SECRETS.apiKey}. <!channel> look.`, costUsd: 0.2, isError: false }));
    const env = await routineEnv({ brain });
    const created = await env.service.create({ ...DIGEST, email: ["dana@acme.example", "lee@acme.example"], slack: "C0ACMEDEV1" }, "test");
    if (!created.ok) throw new Error(created.error);
    const started = await env.service.runNow(created.routine.id);
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;

    expect(run.status).toBe("succeeded");
    expect(run.report).not.toContain(SECRETS.ghToken);
    expect(run.report).toContain("[redacted]");
    expect(run.delivered).toEqual({
      email: { ok: true, detail: "Sent to 2 addresses" },
      slack: { ok: true, detail: "Posted to C0ACMEDEV1" },
      console: { ok: true, detail: "c-conversation-1" },
    });

    expect(env.email.sent).toHaveLength(1);
    expect(env.email.sent[0]!.to).toEqual(["dana@acme.example", "lee@acme.example"]);
    expect(env.email.sent[0]!.subject).toBe("Daily GitHub digest · Nov 21, 2026");
    expect(env.email.sent[0]!.markdown).not.toContain(SECRETS.ghToken);
    expect(env.email.sent[0]!.markdown).not.toContain(SECRETS.apiKey);

    expect(env.slack.messages.map((m) => m.channel)).toEqual(["C0ACMEDEV1"]);
    expect(env.slack.messages[0]!.token).toBe(SECRETS.botToken);
    expect(env.slack.messages[0]!.text).toContain("*Daily GitHub digest* · Nov 21, 2026");
    // Markdown headings become mrkdwn bold; broadcasts never ping.
    expect(env.slack.messages[0]!.text).toContain("*acme/web*");
    expect(env.slack.messages[0]!.text).not.toContain("<!channel>");
    expect(env.slack.messages[0]!.text).not.toContain(SECRETS.ghToken);

    expect(env.threads.started).toEqual([{ id: "c-conversation-1", title: "Daily GitHub digest", markdown: expect.stringContaining("Merged #12.") }]);
    expect(env.threads.started[0]!.markdown).not.toContain(SECRETS.ghToken);
  });

  it("appends to the same console conversation and skips recipients that are not set", async () => {
    const env = await routineEnv();
    const created = await env.service.create(DIGEST, "test");
    if (!created.ok) throw new Error(created.error);
    for (let i = 0; i < 2; i++) {
      env.clock.ms += 60 * 60_000;
      const started = await env.service.runNow(created.routine.id);
      if (!started.ok) throw new Error(started.error);
      expect((await started.done).delivered).toEqual({ email: null, slack: null, console: { ok: true, detail: "c-conversation-1" } });
    }
    expect(env.threads.started).toHaveLength(1);
    expect(env.threads.posted.map((p) => p.id)).toEqual(["c-conversation-1"]);
    expect(env.slack.messages).toEqual([]);
    expect(env.email.sent).toEqual([]);
    expect((await env.service.get(created.routine.id))?.conversationId).toBe("c-conversation-1");
  });

  it("splits a long report into several Slack messages", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `- Line ${i}: ${"x".repeat(60)}`).join("\n");
    const env = await routineEnv({ brain: fakeBrain(() => ({ text: long, isError: false })) });
    const created = await env.service.create({ ...DIGEST, slack: "C0ACMEDEV1", console: false }, "test");
    if (!created.ok) throw new Error(created.error);
    const started = await env.service.runNow(created.routine.id);
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;
    expect(env.slack.messages.length).toBeGreaterThan(2);
    expect(env.slack.messages.every((m) => m.channel === "C0ACMEDEV1" && m.text.length <= 3000)).toBe(true);
    expect(run.delivered.slack).toEqual({ ok: true, detail: `Posted to C0ACMEDEV1 in ${env.slack.messages.length} messages` });
  });

  it("records email as not delivered while Email is not set up, and sends nothing", async () => {
    const env = await routineEnv({ emailReady: false });
    const created = await env.service.create({ ...DIGEST, email: ["dana@acme.example"] }, "test");
    if (!created.ok) throw new Error(created.error);
    const started = await env.service.runNow(created.routine.id);
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;
    expect(run.delivered.email).toEqual({ ok: false, error: "Email is not set up: set it up on the Integrations page." });
    expect(env.email.sent).toEqual([]);
    expect(run.delivered.console).toMatchObject({ ok: true });
  });

  it("a failed run tells the console only, redacted", async () => {
    const env = await routineEnv({ brain: fakeBrain(() => ({ text: `Claude could not answer: bad key ${SECRETS.apiKey}`, isError: true })) });
    const created = await env.service.create({ ...DIGEST, email: ["dana@acme.example"], slack: "C0ACMEDEV1" }, "test");
    if (!created.ok) throw new Error(created.error);
    const started = await env.service.runNow(created.routine.id);
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Claude could not answer: bad key [redacted]");
    expect(env.email.sent).toEqual([]);
    expect(env.slack.messages).toEqual([]);
    expect(env.threads.started[0]).toMatchObject({ isError: true, markdown: "**The routine could not finish:** Claude could not answer: bad key [redacted]" });
  });
});

describe("budget", () => {
  it("skips a run with a note when the spending cap is used up, before any model call", async () => {
    const error = "This month's Claude budget is used up: $50.00 of the $50.00 cap spent on chat and repo tasks.";
    const env = await routineEnv({ spending: { checkChat: async () => ({ ok: false, error }), notify: async () => undefined } });
    const created = await env.service.create(DIGEST, "test");
    if (!created.ok) throw new Error(created.error);
    env.clock.set("2026-11-21T08:00:10Z");
    const tick = await env.service.scheduler.tick();
    const [run] = await tick.finished;
    expect(run).toMatchObject({ status: "skipped", note: `Skipped: ${error}` });
    expect(env.brain.requests).toEqual([]);
    expect(env.threads.started).toEqual([]);
    // Skipped runs are not retried: the next tick finds nothing due.
    env.clock.set("2026-11-21T08:01:10Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);
  });

  it("passes the routine's budget, and the window from the last successful run", async () => {
    const env = await routineEnv({ clock: new Clock(Date.parse("2026-11-20T07:00:00Z")) });
    const created = await env.service.create({ ...DIGEST, budgetUsd: 0.4 }, "test");
    if (!created.ok) throw new Error(created.error);
    env.clock.set("2026-11-20T08:00:05Z");
    await (await env.service.scheduler.tick()).finished;
    env.clock.set("2026-11-21T08:00:05Z");
    await (await env.service.scheduler.tick()).finished;
    expect(env.brain.requests.map((r) => r.budgetUsd)).toEqual([0.4, 0.4]);
    expect(env.brain.requests[0]!.text).toContain("this is the first run, so the last 24 hours");
    expect(env.brain.requests[1]!.text).toContain("since the last successful run, Friday, November 20, 2026");
    expect(env.brain.requests[1]!.text).toContain("(2026-11-20T08:00:05.000Z)");
  });
});
