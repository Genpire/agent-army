/**
 * An Anthropic Messages request as a Gemini generateContent request.
 *
 * - system, and the system messages Claude Code puts among the turns (its
 *   environment), → systemInstruction (Gemini has no system turns; a turn of
 *   its own could also split a call from its result). Claude Code's billing
 *   header line is left out. User and assistant turns → user and model
 *   contents. Text, images (base64, or a URL as fileData), documents (a
 *   base64 PDF, plain text, or a URL) pass; thinking blocks, server tool
 *   blocks (web search) and cache_control are left out.
 * - tool_use → functionCall, with its thought signature and Gemini call id
 *   when this session made it (sessions.ts). A step's first call with no
 *   known signature (a turn another provider answered, a signature forgotten)
 *   gets the value Google documents for calls Gemini did not make, so the
 *   request is not refused. tool_result → functionResponse ({output} or
 *   {error}), named after the tool_use it answers; its images go in the
 *   response's own parts (Gemini 3 and later).
 * - tools → functionDeclarations with the full JSON Schema
 *   (parametersJsonSchema; Gemini ignores keywords it does not support).
 *   Server tools (web search, code execution) are left out. Without tools,
 *   earlier calls and results become text: Gemini refuses function parts
 *   that no declaration covers.
 * - tool_choice → functionCallingConfig; max_tokens (at most Gemini's
 *   65,536), temperature, top_p, top_k, stop_sequences (at most 5) →
 *   generationConfig; output_config.format → responseJsonSchema.
 * - Effort and thinking → thinkingConfig (thinkingFor below).
 * - The model: a Gemini id passes; a Claude id or alias that reaches the
 *   bridge runs on the session's model for its tier.
 */
import { createHash } from "node:crypto";
import type { ModelTier } from "../../core/config.js";
import { BridgeError } from "./errors.js";
import type { BridgeSession } from "./sessions.js";
import type { AnthropicBlock, FunctionDeclaration, GeminiContent, GeminiPart, GeminiRequest, GenerationConfig, MessagesRequest, ThinkingLevel } from "./types.js";

/** Gemini's largest default output (Gemini 4 and 3.x Flash); a larger max_tokens is cut to it. */
export const MAX_OUTPUT_TOKENS = 65_536;
/** Google's value for a function call Gemini did not make (thought-signatures docs). */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---------- The model ----------

/** A Gemini model id as it may go into the request's path. */
const GEMINI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CLAUDE_ALIAS_RE = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)(?:$|-|\[)/;
const ALIAS_TIER: Record<string, ModelTier> = { opus: "opus", fable: "opus", mythos: "opus", sonnet: "sonnet", haiku: "haiku" };

/** The Gemini model a request runs on (see the file comment). */
export function resolveModel(requested: string, models: Readonly<Record<ModelTier, string>>): string {
  let id = requested.trim().replace(/^models\//, "").replace(/\[1m\]$/i, "");
  const lower = id.toLowerCase();
  const alias = lower.match(CLAUDE_ALIAS_RE)?.[1];
  if (alias || /(?:^|[./])claude/.test(lower)) {
    const tier: ModelTier = alias ? (ALIAS_TIER[alias] ?? "main") : "main";
    id = (models[tier] || models.main || models.opus || models.sonnet || "").replace(/\[1m\]$/i, "");
  }
  if (!GEMINI_MODEL_RE.test(id)) throw new BridgeError(400, "invalid_request_error", `model: "${requested.slice(0, 80)}" is not a Gemini model id.`);
  return id;
}

/** Gemini 2.x models take a thinking budget; later ones a level (and need thought signatures back). */
const isLegacy = (model: string) => /^gemini-2\./.test(model);

// ---------- Thinking ----------

/** The thinking levels each model takes (the thinking guide), most specific first. */
const LEVELS: [RegExp, ThinkingLevel[]][] = [
  [/^gemini-4-(?:neon|hydrogen)/, ["low", "medium", "high", "xhigh"]],
  [/^gemini-4-/, ["low", "medium", "high"]],
  [/^gemini-3\.8-flash/, ["low", "medium", "high"]],
  [/^gemini-3(?:\.\d+)?-flash/, ["minimal", "low", "medium", "high"]],
];
const DEFAULT_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];

/** Claude Code's effort → Gemini's thinking level ("max" has no level of its own). */
const EFFORT_LEVEL = new Map<string, ThinkingLevel>([
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "xhigh"],
]);
/** The same for Gemini 2.x's thinking budget, in tokens (2.5 Flash takes up to 24,576). */
const EFFORT_BUDGET = new Map<string, number>([
  ["low", 1024],
  ["medium", 8192],
  ["high", 24_576],
  ["xhigh", 24_576],
  ["max", 24_576],
]);

