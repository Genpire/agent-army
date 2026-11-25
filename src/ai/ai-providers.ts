/**
 * Which AI provider a query runs on, and what the Claude Code process needs
 * for it: its environment (the provider's credentials and model mapping, never
 * another provider's key), the tools it cannot serve (WebSearch where the
 * provider has no search), managed settings (model prices, so budgets and
 * costs are right), and how agents' models and efforts map onto it.
 *
 * Every Agent SDK query the platform makes takes its provider from here:
 * Pointer's chat (scope "chat"), repo tasks and the worker's task sizing
 * (scope "task"), and the console's one-shot calls (HR review, Skills Scout:
 * scope "chat"). The presets themselves are data, in ai-presets.ts.
 *
 * The environment replaces the process's own (options.env replaces the whole
 * environment), so a query sees only its provider's credentials. In repo
 * tasks the same environment is the agents' shell environment: the task
 * provider's credentials reach the agents' shell, as Anthropic's key always
 * has (guard.ts only stops the obvious ways of printing them).
 *
 * Gemini (google-ai) is the exception: Claude Code cannot call it, so its
 * session() starts the platform's bridge (gemini-bridge/) and the
 * environment points Claude Code at it with a token that dies with the
 * session. The Gemini key itself stays in this process.
 */
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, type Settings, query } from "@anthropic-ai/claude-agent-sdk";
import { type FetchLike, appUrlProblem, guardedFetch } from "../integrations/apps/apps-net.js";
import { AI_PRESETS, type AiPreset, type ModelPrice, type PresetCapabilities, QWEN_SHARED_HOSTS, compatibleBaseUrl, presetFor } from "./ai-presets.js";
import { sharedGeminiBridge } from "./gemini-bridge/server.js";
import { MODEL_ID_RE } from "./model-ids.js";
import type { AiProviderConnection, AiProviderId, Config, ModelTier } from "../core/config.js";
import type { QueryFn } from "../chat/pointer.js";
import { EFFORT_LEVELS, type Effort } from "../team/team.js";

export { AI_PRESETS, presetFor };
export type { AiPreset };

export type ProviderScope = "chat" | "task";

export type ProviderCapabilities = PresetCapabilities;

/** The provider's environment with its credential files written (see ProviderRuntime.session). */
export interface ProviderSession {
  env: Record<string, string>;
  /** Removes the credential files. Never throws. */
  dispose(): Promise<void>;
}

export interface ProviderRuntime {
  provider: AiProviderId;
  /** For messages: "Claude", "Kimi"… */
  label: string;
  /**
   * Environment entries for the Claude Code process, merged over the
   * caller's minimal environment (PATH, HOME, LANG…). Holds this provider's
   * credentials and model mapping; for a third-party provider it sets
   * ANTHROPIC_API_KEY to "" so the platform's Anthropic key never reaches it.
   * Credentials that live in a file (a Google service account key) are not
   * here: use session(), which writes them and adds their variable. Nor is
   * Gemini's way in: only session() starts the bridge and gives its address
   * and token (without it, Claude Code is pointed at an address that does not
   * resolve, so the query fails rather than going anywhere).
   */
  env: Record<string, string>;
  /** Tools the provider cannot serve, for Options.disallowedTools (e.g. WebSearch). */
  disallowedTools: string[];
  /** For Options.managedSettings: model prices (modelPricing), so costs and budgets are right. */
  managedSettings?: Settings;
  /**
   * The model to pass for a configured model (undefined in the options = the
   * provider's main tier): "" for its default; a Claude model id or alias on
   * the tier it stands for; a model of another provider's family
   * (foreignModel) on the main tier instead (on Anthropic, the Claude card's
   * model), so a setting made for one provider does not break the work when
   * a route hands it to another.
   */
  model(model: string): string | undefined;
  /**
   * Why this provider does not run a configured model: an id of another
   * provider's family ("gemini-4-carbon" on Claude), which neither its model
   * list nor its connection's tiers have. Undefined when it runs it, maps it
   * (a Claude id) or cannot tell (an id of no known family: an alias, a
   * deployment's own name).
   */
  foreignModel(model: string): string | undefined;
  /** The effort to pass, as the provider accepts it (undefined = leave it out). */
  effort(effort: Effort): Effort | undefined;
  capabilities: ProviderCapabilities;
  /**
   * `env` plus the credential files written: each in a new private folder in
   * the system temp folder (0700, the file 0600), outside any checkout, with
   * its variable (GOOGLE_APPLICATION_CREDENTIALS) pointing at it. Call
   * dispose() after the query. For a provider without files, `env` as is.
   *
   * Private means other OS users cannot read the file. Every process of the
   * service's own user can: Claude Code, and in repo tasks the agents' shell
   * and the repository's code it runs (as the key in `env` always could).
   * Folders left by a process that died before dispose() are removed at the
   * next start (removeStaleCredentialFolders).
   *
   * For Gemini: the bridge started (once per process), with a new session
   * token for this connection; dispose() ends the token.
   */
  session(): Promise<ProviderSession>;
  /** The model a configured model runs on, for people: "Sonnet 5.5", "Kimi K3". */
  displayModel(model: string): string;
}

export type ProviderResult = { ok: true; runtime: ProviderRuntime } | { ok: false; error: string };

/** A connection as the presets see it; Anthropic's lives in config.anthropic. */
export type ConnectionValues = Pick<AiProviderConnection, "secrets" | "settings" | "models"> & { checkedAt?: string };

