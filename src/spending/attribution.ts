import type { ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelPrice } from "../ai/ai-presets.js";
import type { EngineId } from "../core/config.js";
import { AGENT_TOOLS } from "../tasks/progress.js";
import { type EngineTokens, baseModelId, claudePrice } from "./prices.js";

/**
 * Who spent what in one Agent SDK query: Pointer (the lead, "pointer") and
 * each team member it delegated to. Built from the message stream at no
 * extra cost, with the same mapping progress.ts uses (a subagent's messages
 * carry the parent_tool_use_id of the Agent/Task call that started it, whose
 * input names its subagent_type; current SDKs also stamp subagent_type on
 * the message itself). Each assistant message's tokens are priced while the
 * query runs (an estimate, for the per-task caps); when it ends, Claude
 * Code's own per-model cost (the result's modelUsage) is shared out in the
 * same proportions, so the agents add up to the query's total_cost_usd.
 *
 * Codex and Gemini CLI runs (engines.ts) report tokens only: their cost is
 * estimated from a price table (prices.ts) and marked estimated, or left as
 * tokens when the model has no price. It is not part of the Claude total.
 */

/** The key of Pointer's own share (the orchestrator; a reserved agent id, so no team member has it). */
export const LEAD_AGENT_ID = "pointer";

export interface AgentEngineCost {
  /** Tokens its runs used, input and output. */
  tokens: number;
  /** Estimated USD, when the model has a price (included in the agent's usd). */
  usd?: number;
}

/** One agent's share of a task or a chat reply. */
export interface AgentCost {
  /** USD: its share of the Claude cost, plus its engine runs' estimate where priced. */
  usd: number;
  /** Part of usd is estimated from tokens (Codex or Gemini CLI runs, or no cost report from Claude Code). */
  estimated?: boolean;
  /** Tokens it used: Claude's (input, output and cache) and its engine runs'. */
  tokens?: number;
  /** Engine tokens with no dollar figure (the model has no price here). */
  unpricedTokens?: number;
  /** What its Codex or Gemini CLI runs used. */
  engines?: Partial<Record<EngineId, AgentEngineCost>>;
}

export type AgentCosts = Record<string, AgentCost>;

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** When a model has no price at all: Claude Sonnet's list price, so the shares keep the usual input/output/cache ratios. */
const FALLBACK_PRICE: ModelPrice = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const round = (n: number) => Math.round(n * 1e6) / 1e6;

