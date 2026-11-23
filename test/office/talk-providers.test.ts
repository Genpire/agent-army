import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { anthropicRuntime, buildRuntime } from "../../src/ai/ai-providers.js";
import { TRANSCRIPTION } from "../../src/chat/transcribe.js";
import type { QueryFn } from "../../src/chat/pointer.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { TALK_BUDGET_USD, type TalkCall, chatTalk, chooseTalkProvider, geminiTalk, talkAvailability } from "../../src/office/talk-providers.js";
import { SIZING_MODEL } from "../../src/tasks/sizing.js";

const GEMINI_KEY = "AIzaSy-office-gemini-secret-0123456789";
const ANTHROPIC_KEY = "sk-ant-office-secret-0123456789";
const LINES = { lines: [{ speaker: "coder", text: "Nice rally!" }, { speaker: "qa", text: "The tests are green." }] };
const CALL: TalkCall = { system: "You write office talk.", prompt: "They are playing ping pong.", speakers: ["coder", "qa"], model: "" };

function config(over: { gemini?: boolean; anthropic?: boolean; provider?: Config["office"]["talk"]["provider"] } = {}): Config {
  const c = ConfigSchema.parse({});
  if (over.gemini) c.engines.gemini.apiKey = GEMINI_KEY;
  if (over.anthropic) c.anthropic.apiKey = ANTHROPIC_KEY;
  if (over.provider) c.office.talk.provider = over.provider;
  return c;
}

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiAnswer = (body: unknown, usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }) =>
  json(200, { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(body) }] } }], usageMetadata: usage });

/** A fake fetch: each call answers with the next response; records what was sent. */
function fakeFetch(...answers: Array<(seen: Seen) => Response | Promise<Response>>) {
  const calls: Seen[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(seen);
    return answers[Math.min(calls.length - 1, answers.length - 1)]!(seen);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A result message as the SDK sends it (only the fields the code reads matter). */
const result = (fields: Record<string, unknown>): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.0004, num_turns: 1, modelUsage: {}, ...fields }) as unknown as SDKMessage;

function fakeQuery(messages: SDKMessage[] | Error) {
  const calls: { prompt: unknown; options?: Options }[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      if (messages instanceof Error) throw messages;
      yield* messages;
    })();
  };
  return { queryFn, calls };
}

describe("chooseTalkProvider", () => {
  it("auto is Gemini when its key is connected, else the chat provider, else none", () => {
    expect(chooseTalkProvider(config({ gemini: true, anthropic: true }))).toEqual({ id: "gemini", key: GEMINI_KEY });
    expect(chooseTalkProvider(config({ anthropic: true }))?.id).toBe("chat");
    expect(chooseTalkProvider(config())).toBeUndefined();
  });

  it("a chosen provider is used only when it is there", () => {
    expect(chooseTalkProvider(config({ anthropic: true, provider: "gemini" }))).toBeUndefined();
    expect(chooseTalkProvider(config({ gemini: true, anthropic: true, provider: "chat" }))?.id).toBe("chat");
    expect(chooseTalkProvider(config({ gemini: true, provider: "chat" }))).toBeUndefined();
    expect(talkAvailability(config({ gemini: true }))).toEqual({ gemini: true, chat: false });
  });
});

