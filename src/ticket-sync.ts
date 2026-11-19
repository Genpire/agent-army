import type { Config } from "./config.js";
import { MondayClient } from "./monday.js";
import type { Store } from "./store.js";
import { addEvent, currentPhase, plainLine, readTimeline, timelineKey } from "./task-events.js";
import { type Task, type TaskTicket, isWebTask } from "./tasks.js";

/**
 * The monday.com ticket follows its repo task (see monday-automation.ts for
 * how a ticket starts one): the worker calls these at the task's milestones,
 * and the GitHub webhook when the pull request is merged or closed. Each one
 * sets the ticket's status to the board's label for that milestone (an empty
 * label leaves it alone), posts an update signed by Pointer, and records a
 * `ticket` event on the task's timeline. None of them ever throws: a ticket
 * that cannot be updated must not fail the task. Update texts are redacted;
 * logs carry ids and outcomes only, never ticket text.
 */

export type TicketClient = Pick<MondayClient, "addUpdate" | "setStatusLabel">;

/** The board labels a milestone can set (MondayBoardAutomation). */
export type TicketLabel = "workingLabel" | "reviewLabel" | "doneLabel" | "stuckLabel";

/** What a ticket update adds to the task's timeline. */
export interface TicketEvent {
  kind: "ticket";
  text: string;
  ok: boolean;
  url?: string;
}

export interface TicketSyncDeps {
  /** The monday.com token, the automated boards' labels and Pointer's name. */
  config: Config;
  /** Defaults to a client for the configured token; none = monday.com is not connected. */
  client?: TicketClient;
  /** Adds the outcome to the task's timeline (the worker's recorder, or the stored timeline after the task). */
  record?: (e: TicketEvent) => void | Promise<void>;
  redact?: (text: string) => string;
  /** The task's conversation in the admin console, linked from the updates. */
  consoleUrl?: string;
}

/** Longest update posted on a ticket (monday.com update bodies are HTML; this is the plain text before escaping). */
export const TICKET_UPDATE_MAX_CHARS = 4000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** The update as posted: the text, then Pointer's signature, so people on the board know who wrote it. */
export function signedUpdate(text: string, pointerName: string): string {
  return `${clip(text.trim(), TICKET_UPDATE_MAX_CHARS)}\n\n— ${pointerName} (Agent Army)`;
}

async function record(deps: TicketSyncDeps, e: Omit<TicketEvent, "kind">): Promise<void> {
  try {
    await deps.record?.({ kind: "ticket", ...e });
  } catch (err) {
    console.error("[ticket] timeline event not saved:", (err as NodeJS.ErrnoException | undefined)?.code ?? "error");
  }
}

/**
 * Sets the label (when the board has one for it) and posts the update on one
 * ticket, then records what happened. Never throws.
 */
export async function updateTicket(
  deps: TicketSyncDeps,
  ticket: TaskTicket,
  change: { label?: TicketLabel; text: string; what: string },
): Promise<{ ok: boolean }> {
  const redact = deps.redact ?? ((text: string) => text);
  const name = ticket.name ? `"${plainLine(ticket.name, 80)}"` : `item ${ticket.itemId}`;
  try {
    const token = deps.config.monday.token;
    const client = deps.client ?? (token ? new MondayClient(token) : undefined);
    if (!client) {
      await record(deps, { text: `Ticket ${name} not updated: monday.com is not connected`, ok: false });
      console.log(`[ticket] item ${ticket.itemId}: ${change.what}: skipped, monday.com is not connected`);
      return { ok: false };
    }
    const board = deps.config.monday.automation.boards[ticket.boardId];
    const label = change.label && board ? board[change.label].trim() : "";
    const done: string[] = [];
    let ok = true;
    if (board && label) {
      try {
        await client.setStatusLabel({ boardId: ticket.boardId, itemId: ticket.itemId, columnId: board.statusColumnId, label });
        done.push(`status set to "${label}"`);
      } catch (err) {
        ok = false;
        done.push(`status not set (${plainLine(redact(errorText(err)), 160)})`);
      }
    }
    try {
      await client.addUpdate(ticket.itemId, redact(signedUpdate(change.text, deps.config.team.pointer.name)));
      done.push("update posted");
    } catch (err) {
      ok = false;
      done.push(`update not posted (${plainLine(redact(errorText(err)), 160)})`);
    }
    await record(deps, { text: `Ticket ${name}: ${done.join("; ")}`, ok, ...(ticket.url ? { url: ticket.url } : {}) });
    console.log(`[ticket] item ${ticket.itemId}: ${change.what}: ${ok ? "updated" : "not fully updated"}`);
    return { ok };
  } catch (err) {
    console.error(`[ticket] item ${ticket.itemId}: ${change.what} failed:`, plainLine(redact(errorText(err)), 200));
    return { ok: false };
  }
}

