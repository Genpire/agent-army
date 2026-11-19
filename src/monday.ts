import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ATTACHMENT_LIMITS, classify, expandZip } from "./attachments.js";
import type { AddAttachment } from "./pointer-types.js";

/**
 * monday.com for Pointer: a small GraphQL client, the token check used by the
 * admin page, and the chat tools ("open a ticket for the login bug").
 *
 * API reference: https://developer.monday.com/api-reference
 */

export const MONDAY_API_URL = "https://api.monday.com/v2";
/**
 * Pinned API version. 2026-10 became "Current" on 2026-10-26 and moves to
 * maintenance on 2027-01-15 (then 2027-01 is current). Bump deliberately.
 */
export const MONDAY_API_VERSION = "2026-10";

/** Tool results go into the model's context; keep them bounded. */
const MAX_OUTPUT = 20_000;
const NOT_CONNECTED = "monday.com is not connected. Ask the owner to connect it on the admin page.";
const NO_BOARD =
  "No board was given and no default monday.com board is set. Ask the user which board to use, or call monday_list_boards to find it.";
const BOARD_ID_RE = /^\d+$/;

export type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/** A failed monday.com call. Messages are short, user-readable and never contain the token. */
export class MondayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MondayError";
  }
}

interface GraphQLError {
  message?: unknown;
  extensions?: { code?: unknown; status_code?: unknown; retry_in_seconds?: unknown };
}

interface MondayResponse {
  data?: unknown;
  errors?: GraphQLError[];
  /** Older error envelope, still returned for some failures. */
  error_message?: unknown;
  error_code?: unknown;
  status_code?: unknown;
}

interface ErrorSummary {
  message: string;
  code?: string;
  status?: number;
  retryIn?: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function summarizeErrors(body: MondayResponse | undefined): ErrorSummary | undefined {
  if (!body) return undefined;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => str(e?.message)).filter((m): m is string => Boolean(m));
    const first = body.errors.find((e) => str(e?.extensions?.code)) ?? body.errors[0];
    return {
      message: [...new Set(messages)].join("; ") || "unknown error",
      code: str(first?.extensions?.code),
      status: num(first?.extensions?.status_code),
      retryIn: body.errors.map((e) => num(e?.extensions?.retry_in_seconds)).find((n) => n !== undefined),
    };
  }
  const message = str(body.error_message) ?? str(body.error_code);
  if (message) return { message, code: str(body.error_code), status: num(body.status_code) };
  return undefined;
}

function formatError(e: ErrorSummary): string {
  const code = e.code && e.code !== e.message ? ` (${e.code})` : "";
  const retry = e.retryIn !== undefined ? ` Retry in ${e.retryIn}s.` : "";
  return `${e.message.slice(0, 300)}${code}${retry}`;
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** monday.com update bodies are HTML: escape the text and keep its line breaks. */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from an update's HTML body; used when monday.com returns no `text_body`. */
function htmlToText(html: string): string {
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol|h[1-6]|blockquote|pre|tr|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    // One pass, so "&amp;lt;" becomes "&lt;" and not "<".
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#")) {
        const cp = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : entity;
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes links from a message (pre-signed file links grant access while valid). */
const scrubLinks = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]");

/** "120 KB", "1.3 MB", like the attachment store's labels. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "size unknown";
  if (bytes >= 1024 * 1024) return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Status/dropdown labels from a column's `settings` (structured since 2025-10; a JSON string or a labels map in older shapes). */
function parseLabels(settings: unknown): string[] | undefined {
  let s = settings;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return undefined;
    }
  }
  if (!s || typeof s !== "object") return undefined;
  const labels = (s as { labels?: unknown }).labels;
  let out: string[] = [];
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === "string") out.push(l);
      else if (l && typeof l === "object") {
        const o = l as { label?: unknown; name?: unknown; is_deactivated?: unknown };
        const text = str(o.label) ?? str(o.name);
        if (text && o.is_deactivated !== true) out.push(text);
      }
    }
  } else if (labels && typeof labels === "object") {
    out = Object.values(labels).filter((v): v is string => typeof v === "string" && v !== "");
  }
  return out.length ? out : undefined;
}

const LABEL_COLUMN_TYPES = new Set(["status", "color", "dropdown"]);

export interface MondayBoardSummary {
  id: string;
  name: string;
  workspace?: string;
}

export interface MondayBoard {
  id: string;
  name: string;
  url?: string;
  groups: { id: string; title: string }[];
  columns: { id: string; title: string; type: string; labels?: string[] }[];
}

export interface MondayItem {
  id: string;
  name: string;
  url?: string;
  group?: string;
  /** Non-empty column texts keyed by column title. */
  columns: Record<string, string>;
}

export interface MondayUser {
  id: string;
  name: string;
  email?: string;
}

/** A file on an item, an update or a reply. */
export interface MondayAsset {
  id: string;
  name: string;
  /** Without the leading dot, e.g. "png". */
  fileExtension?: string;
  /** Bytes. */
  fileSize?: number;
  /** Pre-signed link, valid for about an hour. Fetched without the token; never shown to the model. */
  publicUrl?: string;
  /** monday.com link; opens only for signed-in users with access to the file. */
  url?: string;
  /** The update the file is attached to (directly or through one of its replies). */
  updateId?: string;
}

export interface MondayReply {
  id: string;
  createdAt?: string;
  author?: string;
  /** Plain text: `text_body`, or the HTML `body` stripped. */
  text: string;
  assets: MondayAsset[];
}

export interface MondayUpdate extends MondayReply {
  replies: MondayReply[];
}

export interface MondayItemDetails {
  id: string;
  name: string;
  url?: string;
  /** "active", "archived" or "deleted". */
  state?: string;
  board?: { id: string; name: string };
  group?: { id: string; title: string };
  /** Name of whoever created the item. */
  creator?: string;
  /** Non-empty column values, in board order. */
  columns: { id: string; title: string; type?: string; text: string }[];
  /** The latest ITEM_UPDATES_LIMIT updates (description and discussion), newest first. */
  updates: MondayUpdate[];
  /** Every file on the item, its updates and their replies, once each (item files first). */
  assets: MondayAsset[];
}

/** Updates read per item (monday.com's default page size; the maximum is 100). */
export const ITEM_UPDATES_LIMIT = 25;

/** A board webhook (https://developer.monday.com/api-reference/reference/webhooks). */
export interface MondayWebhook {
  id: string;
  boardId: string;
  event?: string;
  /** The webhook's config, e.g. {"columnId": "status"} (a JSON string in some responses). */
  config?: unknown;
}

/** The webhook events Agent Army creates: a change of one column (the status column it watches). */
export type MondayWebhookEvent = "change_specific_column_value" | "change_status_column_value" | "change_column_value";

/** A status column and its labels, for pickers and checks. */
export interface MondayStatusColumn {
  id: string;
  title: string;
  labels: string[];
}

/** Status columns are `status` (since API 2023-10) or `color` (older boards and webhook payloads). */
const STATUS_COLUMN_TYPES = new Set(["status", "color"]);

/** The board's status columns with their active labels. */
export function statusColumns(board: Pick<MondayBoard, "columns">): MondayStatusColumn[] {
  return board.columns
    .filter((c) => STATUS_COLUMN_TYPES.has(c.type))
    .map((c) => ({ id: c.id, title: c.title, labels: c.labels ?? [] }));
}

