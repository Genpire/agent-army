import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, ConfigRepo, ConfigSchema } from "../src/core/config.js";
import { deriveKey } from "../src/core/crypto.js";
import { FsStore } from "../src/core/store.js";
import { TimelineRecorder, readTimeline } from "../src/task-events.js";
import { type Task, TaskRepo, WEB_CHANNEL, newTaskId } from "../src/tasks.js";
import {
  type TicketClient,
  type TicketEvent,
  type TicketSyncDeps,
  appendTicketEvent,
  consoleBaseUrl,
  conversationLink,
  rememberConsoleUrl,
  signedUpdate,
  ticketFinished,
  ticketPrClosed,
  ticketPrOpened,
  ticketStarted,
  ticketStopped,
  ticketSyncDeps,
} from "../src/ticket-sync.js";
import { textToAdf } from "../src/jira.js";
import { handleGithubWebhook, handlePrClosed, resetWebhookStateForTests } from "../src/webhook.js";
import { configSecrets, makeRedactor } from "../src/worker.js";

const BOARD = "4012345678";
const ITEM = "9001";
const CONSOLE = "https://army.example.com/#/chat/c-000000001-abcdef";
const MONDAY_TOKEN = "monday-secret-token-0123456789";

function config(configure?: (c: Config) => void): Config {
  const c = ConfigSchema.parse({});
  c.monday.token = MONDAY_TOKEN;
  c.monday.automation = {
    enabled: true,
    webhookSecret: "monday-webhook-secret-0123456789",
    boards: {
      [BOARD]: {
        repo: "acme/web",
        statusColumnId: "status",
        startLabel: "Ready for dev",
        workingLabel: "Working on it",
        reviewLabel: "In review",
        doneLabel: "Done",
        stuckLabel: "Stuck",
      },
    },
  };
  configure?.(c);
  return c;
}

