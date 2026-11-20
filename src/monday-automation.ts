import { createHash } from "node:crypto";
import { z } from "zod";
import { type Config, type ConfigRepo, MONDAY_ID_RE, type MondayBoardAutomation } from "./core/config.js";
import type { DirectTaskResult } from "./conversations.js";
import { KeyedQueue } from "./listen.js";
import { type MondayBoard, MondayClient, type MondayItemDetails, statusColumns } from "./monday.js";
import type { Store } from "./core/store.js";
import { plainLine } from "./task-events.js";
import type { Task, TaskRepo, TaskTicket } from "./tasks.js";
import { type TicketClient, updateTicket } from "./ticket-sync.js";
import { configSecrets, makeRedactor } from "./worker.js";

/**
 * monday.com tickets that start repo tasks. A board opts in with a repository
 * and its status labels (config.monday.automation.boards); monday.com calls
 * the webhook (POST /monday/webhook/<secret>) when the board's status column
 * changes. The payload is never trusted beyond its board and item ids: the
 * item is read again, and a task starts only when its status is the board's
 * start label now, the board is automated, and no task is already working on
 * that ticket. The task runs in a new console conversation named after the
 * ticket; ticket-sync.ts moves the ticket's status as the work goes. Ticket
 * text is never logged.
 */

/** The webhook created on each automated board: a change of its status column. */
export const MONDAY_WEBHOOK_EVENT = "change_specific_column_value";
/** A ticket that started a task is not started again within this time, whatever its status does. */
export const START_COOLDOWN_MS = 5 * 60_000;
/** Longest instruction built from a ticket (console instructions are limited to 8000 characters). */
export const INSTRUCTION_MAX_CHARS = 6000;
/** Recent tasks looked at to find one already working on a ticket. */
const ACTIVE_SCAN = 200;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** Labels compare without letter case and surrounding spaces, as people type them. */
export const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------- The webhook's payload ----------

const Id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().max(20).regex(MONDAY_ID_RE)]).transform(String);
const EventIds = z.object({ event: z.object({ boardId: Id, pulseId: Id }) });

/** The challenge monday.com sends when a webhook is created, to be echoed back. */
export function webhookChallenge(body: unknown): string | undefined {
  const challenge = typeof body === "object" && body !== null ? (body as { challenge?: unknown }).challenge : undefined;
  return typeof challenge === "string" && challenge.length <= 1000 ? challenge : undefined;
}

/** The board and item of a delivery: the only parts of the payload that are used. */
export function webhookIds(body: unknown): { boardId: string; itemId: string } | undefined {
  const parsed = EventIds.safeParse(body);
  return parsed.success ? { boardId: parsed.data.event.boardId, itemId: parsed.data.event.pulseId } : undefined;
}

// ---------- The decision, from the item as monday.com has it now ----------

export type TicketDecision = { start: true; board: MondayBoardAutomation; ticket: TaskTicket } | { start: false; reason: string };

/** Whether this item, read again from monday.com, should start a task now. Pure. */
export function ticketTrigger(config: Config, boardId: string, item: MondayItemDetails): TicketDecision {
  const no = (reason: string): TicketDecision => ({ start: false, reason });
  const auto = config.monday.automation;
  if (!auto.enabled) return no("automation is off");
  const board = auto.boards[boardId];
  if (!board) return no("board not automated");
  const allowed = config.monday.allowedBoardIds;
  if (allowed.length > 0 && !allowed.includes(boardId)) return no("board is not one Pointer may use");
  if (item.board?.id !== boardId) return no("item is not on that board");
  if (item.state && item.state !== "active") return no("item is archived or deleted");
  const status = item.columns.find((c) => c.id === board.statusColumnId)?.text ?? "";
  if (!sameLabel(status, board.startLabel)) return no("status is not the start label");
  return {
    start: true,
    board,
    ticket: { boardId, itemId: item.id, name: clip(item.name.trim(), 200), ...(item.url ? { url: item.url } : {}) },
  };
}

const UPDATES_SHOWN = 5;
const UPDATE_CHARS = 1500;
const COLUMNS_SHOWN = 25;
const COLUMN_CHARS = 150;

function updateDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/**
 * The repo task's instruction from a ticket: its name, where it is, its
 * column values in short, its description and first updates (oldest first),
 * and the names of its files. At most `max` characters: the updates are cut
 * first.
 */
export function ticketInstruction(item: MondayItemDetails, max = INSTRUCTION_MAX_CHARS): string {
  const where = [item.board?.name ? `board "${item.board.name}"` : "", item.group?.title ? `group "${item.group.title}"` : "", `item ${item.id}`]
    .filter(Boolean)
    .join(", ");
  const head = [`Work on this monday.com ticket: ${clip(item.name.trim(), 255)}`, `(${where})`];
  if (item.url) head.push(`Link: ${item.url}`);

  const columns = item.columns.slice(0, COLUMNS_SHOWN).map((c) => `- ${c.title}: ${clip(c.text.replace(/\s+/g, " ").trim(), COLUMN_CHARS)}`);
  const columnsPart = columns.length ? `Columns:\n${columns.join("\n")}` : "";

  const files = item.assets.map((a) => a.name);
  const filesPart = files.length
    ? `Files on the ticket (${files.length}): ${clip(files.join(", "), 500)}. They are not attached to this task; Pointer can attach them in this conversation with its monday.com tools.`
    : "";

  // monday.com lists updates newest first; the oldest is usually the description.
  const updates = [...item.updates]
    .reverse()
    .filter((u) => u.text.trim())
    .slice(0, UPDATES_SHOWN)
    .map((u) => {
      const who = [u.author ?? "Someone", updateDate(u.createdAt)].filter(Boolean).join(", ");
      return `${who}:\n${clip(u.text.trim(), UPDATE_CHARS)}`;
    });

  const fixed = [head.join("\n"), columnsPart, filesPart].filter(Boolean);
  const room = max - fixed.join("\n\n").length - 2;
  const title = "Description and first updates (oldest first):";
  const shown: string[] = [];
  let used = title.length;
  for (const u of updates) {
    if (used + u.length + 2 > room) break;
    shown.push(u);
    used += u.length + 2;
  }
  const parts = [fixed[0]!, ...(shown.length ? [`${title}\n\n${shown.join("\n\n")}`] : []), ...fixed.slice(1)];
  return clip(parts.join("\n\n"), max);
}

// ---------- Board settings ----------

const LABEL_KEYS = ["startLabel", "workingLabel", "reviewLabel", "doneLabel", "stuckLabel"] as const;
const SET_LABELS = ["workingLabel", "reviewLabel", "doneLabel", "stuckLabel"] as const;
const LABEL_NAMES: Record<(typeof LABEL_KEYS)[number], string> = {
  startLabel: "start",
  workingLabel: "working",
  reviewLabel: "in review",
  doneLabel: "done",
  stuckLabel: "stuck",
};

/** The start label must differ from the ones the team sets, or a ticket would start itself again. Pure. */
export function labelConflict(auto: MondayBoardAutomation): string | undefined {
  const same = SET_LABELS.find((k) => auto[k].trim() && sameLabel(auto[k], auto.startLabel));
  return same ? `The start label "${auto.startLabel}" is also the ${LABEL_NAMES[same]} label: use different labels, or a ticket would start itself again.` : undefined;
}

/**
 * Checks a board's settings against the board itself: the status column
 * exists and has every label named. Returns them with the board's spelling of
 * each label. Pure.
 */
export function checkBoardAutomation(
  board: Pick<MondayBoard, "name" | "columns">,
  auto: MondayBoardAutomation,
): { ok: true; automation: MondayBoardAutomation } | { ok: false; error: string } {
  const columns = statusColumns(board);
  const column = columns.find((c) => c.id === auto.statusColumnId);
  if (!column) {
    const list = columns.map((c) => `${c.title} (${c.id})`).join(", ");
    return {
      ok: false,
      error: `Board "${board.name}" has no status column with the id "${auto.statusColumnId}". ${list ? `Its status columns: ${list}.` : "It has no status column."}`,
    };
  }
  const fixed: MondayBoardAutomation = { ...auto };
  for (const key of LABEL_KEYS) {
    const wanted = auto[key].trim();
    if (!wanted) continue;
    const found = column.labels.find((l) => sameLabel(l, wanted));
    if (!found) {
      return {
        ok: false,
        error: `The "${column.title}" column on board "${board.name}" has no label "${wanted}" (the ${LABEL_NAMES[key]} label). Its labels: ${column.labels.join(", ") || "none"}.`,
      };
    }
    fixed[key] = found;
  }
  return { ok: true, automation: fixed };
}

