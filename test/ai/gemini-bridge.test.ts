import { describe, expect, it } from "vitest";
import { BridgeError, geminiError, toBridgeError } from "../../src/ai/gemini-bridge/errors.js";
import { MAX_OUTPUT_TOKENS, SKIP_SIGNATURE, countTokensBody, geminiToolName, resolveModel, thinkingFor, translateRequest } from "../../src/ai/gemini-bridge/request.js";
import { StreamTranslator, stopFor, translateResponse } from "../../src/ai/gemini-bridge/response.js";
import { SessionRegistry, ToolCallMemory } from "../../src/ai/gemini-bridge/sessions.js";
import { type MessagesRequest, MessagesRequestSchema } from "../../src/ai/gemini-bridge/types.js";

const MODELS = { main: "gemini-4-carbon", opus: "gemini-4-carbon", sonnet: "gemini-4-neon", haiku: "gemini-3.5-flash-lite", subagent: "gemini-4-hydrogen" };
const session = () => ({ models: MODELS, calls: new ToolCallMemory() });
const req = (body: Record<string, unknown>): MessagesRequest => MessagesRequestSchema.parse({ model: "gemini-4-carbon", max_tokens: 1024, ...body });
const READ_TOOL = { name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } };

/** Anthropic's server-sent events as {event, data} pairs. */
function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .trim()
    .split("\n\n")
    .map((chunk) => {
      const [event, data] = chunk.split("\n");
      return { event: event!.replace(/^event: /, ""), data: JSON.parse(data!.replace(/^data: /, "")) as Record<string, unknown> };
    });
}

// ---------- Requests ----------

