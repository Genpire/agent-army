/**
 * The AI providers Pointer and the team can run on, as data: what each one
 * needs (its fields), the model each tier maps to, the models to pick from,
 * what it can do, the environment Claude Code needs for it, and its prices.
 * ai-providers.ts turns a preset and a saved connection into what a query
 * needs; the console shows the presets as they are (no secrets here).
 *
 * Model ids and prices were checked on each provider's own pages on
 * 2026-11-20 (the Claude lists on 2026-11-21, Gemini's on 2026-11-23) and
 * change often: check them again before relying on them. These lists are the
 * fallback: the console's model pickers list each provider's models live
 * where it can (model-catalog.ts).
 * Prices are USD per million tokens. Claude models (Anthropic, Bedrock,
 * Vertex, Google Cloud, Foundry) need none: Claude Code prices them itself.
 *
 * Anthropic does not support non-Claude models behind Claude Code
 * (https://code.claude.com/docs/en/llm-gateway): every preset that serves
 * other models is best effort.
 *
 * Left out for now:
 * - MiniMax: only tool_choice "auto", and caching, PDFs and structured output
 *   are undocumented on its Anthropic API.
 * - Ollama: needs a GPU host next to the service, and has no caching, PDFs,
 *   tool_choice or token counting.
 * - GPT inside Claude Code: only through translating gateways, which
 *   Anthropic and OpenRouter do not support. Codex runs as a team member
 *   instead (engines.ts).
 *
 * Gemini (google-ai) has no Anthropic-compatible API: its runtime starts the
 * platform's own translation bridge (gemini-bridge/), which Claude Code talks
 * to on 127.0.0.1 with a per-session token while the bridge calls Gemini with
 * the key. Gemini CLI also runs as a team member (engines.ts); that is the
 * "gemini" engine, a separate key and budget.
 */
import type { AiProviderId, ModelTier } from "../core/config.js";
import type { Effort } from "../team/team.js";

/** Anthropic's own API; Claude on a cloud; another provider's Anthropic-compatible API; any such endpoint. */
export type PresetKind = "anthropic" | "cloud" | "compatible" | "custom";

export interface PresetField {
  /** The key in the saved connection's secrets or settings. */
  key: string;
  label: string;
  /** Stored with the secrets: never sent back, only masked. */
  secret?: boolean;
  required?: boolean;
  /** "text" (the default), "select" (one of `options`) or "textarea" (several lines: a JSON key, headers). */
  type?: "text" | "select" | "textarea";
  options?: { value: string; label: string }[];
  /** Used when the field is left empty. */
  default?: string;
  placeholder?: string;
  help: string;
  /**
   * Part of the address the secrets are sent to (a base URL, a resource, a
   * region, a workspace). When it changes, the saved secrets are not reused:
   * they must be pasted again with the change (routes/ai.ts), so a saved key
   * never goes to a new host. Not Vertex's region or Google Cloud's location:
   * a Google key is never sent; it signs token requests to the address in
   * the key file itself.
   */
  address?: boolean;
}

/** A model to pick, with the tier it suits (a hint for the pickers). */
export interface PresetModel {
  id: string;
  label: string;
  tier: "opus" | "sonnet" | "haiku";
  /** Input tokens, when the provider says. */
  contextWindow?: number;
}

/** USD per million tokens, as Claude Code's modelPricing takes them. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PresetCapabilities {
  /** Claude Code's WebSearch (Anthropic's server-side search, or the provider's own) works. */
  webSearch: boolean;
  /** PDFs can be sent as documents. */
  pdf: boolean;
  /** Images can be sent (on the default models). */
  images: boolean;
  /** The effort levels it takes; another level goes to the nearest of these. Empty = effort is left out. */
  effort: Effort[];
  /** Thinking can be turned off on its models (some always think). */
  thinkingOff: boolean;
}

export interface AiPreset {
  id: AiProviderId;
  /** "Kimi (Moonshot)" */
  name: string;
  /** "Kimi": in status lines and messages. */
  short: string;
  kind: PresetKind;
  /** The console's logo key (web/src/lib/logos.ts). */
  logo: string;
  fields: PresetField[];
  /** The model each tier runs on when the owner picks none. "" = Claude Code's own choice. */
  defaults: Record<ModelTier, string>;
  models: PresetModel[];
  capabilities: PresetCapabilities;
  /** Extra environment for Claude Code, from the provider's own Claude Code guide. */
  env: Record<string, string>;
  /** Prices by model id, for Claude Code's cost estimates and budgets (modelPricing). */
  pricing: Record<string, ModelPrice>;
  docsUrl: string;
  /** Where the key (or credentials) come from. */
  keyHelp: string;
  /** What the owner should know: limits, what is not supported. */
  notes: string[];
  /** Runs models other than Claude behind Claude Code, which Anthropic does not support. */
  bestEffort: boolean;
}