// ---------- The board webhooks ----------

export type WebhookClient = Pick<MondayClient, "createWebhook" | "deleteWebhook" | "listWebhooks">;

/** The webhooks created on each board, so connecting again replaces them instead of adding more. Ids only: the URL holds the secret. */
const WEBHOOKS_KEY = "monday/webhooks.json";
type SavedWebhooks = Record<string, { id: string; urlHash: string; columnId: string; at: string }>;

const urlHash = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);

async function readWebhooks(store: Pick<Store, "get">): Promise<SavedWebhooks> {
  try {
    const blob = await store.get(WEBHOOKS_KEY);
    const data = blob ? (JSON.parse(blob.toString("utf8")) as unknown) : {};
    return typeof data === "object" && data !== null ? (data as SavedWebhooks) : {};
  } catch {
    return {};
  }
}

export interface WebhookConnectResult {
  /** Boards whose webhook was created now or is already there. */
  created: string[];
  failed: { boardId: string; error: string }[];
}

/**
 * Creates (or keeps) one webhook per automated board, on its status column,
 * pointing at `url`. A board's earlier webhook for another URL or column is
 * deleted first. Errors are per board and redacted.
 */
export async function connectWebhooks(
  deps: { store: Pick<Store, "get" | "put">; client: WebhookClient; redact: (text: string) => string; now?: () => Date },
  boards: Record<string, MondayBoardAutomation>,
  url: string,
): Promise<WebhookConnectResult> {
  const saved = await readWebhooks(deps.store);
  const hash = urlHash(url);
  const out: WebhookConnectResult = { created: [], failed: [] };
  for (const [boardId, auto] of Object.entries(boards)) {
    try {
      const mine = saved[boardId];
      if (mine && mine.urlHash === hash && mine.columnId === auto.statusColumnId) {
        const live = await deps.client.listWebhooks(boardId).catch(() => undefined);
        if (live?.some((w) => w.id === mine.id)) {
          out.created.push(boardId);
          continue;
        }
      }
      if (mine) await deps.client.deleteWebhook(mine.id).catch(() => undefined);
      const hook = await deps.client.createWebhook({ boardId, url, event: MONDAY_WEBHOOK_EVENT, config: { columnId: auto.statusColumnId } });
      saved[boardId] = { id: hook.id, urlHash: hash, columnId: auto.statusColumnId, at: (deps.now?.() ?? new Date()).toISOString() };
      out.created.push(boardId);
    } catch (err) {
      out.failed.push({ boardId, error: plainLine(deps.redact(errorText(err)), 300) });
    }
  }
  await deps.store.put(WEBHOOKS_KEY, JSON.stringify(saved));
  return out;
}

/** Deletes the webhook created on a board that is no longer automated. Best effort; never throws. */
export async function removeWebhook(deps: { store: Pick<Store, "get" | "put">; client?: WebhookClient }, boardId: string): Promise<void> {
  try {
    const saved = await readWebhooks(deps.store);
    const mine = saved[boardId];
    if (!mine) return;
    if (deps.client) await deps.client.deleteWebhook(mine.id).catch(() => undefined);
    delete saved[boardId];
    await deps.store.put(WEBHOOKS_KEY, JSON.stringify(saved));
  } catch {
    // The webhook stays; its deliveries are ignored for a board that is not automated.
  }
}

/** How to add the webhook by hand when the token's user cannot create it. */
export function manualWebhookSteps(url: string, columnTitle = "Status"): string[] {
  return [
    "Open the board in monday.com and choose Integrate (the Integrations center) at the top right.",
    'Search for "Webhooks" and choose the recipe "When a column changes, send a webhook".',
    `Pick the ${columnTitle} column and paste this URL: ${url}`,
    "monday.com checks the URL right away; Agent Army answers that check while the automation is on.",
  ];
}

