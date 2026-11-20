import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Config, ConfigSchema, type MondayBoardAutomation } from "../src/config.js";
import type { DirectTaskResult } from "../src/conversations.js";
import { FsStore } from "../src/store.js";
import { MONDAY_API_URL, type MondayItemDetails } from "../src/monday.js";
import {
  type AutomationClient,
  INSTRUCTION_MAX_CHARS,
  START_COOLDOWN_MS,
  TicketAutomation,
  checkBoardAutomation,
  connectWebhooks,
  labelConflict,
  removeWebhook,
  ticketInstruction,
  ticketTrigger,
  webhookChallenge,
  webhookIds,
} from "../src/monday-automation.js";
import { createApp } from "../src/server.js";
import type { Task, TaskTicket } from "../src/tasks.js";

const BOARD = "4012345678";
const ITEM = "9001";

const AUTOMATION: MondayBoardAutomation = {
  repo: "acme/web",
  statusColumnId: "status",
  startLabel: "Ready for dev",
  workingLabel: "Working on it",
  reviewLabel: "In review",
  doneLabel: "Done",
  stuckLabel: "Stuck",
};

function config(configure?: (c: Config) => void): Config {
  const c = ConfigSchema.parse({});
  c.monday.token = "monday-secret-token-0123456789";
  c.monday.automation = { enabled: true, webhookSecret: "w".repeat(32), boards: { [BOARD]: { ...AUTOMATION } } };
  configure?.(c);
  return c;
}

function item(status: string, over: Partial<MondayItemDetails> = {}): MondayItemDetails {
  return {
    id: ITEM,
    name: "Login redirect goes to /",
    url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}`,
    state: "active",
    board: { id: BOARD, name: "Web bugs" },
    group: { id: "topics", title: "This sprint" },
    columns: [
      { id: "status", title: "Status", type: "status", text: status },
      { id: "priority", title: "Priority", type: "status", text: "High" },
    ],
    updates: [
      { id: "u3", createdAt: "2026-11-18T10:00:00Z", author: "Sam", text: "Also on mobile.", assets: [], replies: [] },
      { id: "u1", createdAt: "2026-11-17T09:00:00Z", author: "Dana", text: "After signing in, people land on / instead of the page they came from.", assets: [], replies: [] },
    ],
    assets: [{ id: "a1", name: "login.png" }],
    ...over,
  };
}

// ---------- pure parts ----------

describe("the webhook payload", () => {
  it("reads only the challenge, or the board and item ids", () => {
    expect(webhookChallenge({ challenge: "abc123" })).toBe("abc123");
    expect(webhookChallenge({ challenge: 5 })).toBeUndefined();
    expect(webhookChallenge({ challenge: "x".repeat(1001) })).toBeUndefined();
    expect(webhookChallenge(null)).toBeUndefined();

    const event = { event: { boardId: 4012345678, pulseId: 9001, columnId: "status", value: { label: { text: "Ready for dev" } } } };
    expect(webhookIds(event)).toEqual({ boardId: BOARD, itemId: ITEM });
    expect(webhookIds({ event: { boardId: "4012345678", pulseId: "9001" } })).toEqual({ boardId: BOARD, itemId: ITEM });
    for (const bad of [{}, { event: {} }, { event: { boardId: "abc", pulseId: 1 } }, { event: { boardId: -1, pulseId: 1 } }, "x"]) {
      expect(webhookIds(bad)).toBeUndefined();
    }
  });
});

describe("ticketTrigger", () => {
  it("starts when the item, read again, has the start label now", () => {
    expect(ticketTrigger(config(), BOARD, item("Ready for dev"))).toEqual({
      start: true,
      board: AUTOMATION,
      ticket: { boardId: BOARD, itemId: ITEM, name: "Login redirect goes to /", url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}` },
    });
    // Labels compare without case and spaces.
    expect(ticketTrigger(config(), BOARD, item(" ready for DEV ")).start).toBe(true);
  });

  it("does not start for another label, another board, an archived item or with the automation off", () => {
    const reason = (c: Config, i: MondayItemDetails, board = BOARD) => {
      const d = ticketTrigger(c, board, i);
      return d.start ? "start" : d.reason;
    };
    expect(reason(config(), item("Working on it"))).toBe("status is not the start label");
    expect(reason(config(), item("Ready for dev", { columns: [] }))).toBe("status is not the start label");
    expect(reason(config(), item("Ready for dev"), "111")).toBe("board not automated");
    expect(reason(config(), item("Ready for dev", { board: { id: "222", name: "Other" } }))).toBe("item is not on that board");
    expect(reason(config(), item("Ready for dev", { state: "archived" }))).toBe("item is archived or deleted");
    expect(reason(config((c) => void (c.monday.automation.enabled = false)), item("Ready for dev"))).toBe("automation is off");
    expect(reason(config((c) => void (c.monday.allowedBoardIds = ["111"])), item("Ready for dev"))).toBe("board is not one Pointer may use");
  });
});