/** A thinking budget as a level: up to 4,096 tokens low, up to 16,384 medium, more high. */
const budgetLevel = (tokens: number): ThinkingLevel => (tokens <= 4096 ? "low" : tokens <= 16_384 ? "medium" : "high");

/**
 * The thinkingConfig for a request, or undefined to leave the model's default.
 *
 * - thinking {type: "disabled"} → the lowest level the model takes (minimal on
 *   3.x Flash and Flash-Lite, low elsewhere: Gemini 4 always thinks); budget 0
 *   on 2.x (not 2.5 Pro, which cannot stop).
 * - output_config.effort: low, medium, high → the same level; xhigh and max →
 *   xhigh where the model takes it (Gemini 4 Neon and Hydrogen), else high.
 * - thinking {type: "enabled", budget_tokens} with no effort: up to 4,096 →
 *   low, up to 16,384 → medium, more → high.
 * - Adaptive thinking with no effort: the model's own default.
 * Models that are not Gemini (Gemma) get no thinkingConfig: Gemini refuses it
 * for models that do not think.
 */
export function thinkingFor(model: string, req: Pick<MessagesRequest, "thinking" | "output_config">): GenerationConfig["thinkingConfig"] {
  if (!model.startsWith("gemini-")) return undefined;
  const thinking = req.thinking;
  const effort = req.output_config?.effort;
  const disabled = thinking?.type === "disabled";
  const budget = thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined;
  if (isLegacy(model)) {
    if (disabled) return /pro/.test(model) ? undefined : { thinkingBudget: 0 };
    const tokens = (effort ? EFFORT_BUDGET.get(effort) : undefined) ?? (budget !== undefined ? Math.min(Math.max(0, Math.round(budget)), 24_576) : undefined);
    return tokens === undefined ? undefined : { thinkingBudget: tokens };
  }
  const want: ThinkingLevel | undefined = disabled
    ? "minimal"
    : ((effort ? EFFORT_LEVEL.get(effort) : undefined) ?? (budget !== undefined ? budgetLevel(budget) : undefined));
  if (!want) return undefined;
  const levels = LEVELS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_LEVELS;
  const level = levels.includes(want) ? want : want === "xhigh" ? "high" : levels[0]!;
  return { thinkingLevel: level };
}

// ---------- Tools ----------

/** Gemini's function names: a letter or underscore, then letters, digits, underscores and dashes, at most 64. */
const GEMINI_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** A tool's name as Gemini takes it: the same when it can be, else a readable form with a hash, the same every time. */
export function geminiToolName(name: string): string {
  if (GEMINI_NAME_RE.test(name)) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z_]/, "_").slice(0, 55);
  return `${base}_${hash}`;
}

/** A JSON Schema without its $schema marker, which Gemini does not take. */
function withoutMarker(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  delete out.$schema;
  return out;
}

/** A tool's input schema for parametersJsonSchema: always an object schema. */
function toolSchema(schema: unknown): Record<string, unknown> {
  if (!isObject(schema)) return { type: "object", properties: {} };
  const rest = withoutMarker(schema);
  return rest.type === undefined && rest.properties === undefined ? { type: "object", properties: {}, ...rest } : rest;
}

/** Function declarations from the request's own tools; server tools (web search, code execution…) have no input_schema here. */
function declarations(tools: MessagesRequest["tools"]): FunctionDeclaration[] {
  const out: FunctionDeclaration[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== undefined && tool.type !== "custom") continue;
    if (tool.input_schema === undefined) continue;
    out.push({ name: geminiToolName(tool.name), description: tool.description?.trim() || tool.name, parametersJsonSchema: toolSchema(tool.input_schema) });
  }
  return out;
}

// ---------- Content ----------

