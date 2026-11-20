/**
 * Contracts between the Slack layer (dispatch/server), Pointer's brain and the
 * smoke test. Keep these stable: several modules are built against them.
 */
import type { WebClient } from "@slack/web-api";
import type { AttachmentInfo, AttachmentRepo, NewAttachment } from "./attachments.js";
import type { ConfigRepo } from "./core/config.js";
import type { MemoryRepo } from "./memory.js";
import type { NotesRepo } from "./notes.js";
import type { Runner } from "./runner.js";
import type { TaskRepo, ThreadState } from "./tasks.js";
import type { UsageRepo } from "./spending/usage.js";

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
}

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
  /** Where the conversation happens: Slack (default) or the admin console's chat (channel "web"). */
  surface?: "slack" | "web";
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
  /** Thread attachments; optional so older callers and tests keep working. */
  attachments?: AttachmentRepo;
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