function task(over: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: newTaskId(),
    createdAt: now,
    updatedAt: now,
    status: "running",
    repo: "acme/web",
    channel: WEB_CHANNEL,
    threadTs: "c-000000001-abcdef",
    userId: "admin",
    instruction: "Work on this monday.com ticket: Login redirect",
    trigger: "monday",
    ticket: { boardId: BOARD, itemId: ITEM, name: "Login redirect", url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}` },
    ...over,
  };
}

interface Call {
  op: "status" | "update";
  itemId: string;
  label?: string;
  columnId?: string;
  body?: string;
}

function fakeClient(fail: { status?: Error; update?: Error } = {}) {
  const calls: Call[] = [];
  const client: TicketClient = {
    setStatusLabel: async ({ itemId, columnId, label }) => {
      if (fail.status) throw fail.status;
      calls.push({ op: "status", itemId, columnId, label });
      return { id: itemId };
    },
    addUpdate: async (itemId, body) => {
      if (fail.update) throw fail.update;
      calls.push({ op: "update", itemId, body });
      return { id: "u1" };
    },
  };
  return { client, calls };
}

function deps(c: Config, client: TicketClient, extra: Partial<TicketSyncDeps> = {}) {
  const events: TicketEvent[] = [];
  const d: TicketSyncDeps = { config: c, client, record: (e) => void events.push(e), redact: makeRedactor(configSecrets(c)), consoleUrl: CONSOLE, ...extra };
  return { d, events };
}

const SIGNATURE = "\n\n— Pointer (Agent Army)";

describe("ticket sync milestones", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts: sets the working label and links the console conversation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d, events } = deps(config(), client);
    await ticketStarted(d, task());
    expect(calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "Working on it" },
      { op: "update", itemId: ITEM, body: `The team started on this: ${CONSOLE}${SIGNATURE}` },
    ]);
    expect(events).toEqual([
      { kind: "ticket", ok: true, text: 'Ticket "Login redirect": status set to "Working on it"; update posted', url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}` },
    ]);
  });

  it("opens the pull request: review label and its link; an update of it says so", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d } = deps(config(), client);
    await ticketPrOpened(d, task(), { url: "https://github.com/acme/web/pull/7", number: 7, title: "Return to the page after sign-in" });
    await ticketPrOpened(d, task(), { url: "https://github.com/acme/web/pull/7", number: 7, updated: true });
    expect(calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "In review" },
      { op: "update", itemId: ITEM, body: `Opened pull request #7 for review: https://github.com/acme/web/pull/7\nReturn to the page after sign-in${SIGNATURE}` },
      { op: "status", itemId: ITEM, columnId: "status", label: "In review" },
      { op: "update", itemId: ITEM, body: `Updated pull request #7, ready for review: https://github.com/acme/web/pull/7${SIGNATURE}` },
    ]);
  });

  it("stops: stuck label with the reason, the draft pull request and how to continue", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d } = deps(config(), client);
    await ticketStopped(d, task(), { reason: "Timed out after 50 minutes.", prUrl: "https://github.com/acme/web/pull/8", draft: true });
    expect(calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "Stuck" },
      {
        op: "update",
        itemId: ITEM,
        body: `The team stopped: Timed out after 50 minutes.\nThe unfinished work is in a draft pull request: https://github.com/acme/web/pull/8\nTo continue, reply in its conversation: ${CONSOLE}${SIGNATURE}`,
      },
    ]);
  });

  it("finishes: blocked is stuck, an answer goes to review with its summary, a change adds nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d } = deps(config(), client, { consoleUrl: undefined });
    const report = { title: "Needs the Stripe dashboard", summary: "A human has to rotate it.", verification: "", risks: "" };
    await ticketFinished(d, task({ status: "done", kind: "blocked", report }));
    await ticketFinished(d, task({ status: "done", kind: "answer", report: { ...report, title: "Tax lives in src/api/tax.ts", summary: "12 states." } }));
    await ticketFinished(d, task({ status: "done", kind: "change", report }));
    expect(calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "Stuck" },
      { op: "update", itemId: ITEM, body: `Blocked: Needs the Stripe dashboard\n\nA human has to rotate it.${SIGNATURE}` },
      { op: "status", itemId: ITEM, columnId: "status", label: "In review" },
      { op: "update", itemId: ITEM, body: `Tax lives in src/api/tax.ts\n\n12 states.${SIGNATURE}` },
    ]);
  });

  it("merged: done label; closed without merging: an update only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d } = deps(config(), client);
    await ticketPrClosed(d, task({ status: "done" }), { url: "https://github.com/acme/web/pull/7", merged: true });
    await ticketPrClosed(d, task({ status: "done" }), { url: "https://github.com/acme/web/pull/9", merged: false });
    expect(calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "Done" },
      { op: "update", itemId: ITEM, body: `Merged: https://github.com/acme/web/pull/7${SIGNATURE}` },
      { op: "update", itemId: ITEM, body: `The pull request was closed without merging: https://github.com/acme/web/pull/9${SIGNATURE}` },
    ]);
  });

  it("leaves the status alone for an empty label, and on a board that is no longer automated", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const empty = config((c) => void (c.monday.automation.boards[BOARD]!.workingLabel = ""));
    await ticketStarted(deps(empty, client).d, task());
    const gone = config((c) => void (c.monday.automation.boards = {}));
    await ticketPrOpened(deps(gone, client).d, task(), { url: "https://github.com/acme/web/pull/7", number: 7 });
    expect(calls.map((c) => c.op)).toEqual(["update", "update"]);
  });

  it("does nothing for a task without a ticket", async () => {
    const { client, calls } = fakeClient();
    const { d, events } = deps(config(), client);
    const plain = task({ ticket: undefined, trigger: "web" });
    await ticketStarted(d, plain);
    await ticketPrOpened(d, plain, { url: "https://github.com/acme/web/pull/7", number: 7 });
    await ticketStopped(d, plain, { reason: "x" });
    await ticketFinished(d, { ...plain, kind: "answer" });
    await ticketPrClosed(d, plain, { url: "https://github.com/acme/web/pull/7", merged: true });
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("never throws: failures are recorded on the timeline, redacted", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = fakeClient({ status: new Error(`label rejected for ${MONDAY_TOKEN}`), update: new Error("rate limit") });
    const { d, events } = deps(config(), client);
    await expect(ticketStarted(d, task())).resolves.toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ ok: false, text: 'Ticket "Login redirect": status not set (label rejected for [redacted]); update not posted (rate limit)' }),
    ]);

    const throwingRecord = deps(config(), fakeClient().client, { record: () => Promise.reject(new Error("disk")) }).d;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ticketStopped(throwingRecord, task(), { reason: "x" })).resolves.toBeUndefined();
  });

  it("records that monday.com is not connected instead of calling it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const events: TicketEvent[] = [];
    const c = config((x) => void (x.monday.token = undefined));
    await ticketStarted({ config: c, record: (e) => void events.push(e) }, task());
    expect(events).toEqual([{ kind: "ticket", ok: false, text: 'Ticket "Login redirect" not updated: monday.com is not connected' }]);
  });

  it("redacts secrets from updates, signs them, and keeps them bounded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, calls } = fakeClient();
    const { d } = deps(config(), client);
    await ticketStopped(d, task(), { reason: `git push failed: ${MONDAY_TOKEN}` });
    expect(calls[1]!.body).toContain("git push failed: [redacted]");
    expect(calls[1]!.body).not.toContain(MONDAY_TOKEN);
    const long = signedUpdate("x".repeat(10_000), "Scout");
    expect(long.length).toBeLessThan(4100);
    expect(long.endsWith("— Scout (Agent Army)")).toBe(true);
  });

  it("logs ids and outcomes, never the ticket's text", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = fakeClient();
    await ticketStarted(deps(config(), client).d, task({ ticket: { boardId: BOARD, itemId: ITEM, name: "Secret launch plans" } }));
    const lines = logs.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines).toEqual([`[ticket] item ${ITEM}: started: updated`]);
  });
});

