/**
 * The Team page's vocabulary and rules: option lists, labels, the agent id
 * rule and the checks the page runs before saving. They mirror src/team/team.ts
 * (AgentSpecSchema, PointerSpecSchema, RESERVED_AGENT_IDS); the server
 * validates again and its message is shown when it disagrees.
 */
import type { SelectorOptionData } from "@astryxdesign/core/Selector";
import { presetModelLabel, tierModels } from "../../lib/aiProviders";
import type { AgentEngine } from "../../lib/engines";
import type { PickerSpecial } from "../../lib/modelPicker";
import type { ModelSource } from "../../lib/models";
import {
  type Access,
  type AgentSpec,
  type AiProviderId,
  type AiProviderView,
  type CatalogModel,
  type Effort,
  EFFORT_OPTIONS,
  type PointerSpec,
  type PresetModel,
} from "../../lib/types";

export const MAX_AGENTS = 30;

// ---------- Models ----------

/** Claude's models by id, for their names where no list is loaded (the agents table, HR, the office). */
const MODELS: { value: string; label: string }[] = [
  { value: "claude-fable-5-2", label: "Fable 5.2" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-1", label: "Fable 5.1" },
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/** "claude-sonnet-5-5" → "Sonnet 5.5"; other ids as they are. */
export const modelLabel = (id: string): string => MODELS.find((m) => m.value === id)?.label ?? id;

/**
 * What the model pickers need of the provider the work runs on: where its
 * models come from (Anthropic's, or the provider chat or repo tasks run on),
 * and how to word its default and the models its list does not name.
 */
export interface ModelChoices {
  /** Anthropic: Claude's models and wording, as before providers existed. */
  isClaude: boolean;
  /** "Kimi" */
  name: string;
  /** Whose list the pickers load (ModelPicker). */
  source: ModelSource;
  /** Models set under Integrations that its list may not have (a tier's id typed by hand). */
  extra: CatalogModel[];
  /** More words for its preset models, by id: the tier each suits. */
  notes: Record<string, string>;
  /** What an empty model runs on: the provider's main model, e.g. "Kimi K3". */
  defaultLabel: string;
  /** How a saved model the list does not name runs. */
  describe: (id: string) => string;
}

export const CLAUDE_CHOICES: ModelChoices = {
  isClaude: true,
  name: "Claude",
  source: { kind: "provider", id: "anthropic" },
  extra: [],
  notes: {},
  defaultLabel: "",
  describe: () => "Typed by hand, or set outside this page",
};

const CLAUDE_ID_RE = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:$|-|\[)/;
const TIER_HINT: Record<PresetModel["tier"], string> = { opus: "the largest", sonnet: "balanced", haiku: "fast and cheap" };

/** The models of provider `id` for the pickers; Claude's when it is Anthropic. `p` is its view, once loaded. */
export function providerChoices(id: AiProviderId, p: AiProviderView | undefined): ModelChoices {
  if (id === "anthropic") return CLAUDE_CHOICES;
  const source: ModelSource = { kind: "provider", id };
  if (!p) return { isClaude: false, name: "the provider", source, extra: [], notes: {}, defaultLabel: "the provider's main model", describe: () => "Set outside this page" };
  const tiers = tierModels(p);
  const extra = [...new Set(Object.values(tiers).filter((m) => m && !p.models.some((x) => x.id === m)))].map((m) => ({
    id: m,
    label: m,
    description: "Set under Integrations, AI model",
  }));
  return {
    isClaude: false,
    name: p.short,
    source,
    extra,
    notes: Object.fromEntries(p.models.map((m) => [m.id, TIER_HINT[m.tier]])),
    defaultLabel: tiers.main ? presetModelLabel(p, tiers.main) : "the endpoint's default",
    describe: (id) => {
      const alias = id.toLowerCase().match(CLAUDE_ID_RE)?.[1];
      const tier = alias === "fable" ? "opus" : alias;
      if (!tier) return "Set outside this page";
      const runs = tiers[tier as keyof typeof tiers];
      return runs ? `A Claude model: runs on ${p.short}'s ${presetModelLabel(p, runs)}` : `A Claude model, sent to ${p.short} as it is`;
    },
  };
}

/** An agent's model picker's first choice: empty runs it on Pointer's model. */
export const agentModelSpecials = (lead: string): PickerSpecial[] => [{ value: "", label: `Same as ${lead}`, description: `The model ${lead} runs on` }];

/** Pointer's chat model picker's (and a routed size's) first choice: empty falls back to the model under Integrations, not to Pointer. */
export const chatModelSpecials = (claudeDefault: string, choices: ModelChoices = CLAUDE_CHOICES): PickerSpecial[] => [
  choices.isClaude
    ? {
        value: "",
        label: "Claude default",
        description: claudeDefault ? `${modelLabel(claudeDefault)}, set under Integrations` : "The model set under Integrations, else the SDK default",
      }
    : { value: "", label: `${choices.name} default`, description: `${choices.defaultLabel}, the main model set under Integrations` },
];

/** An engine agent's model picker's first choice: empty runs the engine's own model (its Integrations pane). */
export const engineModelSpecials = (engineName: string, engineModel: string): PickerSpecial[] => [
  {
    value: "",
    label: `${engineName}'s model`,
    description: engineModel ? `${engineModel}, set under Integrations, ${engineName}` : `The CLI's default, until one is set under Integrations, ${engineName}`,
  },
];

/** When an agent's fallbacks (AgentSpec.fallback) take over from its engine. */
export const fallbackHint = (engine: AgentEngine): string =>
  engine === "claude"
    ? "Used when Claude is rate limited, out of credit, its key is rejected or it is down — not when the work itself fails."
    : "Used when the engine is rate limited, out of credit, its key is rejected or it is down — not when the work itself fails. Claude is always the last resort.";

// ---------- Effort ----------

const EFFORT_INFO: Record<Effort, { label: string; description?: string }> = {
  low: { label: "Low", description: "Cheapest and fastest" },
  medium: { label: "Medium", description: "Recommended" },
  high: { label: "High" },
  xhigh: { label: "Extra high" },
  max: { label: "Max", description: "Slowest and most expensive" },
};

export const effortLabel = (effort: Effort): string => EFFORT_INFO[effort].label;

export const EFFORT_SELECT_OPTIONS: SelectorOptionData[] = EFFORT_OPTIONS.map((value) => ({ value, ...EFFORT_INFO[value] }));

/** An agent's effort: empty follows the work it is part of. */
export const AGENT_EFFORT_SELECT_OPTIONS: SelectorOptionData[] = [
  { value: "", label: "Same as the chat or repo task", description: "Pointer's chat effort in Slack, the repo task effort in repo tasks" },
  ...EFFORT_SELECT_OPTIONS,
];

export const isEffort = (value: string): value is Effort => (EFFORT_OPTIONS as readonly string[]).includes(value);

// ---------- Routing by task size ----------

/** The sizes Pointer estimates before a repo task (TASK_SIZES in src/team/team.ts). */
export type TaskSize = keyof Omit<PointerSpec["routing"], "enabled">;
export const TASK_SIZE_OPTIONS = ["small", "medium", "large"] as const satisfies readonly TaskSize[];

/** What each size means, in the words the size estimate uses (src/tasks/sizing.ts). */
export const SIZE_INFO: Record<TaskSize, { label: string; description: string }> = {
  small: { label: "Small", description: "A contained change with a clear location: a typo, copy, a config value, a small fix in one or two files." },
  medium: { label: "Medium", description: "A feature or fix in one area: several files, new tests, or some investigation first." },
  large: { label: "Large", description: "Work across many files or modules: a new subsystem, a migration, a broad refactor, a bug with an unknown cause." },
};

// ---------- Access ----------

/** What each access level allows in repo tasks (README, "The team"); each level has the tools of the one before. */
export const ACCESS_INFO: Record<Access, { label: string; summary: string; tools: string; color: "gray" | "blue" | "orange" }> = {
  read: {
    label: "Looks only",
    summary: "Reads the code and searches the web. Cannot run commands or edit files.",
    tools: "Tools: Read, Glob, Grep, WebSearch, WebFetch.",
    color: "gray",
  },
  run: {
    label: "Runs commands",
    summary: "Also runs commands behind the shell guard and uses a headless browser, so it can build, test and check pages.",
    tools: "Adds Bash and the browser tools.",
    color: "blue",
  },
  write: {
    label: "Changes code",
    summary: "Also edits and writes files. Code changes go only to these agents.",
    tools: "Adds Edit and Write.",
    color: "orange",
  },
};

/** "Reads the code… Tools: Read, …": what a level allows, in one line. */
export const accessDescription = (access: Access): string => `${ACCESS_INFO[access].summary} ${ACCESS_INFO[access].tools}`;

export const isAccess = (value: string): value is Access => value in ACCESS_INFO;

// ---------- Agent ids and emoji ----------

/** Mirrors RESERVED_AGENT_IDS in src/team/team.ts. */
const RESERVED_AGENT_IDS = ["pointer", "general-purpose", "statusline-setup", "claude-code-guide", "explore", "plan", "output-style-setup", "fork", "claude"];

/**
 * The id for a new agent, made from its name: lowercase letters, digits and
 * dashes, 2-31 characters, starting with a letter (/^[a-z][a-z0-9-]{1,30}$/),
 * not reserved and not taken ("-2", "-3"… when it is). It never changes once saved.
 */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[0-9]/.test(base)) base = `agent-${base}`;
  base = base.slice(0, 31).replace(/-+$/, "");
  if (base.length < 2) base = base ? `${base}-agent` : "agent";
  const free = (id: string) => !taken.has(id) && !RESERVED_AGENT_IDS.includes(id);
  let id = base;
  for (let n = 2; !free(id); n++) {
    const suffix = `-${n}`;
    id = base.slice(0, 31 - suffix.length).replace(/-+$/, "") + suffix;
  }
  return id;
}

