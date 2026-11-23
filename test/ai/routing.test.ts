import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { errorFailure, fallbackLine, isRouteReady, providerFailure, routeFor, routeRuntimes, routeSteps } from "../../src/ai/routing.js";

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