const tokensOf = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite;
const costOf = (t: TokenCounts, p: ModelPrice) =>
  (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;

/** One engine run while it goes, then when it ended. */
export interface EngineRunHandle {
  /** Tokens so far and the estimate (undefined: no price); returns the agent's spend in this query with it, USD. */
  update(tokens: EngineTokens, usd: number | undefined): number;
  /** The run ended with these tokens. */
  end(tokens: EngineTokens | undefined, usd: number | undefined): void;
}

interface EngineRun {
  agent: string;
  engine: EngineId;
  tokens: number;
  usd?: number;
}

export interface SpendTrackerOptions {
  /** The team's agent ids: a subagent of another type (the SDK's built-in helpers) counts for whoever started it. */
  agents: Iterable<string>;
  /** Prices for the query's models (the provider's modelPricing, then Claude's list prices). */
  price?: (model: string) => ModelPrice | undefined;
}

export class SpendTracker {
  private readonly agents: Set<string>;
  private readonly price: (model: string) => ModelPrice | undefined;
  /** Agent/Task tool-use id → the agent it started (or its caller, for a type that is not a team member). */
  private readonly delegations = new Map<string, string>();
  /** A subagent's own id (agent_id) → the agent, for hooks that only carry it. */
  private readonly subagentIds = new Map<string, string>();
  /** Assistant messages by id: one response streams as several messages sharing it, usage growing. */
  private readonly responses = new Map<string, { agent: string; model: string; tokens: TokenCounts }>();
  private readonly engineRuns: EngineRun[] = [];

  constructor(opts: SpendTrackerOptions) {
    this.agents = new Set(opts.agents);
    this.price = opts.price ?? claudePrice;
  }

  /** Whose turn an assistant message is: the lead, or the team member its subagent is. */
  private agentOf(parentToolUseId: string | null, subagentType: string | undefined, agentId: string | undefined): string {
    if (parentToolUseId === null) return LEAD_AGENT_ID;
    if (subagentType && this.agents.has(subagentType)) return subagentType;
    return this.delegations.get(parentToolUseId) ?? (agentId ? this.subagentIds.get(agentId) : undefined) ?? LEAD_AGENT_ID;
  }

  /** The agent a hook's subagent context stands for (agent_type, else its agent_id), or undefined for the lead. */
  agentFor(input: { agent_type?: string; agent_id?: string }): string | undefined {
    if (!input.agent_id && !input.agent_type) return undefined;
    if (input.agent_type && this.agents.has(input.agent_type)) return input.agent_type;
    return input.agent_id ? this.subagentIds.get(input.agent_id) : undefined;
  }

  /** Feeds one SDK message. Never throws. */
  feed(message: SDKMessage): void {
    try {
      if (message.type === "system" && message.subtype === "task_started") {
        const type = message.subagent_type;
        const agent = type && this.agents.has(type) ? type : message.tool_use_id ? this.delegations.get(message.tool_use_id) : undefined;
        if (agent) this.subagentIds.set(message.task_id, agent);
        return;
      }
      if (message.type !== "assistant") return;
      const m = message as typeof message & { subagent_type?: string; agent_id?: string };
      const agent = this.agentOf(m.parent_tool_use_id, m.subagent_type, m.agent_id);
      if (m.agent_id && agent !== LEAD_AGENT_ID) this.subagentIds.set(m.agent_id, agent);
      const body = m.message as unknown;
      if (!isRecord(body)) return;
      for (const block of Array.isArray(body.content) ? body.content : []) {
        if (!isRecord(block) || block.type !== "tool_use" || !AGENT_TOOLS.has(str(block.name))) continue;
        const type = isRecord(block.input) ? str(block.input.subagent_type) : "";
        // A built-in helper (general-purpose, Explore…) counts for whoever asked for it.
        this.delegations.set(str(block.id), type && this.agents.has(type) ? type : agent);
      }
      const model = str(body.model);
      const usage = isRecord(body.usage) ? body.usage : undefined;
      if (!usage || !model || model.startsWith("<")) return;
      const id = str(body.id) || m.uuid;
      const tokens: TokenCounts = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
      };
      const seen = this.responses.get(id);
      if (!seen) {
        this.responses.set(id, { agent, model, tokens });
        return;
      }
      // Later frames of the same response: its usage only grows.
      for (const k of Object.keys(tokens) as (keyof TokenCounts)[]) seen.tokens[k] = Math.max(seen.tokens[k], tokens[k]);
    } catch {
      // Attribution must never break the run.
    }
  }

  private priceOf(model: string): ModelPrice {
    return this.price(model) ?? FALLBACK_PRICE;
  }

  /** A Codex or Gemini CLI run by `agent` starting. */
  engineRun(agent: string, engine: EngineId): EngineRunHandle {
    const run: EngineRun = { agent, engine, tokens: 0 };
    this.engineRuns.push(run);
    const total = (t: EngineTokens) => Math.max(0, t.input) + Math.max(0, t.output);
    return {
      update: (tokens, usd) => {
        run.tokens = total(tokens);
        if (usd === undefined) delete run.usd;
        else run.usd = usd;
        return this.usd(agent);
      },
      end: (tokens, usd) => {
        run.tokens = tokens ? total(tokens) : run.tokens;
        if (usd !== undefined) run.usd = usd;
        else if (tokens) delete run.usd;
      },
    };
  }

  /** What `agent` has spent in this query so far, USD: its Claude tokens at list prices and its engine runs' estimates. */
  usd(agent: string): number {
    let total = 0;
    for (const r of this.responses.values()) if (r.agent === agent) total += costOf(r.tokens, this.priceOf(r.model));
    for (const run of this.engineRuns) if (run.agent === agent) total += run.usd ?? 0;
    return total;
  }

  /**
   * Each agent's share. With the query's result: Claude Code's cost per model
   * (modelUsage) split in proportion to each agent's tokens at that model's
   * price, the rest of total_cost_usd (calls no agent's message shows) to the
   * lead. Without one (the query stopped first): list prices, marked estimated.
   */
  costs(result?: { total_cost_usd?: number; modelUsage?: Record<string, ModelUsage> }): AgentCosts {
    const listCost = new Map<string, Map<string, number>>();
    const tokens = new Map<string, number>();
    for (const r of this.responses.values()) {
      const model = baseModelId(r.model);
      const byModel = listCost.get(r.agent) ?? new Map<string, number>();
      byModel.set(model, (byModel.get(model) ?? 0) + costOf(r.tokens, this.priceOf(r.model)));
      listCost.set(r.agent, byModel);
      tokens.set(r.agent, (tokens.get(r.agent) ?? 0) + tokensOf(r.tokens));
    }

    const shares = new Map<string, number>();
    const add = (agent: string, usd: number) => shares.set(agent, (shares.get(agent) ?? 0) + usd);
    const total = num(result?.total_cost_usd);
    const usage = result?.modelUsage ?? {};
    if (result && total > 0) {
      const matched = new Set<string>();
      for (const [key, mu] of Object.entries(usage)) {
        const cost = num(mu?.costUSD);
        if (!cost) continue;
        const names = new Set([baseModelId(key), ...(mu.canonicalModel ? [baseModelId(mu.canonicalModel)] : [])]);
        let sum = 0;
        for (const byModel of listCost.values()) for (const [model, c] of byModel) if (names.has(model)) sum += c;
        if (sum <= 0) {
          add(LEAD_AGENT_ID, cost);
          continue;
        }
        for (const name of names) matched.add(name);
        for (const [agent, byModel] of listCost) {
          let own = 0;
          for (const [model, c] of byModel) if (names.has(model)) own += c;
          if (own > 0) add(agent, (cost * own) / sum);
        }
      }
      // Models no cost report names: at list prices, then everything is scaled to the reported total.
      for (const [agent, byModel] of listCost) for (const [model, c] of byModel) if (!matched.has(model)) add(agent, c);
      const sum = [...shares.values()].reduce((a, b) => a + b, 0);
      if (sum > 0) for (const [agent, usd] of shares) shares.set(agent, (usd * total) / sum);
      else add(LEAD_AGENT_ID, total);
    } else {
      for (const [agent, byModel] of listCost) for (const c of byModel.values()) add(agent, c);
    }
    const estimated = !result || total <= 0;

    const out: AgentCosts = {};
    const entry = (agent: string): AgentCost => (out[agent] ??= { usd: 0 });
    for (const [agent, usd] of shares) {
      const e = entry(agent);
      e.usd += usd;
      if (estimated && usd > 0) e.estimated = true;
    }
    for (const [agent, n] of tokens) if (n > 0) entry(agent).tokens = (entry(agent).tokens ?? 0) + n;
    for (const run of this.engineRuns) {
      if (!run.tokens && run.usd === undefined) continue;
      const e = entry(run.agent);
      const engine = ((e.engines ??= {})[run.engine] ??= { tokens: 0 });
      engine.tokens += run.tokens;
      e.tokens = (e.tokens ?? 0) + run.tokens;
      if (run.usd !== undefined) {
        engine.usd = (engine.usd ?? 0) + run.usd;
        e.usd += run.usd;
        e.estimated = true;
      } else if (run.tokens) {
        e.unpricedTokens = (e.unpricedTokens ?? 0) + run.tokens;
      }
    }
    return normalizeCosts(out);
  }
}

