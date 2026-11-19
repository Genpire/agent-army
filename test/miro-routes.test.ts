import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MIRO_API_URL } from "../src/miro.js";
import { createApp } from "../src/server.js";

const TOKEN = "eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_route-test-token";
const BOARD = "uXjVOabc123=";
const OTHER = "uXjVOarch42=";

/** The Miro admin routes through the real HTTP API (Miro itself faked). */
describe("Miro admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const state = async () => (await get("/api/state")).json();
  const miro = async () => (await state()).config.miro;
  const error = async (input: unknown) => {
    const res = await post("/api/miro", input);
    return { status: res.status, error: (await res.json()).error as string };
  };

  /** Answers Miro API calls with `reply`; everything else (this test's own requests) goes through. */
  function stubMiro(reply: (path: string, url: URL, init?: RequestInit) => Response) {
    const realFetch = globalThis.fetch;
    const calls: { path: string; query: Record<string, string>; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== MIRO_API_URL) return realFetch(input, init);
      const path = decodeURIComponent(url.pathname);
      calls.push({ path, query: Object.fromEntries(url.searchParams), auth: new Headers(init?.headers).get("authorization") });
      return reply(path, url, init);
    });
    return calls;
  }

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-miro-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    vi.unstubAllGlobals();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    expect((await post("/api/miro", { token: TOKEN }, false)).status).toBe(401);
    expect((await post("/api/miro/disconnect", {}, false)).status).toBe(401);
    expect((await get("/api/miro/boards", false)).status).toBe(401);
  });

  it("needs a token before board settings, and lists no boards while disconnected", async () => {
    expect(await miro()).toEqual({ connected: false, userName: null, teamName: null, key: null, defaultBoardId: null, allowedBoardIds: [] });
    expect(await error({ defaultBoardId: BOARD })).toEqual({ status: 400, error: "Connect Miro with an access token first." });
    const boards = await get("/api/miro/boards");
    expect(boards.status).toBe(400);
    expect(await boards.json()).toEqual({ error: "Miro is not connected." });
  });

  it("connects with a token and saves board settings from ids or links, never showing the token", async () => {
    const res = await post("/api/miro", {
      token: ` ${TOKEN} `,
      // The encoded link is the same board as the first id: kept once.
      allowedBoardIds: [BOARD, `https://miro.com/app/board/${OTHER}/?share_link_id=1`, "https://miro.com/app/board/uXjVOabc123%3D/"],
      defaultBoardId: `https://miro.com/app/board/${OTHER}/`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userName: "test", teamName: "test" });
    expect(await miro()).toEqual({ connected: true, userName: "test", teamName: "test", key: "••••oken", defaultBoardId: OTHER, allowedBoardIds: [BOARD, OTHER] });
    expect(JSON.stringify(await state())).not.toContain(TOKEN.slice(-20));

    // Board settings alone keep the connection; empty values clear them.
    expect((await post("/api/miro", { defaultBoardId: "", allowedBoardIds: [] })).status).toBe(200);
    expect(await miro()).toMatchObject({ connected: true, defaultBoardId: null, allowedBoardIds: [] });
    expect((await post("/api/miro", { defaultBoardId: BOARD })).status).toBe(200);
    expect((await miro()).defaultBoardId).toBe(BOARD);
  });

  it("validates the token and board settings", async () => {
    expect(await error({ token: "short" })).toEqual({ status: 400, error: "That doesn't look like a Miro access token." });
    expect(await error({ token: "has spaces in it 0123456789" })).toEqual({ status: 400, error: "That doesn't look like a Miro access token." });
    expect(await error({ allowedBoardIds: ["https://evil.example/app/board/x=/"] })).toEqual({
      status: 400,
      error: '"https://evil.example/app/board/x=/" is not a Miro board id or link, like https://miro.com/app/board/uXjVOabc123=/.',
    });
    expect((await error({ defaultBoardId: "bad id!" })).error).toMatch(/is not a Miro board id or link/);
    expect((await error({ allowedBoardIds: Array.from({ length: 201 }, (_, i) => `uXjVO${i}abc=`) })).error).toBe("Allow at most 200 boards.");
    expect(await error({ allowedBoardIds: [OTHER] })).toEqual({ status: 400, error: "The default board must be one of the boards Pointer may use." });
    expect(await miro()).toMatchObject({ connected: true, defaultBoardId: BOARD, allowedBoardIds: [] });
  });

  it("checks a new token with Miro: who it is and its scopes", async () => {
    delete process.env.SKIP_VALIDATION;
    let scopes = ["boards:read", "boards:write"];
    const calls = stubMiro((path) => {
      expect(path).toBe("/v1/oauth-token");
      return Response.json({ type: "oAuthToken", user: { name: "Acme Bot", id: "1" }, team: { name: "Acme", id: "2" }, scopes });
    });
    try {
      const res = await post("/api/miro", { token: TOKEN });
      expect(await res.json()).toEqual({ ok: true, userName: "Acme Bot", teamName: "Acme" });
      expect(calls).toEqual([{ path: "/v1/oauth-token", query: {}, auth: `Bearer ${TOKEN}` }]);
      expect(await miro()).toMatchObject({ connected: true, userName: "Acme Bot", teamName: "Acme" });

      scopes = ["boards:read"];
      const missing = await error({ token: `${TOKEN}-2` });
      expect(missing.status).toBe(400);
      expect(missing.error).toMatch(/^This token lacks the boards:write scope\./);
      // The old connection stays.
      expect(await miro()).toMatchObject({ connected: true, userName: "Acme Bot" });
    } finally {
      vi.unstubAllGlobals();
      process.env.SKIP_VALIDATION = "1";
    }
  });

  it("lists boards for the picker, looks up a pasted link, and redacts errors", async () => {
    let fail = false;
    const calls = stubMiro((path) => {
      if (fail) return Response.json({ status: 500, message: `Internal error for ${TOKEN}` }, { status: 500 });
      if (path === "/v2/boards") {
        return Response.json({
          data: [
            { id: BOARD, name: "Sprint 12 retro", team: { name: "Acme" }, viewLink: `https://miro.com/app/board/${BOARD}/` },
            { id: OTHER, name: "Architecture" },
          ],
          total: 2,
        });
      }
      if (path === `/v2/boards/${OTHER}`) return Response.json({ id: OTHER, name: "Architecture", description: "Systems" });
      return Response.json({ message: "Not found" }, { status: 404 });
    });
    try {
      const all = await get("/api/miro/boards");
      expect(all.status).toBe(200);
      expect(await all.json()).toEqual({
        boards: [
          { id: BOARD, name: "Sprint 12 retro", team: "Acme", viewLink: `https://miro.com/app/board/${BOARD}/` },
          { id: OTHER, name: "Architecture" },
        ],
      });
      expect(calls[0]).toEqual({ path: "/v2/boards", query: { limit: "50" }, auth: `Bearer ${TOKEN}` });

      await get("/api/miro/boards?query=retro");
      expect(calls[1]!.query).toEqual({ limit: "50", query: "retro" });

      const linked = await get(`/api/miro/boards?query=${encodeURIComponent(`https://miro.com/app/board/${OTHER}/`)}`);
      expect(await linked.json()).toEqual({ boards: [{ id: OTHER, name: "Architecture", description: "Systems" }] });
      expect(calls[2]!.path).toBe(`/v2/boards/${OTHER}`);

      fail = true;
      const failed = await get("/api/miro/boards");
      expect(failed.status).toBe(400);
      const { error: message } = await failed.json();
      expect(message).toMatch(/^Miro API error \(HTTP 500\)/);
      expect(message).not.toContain(TOKEN);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disconnects but keeps the board settings", async () => {
    expect((await post("/api/miro", { defaultBoardId: BOARD, allowedBoardIds: [BOARD] })).status).toBe(200);
    const res = await post("/api/miro/disconnect", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await miro()).toEqual({ connected: false, userName: null, teamName: null, key: null, defaultBoardId: BOARD, allowedBoardIds: [BOARD] });
    expect((await get("/api/miro/boards")).status).toBe(400);
    expect((await post("/api/miro", { allowedBoardIds: [] })).status).toBe(400);
  });
});