export const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** What the console says for every bestEffort preset (its notes leave it out). */
export const BEST_EFFORT_NOTE = "Best effort: Anthropic does not support non-Claude models behind Claude Code, so some features may misbehave.";

const tiers = (main: string, opus: string, sonnet: string, haiku: string, subagent = main): Record<ModelTier, string> => ({
  main,
  opus,
  sonnet,
  haiku,
  subagent,
});

const apiKeyField = (label: string, placeholder: string, help: string): PresetField => ({
  key: "apiKey",
  label,
  secret: true,
  required: true,
  placeholder,
  help,
});

/** A Google service account key: written to a private file for each query, never into a checkout. */
const credentialsJsonField = (role: string): PresetField => ({
  key: "credentialsJson",
  label: "Service account key (JSON)",
  secret: true,
  type: "textarea",
  placeholder: '{"type": "service_account", …}',
  help: `A key for a service account with ${role}. Leave it empty to use the service's own Google credentials (on Cloud Run, its service account).`,
});

/** A million tokens: the context window of every current Claude model (Haiku 4.5 has 200K). */
const M = 1_000_000;

/** Claude on Anthropic's API (and Claude Platform on AWS, Google Cloud), newest of each line first. */
const CLAUDE_MODELS: PresetModel[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", tier: "opus", contextWindow: M },
  { id: "claude-opus-5-5", label: "Opus 5.5", tier: "opus", contextWindow: M },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: "sonnet", contextWindow: M },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", tier: "haiku", contextWindow: M },
  { id: "claude-fable-5-1", label: "Fable 5.1", tier: "opus", contextWindow: M },
  { id: "claude-opus-5", label: "Opus 5", tier: "opus", contextWindow: M },
  { id: "claude-opus-4-8", label: "Opus 4.8", tier: "opus", contextWindow: M },
  { id: "claude-sonnet-5", label: "Sonnet 5", tier: "sonnet", contextWindow: M },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "sonnet", contextWindow: M },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: "haiku", contextWindow: 200_000 },
];

const CLAUDE_CAPABILITIES: PresetCapabilities = { webSearch: true, pdf: true, images: true, effort: ALL_EFFORTS, thinkingOff: true };

