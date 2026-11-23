import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { type Config, ConfigSchema, isChatReady, isReady, publicView } from "../../src/core/config.js";
import {
  RunWatch,
  acrossRoute,
  errorFailure,
  fallbackLine,
  isRouteReady,
  onlyClaudeMissing,
  providerFailure,
  routeFor,
  routeProviders,
  routeRuntimes,
  routeSteps,
  routeView,
} from "../../src/ai/routing.js";

/** Claude and Kimi connected, DeepSeek not. */
function config(patch: (c: Config) => void = () => undefined): Config {
  const c = ConfigSchema.parse({});
  c.anthropic.apiKey = "sk-ant-x-123456789";
  c.ai.providers.kimi = { secrets: { apiKey: "sk-kimi-secret-0008" }, settings: {}, models: {} };
  patch(c);
  return c;
}

const assistant = (error?: string) => ({ type: "assistant", message: { content: [] }, parent_tool_use_id: null, ...(error ? { error } : {}) }) as unknown as SDKMessage;
const result = (patch: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: true, result: "", ...patch }) as unknown as SDKMessage;

describe("routes", () => {
  it("default to the chat and task providers alone, routines and light work following chat", () => {
    const c = config((c) => {
      c.ai.chatProvider = "kimi";
      c.ai.taskProvider = "anthropic";
    });
    expect(routeFor(c, "chat")).toEqual(["kimi"]);
    expect(routeFor(c, "routines")).toEqual(["kimi"]);
    expect(routeFor(c, "light")).toEqual(["kimi"]);
    expect(routeFor(c, "tasks")).toEqual(["anthropic"]);
  });

  it("use the owner's order, without repeats; routines follow the chat route when they have none", () => {
    const c = config((c) => {
      c.ai.routes = { chat: ["kimi", "anthropic", "kimi"], light: ["anthropic"] };
    });
    expect(routeFor(c, "chat")).toEqual(["kimi", "anthropic"]);
    expect(routeFor(c, "routines")).toEqual(["kimi", "anthropic"]);
    expect(routeFor(c, "light")).toEqual(["anthropic"]);
  });

  it("skip a provider that is not connected or over its cap, and say why", () => {
    const c = config((c) => {
      c.ai.routes = { chat: ["deepseek", "kimi", "anthropic"] };
    });
    const steps = routeSteps(c, "chat", { capProblem: (p) => (p === "kimi" ? "Kimi's monthly cap is used up." : undefined) });
    expect(steps.map((s) => [s.provider, Boolean(s.problem)])).toEqual([
      ["deepseek", true],
      ["kimi", true],
      ["anthropic", false],
    ]);
    const run = routeRuntimes(c, "chat", { capProblem: (p) => (p === "kimi" ? "used up" : undefined) });
    expect(run.ok && run.runtimes.map((r) => r.provider)).toEqual(["anthropic"]);
    expect(isRouteReady(c, "chat")).toBe(true);
  });

  it("fail with the provider's own message when it is the only one, and each one's when several", () => {
    const none = ConfigSchema.parse({});
    const alone = routeRuntimes(none, "chat");
    expect(alone).toMatchObject({ ok: false, error: "Claude is not connected. Ask the owner to add the Anthropic API key on the admin page." });
    none.ai.routes = { chat: ["anthropic", "deepseek"] };
    const both = routeRuntimes(none, "chat");
    expect(both.ok).toBe(false);
    expect(!both.ok && both.error).toMatch(/^No AI provider can run this\. Claude: .* DeepSeek: /);
    expect(isRouteReady(none, "chat")).toBe(false);
  });
});