const followLine = (deps: TicketSyncDeps, verb: string) => (deps.consoleUrl ? `\n${verb}: ${deps.consoleUrl}` : "");

/** The task started: "working" label, and a link to follow it in the console. */
export async function ticketStarted(deps: TicketSyncDeps, task: Task): Promise<void> {
  if (!task.ticket) return;
  const text = deps.consoleUrl ? `The team started on this: ${deps.consoleUrl}` : `The team started on this in ${task.repo}.`;
  await updateTicket(deps, task.ticket, { label: "workingLabel", text, what: "started" });
}

/** The pull request was opened (or a follow-up updated it): "review" label and its link. */
export async function ticketPrOpened(
  deps: TicketSyncDeps,
  task: Task,
  pr: { url: string; number: number; title?: string; updated?: boolean },
): Promise<void> {
  if (!task.ticket) return;
  const head = pr.updated ? `Updated pull request #${pr.number}, ready for review: ${pr.url}` : `Opened pull request #${pr.number} for review: ${pr.url}`;
  const text = `${head}${pr.title ? `\n${pr.title}` : ""}`;
  await updateTicket(deps, task.ticket, { label: "reviewLabel", text, what: pr.updated ? "pull request updated" : "pull request opened" });
}

/** The task stopped early or failed: "stuck" label, why, and the draft pull request that keeps the work. */
export async function ticketStopped(deps: TicketSyncDeps, task: Task, stop: { reason: string; prUrl?: string; draft?: boolean }): Promise<void> {
  if (!task.ticket) return;
  const lines = [`The team stopped: ${stop.reason}`];
  if (stop.prUrl) lines.push(`The unfinished work is in ${stop.draft ? "a draft" : "the"} pull request: ${stop.prUrl}`);
  const text = `${lines.join("\n")}${followLine(deps, "To continue, reply in its conversation")}`;
  await updateTicket(deps, task.ticket, { label: "stuckLabel", text, what: "stopped" });
}

/**
 * The task finished. Blocked: "stuck" label and why. An answer (no code
 * change): the answer, with the "review" label so a person reads it. A change
 * was already reported when its pull request opened.
 */
export async function ticketFinished(deps: TicketSyncDeps, task: Task): Promise<void> {
  if (!task.ticket) return;
  const title = task.report?.title ?? "";
  const summary = task.report?.summary ?? task.summary ?? "";
  if (task.kind === "blocked") {
    const text = `Blocked${title ? `: ${title}` : ""}${summary ? `\n\n${summary}` : ""}${followLine(deps, "Details")}`;
    await updateTicket(deps, task.ticket, { label: "stuckLabel", text, what: "blocked" });
  } else if (task.kind === "answer") {
    const text = `${title || "The team's answer"}${summary ? `\n\n${summary}` : ""}${followLine(deps, "Details")}`;
    await updateTicket(deps, task.ticket, { label: "reviewLabel", text, what: "answered" });
  }
}

