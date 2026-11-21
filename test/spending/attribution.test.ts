import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { LEAD_AGENT_ID, SpendTracker, addCosts } from "../../src/spending/attribution.js";
import { baseModelId, claudePrice, engineUsd, enginePrice, priceLookup } from "../../src/spending/prices.js";
import { TASK_CAP_REACHED, TaskSpend } from "../../src/spending/task-spend.js";

// ---------- A fake SDK stream: Pointer (Opus), the Coder and the Reviewer (Sonnet) ----------

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

let n = 0;
function assistant(o: {
  id: string;
  model: string;
  parent?: string | null;
  usage: ReturnType<typeof usage>;
  content?: unknown[];
  subagentType?: string;
  agentId?: string;
}): SDKMessage {
  return {
    type: "assistant",
    uuid: `u-${n++}`,
    session_id: "s",
    parent_tool_use_id: o.parent ?? null,
    ...(o.subagentType ? { subagent_type: o.subagentType } : {}),
    ...(o.agentId ? { agent_id: o.agentId } : {}),
    message: { id: o.id, type: "message", role: "assistant", model: o.model, content: o.content ?? [], stop_reason: null, usage: o.usage },
  } as unknown as SDKMessage;
}

const delegate = (id: string, subagentType: string) => ({ type: "tool_use", id, name: "Agent", input: { subagent_type: subagentType, description: "work", prompt: "do it" } });

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

/** Pointer plans and delegates twice; the Coder works (one response streamed as two frames) and asks a built-in helper; the Reviewer reviews. */
function stream(): SDKMessage[] {
  return [
    assistant({ id: "m-lead-1", model: OPUS, usage: usage(1_000, 100), content: [delegate("toolu_coder", "coder")] }),
    assistant({ id: "m-coder-1", model: SONNET, parent: "toolu_coder", usage: usage(2_000, 50) }),
    // Later frame of the same response: usage grows, counted once.
    assistant({ id: "m-coder-1", model: SONNET, parent: "toolu_coder", usage: usage(2_000, 500), content: [delegate("toolu_helper", "general-purpose")] }),
    // The built-in helper the Coder asked for counts for the Coder.
    assistant({ id: "m-helper-1", model: SONNET, parent: "toolu_helper", usage: usage(1_000, 0) }),
    assistant({ id: "m-lead-2", model: OPUS, usage: usage(500, 100), content: [delegate("toolu_reviewer", "reviewer")] }),
    // Current SDKs stamp the subagent type on the message itself.
    assistant({ id: "m-rev-1", model: SONNET, parent: "toolu_reviewer", subagentType: "reviewer", agentId: "a-rev", usage: usage(1_000, 500) }),
    // A synthetic error message has no real model: not counted.
    assistant({ id: "m-synth", model: "<synthetic>", usage: usage(9_999, 9_999) }),
  ];
}

const AGENTS = ["coder", "reviewer", "qa"];

function fed(): SpendTracker {
  const t = new SpendTracker({ agents: AGENTS });
  for (const m of stream()) t.feed(m);
  return t;
}

