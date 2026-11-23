/**
 * Gemini's answer as an Anthropic message, whole or as Messages API
 * server-sent events.
 *
 * - Text parts → text blocks; function calls → tool_use blocks with ids made
 *   here (toolu_ and random), their thought signature and Gemini's call id
 *   remembered for the next turn (sessions.ts). Thought parts are left out.
 * - finishReason → stop_reason: tool_use when the answer calls a function,
 *   max_tokens for MAX_TOKENS, end_turn otherwise. An answer Gemini stopped
 *   (safety, recitation, a malformed call) or a prompt it blocked ends the
 *   turn with a short line saying so, never as a refusal: Claude Code would
 *   blame Anthropic's usage policy.
 * - usageMetadata → usage: input_tokens without the cached part (and with
 *   built-in tools' prompt tokens), output_tokens with the thinking tokens
 *   (Google bills them as output), cache_read_input_tokens the cached part.
 * - The stream: message_start, then per block content_block_start, deltas
 *   (text_delta, input_json_delta with a call's whole arguments) and
 *   content_block_stop, then message_delta (stop_reason and the full usage:
 *   Gemini says the prompt's size only as it answers, and Claude Code takes
 *   input tokens from message_delta) and message_stop. Pings keep it alive
 *   while Gemini thinks.
 */
import { randomBytes } from "node:crypto";
import type { AnthropicErrorType } from "./errors.js";
import type { ToolCallMemory } from "./sessions.js";
import type { AnthropicMessage, AnthropicUsage, ResponseBlock, StopReason } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export const newId = (prefix: string): string => `${prefix}${randomBytes(18).toString("base64url")}`;

/** What translating an answer needs: the model to name, the tool names to restore, where to remember calls. */
export interface ResponseContext {
  model: string;
  /** Gemini function name → the tool's own name. */
  names: Map<string, string>;
  calls: ToolCallMemory;
}