/** The team's pull request was merged ("done" label) or closed without merging (an update only). */
export async function ticketPrClosed(deps: TicketSyncDeps, task: Task, pr: { url: string; merged: boolean }): Promise<void> {
  if (!task.ticket) return;
  if (pr.merged) await updateTicket(deps, task.ticket, { label: "doneLabel", text: `Merged: ${pr.url}`, what: "merged" });
  else await updateTicket(deps, task.ticket, { text: `The pull request was closed without merging: ${pr.url}`, what: "closed" });
}

// ---------- The console link ----------

/**
 * The console's address, for links in ticket updates. The worker has no
 * request to read it from (and Cloud Run jobs get no PUBLIC_URL), so the web
 * service keeps the address its automation settings were saved from.
 */
export const CONSOLE_URL_KEY = "monday/console-url.json";

const URL_RE = /^https?:\/\/[^\s/?#]+(?::\d+)?(?:\/[^\s?#]*)?$/;

/** Saves the console's base URL when it changed. Never throws. */
export async function rememberConsoleUrl(store: Pick<Store, "get" | "put">, url: string): Promise<void> {
  const base = url.replace(/\/+$/, "");
  if (!URL_RE.test(base)) return;
  try {
    const saved = await store.get(CONSOLE_URL_KEY);
    if (saved && (JSON.parse(saved.toString("utf8")) as { url?: unknown }).url === base) return;
    await store.put(CONSOLE_URL_KEY, JSON.stringify({ url: base }));
  } catch (err) {
    console.error("[ticket] console address not saved:", (err as NodeJS.ErrnoException | undefined)?.code ?? "error");
  }
}

/** PUBLIC_URL, else the address saved by the web service; undefined when neither is known. */
export async function consoleBaseUrl(store: Pick<Store, "get">, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (fromEnv && URL_RE.test(fromEnv)) return fromEnv;
  try {
    const saved = await store.get(CONSOLE_URL_KEY);
    const url = saved ? (JSON.parse(saved.toString("utf8")) as { url?: unknown }).url : undefined;
    return typeof url === "string" && URL_RE.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The task's conversation in the console (`#/chat/<id>`); undefined for Slack tasks. */
export function conversationLink(base: string | undefined, task: Pick<Task, "channel" | "threadTs">): string | undefined {
  if (!base || !isWebTask(task)) return undefined;
  return `${base}/#/chat/${encodeURIComponent(task.threadTs)}`;
}

/** The worker's ticket sync for one task (the console link is looked up only when the task has a ticket). Never throws. */
export async function ticketSyncDeps(o: {
  store: Pick<Store, "get">;
  config: Config;
  task: Task;
  redact?: (text: string) => string;
  record?: TicketSyncDeps["record"];
  env?: NodeJS.ProcessEnv;
}): Promise<TicketSyncDeps> {
  const deps: TicketSyncDeps = { config: o.config, ...(o.redact ? { redact: o.redact } : {}), ...(o.record ? { record: o.record } : {}) };
  if (!o.task.ticket) return deps;
  const consoleUrl = conversationLink(await consoleBaseUrl(o.store, o.env), o.task);
  return consoleUrl ? { ...deps, consoleUrl } : deps;
}

/**
 * Adds a ticket event to a finished task's stored timeline (the worker, its
 * only writer while it runs, is gone). Does nothing for a task without one.
 */
export async function appendTicketEvent(store: Pick<Store, "get" | "put">, taskId: string, e: TicketEvent, now = new Date()): Promise<void> {
  const timeline = await readTimeline(store, taskId);
  if (!timeline) return;
  addEvent(timeline, { at: now.toISOString(), phase: currentPhase(timeline), kind: e.kind, text: plainLine(e.text), ok: e.ok, ...(e.url ? { url: e.url } : {}) });
  timeline.updatedAt = now.toISOString();
  await store.put(timelineKey(taskId), JSON.stringify(timeline));
}