describe("prices", () => {
  it("normalises provider model ids and finds Claude's list price", () => {
    expect(baseModelId("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(baseModelId("us.anthropic.claude-sonnet-5-5-v1:0")).toBe("claude-sonnet-5-5");
    expect(baseModelId("claude-opus-4-1@20250805")).toBe("claude-opus-4-1");
    expect(baseModelId("gemini-3-pro-preview")).toBe("gemini-3-pro");
    expect(baseModelId("gpt-5-2025-08-07")).toBe("gpt-5");
    expect(claudePrice("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(claudePrice("sonnet")).toEqual(claudePrice("claude-sonnet-5-5"));
    expect(claudePrice("kimi-k3")).toBeUndefined();
    // A provider's own rows come first.
    const own = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
    expect(priceLookup({ "kimi-k3": own })("kimi-k3[1m]")).toEqual(own);
    expect(priceLookup({ "kimi-k3": own })(OPUS)).toEqual(claudePrice(OPUS));
  });

  it("estimates an engine run from its tokens, cached input at its own price, and has no figure for an unknown model", () => {
    // 600k fresh at $1.25, 400k cached at $0.125, 100k out at $10.
    expect(engineUsd("codex", "gpt-5.1-codex", { input: 1_000_000, cached: 400_000, output: 100_000 })).toBeCloseTo(0.75 + 0.05 + 1, 10);
    expect(engineUsd("gemini", "gemini-2.5-pro", { input: 200_000, output: 10_000 })).toBeCloseTo(0.25 + 0.1, 10);
    // Exact models only: never a near one's price.
    expect(enginePrice("codex", "gpt-5-pro")).toBeUndefined();
    expect(engineUsd("codex", "", { input: 1_000, output: 1_000 })).toBeUndefined();
    expect(engineUsd("gemini", "auto", { input: 1_000, output: 1_000 })).toBeUndefined();
    // More cached than input is clamped.
    expect(engineUsd("codex", "gpt-5", { input: 100, cached: 1_000, output: 0 })).toBeCloseTo((100 * 0.125) / 1e6, 12);
  });
});

describe("SpendTracker", () => {
  it("prices each agent's own responses while the query runs, a streamed response once", () => {
    const t = fed();
    const lead = ((1_000 + 500) * 4 + (100 + 100) * 20) / 1e6;
    const coder = ((2_000 + 1_000) * 2 + 500 * 10) / 1e6;
    const reviewer = (1_000 * 2 + 500 * 10) / 1e6;
    expect(t.usd(LEAD_AGENT_ID)).toBeCloseTo(lead, 12);
    expect(t.usd("coder")).toBeCloseTo(coder, 12);
    expect(t.usd("reviewer")).toBeCloseTo(reviewer, 12);
    expect(t.usd("qa")).toBe(0);
  });

  it("shares Claude Code's cost per model out to the agents, adding up to the query's total", () => {
    const t = fed();
    const costs = t.costs({
      total_cost_usd: 0.1,
      modelUsage: {
        [`${OPUS}[1m]`]: { costUSD: 0.04 } as never,
        [SONNET]: { costUSD: 0.06 } as never,
      },
    });
    // Opus: only Pointer used it. Sonnet: split by list cost, Coder 11/18 and Reviewer 7/18.
    expect(costs.pointer!.usd).toBeCloseTo(0.04, 6);
    expect(costs.coder!.usd).toBeCloseTo((0.06 * 11) / 18, 6);
    expect(costs.reviewer!.usd).toBeCloseTo((0.06 * 7) / 18, 6);
    expect(Object.values(costs).reduce((s, c) => s + c.usd, 0)).toBeCloseTo(0.1, 6);
    expect(costs.coder).toMatchObject({ tokens: 3_500 });
    expect(costs.coder!.estimated).toBeUndefined();
    expect(costs.qa).toBeUndefined();
  });

  it("gives the lead what no agent's message shows, and estimates at list prices without a result", () => {
    const t = fed();
    const withHelper = t.costs({ total_cost_usd: 0.11, modelUsage: { [OPUS]: { costUSD: 0.04 } as never, [SONNET]: { costUSD: 0.06 } as never, "claude-haiku-5-5": { costUSD: 0.01 } as never } });
    expect(withHelper.pointer!.usd).toBeCloseTo(0.05, 6);
    const estimate = t.costs();
    expect(estimate.coder).toMatchObject({ estimated: true });
    expect(estimate.coder!.usd).toBeCloseTo(t.usd("coder"), 6);
  });

  it("counts engine runs for their agent: priced ones as estimated dollars, others as tokens only", () => {
    const t = new SpendTracker({ agents: ["codex-coder", "gem"] });
    const priced = t.engineRun("codex-coder", "codex");
    expect(priced.update({ input: 1_000, output: 0 }, 0.01)).toBeCloseTo(0.01, 12);
    priced.end({ input: 100_000, output: 10_000 }, 0.2);
    t.engineRun("gem", "gemini").end({ input: 5_000, output: 500 }, undefined);
    const costs = t.costs({ total_cost_usd: 0, modelUsage: {} });
    expect(costs["codex-coder"]).toEqual({ usd: 0.2, estimated: true, tokens: 110_000, engines: { codex: { tokens: 110_000, usd: 0.2 } } });
    expect(costs.gem).toEqual({ usd: 0, tokens: 5_500, unpricedTokens: 5_500, engines: { gemini: { tokens: 5_500 } } });
  });

  it("adds shares up across runs", () => {
    const sum = addCosts(
      { pointer: { usd: 0.1, tokens: 10 }, coder: { usd: 0.2, engines: { codex: { tokens: 5, usd: 0.01 } }, estimated: true } },
      { coder: { usd: 0.3, tokens: 4, unpricedTokens: 2 }, qa: { usd: 0.05 } },
    );
    expect(sum).toEqual({
      pointer: { usd: 0.1, tokens: 10 },
      coder: { usd: 0.5, estimated: true, tokens: 4, unpricedTokens: 2, engines: { codex: { tokens: 5, usd: 0.01 } } },
      qa: { usd: 0.05 },
    });
  });
});

// ---------- The per-task cap ----------

const preToolUse = (tool: string, o: { agentType?: string; agentId?: string; input?: Record<string, unknown> } = {}): HookInput =>
  ({
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
    tool_name: tool,
    tool_input: o.input ?? {},
    tool_use_id: `t-${n++}`,
    ...(o.agentId ? { agent_id: o.agentId } : {}),
    ...(o.agentType ? { agent_type: o.agentType } : {}),
  }) as HookInput;

const callHook = (spend: TaskSpend, input: HookInput) => spend.hook(input, undefined, { signal: new AbortController().signal });

describe("TaskSpend (per-task caps)", () => {
  const setup = (caps: Record<string, number>) => {
    const reached: string[] = [];
    const spend = new TaskSpend({
      agents: ["coder", "reviewer", "codex-coder"],
      engineAgents: { codex: ["codex-coder"] },
      price: claudePrice,
      capFor: (id) => caps[id] ?? 0,
      name: (id) => ({ coder: "Coder", reviewer: "Reviewer", "codex-coder": "Codex" })[id] ?? id,
      onCapReached: (id) => reached.push(id),
    });
    return { spend, reached };
  };

  it("denies an agent's tool calls once its spend in this task passes its cap, and leaves the others alone", async () => {
    const { spend, reached } = setup({ coder: 0.01 });
    const tracker = spend.startRun();
    tracker.feed(assistant({ id: "l", model: OPUS, usage: usage(10, 10), content: [delegate("toolu_c", "coder")] }));
    // $0.006 so far: under the cap.
    tracker.feed(assistant({ id: "c1", model: SONNET, parent: "toolu_c", usage: usage(3_000, 0) }));
    expect(await callHook(spend, preToolUse("Edit", { agentType: "coder", agentId: "a1" }))).toEqual({});
    // $0.011: past it.
    tracker.feed(assistant({ id: "c2", model: SONNET, parent: "toolu_c", usage: usage(2_500, 0) }));
    const denied = await callHook(spend, preToolUse("Bash", { agentType: "coder", agentId: "a1" }));
    expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    const reason = (denied as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
    expect(reason.startsWith(TASK_CAP_REACHED)).toBe(true);
    expect(reason).toContain("Coder has spent $0.01 of the $0.01");
    // Others (no cap), and Pointer itself (no subagent context), go on.
    expect(await callHook(spend, preToolUse("Bash", { agentType: "reviewer", agentId: "a2" }))).toEqual({});
    expect(await callHook(spend, preToolUse("Bash"))).toEqual({});
    expect(reached).toEqual(["coder"]);

    // The cap holds across the task's runs (a fix round).
    spend.endRun({ total_cost_usd: 0.02, modelUsage: { [SONNET]: { costUSD: 0.019 } as never, [OPUS]: { costUSD: 0.001 } as never } });
    spend.startRun();
    expect(spend.spent("coder")).toBeCloseTo(0.019, 6);
    expect(await callHook(spend, preToolUse("Read", { agentType: "coder", agentId: "a9" }))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(reached).toEqual(["coder"]);
  });

  it("matches an engine run to the agent whose call the hook saw, and stops it once the agent's estimate passes its cap", async () => {
    const { spend } = setup({ "codex-coder": 0.5 });
    spend.startRun();
    const tool = "mcp__engines__codex_run";
    expect(await callHook(spend, preToolUse(tool, { agentType: "codex-coder", agentId: "a3", input: { task: "  Add a test.  " } }))).toEqual({});
    const run = spend.engines.begin({ engine: "codex", tool, task: "Add a test.", model: "gpt-5.1-codex" })!;
    expect(run).toBeDefined();
    // $0.125 + $0.10 = $0.225: under.
    expect(run.update({ input: 100_000, output: 10_000 }, "gpt-5.1-codex")).toBe(false);
    // $1.25: past $0.50.
    expect(run.update({ input: 1_000_000, output: 0 }, "gpt-5.1-codex")).toBe(true);
    run.end({ input: 1_000_000, output: 0 }, "gpt-5.1-codex");
    expect(spend.live()["codex-coder"]).toMatchObject({ usd: 1.25, estimated: true, engines: { codex: { tokens: 1_000_000, usd: 1.25 } } });
    // And the agent's next call is denied.
    expect(await callHook(spend, preToolUse(tool, { agentType: "codex-coder", input: { task: "More." } }))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("never stops a run whose model has no price (tokens only), and finds the only agent of an engine without a hook", () => {
    const { spend } = setup({ "codex-coder": 0.01 });
    spend.startRun();
    const run = spend.engines.begin({ engine: "codex", tool: "mcp__engines__codex_run", task: "x", model: "" })!;
    expect(run.update({ input: 10_000_000, output: 1_000_000 }, "")).toBe(false);
    run.end({ input: 10_000_000, output: 1_000_000 }, "");
    expect(spend.endRun()["codex-coder"]).toMatchObject({ usd: 0, unpricedTokens: 11_000_000 });
    // No run going: nothing is tracked.
    expect(spend.engines.begin({ engine: "codex", tool: "mcp__engines__codex_run", task: "x", model: "" })).toBeUndefined();
  });
});