describe("the console link", () => {
  it("prefers PUBLIC_URL, else the address the web service saved", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-ticket-")));
    expect(await consoleBaseUrl(store, {})).toBeUndefined();
    await rememberConsoleUrl(store, "https://army.example.com/");
    expect(await consoleBaseUrl(store, {})).toBe("https://army.example.com");
    expect(await consoleBaseUrl(store, { PUBLIC_URL: "https://pointer.example.org/" })).toBe("https://pointer.example.org");
    await rememberConsoleUrl(store, "not a url");
    expect(await consoleBaseUrl(store, {})).toBe("https://army.example.com");

    expect(conversationLink("https://army.example.com", { channel: WEB_CHANNEL, threadTs: "c-1" })).toBe("https://army.example.com/#/chat/c-1");
    expect(conversationLink("https://army.example.com", { channel: "C123", threadTs: "1.2" })).toBeUndefined();
    expect(conversationLink(undefined, { channel: WEB_CHANNEL, threadTs: "c-1" })).toBeUndefined();

    const withTicket = await ticketSyncDeps({ store, config: config(), task: task(), env: {} });
    expect(withTicket.consoleUrl).toBe("https://army.example.com/#/chat/c-000000001-abcdef");
    const without = await ticketSyncDeps({ store, config: config(), task: task({ ticket: undefined }), env: {} });
    expect(without.consoleUrl).toBeUndefined();
  });

  it("adds a ticket event to a finished task's stored timeline", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-ticket-")));
    const rec = new TimelineRecorder(store, "t-1");
    rec.enter("clone", "Cloning");
    await rec.close(true, "Done");
    await appendTicketEvent(store, "t-1", { kind: "ticket", ok: true, text: 'Ticket "Login": status set to "Done"; update posted' });
    const timeline = await readTimeline(store, "t-1");
    expect(timeline?.events.at(-1)).toMatchObject({ kind: "ticket", ok: true, text: 'Ticket "Login": status set to "Done"; update posted' });
    // No timeline: nothing is written.
    await appendTicketEvent(store, "t-none", { kind: "ticket", ok: true, text: "x" });
    expect(await readTimeline(store, "t-none")).toBeNull();
  });
});

