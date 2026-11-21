/**
 * What a model id may look like, shared by the server (the providers' tiers,
 * the engines' --model, AgentSpec.engineModel) and the console's model picker
 * (web/src/lib/modelPicker.ts), so a typed id is checked the same way on both
 * sides. No imports: the console bundles this file as it is.
 */

/** Model ids as AI providers spell them: "kimi-k3[1m]", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "~anthropic/claude-opus-latest". */
export const MODEL_ID_RE = /^[\x21-\x7e]{1,200}$/;

/** A coding agent CLI's --model (Codex, Gemini CLI): letters, digits and . _ : / -, starting with a letter or digit. */
export const ENGINE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const ENGINE_MODEL_MAX = 100;
export const ENGINE_MODEL_MESSAGE = "A model id is letters, digits and . _ : / -, like the CLI's --model takes.";

/** Which rule a model id follows: an AI provider's (Claude Code's model) or a coding agent CLI's (--model). */
export type ModelIdKind = "provider" | "engine";

/** Why `id` is not a model id of that kind, or undefined when it is. Empty is not an id (callers treat it as "the default"). */
export function modelIdProblem(id: string, kind: ModelIdKind, maxLength = kind === "engine" ? ENGINE_MODEL_MAX : 200): string | undefined {
  if (!id) return "Type a model id.";
  if (id.length > maxLength) return `Model ids are at most ${maxLength} characters.`;
  if (kind === "engine") return ENGINE_MODEL_RE.test(id) ? undefined : ENGINE_MODEL_MESSAGE;
  return MODEL_ID_RE.test(id) ? undefined : "A model id has no spaces or other special characters.";
}
