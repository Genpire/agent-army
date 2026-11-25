import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_PRESETS } from "../../src/ai/ai-presets.js";
import {
  type ConnectionValues,
  GEMINI_BRIDGE_NOT_STARTED,
  anthropicRuntime,
  buildRuntime,
  configuredModel,
  connectionProblem,
  fitContentBlocks,
  modelFamily,
  nearestEffort,
  parseHeaderLines,
  presetFamily,
  providerRuntime,
  redactConnection,
  secretParts,
  testConnection,
} from "../../src/ai/ai-providers.js";
import { AI_PROVIDER_IDS, type AiProviderId, type Config, ConfigSchema, isChatReady, isReady, publicView } from "../../src/core/config.js";
import type { QueryFn } from "../../src/chat/pointer.js";
import { createApp } from "../../src/server.js";
import { estimateTaskSize } from "../../src/tasks/sizing.js";
import { buildRepoAgents } from "../../src/team/team.js";
import { applyChanges } from "../../src/routes/ai.js";
import { configSecrets, makeRedactor, onboardingError, teamQueryOptions } from "../../src/tasks/worker.js";

// ---------- Fixtures: one complete connection per provider, each with its own secrets ----------

// Fake service account files: the shape Google's look like, no real key material.
const SA_KEY = JSON.stringify({ type: "service_account", project_id: "acme-ai", private_key: "fake-vertex-private-part-for-tests" });
const GC_KEY = JSON.stringify({ type: "service_account", project_id: "acme-gc", private_key: "fake-google-cloud-private-part-for-tests" });

const CONNECTIONS: Record<AiProviderId, ConnectionValues> = {
  anthropic: { secrets: { apiKey: "sk-ant-anthropic-secret-0001" }, settings: {}, models: {} },
  bedrock: { secrets: { apiKey: "bedrock-api-key-secret-0002" }, settings: { region: "eu-west-1" }, models: {} },
  vertex: { secrets: { credentialsJson: SA_KEY }, settings: { projectId: "acme-ai", region: "global" }, models: {} },
  "google-cloud": { secrets: { credentialsJson: GC_KEY }, settings: { projectId: "acme-gc", workspaceId: "wrkspc_abc123" }, models: {} },
  foundry: { secrets: { apiKey: "foundry-key-secret-0005" }, settings: { resource: "acme-foundry" }, models: {} },
  deepseek: { secrets: { apiKey: "sk-deepseek-secret-0006" }, settings: {}, models: {} },
  qwen: { secrets: { apiKey: "sk-qwen-secret-0007" }, settings: { region: "ap-southeast-1", workspaceId: "ws-acme" }, models: {} },
  kimi: { secrets: { apiKey: "sk-kimi-secret-0008" }, settings: {}, models: {} },
  zai: { secrets: { apiKey: "zai-key-secret-0009" }, settings: { region: "china" }, models: {} },
  "google-ai": { secrets: { apiKey: "AQ.Ab8-google-ai-secret-0012" }, settings: {}, models: {} },
  custom: {
    secrets: { authToken: "gateway-token-secret-0010", headers: "cf-aig-authorization: Bearer cf-header-secret-0011" },
    settings: { baseUrl: "https://gateway.example.com/anthropic" },
    models: { main: "anthropic/claude-sonnet-5" },
  },
};

const allSecrets = (except?: AiProviderId) =>
  Object.entries(CONNECTIONS)
    .filter(([id]) => id !== except)
    .flatMap(([, c]) => Object.values(c.secrets));

const THIRD_PARTY = AI_PROVIDER_IDS.filter((id) => id !== "anthropic");

/** A config with every provider connected; chat and tasks on `chat` and `task`. */
function fullConfig(chat: AiProviderId = "anthropic", task: AiProviderId = chat): Config {
  const c = ConfigSchema.parse({});
  c.anthropic.apiKey = CONNECTIONS.anthropic.secrets.apiKey;
  for (const id of THIRD_PARTY) c.ai.providers[id] = { ...CONNECTIONS[id], checkedAt: "2026-11-20T00:00:00.000Z" };
  c.ai.chatProvider = chat;
  c.ai.taskProvider = task;
  return c;
}

const result = (fields: Record<string, unknown> = {}): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "OK", total_cost_usd: 0.001, num_turns: 1, ...fields }) as unknown as SDKMessage;

function fakeQuery(messages: SDKMessage[], onCall?: (options: Options) => Promise<void> | void) {
  const calls: Options[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params.options ?? {});
    return (async function* () {
      await onCall?.(params.options ?? {});
      yield* messages;
    })();
  };
  return { queryFn, calls };
}

// ---------- The runtime ----------

describe("provider presets", () => {
  it("cover every provider id, with complete data", () => {
    expect(AI_PRESETS.map((p) => p.id).sort()).toEqual([...AI_PROVIDER_IDS].sort());
    for (const p of AI_PRESETS) {
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(p.fields.length).toBeGreaterThan(0);
      for (const f of p.fields) expect(f.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/);
      // Every preset that serves non-Claude models says so; the Claude ones do not.
      expect(p.bestEffort).toBe(["deepseek", "qwen", "kimi", "zai", "google-ai", "custom"].includes(p.id));
    }
  });
});

