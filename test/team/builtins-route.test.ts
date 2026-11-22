import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { type AgentSpec, type Team, defaultTeam } from "../../src/team/team.js";

/** GET /api/team/builtins through the real HTTP API, and adding a built-in a saved team lacks through POST /api/team. */
describe("built-in agents API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const savedTeam = async (): Promise<Team> => (await (await get("/api/state")).json()).config.team;
  const builtins = async (): Promise<AgentSpec[]> => (await (await get("/api/team/builtins")).json()).agents;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-builtins-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-builtins", RUNNER: "local" }, { runner: { kind: "local", launch: async () => undefined } });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-builtins", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("is for the signed-in admin only", async () => {
    const res = await get("/api/team/builtins", false);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in first." });
  });

  it("lists the default team's agents, the Failure Reviewer included", async () => {
    const res = await get("/api/team/builtins");
    expect(res.status).toBe(200);
    const agents = await builtins();
    expect(agents).toEqual(defaultTeam().agents);
    expect(agents.map((a) => a.id)).toContain("failure-reviewer");
  });

  it("lists every built-in whatever the saved team has, so the page offers the missing ones, which save as they are", async () => {
    // A team saved before the Failure Reviewer existed, with the Skills Scout deleted.
    const old = await savedTeam();
    const without = old.agents.filter((a) => a.id !== "failure-reviewer" && a.id !== "scout");
    expect((await post("/api/team", { pointer: old.pointer, agents: without })).status).toBe(200);
    expect((await savedTeam()).agents.map((a) => a.id)).not.toContain("failure-reviewer");

    const listed = await builtins();
    expect(listed).toEqual(defaultTeam().agents);
    const taken = new Set((await savedTeam()).agents.map((a) => a.id));
    const missing = listed.filter((a) => !taken.has(a.id));
    expect(missing.map((a) => a.id)).toEqual(["failure-reviewer", "scout"]);

    // The drawer saves the prefilled built-in through the existing save flow.
    const fr = missing[0]!;
    const res = await post("/api/team", { pointer: old.pointer, agents: [...(await savedTeam()).agents, fr] });
    expect(res.status).toBe(200);
    expect((await savedTeam()).agents.find((a) => a.id === "failure-reviewer")).toEqual(fr);
    // Added once: saving it a second time is a duplicate.
    const again = await post("/api/team", { pointer: old.pointer, agents: [...(await savedTeam()).agents, fr] });
    expect(again.status).toBe(400);
  });
});
