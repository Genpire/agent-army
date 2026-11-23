/**
 * The models each AI provider and coding engine offers, for the console's
 * model pickers (GET /api/ai/providers/:id/models, GET /api/engines/:id/models).
 *
 * Each source is listed live from the provider's own model list, with the
 * credentials saved for it, and filtered to models that chat or code
 * (embeddings, speech, image and video models are left out):
 * - Anthropic: GET https://api.anthropic.com/v1/models (paginated, labels from display_name).
 * - Codex (the OpenAI key): GET https://api.openai.com/v1/models, the GPT, o-series and Codex models.
 * - Gemini CLI (the Gemini key) and Gemini (Google AI Studio, its own key): GET
 *   https://generativelanguage.googleapis.com/v1beta/models (paginated), the models whose
 *   supportedGenerationMethods include generateContent.
 * - DeepSeek: GET https://api.deepseek.com/models.
 * - Kimi: GET https://api.moonshot.ai/v1/models (api.moonshot.cn in China).
 * - Qwen: Model Studio's GET /api/v1/models on the workspace's host (or the region's shared one), paginated.
 * - A custom endpoint: GET <base>/v1/models through the network guard, as its connection test does.
 * Bedrock (its list needs AWS request signing, and the AWS SDK is not a
 * dependency), Vertex AI and Google Cloud (a Google OAuth token), Foundry (it
 * lists deployments, not models) and Z.ai (no list API) keep the presets'
 * built-in lists.
 *
 * A list that cannot be read live (not connected, the call failed, no list
 * API) is the preset's built-in list, with `live: false` and the reason.
 * Live lists are kept in memory for an hour, built-in ones after a failure for
 * a few minutes, keyed by the source and a fingerprint of its credentials and
 * address (a hash, never the secret). `refresh` reads the list again.
 *
 * The saved credentials are used here, on the server, and never leave it:
 * nothing returned or logged holds them (errors are redacted with every
 * secret the configuration holds).
 */
import { createHash } from "node:crypto";
import type { AiProviderId, Config, EngineId } from "../core/config.js";
import { type FetchLike, type LookupFn, guardedFetch } from "../integrations/apps/apps-net.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import { type AiPreset, QWEN_SHARED_HOSTS, compatibleBaseUrl, presetFor } from "./ai-presets.js";
import { type ConnectionValues, baseUrlProblem, connectionOf, connectionProblem, connectionSecretParts, effectiveSettings, parseHeaderLines } from "./ai-providers.js";

/** What a model is for; the pickers get only "chat" models (chat and coding). */
export type ModelKind = "chat" | "embedding" | "audio" | "image" | "moderation" | "other";

export interface CatalogModel {
  id: string;
  /** "Opus 5.5", "Gemini 4 Carbon". */
  label: string;
  description?: string;
  /** Input tokens, when the provider says. */
  contextWindow?: number;
  kind?: ModelKind;
  /** The provider says it is deprecated or shuts down soon. */
  deprecated?: boolean;
  /** When the provider released it (ISO 8601), when it says. */
  created?: string;
  /** For grouping in the pickers: "Opus", "GPT-6", "Gemini 4". */
  family?: string;
}

/** A source's models, as the routes return them. */
export interface ModelList {
  models: CatalogModel[];
  /** Read from the provider just now (or within the hour); false: the built-in list. */
  live: boolean;
  /** Why the list is the built-in one. */
  reason?: string;
  fetchedAt: string;
  /** Whose list it is: "Anthropic", "OpenAI", "Google". */
  source: string;
}

export interface CatalogOptions {
  /** The fetch under the network guard (tests pass a fake). */
  fetch?: FetchLike;
  /** How the guard resolves a host (tests pass a fake). */
  lookup?: LookupFn;
  env?: NodeJS.ProcessEnv;
  /** For one whole listing, every page included (default 10 s). */
  timeoutMs?: number;
  /** How long a live list is kept (default an hour). */
  ttlMs?: number;
  /** How long the built-in list is kept after a failed call (default 5 minutes). */
  failureTtlMs?: number;
  now?: () => number;
  /** Where a failed call is reported, redacted (default console.warn). */
  log?: (line: string) => void;
}

