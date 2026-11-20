import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS, type NewAttachment } from "../../../src/chat/attachments.js";
import {
  MONDAY_API_URL,
  MONDAY_API_VERSION,
  MONDAY_READ_TOOL_NAMES,
  MONDAY_TOOL_NAMES,
  MondayClient,
  checkMonday,
  mondayHandlers,
  mondayTools,
  type MondayToolOptions,
} from "../../../src/integrations/monday/monday.js";
import type { AddAttachment } from "../../../src/chat/pointer-types.js";

const TOKEN = "eyJtest-monday-token-0123456789";

interface Call {
  url: string;
  headers: Headers;
  query: string;
  variables: Record<string, unknown>;
}

interface Download {
  url: string;
  method?: string;
  headers: Headers;
}

type Canned = unknown | { status: number; body: unknown; headers?: Record<string, string> };
type CannedFile = { status?: number; body: Uint8Array | string; headers?: Record<string, string> };

function isRaw(r: unknown): r is { status: number; body: unknown; headers?: Record<string, string> } {
  return typeof r === "object" && r !== null && "status" in r && "body" in r;
}

/**
 * A fake fetch: GraphQL calls to the monday API get the next canned response;
 * any other URL is a file download served from `files` (404 when unknown).
 */
function fakeMonday(responses: Canned[], files: Record<string, CannedFile> = {}) {
  const calls: Call[] = [];
  const downloads: Download[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== MONDAY_API_URL) {
      downloads.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers) });
      const file = files[String(url)];
      if (!file) return new Response("missing", { status: 404 });
      return new Response(file.body, { status: file.status ?? 200, headers: file.headers });
    }
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      query: body.query,
      variables: body.variables ?? {},
    });
    expect(init?.method).toBe("POST");
    if (responses.length === 0) throw new Error("unexpected extra monday call");
    const next = responses.shift();
    const raw = isRaw(next) ? next : { status: 200, body: next };
    const text = typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body);
    return new Response(text, { status: raw.status, headers: raw.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls, downloads };
}

/** A fake fetch that records each GraphQL call and answers with the next canned response. */
function fakeFetch(...responses: Canned[]) {
  const f = fakeMonday(responses);
  return { fetch: f.fetch, calls: f.calls };
}

const textOf = (r: { content: unknown }) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