describe("ticketInstruction", () => {
  it("has the name, where it is, the columns, the description first and the files", () => {
    const text = ticketInstruction(item("Ready for dev"));
    expect(text).toBe(
      [
        "Work on this monday.com ticket: Login redirect goes to /",
        `(board "Web bugs", group "This sprint", item ${ITEM})`,
        `Link: https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}`,
        "",
        "Description and first updates (oldest first):",
        "",
        "Dana, 2026-11-17:\nAfter signing in, people land on / instead of the page they came from.",
        "",
        "Sam, 2026-11-18:\nAlso on mobile.",
        "",
        "Columns:\n- Status: Ready for dev\n- Priority: High",
        "",
        "Files on the ticket (1): login.png. They are not attached to this task; Pointer can attach them in this conversation with its monday.com tools.",
      ].join("\n"),
    );
  });

  it("stays within the limit, cutting updates first", () => {
    const updates = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, text: `${i} ${"word ".repeat(600)}`, assets: [], replies: [] }));
    const text = ticketInstruction(item("Ready for dev", { updates }));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_MAX_CHARS);
    expect(text).toContain("Columns:");
    expect(text).toContain("Files on the ticket");
    expect(ticketInstruction(item("Ready for dev", { name: "x".repeat(10_000) }), 500).length).toBeLessThanOrEqual(500);
  });
});

describe("board settings", () => {
  const board = {
    name: "Web bugs",
    columns: [
      { id: "name", title: "Name", type: "name" },
      { id: "status", title: "Status", type: "status", labels: ["Ready for dev", "Working on it", "In review", "Done", "Stuck"] },
      { id: "priority", title: "Priority", type: "color", labels: ["High", "Low"] },
    ],
  };

  it("accepts labels the column has, in the board's spelling", () => {
    const result = checkBoardAutomation(board, { ...AUTOMATION, startLabel: "ready for dev", doneLabel: "" });
    expect(result).toEqual({ ok: true, automation: { ...AUTOMATION, startLabel: "Ready for dev", doneLabel: "" } });
  });

  it("names the missing column or label", () => {
    expect(checkBoardAutomation(board, { ...AUTOMATION, statusColumnId: "status9" })).toEqual({
      ok: false,
      error: 'Board "Web bugs" has no status column with the id "status9". Its status columns: Status (status), Priority (priority).',
    });
    expect(checkBoardAutomation(board, { ...AUTOMATION, reviewLabel: "QA" })).toEqual({
      ok: false,
      error: 'The "Status" column on board "Web bugs" has no label "QA" (the in review label). Its labels: Ready for dev, Working on it, In review, Done, Stuck.',
    });
  });

  it("refuses a start label the team also sets", () => {
    expect(labelConflict(AUTOMATION)).toBeUndefined();
    expect(labelConflict({ ...AUTOMATION, doneLabel: "ready for dev" })).toMatch(/also the done label/);
    expect(labelConflict({ ...AUTOMATION, workingLabel: "" })).toBeUndefined();
  });
});

