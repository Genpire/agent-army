import { randomBytes } from "node:crypto";
import { onlyClaudeMissing, routeRuntimes } from "../ai/routing.js";
import { ATTACHMENT_LIMITS, type AttachmentInfo, type AttachmentRepo, type ThreadRef, checkUpload, classify, isAttachmentId } from "./attachments.js";
import { type TranscribeOptions, type TranscribeResult, transcribeAttachment } from "./transcribe.js";
import type { Spending } from "../spending/budget.js";
import type { Config, ConfigRepo } from "../core/config.js";
import { KeyedQueue } from "../slack/listen.js";
import type {
  ActivityKind,
  ConversationMessage,
  PointerActivity,
  PointerBrain,
  PointerContext,
  PointerRequest,
  StartRepoTask,
} from "./pointer-types.js";
import { describeTasks } from "../tasks/progress.js";
import { HOST_TERMS, repoHost } from "../integrations/code-hosts/repo-id.js";
import type { Runner } from "../tasks/runner.js";
import type { Store } from "../core/store.js";
import { describeTimeline, plainLine, readTimeline } from "../tasks/task-events.js";
import { type Task, type TaskRepo, type TaskTicket, type ThreadState, WEB_CHANNEL, newTaskId } from "../tasks/tasks.js";
import { type ThreadTaskResult, resolveTaskRepo, startThreadTask } from "../tasks/thread-task.js";
import type { UsageRepo } from "../spending/usage.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";

/**
 * Conversations with Pointer from the admin console. Each is one JSON file
 * (`conversations/<id>.json`) written only by the web service, one change at
 * a time per conversation. Pointer answers in the background with the same
 * brain, tools and concurrency limit as in Slack; repo tasks started here run
 * without Slack (channel "web", thread = the conversation id) and report back
 * into the conversation: their live progress through the task records, their
 * milestones (pull request opened, checks failing, result) as Pointer
 * messages derived from the task records when the conversation is read.
 * Files and voice messages are uploaded to the conversation's thread in the
 * attachment store first (channel "web", thread = the conversation id, the
 * same place Slack files live), then sent with a message: Pointer reads them
 * like Slack files and repo tasks started here get them. Before the first
 * message a conversation's uploads go to a draft id it then takes.
 * Message text, file contents and transcripts are never logged.
 */

export const WEB_USER_ID = "admin";
export const WEB_USER_NAME = "Admin (console)";
export const MESSAGE_MAX_CHARS = 8000;
export const TITLE_MAX_CHARS = 80;
/** Longest Pointer reply kept. */
export const REPLY_MAX_CHARS = 20_000;
/** Earlier messages given to Pointer with a new one. */
const HISTORY_MAX = 50;
/** Live view limits while Pointer answers. */
const LIVE_TEXT_MAX = 20_000;
export const ACTIVITY_MAX = 100;
/** Repo tasks of one conversation returned with it, newest first. */
const TASKS_SHOWN = 30;
/** Files one message carries (as many as Slack reads per message). */
export const MAX_FILES_PER_MESSAGE = 10;
/** The longest voice message the console records. */
export const MAX_RECORDING_MS = 10 * 60_000;
/** Drafts (uploads before a conversation's first message) kept in memory, and for how long. */
const DRAFTS_MAX = 200;
const DRAFT_TTL_MS = 24 * 60 * 60_000;

export const CONVERSATION_ID_RE = /^c-[0-9a-z]{9}-[0-9a-f]{6}$/;

/** One step Pointer took while answering. */
export interface ActivityStep {
  id: string;
  label: string;
  kind: ActivityKind;
  /** The team member who took it, when Pointer delegated. */
  agent?: string;
  startedAt: string;
  endedAt?: string;
  isError?: boolean;
}

/** What a task milestone message reports: the pull request opened, checks failing (a fix round), the result. */
export type TaskMilestone = "pr" | "checks" | "end";

/** A file sent with a message; its bytes are at GET /api/conversations/:id/attachments/:fileId. */
export type MessageFile = Pick<AttachmentInfo, "id" | "name" | "mime" | "size" | "durationMs">;

export interface ChatMessage {
  id: string;
  role: "user" | "pointer";
  /** Markdown; may be empty when the message carries files. */
  text: string;
  /** Files and voice messages sent with this (user) message. */
  files?: MessageFile[];
  at: string;
  costUsd?: number;
  isError?: boolean;
  /** Pointer's steps for this reply ("Used 5 tools"). */
  activity?: ActivityStep[];
  /** Repo tasks started with this message; the console shows their cards right after it. */
  tasks?: string[];
  /** This message reports on a repo task. */
  result?: { taskId: string; milestone: TaskMilestone; round?: number };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Pointer is answering the last message. */
  pending: boolean;
  messages: ChatMessage[];
  /** Every repo task started in this conversation, oldest first. */
  taskIds: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  pending: boolean;
  messageCount: number;
  taskCount: number;
}

/** The reply Pointer is writing now: kept in memory, returned with the conversation. */
export interface LiveReply {
  messageId: string;
  startedAt: string;
  /** The answer so far (resets when Pointer starts a new turn). */
  text: string;
  activity: ActivityStep[];
  /** Repo tasks started so far in this reply. */
  tasks: string[];
}

/** GET /api/conversations/:id */
export interface ConversationView {
  conversation: Conversation;
  /** The repo tasks started in it, newest first, with their live progress. */
  tasks: Task[];
  live?: LiveReply;
}

