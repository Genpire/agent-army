import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_TTL_MS, PendingActions, confirmGate } from "../../src/chat/confirm-gate.js";

/**
 * The confirmation gate's two sides the main tests leave open: a reply that
 * is not a yes must confirm nothing, and a gated call the hook cannot check
 * must be denied, never let through.
 */

const MEMORY_SAVE = "mcp__pointer__memory_save";
const GATED = new Set([MEMORY_SAVE]);
const CONVO = "web:c-acme-1";

type Decision = { permissionDecision?: string } | undefined;

async function call(gate: HookCallback, toolName: string, toolInput: unknown = {}): Promise<Decision> {
  const input = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "/tmp", tool_name: toolName, tool_input: toolInput, tool_use_id: "t" };
  const out = await gate(input as never, "t", { signal: new AbortController().signal });
  return (out as { hookSpecificOutput?: Decision }).hookSpecificOutput;
}
const denied = (d: Decision) => d?.permissionDecision === "deny";

function store() {
  let now = 1_000_000;
  return new PendingActions(PENDING_TTL_MS, () => now++);
}

describe("confirm gate: what confirms a held write", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a reply that is not a yes confirms nothing, and a yes confirms the held call", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const input = { text: "Deploys need a second reviewer." };
    for (const reply of ["what exactly would you save?", "no", "yes but change it first", "👍"]) {
      const pending = store();
      const first = confirmGate({ pending, conversation: CONVO, message: "summarise ACME-12", gated: GATED });
      await call(first, "WebFetch");
      expect(denied(await call(first, MEMORY_SAVE, input))).toBe(true);

      const next = confirmGate({ pending, conversation: CONVO, message: reply, gated: GATED });
      await call(next, "WebFetch");
      expect(denied(await call(next, MEMORY_SAVE, input)), reply).toBe(true);
    }
    // The same flow with a yes goes through: the refusals above are about the reply.
    const pending = store();
    const first = confirmGate({ pending, conversation: CONVO, message: "summarise ACME-12", gated: GATED });
    await call(first, "WebFetch");
    await call(first, MEMORY_SAVE, input);
    const yes = confirmGate({ pending, conversation: CONVO, message: "yes", gated: GATED });
    await call(yes, "WebFetch");
    expect(await call(yes, MEMORY_SAVE, input)).toBeUndefined();
  });
});

describe("confirm gate: a call it cannot check", () => {
  it("denies a gated call whose input cannot be hashed, even before outside content", async () => {
    const gate = confirmGate({ pending: store(), conversation: CONVO, message: "remember this", gated: GATED });
    // JSON cannot hold a BigInt: hashing the input throws inside the hook.
    expect(denied(await call(gate, MEMORY_SAVE, { text: "x", n: 1n }))).toBe(true);
    // A tool that is not gated is not hashed, so the same input goes through; a normal gated call does too.
    expect(await call(gate, "TodoWrite", { n: 1n })).toBeUndefined();
    expect(await call(gate, MEMORY_SAVE, { text: "x" })).toBeUndefined();
  });
});