function handlersWith(fetchFn: typeof fetch, opts: Partial<MondayToolOptions> = {}) {
  return mondayHandlers({ client: new MondayClient(TOKEN, fetchFn), allowedBoardIds: [], ...opts });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MondayClient transport", () => {
  it("posts GraphQL to the v2 endpoint with the token and a pinned API version", async () => {
    const f = fakeFetch({ data: { me: { name: "Dana", account: { name: "Acme" } } } });
    const me = await new MondayClient(TOKEN, f.fetch).me();
    expect(me).toEqual({ userName: "Dana", accountName: "Acme" });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.monday.com/v2");
    expect(call.headers.get("authorization")).toBe(TOKEN);
    expect(call.headers.get("api-version")).toBe(MONDAY_API_VERSION);
    expect(MONDAY_API_VERSION).toMatch(/^\d{4}-\d{2}$/);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.query).toMatch(/\bme\s*\{\s*name\s+account\s*\{\s*name\s*\}/);
  });

  it("turns a GraphQL errors array (HTTP 200) into a readable error", async () => {
    const f = fakeFetch({
      errors: [
        {
          message: "This column value is not valid",
          extensions: { code: "ColumnValueException", status_code: 200 },
        },
      ],
      account_id: 1,
    });
    await expect(new MondayClient(TOKEN, f.fetch).me()).rejects.toThrow(
      /monday\.com API error: This column value is not valid \(ColumnValueException\)/,
    );
  });

  it("reports the legacy error_message shape", async () => {
    const f = fakeFetch({ error_code: "InvalidBoardIdException", error_message: "Board not found", status_code: 200 });
    await expect(new MondayClient(TOKEN, f.fetch).getBoard("1")).rejects.toThrow(
      /Board not found \(InvalidBoardIdException\)/,
    );
  });

  it("reports complexity and rate limits with the retry delay", async () => {
    const f = fakeFetch(
      {
        errors: [
          {
            message: "Complexity budget exhausted",
            extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: 17 },
          },
        ],
      },
      { status: 429, body: { errors: [{ message: "Rate Limit Exceeded" }] }, headers: { "retry-after": "30" } },
    );
    const client = new MondayClient(TOKEN, f.fetch);
    await expect(client.me()).rejects.toThrow(/COMPLEXITY_BUDGET_EXHAUSTED.*retry in 17s/i);
    await expect(client.me()).rejects.toThrow(/rate limit.*retry in 30s/i);
  });

  it("reports HTTP failures with the status and a short detail", async () => {
    const f = fakeFetch({ status: 500, body: "x".repeat(2000) });
    const err = (await new MondayClient(TOKEN, f.fetch).me().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message.length).toBeLessThan(500);
  });

  it("never puts the token in an error, even if monday echoes it", async () => {
    const client = (fetchFn: typeof fetch) => new MondayClient(TOKEN, fetchFn);
    const echoes = [
      fakeFetch({ status: 500, body: `bad token ${TOKEN}` }),
      fakeFetch({ status: 401, body: { errors: [{ message: `Not Authenticated: ${TOKEN}` }] } }),
      fakeFetch({ errors: [{ message: `weird ${TOKEN}` }] }),
    ];
    for (const f of echoes) {
      const err = (await client(f.fetch).me().catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain(TOKEN);
    }
    const throwing = vi.fn(async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = (await client(throwing).me().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/request failed/);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("checkMonday", () => {
  it("returns who the token belongs to", async () => {
    const f = fakeFetch({ data: { me: { name: "Dana", account: { name: "Acme" } } } });
    await expect(checkMonday(TOKEN, f.fetch)).resolves.toEqual({ userName: "Dana", accountName: "Acme" });
  });

  it("throws a user-readable error for a rejected token", async () => {
    const f = fakeFetch({ status: 401, body: { errors: [{ message: "Not Authenticated" }] } });
    const err = (await checkMonday(TOKEN, f.fetch).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("monday.com rejected this token.");
  });

  it("explains other failures without leaking the token", async () => {
    const f = fakeFetch({ status: 503, body: `down ${TOKEN}` });
    const err = (await checkMonday(TOKEN, f.fetch).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^monday\.com check failed/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("returns a fake identity without calling monday when SKIP_VALIDATION=1", async () => {
    vi.stubEnv("SKIP_VALIDATION", "1");
    const f = fakeFetch();
    await expect(checkMonday(TOKEN, f.fetch)).resolves.toEqual({ userName: "test", accountName: "test" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("MondayClient queries", () => {
  it("lists active boards, most recently used first, without subitem boards or docs", async () => {
    const f = fakeFetch({
      data: {
        boards: [
          { id: "11", name: "Bugs", type: "board", workspace: { name: "Engineering" } },
          { id: "12", name: "Subitems of Bugs", type: "sub_items_board", workspace: null },
          { id: "13", name: "Roadmap", type: "board", workspace: null },
          { id: "14", name: "Spec doc", type: "document", workspace: null },
        ],
      },
    });
    const boards = await new MondayClient(TOKEN, f.fetch).listBoards({ limit: 10 });
    expect(boards).toEqual([
      { id: "11", name: "Bugs", workspace: "Engineering" },
      { id: "13", name: "Roadmap" },
    ]);
    expect(f.calls[0]!.query).toMatch(/order_by:\s*used_at/);
    expect(f.calls[0]!.query).toMatch(/state:\s*active/);
    expect(f.calls[0]!.variables).toMatchObject({ limit: 10, page: 1 });
  });

  it("searches board names client-side across pages (the boards query has no name filter)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: String(100 + i), name: `Board ${i}`, type: "board" }));
    page1[5] = { id: "105", name: "Customer Bugs", type: "board" };
    const f = fakeFetch(
      { data: { boards: page1 } },
      { data: { boards: [{ id: "900", name: "bugs triage", type: "board" }] } },
    );
    const boards = await new MondayClient(TOKEN, f.fetch).listBoards({ search: "BUGS" });
    expect(boards.map((b) => b.id)).toEqual(["105", "900"]);
    expect(f.calls.map((c) => c.variables.page)).toEqual([1, 2]);
    expect(f.calls[0]!.variables.limit).toBe(100);
  });

  it("limits the board list to the given ids", async () => {
    const f = fakeFetch({ data: { boards: [{ id: "11", name: "Bugs", type: "board" }] } });
    await new MondayClient(TOKEN, f.fetch).listBoards({ ids: ["11", "12"] });
    expect(f.calls[0]!.query).toMatch(/ids:\s*\$ids/);
    expect(f.calls[0]!.variables.ids).toEqual(["11", "12"]);
  });

  it("maps a board with groups, columns and status/dropdown labels", async () => {
    const f = fakeFetch({
      data: {
        boards: [
          {
            id: "11",
            name: "Bugs",
            url: "https://acme.monday.com/boards/11",
            groups: [{ id: "topics", title: "New" }],
            columns: [
              { id: "name", title: "Name", type: "name", settings: {} },
              {
                id: "status",
                title: "Status",
                type: "status",
                settings: {
                  labels: [
                    { id: 0, label: "Working on it", color: "working_orange", index: 0, is_done: false },
                    { id: 1, label: "Done", color: "done_green", index: 1, is_done: true },
                  ],
                },
              },
              // Older/stringified settings with a labels map still parse.
              { id: "priority", title: "Priority", type: "status", settings: '{"labels":{"0":"High","1":"Low"}}' },
              {
                id: "dropdown",
                title: "Area",
                type: "dropdown",
                settings: {
                  labels: [
                    { id: 1, label: "Frontend" },
                    { id: 2, label: "Legacy", is_deactivated: true },
                  ],
                },
              },
              { id: "person", title: "Owner", type: "people", settings: null },
            ],
          },
        ],
      },
    });
    const board = await new MondayClient(TOKEN, f.fetch).getBoard("11");
    expect(f.calls[0]!.variables).toEqual({ ids: ["11"] });
    expect(f.calls[0]!.query).toMatch(/columns\s*\{\s*id\s+title\s+type\s+settings\s*\}/);
    expect(board).toEqual({
      id: "11",
      name: "Bugs",
      url: "https://acme.monday.com/boards/11",
      groups: [{ id: "topics", title: "New" }],
      columns: [
        { id: "name", title: "Name", type: "name" },
        { id: "status", title: "Status", type: "status", labels: ["Working on it", "Done"] },
        { id: "priority", title: "Priority", type: "status", labels: ["High", "Low"] },
        { id: "dropdown", title: "Area", type: "dropdown", labels: ["Frontend"] },
        { id: "person", title: "Owner", type: "people" },
      ],
    });
  });

  it("errors when a board is missing", async () => {
    const f = fakeFetch({ data: { boards: [] } });
    await expect(new MondayClient(TOKEN, f.fetch).getBoard("99")).rejects.toThrow(/Board 99 was not found/);
  });

  it("searches items by name with an items_page contains_text rule", async () => {
    const f = fakeFetch({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: "501",
                  name: "Login bug on Safari",
                  url: "https://acme.monday.com/boards/11/pulses/501",
                  group: { title: "New" },
                  column_values: [
                    { id: "status", text: "Working on it", column: { title: "Status" } },
                    { id: "person", text: "", column: { title: "Owner" } },
                    { id: "date4", text: null, column: { title: "Due" } },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const items = await new MondayClient(TOKEN, f.fetch).searchItems("11", "login", 5);
    expect(f.calls[0]!.query).toMatch(/items_page\(limit: \$limit, query_params: \$query\)/);
    expect(f.calls[0]!.query).toMatch(/\$query: ItemsQuery/);
    expect(f.calls[0]!.variables).toEqual({
      ids: ["11"],
      limit: 5,
      query: { rules: [{ column_id: "name", compare_value: ["login"], operator: "contains_text" }] },
    });
    expect(items).toEqual([
      {
        id: "501",
        name: "Login bug on Safari",
        url: "https://acme.monday.com/boards/11/pulses/501",
        group: "New",
        columns: { Status: "Working on it" },
      },
    ]);
  });

  it("creates an item with column values as a JSON string", async () => {
    const f = fakeFetch({ data: { create_item: { id: "777", url: "https://acme.monday.com/boards/11/pulses/777" } } });
    const created = await new MondayClient(TOKEN, f.fetch).createItem({
      boardId: "11",
      groupId: "topics",
      name: "Login bug",
      columnValues: { status: { label: "Working on it" } },
    });
    expect(created).toEqual({ id: "777", url: "https://acme.monday.com/boards/11/pulses/777" });
    expect(f.calls[0]!.query).toMatch(/create_item\(board_id: \$boardId, group_id: \$groupId, item_name: \$name, column_values: \$columnValues\)/);
    expect(f.calls[0]!.variables).toEqual({
      boardId: "11",
      groupId: "topics",
      name: "Login bug",
      columnValues: '{"status":{"label":"Working on it"}}',
    });
  });

  it("changes column values and posts updates", async () => {
    const f = fakeFetch(
      { data: { change_multiple_column_values: { id: "777" } } },
      { data: { create_update: { id: "9001" } } },
    );
    const client = new MondayClient(TOKEN, f.fetch);
    await expect(
      client.changeColumnValues({ boardId: "11", itemId: "777", columnValues: { status: { label: "Done" } } }),
    ).resolves.toEqual({ id: "777" });
    expect(f.calls[0]!.query).toMatch(/change_multiple_column_values\(board_id: \$boardId, item_id: \$itemId, column_values: \$columnValues\)/);
    expect(f.calls[0]!.variables).toEqual({ boardId: "11", itemId: "777", columnValues: '{"status":{"label":"Done"}}' });

    await expect(client.addUpdate("777", "Fixed <b>it</b> & shipped\nsee PR")).resolves.toEqual({ id: "9001" });
    expect(f.calls[1]!.query).toMatch(/create_update\(item_id: \$itemId, body: \$body\)/);
    expect(f.calls[1]!.variables).toEqual({ itemId: "777", body: "Fixed &lt;b&gt;it&lt;/b&gt; &amp; shipped<br>see PR" });
  });

  it("finds users by name", async () => {
    const f = fakeFetch({ data: { users: [{ id: "42", name: "Sam Lee", email: "sam@acme.test" }] } });
    const users = await new MondayClient(TOKEN, f.fetch).findUsers("sam");
    expect(users).toEqual([{ id: "42", name: "Sam Lee", email: "sam@acme.test" }]);
    expect(f.calls[0]!.query).toMatch(/users\(name: \$name, limit: \$limit\)/);
    expect(f.calls[0]!.variables).toMatchObject({ name: "sam" });
  });
});

describe("monday tool handlers", () => {
  it("say monday.com is not connected when there is no client", async () => {
    const h = mondayHandlers({ allowedBoardIds: [] });
    const results = await Promise.all([
      h.monday_list_boards({}),
      h.monday_get_board({}),
      h.monday_search_items({ text: "x" }),
      h.monday_find_users({ name: "x" }),
      h.monday_create_item({ name: "x", board_id: "1" }),
      h.monday_update_item({ item_id: "1", column_values: { status: "Done" } }),
      h.monday_add_comment({ item_id: "1", text: "x" }),
      h.monday_get_item({ item_id: "1" }),
      h.monday_attach_files({ item_id: "1" }),
    ]);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("monday.com is not connected. Ask the owner to connect it on the admin page.");
    }
  });

  it("creates an item on the default board and posts the description with the requester line", async () => {
    const f = fakeFetch(
      { data: { create_item: { id: "777", url: "https://acme.monday.com/boards/11/pulses/777" } } },
      { data: { create_update: { id: "9001" } } },
    );
    const h = handlersWith(f.fetch, { defaultBoardId: "11", requester: "Sam Lee" });
    const r = await h.monday_create_item({
      name: "Login bug",
      description: "Users can't log in on Safari.\nSteps: open /login",
      column_values: { status: { label: "Working on it" } },
    });
    expect(r.isError).toBeFalsy();
    expect(f.calls[0]!.variables).toMatchObject({ boardId: "11", name: "Login bug" });
    expect(f.calls[0]!.variables).not.toHaveProperty("groupId");
    expect(f.calls[1]!.variables).toEqual({
      itemId: "777",
      body: "Users can't log in on Safari.<br>Steps: open /login<br><br>Opened from Slack by Sam Lee",
    });
    const text = textOf(r);
    expect(text).toContain("777");
    expect(text).toContain("https://acme.monday.com/boards/11/pulses/777");
  });

  it("posts the description without a requester line when there is no requester", async () => {
    const f = fakeFetch({ data: { create_item: { id: "777" } } }, { data: { create_update: { id: "1" } } });
    const h = handlersWith(f.fetch, { defaultBoardId: "11" });
    await h.monday_create_item({ name: "Login bug", description: "Broken" });
    expect(f.calls[1]!.variables.body).toBe("Broken");
  });

  it("does not post an update when there is no description", async () => {
    const f = fakeFetch({ data: { create_item: { id: "777" } } });
    const h = handlersWith(f.fetch, { requester: "Sam" });
    const r = await h.monday_create_item({ name: "Login bug", board_id: "12", group_id: "topics" });
    expect(r.isError).toBeFalsy();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.variables).toMatchObject({ boardId: "12", groupId: "topics" });
  });

  it("accepts column_values given as a JSON string and rejects invalid JSON", async () => {
    const f = fakeFetch({ data: { create_item: { id: "777" } } });
    const h = handlersWith(f.fetch, { defaultBoardId: "11" });
    await h.monday_create_item({ name: "x", column_values: '{"date4":{"date":"2026-11-20"}}' });
    expect(f.calls[0]!.variables.columnValues).toBe('{"date4":{"date":"2026-11-20"}}');

    const bad = await h.monday_create_item({ name: "x", column_values: "{not json" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/column_values/);
    expect(f.calls).toHaveLength(1);
  });

  it("keeps the created item when posting the description fails, and says not to retry", async () => {
    const f = fakeFetch(
      { data: { create_item: { id: "777", url: "https://acme.monday.com/boards/11/pulses/777" } } },
      { errors: [{ message: "Internal error" }] },
    );
    const h = handlersWith(f.fetch, { defaultBoardId: "11" });
    const r = await h.monday_create_item({ name: "Login bug", description: "details" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/777/);
    expect(textOf(r)).toMatch(/description failed/i);
  });

  it("asks for a board when none is given and there is no default", async () => {
    const f = fakeFetch();
    const h = handlersWith(f.fetch);
    for (const r of [
      await h.monday_create_item({ name: "Login bug" }),
      await h.monday_get_board({}),
      await h.monday_search_items({ text: "login" }),
    ]) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/which board/i);
      expect(textOf(r)).toMatch(/monday_list_boards/);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("enforces the board allowlist on every board-scoped tool", async () => {
    const f = fakeFetch(
      // update_item / add_comment look up the item's board first
      { data: { items: [{ id: "500", board: { id: "99" } }] } },
      { data: { items: [{ id: "500", board: { id: "99" } }] } },
    );
    const h = handlersWith(f.fetch, { allowedBoardIds: ["11"], defaultBoardId: "11" });
    const denied = [
      await h.monday_create_item({ name: "x", board_id: "99" }),
      await h.monday_get_board({ board_id: "99" }),
      await h.monday_search_items({ text: "x", board_id: "99" }),
      await h.monday_update_item({ item_id: "500", column_values: { status: { label: "Done" } } }),
      await h.monday_add_comment({ item_id: "500", text: "hi" }),
    ];
    for (const r of denied) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/board 99 is not one of the allowed monday\.com boards/i);
    }
    // Only the two item lookups reached monday; nothing was written.
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => /items\(ids: \$ids\)/.test(c.query))).toBe(true);
  });

  it("rejects a default board outside the allowlist", async () => {
    const h = handlersWith(fakeFetch().fetch, { allowedBoardIds: ["11"], defaultBoardId: "12" });
    const r = await h.monday_create_item({ name: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/board 12 is not one of the allowed/i);
  });

  it("lists only allowed boards when an allowlist is set", async () => {
    const f = fakeFetch({ data: { boards: [{ id: "11", name: "Bugs", type: "board", workspace: { name: "Eng" } }] } });
    const h = handlersWith(f.fetch, { allowedBoardIds: ["11", "12"], defaultBoardId: "11" });
    const r = await h.monday_list_boards({});
    expect(f.calls[0]!.variables.ids).toEqual(["11", "12"]);
    expect(textOf(r)).toMatch(/Bugs \(id 11\)/);
    expect(textOf(r)).toMatch(/default/);
  });

  it("updates an item, resolving its board when board_id is omitted", async () => {
    const f = fakeFetch(
      { data: { items: [{ id: "500", board: { id: "11" } }] } },
      { data: { change_multiple_column_values: { id: "500" } } },
    );
    const h = handlersWith(f.fetch, { allowedBoardIds: ["11"] });
    const r = await h.monday_update_item({ item_id: "500", column_values: { status: { label: "Done" } } });
    expect(r.isError).toBeFalsy();
    expect(f.calls[1]!.variables).toEqual({ boardId: "11", itemId: "500", columnValues: '{"status":{"label":"Done"}}' });
    expect(textOf(r)).toMatch(/Updated item 500/);
  });

  it("updates an item directly when board_id is given and there is no allowlist", async () => {
    const f = fakeFetch({ data: { change_multiple_column_values: { id: "500" } } });
    const h = handlersWith(f.fetch);
    const r = await h.monday_update_item({ item_id: "500", board_id: "11", column_values: { text: "hello" } });
    expect(r.isError).toBeFalsy();
    expect(f.calls).toHaveLength(1);
  });

  it("refuses an empty column_values update", async () => {
    const h = handlersWith(fakeFetch().fetch);
    const r = await h.monday_update_item({ item_id: "500", board_id: "11", column_values: {} });
    expect(r.isError).toBe(true);
  });

  it("detects an item that is not on the given board", async () => {
    const f = fakeFetch({ data: { items: [{ id: "500", board: { id: "12" } }] } });
    const h = handlersWith(f.fetch, { allowedBoardIds: ["11", "12"] });
    const r = await h.monday_update_item({ item_id: "500", board_id: "11", column_values: { text: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/on board 12, not board 11/);
  });

  it("adds a comment", async () => {
    const f = fakeFetch({ data: { create_update: { id: "9001" } } });
    const h = handlersWith(f.fetch);
    const r = await h.monday_add_comment({ item_id: "500", text: "Deployed the fix." });
    expect(r.isError).toBeFalsy();
    expect(f.calls[0]!.variables).toEqual({ itemId: "500", body: "Deployed the fix." });
  });

  it("returns API errors as text instead of throwing", async () => {
    const f = fakeFetch({ errors: [{ message: "Item not found", extensions: { code: "ResourceNotFoundException" } }] });
    const h = handlersWith(f.fetch);
    const r = await h.monday_add_comment({ item_id: "500", text: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Item not found/);
  });

  it("formats board details with column ids and labels", async () => {
    const f = fakeFetch({
      data: {
        boards: [
          {
            id: "11",
            name: "Bugs",
            url: "https://acme.monday.com/boards/11",
            groups: [{ id: "topics", title: "New" }],
            columns: [{ id: "status", title: "Status", type: "status", settings: { labels: [{ id: 1, label: "Done" }] } }],
          },
        ],
      },
    });
    const r = await handlersWith(f.fetch, { defaultBoardId: "11" }).monday_get_board({});
    const text = textOf(r);
    expect(text).toContain("Bugs");
    expect(text).toContain("topics");
    expect(text).toMatch(/status.*Done/);
  });

  it("formats search results and users", async () => {
    const f = fakeFetch(
      {
        data: {
          boards: [
            {
              items_page: {
                items: [{ id: "501", name: "Login bug", url: "u", group: { title: "New" }, column_values: [] }],
              },
            },
          ],
        },
      },
      { data: { boards: [{ items_page: { items: [] } }] } },
      { data: { users: [{ id: "42", name: "Sam Lee", email: "sam@acme.test" }] } },
    );
    const h = handlersWith(f.fetch, { defaultBoardId: "11" });
    expect(textOf(await h.monday_search_items({ text: "login" }))).toMatch(/Login bug \(id 501\)/);
    expect(textOf(await h.monday_search_items({ text: "nothing" }))).toMatch(/No items/);
    expect(textOf(await h.monday_find_users({ name: "sam" }))).toMatch(/Sam Lee \(id 42\)/);
  });

  it("caps output at 20 000 characters", async () => {
    const boards = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), name: "B".repeat(500), type: "board" }));
    const f = fakeFetch({ data: { boards } });
    const r = await handlersWith(f.fetch).monday_list_boards({});
    const text = textOf(r);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toMatch(/truncated/);
  });

  it("never returns the token in tool output", async () => {
    const f = fakeFetch({ status: 500, body: `oops ${TOKEN}` });
    const r = await handlersWith(f.fetch, { defaultBoardId: "11" }).monday_get_board({});
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain(TOKEN);
  });
});

describe("monday tool definitions", () => {
  it("defines every tool once, with read-only tools as a subset and no delete/archive", () => {
    const tools = mondayTools({ allowedBoardIds: [] });
    expect(tools.map((t) => t.name).sort()).toEqual([...MONDAY_TOOL_NAMES].sort());
    expect(MONDAY_TOOL_NAMES).toHaveLength(9);
    expect([...MONDAY_READ_TOOL_NAMES].sort()).toEqual(
      ["monday_find_users", "monday_get_board", "monday_get_item", "monday_list_boards", "monday_search_items"].sort(),
    );
    // Attaching files stores them in the conversation: not for read-only subagents.
    expect(MONDAY_TOOL_NAMES).toContain("monday_attach_files");
    expect(MONDAY_READ_TOOL_NAMES).not.toContain("monday_attach_files");
    for (const name of MONDAY_READ_TOOL_NAMES) expect(MONDAY_TOOL_NAMES).toContain(name);
    expect(MONDAY_TOOL_NAMES.some((n) => /delete|archive/.test(n))).toBe(false);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(40);
  });

  it("teaches the column value formats and to read the board first", () => {
    const create = mondayTools({ allowedBoardIds: [] }).find((t) => t.name === "monday_create_item")!;
    expect(create.description).toContain("monday_get_board");
    expect(create.description).toContain('{"label": "Working on it"}');
    expect(create.description).toContain('{"personsAndTeams": [{"id": 12345, "kind": "person"}]}');
    expect(create.description).toContain('{"date": "2026-11-20"}');
    expect(Object.keys(create.inputSchema).sort()).toEqual(
      ["board_id", "column_values", "description", "group_id", "name"].sort(),
    );
  });

  it("wraps the handlers", async () => {
    const tools = mondayTools({ allowedBoardIds: [] });
    const list = tools.find((t) => t.name === "monday_list_boards")!;
    const r = await list.handler({}, undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not connected/);
  });

  it("explains how to get an item id and when to read and attach an item", () => {
    const tools = mondayTools({ allowedBoardIds: [] });
    const get = tools.find((t) => t.name === "monday_get_item")!;
    expect(get.description).toContain("/pulses/");
    expect(get.description).toMatch(/description and comments before acting/);
    expect(Object.keys(get.inputSchema)).toEqual(["item_id"]);
    expect(get.annotations?.readOnlyHint).toBe(true);
    const attach = tools.find((t) => t.name === "monday_attach_files")!;
    expect(attach.description).toContain("monday_get_item");
    expect(Object.keys(attach.inputSchema).sort()).toEqual(["asset_ids", "item_id"]);
    expect(attach.annotations?.readOnlyHint).toBe(false);
    expect(attach.annotations?.destructiveHint).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item details and files

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fileUrl = (id: string) => `https://files-monday-com.s3.amazonaws.com/${id}/file?X-Amz-Signature=sig${id}`;
const rawAsset = (id: string, name: string, size: number) => ({
  id,
  name,
  file_extension: `.${name.split(".").pop()}`,
  file_size: size,
  public_url: fileUrl(id),
  url: `https://acme.monday.com/protected_static/1/resources/${id}/${name}`,
});

function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "501",
    name: "Login bug on Safari",
    url: "https://acme.monday.com/boards/11/pulses/501",
    state: "active",
    board: { id: "11", name: "Bugs" },
    group: { id: "topics", title: "New" },
    creator: { name: "Dana Cohen" },
    column_values: [
      { id: "person", type: "people", text: "Sam Lee", column: { title: "Owner" } },
      { id: "status", type: "status", text: "Working on it", column: { title: "Status" } },
      { id: "date4", type: "date", text: "", column: { title: "Due" } },
      { id: "files", type: "file", text: null, column: { title: "Files" } },
    ],
    assets: [rawAsset("777", "screenshot.png", 120 * 1024), null],
    updates: [
      {
        id: "9002",
        created_at: "2026-11-17T11:00:00Z",
        text_body: "Also broken on iOS.",
        body: "<p>Also broken on iOS.</p>",
        creator: { name: "Sam Lee" },
        assets: [rawAsset("778", "spec.html", 3000)],
        replies: [
          {
            id: "9100",
            created_at: "2026-11-17T11:05:00Z",
            text_body: "",
            body: "<p>Thanks &amp; noted</p>",
            creator: { name: "Dana Cohen" },
            assets: [rawAsset("779", "trace.txt", 10)],
          },
        ],
      },
      {
        id: "9001",
        created_at: "2026-11-17T10:20:00Z",
        text_body: null,
        body: "<p>Users can&#39;t log in on Safari.</p><ul><li>Open /login</li><li>Submit</li></ul>",
        creator: { name: "Dana Cohen" },
        // The same file is on the item and on its first update: listed once.
        assets: [rawAsset("777", "screenshot.png", 120 * 1024)],
        replies: [],
      },
    ],
    ...overrides,
  };
}

const itemResponse = (overrides: Record<string, unknown> = {}) => ({ data: { items: [rawItem(overrides)] } });

describe("MondayClient item details", () => {
  it("reads an item with its columns, updates (text first, else HTML stripped), replies and files", async () => {
    const f = fakeFetch(itemResponse());
    const item = await new MondayClient(TOKEN, f.fetch).getItem("501");
    const call = f.calls[0]!;
    expect(call.variables).toEqual({ ids: ["501"], updatesLimit: 25 });
    expect(call.query).toMatch(/items\(ids: \$ids\)/);
    expect(call.query).toMatch(/updates\(limit: \$updatesLimit\)/);
    expect(call.query).toMatch(/assets\(assets_source: all\)/);
    expect(call.query).toMatch(/replies\s*\{/);
    for (const field of ["text_body", "body", "created_at", "creator { name }", "public_url", "file_size", "file_extension", "state", "board { id name }", "group { id title }", "column_values { id type text column { title } }"]) {
      expect(call.query).toContain(field);
    }

    expect(item).toMatchObject({
      id: "501",
      name: "Login bug on Safari",
      url: "https://acme.monday.com/boards/11/pulses/501",
      state: "active",
      board: { id: "11", name: "Bugs" },
      group: { id: "topics", title: "New" },
      creator: "Dana Cohen",
      columns: [
        { id: "person", title: "Owner", type: "people", text: "Sam Lee" },
        { id: "status", title: "Status", type: "status", text: "Working on it" },
      ],
    });
    expect(item.updates.map((u) => u.id)).toEqual(["9002", "9001"]);
    expect(item.updates[0]).toMatchObject({ author: "Sam Lee", createdAt: "2026-11-17T11:00:00Z", text: "Also broken on iOS." });
    expect(item.updates[0]!.replies[0]).toMatchObject({ id: "9100", author: "Dana Cohen", text: "Thanks & noted" });
    const first = item.updates[1]!.text;
    expect(first).toContain("Users can't log in on Safari.");
    expect(first).toContain("- Open /login\n- Submit");
    expect(first).not.toMatch(/[<>]/);

    expect(item.assets.map((a) => a.id)).toEqual(["777", "778", "779"]);
    expect(item.assets[0]).toEqual({
      id: "777",
      name: "screenshot.png",
      fileExtension: "png",
      fileSize: 120 * 1024,
      publicUrl: fileUrl("777"),
      url: "https://acme.monday.com/protected_static/1/resources/777/screenshot.png",
      updateId: "9001",
    });
    expect(item.assets[1]).toMatchObject({ id: "778", updateId: "9002" });
    expect(item.assets[2]).toMatchObject({ id: "779", updateId: "9002" });
  });

  it("errors when the item is missing", async () => {
    const f = fakeFetch({ data: { items: [] } });
    await expect(new MondayClient(TOKEN, f.fetch).getItem("999")).rejects.toThrow(/Item 999 was not found/);
  });

  it("retries without assets_source when the API rejects that argument", async () => {
    const f = fakeFetch(
      { errors: [{ message: 'Unknown argument "assets_source" on field "assets" of type "Item".' }] },
      { data: { items: [{ id: "7", name: "Ticket", board: { id: "1", name: "B" }, column_values: [], assets: [], updates: [] }] } },
    );
    const item = await new MondayClient(TOKEN, f.fetch).getItem("7");
    expect(item.name).toBe("Ticket");
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.calls[1])).not.toContain("assets_source");
  });
});

describe("MondayClient.downloadAsset", () => {
  it("downloads a public URL without the monday token", async () => {
    const f = fakeMonday([], { [fileUrl("777")]: { body: PNG, headers: { "content-type": "image/png" } } });
    const got = await new MondayClient(TOKEN, f.fetch).downloadAsset(fileUrl("777"));
    expect(Array.from(got.bytes)).toEqual(Array.from(PNG));
    expect(got.contentType).toBe("image/png");
    expect(f.calls).toHaveLength(0);
    expect(f.downloads).toHaveLength(1);
    expect(f.downloads[0]!.url).toBe(fileUrl("777"));
    expect(f.downloads[0]!.method ?? "GET").toBe("GET");
    expect(f.downloads[0]!.headers.get("authorization")).toBeNull();
    expect([...f.downloads[0]!.headers.keys()]).toEqual([]);
  });

  it("only downloads https URLs", async () => {
    const f = fakeMonday([]);
    const client = new MondayClient(TOKEN, f.fetch);
    for (const url of ["http://files.example.com/a.png", "file:///etc/passwd", "not a url", ""]) {
      await expect(client.downloadAsset(url)).rejects.toThrow(/https/);
    }
    expect(f.downloads).toHaveLength(0);
  });

  it("refuses files over the attachment size limit, by header or while reading", async () => {
    const declared = fakeMonday([], {
      [fileUrl("1")]: { body: "small", headers: { "content-length": String(ATTACHMENT_LIMITS.maxFileBytes + 1) } },
    });
    await expect(new MondayClient(TOKEN, declared.fetch).downloadAsset(fileUrl("1"))).rejects.toThrow(/larger than 20 MB/);

    const streamed = fakeMonday([], { [fileUrl("2")]: { body: "x".repeat(64) } });
    const client = new MondayClient(TOKEN, streamed.fetch);
    await expect(client.downloadAsset(fileUrl("2"), 32)).rejects.toThrow(/larger than/);
    await expect(client.downloadAsset(fileUrl("2"), 64)).resolves.toMatchObject({ bytes: expect.any(Uint8Array) });
  });

  it("reports a failed download without the link or the token", async () => {
    const f = fakeMonday([], { [fileUrl("1")]: { status: 403, body: `AccessDenied ${TOKEN}` } });
    const err = (await new MondayClient(TOKEN, f.fetch).downloadAsset(fileUrl("1")).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain("X-Amz-Signature");
    expect(err.message).not.toContain(TOKEN);

    const throwing = vi.fn(async (url: unknown) => {
      throw new Error(`connect failed for ${String(url)} with ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err2 = (await new MondayClient(TOKEN, throwing).downloadAsset(fileUrl("1")).catch((e: Error) => e)) as Error;
    expect(err2.message).toMatch(/download failed/i);
    expect(err2.message).not.toContain("X-Amz-Signature");
    expect(err2.message).not.toContain(TOKEN);
  });
});

describe("monday_get_item", () => {
  it("summarises the item: title, link, board/group, columns, updates newest first and files", async () => {
    const f = fakeFetch(itemResponse());
    const r = await handlersWith(f.fetch).monday_get_item({ item_id: "501" });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain("Login bug on Safari");
    expect(text).toContain("https://acme.monday.com/boards/11/pulses/501");
    expect(text).toMatch(/Bugs \(id 11\)/);
    expect(text).toMatch(/New \(id topics\)/);
    expect(text).toContain("Status: Working on it");
    expect(text).toContain("Owner: Sam Lee");
    // Status first; empty columns left out.
    expect(text.indexOf("Status: Working on it")).toBeLessThan(text.indexOf("Owner: Sam Lee"));
    expect(text).not.toMatch(/Due:/);
    expect(text).not.toMatch(/^- Files:/m);
    // Updates newest first, with author and date; replies under their update.
    expect(text).toMatch(/2026-11-17 11:00 UTC.*Sam Lee/);
    expect(text).toMatch(/2026-11-17 10:20 UTC.*Dana Cohen/);
    expect(text.indexOf("Also broken on iOS.")).toBeLessThan(text.indexOf("Thanks & noted"));
    expect(text.indexOf("Thanks & noted")).toBeLessThan(text.indexOf("Users can't log in on Safari."));
    // Files with name, size and asset id, each once.
    expect(text).toMatch(/screenshot\.png · 120 KB · asset id 777/);
    expect(text).toMatch(/spec\.html · 3 KB · asset id 778/);
    expect(text).toMatch(/trace\.txt · 1 KB · asset id 779/);
    expect(text.match(/asset id 777/g)).toHaveLength(1);
    expect(text).toContain("monday_attach_files");
    // Never the pre-signed links.
    expect(text).not.toContain("X-Amz-Signature");
  });

  it("says when there are no updates or files and shows a non-active state", async () => {
    const f = fakeFetch(itemResponse({ assets: [], updates: [], state: "archived" }));
    const text = textOf(await handlersWith(f.fetch).monday_get_item({ item_id: "501" }));
    expect(text).toMatch(/State: archived/);
    expect(text).toMatch(/Updates: none/);
    expect(text).toMatch(/Files: none/);
  });

  it("enforces the board allowlist on the item's board", async () => {
    const f = fakeFetch(itemResponse({ board: { id: "99", name: "Secret" } }));
    const r = await handlersWith(f.fetch, { allowedBoardIds: ["11"] }).monday_get_item({ item_id: "501" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/board 99 is not one of the allowed monday\.com boards/i);
    expect(textOf(r)).not.toContain("Also broken");
    expect(textOf(r)).not.toContain("Login bug");
  });

  it("rejects an item id that is not a number, and reports a missing item", async () => {
    const f = fakeFetch({ data: { items: [] } });
    const h = handlersWith(f.fetch);
    const bad = await h.monday_get_item({ item_id: "https://acme.monday.com/boards/11/pulses/501" });
    expect(bad.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const missing = await h.monday_get_item({ item_id: "999" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/Item 999 was not found/);
  });

  it("caps the output, keeping the original description and the file list", async () => {
    const updates = Array.from({ length: 25 }, (_, i) => ({
      id: String(9500 - i),
      created_at: `2026-11-${String(30 - i).padStart(2, "0")}T09:00:00Z`,
      text_body: `${i === 24 ? "ORIGINAL DESCRIPTION " : `Comment ${i} `}${"lorem ipsum ".repeat(600)}`,
      body: "",
      creator: { name: "Dana Cohen" },
      assets: [],
      replies: [],
    }));
    const f = fakeFetch(itemResponse({ updates }));
    const text = textOf(await handlersWith(f.fetch).monday_get_item({ item_id: "501" }));
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain("ORIGINAL DESCRIPTION");
    expect(text).toContain("Comment 0 ");
    expect(text).toMatch(/omitted/);
    expect(text).toMatch(/latest 25 updates/);
    expect(text).toContain("asset id 777");
  });
});

describe("monday_attach_files", () => {
  const html = "<h1>Spec</h1>";
  const zip = zipSync({
    "mobile/index.html": strToU8("<p>mobile</p>"),
    "mobile/logo.png": PNG,
    "mobile/font.woff2": new Uint8Array([0, 1, 2, 3]),
  });

  function setup(opts: { assets: ReturnType<typeof rawAsset>[]; files: Record<string, CannedFile>; extra?: Partial<MondayToolOptions> }) {
    const f = fakeMonday([itemResponse({ assets: opts.assets, updates: [] })], opts.files);
    const added: NewAttachment[] = [];
    const addAttachment = vi.fn<AddAttachment>(async (file) => {
      added.push(file);
      return {
        ok: true,
        info: {
          id: `a-0000000${added.length}`,
          name: file.name,
          mime: file.mime,
          size: file.bytes.byteLength,
          source: file.source,
          ...(file.sourceId ? { sourceId: file.sourceId } : {}),
          addedAt: "2026-11-18T00:00:00.000Z",
        },
      };
    });
    const h = handlersWith(f.fetch, { addAttachment, ...opts.extra });
    return { f, h, added, addAttachment };
  }

  const contentOf = (r: { content: unknown }) =>
    r.content as { type: string; text?: string; data?: string; mimeType?: string }[];

  it("stores every file in the conversation and shows images, text and zip contents", async () => {
    const { f, h, added } = setup({
      assets: [
        rawAsset("1", "shot.png", PNG.length),
        rawAsset("2", "spec.html", html.length),
        rawAsset("3", "Mobile.zip", zip.length),
        rawAsset("4", "clip.mov", 10),
      ],
      files: {
        [fileUrl("1")]: { body: PNG, headers: { "content-type": "image/png" } },
        [fileUrl("2")]: { body: html, headers: { "content-type": "binary/octet-stream" } },
        [fileUrl("3")]: { body: zip },
        [fileUrl("4")]: { body: new Uint8Array(10) },
      },
    });
    const r = await h.monday_attach_files({ item_id: "501" });
    expect(r.isError).toBeFalsy();

    // Stored for the team, tagged with the monday asset id.
    expect(added.map((a) => [a.name, a.source, a.sourceId, a.mime])).toEqual([
      ["shot.png", "monday", "1", "image/png"],
      ["spec.html", "monday", "2", "text/html"],
      ["Mobile.zip", "monday", "3", "application/zip"],
      ["clip.mov", "monday", "4", "video/quicktime"],
    ]);
    expect(Buffer.from(added[1]!.bytes).toString("utf8")).toBe(html);
    expect(Array.from(added[0]!.bytes)).toEqual(Array.from(PNG));

    // The pre-signed links are fetched without the token.
    expect(f.downloads.map((d) => d.url)).toEqual(["1", "2", "3", "4"].map(fileUrl));
    expect(f.downloads.every((d) => d.headers.get("authorization") === null)).toBe(true);

    const content = contentOf(r);
    expect(content.filter((c) => c.type === "image")).toEqual([
      { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
    ]);
    const text = textOf(r);
    expect(text).toContain(html);
    expect(text).toContain("<p>mobile</p>");
    expect(text).toContain("Mobile.zip › mobile/index.html");
    expect(text).toMatch(/mobile\/logo\.png/);
    expect(text).toMatch(/mobile\/font\.woff2/);
    expect(text).toMatch(/clip\.mov/);
    expect(text).toMatch(/stored in this conversation/i);
    expect(text).not.toContain("X-Amz-Signature");
  });

  it("attaches only the asset ids given, and says which ids are not on the item", async () => {
    const { f, h, added } = setup({
      assets: [rawAsset("1", "a.txt", 5), rawAsset("2", "b.txt", 5)],
      files: { [fileUrl("2")]: { body: "bbbbb" } },
    });
    const r = await h.monday_attach_files({ item_id: "501", asset_ids: ["2", "55"] });
    expect(r.isError).toBeFalsy();
    expect(f.downloads.map((d) => d.url)).toEqual([fileUrl("2")]);
    expect(added.map((a) => a.sourceId)).toEqual(["2"]);
    expect(textOf(r)).toMatch(/55.*not one of this item's files/);
    expect(textOf(r)).toContain("bbbbb");
  });

  it("refuses more than 10 asset ids, and attaches at most 10 files when none are given", async () => {
    const many = Array.from({ length: 12 }, (_, i) => rawAsset(String(i + 1), `f${i + 1}.txt`, 1));
    const files = Object.fromEntries(many.map((a) => [a.public_url, { body: "x" }]));
    const { f, h } = setup({ assets: many, files });
    const tooMany = await h.monday_attach_files({ item_id: "501", asset_ids: many.map((a) => a.id) });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toMatch(/at most 10/);
    expect(f.calls).toHaveLength(0);

    const { f: f2, h: h2 } = setup({ assets: many, files });
    const r = await h2.monday_attach_files({ item_id: "501" });
    expect(f2.downloads).toHaveLength(10);
    expect(textOf(r)).toMatch(/12 files/);
    expect(textOf(r)).toMatch(/asset_ids/);
    expect(textOf(r)).toMatch(/\b11\b.*\b12\b/);
  });

  it("still returns the contents when files cannot be stored for the team", async () => {
    const f = fakeMonday([itemResponse({ assets: [rawAsset("2", "spec.html", html.length)], updates: [] })], {
      [fileUrl("2")]: { body: html },
    });
    const r = await handlersWith(f.fetch).monday_attach_files({ item_id: "501" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(html);
    expect(textOf(r)).toMatch(/could not be stored for the team/i);
  });

  it("reports a file the store refuses, and still shows it", async () => {
    const f = fakeMonday([itemResponse({ assets: [rawAsset("2", "spec.html", html.length)], updates: [] })], {
      [fileUrl("2")]: { body: html },
    });
    const h = handlersWith(f.fetch, {
      addAttachment: async () => ({ ok: false, error: "This thread already has 40 files; start a new thread for more." }),
    });
    const r = await h.monday_attach_files({ item_id: "501" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/not stored.*40 files/);
    expect(textOf(r)).toContain(html);
  });

  it("caps each text file at about 40 000 characters", async () => {
    const big = "a".repeat(50_000);
    const { h, added } = setup({ assets: [rawAsset("2", "big.txt", big.length)], files: { [fileUrl("2")]: { body: big } } });
    const r = await h.monday_attach_files({ item_id: "501" });
    const fileBlock = contentOf(r).find((c) => c.type === "text" && c.text?.includes("aaaa"))!;
    expect(fileBlock.text!.length).toBeLessThan(41_000);
    expect(fileBlock.text).toMatch(/truncated/);
    // The stored copy is complete.
    expect(added[0]!.bytes.byteLength).toBe(50_000);
  });

  it("does not send a file as an image unless its bytes are one, and uses the real image type", async () => {
    const { h, added } = setup({
      assets: [rawAsset("1", "photo.jpg", PNG.length), rawAsset("2", "fake.png", 4)],
      files: { [fileUrl("1")]: { body: PNG }, [fileUrl("2")]: { body: "nope" } },
    });
    const r = await h.monday_attach_files({ item_id: "501" });
    const images = contentOf(r).filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/png");
    expect(textOf(r)).toMatch(/photo\.jpg.*as photo\.png/);
    // Stored under a name that matches its bytes; the fake image is not stored at all.
    expect(added.map((a) => [a.name, a.mime])).toEqual([["photo.png", "image/png"]]);
    expect(textOf(r)).toMatch(/fake\.png.*not stored/);
  });

  it("skips files over the size limit without downloading them, and reports failed downloads", async () => {
    const { f, h, added } = setup({
      assets: [rawAsset("1", "huge.psd", ATTACHMENT_LIMITS.maxFileBytes + 1), rawAsset("2", "gone.txt", 5)],
      files: { [fileUrl("2")]: { status: 403, body: "expired" } },
    });
    const r = await h.monday_attach_files({ item_id: "501" });
    expect(f.downloads.map((d) => d.url)).toEqual([fileUrl("2")]);
    expect(added).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/huge\.psd.*larger than 20 MB/);
    expect(textOf(r)).toMatch(/gone\.txt.*HTTP 403/);
  });

  it("enforces the board allowlist before downloading anything", async () => {
    const f = fakeMonday([itemResponse({ board: { id: "99", name: "Secret" } })], { [fileUrl("777")]: { body: PNG } });
    const addAttachment = vi.fn<AddAttachment>();
    const r = await handlersWith(f.fetch, { allowedBoardIds: ["11"], addAttachment }).monday_attach_files({ item_id: "501" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/board 99 is not one of the allowed/i);
    expect(f.downloads).toHaveLength(0);
    expect(addAttachment).not.toHaveBeenCalled();
  });

  it("says when the item has no files", async () => {
    const f = fakeMonday([itemResponse({ assets: [], updates: [] })]);
    const r = await handlersWith(f.fetch).monday_attach_files({ item_id: "501" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/has no files/);
  });
});