const TIER_ENV: Record<ModelTier, string[]> = {
  main: ["ANTHROPIC_MODEL"],
  // Claude Code's fable alias goes to the biggest tier too, so no alias is left unmapped.
  opus: ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"],
  sonnet: ["ANTHROPIC_DEFAULT_SONNET_MODEL"],
  haiku: ["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  subagent: ["CLAUDE_CODE_SUBAGENT_MODEL"],
};

/** A Claude model id or alias ("claude-sonnet-5-5", "sonnet", "opus[1m]"), and the alias it stands for. */
const CLAUDE_MODEL_RE = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:$|-|\[)/;
const ALIAS_TIER: Record<string, ModelTier> = { opus: "opus", sonnet: "sonnet", haiku: "haiku", fable: "opus" };
const claudeAlias = (model: string): string | undefined => model.toLowerCase().match(CLAUDE_MODEL_RE)?.[1];

// ---------- Whose model an id is ----------

/** The families of models the presets run, told apart by how their ids start. */
export type ModelFamily = "claude" | "gemini" | "kimi" | "deepseek" | "qwen" | "glm" | "gpt";

const FAMILY_NAMES: Record<ModelFamily, string> = { claude: "Claude", gemini: "Gemini", kimi: "Kimi", deepseek: "DeepSeek", qwen: "Qwen", glm: "GLM", gpt: "GPT" };

/** The other families, by the model's name (after any "vendor/" prefix). */
const FAMILY_RES: [RegExp, ModelFamily][] = [
  [/^(?:gemini|gemma|learnlm)(?:-|$)/, "gemini"],
  [/^(?:kimi|moonshot)(?:-|$)/, "kimi"],
  [/^deepseek(?:-|$)/, "deepseek"],
  [/^(?:qwen|qwq|qvq)/, "qwen"],
  [/^(?:glm|chatglm)(?:-|$)/, "glm"],
  [/^(?:gpt|chatgpt|codex)(?:-|$)|^o\d+(?:-|$)/, "gpt"],
];

/**
 * The family of a model id: Claude for a Claude id or alias in any provider's
 * spelling ("claude-opus-5-5", "sonnet", "us.anthropic.claude-…",
 * "claude-haiku-4-5@20251001"), else by its name. Undefined for an id that
 * says none: an alias Claude Code knows ("opusplan"), a deployment's own name,
 * an inference profile's ARN.
 */
export function modelFamily(id: string): ModelFamily | undefined {
  const lower = id.trim().toLowerCase();
  if (claudeAlias(lower) || /(?:^|[./~])claude(?:-|$)/.test(lower)) return "claude";
  const name = lower.replace(/\[1m\]$/, "").split("/").pop() ?? "";
  return FAMILY_RES.find(([re]) => re.test(name))?.[1];
}

/**
 * The family a provider runs: Claude on Anthropic and the clouds, its default
 * model's on another provider's own API (Kimi's, Gemini's…), none on a custom
 * endpoint (a gateway may serve any).
 */
export function presetFamily(preset: Pick<AiPreset, "kind" | "defaults">): ModelFamily | undefined {
  if (preset.kind === "anthropic" || preset.kind === "cloud") return "claude";
  if (preset.kind === "custom") return undefined;
  return modelFamily(preset.defaults.main);
}

/** For comparing ids: as typed, without Claude Code's "[1m]" marker. */
const sameId = (id: string): string => id.trim().toLowerCase().replace(/\[1m\]$/, "");

/** Settings already logged as ignored on a provider ("provider, setting, model"): each is said once per process. */
const ignoredSaid = new Set<string>();

/**
 * The model to pass for a configured model (runtime.model), saying once per
 * process when the provider does not run it (foreignModel): `setting` names
 * where it was set ("Pointer's chat model (Team page)"), so the owner can
 * tell why the provider ran its main model instead.
 */
export function configuredModel(
  runtime: Pick<ProviderRuntime, "provider" | "label" | "model" | "foreignModel">,
  model: string,
  setting: string,
  log: (line: string) => void = (line) => console.warn(line),
): string | undefined {
  const why = model ? runtime.foreignModel(model) : undefined;
  if (why) {
    const key = `${runtime.provider}\n${setting}\n${model}`;
    if (!ignoredSaid.has(key)) {
      if (ignoredSaid.size >= 500) ignoredSaid.clear();
      ignoredSaid.add(key);
      log(`[models] ${setting} is ignored on ${runtime.label}: ${why}. ${runtime.label} runs its main model instead.`);
    }
  }
  return runtime.model(model);
}

const nonEmpty =(record: Partial<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

/** The saved connection of a provider (Anthropic's from config.anthropic), or undefined when there is none. */
export function connectionOf(config: Config, id: AiProviderId): ConnectionValues | undefined {
  if (id === "anthropic") {
    if (!config.anthropic.apiKey) return undefined;
    return { secrets: { apiKey: config.anthropic.apiKey }, settings: {}, models: config.anthropic.model ? { main: config.anthropic.model } : {} };
  }
  return config.ai.providers[id];
}

/** The settings with each field's default where none is saved. */
export function effectiveSettings(preset: AiPreset, settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of preset.fields) {
    if (f.secret) continue;
    const value = settings[f.key]?.trim() || f.default || "";
    if (value) out[f.key] = value;
  }
  return out;
}

/** The model each tier runs on: the saved choice, else the preset's default ("" = Claude Code's own). */
export function tierModels(preset: AiPreset, models: ConnectionValues["models"]): Record<ModelTier, string> {
  return { ...preset.defaults, ...nonEmpty(models) } as Record<ModelTier, string>;
}

// ---------- Validation ----------

const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const VERTEX_REGION_RE = /^(?:global|us|eu|[a-z]+-[a-z]+\d{1,2})$/;
const LOCATION_RE = /^[a-z][a-z0-9-]{1,39}$/;
const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CLAUDE_WORKSPACE_RE = /^wrkspc_[A-Za-z0-9]{1,100}$/;
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const FOUNDRY_RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/;
/** Keys and tokens: printable, no spaces. */
const TOKEN_RE = /^[\x21-\x7e]{8,4000}$/;
/** Model ids as providers spell them (model-ids.ts, which the console's model picker shares). */
export { MODEL_ID_RE };
const PRICE_RE = /^\d{1,5}(?:\.\d{1,6})?$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "connection",
  "transfer-encoding",
]);
const MAX_HEADERS = 10;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CREDENTIAL_TYPES = new Set(["service_account", "external_account", "authorized_user", "impersonated_service_account"]);
/** A Google AI Studio key: AQ.… now, AIza… before; any such run of characters, as the format has changed before. */
const GOOGLE_AI_KEY_RE = /^[A-Za-z0-9._-]{20,400}$/;