/** Rounded to a millionth of a dollar, without empty fields. */
function normalizeCosts(costs: AgentCosts): AgentCosts {
  const out: AgentCosts = {};
  for (const [agent, c] of Object.entries(costs)) {
    const engines = c.engines
      ? Object.fromEntries(
          Object.entries(c.engines).map(([id, e]) => [id, { tokens: e!.tokens, ...(e!.usd !== undefined ? { usd: round(e!.usd) } : {}) }]),
        )
      : undefined;
    out[agent] = {
      usd: round(c.usd),
      ...(c.estimated ? { estimated: true } : {}),
      ...(c.tokens ? { tokens: c.tokens } : {}),
      ...(c.unpricedTokens ? { unpricedTokens: c.unpricedTokens } : {}),
      ...(engines && Object.keys(engines).length ? { engines } : {}),
    };
  }
  return out;
}

/** Two sets of shares added up (a task's runs, or a run's share on top of what the task spent before it). */
export function addCosts(a: AgentCosts | undefined, b: AgentCosts | undefined): AgentCosts {
  const out: AgentCosts = {};
  for (const costs of [a, b]) {
    for (const [agent, c] of Object.entries(costs ?? {})) {
      const e = (out[agent] ??= { usd: 0 });
      e.usd += num(c.usd);
      if (c.estimated) e.estimated = true;
      if (c.tokens) e.tokens = (e.tokens ?? 0) + num(c.tokens);
      if (c.unpricedTokens) e.unpricedTokens = (e.unpricedTokens ?? 0) + num(c.unpricedTokens);
      for (const [id, ec] of Object.entries(c.engines ?? {})) {
        if (!ec) continue;
        const engine = ((e.engines ??= {})[id as EngineId] ??= { tokens: 0 });
        engine.tokens += num(ec.tokens);
        if (ec.usd !== undefined) engine.usd = (engine.usd ?? 0) + num(ec.usd);
      }
    }
  }
  return normalizeCosts(out);
}

/** The USD an agent's entry holds (0 when it has none). */
export const agentUsd = (costs: AgentCosts | undefined, agent: string): number => num(costs?.[agent]?.usd);