describe("geminiTalk", () => {
  it("calls generateContent with the key in a header, the prompt, and the JSON mode with the speakers", async () => {
    const fake = fakeFetch(() => geminiAnswer(LINES));
    const out = await geminiTalk(GEMINI_KEY, CALL, { fetch: fake.fetch });
    expect(fake.calls).toHaveLength(1);
    const [seen] = fake.calls;
    expect(seen!.url).toBe(`${TRANSCRIPTION.geminiBase}/${TRANSCRIPTION.geminiModels[0]}:generateContent`);
    expect(seen!.url).not.toContain(GEMINI_KEY);
    expect(seen!.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);
    expect(seen!.body).toMatchObject({
      systemInstruction: { parts: [{ text: CALL.system }] },
      contents: [{ role: "user", parts: [{ text: CALL.prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    });
    const schema = (seen!.body.generationConfig as { responseSchema: { properties: { lines: { items: { properties: { speaker: { enum: string[] } } } } } } })
      .responseSchema;
    expect(schema.properties.lines.items.properties.speaker.enum).toEqual(["coder", "qa"]);
    // The thought is left out; the answer is the JSON text.
    expect(JSON.parse(out.raw as string)).toEqual(LINES);
    expect(out).toMatchObject({ model: TRANSCRIPTION.geminiModels[0] });
    expect(out.error).toBeUndefined();
  });

  it("tries the next default model when one is not available to the key, and prices the tokens of a priced model", async () => {
    const fake = fakeFetch(
      () => json(404, { error: { message: "models/gemini-3.5-flash-lite is not found" } }),
      () => geminiAnswer(LINES),
    );
    const out = await geminiTalk(GEMINI_KEY, CALL, { fetch: fake.fetch });
    expect(fake.calls.map((c) => c.url.split("/").at(-1))).toEqual(TRANSCRIPTION.geminiModels.map((m) => `${m}:generateContent`));
    expect(out.model).toBe("gemini-2.5-flash-lite");
    // A million tokens in and out at $0.10 / $0.40.
    expect(out.costUsd).toBeCloseTo(0.5, 6);
    expect(out.tokens).toBe(2_000_000);
  });

  it("uses the owner's model alone, and counts a model with no price at $0", async () => {
    const fake = fakeFetch(() => geminiAnswer(LINES));
    const out = await geminiTalk(GEMINI_KEY, { ...CALL, model: "models/gemini-9-office" }, { fetch: fake.fetch });
    expect(fake.calls[0]!.url).toBe(`${TRANSCRIPTION.geminiBase}/gemini-9-office:generateContent`);
    expect(out).toMatchObject({ model: "gemini-9-office", costUsd: 0, tokens: 2_000_000 });

    const missing = fakeFetch(() => json(404, { error: { message: "not found" } }));
    const failed = await geminiTalk(GEMINI_KEY, { ...CALL, model: "gemini-9-office" }, { fetch: missing.fetch });
    expect(missing.calls).toHaveLength(1);
    expect(failed.error).toBe("Gemini answered 404: not found");
  });

  it("reports a refusal, a timeout and an unreachable API without the key", async () => {
    const declined = await geminiTalk(GEMINI_KEY, CALL, { fetch: fakeFetch(() => json(200, { promptFeedback: { blockReason: "SAFETY" } })).fetch });
    expect(declined.error).toBe("Gemini declined (SAFETY).");
    const slow = fakeFetch(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    expect((await geminiTalk(GEMINI_KEY, CALL, { fetch: slow.fetch })).error).toBe("Gemini took too long to answer.");
    const down = fakeFetch(async () => {
      throw new Error(`connect failed for ${GEMINI_KEY}`);
    });
    const out = await geminiTalk(GEMINI_KEY, CALL, { fetch: down.fetch });
    expect(out.error).toBe("Gemini could not be reached.");
  });
});

describe("chatTalk", () => {
  it("runs one isolated call with no tools, one turn, a JSON schema of the speakers and a tiny budget, on the cheapest model", async () => {
    const q = fakeQuery([result({ structured_output: LINES, total_cost_usd: 0.0007, modelUsage: { [SIZING_MODEL]: { inputTokens: 900, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } })]);
    const out = await chatTalk(anthropicRuntime(ANTHROPIC_KEY), CALL, { queryFn: q.queryFn });
    expect(q.calls).toHaveLength(1);
    const { prompt, options } = q.calls[0]!;
    expect(prompt).toBe(CALL.prompt);
    expect(options).toMatchObject({
      model: SIZING_MODEL,
      systemPrompt: CALL.system,
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: TALK_BUDGET_USD,
      persistSession: false,
      settingSources: [],
      verbatimPrompts: true,
      outputFormat: { type: "json_schema" },
    });
    const schema = (options!.outputFormat as { schema: { properties: { lines: { items: { properties: { speaker: { enum: string[] } } } } } } }).schema;
    expect(schema.properties.lines.items.properties.speaker.enum).toEqual(["coder", "qa"]);
    expect(out).toEqual({ raw: LINES, model: SIZING_MODEL, costUsd: 0.0007, tokens: 1000, provider: "anthropic" });
  });

  it("gives the CLI an environment of its own: the provider's credentials, none of the service's secrets", async () => {
    vi.stubEnv("MASTER_KEY", "master-key-office-0123456789");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-office-0123456789");
    try {
      const q = fakeQuery([result({ structured_output: LINES })]);
      await chatTalk(anthropicRuntime(ANTHROPIC_KEY), CALL, { queryFn: q.queryFn });
      const env = q.calls[0]!.options!.env!;
      expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "HOME", "LANG", "PATH"]);
      expect(env).toMatchObject({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, HOME: q.calls[0]!.options!.cwd, LANG: "C.UTF-8", PATH: process.env.PATH });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the owner's model, and another provider's small tier for the default", async () => {
    const q = fakeQuery([result({ structured_output: LINES })]);
    await chatTalk(anthropicRuntime(ANTHROPIC_KEY), { ...CALL, model: "claude-sonnet-5-5" }, { queryFn: q.queryFn });
    expect(q.calls[0]!.options!.model).toBe("claude-sonnet-5-5");
    const kimi = buildRuntime("kimi", { secrets: { apiKey: "sk-kimi-office-0123456789" }, settings: {}, models: {} });
    const k = fakeQuery([result({ structured_output: LINES })]);
    await chatTalk(kimi, CALL, { queryFn: k.queryFn });
    expect(k.calls[0]!.options!.model).toBe("haiku");
  });

  it("reports a failed or thrown call, keeping its cost", async () => {
    const failed = await chatTalk(anthropicRuntime(ANTHROPIC_KEY), CALL, {
      queryFn: fakeQuery([result({ subtype: "error_max_budget_usd", total_cost_usd: 0.05 })]).queryFn,
    });
    expect(failed).toMatchObject({ error: "error_max_budget_usd", costUsd: 0.05 });
    expect(failed.raw).toBeUndefined();
    const thrown = await chatTalk(anthropicRuntime(ANTHROPIC_KEY), CALL, { queryFn: fakeQuery(new Error("spawn failed")).queryFn });
    expect(thrown.error).toBe("spawn failed");
  });

  it("moves on along the light work route when a provider fails for its own reasons, counting every attempt", async () => {
    const kimi = buildRuntime("kimi", { secrets: { apiKey: "sk-kimi-office-0123456789" }, settings: {}, models: {} });
    const calls: (Options | undefined)[] = [];
    const answers: SDKMessage[][] = [
      [result({ is_error: true, api_error_status: 429, total_cost_usd: 0.0001 })],
      [result({ structured_output: LINES, total_cost_usd: 0.0007 })],
    ];
    const queryFn: QueryFn = (params) => {
      calls.push(params.options);
      const messages = answers[calls.length - 1] ?? [];
      return (async function* () {
        yield* messages;
      })();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await chatTalk([kimi, anthropicRuntime(ANTHROPIC_KEY)], CALL, { queryFn });
    warn.mockRestore();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-kimi-office-0123456789");
    expect(calls[1]!.env?.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
    expect(out).toMatchObject({ raw: LINES, provider: "anthropic" });
    expect(out.costUsd).toBeCloseTo(0.0008, 10);
    expect(out.error).toBeUndefined();

    // The work's own failure (a budget stop) is not the provider's: nobody else is asked.
    const budget = fakeQuery([result({ subtype: "error_max_budget_usd", total_cost_usd: 0.05 })]);
    const stopped = await chatTalk([kimi, anthropicRuntime(ANTHROPIC_KEY)], CALL, { queryFn: budget.queryFn });
    expect(budget.calls).toHaveLength(1);
    expect(stopped).toMatchObject({ error: "error_max_budget_usd", provider: "kimi" });
  });

  it("chooses the light work route, its first provider that is connected", () => {
    const c = config({ anthropic: true, provider: "chat" });
    c.ai.routes = { light: ["kimi", "anthropic"] };
    const choice = chooseTalkProvider(c);
    expect(choice?.id === "chat" && choice.runtimes.map((r) => r.provider)).toEqual(["anthropic"]);
    c.ai.providers.kimi = { secrets: { apiKey: "sk-kimi-office-0123456789" }, settings: {}, models: {} };
    const both = chooseTalkProvider(c);
    expect(both?.id === "chat" && [both.runtime.provider, ...both.runtimes.map((r) => r.provider)]).toEqual(["kimi", "kimi", "anthropic"]);
    expect(talkAvailability(c).chat).toBe(true);
  });
});