/** "Name: Value" lines as header pairs, or why they are not headers. */
export function parseHeaderLines(text: string): { headers: [string, string][] } | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > MAX_HEADERS) return { error: `At most ${MAX_HEADERS} extra headers.` };
  const headers: [string, string][] = [];
  for (const line of lines) {
    const at = line.indexOf(":");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    const value = at > 0 ? line.slice(at + 1).trim() : "";
    if (!HEADER_NAME_RE.test(name) || !value || !/^[\x20-\x7e]{1,4000}$/.test(value)) {
      return { error: "Write each extra header on its own line, as Name: Value." };
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) return { error: `The ${name} header is set by the platform; use another name.` };
    headers.push([name, value]);
  }
  return { headers };
}

/** Why a custom endpoint's address cannot be used: https only; http://localhost only when ALLOW_PRIVATE_APP_URLS=1. */
export function baseUrlProblem(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The base URL is not a valid address.";
  }
  if (u.search || u.hash) return "Leave any ?query or #fragment out of the base URL.";
  if (/\/v1\/?$/.test(u.pathname)) return "Leave /v1 off the base URL: Claude Code adds it.";
  if (u.protocol === "http:") {
    if (env.ALLOW_PRIVATE_APP_URLS === "1" && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password) return undefined;
    return "Use an https:// address (http:// only for localhost, with ALLOW_PRIVATE_APP_URLS=1).";
  }
  const problem = appUrlProblem(url, env);
  return problem?.replace("Apps must", "Endpoints must");
}

/**
 * Why a connection cannot be used, or undefined when it can: every required
 * field set, each value well formed, and the preset's own rules (Bedrock's
 * key or access key, Qwen's workspace for regions without a shared address).
 */
export function connectionProblem(id: AiProviderId, conn: ConnectionValues, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const preset = presetFor(id);
  const settings = effectiveSettings(preset, conn.settings);
  const secrets = nonEmpty(conn.secrets);
  for (const f of preset.fields) {
    const value = f.secret ? secrets[f.key] : settings[f.key];
    if (f.required && !value) return `${f.label} is required for ${preset.name}.`;
    if (!value) continue;
    if (f.type === "select" && !f.options?.some((o) => o.value === value)) return `${f.label}: choose one of the options.`;
  }
  for (const [tier, model] of Object.entries(nonEmpty(conn.models))) {
    if (!MODEL_ID_RE.test(model)) return `The ${tier} model "${model.slice(0, 60)}" is not a model id: no spaces.`;
  }
  const s = settings;
  switch (id) {
    case "anthropic":
    case "deepseek":
    case "kimi":
    case "zai":
    case "foundry":
      if (!TOKEN_RE.test(secrets.apiKey ?? "")) return `That doesn't look like a ${preset.short} API key.`;
      if (id === "foundry" && !FOUNDRY_RESOURCE_RE.test(s.resource ?? "")) {
        return "The resource name is letters, digits and dashes, without https:// or .services.ai.azure.com.";
      }
      return undefined;
    case "qwen": {
      if (!TOKEN_RE.test(secrets.apiKey ?? "")) return "That doesn't look like a Model Studio API key.";
      if (secrets.apiKey!.startsWith("sk-sp-")) {
        return "That is a Coding Plan key: Alibaba does not allow those for applications. Use a pay-as-you-go key (sk-…).";
      }
      if (s.workspaceId && !DNS_LABEL_RE.test(s.workspaceId)) return "The workspace ID is letters, digits and dashes.";
      if (!s.workspaceId && !QWEN_SHARED_HOSTS[s.region ?? ""]) return "That region needs your workspace ID.";
      return undefined;
    }
    case "bedrock":
      if (!AWS_REGION_RE.test(s.region ?? "")) return "The AWS region looks like us-east-1.";
      if (secrets.apiKey) return TOKEN_RE.test(secrets.apiKey) ? undefined : "That doesn't look like a Bedrock API key.";
      if (!secrets.accessKeyId || !secrets.secretAccessKey) return "Give a Bedrock API key, or an access key ID and its secret.";
      if (!/^[A-Z0-9]{16,128}$/.test(secrets.accessKeyId)) return "That doesn't look like an AWS access key ID.";
      if (!TOKEN_RE.test(secrets.secretAccessKey) || (secrets.sessionToken && !TOKEN_RE.test(secrets.sessionToken))) {
        return "That doesn't look like an AWS secret key.";
      }
      return undefined;
    case "vertex":
    case "google-cloud": {
      if (!GCP_PROJECT_RE.test(s.projectId ?? "")) return "The project ID is 6 to 30 lowercase letters, digits and dashes.";
      if (id === "vertex" && !VERTEX_REGION_RE.test(s.region ?? "")) return "The region is global, us, eu, or a region such as us-east5.";
      if (id === "google-cloud" && !CLAUDE_WORKSPACE_RE.test(s.workspaceId ?? "")) return "The workspace ID looks like wrkspc_….";
      if (id === "google-cloud" && !LOCATION_RE.test(s.location ?? "")) return "The location looks like global or us-east5.";
      if (secrets.credentialsJson) return credentialsProblem(secrets.credentialsJson);
      return undefined;
    }
    case "google-ai": {
      const key = secrets.apiKey ?? "";
      if (/^ya29\./.test(key)) return "That is a Google sign-in token, not an API key: create a key in Google AI Studio.";
      if (!GOOGLE_AI_KEY_RE.test(key)) return "That doesn't look like a Gemini API key from Google AI Studio (AQ.… or AIza…).";
      return undefined;
    }
    case "custom": {
      const urlProblem = baseUrlProblem(s.baseUrl ?? "", env);
      if (urlProblem) return urlProblem;
      if (!TOKEN_RE.test(secrets.authToken ?? "")) return "That doesn't look like a token: no spaces, at least 8 characters.";
      if (secrets.headers) {
        const parsed = parseHeaderLines(secrets.headers);
        if ("error" in parsed) return parsed.error;
      }
      for (const key of ["inputPrice", "outputPrice"] as const) {
        if (s[key] && (!PRICE_RE.test(s[key]) || Number(s[key]) > 10_000)) return "Prices are USD per million tokens, from 0 to 10000.";
      }
      if (Boolean(s.inputPrice) !== Boolean(s.outputPrice)) return "Give both prices, or neither.";
      return undefined;
    }
  }
}