export const CATALOG_TTL_MS = 60 * 60_000;
export const CATALOG_FAILURE_TTL_MS = 5 * 60_000;
export const CATALOG_TIMEOUT_MS = 10_000;
/** Pages read at most from a paginated list. */
const MAX_PAGES = 10;
/** Entries kept at most (every credential change makes a new one). */
const MAX_ENTRIES = 200;
const DESCRIPTION_MAX = 120;
const MILLION = 1_000_000;

// ---------- Parsing what the providers answer ----------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const arrayOf = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);
const shortText = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? flat;
  return sentence.length > DESCRIPTION_MAX ? `${sentence.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : sentence;
};
/** An ISO date from an RFC 3339 string or Unix seconds; undefined for nothing, or the epoch (Anthropic's "unknown"). */
function isoDate(v: unknown): string | undefined {
  const ms = typeof v === "number" ? v * 1000 : typeof v === "string" && v ? Date.parse(v.replace(" ", "T")) : NaN;
  return Number.isFinite(ms) && ms > 86_400_000 ? new Date(ms).toISOString() : undefined;
}
/** Model ids the pickers can pass on: printable, no spaces, at most 200 characters. */
const usableId = (id: string) => /^[\x21-\x7e]{1,200}$/.test(id);

/** What a model is for, from its id (providers that say it themselves are read before this). */
export function classifyModelId(id: string): ModelKind {
  const s = id.toLowerCase();
  const word = (w: string) => new RegExp(`(?:^|[-_.:/])(?:${w})(?:$|[-_.:/\\d])`).test(s);
  if (s.includes("embed")) return "embedding";
  if (word("moderation|guard")) return "moderation";
  if (word("tts|whisper|transcribe|realtime|audio|speech|asr|native-audio|live")) return "audio";
  if (s.startsWith("gpt-image") || word("image|imagen|dall-e|sora|veo|video|lyria")) return "image";
  return "chat";
}

/** "gpt-6.2-astra" → "GPT-6.2 Astra", "kimi-k3.1-pro" → "Kimi K3.1 Pro", a dated snapshot with its date. */
export function prettyModelId(id: string): string {
  const date = id.match(/-(\d{4}-\d{2}-\d{2})$/);
  const parts = (date ? id.slice(0, -date[0].length) : id).split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const next = parts[i + 1];
    if (p.toLowerCase() === "gpt" && next && /^\d/.test(next)) {
      out.push(`GPT-${next}`);
      i++;
    } else if (i === 0 && /^o\d/.test(p)) out.push(p);
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return `${out.join(" ")}${date ? ` (${date[1]})` : ""}`;
}

/** The version a model id carries ("gpt-6.2-astra" → 6.2, "gemini-4-neon" → 4), for newest-first order. */
const versionOf = (id: string): number => Number(id.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
const isSnapshot = (id: string) => /-\d{4}-?\d{2}-?\d{2}$|-\d{3}$/.test(id);
const isPreview = (id: string) => /(?:^|-)(?:preview|exp|experimental|latest)(?:-|$)/.test(id);

/** Newest version first; within one, stable before previews and snapshots, newest release first. */
function newestFirst(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort(
    (a, b) =>
      versionOf(b.id) - versionOf(a.id) ||
      Number(isSnapshot(a.id) || isPreview(a.id)) - Number(isSnapshot(b.id) || isPreview(b.id)) ||
      (b.created ?? "").localeCompare(a.created ?? "") ||
      a.id.localeCompare(b.id),
  );
}

/** "claude-opus-5-5", Bedrock's "us.anthropic.claude-opus-5-5", a gateway's "anthropic/claude-opus-5-5". */
const CLAUDE_LINE_RE = /(?:^|[./])claude-(fable|mythos|opus|sonnet|haiku)/;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "Opus" for a Claude model id (bare, Bedrock's or Vertex's), else undefined. */
export const claudeFamily = (id: string): string | undefined => {
  const line = id.toLowerCase().match(CLAUDE_LINE_RE)?.[1];
  return line ? capitalize(line) : undefined;
};

/** One page of Anthropic's GET /v1/models (a custom endpoint's too, when it answers in that shape). */
export function parseAnthropicPage(body: unknown): { models: CatalogModel[]; hasMore: boolean; lastId?: string } {
  const page = isObject(body) ? body : {};
  const models: CatalogModel[] = [];
  for (const m of arrayOf(page.data)) {
    const id = str(m.id);
    if (!usableId(id) || (m.type !== undefined && m.type !== "model")) continue;
    const lifecycle = str(m.lifecycle);
    if (lifecycle === "retired") continue;
    const display = str(m.display_name);
    const line = str(m.line);
    const family = line ? capitalize(line) : claudeFamily(id);
    models.push({
      id,
      label: display ? display.replace(/^Claude\s+/i, "") : prettyModelId(id),
      ...(posInt(m.max_input_tokens) ? { contextWindow: posInt(m.max_input_tokens) } : {}),
      kind: "chat",
      ...(lifecycle === "deprecated" || str(m.deprecated_at) ? { deprecated: true } : {}),
      ...(isoDate(m.created_at) ? { created: isoDate(m.created_at) } : {}),
      ...(family ? { family } : {}),
    });
  }
  const lastId = str(page.last_id) || models.at(-1)?.id;
  return { models, hasMore: page.has_more === true, ...(lastId ? { lastId } : {}) };
}

const OPENAI_KEEP_RE = /^(?:gpt-\d|o\d|codex|chatgpt-)/;
/** Chat models Codex cannot use: completions-only, search, computer use, and the oldest generations. */
const OPENAI_SKIP_RE = /(?:^|-)(?:instruct|search|computer-use|davinci|babbage)(?:-|$)|^gpt-3/;

const openAiFamily = (id: string): string => {
  const gpt = id.match(/^gpt-(\d+)/);
  if (gpt) return `GPT-${gpt[1]}`;
  if (/^o\d/.test(id)) return "o-series";
  return id.includes("codex") ? "Codex" : "Other";
};

/** OpenAI's GET /v1/models: the GPT, o-series and Codex models that chat and code, newest first. */
export function parseOpenAiModels(body: unknown): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const m of arrayOf(isObject(body) ? body.data : undefined)) {
    const id = str(m.id);
    if (!usableId(id) || !OPENAI_KEEP_RE.test(id) || OPENAI_SKIP_RE.test(id) || classifyModelId(id) !== "chat") continue;
    models.push({
      id,
      label: prettyModelId(id),
      kind: "chat",
      ...(m.shutdown_date ? { deprecated: true } : {}),
      ...(isoDate(m.created) ? { created: isoDate(m.created) } : {}),
      family: openAiFamily(id),
    });
  }
  return newestFirst(models);
}

/** Gemini models that generate content but are not for chat or code. */
const GEMINI_SKIP_RE = /(?:^|-)(?:aqa|robotics|computer-use|learnlm)(?:-|$)/;

const geminiFamily = (id: string): string => {
  const major = id.match(/^gemini-(\d+)/)?.[1];
  if (major) return `Gemini ${major}`;
  return id.startsWith("gemma") ? "Gemma" : "Other";
};

/** One page of Gemini's GET /v1beta/models: the models that generate content and chat or code. */
export function parseGeminiPage(body: unknown): { models: CatalogModel[]; nextPageToken?: string } {
  const page = isObject(body) ? body : {};
  const models: CatalogModel[] = [];
  for (const m of arrayOf(page.models)) {
    const id = str(m.name).replace(/^models\//, "");
    const methods = [m.supportedGenerationMethods, m.supported_actions].flatMap((v) => (Array.isArray(v) ? v : []));
    if (!usableId(id) || !methods.includes("generateContent") || GEMINI_SKIP_RE.test(id) || classifyModelId(id) !== "chat") continue;
    const description = str(m.description);
    models.push({
      id,
      label: str(m.displayName) || prettyModelId(id),
      ...(description ? { description: shortText(description) } : {}),
      ...(posInt(m.inputTokenLimit) ? { contextWindow: posInt(m.inputTokenLimit) } : {}),
      kind: "chat",
      ...(/deprecated/i.test(description) ? { deprecated: true } : {}),
      family: geminiFamily(id),
    });
  }
  const next = str(page.nextPageToken);
  return { models, ...(next ? { nextPageToken: next } : {}) };
}

/** An OpenAI-style list (DeepSeek, Kimi, a gateway's /v1/models): the chat models, with a name and context window when given. */
export function parseCompatibleModels(body: unknown, family?: (id: string) => string | undefined): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const m of arrayOf(isObject(body) ? body.data : undefined)) {
    const id = str(m.id);
    if (!usableId(id) || classifyModelId(id) !== "chat") continue;
    const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : undefined;
    if (outputs && !outputs.includes("text")) continue;
    const context = posInt(m.context_window) ?? posInt(m.context_length) ?? posInt(m.max_input_tokens);
    const fam = family?.(id) ?? claudeFamily(id);
    models.push({
      id,
      label: str(m.display_name) || str(m.name) || prettyModelId(id),
      ...(context ? { contextWindow: context } : {}),
      kind: "chat",
      ...(m.shutdown_date || m.deprecated === true ? { deprecated: true } : {}),
      ...(isoDate(m.created) ? { created: isoDate(m.created) } : {}),
      ...(fam ? { family: fam } : {}),
    });
  }
  return models;
}

/** Model Studio capabilities: text generation and reasoning chat; the others (embeddings, speech, images, video) do not. */
const QWEN_CHAT_CAPABILITIES = new Set(["TG", "Reasoning"]);

/** One page of Model Studio's GET /api/v1/models: the text generation models. */
export function parseQwenPage(body: unknown): { models: CatalogModel[]; total: number; pageSize: number } {
  const output = isObject(body) && isObject(body.output) ? body.output : {};
  const raw = arrayOf(output.models);
  const models: CatalogModel[] = [];
  for (const m of raw) {
    const id = str(m.model);
    const capabilities = Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === "string") : [];
    if (!usableId(id) || !capabilities.some((c) => QWEN_CHAT_CAPABILITIES.has(c)) || classifyModelId(id) !== "chat") continue;
    const info = isObject(m.model_info) ? m.model_info : {};
    const offline = isObject(m.inference_offline_info) ? str(m.inference_offline_info.offline_time) : "";
    const description = str(m.description);
    const major = id.match(/^qwen(\d+)/)?.[1];
    const context = posInt(info.context_window) ?? posInt(info.max_input_tokens);
    models.push({
      id,
      label: str(m.name) || prettyModelId(id),
      ...(description ? { description: shortText(description) } : {}),
      ...(context ? { contextWindow: context } : {}),
      kind: "chat",
      ...(offline ? { deprecated: true } : {}),
      ...(isoDate(m.published_time) ? { created: isoDate(m.published_time) } : {}),
      ...(major ? { family: `Qwen${major}` } : {}),
    });
  }
  return { models, total: typeof output.total === "number" ? output.total : raw.length, pageSize: raw.length };
}

const kimiFamily = (id: string): string | undefined => {
  const major = id.match(/^kimi-k(\d+)/)?.[1];
  return major ? `Kimi K${major}` : undefined;
};

// ---------- The built-in lists ----------

const GPT6_CONTEXT = 1_050_000;
const GEMINI_CONTEXT = 1_048_576;

/**
 * The engines' built-in lists, checked on OpenAI's and Google's model pages
 * on 2026-11-21: the models Codex supports (no -codex models are current), and
 * the Gemini 4 models with the Gemini 3 ones still offered.
 */
export const ENGINE_MODELS: Readonly<Record<EngineId, CatalogModel[]>> = {
  codex: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", description: "For demanding coding work", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", description: "For everyday coding work", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
    { id: "gpt-6-astra", label: "GPT-6 Astra", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
    { id: "gpt-6-luna", label: "GPT-6 Luna", contextWindow: GPT6_CONTEXT, kind: "chat", family: "GPT-6" },
  ],
  gemini: [
    { id: "gemini-4-carbon", label: "Gemini 4 Carbon", description: "Most capable reasoning, for complex software engineering", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 4" },
    { id: "gemini-4-neon", label: "Gemini 4 Neon", description: "Frontier intelligence, fast end-to-end tasks", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 4" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", description: "Efficient frontier reasoning", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 4" },
    { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", description: "Everyday coding and agentic work", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 4" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 3" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 3" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 3" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", contextWindow: GEMINI_CONTEXT, kind: "chat", family: "Gemini 3" },
  ],
};

const ENGINE_SOURCE: Record<EngineId, { vendor: string; label: string }> = {
  codex: { vendor: "OpenAI", label: "Codex" },
  gemini: { vendor: "Google", label: "Gemini CLI" },
};

/** A preset's built-in list as catalog models. */
export function presetModels(preset: AiPreset): CatalogModel[] {
  return preset.models.map((m) => {
    const family = claudeFamily(m.id);
    return { id: m.id, label: m.label, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), kind: "chat" as const, ...(family ? { family } : {}) };
  });
}

/** Why a provider's list is always the built-in one. */
const NO_LIVE_LIST: Partial<Record<AiProviderId, string>> = {
  bedrock: "Bedrock's model list needs AWS request signing, which this service does not do",
  vertex: "Vertex AI's model list needs a Google sign-in this service does not make",
  "google-cloud": "Claude on Google Cloud lists models only with a Google sign-in this service does not make",
  foundry: "Foundry runs the deployments you made, which it does not list for a key",
  zai: "Z.ai has no model list API",
};

/** Whose list it is, for "live from …". */
const providerSource = (preset: AiPreset): string =>
  preset.kind === "custom" ? "your endpoint" : preset.short === "Claude" ? "Anthropic" : preset.id === "google-ai" ? "Google" : preset.short;

/**
 * A compatible provider's live models, in the preset's own spelling where it
 * has the model (its "[1m]" ids, its labels): Claude Code reads "[1m]" as a
 * 1M-token window. A model the preset lacks gets "[1m]" when the provider
 * says its window is that big and the preset marks its own that way.
 */
export function withPresetSpelling(live: CatalogModel[], preset: AiPreset): CatalogModel[] {
  const marks = preset.models.some((m) => /\[1m\]$/i.test(m.id));
  const byBase = new Map<string, typeof preset.models>();
  for (const m of preset.models) {
    const base = m.id.replace(/\[1m\]$/i, "");
    byBase.set(base, [...(byBase.get(base) ?? []), m]);
  }
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  const push = (m: CatalogModel) => {
    if (!seen.has(m.id)) out.push(m);
    seen.add(m.id);
  };
  for (const m of live) {
    const own = byBase.get(m.id);
    if (own) for (const p of own) push({ ...m, id: p.id, label: p.label, ...(m.contextWindow || p.contextWindow ? { contextWindow: m.contextWindow ?? p.contextWindow } : {}) });
    else push(marks && (m.contextWindow ?? 0) >= MILLION ? { ...m, id: `${m.id}[1m]` } : m);
  }
  return out;
}

// ---------- Reading a list ----------

class ListError extends Error {}

interface ListContext {
  fetch: FetchLike;
  signal: AbortSignal;
}

/** The provider's error message from its error body, on one line, short. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message: string;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    message = typeof body.error === "string" ? body.error : String(body.error?.message ?? body.message ?? "");
  } catch {
    message = /^\s*</.test(text) ? "" : text;
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** The promise, or the signal's reason once it aborts: the deadline holds even for a fetch that ignores its signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function getJson(ctx: ListContext, url: string, headers: Record<string, string>, name: string): Promise<unknown> {
  const res = await untilAborted(ctx.fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctx.signal }), ctx.signal);
  if (!res.ok) {
    const detail = await errorDetail(res);
    const why = detail ? `: ${detail}` : "";
    if (res.status === 401 || res.status === 403) throw new ListError(`${name} refused the key (HTTP ${res.status})${why}`);
    if (res.status === 404) throw new ListError(`${name} has no model list at that address (HTTP 404)${why}`);
    if (res.status === 429) throw new ListError(`${name} is rate limiting the key (HTTP 429)`);
    throw new ListError(`${name} answered HTTP ${res.status}${why}`);
  }
  try {
    return await untilAborted(res.json() as Promise<unknown>, ctx.signal);
  } catch {
    throw new ListError(`${name} did not answer with JSON`);
  }
}

async function listAnthropicShaped(ctx: ListContext, base: string, headers: Record<string, string>, name: string, query = ""): Promise<{ models: CatalogModel[]; anthropic: boolean }> {
  const models: CatalogModel[] = [];
  let after: string | undefined;
  let anthropic = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = [query, after ? `after_id=${encodeURIComponent(after)}` : ""].filter(Boolean).join("&");
    const body = await getJson(ctx, `${base}/v1/models${params ? `?${params}` : ""}`, headers, name);
    const items = isObject(body) ? arrayOf(body.data) : [];
    // A gateway may answer in OpenAI's shape (no display_name, no has_more).
    if (items.some((m) => "display_name" in m) || (isObject(body) && "has_more" in body)) {
      anthropic = true;
      const parsed = parseAnthropicPage(body);
      models.push(...parsed.models);
      if (!parsed.hasMore || !parsed.lastId || parsed.lastId === after) break;
      after = parsed.lastId;
    } else {
      models.push(...parseCompatibleModels(body));
      break;
    }
  }
  return { models, anthropic };
}

type ProviderLister = (conn: ConnectionValues, preset: AiPreset, ctx: ListContext, env: NodeJS.ProcessEnv) => Promise<CatalogModel[]>;

const bearer = (token: string | undefined) => ({ authorization: `Bearer ${token ?? ""}` });

/** Gemini's models for a key, every page, newest first: Gemini CLI's and the Gemini provider's lists. */
async function listGemini(key: string, ctx: ListContext): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const parsed = parseGeminiPage(await getJson(ctx, url, { "x-goog-api-key": key }, "Google"));
    models.push(...parsed.models);
    if (!parsed.nextPageToken || parsed.nextPageToken === token) break;
    token = parsed.nextPageToken;
  }
  return newestFirst(models);
}

const PROVIDER_LISTERS: Partial<Record<AiProviderId, ProviderLister>> = {
  anthropic: async (conn, _preset, ctx) =>
    (await listAnthropicShaped(ctx, "https://api.anthropic.com", { "x-api-key": conn.secrets.apiKey ?? "", "anthropic-version": "2023-06-01" }, "Anthropic", "limit=1000")).models,
  deepseek: async (conn, preset, ctx) => withPresetSpelling(parseCompatibleModels(await getJson(ctx, "https://api.deepseek.com/models", bearer(conn.secrets.apiKey), "DeepSeek")), preset),
  kimi: async (conn, preset, ctx) => {
    const host = effectiveSettings(preset, conn.settings).region === "china" ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
    return withPresetSpelling(newestFirst(parseCompatibleModels(await getJson(ctx, `${host}/v1/models`, bearer(conn.secrets.apiKey), "Kimi"), kimiFamily)), preset);
  },
  qwen: async (conn, preset, ctx) => {
    const settings = effectiveSettings(preset, conn.settings);
    const host = settings.workspaceId ? `${settings.workspaceId}.${settings.region}.maas.aliyuncs.com` : QWEN_SHARED_HOSTS[settings.region ?? ""];
    if (!host) throw new ListError("that region needs your workspace ID");
    const models: CatalogModel[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const parsed = parseQwenPage(await getJson(ctx, `https://${host}/api/v1/models?page_no=${page}&page_size=100`, bearer(conn.secrets.apiKey), "Model Studio"));
      models.push(...parsed.models);
      if (parsed.pageSize < 100 || page * 100 >= parsed.total) break;
    }
    return withPresetSpelling(newestFirst(models), preset);
  },
  "google-ai": async (conn, _preset, ctx) => listGemini(conn.secrets.apiKey ?? "", ctx),
  custom: async (conn, preset, ctx) => {
    const settings = effectiveSettings(preset, conn.settings);
    const base = compatibleBaseUrl("custom", settings);
    if (!base) throw new ListError("the endpoint has no base URL");
    const token = conn.secrets.authToken ?? "";
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      ...(settings.authHeader === "x-api-key" ? { "x-api-key": token } : bearer(token)),
    };
    if (conn.secrets.headers) {
      const parsed = parseHeaderLines(conn.secrets.headers);
      if ("headers" in parsed) for (const [name, value] of parsed.headers) headers[name] = value;
    }
    return (await listAnthropicShaped(ctx, base, headers, "The endpoint")).models;
  },
};

