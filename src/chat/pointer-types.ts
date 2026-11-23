/**
 * Contracts between the Slack layer (dispatch/server), Pointer's brain and the
 * smoke test. Keep these stable: several modules are built against them.
 */
import type { WebClient } from "@slack/web-api";
import type { AttachmentInfo, AttachmentRepo, NewAttachment } from "./attachments.js";
import type { ConfigRepo } from "../core/config.js";
import type { MemoryRepo } from "./memory.js";
import type { NotesRepo } from "./notes.js";
import type { LessonsRepo } from "../team/lessons.js";
import type { Runner } from "../tasks/runner.js";
import type { TaskRepo, ThreadState } from "../tasks/tasks.js";
import type { UsageRepo } from "../spending/usage.js";
import type { AgentCosts } from "../spending/attribution.js";
import type { Spending } from "../spending/budget.js";
import type { FallbackNote } from "../ai/routing.js";

/** A file attached to a Slack message (subset of Slack's file object). */
export interface SlackFileRef {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  /** "check_file_info" when Slack omits the URLs; call files.info. */
  file_access?: string;
}

/** The message inside a `message_changed` event: as it reads after the edit. */
export interface SlackChangedMessage {
  type?: string;
  /** "tombstone" for a thread's first message deleted while it has replies. */
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFileRef[];
}

/** A Slack `message` or `app_mention` event, as delivered by the Events API. */
export interface SlackMessageEvent {
  type: string; // "message" | "app_mention"
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  /** "im" | "channel" | "group" | "mpim"; absent on app_mention. */
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  /** Team of the user who posted; differs from the installed team for Slack Connect guests. */
  user_team?: string;
  /** Files uploaded with the message (subtype "file_share"). */
  files?: SlackFileRef[];
  /** Subtype "message_changed": the message as it reads now. */
  message?: SlackChangedMessage;
  /** Subtype "message_deleted": the deleted message's ts. */
  deleted_ts?: string;
  /**
   * Set by the events route, not by Slack: the delivery named a person's
   * account in its authorizations (a user token's events), so the
   * conversation may not be the bot's.
   */
  viaPerson?: boolean;
}

/**
 * What one of Pointer's posts carries that is not its own words (Slack message
 * metadata, slack.ts; a console message's `relayed`):
 * - "inbox": what other people wrote to the owner, passed on (answers to the
 *   messages Pointer sent for them, a report or a reply that read their Slack
 *   inbox). A reply after it starts as if it had read the inbox: writes need
 *   a yes, and nothing can carry it out (confirm-gate.ts).
 * - "read": a routine's report, written from what Pointer read on its own
 *   (web pages, apps). A reply after it starts tainted: writes need a yes.
 */
export type OutsideContent = "inbox" | "read";

/** One earlier message in the conversation, oldest first. */
export interface ConversationMessage {
  ts: string;
  userId?: string;
  /** Display name, or "Pointer" for Pointer's own messages. */
  name: string;
  text: string;
  isPointer: boolean;
  /** Files attached to that earlier message. */
  files?: SlackFileRef[];
  /** Pointer's post relayed outside content (never set on anyone else's message): data, never its own words. */
  outsideContent?: OutsideContent;
}

export interface PointerRequest {
  /** The new message, with Slack mentions/links normalised. */
  text: string;
  userId: string;
  userName?: string;
  channel: string;
  channelType: "im" | "channel" | "group" | "mpim" | "unknown";
  /**
   * Where repo-task progress and follow-ups live: the thread's ts, or the
   * message's own ts for a top-level message (also in DMs).
   */
  threadTs: string;
  /** Earlier messages in this thread (or recent DM messages), oldest first, excluding the new one. */
  history: ConversationMessage[];
  /** The channel's bound default repo, if any. */
  channelRepo?: string;
  /** Repo/branch/PR this thread is already working on, if any. */
  thread?: ThreadState | null;
  /**
   * Files shared in this conversation so far (Slack uploads, monday.com files
   * Pointer attached), stored under (channel, threadTs). The brain loads their
   * contents from PointerBrainDeps.attachments; repo tasks get them too.
   */
  attachments?: AttachmentInfo[];
  /**
   * Where the conversation happens: Slack (default), the admin console's chat
   * (channel "web"), or a routine run on a schedule (routines/runner.ts):
   * nobody reading along, read-only tools only, the answer is the report.
   */
  surface?: "slack" | "web" | "routine";
  /** This request's own spending cap instead of Pointer's per-message budget (a routine's budgetUsd). */
  budgetUsd?: number;
  /**
   * A routine run only: the routine is the owner's and reports to them alone
   * (ownerRoutine in slack/user-account.ts), so it may read their Slack
   * account. Set by the runner on each run, never from a message.
   */
  ownerRoutine?: boolean;
  /**
   * Slack only, set by the Slack layer, never from a message: this message
   * answers one Pointer sent this person (or into this thread) for the owner
   * (slack/outreach.ts), so it is passed on to the owner. What Pointer sent
   * is already visible to them in this conversation.
   */
  answering?: {
    /** Who asked for it (the owner), as that message named them. */
    askedBy: string;
    /** When Pointer sent it (ISO). */
    sentAt: string;
    /** What Pointer sent, redacted and clipped. */
    text: string;
    /** The message is a reply in that message's own thread. */
    inThread: boolean;
  };
}