const conversationKey = (id: string) => `conversations/${id}.json`;
const INDEX_KEY = "conversations/index.json";
const FILE_RE = /^conversations\/(c-[0-9a-z]{9}-[0-9a-f]{6})\.json$/;

export const newConversationId = (now = Date.now()) => `c-${newTaskId(now)}`;
const newMessageId = () => `m-${randomBytes(5).toString("hex")}`;

/** The first line of the first message, short: the conversation's name in the list. */
export function conversationTitle(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return "New conversation";
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : line;
}

const summaryOf = (c: Conversation): ConversationSummary => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt,
  pending: c.pending,
  messageCount: c.messages.length,
  taskCount: c.taskIds.length,
});

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 20).trimEnd()}\n\n…(truncated)`);

/** Conversation files and a summary index (one file, so listing is one read). */
export class ConversationRepo {
  private indexChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store) {}

  async get(id: string): Promise<Conversation | null> {
    if (!CONVERSATION_ID_RE.test(id)) return null;
    const blob = await this.store.get(conversationKey(id));
    if (!blob) return null;
    const data = JSON.parse(blob.toString("utf8")) as Partial<Conversation> & { deleted?: boolean };
    if (data.deleted || !Array.isArray(data.messages)) return null;
    return { ...(data as Conversation), taskIds: Array.isArray(data.taskIds) ? data.taskIds : [] };
  }

  async save(c: Conversation, now = new Date()): Promise<void> {
    c.updatedAt = now.toISOString();
    await this.store.put(conversationKey(c.id), JSON.stringify(c));
    await this.updateIndex((items) => [summaryOf(c), ...items.filter((s) => s.id !== c.id)]);
  }

  /** Erases the conversation (its file keeps only a deleted marker). False when there is none. */
  async remove(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.store.put(conversationKey(id), JSON.stringify({ id, deleted: true }));
    await this.updateIndex((items) => items.filter((s) => s.id !== id));
    return true;
  }

  /** Newest activity first. */
  async list(): Promise<ConversationSummary[]> {
    await this.indexChain;
    const items = (await this.readIndex()) ?? (await this.rebuildIndex());
    return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readIndex(): Promise<ConversationSummary[] | null> {
    const blob = await this.store.get(INDEX_KEY);
    if (!blob) return null;
    try {
      const data = JSON.parse(blob.toString("utf8")) as { items?: ConversationSummary[] };
      return Array.isArray(data.items) ? data.items : null;
    } catch {
      return null;
    }
  }

  private async rebuildIndex(): Promise<ConversationSummary[]> {
    const ids = (await this.store.list("conversations/")).map((k) => k.match(FILE_RE)?.[1]).filter((id): id is string => Boolean(id));
    const found = await Promise.all(ids.map((id) => this.get(id).catch(() => null)));
    const items = found.filter((c): c is Conversation => c !== null).map(summaryOf);
    await this.updateIndex(() => items);
    return items;
  }

  private updateIndex(change: (items: ConversationSummary[]) => ConversationSummary[]): Promise<void> {
    const run = this.indexChain.then(async () => {
      const current = (await this.readIndex()) ?? [];
      await this.store.put(INDEX_KEY, JSON.stringify({ items: change(current) }));
    });
    this.indexChain = run.catch(() => undefined);
    return run;
  }
}

// ---------- Live activity ----------

/** Applies one activity event to the reply being written. Pure apart from mutating `live`. */
export function applyActivity(live: LiveReply, e: PointerActivity, at: string): void {
  switch (e.type) {
    case "text":
      if (live.text.length < LIVE_TEXT_MAX) live.text = (live.text + e.delta).slice(0, LIVE_TEXT_MAX);
      return;
    case "turn":
      live.text = "";
      return;
    case "step":
      if (live.activity.length >= ACTIVITY_MAX || live.activity.some((s) => s.id === e.id)) return;
      live.activity.push({
        id: e.id,
        label: plainLine(e.label, 200),
        kind: e.kind,
        ...(e.agent ? { agent: plainLine(e.agent, 80) } : {}),
        startedAt: at,
      });
      return;
    case "step-done": {
      const step = live.activity.find((s) => s.id === e.id && !s.endedAt);
      if (!step) return;
      step.endedAt = at;
      if (e.isError) step.isError = true;
      return;
    }
  }
}

/** The steps of a finished reply: every step ends when the reply does. */
export const closeActivity = (steps: ActivityStep[], at: string): ActivityStep[] => steps.map((s) => (s.endedAt ? s : { ...s, endedAt: at }));

// ---------- Task milestones ----------

/** The number in a pull or merge request's URL: GitHub /pull/12, GitLab /-/merge_requests/12, Bitbucket /pull-requests/12. */
const prNumber = (url: string) => url.match(/\/(?:pull|merge_requests|pull-requests)\/(\d+)/)?.[1];
/** What the task's code host calls a pull request, and how it writes its number ("#12", "!12" on GitLab). */
const termsOf = (t: Pick<Task, "repo">) => {
  const host = repoHost(t.repo);
  return { pr: HOST_TERMS[host].pr, ref: (url: string) => `${host === "gitlab" ? "!" : "#"}${prNumber(url) ?? ""}` };
};
const prLink = (t: Pick<Task, "repo">, url: string, label?: string) => {
  const terms = termsOf(t);
  return `[${label ?? `${terms.pr} ${terms.ref(url)}`.trim()}](${url})`;
};
const usdText = (n: number | undefined) => (n === undefined ? "" : ` · ~$${n.toFixed(2)}`);

/** The checks line of a result, Markdown, or "" when the repository has none. */
export function checksMarkdown(ci: Task["ci"]): string {
  if (!ci) return "";
  const after = ci.fixRounds ? ` after ${ci.fixRounds} fix round${ci.fixRounds === 1 ? "" : "s"}` : "";
  const names = ci.names.length ? `: ${ci.names.slice(0, 8).join(", ")}${ci.names.length > 8 ? ` +${ci.names.length - 8} more` : ""}` : "";
  switch (ci.state) {
    case "passed":
      return `**Checks:** ${ci.total === 1 ? "1 passed" : `all ${ci.total} passed`}${after}`;
    case "failed":
      return `**Checks:** ${ci.names.length} failing${after}${names}`;
    case "pending":
      return `**Checks:** still running when the wait ended${names}`;
    case "none":
      return "";
  }
}

const firstLine = (text: string) => plainLine(text.split("\n").find((l) => l.trim()) ?? "", 120);

/** Pointer's message with a task's result: everything the Slack result says, in Markdown. */
export function taskResultMarkdown(t: Task): string {
  const footer = `_${t.repo}${t.branch ? ` · \`${t.branch}\`` : ""}${usdText(t.costUsd)}_`;
  const notes = t.notes ?? [];
  const terms = termsOf(t);
  if (t.status === "failed") {
    const reason = t.error ?? "The task stopped.";
    if (t.prUrl) {
      const where = t.prDraft ? `a draft ${terms.pr}` : `the ${terms.pr}`;
      return [
        `**Stopped:** ${reason} The unfinished work is saved in ${where}: ${prLink(t, t.prUrl, terms.ref(t.prUrl))}. Reply here (for example "continue") to pick it up on the same branch.`,
        ...notes,
        footer,
      ].join("\n\n");
    }
    return [`**The task failed:** ${reason}`, ...notes, footer].join("\n\n");
  }
  const r = t.report;
  const title = r?.title || firstLine(t.instruction) || "Task finished";
  const head =
    t.kind === "blocked"
      ? `**Blocked: ${title}**`
      : t.kind === "change" && t.prUrl
        ? `**Done: ${title}** — ${prLink(t, t.prUrl, `review the ${terms.pr}`)}`
        : `**${title}**`;
  return [
    head,
    r?.summary ?? t.summary ?? "",
    r?.verification ? `**Verification:** ${r.verification}` : "",
    r?.risks ? `**Risks:** ${r.risks}` : "",
    checksMarkdown(t.ci),
    ...notes,
    footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const milestoneKey = (m: NonNullable<ChatMessage["result"]>) => `${m.taskId}:${m.milestone}:${m.round ?? ""}`;
const isActive = (t: Task) => t.status === "queued" || t.status === "running";

/**
 * The milestone messages a conversation still lacks, from its tasks' records:
 * the result of each task that ended, and, while a task runs, its pull request
 * being opened and each round of fixing failing checks. A task that already
 * ended gets only its result. Pure.
 */
export function pendingMilestones(c: Conversation, tasks: Task[]): ChatMessage[] {
  const have = new Set(c.messages.flatMap((m) => (m.result ? [milestoneKey(m.result)] : [])));
  const out: ChatMessage[] = [];
  const add = (t: Task, milestone: TaskMilestone, at: string, text: string, isError = false, round?: number) => {
    const result = { taskId: t.id, milestone, ...(round !== undefined ? { round } : {}) };
    if (have.has(milestoneKey(result))) return;
    out.push({ id: `r-${t.id}-${milestone}${round ?? ""}`, role: "pointer", text, at, result, ...(isError ? { isError } : {}) });
  };
  for (const t of tasks) {
    if (!c.taskIds.includes(t.id)) continue;
    if (!isActive(t)) {
      add(t, "end", t.updatedAt, clip(taskResultMarkdown(t), REPLY_MAX_CHARS), t.status === "failed");
      continue;
    }
    if (t.prUrl) {
      const title = t.report?.title ? `: **${t.report.title}**` : "";
      // A follow-up pushes to the pull request an earlier task of this conversation opened.
      const verb = tasks.some((o) => o.id < t.id && o.prUrl === t.prUrl) ? "Updated" : "Opened";
      add(t, "pr", t.stage?.at ?? t.updatedAt, `${verb} ${prLink(t, t.prUrl)}${title}. Waiting for its checks…`);
    }
    if (t.fixRound) {
      const failing = t.fixRound.failing.length ? `: ${t.fixRound.failing.slice(0, 8).join(", ")}` : "";
      add(
        t,
        "checks",
        t.fixRound.at,
        `The ${termsOf(t).pr}'s checks failed${failing}. The team is fixing them (round ${t.fixRound.round} of ${t.fixRound.rounds})…`,
        false,
        t.fixRound.round,
      );
    }
  }
  return out;
}