export function usageFrom(meta: unknown): AnthropicUsage {
  const m = isObject(meta) ? meta : {};
  const cached = count(m.cachedContentTokenCount);
  return {
    input_tokens: Math.max(0, count(m.promptTokenCount) - cached) + count(m.toolUsePromptTokenCount),
    output_tokens: count(m.candidatesTokenCount) + count(m.thoughtsTokenCount),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

/** Finish reasons of an answer Gemini's filters stopped. */
const FILTERED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER"]);
const words = (reason: string) => reason.toLowerCase().replace(/_/g, " ");

/** The stop reason, and a line to add when Gemini stopped for its own reasons. */
export function stopFor(finishReason: string | undefined, calledTool: boolean, blockReason?: string): { stop: StopReason; note?: string } {
  if (blockReason) return { stop: "end_turn", note: `(Gemini blocked this request: ${words(blockReason)}.)` };
  if (calledTool) return { stop: "tool_use" };
  if (!finishReason || finishReason === "STOP" || finishReason === "FINISH_REASON_UNSPECIFIED") return { stop: "end_turn" };
  if (finishReason === "MAX_TOKENS") return { stop: "max_tokens" };
  if (FILTERED.has(finishReason)) return { stop: "end_turn", note: `(Gemini stopped this answer: ${words(finishReason)}.)` };
  return { stop: "end_turn", note: `(Gemini could not finish this answer: ${words(finishReason)}.)` };
}

interface CallPart {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
  signature?: string;
}

/** A part as what it adds to the answer: text, a call, or nothing (a thought, an empty part carrying a signature). */
function partOf(part: unknown): { text: string } | { call: CallPart } | undefined {
  if (!isObject(part) || part.thought === true) return undefined;
  if (isObject(part.functionCall) && typeof part.functionCall.name === "string") {
    const fc = part.functionCall;
    return {
      call: {
        name: fc.name as string,
        args: isObject(fc.args) ? fc.args : {},
        ...(typeof fc.id === "string" && fc.id ? { callId: fc.id } : {}),
        ...(typeof part.thoughtSignature === "string" && part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      },
    };
  }
  return typeof part.text === "string" && part.text ? { text: part.text } : undefined;
}

/** The first candidate's parts and finish reason, and why the prompt was blocked. */
function candidateOf(body: unknown): { parts: unknown[]; finishReason?: string; blockReason?: string } {
  const b = isObject(body) ? body : {};
  const candidate = Array.isArray(b.candidates) && isObject(b.candidates[0]) ? b.candidates[0] : {};
  const content = isObject(candidate.content) ? candidate.content : {};
  const feedback = isObject(b.promptFeedback) ? b.promptFeedback : {};
  return {
    parts: Array.isArray(content.parts) ? content.parts : [],
    ...(typeof candidate.finishReason === "string" ? { finishReason: candidate.finishReason } : {}),
    ...(typeof feedback.blockReason === "string" && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED" ? { blockReason: feedback.blockReason } : {}),
  };
}

/** A call as a tool_use block, remembering its signature and Gemini's id under the block's id. */
function toolUse(call: CallPart, ctx: ResponseContext): Extract<ResponseBlock, { type: "tool_use" }> {
  const id = newId("toolu_");
  ctx.calls.remember(id, { ...(call.signature ? { signature: call.signature } : {}), ...(call.callId ? { callId: call.callId } : {}) });
  return { type: "tool_use", id, name: ctx.names.get(call.name) ?? call.name, input: call.args };
}

/** generateContent's answer as an Anthropic message. */
export function translateResponse(body: unknown, ctx: ResponseContext): AnthropicMessage {
  const { parts, finishReason, blockReason } = candidateOf(body);
  const content: ResponseBlock[] = [];
  for (const raw of parts) {
    const part = partOf(raw);
    if (!part) continue;
    const last = content.at(-1);
    if ("text" in part) {
      if (last?.type === "text") last.text += part.text;
      else content.push({ type: "text", text: part.text });
    } else content.push(toolUse(part.call, ctx));
  }
  const { stop, note } = stopFor(finishReason, content.some((b) => b.type === "tool_use"), blockReason);
  if (note) content.push({ type: "text", text: note });
  return {
    id: newId("msg_"),
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usageFrom(isObject(body) ? body.usageMetadata : undefined),
  };
}

/** One server-sent event as Anthropic writes them. */
export const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * streamGenerateContent's chunks as Anthropic stream events. start() first,
 * push() for each chunk, end() once Gemini is done (or error() when it
 * failed half way); each returns the text to write.
 */
export class StreamTranslator {
  private index = -1;
  /** A block is open at `index`; a text block when textOpen. */
  private blockOpen = false;
  private textOpen = false;
  private calledTool = false;
  private finishReason?: string;
  private blockReason?: string;
  private usage: AnthropicUsage = usageFrom(undefined);
  private readonly id = newId("msg_");

  constructor(private readonly ctx: ResponseContext) {}

  start(): string {
    return sse("message_start", {
      type: "message_start",
      message: { id: this.id, type: "message", role: "assistant", model: this.ctx.model, content: [], stop_reason: null, stop_sequence: null, usage: this.usage },
    });
  }

  ping(): string {
    return sse("ping", { type: "ping" });
  }

  push(chunk: unknown): string {
    if (!isObject(chunk)) return "";
    if (isObject(chunk.usageMetadata)) this.usage = usageFrom(chunk.usageMetadata);
    const { parts, finishReason, blockReason } = candidateOf(chunk);
    if (finishReason) this.finishReason = finishReason;
    if (blockReason) this.blockReason = blockReason;
    let out = "";
    for (const raw of parts) {
      const part = partOf(raw);
      if (!part) continue;
      if ("text" in part) {
        if (!this.textOpen) out += this.begin({ type: "text", text: "" });
        out += this.textDelta(part.text);
      } else {
        const block = toolUse(part.call, this.ctx);
        out += this.begin({ ...block, input: {} });
        out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        out += this.finishBlock();
        this.calledTool = true;
      }
    }
    return out;
  }

  end(): string {
    let out = this.finishBlock();
    const { stop, note } = stopFor(this.finishReason, this.calledTool, this.blockReason);
    if (note) out += this.begin({ type: "text", text: "" }) + this.textDelta(note) + this.finishBlock();
    out += sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: this.usage });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  /** An error after the stream began: Anthropic's error event, after which the stream ends. */
  error(type: AnthropicErrorType, message: string): string {
    return sse("error", { type: "error", error: { type, message } });
  }

  /** Closes the open block, if any, and starts the next. */
  private begin(block: Record<string, unknown>): string {
    const out = this.finishBlock();
    this.index++;
    this.blockOpen = true;
    this.textOpen = block.type === "text";
    return out + sse("content_block_start", { type: "content_block_start", index: this.index, content_block: block });
  }

  private textDelta(text: string): string {
    return sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } });
  }

  private finishBlock(): string {
    if (!this.blockOpen) return "";
    this.blockOpen = false;
    this.textOpen = false;
    return sse("content_block_stop", { type: "content_block_stop", index: this.index });
  }
}