const ASSET_FIELDS = "id name file_extension file_size public_url url";

type RawAsset = {
  id?: string | number | null;
  name?: string | null;
  file_extension?: string | null;
  file_size?: number | null;
  public_url?: string | null;
  url?: string | null;
};
type RawReply = {
  id: string | number;
  created_at?: string | null;
  text_body?: string | null;
  body?: string | null;
  creator?: { name?: string | null } | null;
  assets?: (RawAsset | null)[] | null;
};
type RawUpdate = RawReply & { replies?: (RawReply | null)[] | null };
type RawItemDetails = {
  id: string | number;
  name: string;
  url?: string | null;
  state?: string | null;
  board?: { id: string | number; name?: string | null } | null;
  group?: { id: string; title?: string | null } | null;
  creator?: { name?: string | null } | null;
  column_values?: ({ id: string; type?: string | null; text?: string | null; column?: { title?: string | null } | null } | null)[] | null;
  assets?: (RawAsset | null)[] | null;
  updates?: (RawUpdate | null)[] | null;
};

function mapAsset(a: RawAsset | null | undefined): MondayAsset | undefined {
  if (!a || (typeof a.id !== "string" && typeof a.id !== "number")) return undefined;
  const ext = str(a.file_extension)?.replace(/^\./, "");
  const size = num(a.file_size);
  const publicUrl = str(a.public_url);
  const url = str(a.url);
  return {
    id: String(a.id),
    name: str(a.name) ?? `file-${a.id}${ext ? `.${ext}` : ""}`,
    ...(ext ? { fileExtension: ext } : {}),
    ...(size !== undefined ? { fileSize: size } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(url ? { url } : {}),
  };
}

const mapAssets = (list: (RawAsset | null)[] | null | undefined): MondayAsset[] =>
  (list ?? []).map(mapAsset).filter((a): a is MondayAsset => a !== undefined);

function mapReply(r: RawReply): MondayReply {
  const createdAt = str(r.created_at);
  const author = str(r.creator?.name);
  return {
    id: String(r.id),
    ...(createdAt ? { createdAt } : {}),
    ...(author ? { author } : {}),
    text: r.text_body?.trim() || htmlToText(r.body ?? ""),
    assets: mapAssets(r.assets),
  };
}

function mapItemDetails(raw: RawItemDetails): MondayItemDetails {
  const updates: MondayUpdate[] = (raw.updates ?? [])
    .filter((u): u is RawUpdate => Boolean(u))
    .map((u) => ({ ...mapReply(u), replies: (u.replies ?? []).filter((r): r is RawReply => Boolean(r)).map(mapReply) }));

  // Item files first; files that are also on an update say which one.
  const assets = new Map<string, MondayAsset>();
  for (const a of mapAssets(raw.assets)) if (!assets.has(a.id)) assets.set(a.id, a);
  for (const u of updates) {
    for (const a of [...u.assets, ...u.replies.flatMap((r) => r.assets)]) {
      const seen = assets.get(a.id);
      if (!seen) assets.set(a.id, { ...a, updateId: u.id });
      else if (!seen.updateId) seen.updateId = u.id;
    }
  }

  const columns: MondayItemDetails["columns"] = [];
  for (const cv of raw.column_values ?? []) {
    const text = cv?.text?.trim();
    if (!cv || !text) continue;
    const type = str(cv.type);
    columns.push({ id: cv.id, title: str(cv.column?.title) ?? cv.id, ...(type ? { type } : {}), text });
  }

  const url = str(raw.url);
  const state = str(raw.state);
  const creator = str(raw.creator?.name);
  return {
    id: String(raw.id),
    name: raw.name,
    ...(url ? { url } : {}),
    ...(state ? { state } : {}),
    ...(raw.board ? { board: { id: String(raw.board.id), name: str(raw.board.name) ?? "" } } : {}),
    ...(raw.group ? { group: { id: raw.group.id, title: str(raw.group.title) ?? "" } } : {}),
    ...(creator ? { creator } : {}),
    columns,
    updates,
    assets: [...assets.values()],
  };
}

/** Minimal monday.com GraphQL client: only what Pointer's tools need. No deletes or archives. */
export class MondayClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly token: string,
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private redact(text: string): string {
    return this.token.length >= 4 ? text.split(this.token).join("[redacted]") : text;
  }

  private fail(message: string, status?: number, code?: string): MondayError {
    return new MondayError(this.redact(message), status, code);
  }

  /** One GraphQL request. Throws MondayError for HTTP failures and for an `errors` array (sent with HTTP 200). */
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const doFetch = this.fetchFn;
    let res: Response;
    try {
      res = await doFetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
          Authorization: this.token,
          "Content-Type": "application/json",
          "API-Version": MONDAY_API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw this.fail(`monday.com request failed: ${errMessage(err).slice(0, 200)}`);
    }

    const raw = await res.text().catch(() => "");
    let body: MondayResponse | undefined;
    try {
      body = raw ? (JSON.parse(raw) as MondayResponse) : undefined;
    } catch {
      body = undefined;
    }
    const errors = summarizeErrors(body);

    if (res.status === 401 || res.status === 403) {
      const detail = errors ? `: ${formatError(errors)}` : "";
      throw this.fail(`monday.com rejected the API token (HTTP ${res.status})${detail}`, res.status, errors?.code);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const retryIn = errors?.retryIn ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
      const detail = errors ? ` ${errors.message.slice(0, 200)}` : "";
      const retry = retryIn !== undefined ? ` Retry in ${retryIn}s.` : "";
      throw this.fail(`monday.com rate limit reached (HTTP 429).${detail}${retry}`, 429, errors?.code);
    }
    if (!res.ok) {
      const detail = errors ? formatError(errors) : raw.slice(0, 300);
      throw this.fail(`monday.com API error (HTTP ${res.status}): ${detail}`, res.status, errors?.code);
    }
    if (errors) throw this.fail(`monday.com API error: ${formatError(errors)}`, errors.status, errors.code);
    if (!body || typeof body.data !== "object" || body.data === null) {
      throw this.fail("monday.com returned an unexpected response.", res.status);
    }
    return body.data as T;
  }

  async me(): Promise<{ userName: string; accountName: string }> {
    const data = await this.request<{ me: { name?: string; account?: { name?: string } | null } | null }>(
      "query { me { name account { name } } }",
    );
    if (!data.me) throw this.fail("monday.com did not return the token's user.");
    return { userName: data.me.name ?? "", accountName: data.me.account?.name ?? "" };
  }

  /**
   * Active boards, most recently used first. The `boards` query has no name
   * filter, so `search` matches names here, over up to 5 pages of 100.
   */
  async listBoards(opts: { search?: string; limit?: number; ids?: string[] } = {}): Promise<MondayBoardSummary[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), 100);
    const search = opts.search?.trim().toLowerCase() || undefined;
    const ids = opts.ids?.length ? opts.ids : undefined;
    const pageSize = search ? 100 : limit;
    const maxPages = search ? 5 : 1;
    const query = `query ($limit: Int!, $page: Int!${ids ? ", $ids: [ID!]" : ""}) {
  boards(${ids ? "ids: $ids, " : ""}limit: $limit, page: $page, order_by: used_at, state: active) {
    id name type workspace { name }
  }
}`;
    type RawBoard = { id: string; name: string; type?: string | null; workspace?: { name?: string | null } | null };
    const out: MondayBoardSummary[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request<{ boards: (RawBoard | null)[] | null }>(query, {
        limit: pageSize,
        page,
        ...(ids ? { ids } : {}),
      });
      const boards = data.boards ?? [];
      for (const b of boards) {
        if (!b || b.type === "sub_items_board" || b.type === "document") continue;
        if (search && !b.name.toLowerCase().includes(search)) continue;
        const workspace = b.workspace?.name ?? undefined;
        out.push({ id: String(b.id), name: b.name, ...(workspace ? { workspace } : {}) });
        if (out.length >= limit) return out;
      }
      if (boards.length < pageSize) break;
    }
    return out;
  }

  /** A board's groups and columns, with the labels of status and dropdown columns. */
  async getBoard(boardId: string): Promise<MondayBoard> {
    type RawBoard = {
      id: string;
      name: string;
      url?: string | null;
      groups?: { id: string; title: string }[] | null;
      columns?: { id: string; title: string; type: string; settings?: unknown }[] | null;
    };
    const data = await this.request<{ boards: (RawBoard | null)[] | null }>(
      `query ($ids: [ID!]) {
  boards(ids: $ids) {
    id name url
    groups { id title }
    columns { id title type settings }
  }
}`,
      { ids: [boardId] },
    );
    const b = data.boards?.[0];
    if (!b) throw this.fail(`Board ${boardId} was not found (or the token cannot see it).`);
    return {
      id: String(b.id),
      name: b.name,
      ...(b.url ? { url: b.url } : {}),
      groups: (b.groups ?? []).map((g) => ({ id: g.id, title: g.title })),
      columns: (b.columns ?? []).map((c) => {
        const labels = LABEL_COLUMN_TYPES.has(c.type) ? parseLabels(c.settings) : undefined;
        return { id: c.id, title: c.title, type: c.type, ...(labels ? { labels } : {}) };
      }),
    };
  }

  /** Items whose name contains `text` (case-insensitive), with their non-empty column texts. */
  async searchItems(boardId: string, text: string, limit = 10): Promise<MondayItem[]> {
    type RawItem = {
      id: string;
      name: string;
      url?: string | null;
      group?: { title?: string | null } | null;
      column_values?: { id: string; text?: string | null; column?: { title?: string | null } | null }[] | null;
    };
    const data = await this.request<{ boards: ({ items_page?: { items?: RawItem[] | null } | null } | null)[] | null }>(
      `query ($ids: [ID!], $limit: Int!, $query: ItemsQuery) {
  boards(ids: $ids) {
    items_page(limit: $limit, query_params: $query) {
      items { id name url group { title } column_values { id text column { title } } }
    }
  }
}`,
      {
        ids: [boardId],
        limit: Math.min(Math.max(Math.trunc(limit), 1), 50),
        query: { rules: [{ column_id: "name", compare_value: [text], operator: "contains_text" }] },
      },
    );
    const board = data.boards?.[0];
    if (!board) throw this.fail(`Board ${boardId} was not found (or the token cannot see it).`);
    return (board.items_page?.items ?? []).map((item) => {
      const columns: Record<string, string> = {};
      for (const cv of item.column_values ?? []) {
        const value = cv.text?.trim();
        if (!value) continue;
        const title = cv.column?.title || cv.id;
        columns[title in columns ? `${title} (${cv.id})` : title] = value;
      }
      return {
        id: String(item.id),
        name: item.name,
        ...(item.url ? { url: item.url } : {}),
        ...(item.group?.title ? { group: item.group.title } : {}),
        columns,
      };
    });
  }

  async createItem(input: {
    boardId: string;
    groupId?: string;
    name: string;
    columnValues?: Record<string, unknown>;
  }): Promise<{ id: string; url?: string }> {
    const hasValues = input.columnValues && Object.keys(input.columnValues).length > 0;
    const data = await this.request<{ create_item: { id: string; url?: string | null } | null }>(
      `mutation ($boardId: ID!, $groupId: String, $name: String!, $columnValues: JSON) {
  create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $columnValues) { id url }
}`,
      {
        boardId: input.boardId,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        name: input.name,
        // The JSON scalar takes the column values as a JSON-encoded string.
        ...(hasValues ? { columnValues: JSON.stringify(input.columnValues) } : {}),
      },
    );
    if (!data.create_item) throw this.fail("monday.com did not return the new item.");
    return { id: String(data.create_item.id), ...(data.create_item.url ? { url: data.create_item.url } : {}) };
  }

  async changeColumnValues(input: {
    boardId: string;
    itemId: string;
    columnValues: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const data = await this.request<{ change_multiple_column_values: { id: string } | null }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
  change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
}`,
      { boardId: input.boardId, itemId: input.itemId, columnValues: JSON.stringify(input.columnValues) },
    );
    if (!data.change_multiple_column_values) throw this.fail(`monday.com did not update item ${input.itemId}.`);
    return { id: String(data.change_multiple_column_values.id) };
  }

  /**
   * Sets a status column to one of its labels, by the label's text
   * (`{"<column>": {"label": "Done"}}`). The label must exist: monday.com
   * rejects unknown labels unless asked to create them, which this never does.
   */
  setStatusLabel(input: { boardId: string; itemId: string; columnId: string; label: string }): Promise<{ id: string }> {
    return this.changeColumnValues({ boardId: input.boardId, itemId: input.itemId, columnValues: { [input.columnId]: { label: input.label } } });
  }

  /**
   * Creates a board webhook (scope webhooks:write). monday.com first POSTs
   * `{"challenge": "…"}` to the URL and expects it echoed, so the URL must
   * already answer. The URL is limited to 255 characters.
   */
  async createWebhook(input: {
    boardId: string;
    url: string;
    event: MondayWebhookEvent;
    config?: Record<string, unknown>;
  }): Promise<{ id: string; boardId: string }> {
    const data = await this.request<{ create_webhook: { id?: string | number | null; board_id?: string | number | null } | null }>(
      `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
  create_webhook(board_id: $boardId, url: $url, event: $event, config: $config) { id board_id }
}`,
      {
        boardId: input.boardId,
        url: input.url,
        event: input.event,
        // The JSON scalar takes a JSON-encoded string, as column values do.
        ...(input.config ? { config: JSON.stringify(input.config) } : {}),
      },
    );
    const id = data.create_webhook?.id;
    if (id === undefined || id === null) throw this.fail(`monday.com did not create the webhook on board ${input.boardId}.`);
    return { id: String(id), boardId: String(data.create_webhook?.board_id ?? input.boardId) };
  }

  /** Deletes a webhook (scope webhooks:write); events stop being sent to its URL. */
  async deleteWebhook(id: string): Promise<{ id: string }> {
    const data = await this.request<{ delete_webhook: { id?: string | number | null } | null }>(
      `mutation ($id: ID!) {
  delete_webhook(id: $id) { id board_id }
}`,
      { id },
    );
    return { id: String(data.delete_webhook?.id ?? id) };
  }

  /** The board's webhooks (scope webhooks:read). monday.com does not return their URLs. */
  async listWebhooks(boardId: string): Promise<MondayWebhook[]> {
    type Raw = { id: string | number; event?: string | null; board_id?: string | number | null; config?: unknown };
    const data = await this.request<{ webhooks: (Raw | null)[] | null }>(
      `query ($boardId: ID!) {
  webhooks(board_id: $boardId) { id event board_id config }
}`,
      { boardId },
    );
    return (data.webhooks ?? [])
      .filter((w): w is Raw => Boolean(w))
      .map((w) => ({
        id: String(w.id),
        boardId: String(w.board_id ?? boardId),
        ...(w.event ? { event: w.event } : {}),
        ...(w.config !== undefined && w.config !== null ? { config: w.config } : {}),
      }));
  }

  /** Posts an update (comment) on an item. `body` is plain text; it is HTML-escaped with line breaks kept. */
  async addUpdate(itemId: string, body: string): Promise<{ id: string }> {
    const data = await this.request<{ create_update: { id: string } | null }>(
      `mutation ($itemId: ID!, $body: String!) {
  create_update(item_id: $itemId, body: $body) { id }
}`,
      { itemId, body: textToHtml(body) },
    );
    if (!data.create_update) throw this.fail(`monday.com did not add the update to item ${itemId}.`);
    return { id: String(data.create_update.id) };
  }

  /** Fuzzy search of the account's users by name. */
  async findUsers(name: string, limit = 10): Promise<MondayUser[]> {
    const data = await this.request<{ users: ({ id: string; name: string; email?: string | null } | null)[] | null }>(
      `query ($name: String, $limit: Int) {
  users(name: $name, limit: $limit) { id name email }
}`,
      { name, limit: Math.min(Math.max(Math.trunc(limit), 1), 50) },
    );
    return (data.users ?? [])
      .filter((u): u is { id: string; name: string; email?: string | null } => Boolean(u))
      .map((u) => ({ id: String(u.id), name: u.name, ...(u.email ? { email: u.email } : {}) }));
  }

  /** The board an item lives on, or undefined when the item does not exist or is not visible. */
  async getItemBoardId(itemId: string): Promise<string | undefined> {
    const data = await this.request<{ items: ({ id: string; board?: { id: string } | null } | null)[] | null }>(
      `query ($ids: [ID!]) {
  items(ids: $ids) { id board { id } }
}`,
      { ids: [itemId] },
    );
    const id = data.items?.[0]?.board?.id;
    return id === undefined || id === null ? undefined : String(id);
  }

  /**
   * One item in full: board, group, column texts, the latest updates (newest
   * first) with their replies, and the files on the item and its updates.
   * The caller checks the board allowlist against `board.id`.
   */
  async getItem(itemId: string): Promise<MondayItemDetails> {
    // assets_source defaults to file columns only; `all` adds the item's file gallery.
    // Files posted in updates are only reachable through the updates themselves.
    const query = (assetsArg: string) => `query ($ids: [ID!], $updatesLimit: Int) {
  items(ids: $ids) {
    id name url state
    board { id name }
    group { id title }
    creator { name }
    column_values { id type text column { title } }
    assets${assetsArg} { ${ASSET_FIELDS} }
    updates(limit: $updatesLimit) {
      id created_at text_body body creator { name }
      assets { ${ASSET_FIELDS} }
      replies { id created_at text_body body creator { name } assets { ${ASSET_FIELDS} } }
    }
  }
}`;
    const variables = { ids: [itemId], updatesLimit: ITEM_UPDATES_LIMIT };
    let data: { items: (RawItemDetails | null)[] | null };
    try {
      data = await this.request(query("(assets_source: all)"), variables);
    } catch (err) {
      // `assets_source` is only documented by the community; if the API rejects it, fall back to the default (file columns).
      if (!/assets_source/i.test(err instanceof Error ? err.message : String(err))) throw err;
      data = await this.request(query(""), variables);
    }
    const raw = data.items?.[0];
    if (!raw) throw this.fail(`Item ${itemId} was not found (or the token cannot see it).`);
    return mapItemDetails(raw);
  }

  /**
   * Downloads a file from an asset's `public_url`: a pre-signed link, so the
   * monday.com token is never sent (it must not reach the file host). https
   * only; refuses files over `maxBytes`. Errors never include the link.
   */
  async downloadAsset(
    publicUrl: string,
    maxBytes: number = ATTACHMENT_LIMITS.maxFileBytes,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    let url: URL | undefined;
    try {
      url = new URL(publicUrl);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:") throw this.fail("Refusing the file download: monday.com file links must be https.");

    const tooLarge = () => this.fail(`The file is larger than ${formatSize(maxBytes)}.`);
    const doFetch = this.fetchFn;
    let res: Response;
    try {
      res = await doFetch(publicUrl, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw this.fail(`The file download failed: ${scrubLinks(errMessage(err)).slice(0, 200)}`);
    }
    const discard = () => res.body?.cancel().catch(() => undefined);
    if (res.url && !res.url.startsWith("https:")) {
      await discard();
      throw this.fail("Refusing the file download: it was redirected to a non-https link.");
    }
    if (!res.ok) {
      await discard();
      const hint = res.status === 403 ? "; the link may have expired, try again" : "";
      throw this.fail(`The file download failed (HTTP ${res.status}${hint}).`, res.status);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard();
      throw tooLarge();
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof MondayError) throw err;
      throw this.fail(`The file download failed: ${scrubLinks(errMessage(err)).slice(0, 200)}`);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    return { bytes, ...(contentType ? { contentType } : {}) };
  }
}

/**
 * Proves a monday.com token works before the admin page saves it.
 * Throws a user-readable Error; honours SKIP_VALIDATION=1 like src/validate.ts.
 */
export async function checkMonday(
  token: string,
  fetchFn?: typeof fetch,
): Promise<{ userName: string; accountName: string }> {
  if (process.env.SKIP_VALIDATION === "1") return { userName: "test", accountName: "test" };
  try {
    return await new MondayClient(token, fetchFn).me();
  } catch (err) {
    if (err instanceof MondayError && (err.status === 401 || err.status === 403)) {
      throw new Error("monday.com rejected this token.");
    }
    // MondayClient errors are already redacted; anything else is reported generically.
    const detail = err instanceof MondayError ? err.message : "unexpected error";
    throw new Error(`monday.com check failed (${detail}).`);
  }
}

// ---------------------------------------------------------------------------
// Tools

export interface MondayToolOptions {
  /** undefined = monday.com not connected. */
  client?: MondayClient;
  defaultBoardId?: string;
  /** Empty = every board the token can reach. */
  allowedBoardIds: string[];
  /** Display name of the Slack user; appended to new tickets' description. */
  requester?: string;
  /**
   * Stores a file in this conversation (PointerContext.addAttachment), so
   * monday_attach_files hands item files to Pointer and to repo tasks.
   * Undefined = files are shown once but not stored.
   */
  addAttachment?: AddAttachment;
}

/** Column values as a JSON object keyed by column id (a JSON-encoded string is accepted too). */
export type ColumnValuesArg = Record<string, unknown> | string;

export interface MondayHandlers {
  monday_list_boards(args: { search?: string }): Promise<CallToolResult>;
  monday_get_board(args: { board_id?: string }): Promise<CallToolResult>;
  monday_search_items(args: { text: string; board_id?: string }): Promise<CallToolResult>;
  monday_find_users(args: { name: string }): Promise<CallToolResult>;
  monday_create_item(args: {
    name: string;
    board_id?: string;
    group_id?: string;
    description?: string;
    column_values?: ColumnValuesArg;
  }): Promise<CallToolResult>;
  monday_update_item(args: { item_id: string; column_values: ColumnValuesArg; board_id?: string }): Promise<CallToolResult>;
  monday_add_comment(args: { item_id: string; text: string }): Promise<CallToolResult>;
  monday_get_item(args: { item_id: string }): Promise<CallToolResult>;
  monday_attach_files(args: { item_id: string; asset_ids?: string[] }): Promise<CallToolResult>;
}

export const MONDAY_READ_TOOL_NAMES: string[] = [
  "monday_list_boards",
  "monday_get_board",
  "monday_search_items",
  "monday_find_users",
  "monday_get_item",
];

export const MONDAY_TOOL_NAMES: string[] = [
  ...MONDAY_READ_TOOL_NAMES,
  "monday_create_item",
  "monday_update_item",
  "monday_add_comment",
  // Not read-only: it stores the files in the conversation.
  "monday_attach_files",
];

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const note = "\n… (output truncated)";
  return text.slice(0, MAX_OUTPUT - note.length) + note;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text: cap(text) }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text: cap(text) }], isError: true });

/** A problem with the tool input; returned to the model as an error. */
class InputError extends Error {}

function parseColumnValues(value: ColumnValuesArg | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new InputError('column_values is not valid JSON. Pass an object keyed by column id, e.g. {"status": {"label": "Done"}}.');
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InputError('column_values must be an object keyed by column id, e.g. {"status": {"label": "Done"}}.');
  }
  return parsed as Record<string, unknown>;
}

function itemIdOf(raw: string): string {
  const id = raw.trim();
  if (!BOARD_ID_RE.test(id)) throw new InputError(`"${raw}" is not a monday.com item id (digits only).`);
  return id;
}

// --- monday_get_item formatting ---------------------------------------------

const UPDATE_TEXT_CHARS = 3_000;
const REPLY_TEXT_CHARS = 1_000;
const UPDATE_BLOCK_CHARS = 6_000;
const COLUMN_TEXT_CHARS = 200;
const MAX_COLUMNS_SHOWN = 60;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (cut, ${text.length} characters in total)`;
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const assetRefs = (assets: MondayAsset[]) => assets.map((a) => `${a.name} (asset ${a.id})`).join(", ");

