/**
 * The owner's Gmail through the Gmail REST API, with the connected Gmail
 * app's token (google-api.ts): the inbox threads from people that had a
 * message since a time, and whether the owner sent the latest one.
 *
 * What counts as a thread from people:
 * - in the inbox (or the owner sent its latest message: answered, maybe archived since);
 * - not in Promotions, Social, Updates or Forums, not spam, trash or chat;
 * - its latest message from someone else is from a person: not a no-reply,
 *   mailer-daemon or notifications address, and without List-Unsubscribe,
 *   List-Id, Precedence: bulk/list/junk or Auto-Submitted (other than "no").
 * The owner's messages are those Gmail labels SENT or sent from their address
 * (users/me/profile, cached); drafts are ignored.
 *
 * Requests: threads.list (50 a page, at most MAX_THREADS threads a call),
 * then threads.get in metadata format with only the headers needed, a few at
 * a time. Mail text is never logged: only its snippet (Gmail's short plain
 * text) is returned, clipped.
 */
import type { ConfigRepo } from "../../core/config.js";
import type { EmailSource, EmailThread } from "../../followups/types.js";
import { GMAIL, type GoogleClient, type GoogleDeps, GoogleApiError, connectedApp, googleClient, mapLimit } from "./google-api.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Threads per threads.list call. */
export const GMAIL_PAGE_SIZE = 50;
/** Threads one threadsSince reads at most (the newest). */
export const MAX_THREADS = 100;
/** threads.get calls at once. */
const GET_CONCURRENCY = 4;
/** Snippet length, plain text. */
export const SNIPPET_MAX = 300;
const SUBJECT_MAX = 200;
/** The owner's address is looked up again after this. */
const PROFILE_TTL_MS = 30 * 60_000;
/** ready() answers from its last check for this long. */
const READY_TTL_MS = 60_000;

/** Headers asked for: what the list needs and what tells mail from people apart from automated mail. */
const HEADERS = ["From", "Subject", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];

const CATEGORY_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);
const IGNORED_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

/** Gmail's ids are short hex strings: anything else never goes into an address. */
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailMessage {
  id?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}
interface GmailThread {
  id?: string;
  messages?: GmailMessage[];
}
interface ThreadList {
  threads?: { id?: string }[];
  nextPageToken?: string;
}

/** What one inbox read found: the threads, newest first, and whether older ones were left out. */
export interface GmailInbox {
  owner?: string;
  threads: EmailThread[];
  /** More threads matched than MAX_THREADS: the oldest were not read. */
  more: boolean;
}

/** The Gmail source, with the owner's address and the inbox with its limit (for Pointer's tool). */
export interface GmailSource extends EmailSource {
  ownerAddress(): Promise<string | undefined>;
  inbox(since: Date): Promise<GmailInbox>;
}

// ---------- Telling people from automated mail ----------

/** Local parts of addresses that never read replies. */
const AUTOMATED_SENDER_RE =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify)(?:[-+_.].*)?$/i;

const header = (m: GmailMessage, name: string): string | undefined => {
  const lower = name.toLowerCase();
  return m.payload?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value;
};

/** Control characters and line breaks out, spaces collapsed. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** A From header's name and address: `"Fadi S" <fadi@x.example>`, `Fadi <fadi@x.example>` or `fadi@x.example`. */
export function parseFrom(value: string | undefined): { name: string; address: string } {
  const v = oneLine(value ?? "");
  const angle = v.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { name: name.slice(0, 100), address: angle[2]!.toLowerCase() };
  }
  const bare = v.match(/[^\s<>"]+@[^\s<>"]+/);
  return { name: "", address: (bare?.[0] ?? "").toLowerCase() };
}

/** "Name <address>", or the address alone. */
export const formatFrom = (from: { name: string; address: string }) => (from.name ? `${from.name} <${from.address}>` : from.address || "(unknown sender)");