function credentialsProblem(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    const type = typeof parsed === "object" && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
    if (typeof type === "string" && CREDENTIAL_TYPES.has(type)) return undefined;
    return "That JSON is not a Google credentials file (its type should be service_account).";
  } catch {
    return "The service account key is not valid JSON. Paste the whole downloaded file.";
  }
}

/** Why the provider cannot be used yet (not connected, or its connection incomplete), or undefined. */
export function providerProblem(config: Config, id: AiProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const conn = connectionOf(config, id);
  if (!conn) {
    return id === "anthropic"
      ? "Claude is not connected. Ask the owner to add the Anthropic API key on the admin page."
      : `${presetFor(id).name} is not set up. Ask the owner to connect it on the admin page (Integrations, AI model).`;
  }
  // Anthropic: a saved key is enough, as before providers existed (its format is checked when it is saved).
  if (id === "anthropic") return undefined;
  const problem = connectionProblem(id, conn, env);
  return problem && `${presetFor(id).name} cannot be used: ${problem}`;
}

/** The provider chat or repo tasks run on. */
export const scopeProvider = (config: Pick<Config, "ai">, scope: ProviderScope): AiProviderId =>
  scope === "chat" ? config.ai.chatProvider : config.ai.taskProvider;

/** The provider for that scope is connected and complete. */
export const isProviderReady = (config: Config, scope: ProviderScope): boolean => !providerProblem(config, scopeProvider(config, scope));

// ---------- The runtime ----------

/** The provider for chat or repo tasks, with what its queries need; or why it cannot be used (not connected). */
export function providerRuntime(config: Config, scope: ProviderScope): ProviderResult {
  const id = scopeProvider(config, scope);
  const problem = providerProblem(config, id);
  if (problem) return { ok: false, error: problem };
  return { ok: true, runtime: buildRuntime(id, connectionOf(config, id)!) };
}

/**
 * The credential values of a session's environment (a key, or the Gemini
 * bridge's session token), for the redactors: a session token is not in the
 * config, so configSecrets alone would not hide it.
 */
export const sessionSecrets = (env: Record<string, string>): string[] =>
  ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"].map((name) => env[name] ?? "").filter((v) => v.length >= 6);

/** Anthropic's API with this key, as before providers existed. */
export function anthropicRuntime(apiKey: string): ProviderRuntime {
  return buildRuntime("anthropic", { secrets: { apiKey }, settings: {}, models: {} });
}

/** The model on the Claude card (config.anthropic.model) applies on Anthropic only; another provider runs its main tier. */
export const defaultModel = (config: Pick<Config, "anthropic">, runtime: Pick<ProviderRuntime, "provider">): string =>
  runtime.provider === "anthropic" ? config.anthropic.model : "";

/** Pointer's chat model on a runtime, and where it was set (for configuredModel): the Team page's, else the Claude card's. */
export function chatModelOf(config: Pick<Config, "anthropic" | "team">, runtime: Pick<ProviderRuntime, "provider">): { model: string; setting: string } {
  if (config.team.pointer.model) return { model: config.team.pointer.model, setting: "Pointer's chat model (Team page)" };
  return { model: defaultModel(config, runtime), setting: "The Claude card's model" };
}

/** The accepted level nearest to `effort`; between two, the one nearer "high" (as the providers themselves round). */
export function nearestEffort(effort: Effort, accepted: readonly Effort[]): Effort | undefined {
  if (!accepted.length) return undefined;
  if (accepted.includes(effort)) return effort;
  const rank = (e: Effort) => EFFORT_LEVELS.indexOf(e);
  const high = rank("high");
  return [...accepted].sort((a, b) => {
    const da = Math.abs(rank(a) - rank(effort));
    const db = Math.abs(rank(b) - rank(effort));
    return da - db || Math.abs(rank(a) - high) - Math.abs(rank(b) - high);
  })[0];
}

const strip1m = (id: string) => id.replace(/\[1m\]$/i, "");

/** modelPricing rows: each priced model under its id and its "[1m]" form (which form Claude Code matches is undocumented). */
function pricingOverrides(prices: Record<string, ModelPrice>): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(prices)) {
    out[strip1m(id)] = price;
    out[`${strip1m(id)}[1m]`] = price;
  }
  return out;
}

