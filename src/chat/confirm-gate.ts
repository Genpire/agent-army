import { createHash } from "node:crypto";
import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { ChatIntegration } from "./chat-integrations.js";
import { APP_ID_RE } from "../core/config.js";
import { ROUTINE_RUN_TOOL, ROUTINE_WRITE_TOOLS } from "../routines/tool-names.js";
import { SLACK_SEND_TOOL, isSelfTarget } from "../slack/slack-tools.js";
import type { PointerRequest } from "./pointer-types.js";

/**
 * The user's confirmation for persistent and high-impact writes after
 * Pointer has read outside content.
 *
 * Pointer runs headless with its tools approved in advance, and in one turn
 * it may read a Jira issue, a web page or an app's records and then write.
 * What it read could ask for a memory fact or a project note (both reach
 * every later prompt, and notes every repo task there), for a change in a
 * connected app (a refund, an edit in a tracker), for a Slack message that
 * carries what Pointer knows to someone else, or for a routine (work Pointer
 * then does on its own, reporting to whoever it names). So once a query has called
 * a tool that returns outside content, those writes are denied and recorded
 * as pending. Pointer shows the user what it wants to do; when the user's
 * next message in the conversation is a short "yes", the same tool with the
 * same input goes through once.
 *
 * A Slack message to the person asking ("me", or their own Slack user id)
 * is not held: it reaches nobody else.
 *
 * Not gated: Jira, monday.com and Miro writes, and start_repo_task. They are
 * bounded by allow lists, visible where they land (the issue, item or board
 * records them), and a repo task ends in a pull request a human reviews.
 *
 * State: a hook sees one tool call at a time and nothing of the
 * conversation. So the taint lives in the closure of one gate per query
 * (built in each reply()), and the pending actions in a PendingActions store
 * the brain keeps for its lifetime, keyed by conversation. The store is in
 * memory only: a "yes" that reaches another instance, or comes after a
 * restart, finds nothing, and Pointer asks again.
 */

/** How long a pending action waits for the user's yes. */
export const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING_PER_CONVERSATION = 20;
const MAX_CONVERSATIONS = 1_000;
/** A confirmation is a short message: "yes", "ok go ahead", "نعم تمام". */
const MAX_CONFIRMATION_WORDS = 4;

/** Writes that reach future prompts and repo tasks: always gated after outside content. */
export const PERSISTENT_WRITE_TOOLS = ["mcp__pointer__memory_save", "mcp__pointer__project_notes_add"];

/** Tools that send what Pointer knows to other people: gated after outside content when connected. */
export const OUTBOUND_TOOLS = [SLACK_SEND_TOOL];

/**
 * Routines (routines/): creating, changing and deleting one decides what
 * Pointer does on its own from then on, and to whom it reports, so they are
 * gated after outside content like app writes. Running one now is not: its
 * recipients were set (and confirmed) when it was made.
 */
export const ROUTINE_GATED_TOOLS = ROUTINE_WRITE_TOOLS;

/**
 * Tools whose output holds nothing from outside, so calling them never
 * taints a query; every other tool does, the Agent/Task tool included
 * (subagents read outside content and report it back), and so does Slack's
 * member directory (names and titles are written by people). memory_save,
 * project_notes_add and slack_send_message only echo what Pointer wrote:
 * without them here, "remember A and B" would need a confirmation for B.
 */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set([
  "mcp__pointer__repo_task_status",
  "mcp__pointer__memory_forget",
  ...PERSISTENT_WRITE_TOOLS,
  ...OUTBOUND_TOOLS,
  ...ROUTINE_GATED_TOOLS,
  ROUTINE_RUN_TOOL,
  "TodoWrite",
  "Skill",
]);

/**
 * The tools that need a confirmation after outside content: memory, project
 * notes, every app tool that is not read-only, sending Slack messages, and
 * creating, changing or deleting routines.
 */
export function gatedTools(integrations: ChatIntegration[]): Set<string> {
  const appWrites = integrations
    .filter((i) => APP_ID_RE.test(i.key))
    .flatMap((i) => {
      const readOnly = new Set(i.readOnlyToolNames);
      return i.allToolNames.filter((t) => !readOnly.has(t));
    });
  const offered = integrations.flatMap((i) => i.allToolNames);
  const outbound = offered.filter((t) => OUTBOUND_TOOLS.includes(t));
  const routines = offered.filter((t) => ROUTINE_GATED_TOOLS.includes(t));
  return new Set([...PERSISTENT_WRITE_TOOLS, ...appWrites, ...outbound, ...routines]);
}

/**
 * One conversation: a console conversation, a Slack thread, or a Slack DM.
 * A DM is keyed by its channel because its top-level messages each carry
 * their own ts; it is one person talking to Pointer either way.
 */
export function conversationKey(req: Pick<PointerRequest, "channel" | "threadTs" | "channelType" | "surface">): string {
  if (req.surface === "web") return `web:${req.threadTs}`;
  if (req.channelType === "im") return `slack:${req.channel}`;
  return `slack:${req.channel}:${req.threadTs}`;
}

/** Object keys sorted at every level, so the same input always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/** A stable hash of a tool's input; the input itself is never kept. */
export const inputHash = (input: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(input ?? null)))
    .digest("hex");

/** Words that say yes. Arabic is matched after the normalisation in confirmationWords. */
const YES_WORDS = new Set([
  "yes", "y", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "confirmed", "approve", "approved", "proceed", "go", "do", "lgtm",
  "نعم", "اه", "ايوه", "ايوا", "ايو", "تمام", "موافق", "موافقه", "اعمل", "اعملها", "اكيد", "ماشي",
]);
/** Words that may go with a yes ("go ahead", "do it", "yes please"). Anything else ("no", "but", "not") makes it not a confirmation. */
const FILLER_WORDS = new Set([
  "ahead", "it", "that", "this", "please", "pls", "thanks", "thank", "you", "then", "so", "fine",
  "من", "فضلك", "لو", "سمحت", "شكرا", "يلا",
]);

