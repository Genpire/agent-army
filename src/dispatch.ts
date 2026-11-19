import type { WebClient } from "@slack/web-api";
import { ATTACHMENT_LIMITS, type AttachmentRepo, type ThreadRef } from "./attachments.js";
import { type Config, isChatReady } from "./config.js";
import { repoAccessError } from "./code-host-access.js";
import {
  KeyedQueue,
  RecentSet,
  type RespondDecision,
  Semaphore,
  dedupeKey,
  isDm,
  isExplicitMention,
  queueKey,
  replyThreadTs,
  shouldRespond,
  taskThreadTs,
} from "./listen.js";
import type {
  ConversationMessage,
  PointerContext,
  PointerRequest,
  SlackDeps,
  SlackFileRef,
  SlackMessageEvent,
  StartRepoTask,
} from "./pointer-types.js";
import {
  downloadSlackFile,
  fetchConversation,
  react,
  slackFileRefs,
  toMrkdwn,
  truncate,
  unreact,
  userName,
} from "./slack.js";
import { type CapStatus, type Spending, monthlyStatus, repoStatus } from "./budget.js";
import type { ThreadState } from "./tasks.js";
import { resolveTaskRepo, startThreadTask } from "./thread-task.js";
import {
  type Command,
  helpText,
  messageText,
  normalizeSlackText,
  parseCommand,
} from "./targeting.js";
import { configSecrets, makeRedactor } from "./worker.js";
import { describeTasks } from "./progress.js";
import { type MonthUsage, usageLine, usd } from "./usage.js";

// In-memory routing state: the web service runs as a single instance (max-instances 1).
function freshState() {
  return {
    seen: new RecentSet(),
    /** Threads Pointer has posted in (`channel:threadTs`): replies there need no Slack lookup. */
    postedThreads: new RecentSet(),
    conversations: new KeyedQueue(),
    brainSlots: new Semaphore(6),
  };
}
let state = freshState();

const THREAD_HISTORY = 50;
const DM_HISTORY = 15;
const REPLY_MAX_CHARS = 12_000;
/** Files downloaded from Slack for one message; the rest are picked up from the history next time. */
const MAX_NEW_FILES_PER_MESSAGE = 10;
const CHANNEL_TYPES: readonly string[] = ["im", "channel", "group", "mpim"];

/** A message that passed shouldRespond, so these fields are present. */
type Incoming = SlackMessageEvent & { channel: string; ts: string; user: string };

/** The Slack layer's dependencies, with the spending caps (built once in server.ts). */
export type DispatchDeps = SlackDeps & {
  /** Caps checked before chat replies and repo tasks; alerts after spend. Absent = no caps (older tests). */
  spending?: Pick<Spending, "checkTask" | "checkChat" | "notify">;
};

interface Ctx {
  e: Incoming;
  config: Config;
  deps: DispatchDeps;
  slack: WebClient;
  botToken: string;
  mentioned: boolean;
  redact: (text: string) => string;
}

/**
 * Routes one Slack `message`/`app_mention` event: decide whether Pointer
 * answers, run a command or ask the brain, and reply. Never throws; problems
 * the user should know about are posted in the conversation.
 */
export async function handleSlackEvent(event: SlackMessageEvent, deps: DispatchDeps): Promise<void> {
  if (!event.channel || !event.ts) return;
  // Queue before the first await so messages in one conversation keep their arrival order.
  await state.conversations.run(queueKey(event), () => route(event, deps));
}

async function route(event: SlackMessageEvent, deps: DispatchDeps): Promise<void> {
  let redact = (text: string) => text;
  try {
    const config = await deps.configRepo.load();
    const botToken = config.slack.botToken;
    if (!botToken) return;
    redact = secretsRedactor(config);

    const decision = shouldRespond(event, {
      botUserId: config.slack.botUserId,
      pointerChannels: config.slack.pointerChannels,
    });
    if (decision === "no") return;
    if (state.seen.has(dedupeKey(event))) return;
    state.seen.add(dedupeKey(event));

    const ctx: Ctx = {
      e: event as Incoming,
      config,
      deps,
      slack: deps.slack(botToken),
      botToken,
      mentioned: isExplicitMention(event, config.slack.botUserId),
      redact,
    };

    // Checked before any reaction or model call (Resolved #7). People from other
    // organisations (Slack Connect) only get Pointer when explicitly allowlisted.
    const allowed = config.slack.allowedUserIds;
    const external = await isExternalUser(ctx.slack, botToken, ctx.e.user_team);
    if ((allowed.length > 0 || external) && !allowed.includes(ctx.e.user)) {
      if (ctx.mentioned) {
        await say(
          ctx,
          `Sorry, you're not on the list of people who can use ${config.team.pointer.name}. Ask the admin to add you.`,
        );
      }
      return;
    }

    await handleMessage(ctx, decision);
  } catch (err) {
    console.error("[slack] event failed:", redact(errorText(err)));
  }
}

