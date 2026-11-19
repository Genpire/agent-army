/**
 * The Team page's vocabulary and rules: option lists, labels, the agent id
 * rule and the checks the page runs before saving. They mirror src/team.ts
 * (AgentSpecSchema, PointerSpecSchema, RESERVED_AGENT_IDS); the server
 * validates again and its message is shown when it disagrees.
 */
import type { SelectorOptionData } from "@astryxdesign/core/Selector";
import { type Access, type AgentSpec, type Effort, EFFORT_OPTIONS, type PointerSpec } from "../../lib/types";

export const MAX_AGENTS = 30;

// ---------- Models ----------

const MODELS = [
  { value: "claude-opus-5-5", label: "Opus 5.5", description: "claude-opus-5-5 · strongest" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "claude-sonnet-5-5 · half the price of Opus" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", description: "claude-haiku-5-5 · far cheaper, for simple lookups" },
];

/** "claude-sonnet-5-5" → "Sonnet 5.5"; other ids as they are. */
export const modelLabel = (id: string): string => MODELS.find((m) => m.value === id)?.label ?? id;

/** The list, plus the saved value when it is a model the list does not name (set through the API). */
function withCurrent(options: SelectorOptionData[], current: string): SelectorOptionData[] {
  const known = options.some((o) => o.value === current);
  return known || !current ? options : [...options, { value: current, label: current, description: "Set outside this page" }];
}

/** An agent's model: empty runs it on Pointer's model. */
export const agentModelOptions = (current: string, lead: string): SelectorOptionData[] =>
  withCurrent([{ value: "", label: `Same as ${lead}`, description: `The model ${lead} runs on` }, ...MODELS], current);

/** Pointer's chat model: empty falls back to the model on the Claude connection, not to Pointer. */
export const chatModelOptions = (current: string, claudeDefault: string): SelectorOptionData[] =>
  withCurrent(
    [
      {
        value: "",
        label: "Claude default",
        description: claudeDefault ? `${modelLabel(claudeDefault)}, set under Integrations` : "The model set under Integrations, else the SDK default",
      },
      ...MODELS,
    ],
    current,
  );

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

/** Mirrors RESERVED_AGENT_IDS in src/team.ts. */
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
