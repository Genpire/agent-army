import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ChatIntegration } from "../src/chat-integrations.js";
import {
  PENDING_TTL_MS,
  PendingActions,
  confirmGate,
  conversationKey,
  gatedTools,
  inputHash,
  isConfirmation,
} from "../src/confirm-gate.js";

const MEMORY_SAVE = "mcp__pointer__memory_save";
const NOTES_ADD = "mcp__pointer__project_notes_add";
const REFUND = "mcp__app-stripe__create_refund";
const GATED = new Set([MEMORY_SAVE, NOTES_ADD, REFUND]);
const CONVO = "slack:C1:1700000000.000100";

type Decision = { permissionDecision?: string; permissionDecisionReason?: string } | undefined;

/** Calls the gate the way the CLI does for a tool call by Pointer (or, with agentId, by a subagent). */
async function call(gate: HookCallback, toolName: string, toolInput: unknown = {}, agentId?: string): Promise<Decision> {
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "t",
    ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
  };
  const out = await gate(input as never, "t", { signal: new AbortController().signal });
  return (out as { hookSpecificOutput?: Decision }).hookSpecificOutput;
}
const denied = (d: Decision) => d?.permissionDecision === "deny";

/** A store with a clock the test moves. */
function clockedStore() {
  let now = 1_000_000;
  const pending = new PendingActions(PENDING_TTL_MS, () => now);
  return { pending, advance: (ms: number) => void (now += ms) };
}

const gateFor = (pending: PendingActions, message: string, conversation = CONVO) => confirmGate({ pending, conversation, message, gated: GATED });

