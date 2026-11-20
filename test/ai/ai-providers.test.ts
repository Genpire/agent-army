import { mkdtemp, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_PRESETS } from "../../src/ai/ai-presets.js";
import {
  type ConnectionValues,
  anthropicRuntime,
  buildRuntime,
  connectionProblem,
  fitContentBlocks,
  nearestEffort,
  parseHeaderLines,
  providerRuntime,
  testConnection,
} from "../../src/ai/ai-providers.js";
import { AI_PROVIDER_IDS, type AiProviderId, type Config, ConfigSchema, isChatReady, isReady, publicView } from "../../src/core/config.js";
import type { QueryFn } from "../../src/chat/pointer.js";
import { createApp } from "../../src/server.js";
import { estimateTaskSize } from "../../src/sizing.js";
import { buildRepoAgents } from "../../src/team/team.js";
import { configSecrets, onboardingError, teamQueryOptions } from "../../src/worker.js";

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
      expect(p.bestEffort).toBe(["deepseek", "qwen", "kimi", "zai", "custom"].includes(p.id));
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
    expect(blocked.sort()).toEqual(["bedrock", "custom", "kimi", "zai"]);
    const searching = buildRuntime("custom", { ...CONNECTIONS.custom, settings: { ...CONNECTIONS.custom.settings, webSearch: "on" } });
    expect(searching.disallowedTools).toEqual([]);
  });

  it("price non-Claude models for Claude Code's budgets, under both the plain and the [1m] id", () => {
    for (const id of ["deepseek", "qwen", "kimi", "zai"] as const) {
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
});