async function handleMessage(ctx: Ctx, decision: RespondDecision): Promise<void> {
  const { e, slack } = ctx;
  const raw = e.text ?? "";
  const hasText = normalizeSlackText(raw) !== "";
  // Files Pointer can read make a message worth answering even without text.
  const files = ctx.deps.attachments ? slackFileRefs(e.files) : [];
  // An empty message or a lone mention of someone else is not for Pointer (Resolved #8).
  if (!hasText && files.length === 0 && !ctx.mentioned) return;

  const threadKey = `${e.channel}:${taskThreadTs(e)}`;
  let history: ConversationMessage[] | undefined;
  if (decision === "if-pointer-in-thread" && !state.postedThreads.has(threadKey)) {
    history = await loadHistory(ctx);
    if (!history.some((m) => m.isPointer)) return;
    state.postedThreads.add(threadKey);
  }

  await react(slack, e.channel, e.ts, "eyes");
  let isError = false;
  try {
    const command: Command | null = hasText ? parseCommand(raw) : files.length ? null : { kind: "help" };
    const reply = command
      ? { text: await runCommand(ctx, command), isError: false }
      : await askPointer(ctx, messageText(raw, ctx.config.slack.botUserId) || filesOnlyText(files), history);
    isError = reply.isError;
    await say(ctx, truncate(reply.text, REPLY_MAX_CHARS));
  } catch (err) {
    isError = true;
    const reason = ctx.redact(errorText(err));
    console.error("[slack] message failed:", reason);
    await say(ctx, `:x: Something went wrong: ${reason}`).catch(() => undefined);
  }
  state.postedThreads.add(threadKey);
  await unreact(slack, e.channel, e.ts, "eyes");
  await react(slack, e.channel, e.ts, isError ? "x" : "white_check_mark");
}

async function askPointer(
  ctx: Ctx,
  text: string,
  history: ConversationMessage[] | undefined,
): Promise<{ text: string; isError: boolean }> {
  const { e, config, deps, slack } = ctx;
  if (!isChatReady(config)) {
    return { text: "I'm not fully set up yet. Finish onboarding on the admin page (Claude and Slack).", isError: true };
  }
  // The monthly cap: checked before any model call.
  const allowed = (await deps.spending?.checkChat()) ?? { ok: true };
  if (!allowed.ok) return { text: `:no_entry: ${allowed.error}`, isError: true };
  const threadTs = taskThreadTs(e);
  const [convo, thread, name] = await Promise.all([
    history ?? loadHistory(ctx),
    deps.tasks.getThread(e.channel, threadTs),
    userName(slack, e.user),
  ]);
  const req: PointerRequest = {
    text,
    userId: e.user,
    userName: name,
    channel: e.channel,
    channelType: CHANNEL_TYPES.includes(e.channel_type ?? "") ? (e.channel_type as PointerRequest["channelType"]) : "unknown",
    threadTs,
    history: convo,
    channelRepo: config.bindings[e.channel],
    thread,
  };
  const pointerCtx: PointerContext = {
    startRepoTask: repoTaskStarter(ctx, thread),
    taskStatus: async () => {
      const recent = await deps.tasks.recent(50);
      const here = recent.filter((t) => t.channel === e.channel && t.threadTs === threadTs);
      const running = recent.filter((t) => t.status === "running" || t.status === "queued");
      return ctx.redact(describeTasks(here, running));
    },
  };
  const repo = deps.attachments;
  if (repo) {
    // One key for channels and DMs: in a DM, recent files are copied under the new message's thread.
    const where: ThreadRef = { channel: e.channel, threadTs };
    try {
      const unread = await storeSharedFiles(ctx, repo, where, convo);
      if (unread.length) req.text += `\n\n[${config.team.pointer.name} could not read these attachments: ${unread.join("; ")}]`;
      req.attachments = await repo.list(where);
    } catch (err) {
      console.error("[slack] attachments failed:", ctx.redact(errorText(err)));
    }
    pointerCtx.addAttachment = (file) => repo.add(where, file);
  }
  const reply = await state.brainSlots.run(() => deps.brain.reply(req, pointerCtx));
  void deps.usage
    ?.recordChat(reply.costUsd)
    .then(() => deps.spending?.notify())
    .catch((err) => console.error("[usage] chat cost not recorded:", errorText(err)));
  const body = ctx.redact(reply.text.trim()) || "(no reply)";
  return { text: toMrkdwn(reply.isError && !body.startsWith(":x:") ? `:x: ${body}` : body), isError: reply.isError };
}

