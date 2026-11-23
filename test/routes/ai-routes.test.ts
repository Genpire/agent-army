import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteView } from "../../src/ai/routing.js";
import type { WorkKind } from "../../src/core/config.js";
import { createApp } from "../../src/server.js";

type Routes = Record<WorkKind, RouteView>;

/** Each kind of work's route (POST /api/ai/routes) through the real HTTP API, with the provider routes that keep it consistent. */
describe("AI routes admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown, withCookie = true) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (path: string, body: unknown = {}, withCookie = true) => send("POST", path, body, withCookie);
  const failure = async (res: Promise<Response>) => {
    const r = await res;
    return { status: r.status, error: ((await r.json()) as { error: string }).error };
  };
  const ai = async () => (await (await send("GET", "/api/state")).json()).config.ai as { chatProvider: string; taskProvider: string; routes: Routes; chat: { ready: boolean } };
  const setRoute = async (kind: string, providers: string[]) => (await (await post("/api/ai/routes", { kind, providers })).json()) as { ok: boolean; routes: Routes };
  const order = (routes: Routes, kind: WorkKind) => routes[kind].steps.map((s) => s.provider);

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-ai-routes-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/api/anthropic", { apiKey: "sk-ant-routes-secret-0001" })).status).toBe(200);
    expect((await post("/api/ai/providers/kimi", { secrets: { apiKey: "sk-kimi-routes-secret-0002" } })).status).toBe(200);
    expect((await post("/api/ai/providers/deepseek", { secrets: { apiKey: "sk-deepseek-routes-secret-0003" } })).status).toBe(200);
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });
  beforeEach(async () => {
    // Every test starts from the defaults: no route of its own, Claude for chat and repo tasks.
    expect((await post("/api/ai/active", { chatProvider: "anthropic", taskProvider: "anthropic" })).status).toBe(200);
    for (const kind of ["chat", "routines", "tasks", "light"]) expect((await post("/api/ai/routes", { kind, providers: [] })).status).toBe(200);
  });

  it("is admin only", async () => {
    expect((await post("/api/ai/routes", { kind: "chat", providers: ["kimi"] }, false)).status).toBe(401);
  });

  it("shows every kind's route in the state, the default ones following the chat and task providers", async () => {
    const state = await ai();
    expect(Object.keys(state.routes).sort()).toEqual(["chat", "light", "routines", "tasks"]);
    for (const kind of ["chat", "routines", "tasks", "light"] as const) {
      expect(state.routes[kind]).toEqual({ custom: false, steps: [{ provider: "anthropic", name: "Claude", ready: true }] });
    }
    expect(state.chat.ready).toBe(true);
  });

  it("validates the kind and the providers", async () => {
    expect(await failure(post("/api/ai/routes", { kind: "meetings", providers: [] }))).toMatchObject({ status: 400, error: expect.stringContaining("chat, routines, tasks, light") });
    expect((await post("/api/ai/routes", { kind: "chat", providers: ["openai"] })).status).toBe(400);
    expect((await post("/api/ai/routes", { kind: "chat" })).status).toBe(400);
    expect((await post("/api/ai/routes", { kind: "chat", providers: ["kimi"], extra: 1 })).status).toBe(400);
    expect(await failure(post("/api/ai/routes", { kind: "chat", providers: ["kimi", "anthropic", "deepseek", "qwen", "zai"] }))).toEqual({
      status: 400,
      error: "A route has at most 4 providers.",
    });
    // Each must be connected and complete, said for the owner.
    expect(await failure(post("/api/ai/routes", { kind: "light", providers: ["kimi", "qwen"] }))).toEqual({
      status: 400,
      error: "Alibaba Qwen (Model Studio) is not set up. Connect it first.",
    });
    expect((await ai()).routes.light.custom).toBe(false);
  });

  it("saves a route in order without repeats, the chat and task providers following the first", async () => {
    const saved = await setRoute("chat", ["kimi", "anthropic", "kimi"]);
    expect(saved.ok).toBe(true);
    expect(saved.routes.chat).toEqual({
      custom: true,
      steps: [
        { provider: "kimi", name: "Kimi", ready: true },
        { provider: "anthropic", name: "Claude", ready: true },
      ],
    });
    // Routines and light work follow the chat route until they have their own.
    expect(order(saved.routes, "routines")).toEqual(["kimi", "anthropic"]);
    expect(saved.routes.routines.custom).toBe(false);
    expect((await ai()).chatProvider).toBe("kimi");
    expect((await ai()).routes).toEqual(saved.routes);

    const tasks = await setRoute("tasks", ["deepseek", "anthropic"]);
    expect(order(tasks.routes, "tasks")).toEqual(["deepseek", "anthropic"]);
    expect((await ai()).taskProvider).toBe("deepseek");
    // A routines or light work route leaves both alone.
    await setRoute("light", ["anthropic"]);
    expect(await ai()).toMatchObject({ chatProvider: "kimi", taskProvider: "deepseek" });

    // Empty: back to the default, the chat provider kept.
    const cleared = await setRoute("chat", []);
    expect(cleared.routes.chat).toEqual({ custom: false, steps: [{ provider: "kimi", name: "Kimi", ready: true }] });
    expect((await ai()).chatProvider).toBe("kimi");
  });

  it("puts the chat or task provider chosen on the providers page first in a route the owner set", async () => {
    await setRoute("chat", ["kimi", "anthropic"]);
    await setRoute("tasks", ["anthropic", "deepseek"]);
    expect((await post("/api/ai/active", { chatProvider: "anthropic", taskProvider: "kimi" })).status).toBe(200);
    const state = await ai();
    expect(order(state.routes, "chat")).toEqual(["anthropic", "kimi"]);
    // Not in the route yet: added first, the route kept to at most 4.
    expect(order(state.routes, "tasks")).toEqual(["kimi", "anthropic", "deepseek"]);
    // Without a route of its own the kind just follows the provider.
    expect((await post("/api/ai/active", { chatProvider: "deepseek" })).status).toBe(200);
    expect(order((await ai()).routes, "chat")).toEqual(["deepseek", "anthropic", "kimi"]);
  });

  it("takes a deleted provider out of every route, and refuses while a kind of work runs on it alone", async () => {
    await setRoute("chat", ["deepseek", "anthropic"]);
    await setRoute("light", ["deepseek"]);
    // Light work has DeepSeek alone.
    expect(await failure(post("/api/ai/providers/deepseek/delete"))).toEqual({
      status: 409,
      error: "DeepSeek runs light work. Choose another provider for light work first.",
    });
    await setRoute("light", ["deepseek", "kimi"]);
    await setRoute("routines", ["kimi", "deepseek"]);
    expect(await (await post("/api/ai/providers/deepseek/delete")).json()).toEqual({ ok: true });
    const state = await ai();
    expect(order(state.routes, "chat")).toEqual(["anthropic"]);
    expect(order(state.routes, "light")).toEqual(["kimi"]);
    expect(order(state.routes, "routines")).toEqual(["kimi"]);
    // Chat started on DeepSeek: it now starts on the next of its route.
    expect(state.chatProvider).toBe("anthropic");

    // Kimi runs repo tasks alone (the task provider, no route of its own), and light work and routines alone.
    expect((await post("/api/ai/active", { taskProvider: "kimi" })).status).toBe(200);
    expect(await failure(post("/api/ai/providers/kimi/delete"))).toEqual({
      status: 409,
      error: "Kimi (Moonshot) runs routines, repo tasks and light work. Choose another provider for routines, repo tasks and light work first.",
    });
    // Put the deleted provider back for the other tests.
    expect((await post("/api/ai/providers/deepseek", { secrets: { apiKey: "sk-deepseek-routes-secret-0003" } })).status).toBe(200);
  });
});
