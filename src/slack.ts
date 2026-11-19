import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { ATTACHMENT_LIMITS } from "./attachments.js";
import { safeEqual } from "./crypto.js";
import type { ConversationMessage, SlackFileRef } from "./pointer-types.js";
import { messageText } from "./targeting.js";

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

/** Display names rarely change; one users.info call per person per process. */
const userNames = new Map<string, string>();

export async function userName(client: WebClient, userId: string): Promise<string> {
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

interface RawMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown;
}

/**
 * The conversation before a new message, oldest first: the thread (via
 * conversations.replies) or, for a top-level DM message, recent DM history.
 * A top-level channel message starts a new thread and has no history.
 * Long threads keep their first message plus the latest ones. Never throws.
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
    if (opts.threadTs) {
      const res = await client.conversations.replies({ channel: opts.channel, ts: opts.threadTs, limit: 200 });
      raw = res.messages ?? [];
    } else if (opts.isDm) {
      const res = await client.conversations.history({
        channel: opts.channel,
        latest: opts.beforeTs,
        inclusive: false,
        limit: opts.limit,
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
      return {
        ts: m.ts,
        userId: m.user,
        name: mine ? (opts.pointerName ?? "Pointer") : (names.get(m.user ?? "") ?? m.user ?? "someone"),
        text: messageText(m.text ?? "", opts.botUserId),
        isPointer: mine,
        ...(files.length ? { files } : {}),
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