/** The message's words: lower case, Slack emoji codes, punctuation, emoji and Arabic diacritics removed, Arabic letter variants folded. */
function confirmationWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/:[a-z0-9_+'-]+:/g, " ")
    .replace(/[\p{M}ـ]/gu, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** A short yes in English or Arabic, and nothing else: "Yes!", "ok go ahead", "do it 👍", "نعم", "تمام، اعمل". */
export function isConfirmation(text: string): boolean {
  const words = confirmationWords(text);
  if (words.length === 0 || words.length > MAX_CONFIRMATION_WORDS) return false;
  return words.every((w) => YES_WORDS.has(w) || FILLER_WORDS.has(w)) && words.some((w) => YES_WORDS.has(w));
}

/** A write waiting for the user's yes: the tool and a hash of its input. */
export interface PendingAction {
  tool: string;
  inputHash: string;
}

/** Pending actions per conversation, each for PENDING_TTL_MS. In memory, bounded in size. */
export class PendingActions {
  private readonly byConversation = new Map<string, (PendingAction & { expiresAt: number })[]>();

  constructor(
    private readonly ttlMs = PENDING_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an action; the same action again only renews its expiry. */
  add(conversation: string, action: PendingAction): void {
    const now = this.now();
    this.sweep(now);
    const kept = (this.byConversation.get(conversation) ?? []).filter((e) => e.tool !== action.tool || e.inputHash !== action.inputHash);
    kept.push({ tool: action.tool, inputHash: action.inputHash, expiresAt: now + this.ttlMs });
    // Re-inserted so the map's order is oldest conversation first.
    this.byConversation.delete(conversation);
    this.byConversation.set(conversation, kept.slice(-MAX_PENDING_PER_CONVERSATION));
    for (const oldest of this.byConversation.keys()) {
      if (this.byConversation.size <= MAX_CONVERSATIONS) break;
      this.byConversation.delete(oldest);
    }
  }

  /** Removes the conversation's pending actions and returns those that have not expired. */
  take(conversation: string): PendingAction[] {
    const entries = this.byConversation.get(conversation) ?? [];
    this.byConversation.delete(conversation);
    const now = this.now();
    return entries.filter((e) => e.expiresAt > now).map(({ tool, inputHash }) => ({ tool, inputHash }));
  }

  private sweep(now: number): void {
    for (const [key, entries] of this.byConversation) {
      const live = entries.filter((e) => e.expiresAt > now);
      if (live.length) this.byConversation.set(key, live);
      else this.byConversation.delete(key);
    }
  }
}

export interface ConfirmGateOptions {
  pending: PendingActions;
  /** conversationKey of the request. */
  conversation: string;
  /** The user's new message: a short yes confirms the conversation's pending actions. */
  message: string;
  /** Tools that need a confirmation once the query has read outside content (gatedTools). */
  gated: ReadonlySet<string>;
  /** The requester's Slack user id (requesterSlackId); absent in the console. A Slack message to them is never held. */
  requesterSlackId?: string;
}

const deny = (tool: string): SyncHookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `Not done: this turn read outside content (web pages, code hosts, tickets, boards, apps, Slack's member directory or a team member's report), so ${tool} needs the user's confirmation first. ` +
      "Do not call it again now. Show the user exactly what you want to save or do (quote the arguments) and ask them to confirm. " +
      "If they reply yes, call the same tool with exactly the same arguments, without reading anything first.",
  },
});

/**
 * PreToolUse hook for one query (one reply()). Build it once per query: it
 * takes the conversation's pending actions at once, so only the very next
 * message can confirm them and any other message drops them.
 *
 * Only Pointer's own calls count. Subagents are read-only already
 * (subagentReadOnlyGate in pointer.ts), and the Agent call that started
 * them has tainted the query. A query is tainted from the first call to an
 * untrusted tool on, conservatively: a write in the same batch of parallel
 * calls as a read may be held too.
 */
export function confirmGate({ pending, conversation, message, gated, requesterSlackId }: ConfirmGateOptions): HookCallback {
  const taken = pending.take(conversation);
  const confirmed = isConfirmation(message) ? taken : [];
  let tainted = false;

  /** A gated call: allowed when confirmed (once) or before any outside content, otherwise held. */
  const check = (tool: string, toolInput: unknown): SyncHookJSONOutput | undefined => {
    const hash = inputHash(toolInput);
    const match = confirmed.findIndex((a) => a.tool === tool && a.inputHash === hash);
    if (match >= 0) {
      confirmed.splice(match, 1);
      console.info(`[pointer] ${tool}: confirmed by the user`);
      return undefined;
    }
    if (!tainted) return undefined;
    pending.add(conversation, { tool, inputHash: hash });
    console.info(`[pointer] ${tool}: held for the user's confirmation`);
    return deny(tool);
  };

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.agent_id) return {};
    const tool = input.tool_name;
    try {
      // A Slack message to the person asking reaches nobody else: never held, and no confirmation used up.
      const toSelf = tool === SLACK_SEND_TOOL && isSelfTarget(input.tool_input, requesterSlackId);
      const denied = gated.has(tool) && !toSelf ? check(tool, input.tool_input) : undefined;
      if (denied) return denied;
    } catch {
      // A failing hook lets the call through, so a gated call is denied here instead.
      if (gated.has(tool)) return deny(tool);
    }
    if (!TRUSTED_TOOLS.has(tool)) tainted = true;
    return {};
  };
}