// ---------- The agent drawer's target ----------

/** What the agent drawer edits: a new agent, a built-in one to add (prefilled, with its own id), or an existing one by id. */
export type AgentTarget = { kind: "new" } | { kind: "builtin"; agent: AgentSpec } | { kind: "edit"; agent: AgentSpec };

/** The built-in agents (GET /api/team/builtins) that no agent on the team has the id of, in their own order. */
export const missingBuiltins = (builtins: readonly AgentSpec[], takenIds: ReadonlySet<string>): AgentSpec[] => builtins.filter((a) => !takenIds.has(a.id));

/**
 * The drawer's target for the Team page's route: #/team/new-agent, #/team/agent/<id>
 * and #/team/builtin/<id> (a built-in agent the team lacks). Undefined closes the
 * drawer: an unknown id, a built-in the team already has, or a new one on a full team.
 */
export function routeTarget(
  [mode, id]: readonly string[],
  { agents, builtins, isFull }: { agents: readonly AgentSpec[]; builtins: readonly AgentSpec[]; isFull: boolean },
): AgentTarget | undefined {
  if (mode === "new-agent") return isFull ? undefined : { kind: "new" };
  if (mode === "builtin") {
    const builtin = isFull || agents.some((a) => a.id === id) ? undefined : builtins.find((a) => a.id === id);
    return builtin ? { kind: "builtin", agent: builtin } : undefined;
  }
  const agent = mode === "agent" ? agents.find((a) => a.id === id) : undefined;
  return agent ? { kind: "edit", agent } : undefined;
}