describe("Anthropic requests as Gemini requests", () => {
  it("turn system, text, images, documents, tool calls and results into Gemini contents", () => {
    const s = session();
    s.calls.remember("toolu_read", { signature: "sig-read", callId: "fc-1" });
    const t = translateRequest(
      req({
        system: [
          { type: "text", text: "You are Pointer.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Be brief." },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } },
              { type: "image", source: { type: "url", url: "https://example.com/a.webp?x=1" } },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
              { type: "document", title: "Notes", source: { type: "text", media_type: "text/plain", data: "Line one" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "claude-signature" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "Reading." },
              { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_read", content: "file text" },
              { type: "tool_result", tool_use_id: "toolu_grep", is_error: true, content: [{ type: "text", text: "no match" }] },
              { type: "text", text: "Go on" },
            ],
          },
        ],
        tools: [
          {
            name: "Read",
            description: "Reads a file",
            input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
          },
          { name: "Grep", description: "Searches", input_schema: { type: "object", properties: { pattern: { type: "string" } } } },
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ],
      }),
      s,
    );
    expect(t.model).toBe("gemini-4-carbon");
    expect(t.request.systemInstruction).toEqual({ parts: [{ text: "You are Pointer." }, { text: "Be brief." }] });
    expect(t.request.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Look at these" },
          { inlineData: { mimeType: "image/png", data: "iVBORw0=" } },
          { fileData: { mimeType: "image/webp", fileUri: "https://example.com/a.webp?x=1" } },
          { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } },
          { text: "Notes\n\nLine one" },
        ],
      },
      {
        role: "model",
        parts: [
          { text: "Reading." },
          // The signature this session remembered, on the step's first call; the second call has none (parallel calls).
          { functionCall: { id: "fc-1", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "sig-read" },
          { functionCall: { name: "Grep", args: { pattern: "x" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "fc-1", name: "Read", response: { output: "file text" } } },
          { functionResponse: { name: "Grep", response: { error: "no match" } } },
          { text: "Go on" },
        ],
      },
    ]);
    // Full JSON Schema, without the $schema marker; the server tool is left out.
    expect(t.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "Read",
            description: "Reads a file",
            parametersJsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
          },
          { name: "Grep", description: "Searches", parametersJsonSchema: { type: "object", properties: { pattern: { type: "string" } } } },
        ],
      },
    ]);
    expect(t.request.toolConfig).toBeUndefined();
    expect(t.request.generationConfig).toEqual({ maxOutputTokens: 1024 });
  });

  it("sign a step's first call with Google's skip value when its signature is not known (another provider's turn)", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
          { type: "tool_use", id: "toolu_b", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "a" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "b" },
        ],
      },
    ];
    const parts = translateRequest(req({ messages, tools: [READ_TOOL] }), session()).request.contents[1]!.parts;
    expect(parts[0]!.thoughtSignature).toBe(SKIP_SIGNATURE);
    expect(parts[1]!.thoughtSignature).toBeUndefined();
    // Gemini 2.x does not need one.
    const legacy = translateRequest(req({ model: "gemini-2.5-flash", messages, tools: [READ_TOOL] }), session()).request.contents[1]!.parts;
    expect(legacy[0]!.thoughtSignature).toBeUndefined();
    // One step sent as two assistant messages is one model turn, signed once.
    const split = [messages[0], { role: "assistant", content: [messages[1]!.content[0]] }, { role: "assistant", content: [messages[1]!.content[1]] }, messages[2]];
    const joined = translateRequest(req({ messages: split, tools: [READ_TOOL] }), session()).request.contents;
    expect(joined).toHaveLength(3);
    expect(joined[1]!.parts.map((p) => p.thoughtSignature)).toEqual([SKIP_SIGNATURE, undefined]);
  });

  it("put Claude Code's system messages among the turns into the system instruction, without its billing line", () => {
    const t = translateRequest(
      req({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=sdk-ts;" },
          { type: "text", text: "You are a Claude agent." },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "Reply OK", cache_control: { type: "ephemeral" } }] },
          { role: "system", content: "# Environment\nPlatform: linux" },
          { role: "user", content: "Thanks" },
        ],
      }),
      session(),
    );
    expect(t.request.systemInstruction).toEqual({ parts: [{ text: "You are a Claude agent." }, { text: "# Environment\nPlatform: linux" }] });
    expect(t.request.contents).toEqual([{ role: "user", parts: [{ text: "Reply OK" }, { text: "Thanks" }] }]);
  });

  it("put a tool result's images in its function response, and after it on Gemini 2.x", () => {
    const messages = [
      { role: "user", content: "shot" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_shot", name: "Read", input: { file_path: "a.png" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_shot",
            content: [
              { type: "text", text: "A screenshot" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } },
            ],
          },
        ],
      },
    ];
    const image = { inlineData: { mimeType: "image/png", data: "iVBORw0=" } };
    expect(translateRequest(req({ messages, tools: [READ_TOOL] }), session()).request.contents[2]!.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "A screenshot" }, parts: [image] } },
    ]);
    expect(translateRequest(req({ model: "gemini-2.5-flash", messages, tools: [READ_TOOL] }), session()).request.contents[2]!.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "A screenshot" } } },
      image,
    ]);
  });

  it("write earlier calls and results as text when the request declares no tools (Gemini refuses undeclared calls)", () => {
    const t = translateRequest(
      req({
        messages: [
          { role: "user", content: "summarize" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file text" }] },
        ],
      }),
      session(),
    );
    expect(t.request.tools).toBeUndefined();
    expect(t.request.contents[1]).toEqual({ role: "model", parts: [{ text: '[Called tool Read with {"file_path":"a.ts"}]' }] });
    expect(t.request.contents[2]).toEqual({ role: "user", parts: [{ text: "[Result of tool Read]\nfile text" }] });
  });

  it("join turns of the same role and leave out empty ones", () => {
    const t = translateRequest(
      req({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: [{ type: "thinking", thinking: "only thoughts", signature: "s" }] },
          { role: "user", content: "two" },
        ],
      }),
      session(),
    );
    expect(t.request.contents).toEqual([{ role: "user", parts: [{ text: "one" }, { text: "two" }] }]);
    expect(() => translateRequest(req({ messages: [{ role: "user", content: [] }] }), session())).toThrow(BridgeError);
  });

  it("map tool_choice to function calling modes", () => {
    const choose = (tool_choice: Record<string, unknown>) =>
      translateRequest(req({ messages: [{ role: "user", content: "hi" }], tools: [READ_TOOL], tool_choice }), session()).request.toolConfig;
    expect(choose({ type: "auto" })).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(choose({ type: "any" })).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(choose({ type: "none" })).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(choose({ type: "tool", name: "Read" })).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] } });
  });

  it("carry the generation settings, within Gemini's limits", () => {
    const t = translateRequest(
      req({
        max_tokens: 200_000,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["a", "b", "", "c", "d", "e", "f"],
        output_config: { effort: "high", format: { type: "json_schema", schema: { $schema: "x", type: "object", properties: { size: { type: "string" } } } } },
        messages: [{ role: "user", content: "hi" }],
      }),
      session(),
    );
    expect(t.request.generationConfig).toEqual({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      stopSequences: ["a", "b", "c", "d", "e"],
      thinkingConfig: { thinkingLevel: "high" },
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: { size: { type: "string" } } },
    });
  });

  it("map effort and thinking to Gemini's thinking levels (and 2.x budgets)", () => {
    expect(thinkingFor("gemini-4-carbon", { output_config: { effort: "low" } })).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-4-carbon", { output_config: { effort: "medium" } })).toEqual({ thinkingLevel: "medium" });
    // xhigh and max: xhigh where the model has it, high elsewhere.
    expect(thinkingFor("gemini-4-carbon", { output_config: { effort: "max" } })).toEqual({ thinkingLevel: "high" });
    expect(thinkingFor("gemini-4-neon", { output_config: { effort: "max" } })).toEqual({ thinkingLevel: "xhigh" });
    expect(thinkingFor("gemini-4-hydrogen", { output_config: { effort: "xhigh" } })).toEqual({ thinkingLevel: "xhigh" });
    expect(thinkingFor("gemini-3.8-flash", { output_config: { effort: "xhigh" } })).toEqual({ thinkingLevel: "high" });
    // Thinking off: the lowest level (Gemini 4 always thinks).
    expect(thinkingFor("gemini-4-carbon", { thinking: { type: "disabled" }, output_config: { effort: "high" } })).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-3.5-flash-lite", { thinking: { type: "disabled" } })).toEqual({ thinkingLevel: "minimal" });
    expect(thinkingFor("gemini-3.8-flash", { thinking: { type: "disabled" } })).toEqual({ thinkingLevel: "low" });
    // A budget with no effort.
    expect(thinkingFor("gemini-4-carbon", { thinking: { type: "enabled", budget_tokens: 2000 } })).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-4-carbon", { thinking: { type: "enabled", budget_tokens: 10_000 } })).toEqual({ thinkingLevel: "medium" });
    expect(thinkingFor("gemini-4-carbon", { thinking: { type: "enabled", budget_tokens: 31_999 } })).toEqual({ thinkingLevel: "high" });
    // Adaptive, or nothing said: the model's default.
    expect(thinkingFor("gemini-4-carbon", { thinking: { type: "adaptive" } })).toBeUndefined();
    expect(thinkingFor("gemini-4-carbon", {})).toBeUndefined();
    // Gemini 2.x: a budget; 2.5 Pro cannot stop thinking.
    expect(thinkingFor("gemini-2.5-flash", { output_config: { effort: "medium" } })).toEqual({ thinkingBudget: 8192 });
    expect(thinkingFor("gemini-2.5-flash", { thinking: { type: "disabled" } })).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor("gemini-2.5-pro", { thinking: { type: "disabled" } })).toBeUndefined();
    // Not a Gemini model: no thinkingConfig, which Gemini refuses for models that do not think.
    expect(thinkingFor("gemma-4-27b-it", { output_config: { effort: "high" } })).toBeUndefined();
  });

  it("run Gemini ids as they are and Claude ids on the session's tier models, refusing anything else", () => {
    expect(resolveModel("gemini-4-argon", MODELS)).toBe("gemini-4-argon");
    expect(resolveModel("models/gemini-4-argon", MODELS)).toBe("gemini-4-argon");
    expect(resolveModel("claude-opus-5-5", MODELS)).toBe("gemini-4-carbon");
    expect(resolveModel("claude-sonnet-5-5[1m]", MODELS)).toBe("gemini-4-neon");
    expect(resolveModel("haiku", MODELS)).toBe("gemini-3.5-flash-lite");
    expect(resolveModel("claude-fable-5-2", MODELS)).toBe("gemini-4-carbon");
    expect(resolveModel("anthropic/claude-next", MODELS)).toBe("gemini-4-carbon");
    for (const bad of ["../../v1/files", "gemini-4-carbon?key=x", "gemini 4", "a/b"]) expect(() => resolveModel(bad, MODELS), bad).toThrow(BridgeError);
  });

  it("give tools Gemini cannot name a stable name, and restore the tool's own in the answer", () => {
    expect(geminiToolName("mcp__engines__gemini_run_as_gemini-2")).toBe("mcp__engines__gemini_run_as_gemini-2");
    const long = `mcp__acme__${"x".repeat(80)}`;
    const mapped = geminiToolName(long);
    expect(mapped).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    expect(geminiToolName(long)).toBe(mapped);
    expect(geminiToolName("acme.search")).toMatch(/^acme_search_[0-9a-f]{8}$/);
    const s = session();
    const t = translateRequest(req({ messages: [{ role: "user", content: "hi" }], tools: [{ name: long, input_schema: { type: "object" } }] }), s);
    expect(t.request.tools?.[0]?.functionDeclarations[0]?.name).toBe(mapped);
    const answer = translateResponse({ candidates: [{ content: { parts: [{ functionCall: { name: mapped, args: {} } }] }, finishReason: "STOP" }] }, { model: t.model, names: t.names, calls: s.calls });
    expect(answer.content[0]).toMatchObject({ type: "tool_use", name: long });
  });

  it("count the prompt with countTokens' generateContentRequest", () => {
    const t = translateRequest(req({ system: "Be brief.", messages: [{ role: "user", content: "hi" }], tools: [READ_TOOL], output_config: { effort: "low" } }), session());
    expect(countTokensBody(t)).toEqual({
      generateContentRequest: {
        model: "models/gemini-4-carbon",
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "Be brief." }] },
        tools: t.request.tools,
      },
    });
  });
});