/** A Slack file's name for notes to Pointer: one line, no brackets. */
const fileLabel = (f: SlackFileRef): string => (f.name || f.title || f.id).replace(/[\r\n[\]]+/g, " ").slice(0, 120);

/** Stand-in text for a bare file share, so Pointer knows what arrived. */
function filesOnlyText(files: SlackFileRef[]): string {
  const what = files.length === 1 ? "a file" : `${files.length} files`;
  return `(shared ${what} without a message: ${files.map(fileLabel).join(", ")})`;
}

/** "missing files:read permission (reinstall the Slack app)" → "missing files:read permission — reinstall the Slack app". */
const reasonText = (reason: string): string => reason.replace(/\.$/, "").replace(/ \(([^()]*)\)$/, " — $1");

/**
 * Downloads the files shared in this conversation (the new message first, then
 * the history, newest first) that the thread has not stored yet, and stores
 * them. Returns a short reason per file it could not read: a failed download
 * never fails the reply. File contents and the token are never logged.
 */
async function storeSharedFiles(
  ctx: Ctx,
  repo: AttachmentRepo,
  where: ThreadRef,
  history: ConversationMessage[],
): Promise<string[]> {
  const shared = new Map<string, SlackFileRef>();
  const fromHistory = [...history].reverse().flatMap((m) => m.files ?? []);
  for (const f of [...slackFileRefs(ctx.e.files), ...fromHistory]) if (!shared.has(f.id)) shared.set(f.id, f);
  if (shared.size === 0) return [];

  const stored = await repo.list(where);
  const have = new Set(stored.filter((f) => f.source === "slack").map((f) => f.sourceId));
  const fresh = [...shared.values()].filter((f) => !have.has(f.id));
  const room = Math.max(0, ATTACHMENT_LIMITS.maxFilesPerThread - stored.length);
  const now = fresh.slice(0, Math.min(MAX_NEW_FILES_PER_MESSAGE, room));

  const unread: string[] = [];
  for (const f of now) {
    try {
      const file = await downloadSlackFile(ctx.slack, ctx.botToken, f);
      const added = await repo.add(where, { ...file, source: "slack", sourceId: f.id });
      if (!added.ok) unread.push(`${fileLabel(f)} (${reasonText(added.error)})`);
    } catch (err) {
      unread.push(`${fileLabel(f)} (${reasonText(ctx.redact(errorText(err)))})`);
    }
  }
  const later = fresh.slice(now.length);
  if (later.length) {
    const why =
      room < MAX_NEW_FILES_PER_MESSAGE
        ? `this conversation already holds ${ATTACHMENT_LIMITS.maxFilesPerThread} files; start a new thread for more`
        : `at most ${MAX_NEW_FILES_PER_MESSAGE} new files per message; the rest are read with the next message`;
    unread.push(`${later.map(fileLabel).join(", ")} (${why})`);
  }
  return unread;
}

/** Saves the task, posts its progress message in the thread and launches the worker. Never throws. */
function repoTaskStarter(ctx: Ctx, thread: ThreadState | null): StartRepoTask {
  const { e, deps, slack } = ctx;
  return async ({ repo, instruction }) => {
    try {
      const config = await deps.configRepo.load();
      // The worker uses the same rule to pick the connection (and its token) for the task.
      const checked = resolveTaskRepo(config, { repo, threadRepo: thread?.repo, channelRepo: config.bindings[e.channel] });
      if (!checked.ok) return checked;
      const target = checked.repo;
      if (!instruction.trim()) return { ok: false, error: "Say what the team should do." };

      const threadTs = taskThreadTs(e);
      const started = await startThreadTask(
        { tasks: deps.tasks, runner: deps.runner, slack, redact: ctx.redact, budget: deps.spending },
        {
          repo: target,
          channel: e.channel,
          threadTs,
          userId: e.user,
          instruction,
          ackText:
            thread && thread.repo === target
              ? `:saluting_face: Continuing on \`${target}\` (branch \`${thread.branch}\`)…`
              : `:saluting_face: On it. Putting the team on \`${target}\`…`,
          trigger: "slack",
        },
      );
      state.postedThreads.add(`${e.channel}:${threadTs}`);
      return started.ok ? { ok: true, taskId: started.taskId, repo: target } : started;
    } catch (err) {
      return { ok: false, error: `Could not start the task: ${ctx.redact(errorText(err))}` };
    }
  };
}

async function runCommand(ctx: Ctx, command: Command): Promise<string> {
  const { e, config, deps } = ctx;
  switch (command.kind) {
    case "help":
      return helpText(config.team.pointer.name);
    case "status":
      return statusText(ctx);
    case "bind":
      {
        const denied = repoAccessError(config, command.repo);
        if (denied) return `\`${command.repo}\`: ${denied}`;
      }
      await deps.configRepo.update((c) => {
        c.bindings[e.channel] = command.repo;
      });
      return `This channel now defaults to \`${command.repo}\`.`;
    case "unbind":
      await deps.configRepo.update((c) => {
        delete c.bindings[e.channel];
      });
      return "This channel no longer has a default project.";
    case "listen":
    case "unlisten":
      return setListening(ctx, command.kind === "listen");
  }
}