/** The id the drawer saves its agent under: an existing or built-in agent keeps its own; a new one gets one made from its name. */
export const targetAgentId = (target: AgentTarget, name: string, taken: ReadonlySet<string>): string =>
  target.kind === "new" ? slugId(name, taken) : target.agent.id;

/** "robot_face", ":robot_face" and ":robot_face:" all become ":robot_face:". */
export function normEmoji(value: string): string {
  const code = value.trim().toLowerCase().replace(/^:+|:+$/g, "");
  return code ? `:${code}:` : "";
}

// ---------- Validation ----------

export type AgentDraft = Omit<AgentSpec, "id">;
export type AgentErrors = Partial<Record<keyof AgentDraft, string>>;

export const NEW_AGENT: AgentDraft = {
  name: "",
  role: "",
  emoji: ":robot_face:",
  description: "",
  instructions: "",
  access: "read",
  model: "",
  effort: "",
  enabled: true,
  skills: [],
  avatar: "",
  apps: [],
  engine: "claude",
  engineModel: "",
  fallback: [],
};

/** The checks AgentSpecSchema runs, with the page's wording. Empty when the draft can be saved. */
export function agentErrors(d: AgentDraft): AgentErrors {
  const errors: AgentErrors = {};
  const name = d.name.trim();
  const role = d.role.trim();
  const description = d.description.trim();
  const instructions = d.instructions.trim();
  if (!name) errors.name = "Give the agent a name.";
  else if (name.length > 40) errors.name = "At most 40 characters.";
  if (!role) errors.role = "Give the agent a role.";
  else if (role.length > 40) errors.role = "At most 40 characters.";
  if (!/^(:[a-z0-9_+-]+:)?$/.test(normEmoji(d.emoji))) errors.emoji = "Use a Slack emoji code like :hammer_and_wrench:.";
  if (description.length < 10) errors.description = "Describe when Pointer should use this agent, in at least 10 characters.";
  else if (description.length > 500) errors.description = "At most 500 characters.";
  if (instructions.length < 20) errors.instructions = "Write the agent's instructions, at least 20 characters.";
  else if (instructions.length > 8000) errors.instructions = "At most 8,000 characters.";
  return errors;
}