// ---------- The handler ----------

export type AutomationClient = Pick<MondayClient, "getItem"> & TicketClient;

export interface TicketAutomationDeps {
  configRepo: Pick<ConfigRepo, "load">;
  tasks: Pick<TaskRepo, "recent">;
  /** ConversationService.startDirectTask: a new console conversation with the task. */
  startTask: (
    repo: string,
    instruction: string,
    opts: { trigger: Task["trigger"]; ticket: TaskTicket; title: string; ackText: string },
  ) => Promise<DirectTaskResult>;
  /** Test seam: the monday.com client for a token. */
  client?: (token: string) => AutomationClient;
  now?: () => number;
}

const isActive = (t: Task) => t.status === "queued" || t.status === "running";

/**
 * Turns webhook deliveries into repo tasks: one item at a time, each start
 * decided from the item as monday.com has it now. Remembers the tickets it
 * started (in memory) for START_COOLDOWN_MS.
 */
export class TicketAutomation {
  private readonly queue = new KeyedQueue();
  private readonly started = new Map<string, number>();
  private readonly inFlight = new Set<Promise<string>>();

  constructor(private readonly deps: TicketAutomationDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Handles one delivery; resolves with the outcome, which is also logged (ids only). Never throws. */
  handle(boardId: string, itemId: string): Promise<string> {
    const run = this.run(boardId, itemId);
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
    return run;
  }

  /** Tests: resolves when every delivery being handled is done. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  private async run(boardId: string, itemId: string): Promise<string> {
    let redact = (text: string) => text;
    const outcome = await this.queue
      .run(itemId, async () => {
        const config = await this.deps.configRepo.load();
        redact = makeRedactor([...configSecrets(config), config.monday.automation.webhookSecret]);
        return this.decide(config, boardId, itemId, redact);
      })
      .catch((err: unknown) => `failed: ${plainLine(redact(errorText(err)), 200)}`);
    console.log(`[monday] board ${boardId} item ${itemId}: ${outcome}`);
    return outcome;
  }

  private async decide(config: Config, boardId: string, itemId: string, redact: (text: string) => string): Promise<string> {
    const auto = config.monday.automation;
    if (!auto.enabled) return "ignored: automation is off";
    const board = auto.boards[boardId];
    if (!board) return "ignored: board not automated";
    const token = config.monday.token;
    if (!token) return "ignored: monday.com is not connected";
    const now = this.now();
    const last = this.started.get(itemId);
    if (last !== undefined && now - last < START_COOLDOWN_MS) return "ignored: a task started on this ticket moments ago";
    if ((await this.deps.tasks.recent(ACTIVE_SCAN)).some((t) => isActive(t) && t.ticket?.itemId === itemId)) {
      return "ignored: a task is already working on this ticket";
    }

    const client = this.deps.client?.(token) ?? new MondayClient(token);
    let item: MondayItemDetails;
    try {
      item = await client.getItem(itemId);
    } catch (err) {
      return `ignored: could not read the item (${plainLine(redact(errorText(err)), 200)})`;
    }
    const decision = ticketTrigger(config, boardId, item);
    if (!decision.start) return `ignored: ${decision.reason}`;

    this.started.set(itemId, now);
    for (const [id, at] of this.started) if (now - at >= START_COOLDOWN_MS) this.started.delete(id);
    const name = plainLine(item.name, 120);
    const result = await this.deps.startTask(decision.board.repo, ticketInstruction(item), {
      trigger: "monday",
      ticket: decision.ticket,
      title: item.name,
      ackText: `The ticket **${name}** moved to *${decision.board.startLabel}* on monday.com. Putting the team on \`${decision.board.repo}\`…`,
    });
    if (!result.ok) {
      const error = redact(result.error);
      await updateTicket({ config, client, redact }, decision.ticket, {
        label: "stuckLabel",
        text: `The team could not start on this: ${error}`,
        what: "not started",
      });
      return `could not start a task: ${plainLine(error, 200)}`;
    }
    return `started task ${result.taskId} in conversation ${result.conversationId}`;
  }

  /** Tests: forget the tickets started recently. */
  reset(): void {
    this.started.clear();
  }
}