// ---------- Answers ----------

describe("Gemini answers as Anthropic messages", () => {
  it("turn parts into text and tool_use blocks, leave thoughts out, and remember each call's signature", () => {
    const calls = new ToolCallMemory();
    const message = translateResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "planning…", thought: true },
                { text: "Let me " },
                { text: "look." },
                { functionCall: { id: "fc-9", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "sig-9" },
                { functionCall: { name: "Grep", args: { pattern: "x" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 60, totalTokenCount: 1300 },
      },
      { model: "gemini-4-carbon", names: new Map(), calls },
    );
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      model: "gemini-4-carbon",
      stop_reason: "tool_use",
      stop_sequence: null,
      // Input without the cached part; output with the thinking.
      usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    });
    expect(message.id).toMatch(/^msg_/);
    expect(message.content.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(message.content[0]).toEqual({ type: "text", text: "Let me look." });
    const [read, grep] = message.content.slice(1) as { id: string; name: string; input: unknown }[];
    expect(read!.id).toMatch(/^toolu_[A-Za-z0-9_-]{20,}$/);
    expect(read).toMatchObject({ name: "Read", input: { file_path: "a.ts" } });
    expect(calls.recall(read!.id)).toEqual({ signature: "sig-9", callId: "fc-9" });
    expect(calls.recall(grep!.id)).toBeUndefined();
  });

  it("map finish reasons, saying so when Gemini stopped or blocked the answer", () => {
    expect(stopFor("STOP", false)).toEqual({ stop: "end_turn" });
    expect(stopFor("MAX_TOKENS", false)).toEqual({ stop: "max_tokens" });
    expect(stopFor("STOP", true)).toEqual({ stop: "tool_use" });
    expect(stopFor("SAFETY", false)).toEqual({ stop: "end_turn", note: "(Gemini stopped this answer: safety.)" });
    expect(stopFor("MALFORMED_FUNCTION_CALL", false)).toEqual({ stop: "end_turn", note: "(Gemini could not finish this answer: malformed function call.)" });
    const blocked = translateResponse(
      { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 10 } },
      { model: "gemini-4-carbon", names: new Map(), calls: new ToolCallMemory() },
    );
    expect(blocked).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "(Gemini blocked this request: prohibited content.)" }],
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  });

  it("send a call's thought signature and id back on the next turn (round trip)", () => {
    const s = session();
    const first = translateRequest(req({ messages: [{ role: "user", content: "read a.ts" }], tools: [READ_TOOL] }), s);
    const answer = translateResponse(
      { candidates: [{ content: { parts: [{ functionCall: { id: "fc-1", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "opaque-sig" }] }, finishReason: "STOP" }] },
      { model: first.model, names: first.names, calls: s.calls },
    );
    const call = answer.content[0] as { id: string };
    const next = translateRequest(
      req({
        messages: [
          { role: "user", content: "read a.ts" },
          { role: "assistant", content: answer.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "export {}" }] },
        ],
        tools: [READ_TOOL],
      }),
      s,
    );
    expect(next.request.contents[1]).toEqual({ role: "model", parts: [{ functionCall: { id: "fc-1", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "opaque-sig" }] });
    expect(next.request.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "fc-1", name: "Read", response: { output: "export {}" } } }] });
  });
});

