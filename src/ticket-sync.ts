import type { Config, JiraProjectAutomation } from "./config.js";
import { type JiraTicketClient, jiraClientFor } from "./jira.js";
import { MondayClient } from "./monday.js";
import type { Store } from "./store.js";
import { addEvent, currentPhase, plainLine, readTimeline, timelineKey } from "./task-events.js";
import { type Task, type TaskTicket, isWebTask } from "./tasks.js";

/**
 * The ticket follows its repo task: a monday.com item (see
 * monday-automation.ts for how one starts a task) or a Jira issue (see
 * jira-automation.ts). The worker calls these at the task's milestones, and
 * the code hosts' webhooks when the pull request is merged or closed. Each
 * one sets the ticket's status for that milestone (the board's label or the
 * project's status; an empty one leaves it alone), posts an update or comment
 * signed by Pointer, and records a `ticket` event on the task's timeline.
 * None of them ever throws: a ticket that cannot be updated must not fail the
 * task. Texts are redacted; logs carry ids and outcomes only, never ticket
 * text.
 */

/** monday.com, as ticket sync uses it. */
export type TicketClient = Pick<MondayClient, "addUpdate" | "setStatusLabel">;

/** The milestone statuses a ticket can be set to: the board labels (MondayBoardAutomation), which Jira projects name …Status. */
export type TicketLabel = "workingLabel" | "reviewLabel" | "doneLabel" | "stuckLabel";

const JIRA_STATUS: Record<TicketLabel, keyof JiraProjectAutomation> = {
  workingLabel: "workingStatus",
  reviewLabel: "reviewStatus",
  doneLabel: "doneStatus",
  stuckLabel: "stuckStatus",
};

/** One ticket in its tracker: what ticket sync does to it. */
interface TicketTracker {
  /** What a posted text is called there: "update" or "comment". */
  post: string;
  /** The status a milestone sets; "" leaves it alone (none set, or the board or project is no longer automated). */
  statusFor(label: TicketLabel): string;
  /** Checked before anything is written; throws (a short, plain reason) when the ticket must be left alone. */
  ready?(): Promise<void>;
  setStatus(status: string): Promise<void>;
  addComment(text: string): Promise<void>;
}

/** A monday.com item: the board's status column and an update. */
function mondayTracker(config: Config, client: TicketClient | undefined, ticket: TaskTicket): TicketTracker | undefined {
  if (!client) return undefined;
  const board = config.monday.automation.boards[ticket.boardId];
  return {
    post: "update",
    statusFor: (label) => (board ? board[label].trim() : ""),
    setStatus: async (label) => {
      await client.setStatusLabel({ boardId: ticket.boardId, itemId: ticket.itemId, columnId: board!.statusColumnId, label });
    },
    addComment: async (text) => {
      await client.addUpdate(ticket.itemId, text);
    },
  };
}

/**
 * A Jira issue: moved through its workflow by status name, and a comment.
 * Jira answers the old key of a moved issue, so the issue's project is read
 * first and must still be one Pointer may use.
 */
function jiraTracker(config: Config, client: JiraTicketClient | undefined, ticket: TaskTicket): TicketTracker | undefined {
  if (!client) return undefined;
  const project = config.jira.automation.projects[ticket.boardId];
  let key = ticket.itemId;
  return {
    post: "comment",
    statusFor: (label) => (project ? project[JIRA_STATUS[label]].trim() : ""),
    ready: async () => {
      const where = await client.issueProject(ticket.itemId);
      const allowed = config.jira.allowedProjectKeys;
      if (allowed.length > 0 && !allowed.includes(where.projectKey)) {
        throw new Error(`the issue is now in project ${where.projectKey}, which ${config.team.pointer.name} may not use`);
      }
      key = where.key;
    },
    setStatus: async (status) => {
      await client.transitionTo(key, status);
    },
    addComment: async (text) => {
      await client.addComment(key, text);
    },
  };
}

/** What a ticket update adds to the task's timeline. */
export interface TicketEvent {
  kind: "ticket";
  text: string;
  ok: boolean;
  url?: string;
}

export interface TicketSyncDeps {
  /** The trackers' credentials, the automated boards' labels and projects' statuses, and Pointer's name. */
  config: Config;
  /** monday.com tickets: defaults to a client for the configured token; none = monday.com is not connected. */
  client?: TicketClient;
  /** Jira tickets: defaults to a client for the configured site; none = Jira is not connected. */
  jira?: JiraTicketClient;
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

/** The ticket's tracker with a client from the deps or the config; undefined when that tracker is not connected. */
function trackerFor(deps: TicketSyncDeps, ticket: TaskTicket): TicketTracker | undefined {
  if (ticket.provider === "jira") return jiraTracker(deps.config, deps.jira ?? jiraClientFor(deps.config), ticket);
  const token = deps.config.monday.token;
  return mondayTracker(deps.config, deps.client ?? (token ? new MondayClient(token) : undefined), ticket);
}

/**
 * Sets the status (when the board or project has one for the milestone) and
 * posts the update or comment on one ticket, then records what happened.
 * Never throws.
 */
export async function updateTicket(
  deps: TicketSyncDeps,
  ticket: TaskTicket,
  change: { label?: TicketLabel; text: string; what: string },
): Promise<{ ok: boolean }> {
  const redact = deps.redact ?? ((text: string) => text);
  const jira = ticket.provider === "jira";
  const ref = jira ? `issue ${ticket.itemId}` : `item ${ticket.itemId}`;
  const name = ticket.name ? `"${plainLine(ticket.name, 80)}"` : ref;
  try {
    const tracker = trackerFor(deps, ticket);
    if (!tracker) {
      const tool = jira ? "Jira" : "monday.com";
      await record(deps, { text: `Ticket ${name} not updated: ${tool} is not connected`, ok: false });
      console.log(`[ticket] ${ref}: ${change.what}: skipped, ${tool} is not connected`);
      return { ok: false };
    }
    try {
      await tracker.ready?.();
    } catch (err) {
      const why = plainLine(redact(errorText(err)), 160);
      await record(deps, { text: `Ticket ${name} not updated: ${why}`, ok: false, ...(ticket.url ? { url: ticket.url } : {}) });
      console.log(`[ticket] ${ref}: ${change.what}: skipped, ${why}`);
      return { ok: false };
    }
    const status = change.label ? tracker.statusFor(change.label) : "";
    const done: string[] = [];
    let ok = true;
    if (status) {
      try {
        await tracker.setStatus(status);
        done.push(`status set to "${status}"`);
      } catch (err) {
        ok = false;
        done.push(`status not set (${plainLine(redact(errorText(err)), 160)})`);
      }
    }
    try {
      await tracker.addComment(redact(signedUpdate(change.text, deps.config.team.pointer.name)));
      done.push(`${tracker.post} posted`);
    } catch (err) {
      ok = false;
      done.push(`${tracker.post} not posted (${plainLine(redact(errorText(err)), 160)})`);
    }
    await record(deps, { text: `Ticket ${name}: ${done.join("; ")}`, ok, ...(ticket.url ? { url: ticket.url } : {}) });
    console.log(`[ticket] ${ref}: ${change.what}: ${ok ? "updated" : "not fully updated"}`);
    return { ok };
  } catch (err) {
    console.error(`[ticket] ${ref}: ${change.what} failed:`, plainLine(redact(errorText(err)), 200));
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