async function setListening(ctx: Ctx, on: boolean): Promise<string> {
  const { e, deps } = ctx;
  if (isDm(e)) return "That only applies to channels. In DMs I already answer every message.";
  let was = false;
  await deps.configRepo.update((c) => {
    was = c.slack.pointerChannels.includes(e.channel);
    c.slack.pointerChannels = c.slack.pointerChannels.filter((id) => id !== e.channel);
    if (on) c.slack.pointerChannels.push(e.channel);
  });
  if (on) {
    return was
      ? "I'm already answering every message in this channel."
      : ":ear: I'll answer every message in this channel now. Say `stop listening` to undo.";
  }
  return was
    ? "OK. Here I'll only answer when mentioned, and in threads I'm in."
    : "I wasn't listening here. I answer here when mentioned, and in threads I'm in.";
}

async function statusText({ e, config, deps }: Ctx): Promise<string> {
  const [recent, usage] = await Promise.all([deps.tasks.recent(5), deps.usage?.month().catch(() => undefined)]);
  const project = config.bindings[e.channel];
  const listening = isDm(e)
    ? "yes (a DM)"
    : config.slack.pointerChannels.includes(e.channel)
      ? "yes, I answer every message"
      : "no, mention me (or say `listen here`)";
  return [
    `*Project for this channel:* ${project ? `\`${project}\`` : "_none_"}`,
    `*Listening here:* ${listening}`,
    `*Runner:* ${deps.runner.kind}`,
    ...(usage ? [`*Claude spend this month:* ${usageLine(usage)}`] : []),
    ...(usage ? capLines(config, usage, project) : []),
    "*Recent tasks:*",
    ...(recent.length
      ? recent.map((t) => `• \`${t.repo}\` — ${t.status}${t.costUsd !== undefined ? ` — ${usd(t.costUsd)}` : ""}${t.prUrl ? ` — <${t.prUrl}|PR>` : ""}`)
      : ["• none yet"]),
  ].join("\n");
}

/** The monthly cap and this channel's repository cap, for `status`; nothing when neither is set. */
function capLines(config: Config, usage: MonthUsage, project: string | undefined): string[] {
  const line = (label: string, s: CapStatus | null) =>
    s ? [`*${label}:* ${usd(s.usedUsd)} of ${usd(s.capUsd)} (${s.percent}%)${s.level === "exceeded" ? ", used up" : ""}`] : [];
  return [...line("Monthly cap", monthlyStatus(config.budget, usage)), ...(project ? line(`Cap for \`${project}\``, repoStatus(config.budget, usage, project)) : [])];
}

function loadHistory({ e, slack, config }: Ctx): Promise<ConversationMessage[]> {
  return fetchConversation(slack, {
    channel: e.channel,
    threadTs: e.thread_ts,
    isDm: isDm(e),
    beforeTs: e.ts,
    limit: e.thread_ts ? THREAD_HISTORY : DM_HISTORY,
    botUserId: config.slack.botUserId,
    pointerName: config.team.pointer.name,
  });
}

/** Chat replies go in the thread in channels and flat in DMs. */
function say(ctx: Ctx, text: string) {
  const threadTs = replyThreadTs(ctx.e);
  return ctx.slack.chat.postMessage({ channel: ctx.e.channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
}

/** The installed workspace's team id, looked up once per bot token. */
const teamIds = new Map<string, Promise<string | undefined>>();
async function isExternalUser(slack: WebClient, botToken: string, userTeam: string | undefined): Promise<boolean> {
  if (!userTeam) return false;
  if (!teamIds.has(botToken)) {
    teamIds.set(
      botToken,
      slack.auth
        .test()
        .then((r) => r.team_id)
        .catch(() => {
          teamIds.delete(botToken);
          return undefined;
        }),
    );
  }
  const own = await teamIds.get(botToken);
  return Boolean(own && userTeam !== own);
}

/** Every credential in the config, every GitHub connection's token included. */
const secretsRedactor = (c: Config) => makeRedactor(configSecrets(c));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Tests only: start from empty dedupe, thread, queue and concurrency state. */
export function resetDispatchStateForTests(): void {
  state = freshState();
}

/**
 * Runs one Pointer answer within the limit Slack answers use (six at once in
 * this process), so the admin console's chat shares it instead of adding to it.
 */
export function withBrainSlot<T>(fn: () => Promise<T>): Promise<T> {
  return state.brainSlots.run(fn);
}