function renderUpdate(u: MondayUpdate): string {
  const lines = [`[${formatDate(u.createdAt) ?? "undated"}] ${u.author ?? "unknown"} (update ${u.id}):`, clip(u.text || "(no text)", UPDATE_TEXT_CHARS)];
  if (u.assets.length) lines.push(`Files: ${assetRefs(u.assets)}`);
  for (const r of u.replies) {
    const head = [formatDate(r.createdAt), r.author].filter(Boolean).join(" · ") || "reply";
    const body = clip(r.text || "(no text)", REPLY_TEXT_CHARS).replace(/\n/g, "\n    ");
    lines.push(`  ↳ [${head}] ${body}`);
    if (r.assets.length) lines.push(`    Files: ${assetRefs(r.assets)}`);
  }
  return clip(lines.join("\n"), UPDATE_BLOCK_CHARS);
}

/**
 * The item as text for the model. Updates are newest first; when they do not
 * all fit, the newest ones and the oldest one (usually the ticket's
 * description) are kept, and the file list always fits.
 */
function formatItem(item: MondayItemDetails): string {
  const head = [`Item ${item.id}: "${item.name}"`];
  if (item.url) head.push(`Link: ${item.url}`);
  const where = [
    item.board ? `Board: ${item.board.name} (id ${item.board.id})` : "",
    item.group ? `Group: ${item.group.title} (id ${item.group.id})` : "",
  ].filter(Boolean);
  if (where.length) head.push(where.join(" · "));
  if (item.state && item.state !== "active") head.push(`State: ${item.state}`);
  if (item.creator) head.push(`Created by: ${item.creator}`);
  const columns = [...item.columns.filter((c) => c.type === "status"), ...item.columns.filter((c) => c.type !== "status")];
  if (columns.length === 0) head.push("", "Columns: none set.");
  else {
    head.push("", "Columns:");
    for (const c of columns.slice(0, MAX_COLUMNS_SHOWN)) head.push(`- ${c.title}: ${clip(c.text.replace(/\s+/g, " "), COLUMN_TEXT_CHARS)}`);
    if (columns.length > MAX_COLUMNS_SHOWN) head.push(`… ${columns.length - MAX_COLUMNS_SHOWN} more columns`);
  }

  const files =
    item.assets.length === 0
      ? "Files: none."
      : [
          `Files (${item.assets.length}); call monday_attach_files to read them and hand them to the team:`,
          ...item.assets.map(
            (a) => `- ${a.name} · ${formatSize(a.fileSize)} · asset id ${a.id}${a.updateId ? ` · in update ${a.updateId}` : ""}`,
          ),
        ].join("\n");

  let updates: string;
  if (item.updates.length === 0) updates = "Updates: none.";
  else {
    const older =
      item.updates.length >= ITEM_UPDATES_LIMIT
        ? ` Showing the latest ${ITEM_UPDATES_LIMIT} updates; older ones (possibly the original description) are not shown.`
        : "";
    const title = `Updates (the ticket's description and discussion), newest first; the oldest is usually the description.${older}`;
    const blocks = item.updates.map(renderUpdate);
    const budget = MAX_OUTPUT - head.join("\n").length - files.length - title.length - 200;
    const last = blocks.length - 1;
    const keep = blocks.map((_, i) => i === last);
    let used = blocks[last]!.length + 2;
    for (let i = 0; i < last; i++) {
      const size = blocks[i]!.length + 2;
      if (used + size > budget) break;
      keep[i] = true;
      used += size;
    }
    const omitted = keep.filter((k) => !k).length;
    const shown: string[] = [];
    blocks.forEach((b, i) => {
      if (i === last && omitted > 0) shown.push(`… ${omitted} more update(s) omitted to fit the output limit …`);
      if (keep[i]) shown.push(b);
    });
    updates = [title, ...shown].join("\n\n");
  }
  return [head.join("\n"), updates, files].join("\n\n");
}