/** Inserts messages by time (after messages at the same time), keeping the rest in order. */
export function insertByTime(messages: ChatMessage[], added: ChatMessage[]): ChatMessage[] {
  const out = [...messages];
  for (const m of [...added].sort((a, b) => a.at.localeCompare(b.at))) {
    const index = out.findIndex((x) => x.at > m.at);
    if (index === -1) out.push(m);
    else out.splice(index, 0, m);
  }
  return out;
}

const isVoice = (f: Pick<MessageFile, "name" | "mime">) => classify(f.name, f.mime) === "audio";
const fileNames = (files: MessageFile[]) => files.map((f) => `${f.name}${isVoice(f) ? " (voice message)" : ""}`).join(", ");

/** What Pointer reads for a message sent with files only, like Slack's bare file shares. */
export function filesOnlyText(files: MessageFile[]): string {
  if (files.length === 1 && isVoice(files[0]!)) return `(sent a voice message without text: ${fileNames(files)})`;
  return `(shared ${files.length === 1 ? "a file" : `${files.length} files`} without a message: ${fileNames(files)})`;
}

/** A conversation's name when its first message has files only. */
function filesTitle(files: MessageFile[]): string {
  if (files.length === 1) return isVoice(files[0]!) ? "Voice message" : files[0]!.name;
  return `${files.length} files`;
}