const IMAGE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);
/** An image URL's type from its extension (fileData needs one); JPEG when it has none. */
const imageTypeOf = (url: string) => IMAGE_TYPES.get(url.split(/[?#]/)[0]!.split(".").pop()?.toLowerCase() ?? "") ?? "image/jpeg";

/** An image or document block as Gemini parts (a line saying so when Gemini cannot take it). */
function mediaParts(block: AnthropicBlock): GeminiPart[] {
  const source = isObject(block.source) ? block.source : {};
  const kind = str(source.type);
  if (block.type === "image") {
    if (kind === "base64" && str(source.data)) return [{ inlineData: { mimeType: str(source.media_type) || "image/png", data: str(source.data) } }];
    if (kind === "url" && str(source.url)) return [{ fileData: { mimeType: imageTypeOf(str(source.url)), fileUri: str(source.url) } }];
    return [{ text: "(An image was shared that could not be passed to Gemini.)" }];
  }
  // A document.
  const title = str(block.title).trim();
  const titled = (text: string) => (title ? `${title}\n\n${text}` : text);
  if (kind === "base64" && str(source.data)) return [{ inlineData: { mimeType: str(source.media_type) || "application/pdf", data: str(source.data) } }];
  if (kind === "text" && str(source.data)) return [{ text: titled(str(source.data)) }];
  if (kind === "url" && str(source.url)) return [{ fileData: { mimeType: "application/pdf", fileUri: str(source.url) } }];
  if (kind === "content") {
    const inner = typeof source.content === "string" ? [{ type: "text", text: source.content }] : Array.isArray(source.content) ? source.content.filter(isObject) : [];
    const parts = inner.flatMap((b) => (b.type === "text" && str(b.text) ? [{ text: str(b.text) }] : b.type === "image" ? mediaParts(b as AnthropicBlock) : []));
    if (title && parts[0]?.text !== undefined) parts[0] = { text: titled(parts[0].text) };
    return parts;
  }
  return [{ text: "(A document was shared that could not be passed to Gemini.)" }];
}

/** A tool result's content as text and media (images, PDFs). */
function resultContent(content: unknown): { text: string; media: GeminiPart[] } {
  if (typeof content === "string") return { text: content, media: [] };
  const texts: string[] = [];
  const media: GeminiPart[] = [];
  for (const block of Array.isArray(content) ? content.filter(isObject) : []) {
    if (block.type === "text") texts.push(str(block.text));
    else if (block.type === "image" || block.type === "document") {
      for (const part of mediaParts(block as AnthropicBlock)) {
        if (part.text !== undefined) texts.push(part.text);
        else media.push(part);
      }
    } else if (block.type === "tool_reference") texts.push(`Tool ${str(block.tool_name)} is now available.`);
    else if (block.type === "search_result") texts.push(searchResultText(block));
  }
  return { text: texts.filter(Boolean).join("\n"), media };
}

function searchResultText(block: Record<string, unknown>): string {
  const inner = Array.isArray(block.content) ? block.content.filter(isObject).map((b) => str(b.text)) : [];
  return [str(block.title), str(block.source), ...inner].filter(Boolean).join("\n");
}

const stringify = (v: unknown) => {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
};

interface Context {
  model: string;
  session: Pick<BridgeSession, "calls">;
  /** Function parts are sent as such (the request declares tools); else as text. */
  functions: boolean;
  /** tool_use id → its tool's name, for the results that answer it. */
  toolNames: Map<string, string>;
}

function userParts(blocks: AnthropicBlock[], ctx: Context): GeminiPart[] {
  const results: GeminiPart[] = [];
  const rest: GeminiPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (str(block.text)) rest.push({ text: str(block.text) });
        break;
      case "image":
      case "document":
        rest.push(...mediaParts(block));
        break;
      case "search_result":
        rest.push({ text: searchResultText(block) });
        break;
      case "tool_result": {
        const id = str(block.tool_use_id);
        const name = ctx.toolNames.get(id) ?? "unknown_tool";
        const { text, media } = resultContent(block.content);
        const failed = block.is_error === true;
        if (!ctx.functions) {
          rest.push({ text: `[${failed ? "Error from" : "Result of"} tool ${name}]\n${text}` }, ...media);
          break;
        }
        const callId = ctx.session.calls.recall(id)?.callId;
        const nested = media.length > 0 && !isLegacy(ctx.model);
        results.push({
          functionResponse: {
            ...(callId ? { id: callId } : {}),
            name: geminiToolName(name),
            response: failed ? { error: text || "The tool failed." } : { output: text },
            ...(nested ? { parts: media } : {}),
          },
        });
        // Gemini 2.x takes no parts in a function response: the media follow it.
        if (!nested) rest.push(...media);
        break;
      }
      default:
        // Thinking, server tool results, container uploads: nothing Gemini can take.
        break;
    }
  }
  return [...results, ...rest];
}

function modelParts(blocks: AnthropicBlock[], ctx: Context): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && str(block.text)) parts.push({ text: str(block.text) });
    else if (block.type === "tool_use") {
      const name = str(block.name);
      const input = isObject(block.input) ? block.input : {};
      if (!ctx.functions) {
        parts.push({ text: `[Called tool ${name} with ${stringify(input)}]` });
        continue;
      }
      const remembered = ctx.session.calls.recall(str(block.id));
      parts.push({
        functionCall: { ...(remembered?.callId ? { id: remembered.callId } : {}), name: geminiToolName(name), args: input },
        ...(remembered?.signature ? { thoughtSignature: remembered.signature } : {}),
      });
    }
    // Thinking and redacted thinking (Claude's), server tool calls: left out.
  }
  return parts;
}