/**
 * The fallback to save, as the server keeps it (TeamSaveSchema): none for an
 * agent on Claude (Claude is the last resort; the repo tasks route orders its
 * providers), never the agent's own engine, nothing after Claude, and Claude
 * on the team's model.
 */
export function toFallback(d: Pick<AgentDraft, "engine" | "fallback">): AgentSpec["fallback"] {
  if (d.engine === "claude") return [];
  const kept: AgentSpec["fallback"] = [];
  for (const f of d.fallback ?? []) {
    if (f.engine === d.engine || kept.some((k) => k.engine === f.engine)) continue;
    kept.push({ engine: f.engine, model: f.engine === "claude" ? "" : f.model.trim() });
    if (f.engine === "claude") break;
  }
  return kept;
}

/** The spec to save: trimmed, with the emoji normalised. */
export const toSpec = (id: string, d: AgentDraft): AgentSpec => ({
  id,
  name: d.name.trim(),
  role: d.role.trim(),
  emoji: normEmoji(d.emoji),
  description: d.description.trim(),
  instructions: d.instructions.trim(),
  access: d.access,
  model: d.model,
  effort: d.effort,
  enabled: d.enabled,
  skills: d.skills,
  avatar: d.avatar.trim(),
  apps: d.apps,
  engine: d.engine,
  // The CLI's model means nothing for an agent on Claude.
  engineModel: d.engine === "claude" ? "" : d.engineModel.trim(),
  fallback: toFallback(d),
});

export type PointerErrors = Partial<Record<keyof PointerSpec, string>>;

/** The checks PointerSpecSchema runs. */
export function pointerErrors(p: PointerSpec): PointerErrors {
  const errors: PointerErrors = {};
  const name = p.name.trim();
  if (!name) errors.name = "Give Pointer a name.";
  else if (name.length > 40) errors.name = "At most 40 characters.";
  if (p.instructions.length > 8000) errors.instructions = "At most 8,000 characters.";
  if (!Number.isFinite(p.budgetUsd) || p.budgetUsd < 0.1 || p.budgetUsd > 20) errors.budgetUsd = "Between $0.10 and $20.";
  if (!Number.isInteger(p.maxTurns) || p.maxTurns < 5 || p.maxTurns > 200) errors.maxTurns = "A whole number from 5 to 200.";
  return errors;
}

export const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0;

/** `{ type: "error", message }` for a field's status prop, only once the form has tried to save. */
export const fieldStatus = (message: string | undefined, show: boolean) => (show && message ? { type: "error" as const, message } : undefined);