describe("Gemini's stream as Anthropic's events", () => {
  it("send message_start, each block's start, deltas and stop, then the stop reason with the full usage, and message_stop", () => {
    const calls = new ToolCallMemory();
    const stream = new StreamTranslator({ model: "gemini-4-neon", names: new Map([["Read", "Read"]]), calls });
    let text = stream.start();
    text += stream.push({ candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: { promptTokenCount: 50 } });
    text += stream.push({ candidates: [{ content: { parts: [{ text: "lo" }, { text: "a thought", thought: true }, { text: "", thoughtSignature: "text-sig" }] } }] });
    text += stream.push({
      candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { file_path: "a" } }, thoughtSignature: "sig-s" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    });
    text += stream.end();
    const events = parseSse(text);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    for (const e of events) expect(e.data.type).toBe(e.event);
    expect(events[0]!.data.message).toMatchObject({ type: "message", role: "assistant", model: "gemini-4-neon", content: [], stop_reason: null });
    expect(events[1]!.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(events[2]!.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
    expect(events[3]!.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
    expect(events[4]!.data).toEqual({ type: "content_block_stop", index: 0 });
    const block = events[5]!.data.content_block as { id: string };
    expect(events[5]!.data).toMatchObject({ index: 1, content_block: { type: "tool_use", name: "Read", input: {} } });
    expect(events[6]!.data).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' } });
    expect(events[7]!.data).toEqual({ type: "content_block_stop", index: 1 });
    expect(events[8]!.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    expect(calls.recall(block.id)).toEqual({ signature: "sig-s" });
  });

  it("end a stream Gemini stopped with a line saying why", () => {
    const stream = new StreamTranslator({ model: "gemini-4-neon", names: new Map(), calls: new ToolCallMemory() });
    const events = parseSse(stream.start() + stream.push({ candidates: [{ finishReason: "RECITATION" }] }) + stream.end());
    expect(events.map((e) => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(events[2]!.data.delta).toEqual({ type: "text_delta", text: "(Gemini stopped this answer: recitation.)" });
    expect((events[4]!.data.delta as { stop_reason: string }).stop_reason).toBe("end_turn");
    expect(parseSse(stream.error("overloaded_error", "busy"))).toEqual([{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "busy" } } }]);
  });
});

// ---------- Errors ----------

describe("Gemini's errors as Anthropic's", () => {
  const KEY = "AQ.Ab8-errors-test-key-0123456789";
  const redact = (text: string) => text.split(KEY).join("[redacted]");

  it("keep the status Claude Code and the routing act on", () => {
    const cases: [number, unknown, number, string][] = [
      [400, { error: { code: 400, message: "Invalid value at 'contents'", status: "INVALID_ARGUMENT" } }, 400, "invalid_request_error"],
      [
        400,
        { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } },
        401,
        "authentication_error",
      ],
      [401, { error: { code: 401, message: "Unauthenticated", status: "UNAUTHENTICATED" } }, 401, "authentication_error"],
      [402, { error: { code: "payment_required", message: "Prepay credits are used up" } }, 402, "billing_error"],
      [403, { error: { code: 403, message: "Your API key was reported as leaked.", status: "PERMISSION_DENIED" } }, 403, "permission_error"],
      [404, { error: { code: 404, message: "models/gemini-9 is not found", status: "NOT_FOUND" } }, 404, "not_found_error"],
      [429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429, "rate_limit_error"],
      [500, { error: { code: 500, message: "Internal error", status: "INTERNAL" } }, 500, "api_error"],
      [503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 529, "overloaded_error"],
      [504, { error: { code: 504, message: "Deadline exceeded", status: "DEADLINE_EXCEEDED" } }, 504, "timeout_error"],
      [409, { error: { code: 409, message: "Aborted", status: "ABORTED" } }, 400, "invalid_request_error"],
      [502, "<html>Bad gateway</html>", 500, "api_error"],
    ];
    for (const [status, body, code, type] of cases) {
      const e = geminiError(status, body, redact);
      expect([e.status, e.type], `${status} ${JSON.stringify(body).slice(0, 60)}`).toEqual([code, type]);
    }
    const limited = geminiError(429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "32.5s" }] } }, redact);
    // routing.ts's errorFailure reads RESOURCE_EXHAUSTED; Claude Code waits as long as retry-after says.
    expect(limited.message).toContain("RESOURCE_EXHAUSTED");
    expect(limited.headers).toEqual({ "retry-after": "33" });
    expect(geminiError(503, {}, redact, "7").headers).toEqual({ "retry-after": "7" });
  });

  it("never repeat the key", () => {
    expect(geminiError(400, { error: { message: `bad key ${KEY}` } }, redact).message).not.toContain(KEY);
    expect(toBridgeError(new Error(`connect failed for ${KEY}`), redact).message).not.toContain(KEY);
  });

  it("turn a timeout and an unreachable Gemini into a timeout and a server error", () => {
    expect(toBridgeError(new DOMException("late", "TimeoutError"))).toMatchObject({ status: 504, type: "timeout_error" });
    expect(toBridgeError(new Error("ECONNRESET"))).toMatchObject({ status: 500, type: "api_error" });
  });
});