/** The conversation so far as Pointer's history (oldest first, the newest HISTORY_MAX); messages note the files they carried. */
export function toHistory(messages: ChatMessage[], pointerName: string): ConversationMessage[] {
  return messages.slice(-HISTORY_MAX).map((m) => ({
    ts: m.at,
    ...(m.role === "user" ? { userId: WEB_USER_ID } : {}),
    name: m.role === "user" ? WEB_USER_NAME : pointerName,
    text: m.files?.length ? (m.text ? `${m.text}\n[Attached: ${fileNames(m.files)}]` : filesOnlyText(m.files)) : m.text,
    isPointer: m.role === "pointer",
  }));
}

// ---------- The service ----------

export interface ConversationDeps {
  store: Store;
  configRepo: ConfigRepo;
  tasks: TaskRepo;
  runner: Runner;
  brain: PointerBrain;
  usage?: UsageRepo;
  /** The spending caps: checked before replies and repo tasks, alerts after spend. Absent = no caps (tests). */
  spending?: Pick<Spending, "checkTask" | "checkChat" | "notify">;
  /** The concurrency limit Slack answers use; without it, answers run unlimited (tests). */
  brainSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The attachment store Slack files use; without it, the console takes no files (older tests). */
  attachments?: AttachmentRepo;
  now?: () => Date;
}

export type SendResult = { ok: true; conversation: Conversation } | { ok: false; status: 400 | 404 | 409; error: string };

/** Files to send with a message (ids from uploads to this conversation, or to `draftId` before its first message). */
export interface SendFiles {
  attachmentIds?: string[];
  /** POST /api/conversations: the draft the files were uploaded to; the conversation takes its id. */
  draftId?: string;
}

/** One file uploaded from the console: the browser's name and type, and its bytes. */
export interface Upload {
  name: string;
  type: string;
  bytes: Uint8Array;
  /** A voice message's length as recorded (display only). */
  durationMs?: number;
}

export type UploadResult =
  | { ok: true; conversationId: string; info: AttachmentInfo }
  | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string };

export type TranscribeCallResult =
  | TranscribeResult
  | { ok: false; reason: "not-found"; error: string };

export type DirectTaskResult =
  | { ok: true; conversationId: string; taskId: string }
  /** 409: a spending cap is used up (no conversation is created). */
  | { ok: false; status: 400 | 409 | 502; error: string; conversationId?: string };

/** What the code hosts' webhooks need to follow up in a console conversation (no Slack there). */
export interface WebThreads {
  /** Adds a Pointer message (Markdown); false when the conversation no longer exists. */
  post(conversationId: string, markdown: string): Promise<boolean>;
  /** Starts a repo task in the conversation, with `ackText` as Pointer's message above its card. */
  startTask(
    conversationId: string,
    input: { repo: string; instruction: string; ackText: string; trigger: Task["trigger"]; ticket?: TaskTicket },
  ): Promise<ThreadTaskResult>;
}

/** Options of a direct task: what started it (the console by default), its monday.com ticket, the conversation's title and Pointer's first message. */
export interface DirectTaskOptions {
  trigger?: Task["trigger"];
  ticket?: TaskTicket;
  /** The conversation's name; the instruction's first line when omitted. */
  title?: string;
  ackText?: string;
}

const STILL_ANSWERING = "Pointer is still answering. Wait for the reply, then send your next message.";
const NOT_FOUND = "Conversation not found.";
const NO_FILES = "Files cannot be attached here.";
const DRAFT_GONE = "The files you attached are no longer waiting here (the server restarted). Remove them and attach them again.";
const FILE_GONE = "A file you attached is no longer here. Remove it and attach it again.";
const NOT_CONNECTED = "Claude is not connected. Add the Anthropic API key on the Integrations page, then ask again.";
const INTERRUPTED = "This reply was interrupted (the server restarted). Send your message again.";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where a console conversation's files live: the same store and key Slack threads use. */
const threadOf = (conversationId: string): ThreadRef => ({ channel: WEB_CHANNEL, threadTs: conversationId });

/** Files the conversation's messages already carry. */
const sentFileIds = (c: Conversation): Set<string> => new Set(c.messages.flatMap((m) => (m.files ?? []).map((f) => f.id)));

/** Why a new message cannot be sent as written, or null. */
function messageProblem(body: string, attachmentIds: string[]): string | null {
  if (!body && attachmentIds.length === 0) return "Write a message first.";
  if (body.length > MESSAGE_MAX_CHARS) return `Messages are limited to ${MESSAGE_MAX_CHARS} characters.`;
  if (new Set(attachmentIds).size > MAX_FILES_PER_MESSAGE) return `A message can carry ${MAX_FILES_PER_MESSAGE} files.`;
  if (attachmentIds.some((id) => !isAttachmentId(id))) return FILE_GONE;
  return null;
}