/** Mail from a person: not from an automated address, and without the headers of lists and automated mail. */
export function fromPerson(m: GmailMessage): boolean {
  const { address } = parseFrom(header(m, "From"));
  if (!address) return false;
  if (AUTOMATED_SENDER_RE.test(address.split("@")[0]!)) return false;
  if (header(m, "List-Unsubscribe") !== undefined || header(m, "List-Id") !== undefined) return false;
  if (/^\s*(bulk|list|junk)\b/i.test(header(m, "Precedence") ?? "")) return false;
  const auto = header(m, "Auto-Submitted");
  if (auto !== undefined && !/^\s*no\b/i.test(auto)) return false;
  return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Gmail's snippet (HTML-escaped text) as plain text, clipped. */
export function plainSnippet(snippet: string | undefined, max = SNIPPET_MAX): string {
  const text = oneLine(
    (snippet ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
        if (code[0] === "#") {
          const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
          return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
        }
        return ENTITIES[code.toLowerCase()] ?? whole;
      }),
  );
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The thread's page in Gmail, in the owner's account when their address is known. */
export function gmailLink(threadId: string, owner?: string): string {
  return owner ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(owner)}#all/${threadId}` : `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

/**
 * One thread as the follow-ups need it, or undefined when it is not one from
 * people with a message since `since` (see the module's comment).
 */
export function threadFromPeople(thread: GmailThread, owner: string | undefined, since: Date): EmailThread | undefined {
  if (!thread.id || !THREAD_ID_RE.test(thread.id)) return undefined;
  const labels = (m: GmailMessage) => new Set(m.labelIds ?? []);
  const time = (m: GmailMessage) => Number(m.internalDate ?? NaN);
  const messages = (thread.messages ?? [])
    .filter((m) => Number.isFinite(time(m)) && ![...labels(m)].some((l) => IGNORED_LABELS.has(l)))
    .sort((a, b) => time(a) - time(b));
  const latest = messages.at(-1);
  if (!latest || time(latest) < since.getTime()) return undefined;

  const ownerAddress = owner?.toLowerCase();
  const isOwner = (m: GmailMessage) => labels(m).has("SENT") || (ownerAddress !== undefined && parseFrom(header(m, "From")).address === ownerAddress);
  const others = messages.filter((m) => !isOwner(m));
  const lastOther = others.at(-1);
  if (!lastOther || !fromPerson(lastOther)) return undefined;
  if ([...labels(lastOther)].some((l) => CATEGORY_LABELS.has(l))) return undefined;

  const ownerRepliedLast = isOwner(latest);
  const inInbox = messages.some((m) => labels(m).has("INBOX"));
  if (!inInbox && !ownerRepliedLast) return undefined;

  const subject = oneLine(header(latest, "Subject") ?? header(messages[0]!, "Subject") ?? "").slice(0, SUBJECT_MAX) || "(no subject)";
  return {
    id: thread.id,
    subject,
    from: formatFrom(parseFrom(header(lastOther, "From"))),
    at: new Date(time(latest)).toISOString(),
    snippet: plainSnippet(latest.snippet),
    ownerRepliedLast,
    link: gmailLink(thread.id, owner),
  };
}

/**
 * The search for threads with a message since `since`, received in the inbox
 * or sent by the owner, outside the Promotions, Social, Updates and Forums tabs.
 */
export function inboxQuery(since: Date): string {
  const after = Math.floor(since.getTime() / 1000);
  return `after:${after} {in:inbox in:sent} -in:chats -category:promotions -category:social -category:updates -category:forums`;
}

// ---------- The source ----------

/** The owner's address per deployment and app, looked up with users/me/profile: chat builds a source per message. */
const ownersByRepo = new WeakMap<ConfigRepo, Map<string, { address: string; at: number }>>();

/** The owner's mail, through the connected Gmail app. */
export function gmailSource(deps: GoogleDeps): GmailSource {
  const nowMs = () => (deps.now ? deps.now().getTime() : Date.now());
  let readyCache: { value: boolean; at: number } | undefined;
  const owners = ownersByRepo.get(deps.configRepo) ?? new Map<string, { address: string; at: number }>();
  ownersByRepo.set(deps.configRepo, owners);

  const client = async (): Promise<{ api: GoogleClient; appId: string }> => {
    const api = googleClient(await deps.configRepo.load(), GMAIL, deps);
    return { api, appId: api.appId };
  };

  const ownerOf = async (api: GoogleClient, appId: string): Promise<string | undefined> => {
    const hit = owners.get(appId);
    if (hit && nowMs() - hit.at < PROFILE_TTL_MS) return hit.address;
    const profile = await api.get<{ emailAddress?: unknown }>(`${GMAIL_API}/profile`);
    const address = typeof profile.emailAddress === "string" ? parseFrom(profile.emailAddress).address : "";
    if (!address) return undefined;
    owners.set(appId, { address, at: nowMs() });
    return address;
  };

  const inbox = async (since: Date): Promise<GmailInbox> => {
    const { api, appId } = await client();
    const owner = await ownerOf(api, appId);
    const ids: string[] = [];
    let pageToken: string | undefined;
    let more = false;
    do {
      const params = new URLSearchParams({ q: inboxQuery(since), maxResults: String(Math.min(GMAIL_PAGE_SIZE, MAX_THREADS - ids.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await api.get<ThreadList>(`${GMAIL_API}/threads?${params}`);
      for (const t of page.threads ?? []) if (t.id && THREAD_ID_RE.test(t.id) && !ids.includes(t.id)) ids.push(t.id);
      pageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : undefined;
      if (ids.length >= MAX_THREADS) {
        more = pageToken !== undefined;
        break;
      }
    } while (pageToken);

    const query = new URLSearchParams({ format: "metadata", fields: "id,messages(id,labelIds,snippet,internalDate,payload/headers)" });
    for (const h of HEADERS) query.append("metadataHeaders", h);
    const threads = await mapLimit(ids.slice(0, MAX_THREADS), GET_CONCURRENCY, async (id) => {
      try {
        return await api.get<GmailThread>(`${GMAIL_API}/threads/${id}?${query}`);
      } catch (err) {
        // Deleted since it was listed.
        if (err instanceof GoogleApiError && err.status === 404) return undefined;
        throw err;
      }
    });
    const found = threads
      .map((t) => (t ? threadFromPeople(t, owner, since) : undefined))
      .filter((t): t is EmailThread => t !== undefined)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { ...(owner ? { owner } : {}), threads: found, more };
  };

  return {
    async ready() {
      if (readyCache && nowMs() - readyCache.at < READY_TTL_MS) return readyCache.value;
      let value = false;
      try {
        const config = await deps.configRepo.load();
        if (config.followups.trackGmail && connectedApp(config, GMAIL)) {
          const { api, appId } = await client();
          owners.delete(appId);
          value = (await ownerOf(api, appId)) !== undefined;
        }
      } catch {
        value = false;
      }
      readyCache = { value, at: nowMs() };
      return value;
    },
    async threadsSince(since: Date) {
      return (await inbox(since)).threads;
    },
    inbox,
    async ownerAddress() {
      const { api, appId } = await client();
      return ownerOf(api, appId);
    },
  };
}