describe("provider failures", () => {
  it("are the provider's errors, not the work's", () => {
    expect(providerFailure(assistant("rate_limit"))).toEqual({ kind: "rate_limit", reason: "rate limited" });
    expect(providerFailure(assistant("billing_error"))?.reason).toBe("out of credit");
    expect(providerFailure(assistant("invalid_request"))).toBeDefined();
    expect(providerFailure(assistant("max_output_tokens"))).toBeUndefined();
    expect(providerFailure(assistant("unknown"))).toBeUndefined();
    expect(providerFailure(assistant())).toBeUndefined();
  });

  it("are read from an error result's HTTP status, never from the platform's own limits", () => {
    expect(providerFailure(result({ api_error_status: 429 }))).toEqual({ kind: "http", reason: "rate limited" });
    expect(providerFailure(result({ subtype: "error_during_execution", api_error_status: 529 }))?.reason).toBe("overloaded");
    expect(providerFailure(result({ api_error_status: 200 }))).toBeUndefined();
    expect(providerFailure(result({ is_error: false, api_error_status: 429 }))).toBeUndefined();
    expect(providerFailure(result({ subtype: "error_max_turns", api_error_status: 429 }))).toBeUndefined();
    expect(providerFailure(result({ subtype: "error_max_budget_usd" }))).toBeUndefined();
  });

  it("are read from a thrown error's text", () => {
    expect(errorFailure(new Error("API Error: 429 {\"error\":\"too many\"}"))?.reason).toBe("rate limited");
    expect(errorFailure(new Error("Credit balance is too low"))?.kind).toBe("billing_error");
    expect(errorFailure(new Error("RESOURCE_EXHAUSTED: quota"))?.kind).toBe("rate_limit");
    expect(errorFailure(new Error("API Error: 503 Service Unavailable"))?.reason).toBe("unavailable");
    expect(errorFailure(new Error("Claude Code process exited with code 1"))).toBeUndefined();
  });

  it("are said in one line", () => {
    expect(fallbackLine({ from: "kimi", to: "anthropic", reason: "rate limited" })).toBe("Kimi failed (rate limited); Claude answered instead.");
  });
});

describe("watching a run", () => {
  const tool = (parent: string | null = null) =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: {} }] } }) as unknown as SDKMessage;
  const subagentError = { type: "assistant", parent_tool_use_id: "t1", error: "rate_limit", message: { content: [] } } as unknown as SDKMessage;
  const watch = (...messages: SDKMessage[]) => {
    const w = new RunWatch();
    for (const m of messages) w.feed(m);
    return w;
  };

  it("keeps the provider failure the run ended on, and whether a tool may have run", () => {
    const failed = watch(assistant("rate_limit"), result({ api_error_status: 429 }));
    expect(failed.failure?.reason).toBe("rate limited");
    expect(failed.toolRan).toBe(false);
    expect(watch(tool(), assistant("overloaded")).toolRan).toBe(true);
    // A subagent's tool counts: it may have done something.
    expect(watch(tool("toolu_parent")).toolRan).toBe(true);
    const streamed = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t2", name: "Agent", input: {} } } };
    expect(watch(streamed as unknown as SDKMessage).toolRan).toBe(true);
  });

  it("ignores a subagent's failure, and a failure the run went past", () => {
    expect(watch(subagentError, result({ is_error: false })).failure).toBeUndefined();
    expect(watch(subagentError).failure).toBeUndefined();
    // The main agent hit a rate limit, then the run stopped at its turn limit: the platform's stop, not the provider's.
    expect(watch(assistant("rate_limit"), result({ subtype: "error_max_turns" })).failure).toBeUndefined();
    // An error result without a status keeps the main agent's failure.
    expect(watch(assistant("billing_error"), result({ subtype: "error_during_execution" })).failure?.reason).toBe("out of credit");
  });

  it("reads a thrown error only before any result", () => {
    const early = new RunWatch();
    early.thrown(new Error("API Error: 503 Service Unavailable"));
    expect(early.failure?.reason).toBe("unavailable");
    const late = watch(result({ subtype: "error_max_turns" }));
    late.thrown(new Error("API Error: 503"));
    expect(late.failure).toBeUndefined();
  });

  it("collects the calls with effects outside the run, by kind, each tool once with how many times", () => {
    const calls = (parent: string | null, ...names: string[]) =>
      ({
        type: "assistant",
        parent_tool_use_id: parent,
        message: { content: names.map((name, i) => ({ type: "tool_use", id: `t${i}`, name, input: {} })) },
      }) as unknown as SDKMessage;
    const effectOf = (name: string) => (name.startsWith("mcp__app-") ? ("app" as const) : name === "mcp__browser__browser_click" ? ("browser" as const) : undefined);
    const w = new RunWatch(effectOf);
    expect(w.reachedOutside).toBe(false);
    // The lead's calls and a subagent's alike; reading and navigating are no effect outside.
    w.feed(calls(null, "Read", "mcp__browser__browser_navigate"));
    expect(w.reachedOutside).toBe(false);
    w.feed(calls("toolu_coder", "mcp__browser__browser_click", "mcp__app-stripe__create_issue"));
    w.feed(calls("toolu_coder", "mcp__browser__browser_click"));
    // A streamed start says nothing new: the whole message that follows does.
    const streamed = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t9", name: "mcp__app-stripe__create_issue", input: {} } } };
    w.feed(streamed as unknown as SDKMessage);
    expect(w.reachedOutside).toBe(true);
    expect(w.outside).toEqual({ app: [{ tool: "mcp__app-stripe__create_issue", count: 1 }], browser: [{ tool: "mcp__browser__browser_click", count: 2 }] });
    // Without a way to tell, nothing is collected.
    expect(watch(calls(null, "mcp__app-stripe__create_issue")).outside).toEqual({ app: [], browser: [] });
  });
});