// --- monday_attach_files -------------------------------------------------------

/** Files per monday_attach_files call. */
const MAX_ATTACH_FILES = 10;
/** Text shown per file, and in total per call (tool results are size-limited). */
const MAX_ATTACH_TEXT_PER_FILE = 40_000;
const MAX_ATTACH_TEXT_TOTAL = 60_000;
/** Image bytes shown per call (each image also ≤ ATTACHMENT_LIMITS.maxImageBytes). */
const MAX_ATTACH_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const IMAGE_EXT: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The image type from the file's first bytes; a name or header can lie, and Claude rejects a mismatched type. */
function sniffImage(b: Uint8Array): ImageType | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

const extOf = (name: string) => name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();

function mimeFor(name: string, contentType: string | undefined): string {
  const byExt = MIME_BY_EXT[extOf(name) ?? ""];
  if (byExt) return byExt;
  if (contentType && !contentType.includes("octet-stream")) return contentType;
  return "application/octet-stream";
}

/** The asset's name with an extension, matching the real image type when it is an image. */
function fileNameFor(asset: MondayAsset, image: ImageType | undefined): string {
  let name = asset.name;
  if (!extOf(name) && asset.fileExtension) name = `${name}.${asset.fileExtension}`;
  if (image && MIME_BY_EXT[extOf(name) ?? ""] !== image) name = `${name.replace(/\.[a-z0-9]+$/i, "")}.${IMAGE_EXT[image]}`;
  return name;
}