describe("connectWebhooks", () => {
  it("creates one webhook per board on its status column, keeps it next time, and replaces it for a new URL", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-hooks-")));
    const calls: string[] = [];
    const live = new Set<string>();
    let next = 100;
    const client = {
      createWebhook: async (input: { boardId: string; url: string; event: string; config?: Record<string, unknown> }) => {
        calls.push(`create ${input.boardId} ${input.event} ${JSON.stringify(input.config)} ${input.url}`);
        const id = String(next++);
        live.add(id);
        return { id, boardId: input.boardId };
      },
      deleteWebhook: async (id: string) => {
        calls.push(`delete ${id}`);
        live.delete(id);
        return { id };
      },
      listWebhooks: async () => [...live].map((id) => ({ id, boardId: BOARD })),
    };
    const deps = { store, client, redact: (t: string) => t };
    const boards = { [BOARD]: AUTOMATION };

    expect(await connectWebhooks(deps, boards, "https://a.example/monday/webhook/s1")).toEqual({ created: [BOARD], failed: [] });
    expect(await connectWebhooks(deps, boards, "https://a.example/monday/webhook/s1")).toEqual({ created: [BOARD], failed: [] });
    expect(await connectWebhooks(deps, boards, "https://b.example/monday/webhook/s1")).toEqual({ created: [BOARD], failed: [] });
    expect(calls).toEqual([
      `create ${BOARD} change_specific_column_value {"columnId":"status"} https://a.example/monday/webhook/s1`,
      "delete 100",
      `create ${BOARD} change_specific_column_value {"columnId":"status"} https://b.example/monday/webhook/s1`,
    ]);

    await removeWebhook(deps, BOARD);
    expect(calls.at(-1)).toBe("delete 101");
  });

  it("reports each board that failed, redacted", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-hooks-")));
    const client = {
      createWebhook: async () => Promise.reject(new Error("monday.com API error: Unauthorized for https://a.example/monday/webhook/SECRET123")),
      deleteWebhook: async (id: string) => ({ id }),
      listWebhooks: async () => [],
    };
    const result = await connectWebhooks({ store, client, redact: (t) => t.split("SECRET123").join("[redacted]") }, { [BOARD]: AUTOMATION }, "https://a.example/monday/webhook/SECRET123");
    expect(result).toEqual({ created: [], failed: [{ boardId: BOARD, error: "monday.com API error: Unauthorized for https://a.example/monday/webhook/[redacted]" }] });
  });
});

// ---------- the handler ----------