describe("calls without side effects along a route", () => {
  const runtimes = () => {
    const run = routeRuntimes(config((c) => (c.ai.routes = { light: ["kimi", "anthropic"] })), "light");
    if (!run.ok) throw new Error(run.error);
    return run.runtimes;
  };

  it("ask the next provider while one fails for its own reasons", async () => {
    const asked: string[] = [];
    const out = await acrossRoute(runtimes(), async (r) => {
      asked.push(r.provider);
      return r.provider === "kimi" ? { value: "no", failure: { kind: "rate_limit", reason: "rate limited" } } : { value: "yes" };
    });
    expect(asked).toEqual(["kimi", "anthropic"]);
    expect(out).toMatchObject({ value: "yes", fallback: [{ from: "kimi", to: "anthropic", reason: "rate limited" }] });
    expect(out.runtime.provider).toBe("anthropic");
  });

  it("stop at the first answer, a failure of the work, or the last provider", async () => {
    const first = await acrossRoute(runtimes(), async () => ({ value: 1 }));
    expect(first).toMatchObject({ value: 1, fallback: [] });
    const all = await acrossRoute(runtimes(), async (r) => ({ value: r.provider, failure: { kind: "http", reason: "a server error" } }));
    expect(all.value).toBe("anthropic");
    expect(all.fallback).toHaveLength(1);
  });
});

describe("routes for the console and the caps", () => {
  it("show each kind's providers, whether the owner set them, and why one cannot run (without the owner hint)", () => {
    const c = config((c) => (c.ai.routes = { chat: ["deepseek", "kimi"] }));
    expect(routeView(c, "chat")).toEqual({
      custom: true,
      steps: [
        { provider: "deepseek", name: "DeepSeek", ready: false, problem: "DeepSeek is not set up." },
        { provider: "kimi", name: "Kimi", ready: true },
      ],
    });
    expect(routeView(c, "tasks")).toEqual({ custom: false, steps: [{ provider: "anthropic", name: "Claude", ready: true }] });
    expect(routeView(c, "light").custom).toBe(false);
    expect(routeView(c, "light").steps.map((s) => s.provider)).toEqual(["deepseek", "kimi"]);
  });

  it("are in the console's view of the config, readiness following the routes", () => {
    const c = config((c) => {
      c.ai.chatProvider = "deepseek";
      c.ai.routes = { chat: ["deepseek", "kimi"], tasks: ["deepseek"] };
    });
    const ai = publicView(c).ai;
    expect(ai.routes.chat).toEqual(routeView(c, "chat"));
    expect(Object.keys(ai.routes).sort()).toEqual(["chat", "light", "routines", "tasks"]);
    // DeepSeek is not connected, but Kimi can answer chat; repo tasks have nothing.
    expect(ai.chat).toEqual({ provider: "deepseek", name: "DeepSeek", ready: true });
    expect(ai.task.ready).toBe(false);
    c.slack.botToken = "xoxb-1";
    c.slack.signingSecret = "s";
    c.github.token = "ghp_x";
    expect(isChatReady(c)).toBe(true);
    expect(isReady(c)).toBe(false);
    c.ai.routes.tasks = ["deepseek", "anthropic"];
    expect(isReady(c)).toBe(true);
  });

  it("give the caps the connected providers, or all of them when none is", () => {
    const c = config((c) => (c.ai.routes = { chat: ["deepseek", "kimi", "anthropic"] }));
    expect(routeProviders(c, "chat")).toEqual(["kimi", "anthropic"]);
    c.ai.routes = { chat: ["deepseek", "qwen"] };
    expect(routeProviders(c, "chat")).toEqual(["deepseek", "qwen"]);
    expect(onlyClaudeMissing(routeSteps(ConfigSchema.parse({}), "chat"))).toBe(true);
  });
});