export class ConversationService implements WebThreads {
  readonly repo: ConversationRepo;
  /** One change at a time per conversation. */
  private readonly queue = new KeyedQueue();
  private readonly live = new Map<string, { reply: LiveReply; redact: (text: string) => string }>();
  /** Answers running in this process; a pending conversation without one was interrupted. */
  private readonly answering = new Map<string, Promise<void>>();
  /** Ids handed out for uploads before a conversation's first message, with when (ms). */
  private readonly drafts = new Map<string, number>();

  constructor(private readonly deps: ConversationDeps) {
    this.repo = new ConversationRepo(deps.store);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  list(): Promise<ConversationSummary[]> {
    return this.repo.list();
  }

  /**
   * Starts a conversation with its first message; Pointer answers in the
   * background. With files, `draftId` is the id they were uploaded to, and
   * the conversation takes it.
   */
  async create(text: string, files: SendFiles = {}): Promise<SendResult> {
    const body = text.trim();
    const ids = files.attachmentIds ?? [];
    const problem = messageProblem(body, ids);
    if (problem) return { ok: false, status: 400, error: problem };
    let id = newConversationId(this.now().getTime());
    if (ids.length || files.draftId) {
      if (!files.draftId || !this.isDraft(files.draftId)) return { ok: false, status: 400, error: DRAFT_GONE };
      id = files.draftId;
    }
    return this.queue.run(id, async (): Promise<SendResult> => {
      if (await this.repo.get(id)) return { ok: false, status: 409, error: "That conversation has already started." };
      const picked = await this.pickFiles(id, ids, new Set());
      if (!picked.ok) return { ok: false, status: 400, error: picked.error };
      const now = this.iso();
      const first: ChatMessage = { id: newMessageId(), role: "user", text: body, at: now, ...(picked.files.length ? { files: picked.files } : {}) };
      const c: Conversation = {
        id,
        title: conversationTitle(body || filesTitle(picked.files)),
        createdAt: now,
        updatedAt: now,
        pending: true,
        messages: [first],
        taskIds: [],
      };
      await this.repo.save(c, this.now());
      this.drafts.delete(id);
      // Inside the queue: nothing reads the conversation between the save and the answer starting.
      this.answerLater(c.id, first);
      return { ok: true, conversation: c };
    });
  }

  /** Adds a message, with the files uploaded for it; 409 while Pointer is still answering the last one. */
  send(id: string, text: string, files: Pick<SendFiles, "attachmentIds"> = {}): Promise<SendResult> {
    const body = text.trim();
    const ids = files.attachmentIds ?? [];
    const problem = messageProblem(body, ids);
    if (problem) return Promise.resolve({ ok: false, status: 400, error: problem });
    return this.queue.run(id, async (): Promise<SendResult> => {
      const c = await this.repo.get(id);
      if (!c) return { ok: false, status: 404, error: NOT_FOUND };
      this.recoverInterrupted(c);
      if (c.pending) return { ok: false, status: 409, error: STILL_ANSWERING };
      const picked = await this.pickFiles(id, ids, sentFileIds(c));
      if (!picked.ok) return { ok: false, status: 400, error: picked.error };
      // Task milestones first, so they sit before the new message (and Pointer sees them).
      c.messages = insertByTime(c.messages, pendingMilestones(c, await this.tasksOf(c)));
      const message: ChatMessage = {
        id: newMessageId(),
        role: "user",
        text: body,
        at: this.iso(),
        ...(picked.files.length ? { files: picked.files } : {}),
      };
      c.messages.push(message);
      c.pending = true;
      await this.repo.save(c, this.now());
      this.answerLater(c.id, message);
      return { ok: true, conversation: c };
    });
  }

  // ---------- Files and voice messages ----------

  /** An id for uploads before a conversation's first message; the conversation takes it when it starts. */
  startDraft(): string {
    const now = this.now().getTime();
    for (const [id, at] of this.drafts) if (now - at > DRAFT_TTL_MS) this.drafts.delete(id);
    while (this.drafts.size >= DRAFTS_MAX) this.drafts.delete(this.drafts.keys().next().value!);
    const id = newConversationId(now);
    this.drafts.set(id, now);
    return id;
  }

  private isDraft(id: string): boolean {
    const at = this.drafts.get(id);
    return at !== undefined && this.now().getTime() - at <= DRAFT_TTL_MS;
  }

  /** The conversation, or a draft's uploads, exists: its files may be read, added and transcribed. */
  async hasFiles(id: string): Promise<boolean> {
    if (!CONVERSATION_ID_RE.test(id)) return false;
    return this.isDraft(id) || Boolean(await this.repo.get(id));
  }

  /**
   * Stores one console upload in the conversation's thread (`id`, or "new" to
   * start a draft). Its type is decided from its bytes (checkUpload); at most
   * MAX_FILES_PER_MESSAGE files wait unsent, and the thread's limit applies.
   */
  async upload(id: string, file: Upload): Promise<UploadResult> {
    const repo = this.deps.attachments;
    if (!repo) return { ok: false, status: 404, error: NO_FILES };
    if (id !== "new" && !(await this.hasFiles(id))) return { ok: false, status: 404, error: NOT_FOUND };
    const checked = checkUpload(file.name, file.type, file.bytes);
    if (!checked.ok) {
      const status = file.bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes ? 413 : file.bytes.byteLength === 0 || !file.name.trim() ? 400 : 415;
      return { ok: false, status, error: checked.error };
    }
    const target = id === "new" ? this.startDraft() : id;
    return this.queue.run(target, async (): Promise<UploadResult> => {
      const c = await this.repo.get(target);
      const sent = c ? sentFileIds(c) : new Set<string>();
      const stored = await repo.list(threadOf(target));
      if (stored.filter((f) => f.source === "web" && !sent.has(f.id)).length >= MAX_FILES_PER_MESSAGE) {
        return { ok: false, status: 409, error: `A message can carry ${MAX_FILES_PER_MESSAGE} files. Send these first, or remove some.` };
      }
      if (stored.length >= ATTACHMENT_LIMITS.maxFilesPerThread) {
        return { ok: false, status: 409, error: `This conversation already has ${stored.length} files, the most it can hold. Start a new conversation for more.` };
      }
      const duration = classify(checked.name, checked.mime) === "audio" && file.durationMs !== undefined ? Math.min(Math.max(0, file.durationMs), MAX_RECORDING_MS) : undefined;
      const added = await repo.add(threadOf(target), {
        name: checked.name,
        mime: checked.mime,
        bytes: file.bytes,
        source: "web",
        ...(duration !== undefined ? { durationMs: duration } : {}),
      });
      if (!added.ok) return { ok: false, status: 409, error: added.error };
      return { ok: true, conversationId: target, info: added.info };
    });
  }

  /** Removes a file uploaded but not sent yet; 409 once a message carries it. */
  async removeUpload(id: string, fileId: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
    const repo = this.deps.attachments;
    if (!repo || !(await this.hasFiles(id))) return { ok: false, status: 404, error: NOT_FOUND };
    return this.queue.run(id, async () => {
      const c = await this.repo.get(id);
      if (c && sentFileIds(c).has(fileId)) return { ok: false as const, status: 409 as const, error: "That file was already sent; it stays with its message." };
      const info = (await repo.list(threadOf(id))).find((f) => f.id === fileId);
      if (!info || info.source !== "web") return { ok: false as const, status: 404 as const, error: "File not found." };
      await repo.remove(threadOf(id), fileId);
      return { ok: true as const };
    });
  }

  /** One of the conversation's own files, with its bytes; null when it has no such file. */
  async file(id: string, fileId: string): Promise<{ info: AttachmentInfo; bytes: Buffer } | null> {
    const repo = this.deps.attachments;
    if (!repo || !isAttachmentId(fileId) || !(await this.hasFiles(id))) return null;
    const info = (await repo.list(threadOf(id))).find((f) => f.id === fileId);
    const bytes = info ? await repo.get(threadOf(id), fileId) : null;
    return info && bytes ? { info, bytes } : null;
  }

  /** Transcribes one of the conversation's voice messages (transcribe.ts) and keeps the transcript for Pointer. */
  async transcribe(id: string, fileId: string, opts: TranscribeOptions = {}): Promise<TranscribeCallResult> {
    const repo = this.deps.attachments;
    if (!repo || !isAttachmentId(fileId) || !(await this.hasFiles(id))) return { ok: false, reason: "not-found", error: "File not found." };
    const info = (await repo.list(threadOf(id))).find((f) => f.id === fileId);
    if (!info) return { ok: false, reason: "not-found", error: "File not found." };
    return transcribeAttachment(repo, threadOf(id), info, await this.deps.configRepo.load(), opts);
  }

  /** The uploads named in a new message, checked: this conversation's own console uploads, not sent before. */
  private async pickFiles(id: string, ids: string[], sent: Set<string>): Promise<{ ok: true; files: MessageFile[] } | { ok: false; error: string }> {
    if (!ids.length) return { ok: true, files: [] };
    const repo = this.deps.attachments;
    if (!repo) return { ok: false, error: NO_FILES };
    const stored = await repo.list(threadOf(id));
    const files: MessageFile[] = [];
    for (const fileId of new Set(ids)) {
      const info = stored.find((f) => f.id === fileId && f.source === "web");
      if (!info) return { ok: false, error: FILE_GONE };
      if (sent.has(fileId)) return { ok: false, error: `${info.name} was already sent.` };
      files.push({ id: info.id, name: info.name, mime: info.mime, size: info.size, ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}) });
    }
    return { ok: true, files };
  }

  /** The conversation with its tasks and the reply being written; adds the milestone messages it lacks. */
  async view(id: string): Promise<ConversationView | null> {
    const first = await this.repo.get(id);
    if (!first) return null;
    let tasks = await this.tasksOf(first);
    let c: Conversation | null = first;
    if (pendingMilestones(first, tasks).length || this.isInterrupted(first)) {
      c = await this.queue.run(id, async () => {
        const fresh = await this.repo.get(id);
        if (!fresh) return null;
        tasks = await this.tasksOf(fresh);
        const added = pendingMilestones(fresh, tasks);
        const recovered = this.recoverInterrupted(fresh);
        if (added.length || recovered) {
          fresh.messages = insertByTime(fresh.messages, added);
          await this.repo.save(fresh, this.now());
        }
        return fresh;
      });
      if (!c) return null;
    }
    const live = this.live.get(id);
    return {
      conversation: c,
      tasks: [...tasks].sort((a, b) => b.id.localeCompare(a.id)),
      ...(live ? { live: { ...live.reply, text: live.redact(live.reply.text), activity: live.reply.activity.map((s) => ({ ...s })) } } : {}),
    };
  }

  /** Erases the conversation and its files (uploads, voice messages, files Pointer attached). */
  async remove(id: string): Promise<boolean> {
    const removed = await this.queue.run(id, async () => {
      const done = await this.repo.remove(id);
      if (done) await this.deps.attachments?.removeAll(threadOf(id)).catch((err: unknown) => console.error("[web] files not erased:", errorText(err).slice(0, 200)));
      return done;
    });
    if (removed) this.live.delete(id);
    return removed;
  }

  /**
   * A repo task straight from the console, without asking Pointer: a new
   * conversation whose first message is the instruction, then the task. The
   * same checks as Slack (the repository's code host connected, its allow list). A monday.com ticket
   * starts one too (trigger "monday", with the ticket, named after it).
   */
  async startDirectTask(repo: string, instruction: string, opts: DirectTaskOptions = {}): Promise<DirectTaskResult> {
    const body = instruction.trim();
    if (!body) return { ok: false, status: 400, error: "Say what the team should do." };
    if (body.length > MESSAGE_MAX_CHARS) return { ok: false, status: 400, error: `Instructions are limited to ${MESSAGE_MAX_CHARS} characters.` };
    const config = await this.deps.configRepo.load();
    const checked = resolveTaskRepo(config, { repo });
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    // Before the conversation is created: a refused task leaves nothing behind (startTask checks again).
    const allowed = (await this.deps.spending?.checkTask(checked.repo)) ?? { ok: true };
    if (!allowed.ok) return { ok: false, status: 409, error: allowed.error };
    const now = this.iso();
    const c: Conversation = {
      id: newConversationId(this.now().getTime()),
      title: conversationTitle(opts.title?.trim() || body),
      createdAt: now,
      updatedAt: now,
      pending: false,
      messages: [{ id: newMessageId(), role: "user", text: body, at: now }],
      taskIds: [],
    };
    await this.queue.run(c.id, () => this.repo.save(c, this.now()));
    const started = await this.startTask(c.id, {
      repo: checked.repo,
      instruction: body,
      ackText: opts.ackText ?? `On it. Putting the team on \`${checked.repo}\`…`,
      trigger: opts.trigger ?? "web",
      ...(opts.ticket ? { ticket: opts.ticket } : {}),
    });
    if (!started.ok) {
      await this.post(c.id, started.error, true);
      return { ok: false, status: 502, error: started.error, conversationId: c.id };
    }
    return { ok: true, conversationId: c.id, taskId: started.taskId };
  }

  // ---------- WebThreads (also used by the webhook) ----------

  post(conversationId: string, markdown: string, isError = false): Promise<boolean> {
    return this.queue.run(conversationId, async () => {
      const c = await this.repo.get(conversationId);
      if (!c) return false;
      c.messages.push({ id: newMessageId(), role: "pointer", text: clip(markdown, REPLY_MAX_CHARS), at: this.iso(), ...(isError ? { isError } : {}) });
      await this.repo.save(c, this.now());
      return true;
    });
  }

  async startTask(
    conversationId: string,
    input: { repo: string; instruction: string; ackText?: string; trigger: Task["trigger"]; ticket?: TaskTicket },
  ): Promise<ThreadTaskResult> {
    const conversation = await this.repo.get(conversationId);
    if (!conversation) return { ok: false, error: NOT_FOUND };
    // A follow-up in a ticket's conversation keeps working on that ticket (same repository).
    const ticket = input.ticket ?? (await this.tasksOf(conversation)).reverse().find((t) => t.ticket && t.repo.toLowerCase() === input.repo.toLowerCase())?.ticket;
    const config = await this.deps.configRepo.load();
    const started = await startThreadTask(
      { tasks: this.deps.tasks, runner: this.deps.runner, redact: makeRedactor(configSecrets(config)), budget: this.deps.spending, configRepo: this.deps.configRepo },
      {
        repo: input.repo,
        channel: WEB_CHANNEL,
        threadTs: conversationId,
        userId: WEB_USER_ID,
        instruction: input.instruction,
        ackText: input.ackText ?? "",
        trigger: input.trigger,
        ...(ticket ? { ticket } : {}),
      },
    );
    if (!started.ok) return started;
    await this.queue.run(conversationId, async () => {
      const c = await this.repo.get(conversationId);
      if (!c) return;
      c.taskIds.push(started.taskId);
      if (input.ackText) {
        c.messages.push({ id: newMessageId(), role: "pointer", text: input.ackText, at: this.iso(), tasks: [started.taskId] });
      }
      await this.repo.save(c, this.now());
    });
    return started;
  }

  // ---------- Pointer's answer ----------

  private answerLater(id: string, message: ChatMessage): void {
    const run = this.answer(id, message).catch((err: unknown) => console.error("[web] reply failed:", errorText(err).slice(0, 200)));
    this.answering.set(id, run);
    void run.finally(() => {
      if (this.answering.get(id) === run) this.answering.delete(id);
    });
  }

  /** Tests: resolves when every answer in flight has been saved. */
  async idle(): Promise<void> {
    while (this.answering.size) await Promise.all([...this.answering.values()]);
  }

  private async answer(id: string, message: ChatMessage): Promise<void> {
    const reply: LiveReply = { messageId: newMessageId(), startedAt: this.iso(), text: "", activity: [], tasks: [] };
    let redact = (text: string) => text;
    this.live.set(id, { reply, redact });
    let result: { text: string; costUsd?: number; isError: boolean };
    try {
      const config = await this.deps.configRepo.load();
      redact = makeRedactor(configSecrets(config));
      this.live.set(id, { reply, redact });
      result = await this.ask(id, message, config, reply, redact);
    } catch (err) {
      const why = redact(errorText(err));
      console.error("[web] reply failed:", why.slice(0, 300));
      result = { text: `Something went wrong: ${why}`, isError: true };
    }
    await this.queue.run(id, async () => {
      try {
        const c = await this.repo.get(id);
        if (!c) return; // deleted while Pointer was answering
        const at = this.iso();
        c.messages.push({
          id: reply.messageId,
          role: "pointer",
          text: clip(result.text, REPLY_MAX_CHARS),
          at,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(result.isError ? { isError: true } : {}),
          ...(reply.activity.length ? { activity: closeActivity(reply.activity, at) } : {}),
          ...(reply.tasks.length ? { tasks: [...reply.tasks] } : {}),
        });
        c.pending = false;
        await this.repo.save(c, this.now());
      } finally {
        // After the save: a reader sees the live reply or the saved message, never neither.
        this.live.delete(id);
      }
    });
  }

  private async ask(
    id: string,
    message: ChatMessage,
    config: Config,
    reply: LiveReply,
    redact: (text: string) => string,
  ): Promise<{ text: string; costUsd?: number; isError: boolean }> {
    // A provider of the chat route (Claude by default) must be connected before any model call.
    const route = routeRuntimes(config, "chat");
    if (!route.ok) return { text: onlyClaudeMissing(route.skipped) ? NOT_CONNECTED : route.error, isError: true };
    // The monthly cap: checked before any model call.
    const allowed = (await this.deps.spending?.checkChat()) ?? { ok: true };
    if (!allowed.ok) return { text: allowed.error, isError: true };
    const c = await this.repo.get(id);
    if (!c) return { text: NOT_FOUND, isError: true };
    const before = c.messages.slice(0, Math.max(0, c.messages.findIndex((m) => m.id === message.id)));
    const thread = await this.deps.tasks.getThread(WEB_CHANNEL, id);
    const req: PointerRequest = {
      text: message.text || filesOnlyText(message.files ?? []),
      userId: WEB_USER_ID,
      userName: WEB_USER_NAME,
      channel: WEB_CHANNEL,
      channelType: "im",
      threadTs: id,
      history: toHistory(before, config.team.pointer.name),
      thread,
      surface: "web",
    };
    const ctx: PointerContext = {
      startRepoTask: this.starter(id, thread, reply),
      taskStatus: () => this.taskStatus(id, redact),
      onActivity: (e) => applyActivity(reply, e, this.iso()),
    };
    const files = this.deps.attachments;
    if (files) {
      // As in Slack: every file of the conversation so far (sent with a message, or attached by Pointer's tools),
      // never uploads still waiting in the composer.
      const sent = sentFileIds(c);
      try {
        req.attachments = (await files.list(threadOf(id))).filter((f) => f.source !== "web" || sent.has(f.id));
      } catch (err) {
        console.error("[web] attachments failed:", redact(errorText(err)).slice(0, 200));
      }
      ctx.addAttachment = (file) => files.add(threadOf(id), file);
    }
    const slot = this.deps.brainSlot ?? (<T>(fn: () => Promise<T>) => fn());
    const answer = await slot(() => this.deps.brain.reply(req, ctx));
    void this.deps.usage
      ?.recordChat(answer)
      .then(() => this.deps.spending?.notify())
      .catch((err: unknown) => console.error("[usage] chat cost not recorded:", errorText(err)));
    const text = redact(answer.text.trim()) || "(no reply)";
    return { text, ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}), isError: answer.isError };
  }

  /** start_repo_task from the console: no Slack; the task's card appears under Pointer's reply. Never throws. */
  private starter(id: string, thread: ThreadState | null, reply: LiveReply): StartRepoTask {
    return async ({ repo, instruction }) => {
      try {
        const config = await this.deps.configRepo.load();
        const checked = resolveTaskRepo(config, { repo, threadRepo: thread?.repo });
        if (!checked.ok) return checked;
        if (!instruction.trim()) return { ok: false, error: "Say what the team should do." };
        const started = await this.startTask(id, { repo: checked.repo, instruction, trigger: "web" });
        if (!started.ok) return started;
        reply.tasks.push(started.taskId);
        return { ok: true, taskId: started.taskId, repo: checked.repo };
      } catch (err) {
        return { ok: false, error: `Could not start the task: ${errorText(err)}` };
      }
    };
  }

  /** repo_task_status in the console: this conversation's tasks with their timelines, else what runs anywhere. */
  private async taskStatus(id: string, redact: (text: string) => string): Promise<string> {
    const c = await this.repo.get(id);
    const here = c ? [...(await this.tasksOf(c))].sort((a, b) => b.id.localeCompare(a.id)) : [];
    const running = (await this.deps.tasks.recent(50)).filter(isActive);
    const parts = [describeTasks(here, running)];
    const now = this.now().getTime();
    for (const t of here.filter(isActive).slice(0, 3)) {
      const timeline = await readTimeline(this.deps.store, t.id).catch(() => null);
      if (timeline) parts.push(`Timeline of task ${t.id}:\n${describeTimeline(timeline, now)}`);
    }
    return redact(parts.join("\n\n"));
  }

  private async tasksOf(c: Conversation): Promise<Task[]> {
    const ids = c.taskIds.slice(-TASKS_SHOWN);
    const found = await Promise.all(ids.map((taskId) => this.deps.tasks.get(taskId).catch(() => null)));
    return found.filter((t): t is Task => t !== null);
  }

  private isInterrupted(c: Conversation): boolean {
    return c.pending && !this.answering.has(c.id);
  }

  /** A pending conversation whose answer is not running here was cut off by a restart: say so and unlock it. */
  private recoverInterrupted(c: Conversation): boolean {
    if (!this.isInterrupted(c)) return false;
    c.pending = false;
    c.messages.push({ id: newMessageId(), role: "pointer", text: INTERRUPTED, at: this.iso(), isError: true });
    return true;
  }
}
