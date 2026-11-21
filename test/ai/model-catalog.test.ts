import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { presetFor } from "../../src/ai/ai-presets.js";
import {
  CATALOG_FAILURE_TTL_MS,
  CATALOG_TTL_MS,
  ENGINE_MODELS,
  ModelCatalog,
  type ModelList,
  classifyModelId,
  credentialFingerprint,
  parseAnthropicPage,
  parseCompatibleModels,
  parseGeminiPage,
  parseOpenAiModels,
  parseQwenPage,
  prettyModelId,
  withPresetSpelling,
} from "../../src/ai/model-catalog.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { createApp } from "../../src/server.js";

const ANTHROPIC_KEY = "sk-ant-catalog-test-key-0123456789";
const OPENAI_KEY = "sk-proj-catalog-test-key-0123456789";
const GEMINI_KEY = "AIzaCatalogTestKey0123456789abcdefghij";
const KIMI_KEY = "sk-kimi-catalog-0123456789";
const DEEPSEEK_KEY = "sk-deepseek-catalog-0123456789";
const QWEN_KEY = "sk-qwen-catalog-0123456789";
const GATEWAY_TOKEN = "gw-token-catalog-0123456789";
const HEADER_SECRET = "gw-header-secret-0123456789";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch that answers by URL, recording each call (URL and headers). */
function fakeFetch(reply: (url: URL, headers: Headers) => Response | Promise<Response>) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    return reply(url, headers);
  };
  return { fetch, calls };
}

const config = (c: Record<string, unknown> = {}): Config => ConfigSchema.parse(c);
const withAnthropic = () => config({ anthropic: { apiKey: ANTHROPIC_KEY, model: "" } });
const ids = (list: ModelList) => list.models.map((m) => m.id);

/** A catalog with a fake fetch and a clock the test moves, logging into `logs`. */
function catalogWith(reply: Parameters<typeof fakeFetch>[0], extra: ConstructorParameters<typeof ModelCatalog>[0] = {}) {
  const f = fakeFetch(reply);
  const logs: string[] = [];
  let now = Date.parse("2026-11-21T10:00:00Z");
  const catalog = new ModelCatalog({ fetch: f.fetch, now: () => now, log: (line) => logs.push(line), ...extra });
  return { catalog, calls: f.calls, logs, advance: (ms: number) => (now += ms) };
}

// ---------- Parsing each provider's answer ----------

