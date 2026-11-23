import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { ATTACHMENT_LIMITS } from "../chat/attachments.js";
import { safeEqual } from "../core/crypto.js";
import type { ConversationMessage, OutsideContent, SlackFileRef } from "../chat/pointer-types.js";
import { messageText } from "./targeting.js";
import { SLACK_USER_EVENTS, SLACK_USER_SCOPES } from "./user-account.js";

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSec?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false; // replay window
  const expected =
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return safeEqual(expected, signature);
}

/**
 * App manifest for Slack's "create from manifest" (and for updating an
 * existing app). Pointer reads channel, private-channel and DM messages so it
 * can answer without a mention; `app_mention` stays for older installs.
 * channels:read and groups:read let it find a channel by name when asked to
 * post there (slack_list_channels in slack-tools.ts). Bot only: the owner's
 * own account has its manifest (buildAccountManifest).
 */
export function buildManifest(baseUrl: string, botName: string) {
  return {
    display_information: {
      name: botName,
      description: `${botName} answers questions and runs a team of agents that open pull requests.`,
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: botName, always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "chat:write",
          "channels:history",
          "groups:history",
          "im:history",
          "users:read",
          "channels:read",
          "groups:read",
          "reactions:write",
          "files:read",
          "files:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}/slack/events`,
        bot_events: ["app_mention", "message.channels", "message.groups", "message.im"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * The manifest for the owner's own account (slack/user-account.ts), used only
 * by the Slack card's "Your Slack account" section: the bot's manifest plus
 * the user scopes and user events. Once the app is reinstalled with it, Slack
 * also sends the installer's own conversations to the events URL, which are
 * read into their inbox (slack/inbox.ts) and never answered. So the bot's
 * manifest never asks for them: a deployment without the owner's account
 * receives nothing private.
 */
export function buildAccountManifest(baseUrl: string, botName: string) {
  const bot = buildManifest(baseUrl, botName);
  return {
    ...bot,
    oauth_config: { scopes: { ...bot.oauth_config.scopes, user: [...SLACK_USER_SCOPES] } },
    settings: { ...bot.settings, event_subscriptions: { ...bot.settings.event_subscriptions, user_events: [...SLACK_USER_EVENTS] } },
  };
}

export function manifestCreateUrl(manifest: object): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function slackClient(botToken: string): WebClient {
  return new WebClient(botToken, { retryConfig: { retries: 2 } });
}

/** Slack mrkdwn is not Markdown: convert the few constructs agents emit. */
export function toMrkdwn(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
}

export function truncate(text: string, max = 3500): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n…(truncated)`;
}

/** Slack ts "1700000000.123456": compared as seconds, then the fraction, never through a float. */
export function tsAfter(a: string, b: string): boolean {
  const [as = "0", af = ""] = a.split(".");
  const [bs = "0", bf = ""] = b.split(".");
  if (Number(as) !== Number(bs)) return Number(as) > Number(bs);
  return af.padEnd(6, "0") > bf.padEnd(6, "0");
}

/** When a Slack ts was, to the second. */
export const tsDate = (ts: string): Date => new Date(Number(ts.split(".")[0]) * 1000);

/** Display names rarely change; one users.info call per person per process. */
const userNames = new Map<string, string>();

export async function userName(client: { users: Pick<WebClient["users"], "info"> }, userId: string): Promise<string> {
  const cached = userNames.get(userId);
  if (cached) return cached;
  try {
    const { user } = await client.users.info({ user: userId });
    const name = user?.profile?.display_name || user?.real_name || user?.profile?.real_name || userId;
    userNames.set(userId, name);
    return name;
  } catch {
    return userId; // not cached: a transient failure should not stick
  }
}

// ---------------------------------------------------------------------------
// What Pointer's own posts are (Slack message metadata)

/**
 * The `metadata` event types on Pointer's own posts (chat.postMessage), read
 * back from a conversation's history with include_all_metadata. Only posts by
 * Pointer's bot are read for them; a post without one (from before them, or a
 * path that sets none) is not a chat reply.
 * - reply: Pointer's own chat reply to whoever it is talking with.
 * - sent: a message it sent at someone's request (slack_send_message).
 * - outside: a post that relays outside content (OutsideContent): an answer
 *   passed on to the owner, a routine's report, a reply that read the owner's
 *   inbox. Its payload's `level` says which.
 */
export const POINTER_POST_TYPES = {
  reply: "pointer_chat_reply",
  sent: "pointer_sent_message",
  outside: "pointer_outside_content",
} as const;

export type PointerPostKind = keyof typeof POINTER_POST_TYPES;

/** The metadata for one of Pointer's posts: its kind, where it comes from, and for outside content its level. Nothing private. */
export function pointerPostMetadata(
  kind: PointerPostKind,
  source: string,
  level?: OutsideContent,
): { event_type: string; event_payload: { source: string; level?: OutsideContent } } {
  return { event_type: POINTER_POST_TYPES[kind], event_payload: { source, ...(kind === "outside" ? { level: level ?? "inbox" } : {}) } };
}

/** A message as conversations.history and .replies return it, with its metadata. */
export interface RawMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown;
  metadata?: { event_type?: string; event_payload?: unknown };
}

/** What a post of Pointer's metadata says it is; undefined for none (or someone else's type). */
export function pointerPostKind(m: Pick<RawMessage, "metadata">): PointerPostKind | undefined {
  const type = m.metadata?.event_type;
  return (Object.keys(POINTER_POST_TYPES) as PointerPostKind[]).find((k) => POINTER_POST_TYPES[k] === type);
}

/** The outside content a post of Pointer's relays, from its metadata; a level Slack did not keep counts as "inbox", the stricter one. */
export function relayedContent(m: Pick<RawMessage, "metadata">): OutsideContent | undefined {
  if (pointerPostKind(m) !== "outside") return undefined;
  const payload = m.metadata?.event_payload;
  const level = payload && typeof payload === "object" ? (payload as { level?: unknown }).level : undefined;
  return level === "read" ? "read" : "inbox";
}

/**
 * The conversation before a new message, oldest first: the thread (via
 * conversations.replies) or, for a top-level DM message, recent DM history.
 * A top-level channel message starts a new thread and has no history.
 * Long threads keep their first message plus the latest ones. Pointer's posts
 * that relayed outside content say so (outsideContent, from their metadata):
 * the reply then starts as if it had read it (pointer.ts). Never throws.
 */
export async function fetchConversation(
  client: WebClient,
  opts: {
    channel: string;
    threadTs?: string;
    isDm: boolean;
    /** The new message: it and anything after it are excluded. */
    beforeTs: string;
    limit: number;
    /** Identifies Pointer's own messages; without it any bot message counts as Pointer's. */
    botUserId?: string;
    pointerName?: string;
  },
): Promise<ConversationMessage[]> {
  try {
    let raw: RawMessage[];
    // With the metadata: it says which of Pointer's posts relayed outside content.
    if (opts.threadTs) {
      const res = await client.conversations.replies({ channel: opts.channel, ts: opts.threadTs, limit: 200, include_all_metadata: true });
      raw = res.messages ?? [];
    } else if (opts.isDm) {
      const res = await client.conversations.history({
        channel: opts.channel,
        latest: opts.beforeTs,
        inclusive: false,
        limit: opts.limit,
        include_all_metadata: true,
      });
      raw = (res.messages ?? []).slice().reverse();
    } else {
      return [];
    }

    const before = raw.filter(
      (m): m is RawMessage & { ts: string } =>
        Boolean(m.ts && (m.text?.trim() || slackFileRefs(m.files).length)) && Number(m.ts) < Number(opts.beforeTs),
    );
    const kept = before.length > opts.limit ? [before[0]!, ...before.slice(-(opts.limit - 1))] : before;

    const isPointer = (m: RawMessage) => (opts.botUserId ? m.user === opts.botUserId : Boolean(m.bot_id));
    const people = [...new Set(kept.filter((m) => !isPointer(m) && m.user).map((m) => m.user!))];
    const names = new Map(await Promise.all(people.map(async (id) => [id, await userName(client, id)] as const)));

    return kept.map((m) => {
      const mine = isPointer(m);
      const files = slackFileRefs(m.files);
      const relayed = mine ? relayedContent(m) : undefined;
      return {
        ts: m.ts,
        userId: m.user,
        name: mine ? (opts.pointerName ?? "Pointer") : (names.get(m.user ?? "") ?? m.user ?? "someone"),
        text: messageText(m.text ?? "", opts.botUserId),
        isPointer: mine,
        ...(files.length ? { files } : {}),
        ...(relayed ? { outsideContent: relayed } : {}),
      };
    });
  } catch {
    return [];
  }
}

const FILE_STRING_FIELDS = ["name", "title", "mimetype", "filetype", "url_private", "url_private_download", "file_access"] as const;

/**
 * The fields Pointer uses from Slack file objects (events, history,
 * files.info). Deleted files and files hidden by the plan's limits are dropped.
 */
export function slackFileRefs(files: unknown): SlackFileRef[] {
  if (!Array.isArray(files)) return [];
  const out: SlackFileRef[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const raw = f as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id || raw.mode === "tombstone" || raw.mode === "hidden_by_limit") continue;
    const ref: SlackFileRef = { id: raw.id };
    for (const key of FILE_STRING_FIELDS) {
      const value = raw[key];
      if (typeof value === "string" && value) ref[key] = value;
    }
    if (typeof raw.size === "number") ref.size = raw.size;
    out.push(ref);
  }
  return out;
}

const MISSING_FILES_SCOPE ="missing files:read permission (reinstall the Slack app)";
const MAX_REDIRECTS = 3;
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Slack only accepts the bot token for files on files.slack.com; nothing else ever gets it. */
function isSlackFileUrl(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === "files.slack.com" && !url.port && !url.username && !url.password;
}

/**
 * Downloads a file shared in Slack with the bot token (needs the `files:read`
 * scope). The token is sent only to https://files.slack.com; redirects
 * elsewhere are followed without it. Errors are short and never carry the token.
 */
export async function downloadSlackFile(
  client: WebClient,
  botToken: string,
  file: SlackFileRef,
  fetchFn: typeof fetch = fetch,
): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  let ref = file;
  if (!(ref.url_private_download || ref.url_private) || ref.file_access === "check_file_info") {
    let info: unknown;
    try {
      info = (await client.files.info({ file: file.id })).file;
    } catch (err) {
      const code = (err as { data?: { error?: unknown } }).data?.error;
      throw new Error(
        code === "missing_scope"
          ? MISSING_FILES_SCOPE
          : `Slack would not describe the file (${typeof code === "string" ? code : "error"})`,
      );
    }
    const [fresh] = slackFileRefs([info]);
    if (!fresh) throw new Error("Slack no longer has this file");
    ref = { ...file, ...fresh };
  }

  const name = ref.name || ref.title || ref.id;
  const mime = ref.mimetype || "";
  const max = ATTACHMENT_LIMITS.maxFileBytes;
  if (ref.size !== undefined && ref.size > max) throw new Error(`larger than ${mb(max)}`);

  let url: URL;
  try {
    url = new URL(ref.url_private_download || ref.url_private || "");
  } catch {
    throw new Error("Slack gave no usable download link");
  }
  if (!isSlackFileUrl(url)) throw new Error("not a file stored on Slack");

  let res: Response;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetchFn(url.href, {
        redirect: "manual",
        ...(isSlackFileUrl(url) ? { headers: { Authorization: `Bearer ${botToken}` } } : {}),
      });
    } catch {
      throw new Error("download from Slack failed");
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await discard(res);
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects from Slack");
    try {
      url = new URL(location, url);
    } catch {
      throw new Error("Slack redirected to an invalid address");
    }
  }
  if (!res.ok) {
    await discard(res);
    throw new Error(`Slack returned HTTP ${res.status}`);
  }
  if (Number(res.headers.get("content-length")) > max) {
    await discard(res);
    throw new Error(`larger than ${mb(max)}`);
  }

  const bytes = await readCapped(res, max);
  // Without files:read Slack answers with its HTML sign-in page instead of the file.
  const html = /^text\/html\b/i.test(res.headers.get("content-type") ?? "");
  const expectsHtml = mime === "text/html" || ref.filetype === "html" || /\.html?$/i.test(name);
  if (html && (!expectsHtml || (ref.size !== undefined && ref.size !== bytes.byteLength))) {
    throw new Error(MISSING_FILES_SCOPE);
  }
  return { name, mime, bytes };
}

/** Releases a response body we do not read, so the connection is freed. */
const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

/** Reads a response body, stopping as soon as it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error("download from Slack was interrupted");
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`larger than ${mb(max)}`);
    }
    chunks.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Posts files (e.g. screenshots) as one reply in a thread, with a comment.
 * Needs the files:write scope; Slack's error code (e.g. "missing_scope") is
 * on the thrown error, see slackErrorCode.
 */
export async function uploadThreadFiles(
  client: Pick<WebClient, "filesUploadV2">,
  opts: { channel: string; threadTs: string; comment: string; files: { filename: string; data: Buffer }[] },
): Promise<void> {
  if (!opts.files.length) return;
  await client.filesUploadV2({
    channel_id: opts.channel,
    thread_ts: opts.threadTs,
    initial_comment: opts.comment,
    file_uploads: opts.files.map((f) => ({ file: f.data, filename: f.filename, title: f.filename })),
  });
}

/** The error code of a failed Slack API call ("missing_scope", "not_in_channel"…), if it has one. */
export function slackErrorCode(err: unknown): string | undefined {
  const code = (err as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof code === "string" ? code : undefined;
}

/** Best effort: reactions fail until the app is reinstalled with reactions:write. */
export async function react(client: WebClient, channel: string, ts: string, name: string): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
  } catch {
    // ignored on purpose
  }
}

export async function unreact(client: WebClient, channel: string, ts: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp: ts, name });
  } catch {
    // ignored on purpose
  }
}

/** Whether Pointer's bot is in a conversation; "unknown" when Slack could not say. */
export type BotPresence = "member" | "outside" | "unknown";

/** Slack's answers that mean the bot cannot see a conversation. */
const OUTSIDE_ERRORS = new Set(["channel_not_found", "not_in_channel", "missing_scope", "method_not_supported_for_channel_type"]);
/**
 * A channel the bot is in is looked up again after this; one it is not in, or
 * any conversation Slack refused to describe (a DM included), sooner: the bot
 * may be invited, or the app reinstalled with the scope it lacked.
 */
const MEMBER_TTL_MS = 5 * 60_000;
const OUTSIDE_TTL_MS = 30_000;
const MAX_KNOWN_CONVERSATIONS = 5_000;

/** The bot can read the conversation: its own DM, or a channel it is in. Slack's error otherwise. */
async function botReads(client: Pick<WebClient, "conversations">, channel: string): Promise<boolean> {
  await client.conversations.history({ channel, limit: 1 });
  return true;
}

/**
 * Which conversations Pointer's bot is in, asked with the bot's token and
 * cached. Asked only while the owner's account is connected (dispatch.ts):
 * Slack then also sends the owner's own conversations, their DMs and group DMs
 * with colleagues and the channels Pointer is not in. Only the bot's
 * conversations hold requests to Pointer, whoever Slack names in the event's
 * authorizations.
 *
 * A DM is the bot's when the bot can read it (conversations.history with
 * im:history: the app has no im:read for conversations.info); a channel says
 * whether the bot is in it (conversations.info), or, for an app without
 * channels:read, whether the bot can read it. A DM's members never change, so
 * a DM the bot reads is looked up once; a channel again after a few minutes.
 * A miss or a refusal is looked up again after a short while.
 */
export class BotConversations {
  private readonly known = new Map<string, { member: boolean; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `bot` (the bot's user id) keeps one app's answers apart from another's. */
  async presence(client: Pick<WebClient, "conversations">, channel: string, channelType: string | undefined, bot = ""): Promise<BotPresence> {
    // Group DMs: the app has no mpim scopes, so its bot is never in one.
    if (channelType === "mpim") return "outside";
    const key = `${bot}:${channel}`;
    const hit = this.known.get(key);
    if (hit && hit.until > this.now()) return hit.member ? "member" : "outside";
    const dm = channelType === "im" || channel.startsWith("D");
    let member: boolean;
    try {
      member = dm ? await botReads(client, channel) : await this.inChannel(client, channel);
    } catch (err) {
      const code = slackErrorCode(err);
      if (!code || !OUTSIDE_ERRORS.has(code)) return "unknown";
      member = false;
    }
    // Only a DM the bot reads is known for good: a refusal may change with a reinstall.
    this.remember(key, member, dm && member);
    return member ? "member" : "outside";
  }

  private async inChannel(client: Pick<WebClient, "conversations">, channel: string): Promise<boolean> {
    let info: Awaited<ReturnType<WebClient["conversations"]["info"]>>["channel"];
    try {
      info = (await client.conversations.info({ channel })).channel;
    } catch (err) {
      if (slackErrorCode(err) === "missing_scope") return botReads(client, channel);
      throw err;
    }
    if (info?.is_mpim) return false;
    return info?.is_im ? botReads(client, channel) : Boolean(info?.is_member);
  }

  /** What an event shows: the bot joined or left a channel. */
  note(channel: string, member: boolean, bot = ""): void {
    this.remember(`${bot}:${channel}`, member, false);
  }

  private remember(key: string, member: boolean, forever: boolean): void {
    this.known.delete(key);
    this.known.set(key, { member, until: forever ? Number.POSITIVE_INFINITY : this.now() + (member ? MEMBER_TTL_MS : OUTSIDE_TTL_MS) });
    for (const oldest of this.known.keys()) {
      if (this.known.size <= MAX_KNOWN_CONVERSATIONS) break;
      this.known.delete(oldest);
    }
  }
}