/** The messages as Gemini contents: empty turns left out, turns of the same role in a row joined. */
function contents(messages: MessagesRequest["messages"], ctx: Context): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const blocks: AnthropicBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const role = message.role === "assistant" ? "model" : "user";
    const parts = role === "model" ? modelParts(blocks, ctx) : userParts(blocks, ctx);
    if (!parts.length) continue;
    const last = out.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  if (!out.length) throw new BridgeError(400, "invalid_request_error", "messages: no message has content Gemini can take.");
  // Each step's first call must carry a signature on Gemini 3 and later (a step: one model turn, once joined).
  for (const content of isLegacy(ctx.model) ? [] : out) {
    const first = content.role === "model" ? content.parts.find((p) => p.functionCall) : undefined;
    if (first && !first.thoughtSignature) first.thoughtSignature = SKIP_SIGNATURE;
  }
  return out;
}

// ---------- The request ----------

/** Claude Code's attribution line in the system prompt: metadata for Anthropic's API, not an instruction. */
const BILLING_HEADER_RE = /^x-anthropic-billing-header:/;

/** The texts of a system prompt or system message. */
const systemTexts = (content: string | AnthropicBlock[]): string[] =>
  (typeof content === "string" ? [content] : content.filter((b) => b.type === "text").map((b) => str(b.text))).filter((t) => t.trim() && !BILLING_HEADER_RE.test(t));

export interface Translated {
  model: string;
  request: GeminiRequest;
  /** Gemini function name → the tool's own name. */
  names: Map<string, string>;
}

/** The Gemini request for an Anthropic one, in this session (see the file comment). */
export function translateRequest(req: MessagesRequest, session: Pick<BridgeSession, "models" | "calls">): Translated {
  const model = resolveModel(req.model, session.models);
  const decls = declarations(req.tools);
  const names = new Map<string, string>();
  for (const tool of req.tools ?? []) names.set(geminiToolName(tool.name), tool.name);
  const toolNames = new Map<string, string>();
  for (const message of req.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      toolNames.set(str(block.id), str(block.name));
      names.set(geminiToolName(str(block.name)), str(block.name));
    }
  }
  const ctx: Context = { model, session, functions: decls.length > 0, toolNames };
  const request: GeminiRequest = { contents: contents(req.messages, ctx) };

  const systemParts = [req.system ?? [], ...req.messages.filter((m) => m.role === "system").map((m) => m.content)].flatMap(systemTexts).map((text) => ({ text }));
  if (systemParts.length) request.systemInstruction = { parts: systemParts };

  if (decls.length) {
    request.tools = [{ functionDeclarations: decls }];
    const choice = req.tool_choice;
    if (choice?.type === "any") request.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (choice?.type === "none") request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice?.type === "tool" && choice.name) request.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [geminiToolName(choice.name)] } };
    else if (choice?.type === "auto") request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const config: GenerationConfig = {};
  if (req.max_tokens) config.maxOutputTokens = Math.min(req.max_tokens, MAX_OUTPUT_TOKENS);
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.top_p !== undefined) config.topP = req.top_p;
  if (req.top_k !== undefined) config.topK = req.top_k;
  const stops = (req.stop_sequences ?? []).filter(Boolean).slice(0, 5);
  if (stops.length) config.stopSequences = stops;
  const thinking = thinkingFor(model, req);
  if (thinking) config.thinkingConfig = thinking;
  const format = req.output_config?.format;
  if (format?.type === "json_schema" && isObject(format.schema)) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = withoutMarker(format.schema);
  }
  if (Object.keys(config).length) request.generationConfig = config;
  return { model, request, names };
}

/** countTokens' body for the same request: what the prompt holds, without generation settings. */
export function countTokensBody(t: Translated): Record<string, unknown> {
  const { contents, systemInstruction, tools, toolConfig } = t.request;
  return {
    generateContentRequest: {
      model: `models/${t.model}`,
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      ...(toolConfig ? { toolConfig } : {}),
    },
  };
}