/** The environment for the provider's credentials and endpoint (files apart). */
function credentialEnv(preset: AiPreset, secrets: Record<string, string>, settings: Record<string, string>): Record<string, string> {
  switch (preset.id) {
    case "anthropic":
      return { ANTHROPIC_API_KEY: secrets.apiKey ?? "" };
    case "bedrock":
      return {
        AWS_REGION: settings.region ?? "",
        ...(secrets.apiKey
          ? { AWS_BEARER_TOKEN_BEDROCK: secrets.apiKey }
          : {
              AWS_ACCESS_KEY_ID: secrets.accessKeyId ?? "",
              AWS_SECRET_ACCESS_KEY: secrets.secretAccessKey ?? "",
              ...(secrets.sessionToken ? { AWS_SESSION_TOKEN: secrets.sessionToken } : {}),
            }),
      };
    case "vertex":
      return { CLOUD_ML_REGION: settings.region ?? "", ANTHROPIC_VERTEX_PROJECT_ID: settings.projectId ?? "" };
    case "google-cloud":
      return {
        ANTHROPIC_GOOGLE_CLOUD_PROJECT: settings.projectId ?? "",
        ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID: settings.workspaceId ?? "",
        ANTHROPIC_GOOGLE_CLOUD_LOCATION: settings.location ?? "global",
      };
    case "foundry":
      return { ANTHROPIC_FOUNDRY_RESOURCE: settings.resource ?? "", ANTHROPIC_FOUNDRY_API_KEY: secrets.apiKey ?? "" };
    case "google-ai":
      // No key here: session() gives the bridge's address and a token.
      return { ANTHROPIC_BASE_URL: GEMINI_BRIDGE_NOT_STARTED };
    case "custom": {
      const headers = secrets.headers ? parseHeaderLines(secrets.headers) : undefined;
      return {
        ANTHROPIC_BASE_URL: compatibleBaseUrl("custom", settings) ?? "",
        // x-api-key gateways read ANTHROPIC_API_KEY; the others a Bearer token, with the key explicitly empty.
        ...(settings.authHeader === "x-api-key" ? { ANTHROPIC_API_KEY: secrets.authToken ?? "" } : { ANTHROPIC_AUTH_TOKEN: secrets.authToken ?? "" }),
        ...(headers && "headers" in headers && headers.headers.length
          ? { ANTHROPIC_CUSTOM_HEADERS: headers.headers.map(([n, v]) => `${n}: ${v}`).join("\n") }
          : {}),
        ...(settings.compat === "on" ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1" } : {}),
      };
    }
    default:
      // DeepSeek, Qwen, Kimi, GLM: an Anthropic-compatible endpoint with a Bearer token.
      return { ANTHROPIC_BASE_URL: compatibleBaseUrl(preset.id, settings) ?? "", ANTHROPIC_AUTH_TOKEN: secrets.apiKey ?? "" };
  }
}

/**
 * Where the environment without a session points Claude Code for Gemini: a
 * name that never resolves (.invalid, RFC 2606), so a query that skipped
 * session() fails at once, saying what it needed.
 */
export const GEMINI_BRIDGE_NOT_STARTED = "http://gemini-bridge-needs-a-session.invalid";

/** The runtime of a provider from its connection (saved, or about to be). The caller has checked connectionProblem. */
export function buildRuntime(id: AiProviderId, conn: ConnectionValues): ProviderRuntime {
  const preset = presetFor(id);
  const secrets = nonEmpty(conn.secrets);
  const settings = effectiveSettings(preset, conn.settings);
  const capabilities: ProviderCapabilities = id === "custom" ? { ...preset.capabilities, webSearch: settings.webSearch === "on" } : preset.capabilities;
  const disallowedTools = capabilities.webSearch ? [] : ["WebSearch"];
  const labelOf = (model: string) => preset.models.find((m) => m.id === model)?.label ?? model;
  const files: Record<string, string> = secrets.credentialsJson ? { GOOGLE_APPLICATION_CREDENTIALS: secrets.credentialsJson } : {};

  // A model of another provider's family is not this one's, unless its list or its connection's tiers have it
  // (a setting made for one provider of a route reaching another after a fallback, or Pointer's model set to Gemini).
  const family = presetFamily(preset);
  const ownIds = new Set([...preset.models.map((m) => m.id), ...Object.values(nonEmpty(conn.models))].map(sameId));
  const foreignModel = (model: string): string | undefined => {
    const of = model ? modelFamily(model) : undefined;
    if (!of || of === "claude" || !family || of === family || ownIds.has(sameId(model))) return undefined;
    return `"${model}" is a ${FAMILY_NAMES[of]} model, and ${preset.short} runs ${FAMILY_NAMES[family]} models`;
  };

  if (id === "anthropic") {
    // As before providers existed: the key, and the models and efforts as configured. Also here: a
    // repository's .claude/settings*.json (repo tasks load project settings) cannot redirect the
    // endpoint or the key, which would otherwise send the Anthropic key to another host.
    const env = { ...credentialEnv(preset, secrets, settings), CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };
    // Its main tier: the Claude card's model (connectionOf), else Claude Code's default.
    const card = nonEmpty(conn.models).main;
    const main = card && !foreignModel(card) ? card : undefined;
    return {
      provider: id,
      label: preset.short,
      env,
      disallowedTools,
      model: (model) => (!model ? undefined : foreignModel(model) ? main : model),
      foreignModel,
      effort: (effort) => effort,
      capabilities,
      session: async () => ({ env: { ...env }, dispose: async () => undefined }),
      displayModel: (model) => {
        const runs = model && !foreignModel(model) ? model : main;
        return runs ? labelOf(runs) : "the default model";
      },
    };
  }

  const models = tierModels(preset, conn.models);
  const tierEnv: Record<string, string> = {};
  for (const tier of Object.keys(TIER_ENV) as ModelTier[]) {
    if (models[tier]) for (const name of TIER_ENV[tier]) tierEnv[name] = models[tier];
  }
  const env: Record<string, string> = {
    // Never the platform's own Anthropic key: options.env replaces the environment, and this says so explicitly.
    ANTHROPIC_API_KEY: "",
    // A repository's .claude/settings*.json cannot redirect the endpoint or keys, and the prices below apply.
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...preset.env,
    ...tierEnv,
    ...credentialEnv(preset, secrets, settings),
  };

  const prices: Record<string, ModelPrice> = { ...preset.pricing };
  if (id === "custom" && settings.inputPrice && settings.outputPrice) {
    const input = Number(settings.inputPrice);
    const output = Number(settings.outputPrice);
    // Claude's usual cache ratios: reads at a tenth of input, writes at 1.25 times.
    const price = { input, output, cacheRead: Math.round(input * 0.1 * 1e6) / 1e6, cacheWrite: Math.round(input * 1.25 * 1e6) / 1e6 };
    for (const model of new Set(Object.values(models).filter(Boolean))) prices[model] = price;
  }
  const overrides = pricingOverrides(prices);

  /** A Claude model id or alias stands for a tier (when that tier is mapped); other ids are the provider's own. */
  const tierOf = (model: string): ModelTier | undefined => {
    const alias = claudeAlias(model);
    const tier = alias ? ALIAS_TIER[alias] : undefined;
    return tier && models[tier] ? tier : undefined;
  };

  return {
    provider: id,
    label: preset.short,
    env,
    disallowedTools,
    ...(Object.keys(overrides).length ? { managedSettings: { modelPricing: { overrides } } } : {}),
    // The alias, which Claude Code resolves through the tier's variable (fable through the opus tier's);
    // another provider's model, nothing: the main tier (ANTHROPIC_MODEL).
    model: (model) => (!model || foreignModel(model) ? undefined : tierOf(model) ? claudeAlias(model) : model),
    foreignModel,
    effort: (effort) => nearestEffort(effort, capabilities.effort),
    capabilities,
    session: async () => {
      if (id === "google-ai") {
        const bridge = await sharedGeminiBridge().open(secrets.apiKey ?? "", models);
        return {
          env: { ...env, ANTHROPIC_BASE_URL: bridge.baseUrl, ANTHROPIC_AUTH_TOKEN: bridge.token },
          dispose: async () => bridge.close(),
        };
      }
      if (!Object.keys(files).length) return { env: { ...env }, dispose: async () => undefined };
      // A private folder of its own in the system temp folder: never inside a checkout or the data folder.
      // Private against other OS users only (see ProviderRuntime.session). Named after this process, so a
      // later start knows whether its owner is still running (removeStaleCredentialFolders).
      const dir = await mkdtemp(join(tmpdir(), `${CREDENTIALS_DIR_PREFIX}${process.pid}-`));
      const written: Record<string, string> = {};
      try {
        for (const [name, content] of Object.entries(files)) {
          const file = join(dir, `${name.toLowerCase()}.json`);
          await writeFile(file, content, { mode: 0o600, flag: "wx" });
          written[name] = file;
        }
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      return { env: { ...env, ...written }, dispose: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
    },
    displayModel: (model) => {
      const tier = !model || foreignModel(model) ? "main" : tierOf(model);
      const runs = tier ? models[tier] : model;
      return runs ? labelOf(runs) : "the default model";
    },
  };
}

// ---------- Credential files left behind ----------

/** session() folders: "ai-credentials-<pid>-XXXXXX" (before the pid was added: "ai-credentials-XXXXXX"). */
const CREDENTIALS_DIR_PREFIX = "ai-credentials-";
const CREDENTIALS_DIR_RE = /^ai-credentials-(?:(\d{1,10})-)?[A-Za-z0-9]{6}$/;
/** Younger folders are always kept: a query may have just written its file. */
export const STALE_CREDENTIALS_MS = 5 * 60_000;

/** The process exists (EPERM: it does, as another user). */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the session() folders a process left when it died before
 * dispose() (a worker stopped at its job's limit, a crash), so a Google key
 * does not stay on disk. Called once at the web service's and the worker's
 * start. Only this user's folders older than a few minutes whose process is
 * gone: the web service and the local runner's workers share the temp folder,
 * and a repo task keeps its folder for its whole run. A folder named after
 * this process but older than it was left by an earlier process with the same
 * pid (a restarted container). Returns how many it removed; never throws.
 */
export async function removeStaleCredentialFolders(opts: { dir?: string; now?: number; minAgeMs?: number } = {}): Promise<number> {
  const dir = opts.dir ?? tmpdir();
  const now = opts.now ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? STALE_CREDENTIALS_MS;
  const startedAt = Date.now() - process.uptime() * 1000;
  const uid = process.getuid?.();
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      const match = name.match(CREDENTIALS_DIR_RE);
      if (!match) continue;
      const path = join(dir, name);
      try {
        // lstat: a symlink with this name is not a folder of ours.
        const info = await lstat(path);
        if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
        if (now - info.mtimeMs < minAgeMs) continue;
        const pid = match[1] ? Number(match[1]) : undefined;
        const ownerRunning = pid === undefined ? false : pid === process.pid ? info.mtimeMs >= startedAt : processRunning(pid);
        if (ownerRunning) continue;
        await rm(path, { recursive: true, force: true });
        removed++;
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  } catch {
    return removed;
  }
  if (removed) console.log(`[ai] removed ${removed} credential folder${removed === 1 ? "" : "s"} left by stopped processes`);
  return removed;
}

/**
 * Content blocks the provider cannot read (PDFs, images) become a line of
 * text saying so, so one shared file does not fail the whole reply.
 */
export function fitContentBlocks<T extends { type: string }>(
  blocks: T[],
  runtime: Pick<ProviderRuntime, "capabilities" | "label">,
): (T | { type: "text"; text: string })[] {
  return blocks.map((block) => {
    if (block.type === "document" && !runtime.capabilities.pdf && isPdf(block)) {
      return { type: "text" as const, text: `(A PDF was shared, but ${runtime.label} cannot read PDFs here.)` };
    }
    if (block.type === "image" && !runtime.capabilities.images) {
      return { type: "text" as const, text: `(An image was shared, but ${runtime.label} cannot read images here.)` };
    }
    return block;
  });
}

const isPdf = (block: { type: string }) => (block as { source?: { media_type?: string } }).source?.media_type === "application/pdf";

// ---------- Secrets, for redaction ----------

/** Fields of a JSON credentials file that are secret: Google's service account and user keys, nested ones included. */
const SECRET_JSON_FIELDS = new Set(["private_key", "private_key_id", "client_secret", "refresh_token"]);
/** A header value that is plainly not secret (a word, a number): redacting it would garble every text that has it. */
const PLAIN_RE = /^(?:[A-Za-z]+|\d+)$/;
/** "Name: Value", as extra headers are written. */
const HEADER_LINE_RE = /^[A-Za-z0-9-]{1,100}\s*:\s*(\S.*)$/;
/** A line of a PEM key's base64 body. */
const BASE64_LINE_RE = /^[A-Za-z0-9+/=]{12,}$/;
/** The secret field holding a custom endpoint's extra headers, as "Name: Value" lines. */
const HEADERS_FIELD = "headers";

/** Lines split on real line breaks and on JSON's literal "\n", never leaving its "n" on the next line. */
const linesOf = (text: string): string[] => text.split(/\r?\n|(?:\\r)?\\n/).map((l) => l.trim());

/** The secret fields' string values anywhere in a parsed JSON value. */
function secretJsonValues(value: unknown, depth = 0): string[] {
  if (depth > 5 || typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, v]) =>
    typeof v === "string" ? (SECRET_JSON_FIELDS.has(key) && v ? [v] : []) : secretJsonValues(v, depth + 1),
  );
}

/**
 * A secret and the parts of it that can be printed on their own, for
 * redaction: exact matching only finds a value printed as it was saved.
 *
 * - The whole value.
 * - A JSON credentials file (a Google service account key): its
 *   private_key and private_key_id (and a user key's client_secret and
 *   refresh_token), as they are (`jq -r .private_key`) and JSON-escaped
 *   (`jq .`, `python -m json.tool`, which lay the file out anew).
 *   client_email and client_id stay readable: they name the account, are not
 *   secret on their own, and are what an owner needs to fix its permissions.
 * - A PEM key's base64 lines, 12 characters or more, so the key is hidden in
 *   any layout (lines joined, cut short, re-indented).
 * - With `headers` ("Name: Value" lines, a custom endpoint's extra headers):
 *   each value, and each long token in it ("Bearer <token>"), as headers are
 *   sent and printed in other layouts than the saved one
 *   (ANTHROPIC_CUSTOM_HEADERS). Plain words and numbers are left out.
 */
export function secretParts(value: string, opts: { headers?: boolean } = {}): string[] {
  const parts = [value];
  let json: unknown;
  try {
    json = /^\s*\{/.test(value) ? JSON.parse(value) : undefined;
  } catch {
    json = undefined;
  }
  const fields = secretJsonValues(json);
  for (const field of fields) parts.push(field, JSON.stringify(field).slice(1, -1));
  for (const text of [value, ...fields]) {
    if (text.includes("-----BEGIN")) parts.push(...linesOf(text).filter((l) => BASE64_LINE_RE.test(l)));
  }
  if (opts.headers) {
    for (const line of linesOf(value)) {
      const headerValue = line.match(HEADER_LINE_RE)?.[1]?.trim();
      if (!headerValue) continue;
      const tokens = [headerValue, ...headerValue.split(/[\s=,]+/).filter((p) => p.length >= 12)];
      parts.push(...tokens.filter((p) => !PLAIN_RE.test(p)));
    }
  }
  return [...new Set(parts.filter((p, i) => i === 0 || p.length >= 6))];
}

/** Every secret of a provider connection, with its parts (secretParts): what redaction must hide. */
export const connectionSecretParts = (secrets: Partial<Record<string, string>>): string[] =>
  Object.entries(nonEmpty(secrets)).flatMap(([key, value]) => secretParts(value, { headers: key === HEADERS_FIELD }));

export function redactConnection(conn: ConnectionValues): (text: string) => string {
  const needles = [...new Set(connectionSecretParts(conn.secrets))].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => needles.reduce((acc, s) => acc.split(s).join("[redacted]"), text);
}

// ---------- The connection test ----------

export interface ConnectionTestDeps {
  /** The fetch under the network guard (tests pass a fake). */
  fetch?: FetchLike;
  /** The Agent SDK's query, for the clouds (tests pass a fake). */
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ConnectionTestResult = { ok: true } | { ok: false; error: string };

const TEST_TIMEOUT_MS = 30_000;
const SDK_TEST_TIMEOUT_MS = 90_000;
/** One short answer (Claude Code's own prompt included); far more than that stops here. */
const SDK_TEST_BUDGET_USD = 0.25;

/**
 * Proves a connection works before it is saved: for an Anthropic-compatible
 * endpoint, one POST /v1/messages (max_tokens 1) through the network guard;
 * for a cloud (Bedrock, Vertex, Google Cloud, Foundry) and Gemini (through
 * the bridge, which this also proves), one turn through the Agent SDK with
 * the provider's session. Anthropic's own key is checked by listing models
 * (free). Errors never contain the secrets.
 */
export async function testConnection(id: AiProviderId, conn: ConnectionValues, deps: ConnectionTestDeps = {}): Promise<ConnectionTestResult> {
  const env = deps.env ?? process.env;
  const problem = connectionProblem(id, conn, env);
  if (problem) return { ok: false, error: problem };
  const preset = presetFor(id);
  const redact = redactConnection(conn);
  try {
    const result =
      preset.kind === "cloud" || id === "google-ai"
        ? await sdkProbe(id, conn, deps)
        : preset.kind === "anthropic"
          ? await anthropicProbe(conn, deps, env)
          : await messagesProbe(id, conn, deps, env);
    return result.ok ? result : { ok: false, error: redact(result.error) };
  } catch (err) {
    return { ok: false, error: redact(`${preset.name} could not be reached: ${errorText(err)}`).slice(0, 400) };
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** The fetch for a test call: guarded (https, public); a custom endpoint on http://localhost only when ALLOW_PRIVATE_APP_URLS=1. */
function testFetch(id: AiProviderId, url: string, deps: ConnectionTestDeps, env: NodeJS.ProcessEnv): FetchLike {
  const timeoutMs = deps.timeoutMs ?? TEST_TIMEOUT_MS;
  if (new URL(url).protocol === "http:") {
    if (id !== "custom" || baseUrlProblem(url.replace(/\/v1\/messages$/, ""), env)) throw new Error("Use an https:// address.");
    const plain: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    return (input, init = {}) => plain(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  }
  return guardedFetch({ env, timeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}

async function anthropicProbe(conn: ConnectionValues, deps: ConnectionTestDeps, env: NodeJS.ProcessEnv): Promise<ConnectionTestResult> {
  const url = "https://api.anthropic.com/v1/models?limit=1";
  const res = await testFetch("anthropic", url, deps, env)(url, {
    headers: { "x-api-key": conn.secrets.apiKey ?? "", "anthropic-version": "2023-06-01" },
  });
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401 || res.status === 403) return { ok: false, error: "Anthropic rejected this API key." };
  if (!res.ok) return { ok: false, error: `Anthropic API check failed (HTTP ${res.status}).` };
  return { ok: true };
}

async function messagesProbe(id: AiProviderId, conn: ConnectionValues, deps: ConnectionTestDeps, env: NodeJS.ProcessEnv): Promise<ConnectionTestResult> {
  const preset = presetFor(id);
  const settings = effectiveSettings(preset, conn.settings);
  const secrets = nonEmpty(conn.secrets);
  const base = compatibleBaseUrl(id, settings);
  if (!base) return { ok: false, error: `${preset.name} has no address for that region.` };
  const models = tierModels(preset, conn.models);
  // The model chat runs on by default; "[1m]" is Claude Code's own marker, never sent.
  const model = strip1m(models.main || models.sonnet || models.haiku || "claude-haiku-5-5");
  const token = id === "custom" ? (secrets.authToken ?? "") : (secrets.apiKey ?? "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(id === "custom" && settings.authHeader === "x-api-key" ? { "x-api-key": token } : { authorization: `Bearer ${token}` }),
  };
  if (id === "custom" && secrets.headers) {
    const parsed = parseHeaderLines(secrets.headers);
    if ("headers" in parsed) for (const [name, value] of parsed.headers) headers[name] = value;
  }
  const url = `${base}/v1/messages`;
  const res = await testFetch(id, url, deps, env)(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "Reply OK" }] }),
  });
  if (res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  const detail = await providerMessage(res);
  const why = detail ? `: ${detail}` : ".";
  if (res.status === 401 || res.status === 403) return { ok: false, error: `${preset.name} rejected the key${why}` };
  if (res.status === 404) return { ok: false, error: `${preset.name} answered 404: check the ${id === "custom" ? "base URL and the " : ""}model ${model}${why}` };
  // A model that must think more than one token refuses max_tokens 1: the key and the model were accepted.
  if (res.status === 400 && /max_tokens|budget|thinking/i.test(detail)) return { ok: true };
  return { ok: false, error: `${preset.name} check failed (HTTP ${res.status})${why}` };
}

/** The provider's error message from an Anthropic-style error body, on one line, short. */
async function providerMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message: string;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    message = typeof body.error === "string" ? body.error : String(body.error?.message ?? body.message ?? "");
  } catch {
    message = text;
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function sdkProbe(id: AiProviderId, conn: ConnectionValues, deps: ConnectionTestDeps): Promise<ConnectionTestResult> {
  const runtime = buildRuntime(id, conn);
  const preset = presetFor(id);
  const queryFn: QueryFn = deps.queryFn ?? query;
  // Both inside the try: whatever fails after the key file is written, finally removes it.
  let session: ProviderSession | undefined;
  let tmp: string | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? SDK_TEST_TIMEOUT_MS);
  let failure = "no answer";
  try {
    session = await runtime.session();
    tmp = await mkdtemp(join(tmpdir(), "ai-test-"));
    // No model: the main tier answers, the model chat and tasks start on.
    const options: Options = {
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      maxBudgetUsd: SDK_TEST_BUDGET_USD,
      ...(runtime.managedSettings ? { managedSettings: runtime.managedSettings } : {}),
      cwd: tmp,
      abortController: abort,
      env: { PATH: process.env.PATH ?? "", HOME: tmp, LANG: "C.UTF-8", ...session.env, CLAUDE_AGENT_SDK_CLIENT_APP: "agent-army-check/0.1.0" },
    };
    for await (const message of queryFn({ prompt: "Reply OK", options })) {
      if (message.type !== "result") continue;
      // Over the small budget still means the provider answered.
      if ((message.subtype === "success" && !message.is_error) || message.subtype === "error_max_budget_usd") return { ok: true };
      failure = message.subtype === "success" ? message.result || "the call failed" : message.errors.join("; ") || message.subtype;
    }
  } catch (err) {
    failure = errorText(err);
  } finally {
    clearTimeout(timer);
    await session?.dispose();
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  if (abort.signal.aborted) failure = "it did not answer in time";
  return { ok: false, error: `${preset.name} check failed: ${failure.replace(/\s+/g, " ").slice(0, 300)}` };
}