type EngineLister = (key: string, ctx: ListContext) => Promise<CatalogModel[]>;

const ENGINE_LISTERS: Record<EngineId, EngineLister> = {
  codex: async (key, ctx) => parseOpenAiModels(await getJson(ctx, "https://api.openai.com/v1/models", bearer(key), "OpenAI")),
  gemini: listGemini,
};

/** A hash of what a list depends on (the credentials and the address), never the secrets themselves. */
export function credentialFingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

const sortedEntries = (record: Record<string, string>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** The models each provider and engine offers, live where possible, cached. See the file comment. */
export class ModelCatalog {
  private readonly entries = new Map<string, { until: number; list: ModelList }>();
  private readonly pending = new Map<string, Promise<ModelList>>();

  constructor(private readonly opts: CatalogOptions = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Forgets every list (tests; a new configuration). */
  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  /** An AI provider's models: live from it with the saved connection, else the preset's list and why. */
  async providerModels(config: Config, id: AiProviderId, o: { refresh?: boolean } = {}): Promise<ModelList> {
    const env = this.opts.env ?? process.env;
    const preset = presetFor(id);
    const source = providerSource(preset);
    const builtIn = (reason: string): ModelList => ({ models: presetModels(preset), live: false, reason, fetchedAt: new Date(this.now()).toISOString(), source });
    const lister = PROVIDER_LISTERS[id];
    if (!lister) return builtIn(`${NO_LIVE_LIST[id] ?? `${preset.name} has no model list`}: this is the built-in list.`);
    const conn = connectionOf(config, id);
    if (!conn) return builtIn(`${preset.name} is not connected yet: this is the built-in list.`);
    // As providerProblem: a saved Anthropic key is enough.
    const problem = id === "anthropic" ? undefined : connectionProblem(id, conn, env);
    if (problem) return builtIn(`${preset.name} cannot be used yet (${problem.replace(/\.$/, "")}): this is the built-in list.`);
    const settings = effectiveSettings(preset, conn.settings);
    const key = `provider:${id}:${credentialFingerprint([sortedEntries(conn.secrets), sortedEntries(settings)])}`;
    const redact = makeRedactor([...configSecrets(config), ...connectionSecretParts(conn.secrets)]);
    return this.cached(key, o.refresh, redact, builtIn, async (ctx) => lister(conn, preset, ctx, env), source, (ctx) => this.providerFetch(id, settings, env, ctx));
  }

  /** A coding engine's models: live from its vendor with the saved key, else the built-in list and why. */
  async engineModels(config: Config, id: EngineId, o: { refresh?: boolean } = {}): Promise<ModelList> {
    const { vendor, label } = ENGINE_SOURCE[id];
    const builtIn = (reason: string): ModelList => ({ models: ENGINE_MODELS[id].map((m) => ({ ...m })), live: false, reason, fetchedAt: new Date(this.now()).toISOString(), source: vendor });
    const apiKey = config.engines[id].apiKey;
    if (!apiKey) return builtIn(`Connect ${label} to list ${vendor}'s models for its key: this is the built-in list.`);
    const key = `engine:${id}:${credentialFingerprint(apiKey)}`;
    const redact = makeRedactor([...configSecrets(config), apiKey]);
    return this.cached(key, o.refresh, redact, builtIn, (ctx) => ENGINE_LISTERS[id](apiKey, ctx), vendor, () => this.guarded());
  }

  private guarded(): FetchLike {
    return guardedFetch({
      env: this.opts.env ?? process.env,
      timeoutMs: this.opts.timeoutMs ?? CATALOG_TIMEOUT_MS,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
    });
  }

  /** The guarded fetch; a custom endpoint on http://localhost only when ALLOW_PRIVATE_APP_URLS=1 (as its connection test). */
  private providerFetch(id: AiProviderId, settings: Record<string, string>, env: NodeJS.ProcessEnv, ctx: { signal: AbortSignal }): FetchLike {
    const base = id === "custom" ? compatibleBaseUrl("custom", settings) : undefined;
    if (base && new URL(base).protocol === "http:") {
      if (baseUrlProblem(base, env)) throw new ListError("the endpoint is not https://");
      const plain: FetchLike = this.opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
      return (input, init = {}) => plain(input, { ...init, redirect: "manual", signal: ctx.signal });
    }
    return this.guarded();
  }

  private async cached(
    key: string,
    refresh: boolean | undefined,
    redact: (text: string) => string,
    builtIn: (reason: string) => ModelList,
    read: (ctx: ListContext) => Promise<CatalogModel[]>,
    source: string,
    fetchFor: (ctx: { signal: AbortSignal }) => FetchLike,
  ): Promise<ModelList> {
    const hit = this.entries.get(key);
    if (!refresh && hit && hit.until > this.now()) return hit.list;
    const running = this.pending.get(key);
    if (running) return running;
    const job = (async () => {
      let list: ModelList;
      let ttl: number;
      try {
        const signal = AbortSignal.timeout(this.opts.timeoutMs ?? CATALOG_TIMEOUT_MS);
        const models = await read({ fetch: fetchFor({ signal }), signal });
        if (!models.length) throw new ListError(`${source} listed no chat models for this key`);
        list = { models, live: true, fetchedAt: new Date(this.now()).toISOString(), source };
        ttl = this.opts.ttlMs ?? CATALOG_TTL_MS;
      } catch (err) {
        const why = err instanceof ListError ? err.message : timedOut(err) ? `${source} did not answer within ${Math.max(1, Math.round((this.opts.timeoutMs ?? CATALOG_TIMEOUT_MS) / 1000))} s` : `${source} could not be reached (${err instanceof Error ? err.message : String(err)})`;
        const reason = redact(`Could not read the list live: ${why.replace(/\.$/, "")}. This is the built-in list.`).slice(0, 400);
        (this.opts.log ?? ((line: string) => console.warn(line)))(`[models] ${reason}`);
        list = builtIn(reason);
        ttl = this.opts.failureTtlMs ?? CATALOG_FAILURE_TTL_MS;
      }
      if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { until: this.now() + ttl, list });
      return list;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
}

/** The catalog the routes share. */
export const modelCatalog = new ModelCatalog();