describe("provider environments", () => {
  it("never contain another provider's key, nor anything from the process environment", () => {
    for (const id of AI_PROVIDER_IDS) {
      const { env } = buildRuntime(id, CONNECTIONS[id]);
      const values = Object.values(env).join("\n");
      for (const secret of allSecrets(id)) expect(values, `${id} env has another provider's secret`).not.toContain(secret);
      expect(Object.keys(env)).not.toContain("MASTER_KEY");
      expect(Object.keys(env)).not.toContain("PATH");
    }
  });

  it("set ANTHROPIC_API_KEY to empty for every third-party provider", () => {
    for (const id of THIRD_PARTY) {
      const { env } = buildRuntime(id, CONNECTIONS[id]);
      expect(env.ANTHROPIC_API_KEY, id).toBe("");
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, id).toBe("1");
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, id).toBe("1");
    }
    // A gateway that reads x-api-key gets its own token there, never Anthropic's.
    const xApiKey = buildRuntime("custom", { ...CONNECTIONS.custom, settings: { ...CONNECTIONS.custom.settings, authHeader: "x-api-key" } }).env;
    expect(xApiKey.ANTHROPIC_API_KEY).toBe("gateway-token-secret-0010");
    expect(xApiKey.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("keep Anthropic as before: the key, with settings files unable to redirect it", () => {
    // The key, and settings files in a repository may not redirect the endpoint or the key.
    expect(buildRuntime("anthropic", CONNECTIONS.anthropic).env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-anthropic-secret-0001",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    });
    const r = anthropicRuntime("sk-ant-x-123456789");
    expect(r.model("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(r.model("")).toBeUndefined();
    expect(r.effort("xhigh")).toBe("xhigh");
    expect(r.disallowedTools).toEqual([]);
    expect(r.managedSettings).toBeUndefined();
  });

  it("set each provider's endpoint and credentials", () => {
    expect(buildRuntime("deepseek", CONNECTIONS.deepseek).env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-deepseek-secret-0006",
      CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1",
    });
    expect(buildRuntime("kimi", CONNECTIONS.kimi).env.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic");
    expect(buildRuntime("zai", CONNECTIONS.zai).env.ANTHROPIC_BASE_URL).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(buildRuntime("qwen", CONNECTIONS.qwen).env.ANTHROPIC_BASE_URL).toBe("https://ws-acme.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
    expect(buildRuntime("qwen", { ...CONNECTIONS.qwen, settings: { region: "ap-southeast-1" } }).env.ANTHROPIC_BASE_URL).toBe(
      "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    );
    expect(buildRuntime("bedrock", CONNECTIONS.bedrock).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-secret-0002" });
    const keys = buildRuntime("bedrock", { secrets: { accessKeyId: "AKIAEXAMPLE123456", secretAccessKey: "aws-secret-access-key-0003" }, settings: {}, models: {} }).env;
    expect(keys).toMatchObject({ AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE123456", AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-0003" });
    expect(keys.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(buildRuntime("vertex", CONNECTIONS.vertex).env).toMatchObject({ CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global", ANTHROPIC_VERTEX_PROJECT_ID: "acme-ai" });
    expect(buildRuntime("google-cloud", CONNECTIONS["google-cloud"]).env).toMatchObject({
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1",
      ANTHROPIC_GOOGLE_CLOUD_PROJECT: "acme-gc",
      ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID: "wrkspc_abc123",
      ANTHROPIC_GOOGLE_CLOUD_LOCATION: "global",
    });
    expect(buildRuntime("foundry", CONNECTIONS.foundry).env).toMatchObject({ CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "acme-foundry", ANTHROPIC_FOUNDRY_API_KEY: "foundry-key-secret-0005" });
    expect(buildRuntime("custom", CONNECTIONS.custom).env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "gateway-token-secret-0010",
      ANTHROPIC_CUSTOM_HEADERS: "cf-aig-authorization: Bearer cf-header-secret-0011",
    });
    // Credentials in a file are not in the plain environment: only a session writes them.
    expect(buildRuntime("vertex", CONNECTIONS.vertex).env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it("map every tier, the preset's defaults first and the owner's choices over them", () => {
    expect(buildRuntime("deepseek", CONNECTIONS.deepseek).env).toMatchObject({
      ANTHROPIC_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
    });
    const chosen = buildRuntime("kimi", { ...CONNECTIONS.kimi, models: { opus: "kimi-k3.1-pro[1m]", haiku: "kimi-k3.1-pro-highspeed[1m]" } }).env;
    expect(chosen).toMatchObject({
      ANTHROPIC_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3.1-pro[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3.1-pro[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3.1-pro-highspeed[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3[1m]",
    });
    // A custom endpoint maps only the tiers typed in.
    const custom = buildRuntime("custom", CONNECTIONS.custom).env;
    expect(custom.ANTHROPIC_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(custom.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    for (const id of THIRD_PARTY.filter((i) => i !== "custom")) {
      const env = buildRuntime(id, CONNECTIONS[id]).env;
      for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
        expect(env[name], `${id} ${name}`).toBeTruthy();
      }
    }
  });

  it("map Claude model ids and aliases onto the tier aliases, and pass the provider's own ids through", () => {
    const kimi = buildRuntime("kimi", CONNECTIONS.kimi);
    expect(kimi.model("claude-opus-5-5")).toBe("opus");
    expect(kimi.model("claude-sonnet-5-5")).toBe("sonnet");
    expect(kimi.model("claude-haiku-5-5")).toBe("haiku");
    expect(kimi.model("claude-fable-5-2")).toBe("fable");
    expect(kimi.model("opus")).toBe("opus");
    expect(kimi.model("sonnet")).toBe("sonnet");
    expect(kimi.model("haiku")).toBe("haiku");
    expect(kimi.model("kimi-k3.1-pro[1m]")).toBe("kimi-k3.1-pro[1m]");
    expect(kimi.model("")).toBeUndefined();
    // Bedrock's own ids are not Claude API ids: they pass through.
    expect(buildRuntime("bedrock", CONNECTIONS.bedrock).model("us.anthropic.claude-opus-4-8")).toBe("us.anthropic.claude-opus-4-8");
    expect(buildRuntime("bedrock", CONNECTIONS.bedrock).model("claude-sonnet-5-5")).toBe("sonnet");
    // A tier the custom endpoint leaves unmapped keeps the Claude id, which the gateway may serve.
    const custom = buildRuntime("custom", CONNECTIONS.custom);
    expect(custom.model("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(kimi.displayModel("claude-sonnet-5-5")).toBe("Kimi K3");
    expect(kimi.displayModel("")).toBe("Kimi K3");
  });

  it("run another provider's model on their main tier: a Gemini id on Claude, a Kimi id on Gemini", () => {
    // Pointer's chat model set to Gemini, and the reply handed to Claude after Gemini failed.
    const claude = anthropicRuntime("sk-ant-x-123456789");
    expect(claude.model("gemini-4-carbon")).toBeUndefined();
    expect(claude.foreignModel("gemini-4-carbon")).toBe('"gemini-4-carbon" is a Gemini model, and Claude runs Claude models');
    expect(claude.displayModel("gemini-4-carbon")).toBe("the default model");
    for (const id of ["kimi-k3[1m]", "deepseek-v4-pro[1m]", "qwen3.7-max", "glm-5.3", "gpt-6", "o4-mini", "models/gemini-3.6-flash"]) {
      expect(claude.model(id), id).toBeUndefined();
    }
    // Claude's main tier is the Claude card's model, when there is one.
    const card = buildRuntime("anthropic", { ...CONNECTIONS.anthropic, models: { main: "claude-opus-5-5" } });
    expect(card.model("gemini-4-carbon")).toBe("claude-opus-5-5");
    expect(card.displayModel("gemini-4-carbon")).toBe("Opus 5.5");
    // Ids of no known family still pass (a Claude Code alias, a deployment's own name), and so do Claude's.
    expect(claude.model("opusplan")).toBe("opusplan");
    expect(claude.model("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(claude.foreignModel("claude-sonnet-5-5")).toBeUndefined();
    expect(buildRuntime("bedrock", CONNECTIONS.bedrock).model("gemini-4-carbon")).toBeUndefined();
    expect(buildRuntime("bedrock", CONNECTIONS.bedrock).model("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc")).toBe(
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc",
    );

    const gemini = buildRuntime("google-ai", CONNECTIONS["google-ai"]);
    // Its own family passes, listed or not (a newer model the live catalog lists); a Claude id goes to its tier.
    expect(gemini.model("gemini-4-carbon")).toBe("gemini-4-carbon");
    expect(gemini.model("gemini-9-pro")).toBe("gemini-9-pro");
    expect(gemini.model("claude-haiku-5-5")).toBe("haiku");
    expect(gemini.model("kimi-k3[1m]")).toBeUndefined();
    expect(gemini.displayModel("kimi-k3[1m]")).toBe("Gemini 4 Carbon");
    expect(buildRuntime("kimi", CONNECTIONS.kimi).model("gemini-4-carbon")).toBeUndefined();
    // A model the owner put on one of the connection's tiers is the provider's, whatever its name says.
    const routed = buildRuntime("qwen", { ...CONNECTIONS.qwen, models: { main: "kimi-k3" } });
    expect(routed.model("kimi-k3")).toBe("kimi-k3");
    // A custom endpoint may serve anything.
    expect(buildRuntime("custom", CONNECTIONS.custom).model("gemini-4-carbon")).toBe("gemini-4-carbon");
  });

  it("tell model families apart, and give every provider's own API a family", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("claude");
    expect(modelFamily("sonnet[1m]")).toBe("claude");
    expect(modelFamily("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude");
    expect(modelFamily("~anthropic/claude-opus-latest")).toBe("claude");
    expect(modelFamily("claude-haiku-4-5@20251001")).toBe("claude");
    expect(modelFamily("gemini-4-carbon")).toBe("gemini");
    expect(modelFamily("google/gemma-4-27b")).toBe("gemini");
    expect(modelFamily("moonshot-v1-128k")).toBe("kimi");
    expect(modelFamily("qwen-max")).toBe("qwen");
    expect(modelFamily("glm-5.3-flash[1m]")).toBe("glm");
    expect(modelFamily("gpt-6-codex")).toBe("gpt");
    expect(modelFamily("opusplan")).toBeUndefined();
    expect(modelFamily("my-deployment")).toBeUndefined();
    for (const preset of AI_PRESETS) {
      const family = presetFamily(preset);
      if (preset.kind === "custom") expect(family).toBeUndefined();
      else expect(family, preset.id).toBeTruthy();
      // Every listed model is the provider's own.
      const runtime = buildRuntime(preset.id, CONNECTIONS[preset.id]);
      for (const m of preset.models) expect(runtime.foreignModel(m.id), `${preset.id} ${m.id}`).toBeUndefined();
    }
    expect(presetFamily(AI_PRESETS.find((p) => p.id === "zai")!)).toBe("glm");
  });

  it("say once per setting, model and provider when a configured model is ignored", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const claude = anthropicRuntime("sk-ant-x-123456789");
    expect(configuredModel(claude, "gemini-4-carbon", "Pointer's chat model (Team page)", log)).toBeUndefined();
    expect(configuredModel(claude, "gemini-4-carbon", "Pointer's chat model (Team page)", log)).toBeUndefined();
    expect(lines).toEqual([
      `[models] Pointer's chat model (Team page) is ignored on Claude: "gemini-4-carbon" is a Gemini model, and Claude runs Claude models. Claude runs its main model instead.`,
    ]);
    // Another setting, or a model that fits: said separately, or not at all.
    configuredModel(claude, "gemini-4-carbon", "Ada's model (Team page)", log);
    expect(configuredModel(claude, "claude-opus-5-5", "Pointer's chat model (Team page)", log)).toBe("claude-opus-5-5");
    expect(configuredModel(claude, "", "Pointer's chat model (Team page)", log)).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(configuredModel(buildRuntime("google-ai", CONNECTIONS["google-ai"]), "gemini-4-carbon", "Pointer's chat model (Team page)", log)).toBe("gemini-4-carbon");
    expect(lines).toHaveLength(2);
  });

  it("map efforts onto the levels each provider takes", () => {
    const deepseek = buildRuntime("deepseek", CONNECTIONS.deepseek);
    expect(["low", "medium", "high", "xhigh", "max"].map((e) => deepseek.effort(e as "low"))).toEqual(["low", "high", "high", "high", "max"]);
    const qwen = buildRuntime("qwen", CONNECTIONS.qwen);
    expect(qwen.effort("max")).toBe("xhigh");
    expect(qwen.effort("medium")).toBe("high");
    expect(buildRuntime("vertex", CONNECTIONS.vertex).effort("xhigh")).toBe("xhigh");
    expect(nearestEffort("medium", [])).toBeUndefined();
  });

  it("leave WebSearch out where the provider cannot search", () => {
    const blocked = AI_PROVIDER_IDS.filter((id) => buildRuntime(id, CONNECTIONS[id]).disallowedTools.includes("WebSearch"));
    expect(blocked.sort()).toEqual(["bedrock", "custom", "google-ai", "kimi", "zai"]);
    const searching = buildRuntime("custom", { ...CONNECTIONS.custom, settings: { ...CONNECTIONS.custom.settings, webSearch: "on" } });
    expect(searching.disallowedTools).toEqual([]);
  });

  it("price non-Claude models for Claude Code's budgets, under both the plain and the [1m] id", () => {
    for (const id of ["deepseek", "qwen", "kimi", "zai", "google-ai"] as const) {
      const overrides = buildRuntime(id, CONNECTIONS[id]).managedSettings?.modelPricing?.overrides ?? {};
      expect(Object.keys(overrides).length, id).toBeGreaterThan(0);
      for (const price of Object.values(overrides)) {
        for (const rate of [price.input, price.output, price.cacheRead, price.cacheWrite]) expect(rate).toBeGreaterThanOrEqual(0);
      }
    }
    const deepseek = buildRuntime("deepseek", CONNECTIONS.deepseek).managedSettings?.modelPricing?.overrides;
    expect(deepseek?.["deepseek-flash"]).toEqual(deepseek?.["deepseek-flash[1m]"]);
    // Claude models are priced by Claude Code itself.
    for (const id of ["anthropic", "bedrock", "vertex", "google-cloud", "foundry"] as const) expect(buildRuntime(id, CONNECTIONS[id]).managedSettings, id).toBeUndefined();
    const priced = buildRuntime("custom", { ...CONNECTIONS.custom, settings: { ...CONNECTIONS.custom.settings, inputPrice: "3", outputPrice: "15" } });
    expect(priced.managedSettings?.modelPricing?.overrides?.["anthropic/claude-sonnet-5"]).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("write a Google key to a private file outside any checkout for the session, and remove it after", async () => {
    const runtime = buildRuntime("vertex", CONNECTIONS.vertex);
    const session = await runtime.session();
    const file = session.env.GOOGLE_APPLICATION_CREDENTIALS!;
    expect(file).toBeTruthy();
    expect(resolve(file).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(resolve(file).startsWith(resolve(process.cwd()) + sep)).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe(SA_KEY);
    // Its folder is the session's own.
    expect((await stat(join(file, ".."))).mode & 0o077).toBe(0);
    await session.dispose();
    await expect(stat(file)).rejects.toThrow();
    // Without a key: the service's own Google credentials, no file.
    const ambient = await buildRuntime("vertex", { ...CONNECTIONS.vertex, secrets: {} }).session();
    expect(ambient.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it("give Gemini's key to the bridge only: Claude Code gets a token that ends with the session", async () => {
    const key = CONNECTIONS["google-ai"].secrets.apiKey!;
    const runtime = buildRuntime("google-ai", CONNECTIONS["google-ai"]);
    // Without a session: no key, no token, and an address that never resolves.
    expect(JSON.stringify(runtime.env)).not.toContain(key);
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe(GEMINI_BRIDGE_NOT_STARTED);
    expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(runtime.env).toMatchObject({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "gemini-4-carbon",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gemini-4-carbon",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gemini-4-neon",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "gemini-3.5-flash-lite",
      CLAUDE_CODE_SUBAGENT_MODEL: "gemini-4-hydrogen",
      CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1",
    });
    const session = await runtime.session();
    const base = session.env.ANTHROPIC_BASE_URL!;
    const token = session.env.ANTHROPIC_AUTH_TOKEN!;
    // A known token with a bad body is refused before Gemini is called: no network here.
    const probe = () => fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    try {
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(token).toMatch(/^gbr_[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(session.env)).not.toContain(key);
      expect((await probe()).status).toBe(400);
    } finally {
      await session.dispose();
    }
    expect((await probe()).status).toBe(401);
    // Each session its own token.
    const [a, b] = await Promise.all([runtime.session(), runtime.session()]);
    expect(a.env.ANTHROPIC_AUTH_TOKEN).not.toBe(b.env.ANTHROPIC_AUTH_TOKEN);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it("map Gemini's models, efforts and names", () => {
    const gemini = buildRuntime("google-ai", CONNECTIONS["google-ai"]);
    expect(gemini.model("claude-opus-5-5")).toBe("opus");
    expect(gemini.model("gemini-4-argon")).toBe("gemini-4-argon");
    expect(gemini.displayModel("")).toBe("Gemini 4 Carbon");
    expect(gemini.displayModel("claude-haiku-5-5")).toBe("Gemini 3.5 Flash-Lite");
    expect(["low", "medium", "high", "xhigh", "max"].map((e) => gemini.effort(e as "low"))).toEqual(["low", "medium", "high", "xhigh", "xhigh"]);
    expect(gemini.managedSettings?.modelPricing?.overrides?.["gemini-4-carbon"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 });
  });

  it("turn files the provider cannot read into a line saying so", () => {
    const blocks = [
      { type: "text", text: "hi" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } },
    ];
    const zai = buildRuntime("zai", CONNECTIONS.zai);
    expect(fitContentBlocks(blocks, zai).map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(fitContentBlocks(blocks, buildRuntime("anthropic", CONNECTIONS.anthropic))).toEqual(blocks);
  });
});

describe("providerRuntime and readiness", () => {
  it("runs chat and tasks on their own providers", () => {
    const c = fullConfig("kimi", "deepseek");
    const chat = providerRuntime(c, "chat");
    const task = providerRuntime(c, "task");
    expect(chat.ok && chat.runtime.provider).toBe("kimi");
    expect(task.ok && task.runtime.provider).toBe("deepseek");
  });

  it("says clearly when the provider for a scope is not set up", () => {
    const c = ConfigSchema.parse({});
    expect(providerRuntime(c, "chat")).toEqual({ ok: false, error: "Claude is not connected. Ask the owner to add the Anthropic API key on the admin page." });
    c.anthropic.apiKey = "sk-ant-x-123456789";
    c.ai.taskProvider = "kimi";
    expect(providerRuntime(c, "chat").ok).toBe(true);
    expect(providerRuntime(c, "task")).toEqual({ ok: false, error: expect.stringContaining("Kimi (Moonshot) is not set up") });
    c.ai.providers.kimi = { secrets: {}, settings: {}, models: {} };
    expect(providerRuntime(c, "task")).toEqual({ ok: false, error: expect.stringContaining("API key is required") });
  });

  it("makes readiness follow the chat and task providers", () => {
    const c = fullConfig("kimi", "kimi");
    c.anthropic.apiKey = undefined;
    c.slack.botToken = "xoxb-1";
    c.slack.signingSecret = "s";
    c.github.token = "ghp_x";
    expect(isChatReady(c)).toBe(true);
    expect(isReady(c)).toBe(true);
    expect(onboardingError({ channel: "web" }, c)).toBeUndefined();
    delete c.ai.providers.kimi;
    expect(isChatReady(c)).toBe(false);
    expect(isReady(c)).toBe(false);
    expect(onboardingError({ channel: "web" }, c)).toMatch(/^Onboarding is incomplete: Kimi \(Moonshot\) is not set up/);
    expect(publicView(c).ai.chat).toEqual({ provider: "kimi", name: "Kimi", ready: false });
  });

  it("redacts every provider's secrets", () => {
    const secrets = configSecrets(fullConfig());
    for (const secret of allSecrets()) expect(secrets).toContain(secret);
  });
});

describe("connection validation", () => {
  const problem = (id: AiProviderId, conn: Partial<ConnectionValues>, env: NodeJS.ProcessEnv = {}) =>
    connectionProblem(id, { secrets: {}, settings: {}, models: {}, ...conn }, env);

  it("accepts every fixture", () => {
    for (const id of AI_PROVIDER_IDS) expect(problem(id, CONNECTIONS[id]), id).toBeUndefined();
  });

  it("takes Gemini keys in their old and new formats, and refuses what is plainly not one", () => {
    expect(problem("google-ai", { secrets: { apiKey: "AIzaSyA-legacy-format-key-0123456789" } })).toBeUndefined();
    expect(problem("google-ai", { secrets: { apiKey: "AQ.Ab8RN6-new-format-key-0123456789" } })).toBeUndefined();
    expect(problem("google-ai", {})).toBe("API key is required for Gemini (Google AI Studio).");
    expect(problem("google-ai", { secrets: { apiKey: "ya29.a0Af-sign-in-token-0123456789" } })).toMatch(/sign-in token/);
    expect(problem("google-ai", { secrets: { apiKey: "short-key" } })).toMatch(/Gemini API key/);
    expect(problem("google-ai", { secrets: { apiKey: '{"type": "service_account"}' } })).toMatch(/Gemini API key/);
  });

  it("refuses incomplete or wrong values with a clear message", () => {
    expect(problem("deepseek", {})).toBe("DeepSeek API key is required for DeepSeek.");
    expect(problem("qwen", { secrets: { apiKey: "sk-sp-codingplan-123" }, settings: { workspaceId: "ws-1" } })).toMatch(/Coding Plan key/);
    expect(problem("qwen", { secrets: { apiKey: "sk-qwen-123456" }, settings: { region: "us-east-1" } })).toBe("That region needs your workspace ID.");
    expect(problem("bedrock", { settings: { region: "us-east-1" } })).toBe("Give a Bedrock API key, or an access key ID and its secret.");
    expect(problem("vertex", { settings: { projectId: "acme-ai" }, secrets: { credentialsJson: "{nope" } })).toMatch(/not valid JSON/);
    expect(problem("vertex", { settings: { projectId: "acme-ai" }, secrets: { credentialsJson: '{"type":"other"}' } })).toMatch(/not a Google credentials file/);
    expect(problem("kimi", { secrets: { apiKey: "sk-kimi-1234567" }, settings: { region: "mars" } })).toBe("Platform: choose one of the options.");
    expect(problem("kimi", { secrets: { apiKey: "sk-kimi-1234567" }, models: { main: "kimi k3" } })).toMatch(/not a model id/);
    expect(problem("custom", { secrets: { authToken: "token-12345678" }, settings: { baseUrl: "https://gateway.example.com/v1" } })).toMatch(/Leave \/v1 off/);
    expect(problem("custom", { secrets: { authToken: "token-12345678", headers: "Authorization: Bearer x" }, settings: { baseUrl: "https://gateway.example.com" } })).toMatch(
      /set by the platform/,
    );
    expect(problem("custom", { secrets: { authToken: "token-12345678" }, settings: { baseUrl: "https://gateway.example.com", inputPrice: "3" } })).toBe(
      "Give both prices, or neither.",
    );
  });

  it("allows a custom endpoint on http://localhost only with ALLOW_PRIVATE_APP_URLS=1, and https elsewhere", () => {
    const local = { secrets: { authToken: "token-12345678" }, settings: { baseUrl: "http://localhost:4000" } };
    expect(problem("custom", local)).toMatch(/Use an https:\/\/ address/);
    expect(problem("custom", local, { ALLOW_PRIVATE_APP_URLS: "1" })).toBeUndefined();
    expect(problem("custom", { ...local, settings: { baseUrl: "http://gateway.example.com" } }, { ALLOW_PRIVATE_APP_URLS: "1" })).toMatch(/https/);
    expect(problem("custom", { ...local, settings: { baseUrl: "https://metadata.google.internal" } })).toMatch(/private network/);
  });

  it("parses extra headers", () => {
    expect(parseHeaderLines("a-b: 1\n\nX-Two:  two words ")).toEqual({ headers: [["a-b", "1"], ["X-Two", "two words"]] });
    expect(parseHeaderLines("no colon")).toEqual({ error: expect.stringContaining("Name: Value") });
  });
});

// ---------- Redacting secrets made of parts ----------

describe("secrets made of parts", () => {
  // A fake key: random bytes laid out as a PEM, no real key material.
  const PEM_LINES = randomBytes(700).toString("base64").match(/.{1,64}/g)!;
  const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_LINES.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const KEY = {
    type: "service_account",
    project_id: "acme-ai",
    private_key_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    private_key: PEM,
    client_email: "pointer@acme-ai.iam.gserviceaccount.com",
    client_id: "102030405060708090100",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  // As Google's download lays it out.
  const KEY_FILE = JSON.stringify(KEY, null, 2);
  const config = () => {
    const c = fullConfig();
    c.ai.providers.vertex = { ...CONNECTIONS.vertex, secrets: { credentialsJson: KEY_FILE } };
    return c;
  };

  /** What an agent's shell could print of the key file, laid out anew by the tool. */
  const printed: Record<string, string> = {
    "jq --tab .": JSON.stringify(KEY, null, 2).replace(/^ {2}/gm, "\t"),
    "python -m json.tool": JSON.stringify(KEY, null, 4),
    "jq -c .": JSON.stringify(KEY),
    "jq '{private_key}'": JSON.stringify({ private_key: PEM }, null, 2),
    "jq -r .private_key": PEM,
    "jq -r .private_key | head -5": PEM.split("\n").slice(0, 5).join("\n"),
    "jq -r .private_key | tr -d '\\n'": PEM.replace(/\n/g, ""),
    "jq -r .private_key | sed 's/^/    /'": PEM.replace(/^/gm, "    "),
    "jq -r .private_key_id": KEY.private_key_id,
    "cat": KEY_FILE,
  };

  const leaks = (text: string) => [...PEM_LINES.filter((l) => l.length >= 12), KEY.private_key_id].filter((s) => text.includes(s));

  it("hides a Google key's private key however a tool prints it, in everything the platform posts and logs", () => {
    const redact = makeRedactor(configSecrets(config()));
    for (const [command, output] of Object.entries(printed)) expect(leaks(redact(output)), command).toEqual([]);
    // The account's name is not secret on its own, and says whose permissions to fix.
    expect(redact(printed["jq --tab ."]!)).toContain(KEY.client_email);
  });

  it("hides it the same way in a connection test's errors", () => {
    const redact = redactConnection({ secrets: { credentialsJson: KEY_FILE }, settings: {}, models: {} });
    for (const [command, output] of Object.entries(printed)) expect(leaks(redact(`check failed: ${output}`)), command).toEqual([]);
  });

  it("splits a PEM on real and literal \\n alike, without leaving the n on a line", () => {
    const escaped = PEM.replace(/\n/g, "\\n");
    for (const value of [KEY_FILE, JSON.stringify(KEY), escaped]) {
      const parts = secretParts(value);
      for (const line of PEM_LINES.filter((l) => l.length >= 12)) {
        expect(parts).toContain(line);
        expect(parts).not.toContain(`n${line}`);
      }
    }
    // Plain secrets are only themselves.
    expect(secretParts("sk-ant-anthropic-secret-0001")).toEqual(["sk-ant-anthropic-secret-0001"]);
    expect(secretParts("http://localhost:3000")).toEqual(["http://localhost:3000"]);
  });

  it("hides each extra header's value, as the headers are sent and printed in other layouts", () => {
    const c = fullConfig();
    c.ai.providers.custom = {
      ...CONNECTIONS.custom,
      secrets: { authToken: "gateway-token-secret-0010", headers: "cf-aig-authorization: Bearer cf-header-secret-0011\nX-Team:team-secret-value-42\nX-Debug: enabled" },
    };
    const redact = makeRedactor(configSecrets(c));
    expect(redact("ANTHROPIC_CUSTOM_HEADERS=cf-aig-authorization:Bearer cf-header-secret-0011")).toBe("ANTHROPIC_CUSTOM_HEADERS=cf-aig-authorization:[redacted]");
    expect(redact("token cf-header-secret-0011")).toBe("token [redacted]");
    expect(redact("X-Team: team-secret-value-42")).toBe("X-Team: [redacted]");
    // A plain word is not a secret: hiding it would garble every message that has it.
    expect(redact("the cache is enabled")).toBe("the cache is enabled");
  });
});

// ---------- A saved key never goes to a new address ----------

describe("changing where the secrets go", () => {
  const presetOf = (id: AiProviderId) => AI_PRESETS.find((p) => p.id === id)!;
  const change = (id: AiProviderId, saved: ConnectionValues, changes: Parameters<typeof applyChanges>[2]) => applyChanges(presetOf(id), saved, changes);

  it("needs the secrets pasted again when the address they are sent to changes", () => {
    const custom = CONNECTIONS.custom;
    expect(change("custom", custom, { settings: { baseUrl: "https://collector.example" } })).toEqual({
      error: "Paste the token and extra headers again for the new address.",
    });
    expect(change("custom", custom, { secrets: { authToken: "new-token-12345678" }, settings: { baseUrl: "https://collector.example" } })).toEqual({
      error: "Paste the extra headers again for the new address.",
    });
    // Pasted again (or removed with null): only the new values go to the new address.
    const moved = change("custom", custom, { secrets: { authToken: "new-token-12345678", headers: null }, settings: { baseUrl: "https://collector.example" } });
    expect(moved).toMatchObject({ conn: { secrets: { authToken: "new-token-12345678" }, settings: { baseUrl: "https://collector.example" } } });

    expect(change("foundry", CONNECTIONS.foundry, { settings: { resource: "other-resource" } })).toEqual({ error: "Paste the API key again for the new address." });
    expect(change("qwen", CONNECTIONS.qwen, { settings: { workspaceId: "ws-other" } })).toEqual({ error: "Paste the API key again for the new address." });
    expect(change("qwen", CONNECTIONS.qwen, { settings: { region: "us-east-1" } })).toEqual({ error: "Paste the API key again for the new address." });
    expect(change("kimi", CONNECTIONS.kimi, { settings: { region: "china" } })).toEqual({ error: "Paste the API key again for the new address." });
    expect(change("zai", CONNECTIONS.zai, { settings: { region: "international" } })).toEqual({ error: "Paste the API key again for the new address." });
    expect(change("bedrock", CONNECTIONS.bedrock, { settings: { region: "us-west-2" } })).toEqual({ error: "Paste the Bedrock API key again for the new address." });
    const accessKeys = { secrets: { accessKeyId: "AKIAEXAMPLEKEY000001", secretAccessKey: "aws-secret-access-key-0001" }, settings: { region: "eu-west-1" }, models: {} };
    expect(change("bedrock", accessKeys, { settings: { region: "us-west-2" } })).toEqual({ error: "Paste the access key ID and secret access key again for the new address." });
    expect(change("kimi", CONNECTIONS.kimi, { secrets: { apiKey: "sk-kimi-new-key-0001" }, settings: { region: "china" } })).toMatchObject({
      conn: { secrets: { apiKey: "sk-kimi-new-key-0001" } },
    });
  });

  it("keeps the saved secrets when the address stays the same", () => {
    // Other settings, models, and the default typed out.
    expect(change("custom", CONNECTIONS.custom, { settings: { baseUrl: "https://gateway.example.com/anthropic", compat: "on" }, models: { main: "x" } })).toMatchObject({
      conn: { secrets: CONNECTIONS.custom.secrets },
    });
    expect(change("kimi", CONNECTIONS.kimi, { settings: { region: "international" } })).toMatchObject({ conn: { secrets: CONNECTIONS.kimi.secrets } });
    // A Google key is never sent: it signs token requests to the address in the key file itself.
    expect(change("vertex", CONNECTIONS.vertex, { settings: { region: "us-east5" } })).toMatchObject({ conn: { secrets: CONNECTIONS.vertex.secrets } });
    // Nothing saved yet: nothing to carry over.
    expect(change("custom", undefined as never, { secrets: { authToken: "token-12345678" }, settings: { baseUrl: "https://collector.example" } })).toMatchObject({
      conn: { secrets: { authToken: "token-12345678" } },
    });
  });
});

describe("the team on another provider", () => {
  it("maps each agent's model and effort through the task provider", () => {
    const c = fullConfig("anthropic", "deepseek");
    const runtime = buildRuntime("deepseek", CONNECTIONS.deepseek);
    c.team.agents = c.team.agents.map((a) => (a.id === "coder" ? { ...a, model: "claude-opus-5-5", effort: "medium" } : a.id === "qa" ? { ...a, model: "deepseek-v4-pro[1m]" } : a));
    const agents = buildRepoAgents(c.team, { provider: runtime });
    expect(agents.coder).toMatchObject({ model: "opus", effort: "high" });
    expect(agents.qa?.model).toBe("deepseek-v4-pro[1m]");
    expect(agents.reviewer?.model).toBeUndefined();
    c.team.pointer.taskEffort = "xhigh";
    expect(teamQueryOptions(c, {}, undefined, { provider: runtime }).effort).toBe("high");
    expect(teamQueryOptions(c).effort).toBe("xhigh");
  });

  it("sizes a task on the task provider's small tier, with its environment", async () => {
    const q = fakeQuery([result({ structured_output: { size: "small", reason: "One line" } })]);
    const sized = await estimateTaskSize({ instruction: "Fix a typo", repo: "acme/web" }, { provider: buildRuntime("kimi", CONNECTIONS.kimi), queryFn: q.queryFn });
    expect(sized.size).toBe("small");
    expect(q.calls[0]).toMatchObject({ model: "haiku", effort: "low" });
    expect(q.calls[0]!.env).toMatchObject({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "sk-kimi-secret-0008" });
    expect(q.calls[0]!.managedSettings?.modelPricing?.overrides?.["kimi-k3"]).toBeDefined();
  });
});

// ---------- The connection test ----------

describe("testConnection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends one tiny Messages call to an Anthropic-compatible endpoint, with the key in the right header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 });
    };
    expect(await testConnection("deepseek", CONNECTIONS.deepseek, { fetch })).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer sk-deepseek-secret-0006");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ model: "deepseek-flash", max_tokens: 1, messages: [{ role: "user", content: "Reply OK" }] });

    await testConnection("custom", { ...CONNECTIONS.custom, settings: { ...CONNECTIONS.custom.settings, authHeader: "x-api-key" } }, { fetch });
    const headers = new Headers(calls[1]!.init?.headers);
    expect(calls[1]!.url).toBe("https://gateway.example.com/anthropic/v1/messages");
    expect(headers.get("x-api-key")).toBe("gateway-token-secret-0010");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cf-header-secret-0011");
  });

  it("explains a rejected key without ever repeating it", async () => {
    const fetch = async () => new Response(JSON.stringify({ error: { message: "Invalid key sk-kimi-secret-0008 for this account" } }), { status: 401 });
    const r = await testConnection("kimi", CONNECTIONS.kimi, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Kimi (Moonshot) rejected the key");
      expect(r.error).not.toContain("sk-kimi-secret-0008");
    }
    const down = await testConnection("zai", CONNECTIONS.zai, { fetch: async () => Promise.reject(new Error("connect ECONNREFUSED zai-key-secret-0009")) });
    expect(down).toEqual({ ok: false, error: expect.not.stringContaining("zai-key-secret-0009") });
  });

  it("refuses plain http except a custom endpoint on localhost with ALLOW_PRIVATE_APP_URLS=1", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const local = { ...CONNECTIONS.custom, settings: { baseUrl: "http://localhost:4000" } };
    expect(await testConnection("custom", local, { fetch, env: {} })).toEqual({ ok: false, error: expect.stringContaining("https://") });
    expect(fetch).not.toHaveBeenCalled();
    expect(await testConnection("custom", local, { fetch, env: { ALLOW_PRIVATE_APP_URLS: "1" } })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("http://localhost:4000/v1/messages", expect.anything());
  });

  it("checks Gemini with one SDK turn through the bridge, with a token in place of the key", async () => {
    const key = CONNECTIONS["google-ai"].secrets.apiKey!;
    let seen: Record<string, string | undefined> = {};
    const q = fakeQuery([result()], (options) => {
      seen = { ...options.env };
    });
    expect(await testConnection("google-ai", CONNECTIONS["google-ai"], { queryFn: q.queryFn })).toEqual({ ok: true });
    expect(q.calls[0]).toMatchObject({ maxTurns: 1, tools: [], settingSources: [] });
    expect(seen.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    expect(JSON.stringify(seen)).not.toContain(key);
    // The token ended with the check.
    const res = await fetch(`${seen.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "x-api-key": seen.ANTHROPIC_AUTH_TOKEN! }, body: "{}" });
    expect(res.status).toBe(401);

    const failing = fakeQuery([result({ is_error: true, result: `API Error: 401 rejected ${key}` })]);
    const r = await testConnection("google-ai", CONNECTIONS["google-ai"], { queryFn: failing.queryFn });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Gemini (Google AI Studio) check failed") });
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it("runs one SDK turn for a cloud, with the key file only while it runs", async () => {
    let seen: string | undefined;
    const q = fakeQuery([result()], async (options) => {
      seen = options.env?.GOOGLE_APPLICATION_CREDENTIALS;
      expect(await readFile(seen!, "utf8")).toBe(SA_KEY);
    });
    expect(await testConnection("vertex", CONNECTIONS.vertex, { queryFn: q.queryFn })).toEqual({ ok: true });
    expect(q.calls[0]).toMatchObject({ maxTurns: 1, tools: [], settingSources: [] });
    expect(q.calls[0]!.env).toMatchObject({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_API_KEY: "" });
    await expect(stat(seen!)).rejects.toThrow();

    const failing = fakeQuery([result({ is_error: true, result: `403 for ${CONNECTIONS.foundry.secrets.apiKey}` })]);
    const r = await testConnection("foundry", CONNECTIONS.foundry, { queryFn: failing.queryFn });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Microsoft Foundry check failed") });
    expect(JSON.stringify(r)).not.toContain(CONNECTIONS.foundry.secrets.apiKey);
  });
});

// ---------- The admin routes ----------

describe("AI provider admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown, withCookie = true) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (path: string, body: unknown = {}, withCookie = true) => send("POST", path, body, withCookie);
  const providers = async () => (await (await send("GET", "/api/ai/providers")).json()) as import("../../src/routes/ai.js").AiProvidersView;
  const state = async () => (await (await send("GET", "/api/state")).json()).config;
  const error = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error: string }).error });

  /** Answers calls to the providers' hosts; this test's own requests go through. */
  function stubProviders(reply: (url: URL, init?: RequestInit) => Response) {
    const realFetch = globalThis.fetch;
    const calls: { url: URL; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "127.0.0.1") return realFetch(input, init);
      calls.push({ url, init });
      return reply(url, init);
    });
    return calls;
  }

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-ai-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => close());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    expect((await send("GET", "/api/ai/providers", undefined, false)).status).toBe(401);
    expect((await post("/api/ai/providers/kimi", { secrets: { apiKey: "sk-kimi-123456789" } }, false)).status).toBe(401);
    expect((await post("/api/ai/providers/kimi/test", {}, false)).status).toBe(401);
    expect((await post("/api/ai/providers/kimi/delete", {}, false)).status).toBe(401);
    expect((await post("/api/ai/active", { chatProvider: "kimi" }, false)).status).toBe(401);
  });

  it("lists every preset with its capabilities, models and docs, Anthropic first", async () => {
    const view = await providers();
    expect(view.chatProvider).toBe("anthropic");
    expect(view.providers.map((p) => p.id)).toEqual([...AI_PROVIDER_IDS]);
    const kimi = view.providers.find((p) => p.id === "kimi")!;
    expect(kimi).toMatchObject({ name: "Kimi (Moonshot)", configured: false, saved: null, bestEffort: true, capabilities: { webSearch: false } });
    expect(kimi.models.length).toBeGreaterThan(0);
    expect(kimi.docsUrl).toMatch(/^https:\/\//);
  });

  it("validates the input against the preset", async () => {
    process.env.SKIP_VALIDATION = "1";
    expect((await post("/api/ai/providers/openai", { secrets: { apiKey: "x" } })).status).toBe(404);
    expect(await error(await post("/api/ai/providers/kimi", { secrets: { token: "sk-kimi-123456789" } }))).toEqual({
      status: 400,
      error: 'Kimi (Moonshot) has no field "token".',
    });
    expect(await error(await post("/api/ai/providers/kimi", { settings: { apiKey: "sk-kimi-123456789" } }))).toMatchObject({ status: 400 });
    expect(await error(await post("/api/ai/providers/kimi", {}))).toEqual({ status: 400, error: "API key is required for Kimi (Moonshot)." });
    expect(await error(await post("/api/ai/providers/kimi", { secrets: { apiKey: "sk-kimi-123456789" }, extra: 1 }))).toMatchObject({ status: 400 });
    expect(await error(await post("/api/ai/providers/qwen", { secrets: { apiKey: "sk-sp-123456789" } }))).toMatchObject({ status: 400, error: expect.stringContaining("Coding Plan") });
    expect(await error(await post("/api/ai/providers/anthropic", { secrets: { apiKey: "sk-ant-123456789" }, models: { opus: "x" } }))).toMatchObject({ status: 400 });
  });

  it("tests a new connection with the provider before saving it, and never returns the secret", async () => {
    const KEY = "sk-kimi-route-secret-123";
    const calls = stubProviders((url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === `Bearer ${KEY}` ? new Response("{}", { status: 200 }) : new Response(JSON.stringify({ error: { message: `bad key ${auth}` } }), { status: 401 });
    });
    const bad = await post("/api/ai/providers/kimi", { secrets: { apiKey: "sk-kimi-wrong-secret-456" } });
    const badBody = await bad.text();
    expect(bad.status).toBe(400);
    expect(badBody).toContain("rejected the key");
    expect(badBody).not.toContain("sk-kimi-wrong-secret-456");
    expect((await providers()).providers.find((p) => p.id === "kimi")!.saved).toBeNull();

    const ok = await post("/api/ai/providers/kimi", { secrets: { apiKey: KEY }, models: { opus: "kimi-k3.1-pro[1m]" } });
    const okBody = await ok.text();
    expect(ok.status).toBe(200);
    expect(okBody).not.toContain(KEY);
    expect(JSON.parse(okBody).provider).toMatchObject({ configured: true, saved: { secrets: { apiKey: "••••-123" }, models: { opus: "kimi-k3.1-pro[1m]" } } });
    expect(calls.at(-1)!.url.href).toBe("https://api.moonshot.ai/anthropic/v1/messages");
    expect(JSON.parse(okBody).provider.saved.checkedAt).toEqual(expect.any(String));

    // An empty secret keeps the saved one; the model change is tested with it.
    const again = await post("/api/ai/providers/kimi", { secrets: { apiKey: "" }, models: { opus: "" } });
    expect(again.status).toBe(200);
    expect(new Headers(calls.at(-1)!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const kimi = (await providers()).providers.find((p) => p.id === "kimi")!;
    expect(kimi.saved?.models).toEqual({});
    expect(JSON.stringify(await providers())).not.toContain(KEY);
    expect(JSON.stringify(await state())).not.toContain(KEY);

    // The test route checks the saved connection again.
    expect(await (await post("/api/ai/providers/kimi/test")).json()).toEqual({ ok: true, checkedAt: expect.any(String) });
  });

  it("chooses chat and task providers only among configured ones, and refuses to delete one in use", async () => {
    process.env.SKIP_VALIDATION = "1";
    expect(await error(await post("/api/ai/active", { taskProvider: "zai" }))).toMatchObject({ status: 400, error: expect.stringContaining("Z.ai GLM is not set up") });
    expect((await post("/api/ai/providers/kimi", { secrets: { apiKey: "sk-kimi-123456789" } })).status).toBe(200);
    expect(await (await post("/api/ai/active", { taskProvider: "kimi" })).json()).toEqual({ ok: true, chatProvider: "anthropic", taskProvider: "kimi" });
    expect((await state()).ai.task).toEqual({ provider: "kimi", name: "Kimi", ready: true });
    expect(await error(await post("/api/ai/providers/kimi/delete"))).toEqual({
      status: 409,
      error: "Kimi (Moonshot) runs repo tasks. Choose another provider for repo tasks first.",
    });
    expect(await error(await post("/api/ai/providers/anthropic/delete"))).toMatchObject({ status: 409 });
    expect((await post("/api/ai/active", { taskProvider: "anthropic" })).status).toBe(400); // Anthropic is not connected yet
  });

  it("keeps Anthropic's own key where it was, through both routes", async () => {
    process.env.SKIP_VALIDATION = "1";
    expect((await post("/api/anthropic", { apiKey: "sk-ant-route-key-0001", model: "claude-opus-5-5" })).status).toBe(200);
    expect((await state()).anthropic).toEqual({ connected: true, key: "••••0001", model: "claude-opus-5-5" });
    const res = await post("/api/ai/providers/anthropic", { secrets: { apiKey: "" }, models: { main: "claude-sonnet-5-5" } });
    expect(res.status).toBe(200);
    expect((await state()).anthropic).toEqual({ connected: true, key: "••••0001", model: "claude-sonnet-5-5" });
    expect((await providers()).providers[0]).toMatchObject({ id: "anthropic", configured: true, usedFor: { chat: true } });
    // Back on Anthropic, Kimi can go.
    expect((await post("/api/ai/active", { taskProvider: "anthropic" })).status).toBe(200);
    expect(await (await post("/api/ai/providers/kimi/delete")).json()).toEqual({ ok: true });
    expect((await providers()).providers.find((p) => p.id === "kimi")!.saved).toBeNull();
  });

  it("never sends a saved token to a new address: a test or a save needs it pasted again", async () => {
    process.env.SKIP_VALIDATION = "1";
    const TOKEN = "gateway-route-token-0001";
    const saved = await post("/api/ai/providers/custom", {
      secrets: { authToken: TOKEN, headers: "X-Team: header-route-secret-0002" },
      settings: { baseUrl: "https://gateway.example.com/anthropic" },
    });
    expect(saved.status).toBe(200);
    delete process.env.SKIP_VALIDATION;
    // The example hosts have no DNS: let the guarded fetch reach the stub without a lookup.
    process.env.ALLOW_PRIVATE_APP_URLS = "1";
    const calls = stubProviders(() => new Response("{}", { status: 200 }));
    try {
      const away = { settings: { baseUrl: "https://collector.example" } };
      for (const path of ["/api/ai/providers/custom/test", "/api/ai/providers/custom"]) {
        expect(await error(await post(path, away))).toEqual({ status: 400, error: "Paste the token and extra headers again for the new address." });
      }
      expect(calls).toEqual([]);

      // Pasted again (the headers removed): only the new token goes to the new address.
      expect((await post("/api/ai/providers/custom/test", { secrets: { authToken: "collector-token-0003", headers: null }, ...away })).status).toBe(200);
      expect(calls.map((c) => c.url.host)).toEqual(["collector.example"]);
      const sent = new Headers(calls[0]!.init?.headers);
      expect(sent.get("authorization")).toBe("Bearer collector-token-0003");
      expect(sent.get("x-team")).toBeNull();

      // A test saves nothing: the saved connection still goes to its own address, with its own token.
      expect((await post("/api/ai/providers/custom/test")).status).toBe(200);
      expect(calls[1]!.url.host).toBe("gateway.example.com");
      expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    } finally {
      delete process.env.ALLOW_PRIVATE_APP_URLS;
    }
  });
});
