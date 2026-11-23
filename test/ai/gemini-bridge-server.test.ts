import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeHandle, GeminiBridge, type GeminiBridgeOptions } from "../../src/ai/gemini-bridge/server.js";

const KEY = "AQ.Ab8-bridge-server-test-key-0123456789";
const MODELS = { main: "gemini-4-carbon", opus: "gemini-4-carbon", sonnet: "gemini-4-neon", haiku: "gemini-3.5-flash-lite", subagent: "gemini-4-hydrogen" };

interface UpstreamCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

/** A fake Gemini API: records each call, answers with `reply`. No network. */
function fakeGemini(reply: (call: UpstreamCall) => Response | Promise<Response>) {
  const calls: UpstreamCall[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal };
    calls.push(call);
    return reply(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Gemini's alt=sse stream of these chunks, cut into small pieces so events straddle reads. */
function sseResponse(chunks: unknown[], opts: { piece?: number; hangAfter?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""));
  const piece = opts.piece ?? 7;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += piece) controller.enqueue(bytes.slice(at, at + piece));
        if (!opts.hangAfter) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .trim()
    .split("\n\n")
    .map((chunk) => {
      const [event, data] = chunk.split("\n");
      return { event: event!.replace(/^event: /, ""), data: JSON.parse(data!.replace(/^data: /, "")) as Record<string, unknown> };
    });
}

let bridges: GeminiBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.map((b) => b.close()));
  bridges = [];
});

async function startBridge(reply: Parameters<typeof fakeGemini>[0], opts: Omit<GeminiBridgeOptions, "fetch"> = {}) {
  const upstream = fakeGemini(reply);
  const logs: string[] = [];
  const bridge = new GeminiBridge({ fetch: upstream.fetch, log: (line) => logs.push(line), ...opts });
  bridges.push(bridge);
  const handle = await bridge.open(KEY, MODELS);
  return { bridge, handle, upstream, logs };
}

