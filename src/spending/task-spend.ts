import type { HookCallback, ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelPrice } from "../ai/ai-presets.js";
import type { EngineRunSpend, EngineSpend } from "../ai/engines.js";
import type { EngineId } from "../core/config.js";
import { type AgentCosts, SpendTracker, addCosts, agentUsd } from "./attribution.js";
import { engineUsd } from "./prices.js";
import { usd } from "./usage.js";

/**
 * A repo task's spend while it runs (the worker's): each run of the team is
 * tracked (attribution.ts) and added to what the task's earlier runs spent,
 * and an agent with a per-task cap (config.budget.perTaskAgentUsd) is held to
 * it across runs: past the cap its tool calls are denied (the PreToolUse
 * hook, keyed by the subagent's context like the other gates) and its Codex or
 * Gemini CLI runs are stopped (engines.ts). Its Claude spend is counted at list
 * prices while it works (Claude Code's own figure comes at the end of a run),
 * so the cap is a close brake, not an exact one: a step already under way finishes.
 */

/** The SDK's server for engine tools (engines.ts ENGINES_SERVER), as hooks see their names. */
const ENGINE_TOOL_PREFIX = "mcp__engines__";

/** The tool call's text the engine handler receives too (zod trims it), to match a call to its agent. */
const callKey = (tool: string, task: unknown) => `${tool}\n${typeof task === "string" ? task.trim() : ""}`;

export const TASK_CAP_REACHED = "Budget for this task reached; wrap up and report.";

export interface TaskSpendOptions {
  /** The task's team (agent ids): any other subagent type counts for whoever started it. */
  agents: string[];
  /** The agents that work through each engine, to match a run no hook saw (one agent per engine). */
  engineAgents?: Partial<Record<EngineId, string[]>>;
  /** Prices of the task provider's models (prices.ts runtimePrices). */
  price: (model: string) => ModelPrice | undefined;
  /** What an agent may spend in this task; 0 = no cap. */
  capFor: (agentId: string) => number;
  /** An agent's name, for messages. */
  name: (agentId: string) => string;
  /** An agent reached its cap (called once per agent): for the task's timeline. */
  onCapReached?: (agentId: string, text: string) => void;
}

export class TaskSpend {
  private done: AgentCosts = {};
  private current: SpendTracker | undefined;
  /** Engine calls a hook saw, by tool and assignment, waiting for their run: the agents that made them, oldest first. */
  private readonly pendingCalls = new Map<string, string[]>();
  private readonly reached = new Set<string>();

  constructor(private readonly o: TaskSpendOptions) {}

  /** A run of the team starts: feed its messages to the tracker returned. */
  startRun(): SpendTracker {
    this.current = new SpendTracker({ agents: this.o.agents, price: this.o.price });
    return this.current;
  }

  /** The run ended (with its result, when one came): its shares join the task's. Returns the task's shares so far. */
  endRun(result?: { total_cost_usd?: number; modelUsage?: Record<string, ModelUsage> }): AgentCosts {
    if (this.current) this.done = addCosts(this.done, this.current.costs(result));
    this.current = undefined;
    this.pendingCalls.clear();
    return this.done;
  }

  /** Spend outside the team's runs (the size estimate): added to the task's shares. */
  add(costs: AgentCosts): void {
    this.done = addCosts(this.done, costs);
  }

  /** The task's shares now, the running run's at list prices (marked estimated until it ends). */
  live(): AgentCosts {
    return this.current ? addCosts(this.done, this.current.costs()) : this.done;
  }

  /** What `agent` has spent in this task so far, USD. */
  spent(agent: string): number {
    return agentUsd(this.done, agent) + (this.current?.usd(agent) ?? 0);
  }

  private capReached(agent: string, cap: number): string {
    const text = `${TASK_CAP_REACHED} (${this.o.name(agent)} has spent ${usd(this.spent(agent))} of the ${usd(cap)} it may spend in this task.)`;
    if (!this.reached.has(agent)) {
      this.reached.add(agent);
      try {
        this.o.onCapReached?.(agent, `${this.o.name(agent)} reached its budget for this task (${usd(cap)}): its further tool calls are denied.`);
      } catch {
        // a listener must never break the gate
      }
    }
    return text;
  }

  /** PreToolUse, every tool: inside a subagent past its per-task cap, deny; an engine call is matched to its agent. */
  readonly hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const agent = this.current?.agentFor(input);
    if (!agent) return {};
    const cap = this.o.capFor(agent);
    if (cap > 0 && this.spent(agent) >= cap) {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: this.capReached(agent, cap) } };
    }
    if (input.tool_name.startsWith(ENGINE_TOOL_PREFIX)) {
      const key = callKey(input.tool_name, (input.tool_input as { task?: unknown } | undefined)?.task);
      this.pendingCalls.set(key, [...(this.pendingCalls.get(key) ?? []), agent]);
    }
    return {};
  };

  /** For engines.ts: each run's tokens, priced (prices.ts), counted for its agent and held to its per-task cap. */
  readonly engines: EngineSpend = {
    begin: ({ engine, tool, task, agent: owner }) => {
      const tracker = this.current;
      if (!tracker) return undefined;
      const key = callKey(tool, task);
      const queue = this.pendingCalls.get(key);
      const only = this.o.engineAgents?.[engine];
      const matched = queue?.shift();
      // An agent's own tool says whose run it is: so does the next CLI of its line, taking over within the same call.
      const agent = (owner && this.o.agents.includes(owner) ? owner : undefined) ?? matched ?? (only?.length === 1 ? only[0] : undefined);
      if (queue && !queue.length) this.pendingCalls.delete(key);
      if (!agent) return undefined;
      const run = tracker.engineRun(agent, engine);
      const spend: EngineRunSpend = {
        update: (tokens, model) => {
          const estimate = engineUsd(engine, model, tokens);
          const inRun = run.update(tokens, estimate);
          const cap = this.o.capFor(agent);
          if (!(cap > 0) || estimate === undefined) return false;
          const reached = agentUsd(this.done, agent) + inRun >= cap;
          if (reached) this.capReached(agent, cap);
          return reached;
        },
        end: (tokens, model) => run.end(tokens, tokens ? engineUsd(engine, model, tokens) : undefined),
      };
      return spend;
    },
  };
}