export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    short: "Claude",
    kind: "anthropic",
    logo: "anthropic",
    fields: [apiKeyField("Anthropic API key", "sk-ant-…", "From the Claude Console, under API keys.")],
    defaults: tiers("", "", "", "", ""),
    models: CLAUDE_MODELS,
    capabilities: CLAUDE_CAPABILITIES,
    env: {},
    pricing: {},
    docsUrl: "https://platform.claude.com/docs/en/get-started",
    keyHelp: "Create a key in the Claude Console (platform.claude.com, API keys). A key just for this service shows its spend on its own.",
    notes: [],
    bestEffort: false,
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    short: "Bedrock",
    kind: "cloud",
    logo: "bedrock",
    fields: [
      {
        key: "region",
        label: "AWS region",
        required: true,
        address: true,
        default: "us-east-1",
        placeholder: "us-east-1",
        help: "The region the requests go to. Models in other regions need their inference profile's prefix (us., eu., global.).",
      },
      {
        key: "apiKey",
        label: "Bedrock API key",
        secret: true,
        placeholder: "Paste a Bedrock API key",
        help: "A Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). Or leave it empty and give an access key below.",
      },
      { key: "accessKeyId", label: "Access key ID", secret: true, placeholder: "AKIA…", help: "An IAM access key allowed bedrock:InvokeModel and InvokeModelWithResponseStream." },
      { key: "secretAccessKey", label: "Secret access key", secret: true, help: "The access key's secret." },
      { key: "sessionToken", label: "Session token", secret: true, help: "Only for temporary credentials." },
    ],
    defaults: tiers(
      "us.anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5",
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ),
    models: [
      { id: "us.anthropic.claude-fable-5-2", label: "Fable 5.2 (US)", tier: "opus", contextWindow: M },
      { id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5 (US)", tier: "opus", contextWindow: M },
      { id: "global.anthropic.claude-opus-5-5", label: "Opus 5.5 (global)", tier: "opus", contextWindow: M },
      { id: "eu.anthropic.claude-opus-5-5", label: "Opus 5.5 (EU)", tier: "opus", contextWindow: M },
      { id: "us.anthropic.claude-sonnet-5-5", label: "Sonnet 5.5 (US)", tier: "sonnet", contextWindow: M },
      { id: "global.anthropic.claude-sonnet-5-5", label: "Sonnet 5.5 (global)", tier: "sonnet", contextWindow: M },
      { id: "us.anthropic.claude-haiku-5-5", label: "Haiku 5.5 (US)", tier: "haiku", contextWindow: M },
      { id: "us.anthropic.claude-opus-4-8", label: "Opus 4.8 (US)", tier: "opus", contextWindow: M },
      { id: "us.anthropic.claude-sonnet-4-6", label: "Sonnet 4.6 (US)", tier: "sonnet", contextWindow: M },
      { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Haiku 4.5 (US)", tier: "haiku", contextWindow: 200_000 },
    ],
    capabilities: { ...CLAUDE_CAPABILITIES, webSearch: false },
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    pricing: {},
    docsUrl: "https://code.claude.com/docs/en/amazon-bedrock",
    keyHelp: "In the AWS console: Bedrock, API keys (or IAM, an access key). Enable the Claude models in the region first.",
    notes: [
      "Web search: not available on Bedrock.",
      "Costs are estimated at Anthropic's list prices, not Bedrock's.",
      "Fable 5.2 runs only in the regions AWS offers it in.",
    ],
    bestEffort: false,
  },
  {
    id: "vertex",
    name: "Google Vertex AI",
    short: "Vertex AI",
    kind: "cloud",
    logo: "googlecloud",
    fields: [
      { key: "projectId", label: "Project ID", required: true, placeholder: "my-project", help: "The Google Cloud project the Claude models are enabled in (Model Garden)." },
      {
        key: "region",
        label: "Region",
        required: true,
        default: "global",
        placeholder: "global",
        help: "global (recommended), us, eu, or a region such as us-east5.",
      },
      credentialsJsonField("roles/aiplatform.user"),
    ],
    defaults: tiers("claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5@20251001"),
    models: [
      { id: "claude-fable-5-2", label: "Fable 5.2", tier: "opus", contextWindow: M },
      { id: "claude-opus-5-5", label: "Opus 5.5", tier: "opus", contextWindow: M },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: "sonnet", contextWindow: M },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", tier: "haiku", contextWindow: M },
      { id: "claude-opus-4-8", label: "Opus 4.8", tier: "opus", contextWindow: M },
      { id: "claude-sonnet-5", label: "Sonnet 5", tier: "sonnet", contextWindow: M },
      { id: "claude-haiku-4-5@20251001", label: "Haiku 4.5", tier: "haiku", contextWindow: 200_000 },
    ],
    capabilities: CLAUDE_CAPABILITIES,
    env: { CLAUDE_CODE_USE_VERTEX: "1" },
    pricing: {},
    docsUrl: "https://code.claude.com/docs/en/google-vertex-ai",
    keyHelp: "In the Google Cloud console: enable the Claude models in Model Garden, then create a service account key (IAM, Service accounts, Keys).",
    notes: ["Costs are estimated at Anthropic's list prices, not Google's.", "Fable 5.2 runs only where Google offers it: enable it in Model Garden first."],
    bestEffort: false,
  },
  {
    id: "google-cloud",
    name: "Google Cloud (Anthropic managed)",
    short: "Google Cloud",
    kind: "cloud",
    logo: "googlecloud",
    fields: [
      { key: "projectId", label: "Project ID", required: true, placeholder: "my-project", help: "The Google Cloud project with the Claude API (claude.googleapis.com) enabled." },
      { key: "workspaceId", label: "Workspace ID", required: true, placeholder: "wrkspc_…", help: "The Claude workspace in that project." },
      { key: "location", label: "Location", default: "global", placeholder: "global", help: "Leave it at global unless your workspace says otherwise." },
      credentialsJsonField("roles/claude.user"),
    ],
    defaults: tiers("claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"),
    models: [
      { id: "claude-fable-5-2", label: "Fable 5.2", tier: "opus", contextWindow: M },
      { id: "claude-opus-5-5", label: "Opus 5.5", tier: "opus", contextWindow: M },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: "sonnet", contextWindow: M },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", tier: "haiku", contextWindow: M },
      { id: "claude-fable-5-1", label: "Fable 5.1", tier: "opus", contextWindow: M },
      { id: "claude-opus-5", label: "Opus 5", tier: "opus", contextWindow: M },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "haiku", contextWindow: 200_000 },
    ],
    capabilities: CLAUDE_CAPABILITIES,
    env: { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1" },
    pricing: {},
    docsUrl: "https://code.claude.com/docs/en/claude-models-on-google-cloud-anthropic-managed",
    keyHelp: "In the Google Cloud console: enable claude.googleapis.com, note the workspace ID, and create a service account key with roles/claude.user.",
    notes: [],
    bestEffort: false,
  },
  {
    id: "foundry",
    name: "Microsoft Foundry",
    short: "Foundry",
    kind: "cloud",
    logo: "foundry",
    fields: [
      {
        key: "resource",
        label: "Resource name",
        required: true,
        address: true,
        placeholder: "my-resource",
        help: "The Foundry resource's name only (from https://<name>.services.ai.azure.com), not its address.",
      },
      apiKeyField("API key", "Paste the resource's key", "From the resource's Keys and Endpoint page."),
    ],
    defaults: tiers("claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"),
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", tier: "opus", contextWindow: M },
      { id: "claude-fable-5-2", label: "Fable 5.2", tier: "opus", contextWindow: M },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: "sonnet", contextWindow: M },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", tier: "haiku", contextWindow: M },
      { id: "claude-opus-4-8", label: "Opus 4.8", tier: "opus", contextWindow: M },
      { id: "claude-sonnet-5", label: "Sonnet 5", tier: "sonnet", contextWindow: M },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: "haiku", contextWindow: 200_000 },
    ],
    capabilities: CLAUDE_CAPABILITIES,
    env: { CLAUDE_CODE_USE_FOUNDRY: "1" },
    pricing: {},
    docsUrl: "https://code.claude.com/docs/en/microsoft-foundry",
    keyHelp: "Deploy the Claude models in your Foundry resource, then copy its key. The models below are deployment names: name deployments after the model ids.",
    notes: [
      "Models are deployment names; costs are only right when they are named after the model ids.",
      "Fable 5.2 deploys only on Foundry's Anthropic-hosted option.",
    ],
    bestEffort: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    short: "DeepSeek",
    kind: "compatible",
    logo: "deepseek",
    fields: [apiKeyField("DeepSeek API key", "sk-…", "A pay-as-you-go key from the DeepSeek platform, under API keys.")],
    defaults: tiers("deepseek-flash[1m]", "deepseek-flash[1m]", "deepseek-flash[1m]", "deepseek-flash", "deepseek-flash"),
    models: [
      { id: "deepseek-v4-pro[1m]", label: "DeepSeek V4 Pro", tier: "opus", contextWindow: 1_048_576 },
      { id: "deepseek-flash[1m]", label: "DeepSeek Flash", tier: "sonnet", contextWindow: 1_048_576 },
      { id: "deepseek-flash", label: "DeepSeek Flash (background)", tier: "haiku" },
    ],
    capabilities: { webSearch: true, pdf: false, images: true, effort: ["low", "high", "max"], thinkingOff: true },
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432", CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1" },
    pricing: {
      // Peak rates; off-peak is half, so budgets err on the safe side.
      "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
      "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
    },
    docsUrl: "https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code",
    keyHelp: "Create a key on platform.deepseek.com, under API keys, and top up the balance.",
    notes: [
      "PDFs: not supported (DeepSeek's Anthropic API takes no PDF documents).",
      "Images: DeepSeek Flash only; V4 Pro ignores them.",
      "Costs use DeepSeek's peak prices; off-peak hours cost half.",
    ],
    bestEffort: true,
  },
  {
    id: "qwen",
    name: "Alibaba Qwen (Model Studio)",
    short: "Qwen",
    kind: "compatible",
    logo: "qwen",
    fields: [
      {
        key: "region",
        label: "Region",
        type: "select",
        required: true,
        default: "ap-southeast-1",
        address: true,
        options: [
          { value: "ap-southeast-1", label: "Singapore (international)" },
          { value: "us-east-1", label: "US (Virginia)" },
          { value: "eu-central-1", label: "Germany (Frankfurt)" },
          { value: "ap-northeast-1", label: "Japan (Tokyo)" },
          { value: "cn-hongkong", label: "China (Hong Kong)" },
          { value: "cn-beijing", label: "China (Beijing)" },
        ],
        help: "Where your Model Studio workspace is.",
      },
      {
        key: "workspaceId",
        label: "Workspace ID",
        placeholder: "ws-…",
        address: true,
        help: "Your pay-as-you-go workspace's ID, from Model Studio. Needed in the US, Germany and Japan; elsewhere, empty uses the shared address.",
      },
      apiKeyField("API key", "sk-…", "A pay-as-you-go key (sk-…). Coding Plan keys (sk-sp-…) are not allowed for applications like this one."),
    ],
    defaults: tiers("qwen3.7-max", "qwen3.7-max", "qwen3.7-max", "qwen3.6-flash"),
    models: [
      { id: "qwen4-max", label: "Qwen4 Max", tier: "opus", contextWindow: M },
      { id: "qwen3.7-max", label: "Qwen3.7 Max", tier: "sonnet", contextWindow: M },
      { id: "qwen3.6-flash", label: "Qwen3.6 Flash", tier: "haiku", contextWindow: M },
    ],
    capabilities: { webSearch: true, pdf: true, images: true, effort: ["low", "high", "xhigh"], thinkingOff: true },
    env: {},
    pricing: {
      // Singapore list prices; cache prices worked out from Model Studio's rules (write 125%, hit 10% of input).
      "qwen4-max": { input: 1.5, output: 4.5, cacheRead: 0.075, cacheWrite: 1.875 },
      "qwen3.7-max": { input: 2.5, output: 7.5, cacheRead: 0.25, cacheWrite: 3.125 },
      "qwen3.6-flash": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.3125 },
    },
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/claude-code",
    keyHelp: "In Alibaba Cloud Model Studio: API keys, create a key for a pay-as-you-go workspace. Coding Plan and Token Plan keys forbid application backends.",
    notes: ["Costs use Singapore list prices; other regions and long prompts (Qwen3.6 Flash above 256K tokens) cost more."],
    bestEffort: true,
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    short: "Kimi",
    kind: "compatible",
    logo: "kimi",
    fields: [
      {
        key: "region",
        label: "Platform",
        type: "select",
        required: true,
        default: "international",
        address: true,
        options: [
          { value: "international", label: "International (platform.kimi.ai)" },
          { value: "china", label: "China (platform.moonshot.cn)" },
        ],
        help: "Where the key was created: keys work only on their own platform.",
      },
      apiKeyField("API key", "sk-…", "A pay-as-you-go platform key. Kimi Code membership keys are for personal use and do not work here."),
    ],
    defaults: tiers("kimi-k3[1m]", "kimi-k3[1m]", "kimi-k3[1m]", "kimi-k3[1m]"),
    models: [
      { id: "kimi-k3[1m]", label: "Kimi K3", tier: "opus", contextWindow: 1_048_576 },
      { id: "kimi-k3.1-pro[1m]", label: "Kimi K3.1 Pro", tier: "opus", contextWindow: 1_048_576 },
      { id: "kimi-k3.1-pro-highspeed[1m]", label: "Kimi K3.1 Pro (high speed)", tier: "sonnet" },
    ],
    capabilities: { webSearch: false, pdf: false, images: true, effort: ["low", "high", "max"], thinkingOff: false },
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
    pricing: {
      "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
      "kimi-k3.1-pro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
      "kimi-k3.1-pro-highspeed": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 },
    },
    docsUrl: "https://platform.kimi.ai/docs/guide/claude-code-kimi",
    keyHelp: "Create a key on the Kimi platform (platform.kimi.ai, API keys) and add a balance.",
    notes: ["Web search: not available on Kimi.", "PDFs: not supported.", "Kimi always thinks: thinking cannot be turned off."],
    bestEffort: true,
  },
  {
    id: "zai",
    name: "Z.ai GLM",
    short: "GLM",
    kind: "compatible",
    logo: "zai",
    fields: [
      {
        key: "region",
        label: "Platform",
        type: "select",
        required: true,
        default: "international",
        address: true,
        options: [
          { value: "international", label: "International (z.ai)" },
          { value: "china", label: "China (bigmodel.cn)" },
        ],
        help: "Where the key was created: keys work only on their own platform.",
      },
      apiKeyField("API key", "Paste a Standard key", "A Standard (pay-as-you-go) key. GLM Coding Plan keys are only for the coding tools Z.ai supports."),
    ],
    defaults: tiers("glm-5.3[1m]", "glm-5.3[1m]", "glm-5.3[1m]", "glm-5.3-flash[1m]"),
    models: [
      { id: "glm-5.3[1m]", label: "GLM-5.3", tier: "opus", contextWindow: M },
      { id: "glm-5.3-flash[1m]", label: "GLM-5.3 Flash", tier: "haiku", contextWindow: M },
    ],
    capabilities: { webSearch: false, pdf: false, images: false, effort: ["low", "high", "max"], thinkingOff: false },
    env: {
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
      CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1",
      DISABLE_TELEMETRY: "1",
    },
    pricing: {
      "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
      "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 },
    },
    docsUrl: "https://docs.z.ai/devpack/tool/claude",
    keyHelp: "Create a Standard API key on z.ai (or bigmodel.cn in China), under API keys.",
    notes: [
      "Web search: not available on GLM.",
      "PDFs: not supported. Images: GLM-5.3 Flash only.",
      "GLM always thinks: thinking cannot be turned off.",
      "Accounts that ever had a GLM Coding Plan may be limited to Z.ai's OpenAI-compatible API.",
    ],
    bestEffort: true,
  },
  {
    id: "google-ai",
    name: "Gemini (Google AI Studio)",
    short: "Gemini",
    kind: "compatible",
    logo: "gemini",
    fields: [
      apiKeyField(
        "API key",
        "AQ.… or AIza…",
        "A Gemini API key from Google AI Studio (https://aistudio.google.com/apikey), on a project with billing: the Gemini 4 models are not on the free tier.",
      ),
    ],
    // Carbon is Google's strongest; Neon the fast frontier model; Hydrogen what 3.x Flash moves to; 3.5 Flash-Lite the lowest cost.
    defaults: tiers("gemini-4-carbon", "gemini-4-carbon", "gemini-4-neon", "gemini-3.5-flash-lite", "gemini-4-hydrogen"),
    models: [
      { id: "gemini-4-carbon", label: "Gemini 4 Carbon", tier: "opus", contextWindow: 1_048_576 },
      { id: "gemini-4-argon", label: "Gemini 4 Argon", tier: "opus", contextWindow: 1_048_576 },
      { id: "gemini-4-neon", label: "Gemini 4 Neon", tier: "sonnet", contextWindow: 1_048_576 },
      { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", tier: "sonnet", contextWindow: 1_048_576 },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", tier: "sonnet", contextWindow: 1_048_576 },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", tier: "sonnet", contextWindow: 1_048_576 },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", tier: "haiku", contextWindow: 1_048_576 },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", tier: "haiku", contextWindow: 1_048_576 },
    ],
    // Effort is Gemini's thinking level (gemini-bridge/request.ts): xhigh on Neon and Hydrogen, high elsewhere.
    capabilities: { webSearch: false, pdf: true, images: true, effort: ["low", "medium", "high", "xhigh"], thinkingOff: false },
    env: {
      // The 1,048,576-token window holds the answer too: compact with room for a whole one.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "960000",
      // No beta features (tool search among them) and no structured output requests: the bridge would drop them.
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1",
    },
    pricing: {
      // Standard tier. Where Google has announced a rise, the new price: Carbon and Argon double on
      // 2026-12-01, the 3.x Flash models on 2027-01-01. Cache reads are Google's caching price
      // (implicit caching); there is no cache write charge.
      "gemini-4-carbon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 },
      "gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 },
      "gemini-4-neon": { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 3 },
      "gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 1.5 },
      "gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 },
      "gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 },
      "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
      "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
    },
    docsUrl: "https://aistudio.google.com/docs/models",
    keyHelp: "Create a key in Google AI Studio (aistudio.google.com/apikey) on a project with billing set up. New keys start with AQ., older ones with AIza.",
    notes: [
      "Runs through a bridge built into this service: Claude Code's requests are translated to the Gemini API here, and the key never leaves the server.",
      "Web search: not available (Claude Code's WebSearch is Anthropic's).",
      "Prompt caching: Claude Code's cache markers are ignored; Gemini's own implicit caching still applies.",
      "Gemini 4 always thinks: thinking cannot be turned off. Effort sets Gemini's thinking level; max runs as xhigh on Neon and Hydrogen, as high elsewhere.",
      "Costs use Google's Standard prices, at the higher rate where Google has announced a rise.",
    ],
    bestEffort: true,
  },
  {
    id: "custom",
    name: "Custom endpoint",
    short: "Custom endpoint",
    kind: "custom",
    logo: "custom",
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        required: true,
        address: true,
        placeholder: "https://ai-gateway.vercel.sh/claude-code",
        help: "An Anthropic Messages API, without /v1: LiteLLM, Vercel AI Gateway, OpenRouter (Claude models), Cloudflare AI Gateway… https:// only.",
      },
      { key: "authToken", label: "Token", secret: true, required: true, help: "The gateway's key or token." },
      {
        key: "authHeader",
        label: "Send the token as",
        type: "select",
        default: "bearer",
        options: [
          { value: "bearer", label: "Authorization: Bearer (most gateways)" },
          { value: "x-api-key", label: "x-api-key (Anthropic's header)" },
        ],
        help: "Which header the gateway reads the token from.",
      },
      {
        key: "headers",
        label: "Extra headers",
        secret: true,
        type: "textarea",
        placeholder: "cf-aig-authorization: Bearer …",
        help: "One per line, as Name: Value (ANTHROPIC_CUSTOM_HEADERS). Stored as a secret.",
      },
      {
        key: "webSearch",
        label: "Web search",
        type: "select",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On: the endpoint serves Anthropic's web search" },
        ],
        help: "Turn on only when the endpoint passes Claude models through (OpenRouter's Anthropic provider, Vercel with Claude).",
      },
      {
        key: "compat",
        label: "Compatibility mode",
        type: "select",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On: leave out beta features and structured output requests" },
        ],
        help: "Turn on when the endpoint answers 400 to Claude Code's requests (Bedrock or Vertex behind a gateway, non-Claude models).",
      },
      { key: "inputPrice", label: "Input price", placeholder: "3", help: "USD per million input tokens, for budgets. Empty: Claude's list prices, or a guess for unknown models." },
      { key: "outputPrice", label: "Output price", placeholder: "15", help: "USD per million output tokens." },
    ],
    defaults: tiers("", "", "", "", ""),
    models: [],
    capabilities: { webSearch: false, pdf: true, images: true, effort: ALL_EFFORTS, thinkingOff: true },
    env: {},
    pricing: {},
    docsUrl: "https://code.claude.com/docs/en/llm-gateway",
    keyHelp: "The gateway's own key. Type the model ids the gateway expects; empty tiers send Claude's own model ids.",
    notes: [
      "Anthropic and OpenRouter support only Claude models through a gateway; anything else is best effort.",
      "What works (web search, PDFs, effort) depends on the endpoint.",
    ],
    bestEffort: true,
  },
];