describe("the providers' model lists, parsed", () => {
  it("reads Anthropic's pages: display names without 'Claude', context windows, lines, deprecated and retired models", () => {
    const page = parseAnthropicPage({
      data: [
        { type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1_000_000, line: "fable" },
        { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "1970-01-01T00:00:00Z", max_input_tokens: 1_000_000 },
        { type: "model", id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", lifecycle: "deprecated" },
        { type: "model", id: "claude-opus-4-1-20250805", display_name: "Claude Opus 4.1", lifecycle: "retired" },
        { type: "model", id: "has a space", display_name: "Broken" },
      ],
      has_more: true,
      last_id: "claude-sonnet-4-5-20250929",
    });
    expect(page.hasMore).toBe(true);
    expect(page.lastId).toBe("claude-sonnet-4-5-20250929");
    expect(page.models).toEqual([
      { id: "claude-fable-5-2", label: "Fable 5.2", contextWindow: 1_000_000, kind: "chat", created: "2026-10-01T00:00:00.000Z", family: "Fable" },
      // The epoch means "unknown"; the family comes from the id without a line.
      { id: "claude-opus-5-5", label: "Opus 5.5", contextWindow: 1_000_000, kind: "chat", family: "Opus" },
      { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", kind: "chat", deprecated: true, family: "Sonnet" },
    ]);
    expect(parseAnthropicPage("nonsense")).toEqual({ models: [], hasMore: false });
  });

  it("keeps OpenAI's GPT, o-series and Codex models, newest first, and leaves out embeddings, speech, images, search and completions", () => {
    const models = parseOpenAiModels({
      object: "list",
      data: [
        { id: "gpt-6.1-sol", created: 1_780_000_000 },
        { id: "gpt-6.2-astra", created: 1_790_000_000 },
        { id: "gpt-6.2-astra-2026-10-01", created: 1_790_000_000 },
        { id: "gpt-5.3-codex", created: 1_760_000_000, shutdown_date: "2027-04-01" },
        { id: "o4-mini", created: 1_740_000_000 },
        { id: "codex-mini-latest", created: 1_740_000_000 },
        ...["text-embedding-3-large", "tts-1", "gpt-4o-mini-tts", "whisper-1", "gpt-image-1", "dall-e-3", "gpt-realtime", "gpt-audio", "gpt-4o-transcribe"].map((id) => ({ id })),
        ...["gpt-4o-search-preview", "gpt-3.5-turbo-instruct", "gpt-3.5-turbo", "omni-moderation-latest", "babbage-002", "sora-2", "computer-use-preview"].map((id) => ({ id })),
      ],
    });
    expect(models.map((m) => [m.id, m.label, m.family])).toEqual([
      ["gpt-6.2-astra", "GPT-6.2 Astra", "GPT-6"],
      ["gpt-6.2-astra-2026-10-01", "GPT-6.2 Astra (2026-10-01)", "GPT-6"],
      ["gpt-6.1-sol", "GPT-6.1 Sol", "GPT-6"],
      ["gpt-5.3-codex", "GPT-5.3 Codex", "GPT-5"],
      ["o4-mini", "o4 Mini", "o-series"],
      ["codex-mini-latest", "Codex Mini Latest", "Codex"],
    ]);
    expect(models.find((m) => m.id === "gpt-5.3-codex")!.deprecated).toBe(true);
    expect(models[0]!.created).toBe("2026-09-21T14:13:20.000Z");
  });

  it("reads Gemini's pages: the models that generate content, by their names without models/, with Google's names and limits", () => {
    const page = parseGeminiPage({
      models: [
        { name: "models/gemini-4-carbon", displayName: "Gemini 4 Carbon", description: "Our most capable reasoning model. Built for complex software engineering.", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent", "countTokens"] },
        { name: "models/gemini-4-neon", displayName: "Gemini 4 Neon", inputTokenLimit: 1_048_576, supported_actions: ["generateContent"] },
        { name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-4.0-generate-001", displayName: "Imagen 4", supportedGenerationMethods: ["predict"] },
        { name: "models/gemini-2.5-flash-image", displayName: "Nano Banana", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
        { name: "models/aqa", displayName: "AQA", supportedGenerationMethods: ["generateAnswer", "generateContent"] },
        { name: "models/gemma-3-27b-it", displayName: "Gemma 3 27B", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", description: "Deprecated: moves to Gemini 3.8 Flash.", supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "page-2",
    });
    expect(page.nextPageToken).toBe("page-2");
    expect(page.models.map((m) => [m.id, m.label, m.family, m.contextWindow])).toEqual([
      ["gemini-4-carbon", "Gemini 4 Carbon", "Gemini 4", 1_048_576],
      ["gemini-4-neon", "Gemini 4 Neon", "Gemini 4", 1_048_576],
      ["gemma-3-27b-it", "Gemma 3 27B", "Gemma", undefined],
      ["gemini-2.5-pro", "Gemini 2.5 Pro", "Gemini 2", undefined],
    ]);
    // The first sentence of Google's description.
    expect(page.models[0]!.description).toBe("Our most capable reasoning model.");
    expect(page.models.at(-1)!.deprecated).toBe(true);
  });

  it("reads OpenAI-style lists (DeepSeek, Kimi, gateways): names, context windows, text models only", () => {
    const models = parseCompatibleModels({
      object: "list",
      data: [
        { id: "deepseek-flash", object: "model", name: "DeepSeek-V4.1-Flash", context_window: 1_048_576, output_modalities: ["text"] },
        { id: "kimi-k3.1-pro", object: "model", created: 1_790_000_000, context_length: 1_048_576 },
        { id: "some-image-model", output_modalities: ["image"] },
        { id: "bge-embedding-m3" },
      ],
    });
    expect(models).toEqual([
      { id: "deepseek-flash", label: "DeepSeek-V4.1-Flash", contextWindow: 1_048_576, kind: "chat" },
      { id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", contextWindow: 1_048_576, kind: "chat", created: "2026-09-21T14:13:20.000Z" },
    ]);
  });

  it("reads Model Studio's pages: text generation models only, with their names, windows and release dates", () => {
    const page = parseQwenPage({
      output: {
        total: 4,
        page_no: 1,
        page_size: 100,
        models: [
          { model: "qwen4-max", name: "Qwen4-Max", capabilities: ["TG", "Reasoning"], model_info: { context_window: 1_000_000 }, published_time: "2026-11-01 08:00:00" },
          { model: "qwen3.8-flash", name: "Qwen3.8-Flash", capabilities: ["TG"], model_info: { max_input_tokens: 983_616 }, inference_offline_info: { offline_time: "2027-01-01" } },
          { model: "text-embedding-v4", name: "Embedding", capabilities: ["TR"] },
          { model: "qwen-tts-latest", name: "TTS", capabilities: ["TTS"] },
        ],
      },
    });
    expect(page.total).toBe(4);
    expect(page.models.map((m) => [m.id, m.label, m.contextWindow, m.family, m.deprecated ?? false])).toEqual([
      ["qwen4-max", "Qwen4-Max", 1_000_000, "Qwen4", false],
      ["qwen3.8-flash", "Qwen3.8-Flash", 983_616, "Qwen3", true],
    ]);
    expect(page.models[0]!.created).toMatch(/^2026-11-01T/);
  });

  it("names and sorts what the providers leave unnamed", () => {
    expect(prettyModelId("gpt-6.2-astra")).toBe("GPT-6.2 Astra");
    expect(prettyModelId("kimi-k3.1-pro-highspeed")).toBe("Kimi K3.1 Pro Highspeed");
    expect(prettyModelId("o3")).toBe("o3");
    expect(classifyModelId("gemini-2.0-flash-live-001")).toBe("audio");
    expect(classifyModelId("deepseek-v4-flash-vision-exp")).toBe("chat");
    expect(classifyModelId("llama-guard-4")).toBe("moderation");
    expect(classifyModelId("claude-opus-5-5")).toBe("chat");
  });

  it("spells a compatible provider's models as its preset does, with Claude Code's [1m] marker where the window is that big", () => {
    const deepseek = presetFor("deepseek");
    const spelled = withPresetSpelling(
      [
        { id: "deepseek-flash", label: "DeepSeek-V4.1-Flash", contextWindow: 1_048_576 },
        { id: "deepseek-v5-preview", label: "DeepSeek V5 Preview", contextWindow: 2_000_000 },
        { id: "deepseek-small", label: "Small", contextWindow: 128_000 },
      ],
      deepseek,
    );
    expect(spelled.map((m) => [m.id, m.label])).toEqual([
      ["deepseek-flash[1m]", "DeepSeek Flash"],
      ["deepseek-flash", "DeepSeek Flash (background)"],
      ["deepseek-v5-preview[1m]", "DeepSeek V5 Preview"],
      ["deepseek-small", "Small"],
    ]);
    // Qwen's preset has no [1m] ids: none are added.
    expect(withPresetSpelling([{ id: "qwen4-max", label: "Qwen4-Max", contextWindow: 1_000_000 }], presetFor("qwen")).map((m) => m.id)).toEqual(["qwen4-max"]);
  });
});

// ---------- Reading lists live, the cache and the fallbacks ----------

describe("the model catalog", () => {
  it("lists Anthropic's models across pages, with the saved key in the header", async () => {
    const { catalog, calls } = catalogWith((url) =>
      url.searchParams.get("after_id")
        ? json({ data: [{ type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 1_000_000 }], has_more: false, last_id: "claude-haiku-5-5" })
        : json({ data: [{ type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2" }], has_more: true, last_id: "claude-fable-5-2" }),
    );
    const list = await catalog.providerModels(withAnthropic(), "anthropic");
    expect(list).toMatchObject({ live: true, source: "Anthropic", fetchedAt: "2026-11-21T10:00:00.000Z" });
    expect(list.reason).toBeUndefined();
    expect(ids(list)).toEqual(["claude-fable-5-2", "claude-haiku-5-5"]);
    expect(calls.map((c) => `${c.url.origin}${c.url.pathname}?${c.url.searchParams}`)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-fable-5-2",
    ]);
    expect(calls[0]!.headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("lists Gemini's models across pages with the key in a header, never in the URL", async () => {
    const { catalog, calls } = catalogWith((url) =>
      url.searchParams.get("pageToken")
        ? json({ models: [{ name: "models/gemini-4-neon", displayName: "Gemini 4 Neon", supportedGenerationMethods: ["generateContent"] }] })
        : json({ models: [{ name: "models/gemini-4-carbon", displayName: "Gemini 4 Carbon", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" }),
    );
    const list = await catalog.engineModels(config({ engines: { gemini: { apiKey: GEMINI_KEY, model: "" } } }), "gemini");
    expect(list).toMatchObject({ live: true, source: "Google" });
    expect(ids(list)).toEqual(["gemini-4-carbon", "gemini-4-neon"]);
    expect(calls.map((c) => c.url.searchParams.toString())).toEqual(["pageSize=1000", "pageSize=1000&pageToken=next"]);
    expect(calls.every((c) => !c.url.toString().includes(GEMINI_KEY) && c.headers.get("x-goog-api-key") === GEMINI_KEY)).toBe(true);
  });

  it("lists DeepSeek, Kimi (by platform) and Qwen (by workspace or region) with their saved keys", async () => {
    const { catalog, calls } = catalogWith((url) => {
      if (url.hostname === "api.deepseek.com") return json({ data: [{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", context_window: 1_048_576 }] });
      if (url.hostname.startsWith("api.moonshot")) return json({ data: [{ id: "kimi-k3", context_length: 1_048_576 }, { id: "kimi-k3.1-pro", context_length: 1_048_576 }] });
      return json({ output: { total: 1, models: [{ model: "qwen4-max", name: "Qwen4-Max", capabilities: ["TG"], model_info: { context_window: 1_000_000 } }] } });
    });
    const c = config({
      ai: {
        providers: {
          deepseek: { secrets: { apiKey: DEEPSEEK_KEY } },
          kimi: { secrets: { apiKey: KIMI_KEY }, settings: { region: "china" } },
          qwen: { secrets: { apiKey: QWEN_KEY }, settings: { region: "eu-central-1", workspaceId: "ws-team" } },
        },
      },
    });
    expect(ids(await catalog.providerModels(c, "deepseek"))).toEqual(["deepseek-v4-pro[1m]"]);
    // Newest first, in the preset's spelling.
    expect(ids(await catalog.providerModels(c, "kimi"))).toEqual(["kimi-k3.1-pro[1m]", "kimi-k3[1m]"]);
    expect(ids(await catalog.providerModels(c, "qwen"))).toEqual(["qwen4-max"]);
    expect(calls.map((x) => `${x.url.origin}${x.url.pathname}`)).toEqual([
      "https://api.deepseek.com/models",
      "https://api.moonshot.cn/v1/models",
      "https://ws-team.eu-central-1.maas.aliyuncs.com/api/v1/models",
    ]);
    expect(calls.map((x) => x.headers.get("authorization"))).toEqual([`Bearer ${DEEPSEEK_KEY}`, `Bearer ${KIMI_KEY}`, `Bearer ${QWEN_KEY}`]);
    expect(calls[2]!.url.searchParams.toString()).toBe("page_no=1&page_size=100");
  });

  it("lists a custom endpoint's /v1/models with its token and extra headers, in Anthropic's shape or OpenAI's", async () => {
    let shape: "anthropic" | "openai" = "anthropic";
    const { catalog, calls } = catalogWith(() =>
      shape === "anthropic"
        ? json({ data: [{ type: "model", id: "anthropic/claude-opus-5-5", display_name: "Claude Opus 5.5" }], has_more: false })
        : json({ object: "list", data: [{ id: "openrouter/some-model" }] }),
    );
    const c = config({
      ai: {
        providers: {
          custom: {
            secrets: { authToken: GATEWAY_TOKEN, headers: `cf-aig-authorization: Bearer ${HEADER_SECRET}` },
            settings: { baseUrl: "https://gateway.example.com/claude-code/" },
          },
        },
      },
    });
    const list = await catalog.providerModels(c, "custom");
    expect(list).toMatchObject({ live: true, source: "your endpoint", models: [{ id: "anthropic/claude-opus-5-5", label: "Opus 5.5", family: "Opus" }] });
    expect(calls[0]!.url.toString()).toBe("https://gateway.example.com/claude-code/v1/models");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(calls[0]!.headers.get("cf-aig-authorization")).toBe(`Bearer ${HEADER_SECRET}`);
    shape = "openai";
    expect(ids(await catalog.providerModels(c, "custom", { refresh: true }))).toEqual(["openrouter/some-model"]);
  });

  it("sends a custom endpoint's request through the network guard: a public name on a private address is refused", async () => {
    const { catalog, calls, logs } = catalogWith(() => json({ data: [] }), { env: { NODE_ENV: "production" }, lookup: async () => ["10.0.0.7"] });
    const c = config({ ai: { providers: { custom: { secrets: { authToken: GATEWAY_TOKEN }, settings: { baseUrl: "https://gateway.example.com" } } } } });
    const list = await catalog.providerModels(c, "custom");
    expect(list.live).toBe(false);
    expect(list.reason).toContain("private network");
    expect(calls).toEqual([]);
    expect(logs.join()).not.toContain(GATEWAY_TOKEN);
  });

  it("keeps the built-in list, and says why, for providers it cannot list or that are not connected", async () => {
    const { catalog, calls } = catalogWith(() => json({}));
    const empty = config({
      ai: {
        providers: {
          bedrock: { secrets: { apiKey: "bedrock-api-key-0123456789" }, settings: { region: "us-east-1" } },
          zai: { secrets: { apiKey: "zai-api-key-0123456789" } },
        },
      },
    });
    const notConnected = await catalog.providerModels(empty, "anthropic");
    expect(notConnected).toMatchObject({ live: false, source: "Anthropic", reason: "Anthropic is not connected yet: this is the built-in list." });
    expect(ids(notConnected).slice(0, 4)).toEqual(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    const bedrock = await catalog.providerModels(empty, "bedrock");
    expect(bedrock).toMatchObject({ live: false, reason: expect.stringContaining("AWS request signing") });
    expect(ids(bedrock)).toContain("us.anthropic.claude-sonnet-5-5");
    expect((await catalog.providerModels(empty, "zai")).reason).toContain("no model list API");
    expect((await catalog.providerModels(empty, "vertex")).live).toBe(false);
    // Saved but incomplete: Qwen in a region that needs a workspace.
    const qwen = await catalog.providerModels(config({ ai: { providers: { qwen: { secrets: { apiKey: QWEN_KEY }, settings: { region: "us-east-1" } } } } }), "qwen");
    expect(qwen).toMatchObject({ live: false, reason: expect.stringContaining("needs your workspace ID") });
    const codex = await catalog.engineModels(empty, "codex");
    expect(codex).toMatchObject({ live: false, source: "OpenAI", reason: expect.stringContaining("Connect Codex") });
    expect(codex.models).toEqual(ENGINE_MODELS.codex);
    expect(ids(await catalog.engineModels(empty, "gemini"))).toEqual(expect.arrayContaining(["gemini-4-carbon", "gemini-4-neon", "gemini-4-argon"]));
    expect(calls).toEqual([]);
  });

  it("falls back to the built-in list when the call fails, with the reason, never the key, in the answer and the log", async () => {
    const { catalog, logs } = catalogWith(() => json({ error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC_KEY}` } }, 401));
    const list = await catalog.providerModels(withAnthropic(), "anthropic");
    expect(list.live).toBe(false);
    expect(list.reason).toBe("Could not read the list live: Anthropic refused the key (HTTP 401): invalid x-api-key [redacted]. This is the built-in list.");
    expect(ids(list)).toContain("claude-opus-5-5");
    expect(logs).toEqual([`[models] ${list.reason}`]);
    expect(JSON.stringify(list) + logs.join()).not.toContain(ANTHROPIC_KEY);

    // Every secret the configuration holds is redacted, not only this provider's.
    const other = catalogWith(() => json({ error: `upstream said ${OPENAI_KEY}` }, 500));
    const c = config({ anthropic: { apiKey: ANTHROPIC_KEY, model: "" }, engines: { codex: { apiKey: OPENAI_KEY, model: "" } } });
    const failed = await other.catalog.providerModels(c, "anthropic");
    expect(failed.reason).toContain("Anthropic answered HTTP 500: upstream said [redacted]");
    expect(JSON.stringify(failed) + other.logs.join()).not.toContain(OPENAI_KEY);
  });

  it("gives up after its timeout, and says so", async () => {
    const { catalog } = catalogWith(() => new Promise<Response>(() => undefined), { timeoutMs: 50 });
    // The fake never answers; the guard's own timeout aborts the request.
    const list = await catalog.engineModels(config({ engines: { gemini: { apiKey: GEMINI_KEY, model: "" } } }), "gemini");
    expect(list).toMatchObject({ live: false, reason: "Could not read the list live: Google did not answer within 1 s. This is the built-in list." });
  });

  it("keeps a live list for an hour per credential, a failed one for a few minutes, and reads again on refresh", async () => {
    let status = 200;
    const { catalog, calls, advance } = catalogWith(() => (status === 200 ? json({ object: "list", data: [{ id: "gpt-6.2-sol" }] }) : json({}, status)));
    const c = config({ engines: { codex: { apiKey: OPENAI_KEY, model: "" } } });
    const first = await catalog.engineModels(c, "codex");
    expect(first.live).toBe(true);
    // Two pickers opening at once share one call; later calls within the hour make none.
    await Promise.all([catalog.engineModels(c, "codex"), catalog.engineModels(c, "codex")]);
    advance(CATALOG_TTL_MS - 1000);
    expect(await catalog.engineModels(c, "codex")).toBe(first);
    expect(calls).toHaveLength(1);
    // A refresh reads it again.
    await catalog.engineModels(c, "codex", { refresh: true });
    expect(calls).toHaveLength(2);
    // Another key is another list.
    await catalog.engineModels(config({ engines: { codex: { apiKey: `${OPENAI_KEY}-other`, model: "" } } }), "codex");
    expect(calls).toHaveLength(3);
    // After the hour, read again; a failure is kept for a few minutes only.
    advance(CATALOG_TTL_MS + 1);
    status = 503;
    expect((await catalog.engineModels(c, "codex")).live).toBe(false);
    expect(calls).toHaveLength(4);
    await catalog.engineModels(c, "codex");
    expect(calls).toHaveLength(4);
    advance(CATALOG_FAILURE_TTL_MS + 1);
    status = 200;
    expect((await catalog.engineModels(c, "codex")).live).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("keys the cache by a fingerprint of the credentials, never the secret", async () => {
    const { catalog } = catalogWith(() => json({ object: "list", data: [{ id: "gpt-6.2-sol" }] }));
    await catalog.engineModels(config({ engines: { codex: { apiKey: OPENAI_KEY, model: "" } } }), "codex");
    await catalog.providerModels(withAnthropic(), "anthropic");
    const keys = [...(catalog as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.join()).not.toContain(OPENAI_KEY);
    expect(keys.join()).not.toContain(ANTHROPIC_KEY);
    expect(credentialFingerprint(OPENAI_KEY)).toMatch(/^[0-9a-f]{24}$/);
    expect(credentialFingerprint(OPENAI_KEY)).not.toBe(credentialFingerprint(`${OPENAI_KEY}x`));
  });
});

// ---------- The route ----------

describe("GET /api/ai/providers/:id/models", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-models-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await fetch(`${base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: "setup-123", password: "longpassword1" }) });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => close());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only and knows only its providers", async () => {
    expect((await get("/api/ai/providers/anthropic/models", false)).status).toBe(401);
    expect((await get("/api/ai/providers/openai/models")).status).toBe(404);
  });

  it("answers the built-in list until a provider is connected, then its live list, again on refresh, never with the key", async () => {
    const before = (await (await get("/api/ai/providers/kimi/models")).json()) as ModelList;
    expect(before).toMatchObject({ live: false, source: "Kimi", reason: "Kimi (Moonshot) is not connected yet: this is the built-in list." });
    expect(before.models.map((m) => m.id)).toEqual(presetFor("kimi").models.map((m) => m.id));

    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "127.0.0.1") return realFetch(input, init);
      calls.push(url.toString());
      return json({ object: "list", data: [{ id: "kimi-k3.1-pro", context_length: 1_048_576 }, { id: "kimi-k4-preview", context_length: 2_097_152 }] });
    });
    process.env.SKIP_VALIDATION = "1";
    expect((await post("/api/ai/providers/kimi", { secrets: { apiKey: KIMI_KEY } })).status).toBe(200);

    const live = (await (await get("/api/ai/providers/kimi/models")).json()) as ModelList;
    expect(live).toMatchObject({ live: true, source: "Kimi" });
    expect(live.models.map((m) => [m.id, m.label])).toEqual([
      ["kimi-k4-preview[1m]", "Kimi K4 Preview"],
      ["kimi-k3.1-pro[1m]", "Kimi K3.1 Pro"],
    ]);
    expect(JSON.stringify(live)).not.toContain(KIMI_KEY);
    expect(calls).toEqual(["https://api.moonshot.ai/v1/models"]);
    await get("/api/ai/providers/kimi/models");
    expect(calls).toHaveLength(1);
    await get("/api/ai/providers/kimi/models?refresh=1");
    expect(calls).toHaveLength(2);
    // The providers list still answers as before.
    expect((await get("/api/ai/providers")).status).toBe(200);
  });
});