/** What a step Pointer takes is about, so the console can show an icon. */
export type ActivityKind = "web" | "github" | "memory" | "notes" | "monday" | "task" | "agent" | "other";

/**
 * Live activity while Pointer answers (the admin console shows it; Slack does
 * not ask for it): the answer text as it is written, and each step it takes.
 */
export type PointerActivity =
  /** More of the answer text, as it is written. */
  | { type: "text"; delta: string }
  /** A new turn starts: the text so far was a note before using tools, not the answer. */
  | { type: "turn" }
  /** A tool use or a delegation started. `agent` is set when a team member took the step. */
  | { type: "step"; id: string; label: string; kind: ActivityKind; agent?: string }
  /** That step finished. */
  | { type: "step-done"; id: string; isError: boolean };

export interface PointerReply {
  /** Final answer, Markdown (the Slack layer converts it to mrkdwn). */
  text: string;
  costUsd?: number;
  /** Who spent costUsd: Pointer ("pointer") and the team members it asked (see attribution.ts). */
  agentCosts?: AgentCosts;
  /** The AI provider that answered (the first of the chat or routines route that could), for its monthly cap. */
  provider?: string;
  /**
   * What each provider spent of costUsd when more than one ran (a provider
   * failed and the next answered), so each one's cap sees its own part
   * (UsageRepo.recordChat). Absent: all of it is `provider`'s.
   */
  providerCosts?: Record<string, number>;
  /** Providers that failed before this one answered (routing.ts), in order; absent when the first answered. */
  fallback?: FallbackNote[];
  /** The reply read the owner's Slack inbox (slack_my_inbox): it may quote what people wrote there, so it is posted as outside content. */
  readInbox?: boolean;
  isError: boolean;
}

export interface StartRepoTaskInput {
  /** owner/repo; when omitted the Slack layer uses the thread repo, then the channel default. */
  repo?: string;
  instruction: string;
}

export type StartRepoTaskResult = { ok: true; taskId: string; repo: string } | { ok: false; error: string };

/** Provided by the Slack layer per request: posts the progress message, saves the task, launches the worker. */
export type StartRepoTask = (input: StartRepoTaskInput) => Promise<StartRepoTaskResult>;

export type AddAttachment = (file: NewAttachment) => Promise<{ ok: true; info: AttachmentInfo } | { ok: false; error: string }>;

export interface PointerContext {
  startRepoTask: StartRepoTask;
  /** Live status of the repo tasks in this conversation (else the ones running anywhere), as text. */
  taskStatus?: () => Promise<string>;
  /** Store a file in this conversation (e.g. a monday.com item's files) so Pointer and the team can use it. */
  addAttachment?: AddAttachment;
  /** Live activity while answering (streamed text, tool uses, delegations); absent in Slack. Must not throw. */
  onActivity?: (event: PointerActivity) => void;
}

export interface PointerBrain {
  reply(req: PointerRequest, ctx: PointerContext): Promise<PointerReply>;
}

export interface PointerBrainDeps {
  configRepo: ConfigRepo;
  memory: MemoryRepo;
  /** Per-repo project notes; optional so older callers and tests keep working. */
  notes?: NotesRepo;
  /** Per-repo lessons library (team/lessons.ts), read with the notes; optional so older callers and tests keep working. */
  lessons?: LessonsRepo;
  /** Thread attachments; optional so older callers and tests keep working. */
  attachments?: AttachmentRepo;
  /** The providers' monthly caps (budget.ts): a provider whose cap is used up is skipped. Absent: no cap is checked here. */
  spending?: Pick<Spending, "providerCaps">;
}

/** Everything the Slack layer needs; built once in server.ts. */
export interface SlackDeps {
  configRepo: ConfigRepo;
  tasks: TaskRepo;
  runner: Runner;
  memory: MemoryRepo;
  /** Thread attachments (Slack uploads); optional so older tests keep working. */
  attachments?: AttachmentRepo;
  /** Monthly spend tally; optional so older tests keep working. */
  usage?: UsageRepo;
  brain: PointerBrain;
  slack: (botToken: string) => WebClient;
}