export function presetFor(id: AiProviderId): AiPreset {
  const preset = AI_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown AI provider ${id}`);
  return preset;
}

/** The Anthropic-compatible base URL (no /v1) of a compatible preset, from its settings; undefined when one is missing. */
export function compatibleBaseUrl(id: AiProviderId, settings: Record<string, string>): string | undefined {
  const region = settings.region || presetFor(id).fields.find((f) => f.key === "region")?.default || "";
  switch (id) {
    case "deepseek":
      return "https://api.deepseek.com/anthropic";
    case "kimi":
      return region === "china" ? "https://api.moonshot.cn/anthropic" : "https://api.moonshot.ai/anthropic";
    case "zai":
      return region === "china" ? "https://open.bigmodel.cn/api/anthropic" : "https://api.z.ai/api/anthropic";
    case "qwen": {
      const workspace = settings.workspaceId?.trim();
      if (workspace) return `https://${workspace}.${region}.maas.aliyuncs.com/apps/anthropic`;
      return QWEN_SHARED_HOSTS[region] ? `https://${QWEN_SHARED_HOSTS[region]}/apps/anthropic` : undefined;
    }
    case "custom":
      return settings.baseUrl?.trim().replace(/\/+$/, "") || undefined;
    default:
      return undefined;
  }
}

/** Model Studio's shared (pre-workspace) addresses, which still work; the other regions need a workspace ID. */
export const QWEN_SHARED_HOSTS: Record<string, string> = {
  "ap-southeast-1": "dashscope-intl.aliyuncs.com",
  "cn-beijing": "dashscope.aliyuncs.com",
  "cn-hongkong": "cn-hongkong.dashscope.aliyuncs.com",
};