describe("GitHub pull request closed → ticket", () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup(seed: { ticket?: boolean; followUp?: boolean } = {}) {
    resetWebhookStateForTests();
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-merged-")));
    const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
    const base = config();
    await configRepo.update((c) => {
      c.anthropic.apiKey = "sk-ant-secret-key";
      c.github = { token: "ghp_secret_token", allowedOwners: ["acme"], extra: [], webhookSecret: "whsec-test-0123456789abcdef" };
      c.monday = base.monday;
    });
    const tasks = new TaskRepo(store);
    await tasks.savePrThread("acme/web", 7, { channel: WEB_CHANNEL, threadTs: "c-000000001-abcdef" });
    const first = task({ id: newTaskId(Date.now() - 120_000), status: "done", kind: "change", prUrl: "https://github.com/acme/web/pull/7", ...(seed.ticket === false ? { ticket: undefined } : {}) });
    await tasks.save(first);
    const rec = new TimelineRecorder(store, first.id);
    rec.enter("publish", "Publishing");
    await rec.close(true, "Done");
    if (seed.followUp) await tasks.save(task({ id: newTaskId(Date.now() - 60_000), status: "done", trigger: "review", ticket: undefined }));
    const { client, calls } = fakeClient();
    const deps = {
      configRepo,
      tasks,
      runner: { kind: "local" as const, launch: async () => undefined },
      slack: () => ({}) as never,
      store,
      monday: () => client,
    };
    return { store, deps, calls, first };
  }

  const closed = (merged: boolean, action = "closed") => ({
    action,
    pull_request: { number: 7, merged, html_url: "https://github.com/acme/web/pull/7" },
    repository: { full_name: "acme/web" },
  });

  it("sets the ticket to done when the team's pull request is merged, and notes it on the task's timeline", async () => {
    const t = await setup({ followUp: true });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGithubWebhook("pull_request", closed(true), t.deps);
    expect(t.calls).toEqual([
      { op: "status", itemId: ITEM, columnId: "status", label: "Done" },
      { op: "update", itemId: ITEM, body: `Merged: https://github.com/acme/web/pull/7${SIGNATURE}` },
    ]);
    const timeline = await readTimeline(t.store, t.first.id);
    expect(timeline?.events.at(-1)).toMatchObject({ kind: "ticket", ok: true, text: 'Ticket "Login redirect": status set to "Done"; update posted' });
    expect(logs.mock.calls.map((c) => String(c[0]))).toContain(`[github] pull_request acme/web#7: ticket ${ITEM} marked done`);
  });

  it("only posts an update when it was closed without merging", async () => {
    const t = await setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGithubWebhook("pull_request", closed(false), t.deps);
    expect(t.calls).toEqual([{ op: "update", itemId: ITEM, body: `The pull request was closed without merging: https://github.com/acme/web/pull/7${SIGNATURE}` }]);
  });

  it("ignores other actions, pull requests the team did not open, and threads without a ticket", async () => {
    const t = await setup();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGithubWebhook("pull_request", closed(true, "opened"), t.deps);
    await handleGithubWebhook("pull_request", { ...closed(true), pull_request: { number: 8, merged: true } }, t.deps);
    const noTicket = await setup({ ticket: false });
    await handleGithubWebhook("pull_request", closed(true), noTicket.deps);
    expect(t.calls).toEqual([]);
    expect(noTicket.calls).toEqual([]);
    expect(logs.mock.calls.map((c) => String(c[0]))).toEqual([
      "[github] pull_request acme/web#7: ignored: pull request not closed",
      "[github] pull_request acme/web#8: ignored: not a pull request the team opened",
      "[github] pull_request acme/web#7: ignored: no ticket",
    ]);
  });

  it("links a merge request on another host when the webhook gives no link", async () => {
    const t = await setup();
    await t.deps.configRepo.update((c) => {
      c.gitlab = { ...c.gitlab, token: "glpat-secret-token-0123456789", baseUrl: "https://gitlab.example.com", allowed: ["acme"] };
    });
    await t.deps.tasks.savePrThread("gitlab:acme/web", 12, { channel: WEB_CHANNEL, threadTs: "c-000000001-abcdef" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await handlePrClosed("merge_request", { repo: "gitlab:acme/web", prNumber: 12, merged: true }, t.deps);
    expect(t.calls.at(-1)).toEqual({ op: "update", itemId: ITEM, body: `Merged: https://gitlab.example.com/acme/web/-/merge_requests/12${SIGNATURE}` });
  });
});

// ---------- Jira issues ----------

const JIRA_SITE = "https://acme.atlassian.net";
const JIRA_TOKEN = "ATATT3x-jira-secret-token-0123456789";
const ISSUE = "ACME-123";

function jiraConfig(configure?: (c: Config) => void): Config {
  return config((c) => {
    c.jira = {
      ...c.jira,
      siteUrl: JIRA_SITE,
      email: "bot@example.com",
      token: JIRA_TOKEN,
      automation: {
        enabled: true,
        webhookSecret: "jira-webhook-secret-0123456789",
        projects: {
          ACME: { repo: "acme/web", startStatus: "Ready for dev", workingStatus: "In Progress", reviewStatus: "In Review", doneStatus: "Done", stuckStatus: "Blocked" },
        },
      },
    };
    configure?.(c);
  });
}

const jiraTask = (over: Partial<Task> = {}) =>
  task({ trigger: "jira", ticket: { provider: "jira", boardId: "ACME", itemId: ISSUE, name: "Login redirect", url: `${JIRA_SITE}/browse/${ISSUE}` }, ...over });

function fakeJira(where: { key: string; projectKey: string } = { key: ISSUE, projectKey: "ACME" }) {
  const calls: { op: "move" | "comment"; key: string; status?: string; text?: string }[] = [];
  const jira = {
    issueProject: async () => where,
    transitionTo: async (key: string, status: string) => {
      calls.push({ op: "move", key, status });
      return { status, changed: true };
    },
    addComment: async (key: string, text: string) => {
      calls.push({ op: "comment", key, text });
      return { id: "1" };
    },
  };
  return { jira, calls };
}

describe("ticket sync for Jira issues", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("moves the issue through the project's statuses and comments, signed", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const { jira, calls } = fakeJira();
    const events: TicketEvent[] = [];
    const d: TicketSyncDeps = { config: jiraConfig(), jira, record: (e) => void events.push(e), consoleUrl: CONSOLE };
    await ticketStarted(d, jiraTask());
    await ticketPrOpened(d, jiraTask(), { url: "https://github.com/acme/web/pull/7", number: 7 });
    await ticketStopped(d, jiraTask(), { reason: "Timed out." });
    await ticketPrClosed(d, jiraTask({ status: "done" }), { url: "https://github.com/acme/web/pull/7", merged: true });
    expect(calls).toEqual([
      { op: "move", key: ISSUE, status: "In Progress" },
      { op: "comment", key: ISSUE, text: `The team started on this: ${CONSOLE}${SIGNATURE}` },
      { op: "move", key: ISSUE, status: "In Review" },
      { op: "comment", key: ISSUE, text: `Opened pull request #7 for review: https://github.com/acme/web/pull/7${SIGNATURE}` },
      { op: "move", key: ISSUE, status: "Blocked" },
      { op: "comment", key: ISSUE, text: `The team stopped: Timed out.\nTo continue, reply in its conversation: ${CONSOLE}${SIGNATURE}` },
      { op: "move", key: ISSUE, status: "Done" },
      { op: "comment", key: ISSUE, text: `Merged: https://github.com/acme/web/pull/7${SIGNATURE}` },
    ]);
    expect(events[0]).toEqual({ kind: "ticket", ok: true, text: 'Ticket "Login redirect": status set to "In Progress"; comment posted', url: `${JIRA_SITE}/browse/${ISSUE}` });
    expect(logs.mock.calls.map((c) => String(c[0]))[0]).toBe(`[ticket] issue ${ISSUE}: started: updated`);
  });

  it("leaves the status alone for an empty status or a project no longer automated, and says when Jira is not connected", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { jira, calls } = fakeJira();
    await ticketStarted({ config: jiraConfig((c) => void (c.jira.automation.projects.ACME!.workingStatus = "")), jira }, jiraTask());
    await ticketStarted({ config: jiraConfig((c) => void (c.jira.automation.projects = {})), jira }, jiraTask());
    expect(calls.map((c) => c.op)).toEqual(["comment", "comment"]);

    const events: TicketEvent[] = [];
    await ticketStarted({ config: jiraConfig((c) => void (c.jira.token = undefined)), record: (e) => void events.push(e) }, jiraTask());
    expect(events).toEqual([{ kind: "ticket", ok: false, text: 'Ticket "Login redirect" not updated: Jira is not connected' }]);
  });

  it("leaves an issue alone once it moved to a project Pointer may not use, and follows a move within allowed ones", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const moved = fakeJira({ key: "OTHER-9", projectKey: "OTHER" });
    const events: TicketEvent[] = [];
    const scoped = jiraConfig((c) => void (c.jira.allowedProjectKeys = ["ACME"]));
    await ticketStarted({ config: scoped, jira: moved.jira, record: (e) => void events.push(e) }, jiraTask());
    expect(moved.calls).toEqual([]);
    expect(events).toEqual([
      { kind: "ticket", ok: false, text: 'Ticket "Login redirect" not updated: the issue is now in project OTHER, which Pointer may not use', url: `${JIRA_SITE}/browse/${ISSUE}` },
    ]);
    expect(logs.mock.calls.map((c) => String(c[0]))).toContain(`[ticket] issue ${ISSUE}: started: skipped, the issue is now in project OTHER, which Pointer may not use`);

    // With every project allowed, the issue is updated under its new key.
    const renamed = fakeJira({ key: "WEB-4", projectKey: "WEB" });
    await ticketStarted({ config: jiraConfig(), jira: renamed.jira }, jiraTask());
    expect(renamed.calls.map((c) => c.key)).toEqual(["WEB-4", "WEB-4"]);
  });

  it("uses Jira's REST API from the configuration: the transition to the status, and the comment in ADF", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.pathname === `/rest/api/3/issue/${ISSUE}`) return Response.json({ key: ISSUE, fields: { project: { key: "ACME" } } });
      if (url.pathname.endsWith("/transitions") && init?.method === "GET") {
        return Response.json({ transitions: [{ id: "11", name: "Start", to: { name: "In Progress" } }] });
      }
      if (url.pathname.endsWith("/transitions")) return new Response(null, { status: 204 });
      return Response.json({ id: "100" }, { status: 201 });
    });
    const events: TicketEvent[] = [];
    await ticketStarted({ config: jiraConfig(), record: (e) => void events.push(e), consoleUrl: CONSOLE }, jiraTask());
    expect(requests).toEqual([
      { method: "GET", path: `/rest/api/3/issue/${ISSUE}` },
      { method: "GET", path: `/rest/api/3/issue/${ISSUE}/transitions` },
      { method: "POST", path: `/rest/api/3/issue/${ISSUE}/transitions`, body: { transition: { id: "11" } } },
      { method: "POST", path: `/rest/api/3/issue/${ISSUE}/comment`, body: { body: textToAdf(`The team started on this: ${CONSOLE}${SIGNATURE}`) } },
    ]);
    expect(events[0]!.ok).toBe(true);
  });

  it("moves the issue to done when the team's pull request is merged", async () => {
    resetWebhookStateForTests();
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-jira-merged-")));
    const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
    const base = jiraConfig();
    await configRepo.update((c) => {
      c.github = { token: "ghp_secret_token", allowedOwners: ["acme"], extra: [], webhookSecret: "whsec-test-0123456789abcdef" };
      c.jira = base.jira;
    });
    const tasks = new TaskRepo(store);
    await tasks.savePrThread("acme/web", 7, { channel: WEB_CHANNEL, threadTs: "c-000000001-abcdef" });
    await tasks.save(jiraTask({ status: "done", kind: "change", prUrl: "https://github.com/acme/web/pull/7" }));
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === `/rest/api/3/issue/${ISSUE}`) return Response.json({ key: ISSUE, fields: { project: { key: "ACME" } } });
      if (url.pathname.endsWith("/transitions") && init?.method === "GET") return Response.json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
      if (url.pathname.endsWith("/transitions")) return new Response(null, { status: 204 });
      return Response.json({ id: "100" }, { status: 201 });
    });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = { configRepo, tasks, runner: { kind: "local" as const, launch: async () => undefined }, slack: () => ({}) as never, store };
    await handleGithubWebhook("pull_request", { action: "closed", pull_request: { number: 7, merged: true, html_url: "https://github.com/acme/web/pull/7" }, repository: { full_name: "acme/web" } }, deps);
    expect(requests).toEqual([
      `GET /rest/api/3/issue/${ISSUE}`,
      `GET /rest/api/3/issue/${ISSUE}/transitions`,
      `POST /rest/api/3/issue/${ISSUE}/transitions`,
      `POST /rest/api/3/issue/${ISSUE}/comment`,
    ]);
    expect(logs.mock.calls.map((c) => String(c[0]))).toContain(`[github] pull_request acme/web#7: ticket ${ISSUE} marked done`);

    // Jira disconnected: nothing is called.
    await configRepo.update((c) => void (c.jira.token = undefined));
    requests.length = 0;
    await handleGithubWebhook("pull_request", { action: "closed", pull_request: { number: 7, merged: true }, repository: { full_name: "acme/web" } }, deps);
    expect(requests).toEqual([]);
    expect(logs.mock.calls.map((c) => String(c[0]))).toContain("[github] pull_request acme/web#7: ignored: Jira not connected");
  });
});