const post = (handle: BridgeHandle, path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`${handle.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

/** A raw request, for headers fetch will not let a test set (Host). */
function rawRequest(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

const GEMINI_TEXT = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, thoughtsTokenCount: 2 },
});

describe("the Gemini bridge, end to end with a fake Gemini", () => {
  it("answers an Anthropic request through generateContent, with the key in a header and a Claude alias on its tier's model", async () => {
    const { handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")));
    const res = await post(handle, "/v1/messages?beta=true", { model: "claude-sonnet-5-5", max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "Reply OK" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("request-id")).toMatch(/^req_/);
    expect(await res.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "gemini-4-neon",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
    expect(call.url).not.toContain(KEY);
    expect(call.headers.get("x-goog-api-key")).toBe(KEY);
    expect(call.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
      systemInstruction: { parts: [{ text: "Be brief." }] },
      generationConfig: { maxOutputTokens: 100 },
    });
  });

  it("streams Anthropic events from streamGenerateContent, and sends the call's thought signature back on the next turn", async () => {
    const { handle, upstream } = await startBridge((call) =>
      call.url.includes(":streamGenerateContent")
        ? sseResponse([
            { candidates: [{ content: { role: "model", parts: [{ text: "Reading the file." }] } }], usageMetadata: { promptTokenCount: 30 } },
            {
              candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fc-7", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "sig-e2e" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9, thoughtsTokenCount: 11 },
            },
          ])
        : json(GEMINI_TEXT("Done.")),
    );
    const tools = [{ name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }];
    const first = [{ role: "user", content: "Read a.ts" }];
    const res = await post(handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 1000, stream: true, messages: first, tools, output_config: { effort: "max" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2]!.data.delta).toEqual({ type: "text_delta", text: "Reading the file." });
    const toolUse = events[4]!.data.content_block as { id: string; name: string };
    expect(toolUse.name).toBe("Read");
    expect(events[5]!.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"file_path":"a.ts"}' });
    expect(events[7]!.data).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 30, output_tokens: 20 } });
    expect(upstream.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse");
    // max effort on Carbon: its highest level.
    expect(upstream.calls[0]!.body.generationConfig).toEqual({ maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: "high" } });

    // Claude Code sends the turn back with the tool's result.
    const second = await post(handle, "/v1/messages", {
      model: "gemini-4-carbon",
      max_tokens: 1000,
      tools,
      messages: [
        ...first,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file." },
            { type: "tool_use", id: toolUse.id, name: "Read", input: { file_path: "a.ts" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "export {}" }] },
      ],
    });
    expect(await second.json()).toMatchObject({ content: [{ type: "text", text: "Done." }] });
    const contents = upstream.calls[1]!.body.contents as unknown[];
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Reading the file." }, { functionCall: { id: "fc-7", name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "sig-e2e" }],
    });
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "fc-7", name: "Read", response: { output: "export {}" } } }] });
  });

  it("counts tokens with Gemini's countTokens", async () => {
    const { handle, upstream } = await startBridge(() => json({ totalTokens: 321 }));
    const res = await post(handle, "/v1/messages/count_tokens?beta=true", { model: "claude-haiku-5-5", system: "Be brief.", messages: [{ role: "user", content: "hi" }] });
    expect(await res.json()).toEqual({ input_tokens: 321 });
    expect(upstream.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:countTokens");
    expect(upstream.calls[0]!.body).toEqual({
      generateContentRequest: { model: "models/gemini-3.5-flash-lite", contents: [{ role: "user", parts: [{ text: "hi" }] }], systemInstruction: { parts: [{ text: "Be brief." }] } },
    });
  });

  it("answers Gemini's errors as Anthropic's, with the status routing and Claude Code act on, never with the key", async () => {
    const replies: Record<string, Response> = {};
    const { handle, logs } = await startBridge((call) => replies[String((call.body.contents as { parts: { text: string }[] }[])[0]!.parts[0]!.text)]!);
    const ask = async (text: string, stream = false) => {
      const res = await post(handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, stream, messages: [{ role: "user", content: text }] });
      return { status: res.status, retryAfter: res.headers.get("retry-after"), type: res.headers.get("content-type"), body: (await res.json()) as { type: string; error: { type: string; message: string } } };
    };
    replies.limited = json({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "20s" }] } }, 429);
    expect(await ask("limited")).toMatchObject({ status: 429, retryAfter: "20", body: { type: "error", error: { type: "rate_limit_error", message: expect.stringContaining("RESOURCE_EXHAUSTED") } } });
    replies.busy = json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503);
    // A stream that fails before it starts is a plain error answer.
    expect(await ask("busy", true)).toMatchObject({ status: 529, type: "application/json", body: { error: { type: "overloaded_error" } } });
    replies.badkey = json({ error: { code: 400, message: `API key not valid: ${KEY}`, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, 400);
    const badKey = await ask("badkey");
    expect(badKey).toMatchObject({ status: 401, body: { error: { type: "authentication_error" } } });
    expect(JSON.stringify(badKey)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(handle.token);
  });

  it("ends a stream that fails half way with Anthropic's error event", async () => {
    const { handle } = await startBridge(() =>
      sseResponse([{ candidates: [{ content: { parts: [{ text: "Hal" }] } }] }, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }]),
    );
    const res = await post(handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] });
    const events = parseSse(await res.text());
    expect(events.at(-1)).toEqual({ event: "error", data: { type: "error", error: { type: "overloaded_error", message: expect.stringContaining("UNAVAILABLE") } } });
  });

  it("times out a Gemini call that does not answer, and a stream that stops sending", async () => {
    const hang = (call: UpstreamCall) =>
      new Promise<Response>((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true }));
    const slow = await startBridge(hang, { timeoutMs: 50 });
    const res = await post(slow.handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { type: "timeout_error" } });

    const stalled = await startBridge(() => sseResponse([{ candidates: [{ content: { parts: [{ text: "Hal" }] } }] }], { hangAfter: true }), { idleTimeoutMs: 50, pingMs: 10 });
    const stream = await post(stalled.handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] });
    const events = parseSse(await stream.text());
    expect(events.at(-1)!.data).toMatchObject({ type: "error", error: { type: "timeout_error" } });
  });

  it("starts the stream and pings while Gemini thinks, and then reports a failure as the stream's error event", async () => {
    const later = (reply: () => Response) => async () => {
      await new Promise((r) => setTimeout(r, 80));
      return reply();
    };
    const body = { model: "gemini-4-carbon", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] };
    const slow = await startBridge(later(() => sseResponse([GEMINI_TEXT("Hi")])), { streamStartMs: 10, pingMs: 10 });
    const events = parseSse(await (await post(slow.handle, "/v1/messages", body)).text()).map((e) => e.event);
    expect(events[0]).toBe("message_start");
    expect(events[1]).toBe("ping");
    expect(events.slice(events.indexOf("content_block_start"))).toEqual(["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);

    const failing = await startBridge(later(() => json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503)), { streamStartMs: 10, pingMs: 10 });
    const res = await post(failing.handle, "/v1/messages", body);
    expect(res.status).toBe(200);
    const failed = parseSse(await res.text());
    expect(failed[0]!.event).toBe("message_start");
    expect(failed.at(-1)).toEqual({ event: "error", data: { type: "error", error: { type: "overloaded_error", message: expect.stringContaining("UNAVAILABLE") } } });
  });

  it("stops the Gemini call when Claude Code hangs up", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const { handle } = await startBridge(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = call.signal;
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const client = new AbortController();
    const pending = post(handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, {}, client.signal).catch(() => undefined);
    await expect.poll(() => upstreamSignal).toBeTruthy();
    client.abort();
    await pending;
    await expect.poll(() => upstreamSignal?.aborted).toBe(true);
  });
});

describe("who the Gemini bridge answers", () => {
  it("needs a live session's token, as a Bearer token or x-api-key, and never calls Gemini without one", async () => {
    const { bridge, handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")));
    const body = { model: "gemini-4-carbon", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const noToken = await fetch(`${handle.baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toEqual({ type: "error", error: { type: "authentication_error", message: expect.any(String) } });
    expect((await post(handle, "/v1/messages", body, { authorization: `Bearer ${handle.token}x` })).status).toBe(401);
    expect((await post(handle, "/v1/messages", body, { authorization: "", "x-api-key": handle.token })).status).toBe(200);
    // A second session has its own token; ending one leaves the other.
    const other = await bridge.open(KEY, MODELS);
    handle.close();
    expect((await post(handle, "/v1/messages", body)).status).toBe(401);
    expect((await post(other, "/v1/messages", body)).status).toBe(200);
    expect(upstream.calls).toHaveLength(2);
  });

  it("answers only POST /v1/messages and /v1/messages/count_tokens", async () => {
    const { handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")));
    const models = await fetch(`${handle.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(models.status).toBe(404);
    expect(await models.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    expect((await post(handle, "/v1/messages/batches", {})).status).toBe(404);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses browsers, other Host names and bodies over the limit", async () => {
    const { handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")), { maxBodyBytes: 1024 });
    const port = Number(new URL(handle.baseUrl).port);
    const auth = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    expect((await rawRequest(port, { ...auth, host: `127.0.0.1:${port}` })).status).toBe(400);
    expect((await rawRequest(port, { ...auth, host: `localhost:${port}` })).status).toBe(400);
    expect((await rawRequest(port, { ...auth, host: `attacker.example:${port}` })).status).toBe(403);
    expect((await rawRequest(port, { ...auth, host: `127.0.0.1:${port}`, origin: "https://attacker.example" })).status).toBe(403);
    const big = await post(handle, "/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(4096) }] });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { type: "request_too_large" } });
    expect(upstream.calls).toEqual([]);
  });

  it("listens on 127.0.0.1 only", async () => {
    const { handle } = await startBridge(() => json(GEMINI_TEXT("OK")));
    const url = new URL(handle.baseUrl);
    expect(url.hostname).toBe("127.0.0.1");
    // On this machine's other addresses the port is closed.
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a!.address);
    for (const address of others.slice(0, 2)) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: address, port: Number(url.port) });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve(true);
        });
      });
      expect(refused, address).toBe(true);
    }
  });

  it("refuses a malformed request before calling Gemini", async () => {
    const { handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")));
    const notJson = await post(handle, "/v1/messages", "{nope");
    expect(notJson.status).toBe(400);
    const noMax = await post(handle, "/v1/messages", { model: "gemini-4-carbon", messages: [{ role: "user", content: "hi" }] });
    expect(await noMax.json()).toMatchObject({ error: { type: "invalid_request_error", message: "max_tokens: Field required" } });
    const badModel = await post(handle, "/v1/messages", { model: "../files", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    expect(badModel.status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });
});

describe("a session's limits on the Gemini bridge", () => {
  const ask = { model: "gemini-4-carbon", max_tokens: 5, messages: [{ role: "user", content: "hi" }] };

  it("answers 429 past the requests a session may have in flight, and frees a place when one ends", async () => {
    // Gemini holds every call until the test lets it answer.
    const held: (() => void)[] = [];
    const { bridge, handle, upstream } = await startBridge(
      () =>
        new Promise<Response>((resolve) => {
          held.push(() => resolve(json(GEMINI_TEXT("OK"))));
        }),
      { maxConcurrent: 2 },
    );
    const first = post(handle, "/v1/messages", ask);
    const second = post(handle, "/v1/messages", { ...ask, stream: true });
    await expect.poll(() => upstream.calls.length).toBe(2);

    const third = await post(handle, "/v1/messages/count_tokens", { model: "gemini-4-carbon", messages: [{ role: "user", content: "hi" }] });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("1");
    expect(await third.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "This session already has 2 requests in progress on the Gemini bridge. Try again when one has finished." },
    });
    expect(upstream.calls).toHaveLength(2);

    // Another session is not held by this one's.
    const other = await bridge.open(KEY, MODELS);
    const elsewhere = post(other, "/v1/messages", ask);
    await expect.poll(() => upstream.calls.length).toBe(3);

    for (const release of held.splice(0)) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await elsewhere).status).toBe(200);
    // Both places are free again.
    const after = post(handle, "/v1/messages", ask);
    await expect.poll(() => held.length).toBe(1);
    held.pop()!();
    expect((await after).status).toBe(200);
  });

  it("answers 429 without a retry once a session has made the requests it may make in all", async () => {
    const { bridge, handle, upstream } = await startBridge(() => json(GEMINI_TEXT("OK")), { maxRequests: 2 });
    expect((await post(handle, "/v1/messages", ask)).status).toBe(200);
    // A refused request counts too: the limit is on what the token asks for.
    expect((await post(handle, "/v1/messages", "{nope")).status).toBe(400);
    const over = await post(handle, "/v1/messages", ask);
    expect(over.status).toBe(429);
    expect(over.headers.get("x-should-retry")).toBe("false");
    expect(await over.json()).toMatchObject({ error: { type: "rate_limit_error", message: "This session has made the 2 requests the Gemini bridge allows one session." } });
    expect(upstream.calls).toHaveLength(1);
    // A new session starts with its own count.
    expect((await post(await bridge.open(KEY, MODELS), "/v1/messages", ask)).status).toBe(200);
  });
});