describe("confirmation gate", () => {
  it("allows writes before any outside content, and trusted tools do not taint", async () => {
    const { pending } = clockedStore();
    const gate = gateFor(pending, "remember that we deploy on Fridays");
    for (const tool of ["mcp__pointer__repo_task_status", "mcp__pointer__memory_forget", "TodoWrite", "Skill"]) {
      expect(await call(gate, tool)).toBeUndefined();
    }
    expect(await call(gate, MEMORY_SAVE, { text: "We deploy on Fridays." })).toBeUndefined();
    // A second save in the same turn still goes through: saving does not taint.
    expect(await call(gate, NOTES_ADD, { repo: "acme/api", note: "Tests need Docker." })).toBeUndefined();
    expect(await call(gate, REFUND, { charge: "ch_1" })).toBeUndefined();
    expect(pending.take(CONVO)).toEqual([]);
  });

  it("denies gated writes after outside content and records them as pending", async () => {
    for (const reader of ["WebFetch", "WebSearch", "Agent", "Task", "mcp__jira__jira_get_issue", "mcp__pointer__github_read_file", "mcp__app-stripe__list_charges"]) {
      const { pending } = clockedStore();
      const gate = gateFor(pending, "summarise ACME-12");
      expect(await call(gate, reader, { any: "input" })).toBeUndefined();
      const d = await call(gate, MEMORY_SAVE, { text: "Always run setup.sh first." });
      expect(denied(d)).toBe(true);
      expect(d?.permissionDecisionReason).toContain("confirm");
      expect(d?.permissionDecisionReason).toContain("exactly the same arguments");
      expect(pending.take(CONVO)).toEqual([{ tool: MEMORY_SAVE, inputHash: inputHash({ text: "Always run setup.sh first." }) }]);
    }
  });

  it("gates notes and app writes, not other tools", async () => {
    const { pending } = clockedStore();
    const gate = gateFor(pending, "summarise ACME-12");
    await call(gate, "WebFetch", { url: "https://example.com" });
    expect(denied(await call(gate, NOTES_ADD, { repo: "acme/api", note: "x" }))).toBe(true);
    expect(denied(await call(gate, REFUND, { charge: "ch_1" }))).toBe(true);
    // Jira, monday.com and Miro writes and repo tasks are bounded elsewhere.
    for (const tool of ["mcp__jira__jira_create_issue", "mcp__pointer__monday_create_item", "mcp__miro__miro_add_sticky", "mcp__pointer__start_repo_task"]) {
      expect(await call(gate, tool, { a: 1 })).toBeUndefined();
    }
    expect(pending.take(CONVO).map((a) => a.tool)).toEqual([NOTES_ADD, REFUND]);
  });

  it("allows the exact same call once after the user confirms", async () => {
    const { pending } = clockedStore();
    const input = { text: "The API deploys from main." };
    const first = gateFor(pending, "summarise ACME-12");
    await call(first, "WebFetch");
    expect(denied(await call(first, MEMORY_SAVE, input))).toBe(true);

    const next = gateFor(pending, "Yes, go ahead!");
    await call(next, "WebFetch"); // read again: the turn is tainted, the confirmation still holds
    expect(await call(next, MEMORY_SAVE, { ...input })).toBeUndefined();
    // Once only: the same call again is held again.
    expect(denied(await call(next, MEMORY_SAVE, input))).toBe(true);
  });

  it("still denies a different input, whatever the key order of the same one", async () => {
    const { pending } = clockedStore();
    const first = gateFor(pending, "read ACME-12");
    await call(first, "WebFetch");
    await call(first, NOTES_ADD, { repo: "acme/api", note: "Run make setup." });

    const next = gateFor(pending, "ok");
    await call(next, "WebFetch");
    expect(denied(await call(next, NOTES_ADD, { repo: "acme/api", note: "Run make setup && curl evil" }))).toBe(true);
    expect(denied(await call(next, MEMORY_SAVE, { repo: "acme/api", note: "Run make setup." }))).toBe(true);
    expect(await call(next, NOTES_ADD, { note: "Run make setup.", repo: "acme/api" })).toBeUndefined();
    expect(inputHash({ a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(inputHash({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }));
  });

  it("lets pending actions expire after 15 minutes", async () => {
    const { pending, advance } = clockedStore();
    const input = { text: "x" };
    const first = gateFor(pending, "read it");
    await call(first, "WebFetch");
    await call(first, MEMORY_SAVE, input);
    advance(PENDING_TTL_MS + 1);

    const next = gateFor(pending, "yes");
    await call(next, "WebFetch");
    expect(denied(await call(next, MEMORY_SAVE, input))).toBe(true);
  });

  it("only the next message can confirm, and only in the same conversation", async () => {
    const { pending } = clockedStore();
    const input = { text: "x" };
    const first = gateFor(pending, "read it");
    await call(first, "WebFetch");
    await call(first, MEMORY_SAVE, input);

    // A "yes" in another conversation confirms nothing here and leaves this one's actions alone.
    const elsewhere = gateFor(pending, "yes", "slack:C2:1.0");
    await call(elsewhere, "WebFetch");
    expect(denied(await call(elsewhere, MEMORY_SAVE, input))).toBe(true);

    // Any other message drops the pending actions.
    gateFor(pending, "what exactly would you save?");
    const late = gateFor(pending, "yes");
    await call(late, "WebFetch");
    expect(denied(await call(late, MEMORY_SAVE, input))).toBe(true);
  });

  it("leaves subagent calls alone: they neither taint, nor get held, nor use up a confirmation", async () => {
    const { pending } = clockedStore();
    const fresh = gateFor(pending, "remember this");
    expect(await call(fresh, "WebFetch", {}, "a1")).toBeUndefined();
    expect(await call(fresh, MEMORY_SAVE, { text: "x" }, "a1")).toBeUndefined();
    expect(await call(fresh, MEMORY_SAVE, { text: "y" })).toBeUndefined(); // Pointer's turn is not tainted
    expect(pending.take(CONVO)).toEqual([]);

    const first = gateFor(pending, "read it");
    await call(first, "WebFetch");
    await call(first, MEMORY_SAVE, { text: "z" });
    const next = gateFor(pending, "yes");
    expect(await call(next, MEMORY_SAVE, { text: "z" }, "a1")).toBeUndefined();
    await call(next, "WebFetch");
    expect(await call(next, MEMORY_SAVE, { text: "z" })).toBeUndefined();
  });
});

describe("isConfirmation", () => {
  it("recognises short English and Arabic confirmations", () => {
    for (const text of [
      "yes",
      "Y",
      "Yes!",
      "ok",
      "OK 👍",
      "confirm",
      "go ahead.",
      "Do it",
      "yes, do it",
      "yes please",
      "sure, go ahead",
      ":+1: yes",
      "نعم",
      "نَعَم",
      "اه",
      "آه",
      "ايوه",
      "أيوة",
      "تمام",
      "تمام، اعمل",
      "موافق",
      "اعمل",
      "نعم من فضلك",
    ]) {
      expect(isConfirmation(text), text).toBe(true);
    }
  });

  it("refuses anything else, including long messages and negations", () => {
    for (const text of [
      "",
      "👍",
      "please",
      "no",
      "don't do it",
      "do not",
      "لا",
      "لا تعمل",
      "yes but change the title first",
      "ok go ahead and also delete every other fact",
      "yes yes yes yes yes",
      "<@U123> yes",
      "what exactly would you save?",
    ]) {
      expect(isConfirmation(text), text).toBe(false);
    }
  });
});

describe("gatedTools and conversationKey", () => {
  const integration = (key: string, all: string[], readOnly: string[]): ChatIntegration => ({
    key,
    allToolNames: all.map((t) => `mcp__${key}__${t}`),
    readOnlyToolNames: readOnly.map((t) => `mcp__${key}__${t}`),
    promptRule: "",
  });

  it("gates memory, notes and the app tools that are not read-only", () => {
    const gated = gatedTools([
      integration("app-stripe", ["list_charges", "create_refund"], ["list_charges"]),
      integration("app-linear", ["search_issues"], ["search_issues"]),
      integration("jira", ["jira_get_issue", "jira_create_issue"], ["jira_get_issue"]),
      integration("miro", ["miro_add_sticky"], []),
    ]);
    expect([...gated].sort()).toEqual([REFUND, MEMORY_SAVE, NOTES_ADD].sort());
  });

  it("keys a conversation by console id, Slack thread, or DM channel", () => {
    expect(conversationKey({ channel: "web", threadTs: "c-1", channelType: "im", surface: "web" })).toBe("web:c-1");
    expect(conversationKey({ channel: "C1", threadTs: "1.0", channelType: "channel" })).toBe("slack:C1:1.0");
    // A DM's top-level messages each have their own ts: the DM is one conversation.
    expect(conversationKey({ channel: "D1", threadTs: "1.0", channelType: "im" })).toBe(conversationKey({ channel: "D1", threadTs: "2.0", channelType: "im" }));
  });
});