// ---------- Sessions ----------

describe("bridge sessions", () => {
  it("issue a random token per session, find it, and forget it when the session ends", () => {
    const registry = new SessionRegistry();
    const a = registry.open("AQ.key-a-0123456789", MODELS);
    const b = registry.open("AQ.key-b-0123456789", MODELS);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^gbr_[A-Za-z0-9_-]{43}$/);
    expect(registry.authenticate(a.token)?.apiKey).toBe("AQ.key-a-0123456789");
    expect(registry.authenticate(`${a.token}x`)).toBeUndefined();
    expect(registry.authenticate(a.token.slice(0, -1))).toBeUndefined();
    expect(registry.authenticate(undefined)).toBeUndefined();
    expect(registry.authenticate("")).toBeUndefined();
    a.close();
    expect(registry.authenticate(a.token)).toBeUndefined();
    expect(registry.size).toBe(1);
    const s = registry.authenticate(b.token)!;
    expect(s.models).toEqual(MODELS);
    expect(s.redact(`key AQ.key-b-0123456789 token ${b.token}`)).toBe("key [redacted] token [redacted]");
  });

  it("keep a bounded number of tool calls, forgetting the oldest first", () => {
    const memory = new ToolCallMemory(3, 1000);
    for (const i of [1, 2, 3, 4]) memory.remember(`toolu_${i}`, { signature: `sig-${i}` });
    expect(memory.size).toBe(3);
    expect(memory.recall("toolu_1")).toBeUndefined();
    expect(memory.recall("toolu_4")).toEqual({ signature: "sig-4" });
    // Bounded in size too.
    const small = new ToolCallMemory(100, 10);
    small.remember("a", { signature: "123456" });
    small.remember("b", { signature: "abcdef" });
    expect(small.recall("a")).toBeUndefined();
    expect(small.recall("b")).toEqual({ signature: "abcdef" });
    // Nothing to remember: nothing kept.
    memory.remember("toolu_x", {});
    expect(memory.recall("toolu_x")).toBeUndefined();
  });
});
