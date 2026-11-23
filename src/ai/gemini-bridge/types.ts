/**
 * The two wire formats the bridge speaks: the part of Anthropic's Messages API
 * Claude Code sends (checked loosely: unknown fields and block types pass and
 * are left out later), and the part of Gemini's generateContent it calls
 * (https://aistudio.google.com/api-reference/generate-content).
 */
import { z } from "zod";

// ---------- Anthropic, as Claude Code sends it ----------

const Block = z.looseObject({ type: z.string() });
export type AnthropicBlock = z.infer<typeof Block>;

const Message = z.looseObject({
  // "system": Claude Code's mid-conversation system messages (its environment, for one).
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(Block)]),
});

const Tool = z.looseObject({
  name: z.string().min(1).max(200),
  type: z.string().optional(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
});

/** POST /v1/messages and /v1/messages/count_tokens (which has no max_tokens). */
export const MessagesRequestSchema = z.looseObject({
  model: z.string().min(1).max(300),
  max_tokens: z.number().int().positive().optional(),
  messages: z.array(Message).min(1),
  system: z.union([z.string(), z.array(Block)]).optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z.looseObject({ type: z.string(), name: z.string().optional() }).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  thinking: z.looseObject({ type: z.string(), budget_tokens: z.number().optional() }).optional(),
  output_config: z
    .looseObject({
      effort: z.string().optional(),
      format: z.looseObject({ type: z.string(), schema: z.unknown().optional() }).nullish(),
    })
    .optional(),
  stream: z.boolean().optional(),
});
export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ResponseBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ResponseBlock[];
  stop_reason: StopReason;
  stop_sequence: null;
  usage: AnthropicUsage;
}

// ---------- Gemini ----------

export interface GeminiPart {
  text?: string;
  /** A thought summary (only with includeThoughts, which the bridge never asks for). */
  thought?: boolean;
  /** Opaque; Gemini 3 and later need a function call's back on later turns. */
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown>; parts?: GeminiPart[] };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  /** Full JSON Schema (mutually exclusive with the OpenAPI-subset `parameters`). */
  parametersJsonSchema: Record<string, unknown>;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  thinkingConfig?: { thinkingLevel?: ThinkingLevel; thinkingBudget?: number };
  responseMimeType?: string;
  responseJsonSchema?: unknown;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } };
  generationConfig?: GenerationConfig;
}