type Content = CallToolResult["content"];

/** Downloads, stores and shows an item's files. Per-file problems are reported, not thrown. */
async function attachFiles(
  client: MondayClient,
  item: MondayItemDetails,
  assetIds: string[] | undefined,
  addAttachment: AddAttachment | undefined,
): Promise<CallToolResult> {
  if (item.assets.length === 0) return ok(`Item ${item.id} "${item.name}" has no files.`);

  const notes: string[] = [];
  let chosen: MondayAsset[];
  if (assetIds?.length) {
    chosen = [];
    for (const id of assetIds) {
      const asset = item.assets.find((a) => a.id === id);
      if (asset) chosen.push(asset);
      else notes.push(`Asset ${id} is not one of this item's files.`);
    }
    if (chosen.length === 0) {
      throw new InputError(`None of the given asset ids are files of item ${item.id}. Its files: ${assetRefs(item.assets)}.`);
    }
  } else {
    chosen = item.assets.slice(0, MAX_ATTACH_FILES);
    if (item.assets.length > MAX_ATTACH_FILES) {
      notes.push(
        `The item has ${item.assets.length} files; attached the first ${MAX_ATTACH_FILES}. For the others, call again with asset_ids: ${assetRefs(item.assets.slice(MAX_ATTACH_FILES))}.`,
      );
    }
  }

  const blocks: Content = [];
  let textBudget = MAX_ATTACH_TEXT_TOTAL;
  let imageBudget = MAX_ATTACH_IMAGE_BYTES;

  /** Adds a text file's contents; returns what happened, for the summary. */
  const showText = (label: string, bytes: Uint8Array): { shown: boolean; note: string } => {
    const full = Buffer.from(bytes).toString("utf8");
    if (full.slice(0, 8_000).includes("\u0000")) return { shown: false, note: "binary, not shown" };
    if (textBudget <= 0) return { shown: false, note: "not shown here (text limit for one call reached)" };
    const limit = Math.min(MAX_ATTACH_TEXT_PER_FILE, textBudget);
    const cut = full.length > limit;
    textBudget -= Math.min(full.length, limit);
    const text = cut ? `${full.slice(0, limit)}\n… (truncated, ${full.length} characters in total)` : full;
    blocks.push({ type: "text", text: `File: ${label}\n<file>\n${text}\n</file>` });
    return { shown: true, note: cut ? "text shown below (truncated)" : "text shown below" };
  };

  const show = (name: string, mime: string, image: ImageType | undefined, bytes: Uint8Array): string => {
    if (image) {
      if (bytes.byteLength > ATTACHMENT_LIMITS.maxImageBytes) return `image over ${formatSize(ATTACHMENT_LIMITS.maxImageBytes)}, not shown here`;
      if (bytes.byteLength > imageBudget) return "image not shown here (image limit for one call reached)";
      imageBudget -= bytes.byteLength;
      blocks.push({ type: "text", text: `Image: ${name}` });
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: image });
      return "image shown below";
    }
    const kind = classify(name, mime);
    if (kind === "zip") {
      let inner: { name: string; bytes: Uint8Array }[];
      try {
        inner = expandZip(bytes);
      } catch {
        return "a zip that could not be opened";
      }
      const shown: string[] = [];
      const others: string[] = [];
      for (const f of inner) {
        if (classify(f.name, "") === "text" && showText(`${name} › ${f.name}`, f.bytes).shown) shown.push(f.name);
        else others.push(f.name);
      }
      const listed = others.length > 40 ? `${others.slice(0, 40).join(", ")}, … (${others.length - 40} more)` : others.join(", ");
      return [
        `zip with ${inner.length} file(s)`,
        shown.length ? `text files shown below: ${shown.join(", ")}` : "no text files shown",
        others.length ? `not shown: ${listed}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    if (kind === "text") return showText(name, bytes).note;
    if (kind === "pdf") return "PDF, not shown here";
    return `${mime === "application/octet-stream" ? "this file type" : mime} cannot be shown here`;
  };

  const lines: string[] = [];
  let delivered = 0;
  let stored = 0;
  for (const asset of chosen) {
    const label = `${asset.name} (${formatSize(asset.fileSize)}, asset ${asset.id})`;
    if (asset.fileSize !== undefined && asset.fileSize > ATTACHMENT_LIMITS.maxFileBytes) {
      lines.push(`- ${label}: skipped, larger than ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`);
      continue;
    }
    if (!asset.publicUrl) {
      lines.push(`- ${label}: skipped, monday.com gave no download link.`);
      continue;
    }
    let file: { bytes: Uint8Array; contentType?: string };
    try {
      file = await client.downloadAsset(asset.publicUrl);
    } catch (err) {
      lines.push(`- ${label}: ${errMessage(err)}`);
      continue;
    }
    const image = sniffImage(file.bytes);
    const name = fileNameFor(asset, image);
    const mime = image ?? mimeFor(name, file.contentType);
    if (!image && classify(name, mime) === "image") {
      // Stored as an image, it would later be sent to Claude as one and rejected.
      lines.push(`- ${label}: not stored or shown; it is named like an image but is not a PNG, JPEG, GIF or WebP file.`);
      continue;
    }
    delivered += 1;
    let storeNote = "";
    if (addAttachment) {
      try {
        const r = await addAttachment({ name, mime, bytes: file.bytes, source: "monday", sourceId: asset.id });
        if (r.ok) stored += 1;
        else storeNote = `; not stored for the team: ${r.error}`;
      } catch (err) {
        storeNote = `; not stored for the team: ${errMessage(err)}`;
      }
    }
    const renamed = name !== asset.name ? ` (as ${name}, its real file type)` : "";
    lines.push(`- ${label}: ${show(name, mime, image, file.bytes)}${renamed}${storeNote}.`);
  }

  const storage = !addAttachment
    ? "These files could not be stored for the team (file storage is not available here): they are shown below for this reply only, and repo tasks will not get them."
    : stored > 0
      ? `Stored in this conversation (${stored} file(s)): you can use them in later replies, and repo tasks started from this conversation get them.`
      : "";
  const summary = [`Files from item ${item.id} "${item.name}":`, ...lines, ...notes, ...(delivered > 0 && storage ? [storage] : [])].join("\n");
  return { content: [{ type: "text", text: cap(summary) }, ...blocks], ...(delivered === 0 ? { isError: true } : {}) };
}

/** Plain handler functions (unit-testable); `mondayTools` wraps them as SDK tools. */
export function mondayHandlers(opts: MondayToolOptions): MondayHandlers {
  const allowed = opts.allowedBoardIds;

  const checkAllowed = (boardId: string) => {
    if (allowed.length > 0 && !allowed.includes(boardId)) {
      throw new InputError(
        `Board ${boardId} is not one of the allowed monday.com boards (${allowed.join(", ")}). Ask the owner to allow it on the admin page.`,
      );
    }
  };

  const boardIdOf = (given: string | undefined): string => {
    const id = given?.trim() || opts.defaultBoardId;
    if (!id) throw new InputError(NO_BOARD);
    if (!BOARD_ID_RE.test(id)) throw new InputError(`"${id}" is not a monday.com board id (digits only).`);
    checkAllowed(id);
    return id;
  };

  /** Finds the item's board, checks it against `expected` and the allowlist. */
  const itemBoard = async (client: MondayClient, itemId: string, expected?: string): Promise<string> => {
    const actual = await client.getItemBoardId(itemId);
    if (!actual) throw new InputError(`Item ${itemId} was not found (or the token cannot see it).`);
    if (expected && actual !== expected) {
      throw new InputError(`Item ${itemId} is on board ${actual}, not board ${expected}.`);
    }
    checkAllowed(actual);
    return actual;
  };

  /** The item's board must be allowed; checked before anything from the item is returned or downloaded. */
  const checkItemAllowed = (item: MondayItemDetails) => {
    if (allowed.length === 0) return;
    if (!item.board) {
      throw new InputError(`Could not tell which board item ${item.id} is on, so it cannot be checked against the allowed boards.`);
    }
    checkAllowed(item.board.id);
  };

  const runContent = async (fn: (client: MondayClient) => Promise<CallToolResult>): Promise<CallToolResult> => {
    const client = opts.client;
    if (!client) return fail(NOT_CONNECTED);
    try {
      return await fn(client);
    } catch (err) {
      return fail(errMessage(err));
    }
  };

  const run = (fn: (client: MondayClient) => Promise<string>): Promise<CallToolResult> =>
    runContent(async (client) => ok(await fn(client)));

  return {
    monday_list_boards: ({ search }) =>
      run(async (client) => {
        const boards = await client.listBoards({
          search,
          limit: 50,
          ...(allowed.length ? { ids: allowed } : {}),
        });
        if (boards.length === 0) {
          return search ? `No monday.com boards match "${search}".` : "No monday.com boards found.";
        }
        const lines = boards.map((b) => {
          const ws = b.workspace ? ` · workspace: ${b.workspace}` : "";
          const def = b.id === opts.defaultBoardId ? " · default board" : "";
          return `- ${b.name} (id ${b.id})${ws}${def}`;
        });
        const scope = allowed.length ? "Allowed boards" : "Boards (most recently used first)";
        return `${scope}:\n${lines.join("\n")}`;
      }),

    monday_get_board: ({ board_id }) =>
      run(async (client) => {
        const board = await client.getBoard(boardIdOf(board_id));
        const lines = [`Board "${board.name}" (id ${board.id})`];
        if (board.url) lines.push(`URL: ${board.url}`);
        lines.push("", "Groups (use the id as group_id):");
        for (const g of board.groups) lines.push(`- ${g.title}: ${g.id}`);
        lines.push("", "Columns (use the id as the key in column_values):");
        for (const c of board.columns) {
          const labels = c.labels ? ` · labels: ${c.labels.join(", ")}` : "";
          lines.push(`- ${c.title}: id ${c.id}, type ${c.type}${labels}`);
        }
        return lines.join("\n");
      }),

    monday_search_items: ({ text, board_id }) =>
      run(async (client) => {
        const boardId = boardIdOf(board_id);
        const query = text.trim();
        if (!query) throw new InputError("Give some text to search for.");
        const items = await client.searchItems(boardId, query, 20);
        if (items.length === 0) return `No items on board ${boardId} have "${query}" in their name.`;
        const lines = items.map((item) => {
          const group = item.group ? ` · group: ${item.group}` : "";
          const url = item.url ? ` · ${item.url}` : "";
          const cols = Object.entries(item.columns)
            .map(([k, v]) => `${k}: ${v.replace(/\s+/g, " ").slice(0, 200)}`)
            .join(" · ");
          return `- ${item.name} (id ${item.id})${group}${url}${cols ? `\n  ${cols}` : ""}`;
        });
        return `Items on board ${boardId} matching "${query}":\n${lines.join("\n")}`;
      }),

    monday_find_users: ({ name }) =>
      run(async (client) => {
        const query = name.trim();
        if (!query) throw new InputError("Give a name to search for.");
        const users = await client.findUsers(query);
        if (users.length === 0) return `No monday.com users match "${query}".`;
        const lines = users.map((u) => `- ${u.name} (id ${u.id})${u.email ? ` · ${u.email}` : ""}`);
        return `${lines.join("\n")}\nTo assign someone: {"personsAndTeams": [{"id": <id>, "kind": "person"}]} on a people column.`;
      }),

    monday_create_item: ({ name, board_id, group_id, description, column_values }) =>
      run(async (client) => {
        const title = name.trim();
        if (!title) throw new InputError("The item needs a name.");
        if (title.length > 255) throw new InputError("The item name must be at most 255 characters; put details in description.");
        const boardId = boardIdOf(board_id);
        const columnValues = parseColumnValues(column_values);
        const created = await client.createItem({
          boardId,
          name: title,
          ...(group_id?.trim() ? { groupId: group_id.trim() } : {}),
          ...(columnValues ? { columnValues } : {}),
        });
        const lines = [`Created item ${created.id} "${title}" on board ${boardId}.`];
        if (created.url) lines.push(`URL: ${created.url}`);
        const details = description?.trim();
        if (details) {
          const body = opts.requester ? `${details}\n\nOpened from Slack by ${opts.requester}` : details;
          try {
            await client.addUpdate(created.id, body);
            lines.push("Posted the description as the item's first update.");
          } catch (err) {
            lines.push(
              `The item was created, but posting the description failed: ${errMessage(err)} Do not create the item again; use monday_add_comment to add the description.`,
            );
          }
        }
        return lines.join("\n");
      }),

    monday_update_item: ({ item_id, column_values, board_id }) =>
      run(async (client) => {
        const itemId = itemIdOf(item_id);
        const values = parseColumnValues(column_values);
        if (!values || Object.keys(values).length === 0) {
          throw new InputError("column_values is empty: give at least one column id and its new value.");
        }
        let boardId = board_id?.trim() || undefined;
        if (boardId) {
          if (!BOARD_ID_RE.test(boardId)) throw new InputError(`"${boardId}" is not a monday.com board id (digits only).`);
          checkAllowed(boardId);
        }
        // Without a board id we must look it up; with an allowlist we verify the item's real board.
        if (!boardId || allowed.length > 0) boardId = await itemBoard(client, itemId, boardId);
        await client.changeColumnValues({ boardId, itemId, columnValues: values });
        return `Updated item ${itemId} on board ${boardId}: ${Object.keys(values).join(", ")}.`;
      }),

    monday_add_comment: ({ item_id, text }) =>
      run(async (client) => {
        const itemId = itemIdOf(item_id);
        const body = text.trim();
        if (!body) throw new InputError("The comment is empty.");
        if (allowed.length > 0) await itemBoard(client, itemId);
        const update = await client.addUpdate(itemId, body);
        return `Added a comment (update ${update.id}) to item ${itemId}.`;
      }),

    monday_get_item: ({ item_id }) =>
      run(async (client) => {
        const item = await client.getItem(itemIdOf(item_id));
        checkItemAllowed(item);
        return formatItem(item);
      }),

    monday_attach_files: ({ item_id, asset_ids }) =>
      runContent(async (client) => {
        const itemId = itemIdOf(item_id);
        const ids = asset_ids ? [...new Set(asset_ids.map((id) => id.trim()).filter(Boolean))] : [];
        if (ids.length > MAX_ATTACH_FILES) throw new InputError(`Give at most ${MAX_ATTACH_FILES} asset ids per call.`);
        for (const id of ids) {
          if (!BOARD_ID_RE.test(id)) throw new InputError(`"${id}" is not a monday.com asset id (digits only).`);
        }
        const item = await client.getItem(itemId);
        checkItemAllowed(item);
        return attachFiles(client, item, ids.length ? ids : undefined, opts.addAttachment);
      }),
  };
}

const COLUMN_FORMATS = `column_values is a JSON object keyed by column id (ids from monday_get_board, never guessed). Formats:
- status: {"label": "Working on it"} (must be one of the column's labels) or {"index": 1}
- dropdown: {"labels": ["Bug", "Frontend"]}
- people: {"personsAndTeams": [{"id": 12345, "kind": "person"}]} (user ids from monday_find_users; replaces whoever is assigned)
- date: {"date": "2026-11-20"}, optionally with "time": "14:00:00" (UTC)
- text: "plain text"
- long text: {"text": "longer text"}
- numbers: "42"
- clear a column: null
Example: {"status": {"label": "Stuck"}, "date4": {"date": "2026-11-20"}}`;

const boardIdField = (what: string) =>
  z
    .string()
    .regex(BOARD_ID_RE, "monday.com ids are digits")
    .optional()
    .describe(`${what} Numeric board id as a string. Defaults to the default board.`);

const itemIdField = z.string().regex(BOARD_ID_RE, "monday.com ids are digits").describe("Numeric item id as a string.");

const columnValuesField = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .describe("Column values keyed by column id, as a JSON object (see the formats in the tool description).");

/**
 * Tool definitions for Pointer's in-process MCP server "pointer" (full names: mcp__pointer__<name>).
 * Typed like `createSdkMcpServer`'s `tools` option (SdkMcpToolDefinition<any>[]): each tool has its own schema.
 */
export function mondayTools(opts: MondayToolOptions): SdkMcpToolDefinition<any>[] {
  const h = mondayHandlers(opts);
  const read = { annotations: { readOnlyHint: true, openWorldHint: true } };
  const write = { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } };
  return [
    tool(
      "monday_list_boards",
      "List the monday.com boards Pointer can use (most recently used first) with their ids and workspaces. Pass `search` to filter by board name. Use it to find a board id when the user names a board, or when no default board is set.",
      { search: z.string().optional().describe("Part of the board name, case-insensitive.") },
      (args) => h.monday_list_boards(args),
      read,
    ),
    tool(
      "monday_get_board",
      "Show a monday.com board's groups and columns: column ids, column types, and the labels allowed in its status and dropdown columns. Call this before setting column_values in monday_create_item or monday_update_item so you use real column ids and existing labels.",
      { board_id: boardIdField("The board to describe.") },
      (args) => h.monday_get_board(args),
      read,
    ),
    tool(
      "monday_search_items",
      "Search items (tickets) on a monday.com board whose name contains the text (case-insensitive). Returns item ids, groups, URLs and current column values. Use it to find a ticket before updating or commenting on it, and to check for an existing ticket before opening a new one. Search with a short keyword (\"login\"), not a sentence.",
      {
        text: z.string().min(1).describe("Text the item name contains, e.g. a keyword."),
        board_id: boardIdField("The board to search."),
      },
      (args) => h.monday_search_items(args),
      read,
    ),
    tool(
      "monday_find_users",
      'Find monday.com users by name (fuzzy). Returns user ids and emails, needed to assign someone through a people column: {"personsAndTeams": [{"id": 12345, "kind": "person"}]}.',
      { name: z.string().min(1).describe("The person's name or part of it.") },
      (args) => h.monday_find_users(args),
      read,
    ),
    tool(
      "monday_create_item",
      `Create an item (ticket) on a monday.com board, e.g. when asked to "open a ticket for the login bug". Returns the item id and URL; share the URL with the user.
- name: a short title.
- description: the details (what happened, steps to reproduce, links, context from the conversation). It is posted as the item's first update (with a note naming who asked in Slack, when known). Always include one.
- board_id: defaults to the default board. If there is none, ask the user which board, or call monday_list_boards.
- group_id: optional (defaults to the board's top group); group ids come from monday_get_board.
- column_values: optional. Call monday_get_board first to learn the column ids and status labels.
Do not open the same ticket twice: if unsure whether it exists, call monday_search_items first.

${COLUMN_FORMATS}`,
      {
        name: z.string().min(1).max(255).describe("Short item title."),
        board_id: boardIdField("Board to create the item on."),
        group_id: z.string().optional().describe("Group id from monday_get_board (not the group title)."),
        description: z.string().optional().describe("Details, posted as the item's first update."),
        column_values: columnValuesField.optional(),
      },
      (args) => h.monday_create_item(args),
      write,
    ),
    tool(
      "monday_update_item",
      `Change column values of an existing monday.com item, e.g. set its status to "Done", assign someone or set a due date. Call monday_get_board first for column ids and status labels, and monday_search_items to find the item id. To rename the item use {"name": "New title"}.

${COLUMN_FORMATS}`,
      {
        item_id: itemIdField,
        column_values: columnValuesField,
        board_id: z
          .string()
          .regex(BOARD_ID_RE, "monday.com ids are digits")
          .optional()
          .describe("The item's board id; looked up from the item when omitted."),
      },
      (args) => h.monday_update_item(args),
      { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
    ),
    tool(
      "monday_add_comment",
      "Add a comment (an update) to a monday.com item, e.g. progress notes, a PR link, or extra details. Plain text; line breaks are kept.",
      {
        item_id: itemIdField,
        text: z.string().min(1).describe("The comment text."),
      },
      (args) => h.monday_add_comment(args),
      write,
    ),
    tool(
      "monday_get_item",
      "Read one monday.com item (ticket) in full: title, link, board and group, status and other column values, its updates (the ticket's description and discussion, newest first, with author, date and replies) and its files (name, size, asset id). " +
        "The item id is the number after /pulses/ in a monday URL, e.g. https://acme.monday.com/boards/123/pulses/4567 → 4567. " +
        "Use this to read a ticket's description and comments before acting on it. To read its files or hand them to the team, call monday_attach_files.",
      { item_id: itemIdField },
      (args) => h.monday_get_item(args),
      read,
    ),
    tool(
      "monday_attach_files",
      `Download a monday.com item's files and attach them to this conversation: you see them now, and repo tasks started from this conversation get them. ` +
        `Attaches all of the item's files, or only asset_ids (from monday_get_item); at most ${MAX_ATTACH_FILES} files per call, ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)} each. ` +
        "Text, HTML and code files are shown as text, PNG/JPEG/GIF/WebP images as images, and zips are opened with their text files shown; other files (PDFs, videos, …) are stored and listed by name. " +
        "Use it when a ticket's designs, screenshots or specs matter, e.g. before start_repo_task.",
      {
        item_id: itemIdField,
        asset_ids: z
          .array(z.string().regex(BOARD_ID_RE, "monday.com ids are digits"))
          .max(MAX_ATTACH_FILES)
          .optional()
          .describe("Asset ids from monday_get_item. Omit to attach all of the item's files."),
      },
      (args) => h.monday_attach_files(args),
      write,
    ),
  ];
}