describe("TicketAutomation", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(opts: { status?: string; tasks?: Task[]; start?: DirectTaskResult; configure?: (c: Config) => void } = {}) {
    const c = config(opts.configure);
    let clock = 1_000_000;
    let current = opts.status ?? "Ready for dev";
    const reads: string[] = [];
    const posted: { op: string; label?: string; body?: string }[] = [];
    const client: AutomationClient = {
      getItem: async (id) => {
        reads.push(id);
        return item(current);
      },
      setStatusLabel: async ({ label }) => {
        posted.push({ op: "status", label });
        return { id: ITEM };
      },
      addUpdate: async (_id, body) => {
        posted.push({ op: "update", body });
        return { id: "u9" };
      },
    };
    const started: { repo: string; instruction: string; opts: { trigger: Task["trigger"]; ticket: TaskTicket; title: string; ackText: string } }[] = [];
    const tasks = [...(opts.tasks ?? [])];
    const automation = new TicketAutomation({
      configRepo: { load: async () => c },
      tasks: { recent: async () => tasks },
      startTask: async (repo, instruction, o) => {
        started.push({ repo, instruction, opts: o });
        return opts.start ?? { ok: true, conversationId: "c-000000001-abcdef", taskId: `t-${started.length}` };
      },
      client: () => client,
      now: () => clock,
    });
    return {
      automation,
      reads,
      posted,
      started,
      tasks,
      setStatus: (s: string) => void (current = s),
      advance: (ms: number) => void (clock += ms),
    };
  }

  it("starts a monday-triggered task with the ticket, in a conversation named after it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup();
    expect(await t.automation.handle(BOARD, ITEM)).toBe("started task t-1 in conversation c-000000001-abcdef");
    expect(t.reads).toEqual([ITEM]);
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({
      repo: "acme/web",
      instruction: ticketInstruction(item("Ready for dev")),
      opts: {
        trigger: "monday",
        title: "Login redirect goes to /",
        ticket: { boardId: BOARD, itemId: ITEM, name: "Login redirect goes to /", url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}` },
        ackText: "The ticket **Login redirect goes to /** moved to *Ready for dev* on monday.com. Putting the team on `acme/web`…",
      },
    });
  });

  it("does not trust the payload: the label read again decides", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ status: "Done" });
    expect(await t.automation.handle(BOARD, ITEM)).toBe("ignored: status is not the start label");
    expect(t.started).toHaveLength(0);
    t.setStatus("Ready for dev");
    expect(await t.automation.handle(BOARD, ITEM)).toMatch(/^started task/);
  });

  it("starts once: not while a task works on the ticket, nor again within a few minutes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const active = { id: "t-0", status: "running", ticket: { boardId: BOARD, itemId: ITEM } } as Task;
    const busy = setup({ tasks: [active] });
    expect(await busy.automation.handle(BOARD, ITEM)).toBe("ignored: a task is already working on this ticket");
    expect(busy.reads).toEqual([]);

    const t = setup();
    const [first, second] = await Promise.all([t.automation.handle(BOARD, ITEM), t.automation.handle(BOARD, ITEM)]);
    expect(first).toMatch(/^started task/);
    expect(second).toBe("ignored: a task started on this ticket moments ago");
    t.advance(START_COOLDOWN_MS + 1);
    expect(await t.automation.handle(BOARD, ITEM)).toMatch(/^started task/);
    expect(t.started).toHaveLength(2);
  });

  it("ignores boards that are not automated, the automation off and a disconnected monday.com", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await setup().automation.handle("111", ITEM)).toBe("ignored: board not automated");
    expect(await setup({ configure: (c) => void (c.monday.automation.enabled = false) }).automation.handle(BOARD, ITEM)).toBe("ignored: automation is off");
    expect(await setup({ configure: (c) => void (c.monday.token = undefined) }).automation.handle(BOARD, ITEM)).toBe("ignored: monday.com is not connected");
  });

  it("tells the ticket when the task cannot start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ start: { ok: false, status: 400, error: "No GitHub connection is allowed to work on acme/web." } });
    expect(await t.automation.handle(BOARD, ITEM)).toBe("could not start a task: No GitHub connection is allowed to work on acme/web.");
    expect(t.posted).toEqual([
      { op: "status", label: "Stuck" },
      { op: "update", body: "The team could not start on this: No GitHub connection is allowed to work on acme/web.\n\n— Pointer (Agent Army)" },
    ]);
  });

  it("logs ids and outcomes only, never the ticket's text", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup();
    await t.automation.handle(BOARD, ITEM);
    const lines = logs.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines).toEqual([`[monday] board ${BOARD} item ${ITEM}: started task t-1 in conversation c-000000001-abcdef`]);
    expect(lines.join("\n")).not.toMatch(/Login redirect|Dana|mobile/);
  });
});

// ---------- end to end through the HTTP API ----------

describe("monday.com automation routes", () => {
  const TOKEN = "eyJmonday-test-token-0123456789abcdef";
  let base = "";
  let cookie = "";
  let close: () => void;
  let made: Awaited<ReturnType<typeof createApp>>;
  const launched: string[] = [];
  const realFetch = globalThis.fetch;
  const mondayCalls: { query: string; variables: Record<string, unknown> }[] = [];
  const state = {
    status: "Ready for dev",
    createError: undefined as string | undefined,
    columns: [
      { id: "status", title: "Status", type: "status", settings: { labels: [{ id: 1, label: "Ready for dev" }, { id: 2, label: "Working on it" }, { id: 3, label: "In review" }, { id: 4, label: "Done" }, { id: 5, label: "Stuck" }] } },
      { id: "text", title: "Notes", type: "text", settings: {} },
    ],
  };

  const reply = (data: unknown) => Response.json({ data });
  const fakeMonday = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== MONDAY_API_URL) return realFetch(input, init);
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    mondayCalls.push({ query, variables });
    if (query.includes("create_webhook(")) {
      if (state.createError) return Response.json({ errors: [{ message: state.createError }] });
      return reply({ create_webhook: { id: "555", board_id: variables.boardId } });
    }
    if (query.includes("delete_webhook(")) return reply({ delete_webhook: { id: variables.id } });
    if (query.includes("webhooks(board_id")) return reply({ webhooks: [] });
    if (query.includes("change_multiple_column_values(")) return reply({ change_multiple_column_values: { id: variables.itemId } });
    if (query.includes("create_update(")) return reply({ create_update: { id: "u1" } });
    if (query.includes("items(ids")) {
      return reply({
        items: [
          {
            id: ITEM,
            name: "Login redirect goes to /",
            url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}`,
            state: "active",
            board: { id: BOARD, name: "Web bugs" },
            group: { id: "topics", title: "This sprint" },
            column_values: [{ id: "status", type: "status", text: state.status, column: { title: "Status" } }],
            assets: [],
            updates: [{ id: "u1", created_at: "2026-11-17T09:00:00Z", text_body: "People land on / after signing in.", creator: { name: "Dana" }, assets: [], replies: [] }],
          },
        ],
      });
    }
    if (query.includes("boards(ids")) return reply({ boards: [{ id: BOARD, name: "Web bugs", groups: [], columns: state.columns }] });
    return Response.json({ errors: [{ message: "unexpected query" }] });
  };

  const send = (method: "GET" | "POST", path: string, body?: unknown, withCookie = true) =>
    fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(withCookie && cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = (path: string, body: unknown = {}, withCookie = true) => send("POST", path, body, withCookie);
  const get = (path: string) => send("GET", path);
  const automation = async () => (await (await get("/api/state")).json()).config.monday.automation;
  const deliver = (secret: string, body: unknown) =>
    fetch(`${base}/monday/webhook/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const statusEvent = { event: { boardId: Number(BOARD), pulseId: Number(ITEM), columnId: "status", value: { label: { text: "Ready for dev" } } } };

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    vi.stubGlobal("fetch", fakeMonday);
    const dir = await mkdtemp(join(tmpdir(), "army-monday-auto-"));
    const runner = { kind: "local" as const, launch: async (id: string) => void launched.push(id) };
    made = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-monday", RUNNER: "local" }, { runner });
    const server = made.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const setup = await post("/api/setup", { setupToken: "setup-monday", password: "longpassword1" }, false);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/api/anthropic", { apiKey: "sk-ant-0123456789abcd" })).status).toBe(200);
  });
  afterAll(() => {
    close();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    process.env.SKIP_VALIDATION = "1";
  });

  it("requires a session", async () => {
    expect((await post("/api/monday/automation", { enabled: true }, false)).status).toBe(401);
    expect((await post("/api/monday/automation/webhook", {}, false)).status).toBe(401);
    expect((await send("GET", `/api/monday/columns?boardId=${BOARD}`, undefined, false)).status).toBe(401);
  });

  it("validates board settings: monday.com and GitHub connected, allowed boards and repos, real labels", async () => {
    const error = async (input: unknown) => {
      const res = await post("/api/monday/automation", input);
      return { status: res.status, error: (await res.json()).error as string };
    };
    expect(await error({ enabled: true })).toEqual({ status: 400, error: "Connect monday.com with an API token first." });
    expect((await post("/api/monday", { token: TOKEN, allowedBoardIds: ["111"] })).status).toBe(200);

    expect(await error({ boards: { [BOARD]: AUTOMATION } })).toEqual({ status: 400, error: `Board ${BOARD} is not one of the boards Pointer may use. Add it under Boards first.` });
    expect((await post("/api/monday", { allowedBoardIds: [] })).status).toBe(200);
    expect(await error({ boards: { [BOARD]: AUTOMATION } })).toEqual({ status: 400, error: "GitHub is not connected. Ask the owner to connect it on the admin page." });
    expect((await post("/api/github", { token: "github_pat_0123456789abcdefghij", allowedOwners: ["acme"] })).status).toBe(200);
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, repo: "other/web" } } })).toEqual({
      status: 400,
      error: "Not allowed to work on other/web. Allowed on GitHub: acme.",
    });
    expect(await error({ boards: { abc: AUTOMATION } })).toEqual({ status: 400, error: '"abc" is not a board id. Board ids are numbers, like 1234567890.' });
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, repo: "nope" } } })).toEqual({ status: 400, error: `Board ${BOARD}: Repositories look like owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo.` });
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, startLabel: " " } } })).toEqual({ status: 400, error: `Board ${BOARD}: Choose the status that starts a task.` });
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, doneLabel: "Ready for dev" } } })).toMatchObject({ status: 400, error: expect.stringMatching(/also the done label/) });

    // With validation on, the board's real column and labels are checked through the API.
    delete process.env.SKIP_VALIDATION;
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, reviewLabel: "QA" } } })).toEqual({
      status: 400,
      error: 'The "Status" column on board "Web bugs" has no label "QA" (the in review label). Its labels: Ready for dev, Working on it, In review, Done, Stuck.',
    });
    expect(await error({ boards: { [BOARD]: { ...AUTOMATION, statusColumnId: "text" } } })).toMatchObject({ status: 400, error: expect.stringMatching(/no status column with the id "text"/) });
    const ok = await post("/api/monday/automation", { enabled: true, boards: { [BOARD]: { repo: "acme/web", statusColumnId: "status", startLabel: "ready for dev" } } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      automation: { enabled: true, webhookConfigured: false, boards: { [BOARD]: { ...AUTOMATION, startLabel: "Ready for dev" } } },
    });
    expect(await automation()).toEqual({ enabled: true, webhookConfigured: false, boards: { [BOARD]: AUTOMATION } });
  });

  it("lists a board's status columns with their labels", async () => {
    const res = await get(`/api/monday/columns?boardId=${BOARD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      board: { id: BOARD, name: "Web bugs" },
      columns: [{ id: "status", title: "Status", labels: ["Ready for dev", "Working on it", "In review", "Done", "Stuck"] }],
    });
    expect((await get("/api/monday/columns?boardId=x1")).status).toBe(400);
  });

  it("creates the webhook on each board, with a new secret in its URL, and says how to add it by hand when it cannot", async () => {
    const res = await post("/api/monday/automation/webhook");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, created: [BOARD], failed: [] });
    expect(body.url).toMatch(new RegExp(`^${base}/monday/webhook/[A-Za-z0-9_-]{40,}$`));
    const create = mondayCalls.find((c) => c.query.includes("create_webhook("))!;
    expect(create.variables).toEqual({ boardId: BOARD, url: body.url, event: "change_specific_column_value", config: '{"columnId":"status"}' });
    expect((await automation()).webhookConfigured).toBe(true);
    expect(JSON.stringify(await (await get("/api/state")).json())).not.toContain(body.url.split("/").pop());

    state.createError = "User unauthorized to perform action";
    const again = await (await post("/api/monday/automation/webhook")).json();
    expect(again).toMatchObject({ ok: false, url: body.url, created: [], failed: [{ boardId: BOARD, error: "monday.com API error: User unauthorized to perform action" }] });
    expect(again.manualSteps.join(" ")).toContain(body.url);
    expect(again.manualSteps.join(" ")).toContain("When a column changes, send a webhook");
    state.createError = undefined;
  });

  it("answers 404 for a wrong secret, echoes the challenge, and starts a monday task from a delivery", async () => {
    const url: string = (await (await post("/api/monday/automation/webhook")).json()).url;
    const secret = url.split("/").pop()!;
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await deliver("wrong-secret-0123456789abcdefghijklmnop", { challenge: "abc" })).status).toBe(404);
      expect((await deliver("", { challenge: "abc" })).status).toBe(404);

      const challenge = await deliver(secret, { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
      expect(challenge.status).toBe(200);
      expect(await challenge.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });

      // The payload says "Ready for dev" but the item, read again, does not: nothing starts.
      state.status = "Done";
      const ignored = await deliver(secret, statusEvent);
      expect(ignored.status).toBe(200);
      await made.automation.idle();
      expect(launched).toHaveLength(0);

      state.status = "Ready for dev";
      mondayCalls.length = 0;
      expect((await deliver(secret, statusEvent)).status).toBe(200);
      await made.automation.idle();
      expect(launched).toHaveLength(1);
      expect(mondayCalls.filter((c) => c.query.includes("items(ids"))).toHaveLength(1);

      const view = await (await get("/api/conversations")).json();
      const conversation = view.conversations.find((c: { title: string }) => c.title === "Login redirect goes to /");
      expect(conversation).toBeDefined();
      const full = await (await get(`/api/conversations/${conversation.id}`)).json();
      expect(full.tasks).toHaveLength(1);
      expect(full.tasks[0]).toMatchObject({
        id: launched[0],
        trigger: "monday",
        repo: "acme/web",
        status: "queued",
        ticket: { boardId: BOARD, itemId: ITEM, name: "Login redirect goes to /", url: `https://acme.monday.com/boards/${BOARD}/pulses/${ITEM}` },
      });
      expect(full.tasks[0].instruction).toContain("People land on / after signing in.");

      // A second delivery while that task is queued starts nothing.
      expect((await deliver(secret, statusEvent)).status).toBe(200);
      await made.automation.idle();
      expect(launched).toHaveLength(1);

      const lines = logs.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(lines).not.toMatch(/People land|Login redirect/);
    } finally {
      logs.mockRestore();
    }
  });

  it("stops answering when the automation is off, and removes a board with null", async () => {
    const url: string = (await (await post("/api/monday/automation/webhook")).json()).url;
    const secret = url.split("/").pop()!;
    expect((await post("/api/monday/automation", { enabled: false })).status).toBe(200);
    expect((await deliver(secret, { challenge: "abc" })).status).toBe(404);
    expect((await post("/api/monday/automation/webhook")).status).toBe(400);

    mondayCalls.length = 0;
    expect((await post("/api/monday/automation", { boards: { [BOARD]: null } })).status).toBe(200);
    expect((await automation()).boards).toEqual({});
    expect(mondayCalls.some((c) => c.query.includes("delete_webhook("))).toBe(true);
  });
});
