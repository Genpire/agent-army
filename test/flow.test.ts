import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey } from "../src/crypto.js";
import { MemoryRepo } from "../src/memory.js";
import { MONDAY_API_URL } from "../src/monday.js";
import { NOTES_MAX_CHARS } from "../src/notes.js";
import type { SlackDeps, SlackMessageEvent } from "../src/pointer-types.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/store.js";
import type { AgentSpec, Team } from "../src/team.js";

// The real Slack layer would call Slack and Claude. Record what the server hands
// it instead, and never settle, which proves /slack/events answers without waiting.
const dispatched = vi.hoisted(() => [] as Array<{ event: SlackMessageEvent; deps: SlackDeps }>);
vi.mock("../src/dispatch.js", () => ({
  handleSlackEvent: (event: SlackMessageEvent, deps: SlackDeps) => {
    dispatched.push({ event, deps });
    return new Promise<void>(() => {});
  },
  // Console chat answers share Slack's concurrency limit; unlimited here.
  withBrainSlot: <T>(fn: () => Promise<T>) => fn(),
}));

const SIGNING_SECRET = "0123456789abcdef0123";

const designer: AgentSpec = {
  id: "designer",
  name: "Dana",
  role: "Designer",
  emoji: ":art:",
  description: "Designs screens, flows and visual assets for the product.",
  instructions: "You are the Designer. Propose clear, accessible UI and explain the reasoning.",
  access: "read",
  model: "",
  enabled: true,
};

/** End-to-end through the real HTTP API (credential checks stubbed, Slack layer faked). */
describe("admin API and Slack events", () => {
  let base = "";
  let dir = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) =>
    fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const state = async () => (await get("/api/state")).json();
  const team = async (): Promise<Team> => (await state()).config.team;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    dir = await mkdtemp(join(tmpdir(), "army-flow-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  describe("onboarding", () => {
    it("requires the setup token, then locks setup", async () => {
      expect((await (await fetch(base + "/api/state")).json()).setupRequired).toBe(true);
      expect((await post("/api/setup", { setupToken: "nope", password: "longpassword1" })).status).toBe(403);
      expect((await post("/api/setup", { setupToken: "setup-123", password: "short" })).status).toBe(400);
      const ok = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
      expect(ok.status).toBe(200);
      cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
      expect((await post("/api/setup", { setupToken: "setup-123", password: "anotherpassword" })).status).toBe(409);
    });

    it("rejects admin routes without a session", async () => {
      expect((await post("/api/anthropic", { apiKey: "sk-ant-0123456789" }, false)).status).toBe(401);
      expect((await get("/api/tasks", false)).status).toBe(401);
      expect((await post("/api/team", { pointer: {}, agents: [] }, false)).status).toBe(401);
      expect((await get("/api/memory", false)).status).toBe(401);
      expect((await post("/api/memory/delete", { id: "m-1" }, false)).status).toBe(401);
      expect((await post("/api/settings", { orgName: "x" }, false)).status).toBe(401);
      expect((await get("/api/slack/manifest", false)).status).toBe(401);
      expect((await get("/api/notes", false)).status).toBe(401);
      expect((await get("/api/notes/acme/web", false)).status).toBe(401);
      expect((await post("/api/notes", { repo: "acme/web", text: "x" }, false)).status).toBe(401);
      expect((await post("/api/monday", { token: "eyJ0123456789abcdefghij" }, false)).status).toBe(401);
      expect((await post("/api/monday/disconnect", {}, false)).status).toBe(401);
      expect((await get("/api/monday/boards", false)).status).toBe(401);
      expect((await post("/api/github/connections", { token: "github_pat_0123456789abcdefghij", allowed: [] }, false)).status).toBe(401);
      expect((await post("/api/github/connections/update", { id: "gh-abc123", allowed: [] }, false)).status).toBe(401);
      expect((await post("/api/github/connections/delete", { id: "gh-abc123" }, false)).status).toBe(401);
      const anonymous = await (await get("/api/state", false)).json();
      expect(anonymous.config).toBeUndefined();
    });

    it("logs in and completes onboarding", async () => {
      expect((await post("/api/login", { password: "wrong" }, false)).status).toBe(403);
      expect((await post("/api/login", { password: "longpassword1" }, false)).status).toBe(200);
      expect((await post("/api/anthropic", { apiKey: "sk-ant-0123456789abcd" })).status).toBe(200);
      expect((await post("/api/slack", { botToken: "nope", signingSecret: SIGNING_SECRET })).status).toBe(400);
      expect((await post("/api/slack", { botToken: "xoxb-1-2-abc", signingSecret: SIGNING_SECRET })).status).toBe(200);
      expect((await post("/api/github", { token: "github_pat_0123456789abcdefghij", allowedOwners: ["acme"] })).status).toBe(200);
      expect((await post("/api/settings", { orgName: "Acme", bindings: { C123: "acme/web" } })).status).toBe(200);
      expect((await post("/api/settings", { bindings: { C123: "bad repo" } })).status).toBe(400);

      const s = await state();
      expect(s.ready).toBe(true);
      expect(s.config.bindings).toEqual({ C123: "acme/web" });
      expect(s.config.slack.pointerChannels).toEqual([]);
      expect(s.eventsUrl).toBe(`${base}/slack/events`);
      expect(JSON.stringify(s)).not.toContain("0123456789abcdefghij");
    });

    it("names the Slack app after Pointer unless a name is given", async () => {
      const { manifest } = await (await get("/api/slack/manifest")).json();
      expect(manifest.settings.event_subscriptions.request_url).toBe(`${base}/slack/events`);
      expect(manifest.display_information.name).toBe("Pointer");
      const named = await (await get("/api/slack/manifest?name=Acme%20Bot")).json();
      expect(named.manifest.display_information.name).toBe("Acme Bot");
    });
  });

  describe("team", () => {
    it("saves a renamed agent and a new one, and the app name follows Pointer's", async () => {
      const current = await team();
      const agents = current.agents.map((a) => (a.id === "coder" ? { ...a, name: "Sara" } : a));
      const res = await post("/api/team", { pointer: { ...current.pointer, name: "Scout" }, agents: [...agents, designer] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const saved = await team();
      expect(saved.pointer.name).toBe("Scout");
      expect(saved.agents.find((a) => a.id === "coder")?.name).toBe("Sara");
      expect(saved.agents.at(-1)).toEqual({ ...designer, effort: "", skills: [], avatar: "" });

      const { manifest } = await (await get("/api/slack/manifest")).json();
      expect(manifest.display_information.name).toBe("Scout");
    });

    it("rejects an invalid team and names the agent at fault", async () => {
      const current = await team();
      const save = async (agents: unknown[]) => {
        const res = await post("/api/team", { pointer: current.pointer, agents });
        return { status: res.status, error: (await res.json()).error as string };
      };

      expect(await save([...current.agents, designer])).toEqual({
        status: 400,
        error: 'Agent "designer": Duplicate agent id "designer"',
      });
      expect(await save([...current.agents, { ...designer, id: "explore" }])).toEqual({
        status: 400,
        error: 'Agent "explore": That agent id is reserved',
      });
      const others = current.agents.filter((a) => a.id !== "designer");
      expect(await save([...others, { ...designer, description: "short" }])).toEqual({
        status: 400,
        error: 'Agent "designer": Describe when Pointer should use this agent',
      });
      const { id: _id, ...noId } = designer;
      const missing = await save([...others, noId]);
      expect(missing.status).toBe(400);
      expect(missing.error).toMatch(new RegExp(`^Agent #${others.length + 1}: `));

      expect((await team()).agents).toEqual(current.agents);
    });

    it("accepts a team larger than the default request limit", async () => {
      const current = await team();
      const agents = Array.from({ length: 20 }, (_, i) => ({
        ...designer,
        id: `helper-${i}`,
        instructions: `Helper ${i}. ${"Follow the house style. ".repeat(260)}`.slice(0, 6000),
      }));
      expect(JSON.stringify(agents).length).toBeGreaterThan(110_000);
      expect((await post("/api/team", { pointer: current.pointer, agents })).status).toBe(200);
      expect((await team()).agents).toHaveLength(20);
    });
  });

  describe("memory", () => {
    it("lists and deletes saved facts", async () => {
      const memory = new MemoryRepo(new FsStore(dir), deriveKey("m"));
      const first = await memory.save("The main repo is acme/web.", "U1");
      await memory.save("Deploys happen on Tuesdays.", "U2");
      if (!first.ok) throw new Error(first.error);

      const listed = await (await get("/api/memory")).json();
      expect(listed.max).toBe(100);
      expect(listed.facts.map((f: { text: string }) => f.text)).toEqual([
        "The main repo is acme/web.",
        "Deploys happen on Tuesdays.",
      ]);

      expect((await post("/api/memory/delete", {})).status).toBe(400);
      const deleted = await post("/api/memory/delete", { id: first.fact.id });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      const again = await post("/api/memory/delete", { id: first.fact.id });
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: "Not found." });

      const after = await (await get("/api/memory")).json();
      expect(after.facts.map((f: { text: string }) => f.text)).toEqual(["Deploys happen on Tuesdays."]);
    });
  });

  describe("settings", () => {
    it("merges partial limits field by field", async () => {
      expect((await post("/api/settings", { limits: { maxParallel: 5 } })).status).toBe(200);
      expect((await state()).config.limits).toEqual({ maxTurns: 200, maxBudgetUsd: 15, maxParallel: 5, progressEveryMin: 5, ciWaitMin: 15, ciFixRounds: 2, previewCheck: "visible" });

      expect((await post("/api/settings", { limits: { maxBudgetUsd: 20, progressEveryMin: 0 } })).status).toBe(200);
      expect((await state()).config.limits).toEqual({ maxTurns: 200, maxBudgetUsd: 20, maxParallel: 5, progressEveryMin: 0, ciWaitMin: 15, ciFixRounds: 2, previewCheck: "visible" });

      expect((await post("/api/settings", { limits: { maxParallel: 0 } })).status).toBe(400);
      expect((await post("/api/settings", { limits: { maxTurns: "lots" } })).status).toBe(400);
      expect((await post("/api/settings", { limits: { progressEveryMin: 61 } })).status).toBe(400);
      expect((await post("/api/settings", { limits: { progressEveryMin: 2.5 } })).status).toBe(400);
      expect((await state()).config.limits).toEqual({ maxTurns: 200, maxBudgetUsd: 20, maxParallel: 5, progressEveryMin: 0, ciWaitMin: 15, ciFixRounds: 2, previewCheck: "visible" });
    });

    it("merges and validates the CI wait and fix rounds", async () => {
      expect((await post("/api/settings", { limits: { ciWaitMin: 30 } })).status).toBe(200);
      expect((await state()).config.limits).toEqual({ maxTurns: 200, maxBudgetUsd: 20, maxParallel: 5, progressEveryMin: 0, ciWaitMin: 30, ciFixRounds: 2, previewCheck: "visible" });
      expect((await post("/api/settings", { limits: { ciWaitMin: 0, ciFixRounds: 5 } })).status).toBe(200);
      expect((await state()).config.limits).toMatchObject({ maxParallel: 5, ciWaitMin: 0, ciFixRounds: 5, previewCheck: "visible" });

      for (const limits of [{ ciWaitMin: 61 }, { ciWaitMin: -1 }, { ciWaitMin: 1.5 }]) {
        const res = await post("/api/settings", { limits });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "The wait for checks is a whole number of minutes from 0 to 60." });
      }
      for (const limits of [{ ciFixRounds: 6 }, { ciFixRounds: -1 }, { ciFixRounds: 0.5 }]) {
        const res = await post("/api/settings", { limits });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Fix rounds are a whole number from 0 to 5." });
      }
      expect((await post("/api/settings", { limits: { ciFixRounds: "2" } })).status).toBe(400);
      expect((await state()).config.limits).toMatchObject({ ciWaitMin: 0, ciFixRounds: 5, previewCheck: "visible" });

      expect((await post("/api/settings", { limits: { ciWaitMin: 15, ciFixRounds: 2 } })).status).toBe(200);
      expect((await state()).config.limits).toEqual({ maxTurns: 200, maxBudgetUsd: 20, maxParallel: 5, progressEveryMin: 0, ciWaitMin: 15, ciFixRounds: 2, previewCheck: "visible" });
    });

    it("saves Pointer channels and validates them", async () => {
      const ok = await post("/api/settings", { pointerChannels: ["C0POINTER", "G0PRIVATE", "C0POINTER"] });
      expect(ok.status).toBe(200);
      expect((await state()).config.slack.pointerChannels).toEqual(["C0POINTER", "G0PRIVATE"]);

      const bad = await post("/api/settings", { pointerChannels: ["general"] });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("Channel IDs look like C012ABCDEF");
      const tooMany = Array.from({ length: 101 }, (_, i) => `C${i}`);
      expect((await post("/api/settings", { pointerChannels: tooMany })).status).toBe(400);
      expect((await state()).config.slack.pointerChannels).toEqual(["C0POINTER", "G0PRIVATE"]);

      expect((await post("/api/settings", { pointerChannels: [] })).status).toBe(200);
      expect((await state()).config.slack.pointerChannels).toEqual([]);
    });
  });

  describe("GitHub connections", () => {
    const TOKEN = "github_pat_SECOND_0123456789abcdefghijkl";
    const PRIMARY = "github_pat_0123456789abcdefghij";
    const github = async () => (await state()).config.github;
    const error = async (path: string, input: unknown) => {
      const res = await post(path, input);
      return { status: res.status, error: (await res.json()).error as string };
    };
    let id = "";

    it("adds a connection limited to an exact repo, never showing its token", async () => {
      const res = await post("/api/github/connections", { token: ` ${TOKEN} `, allowed: ["Partner-Co/Acme"] });
      expect(res.status).toBe(200);
      const added = await res.json();
      expect(added).toEqual({ ok: true, id: expect.stringMatching(/^gh-[0-9a-f]{6}$/), login: "test" });
      id = added.id;

      const gh = await github();
      expect(gh.extra).toEqual([{ id, login: "test", allowed: ["Partner-Co/Acme"], key: `••••${TOKEN.slice(-4)}` }]);
      expect(gh.connected).toBe(true);
      expect(JSON.stringify(await state())).not.toContain(TOKEN.slice(0, 20));
    });

    it("edits a connection's allow list", async () => {
      const res = await post("/api/github/connections/update", { id, allowed: ["Partner-Co/Acme", "Partner-Co", "Partner-Co"] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await github()).extra).toEqual([{ id, login: "test", allowed: ["Partner-Co/Acme", "Partner-Co"], key: `••••${TOKEN.slice(-4)}` }]);

      expect((await post("/api/github/connections/update", { id, allowed: ["Partner-Co/Acme"] })).status).toBe(200);
      expect((await github()).extra[0].allowed).toEqual(["Partner-Co/Acme"]);
    });

    it("rejects invalid allow entries and tokens, and unknown ids", async () => {
      const entryError = "Allowed entries are owners (your-org) or exact repos (owner/repo).";
      for (const allowed of [["not a repo"], ["a/b/c"], ["../x"], ["owner/.."], [""]]) {
        expect(await error("/api/github/connections", { token: TOKEN, allowed })).toEqual({ status: 400, error: entryError });
        expect(await error("/api/github/connections/update", { id, allowed })).toEqual({ status: 400, error: entryError });
      }
      expect((await error("/api/github/connections", { token: "short", allowed: [] })).status).toBe(400);
      expect((await error("/api/github/connections", { token: TOKEN, allowed: "owner/repo" })).status).toBe(400);
      expect((await error("/api/github/connections/update", { id: "not-an-id", allowed: [] })).status).toBe(400);
      expect((await error("/api/github/connections/delete", { id: "../../x" })).status).toBe(400);

      expect(await error("/api/github/connections/update", { id: "gh-000000", allowed: [] })).toEqual({ status: 404, error: "Not found." });
      expect(await error("/api/github/connections/delete", { id: "gh-000000" })).toEqual({ status: 404, error: "Not found." });

      expect((await github()).extra).toEqual([{ id, login: "test", allowed: ["Partner-Co/Acme"], key: `••••${TOKEN.slice(-4)}` }]);
    });

    it("keeps at most 10 extra connections", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const res = await post("/api/github/connections", { token: `${TOKEN}-${i}`, allowed: [`someone/repo-${i}`] });
        expect(res.status).toBe(200);
        ids.push((await res.json()).id);
      }
      expect(new Set([id, ...ids]).size).toBe(10);
      expect(await error("/api/github/connections", { token: TOKEN, allowed: [] })).toEqual({
        status: 400,
        error: "At most 10 other GitHub connections. Remove one first.",
      });
      for (const x of ids) expect((await post("/api/github/connections/delete", { id: x })).status).toBe(200);
      expect((await github()).extra.map((x: { id: string }) => x.id)).toEqual([id]);
    });

    it("the primary token and settings accept owners and exact repos, and keep the other connections", async () => {
      const res = await post("/api/github", { token: PRIMARY, allowedOwners: ["Acme", "Partner-Co/Acme"] });
      expect(res.status).toBe(200);
      let gh = await github();
      expect(gh.allowedOwners).toEqual(["Acme", "Partner-Co/Acme"]);
      expect(gh.extra.map((x: { id: string }) => x.id)).toEqual([id]);

      expect((await post("/api/settings", { allowedOwners: ["acme", "someone/some-repo"] })).status).toBe(200);
      gh = await github();
      expect(gh.allowedOwners).toEqual(["acme", "someone/some-repo"]);
      expect(gh.extra.map((x: { id: string }) => x.id)).toEqual([id]);

      const entryError = "Allowed entries are owners (your-org) or exact repos (owner/repo).";
      expect(await error("/api/github", { token: PRIMARY, allowedOwners: ["bad repo"] })).toEqual({ status: 400, error: entryError });
      expect(await error("/api/settings", { allowedOwners: ["a/b/c"] })).toEqual({ status: 400, error: entryError });
      expect((await github()).allowedOwners).toEqual(["acme", "someone/some-repo"]);

      expect((await post("/api/settings", { allowedOwners: ["acme"] })).status).toBe(200);
    });

    it("checks with GitHub that the token can reach each exact repo, without echoing the token", async () => {
      const OTHER = "ghp_classicTOKEN_0123456789abcdefghij";
      const realFetch = globalThis.fetch;
      const calls: { url: string; auth: string | null }[] = [];
      let reachable = false;
      let userStatus = 200;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url === "https://api.github.com/user") return Response.json({ login: "shosh" }, { status: userStatus });
        if (url === "https://api.github.com/repos/Partner-Co/Acme" && reachable) return Response.json({ full_name: "Partner-Co/Acme" });
        return Response.json({ message: "Not Found" }, { status: 404 });
      });
      delete process.env.SKIP_VALIDATION;
      try {
        const denied = await error("/api/github/connections", { token: OTHER, allowed: ["Acme", "Partner-Co/Acme"] });
        expect(denied).toEqual({ status: 400, error: "This token cannot reach Partner-Co/Acme." });
        // Owner entries are not checked; only exact repos are.
        expect(calls).toEqual([
          { url: "https://api.github.com/user", auth: `Bearer ${OTHER}` },
          { url: "https://api.github.com/repos/Partner-Co/Acme", auth: `Bearer ${OTHER}` },
        ]);

        userStatus = 401;
        expect(await error("/api/github/connections", { token: OTHER, allowed: ["Partner-Co/Acme"] })).toEqual({
          status: 400,
          error: "GitHub rejected this token.",
        });
        userStatus = 200;
        expect((await github()).extra).toHaveLength(1);

        reachable = true;
        const res = await post("/api/github/connections", { token: OTHER, allowed: ["Partner-Co/Acme"] });
        expect(res.status).toBe(200);
        const added = await res.json();
        expect(added).toEqual({ ok: true, id: expect.stringMatching(/^gh-[0-9a-f]{6}$/), login: "shosh" });

        // Edits are checked with the connection's own token.
        calls.length = 0;
        expect(await error("/api/github/connections/update", { id: added.id, allowed: ["Partner-Co/other"] })).toEqual({
          status: 400,
          error: "This token cannot reach Partner-Co/other.",
        });
        expect(calls).toEqual([{ url: "https://api.github.com/repos/Partner-Co/other", auth: `Bearer ${OTHER}` }]);

        expect((await post("/api/github/connections/delete", { id: added.id })).status).toBe(200);
      } finally {
        vi.unstubAllGlobals();
        process.env.SKIP_VALIDATION = "1";
      }
    });

    it("removes a connection", async () => {
      const res = await post("/api/github/connections/delete", { id });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await github()).extra).toEqual([]);
      expect((await post("/api/github/connections/delete", { id })).status).toBe(404);
    });
  });

  describe("GitHub webhook secret", () => {
    const SECRET = "whsec-0123456789abcdefghij";
    const error = async (input: unknown) => {
      const res = await post("/api/github/webhook", input);
      return { status: res.status, error: (await res.json()).error as string };
    };

    it("is admin only, and the state gives the webhook URL", async () => {
      expect((await post("/api/github/webhook", { secret: SECRET }, false)).status).toBe(401);
      const s = await state();
      expect(s.githubWebhookUrl).toBe(`${base}/github/webhook`);
      expect(s.config.github.webhook).toEqual({ configured: false });
      expect((await (await get("/api/state", false)).json()).githubWebhookUrl).toBeUndefined();
    });

    it("saves the secret without ever returning it, and removes it", async () => {
      const res = await post("/api/github/webhook", { secret: ` ${SECRET} ` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, url: `${base}/github/webhook` });
      const s = await state();
      expect(s.config.github.webhook).toEqual({ configured: true });
      expect(JSON.stringify(s)).not.toContain(SECRET);

      const removed = await post("/api/github/webhook", { secret: "" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ ok: true, url: `${base}/github/webhook` });
      expect((await state()).config.github.webhook).toEqual({ configured: false });
    });

    it("rejects a short, long, spaced or missing secret and keeps the saved one", async () => {
      expect((await post("/api/github/webhook", { secret: SECRET })).status).toBe(200);
      expect(await error({ secret: "short-secret" })).toEqual({ status: 400, error: "Use a secret of at least 20 characters." });
      expect(await error({ secret: "x".repeat(201) })).toEqual({ status: 400, error: "Use a secret of at most 200 characters." });
      expect(await error({ secret: "has a space 0123456789abc" })).toEqual({ status: 400, error: "Use printable characters without spaces in the secret." });
      expect((await error({ secret: "tab\there-0123456789abcdef" })).status).toBe(400);
      expect((await error({ secret: "ünïcödé-0123456789abcdefg" })).status).toBe(400);
      expect((await error({})).status).toBe(400);
      expect((await error({ secret: 12345678901234567890 })).status).toBe(400);
      expect((await state()).config.github.webhook).toEqual({ configured: true });
      expect((await post("/api/github/webhook", { secret: "" })).status).toBe(200);
    });
  });

  describe("repo setup", () => {
    const setups = async () => (await state()).config.repoSetup as Record<string, unknown>;
    const save = async (input: unknown) => {
      const res = await post("/api/repo-setup", input);
      return { status: res.status, json: await res.json() };
    };
    const SECRET_VALUE = "sk_test_repo_setup_value_0123456789";

    it("is admin only", async () => {
      expect((await post("/api/repo-setup", { repo: "acme/web" }, false)).status).toBe(401);
      expect((await post("/api/repo-setup/delete", { repo: "acme/web" }, false)).status).toBe(401);
    });

    it("creates a setup and returns it without the variables' values", async () => {
      const created = await save({
        repo: "Acme/Web",
        setupCommand: " npm ci ",
        startCommand: "npm run dev",
        appUrl: "http://localhost:3000",
        env: { STRIPE_KEY: SECRET_VALUE, DATABASE_URL: "postgres://localhost/dev" },
      });
      expect(created).toEqual({
        status: 200,
        json: {
          ok: true,
          repoSetup: { setupCommand: "npm ci", startCommand: "npm run dev", appUrl: "http://localhost:3000", envKeys: ["DATABASE_URL", "STRIPE_KEY"] },
        },
      });
      expect(await setups()).toEqual({
        "Acme/Web": { setupCommand: "npm ci", startCommand: "npm run dev", appUrl: "http://localhost:3000", envKeys: ["DATABASE_URL", "STRIPE_KEY"] },
      });
      expect(JSON.stringify(await state())).not.toContain(SECRET_VALUE);
    });

    it("merges field by field, deletes variables with null and keeps the rest", async () => {
      const merged = await save({ repo: "Acme/Web", startCommand: "npm start", env: { DATABASE_URL: null, NODE_ENV: "test" } });
      expect(merged.json.repoSetup).toEqual({
        setupCommand: "npm ci",
        startCommand: "npm start",
        appUrl: "http://localhost:3000",
        envKeys: ["NODE_ENV", "STRIPE_KEY"],
      });

      // Another letter case is the same repo, stored under the name as given now.
      const recased = await save({ repo: "acme/web", appUrl: "" });
      expect(recased.json.repoSetup).toEqual({ setupCommand: "npm ci", startCommand: "npm start", appUrl: "", envKeys: ["NODE_ENV", "STRIPE_KEY"] });
      expect(Object.keys(await setups())).toEqual(["acme/web"]);

      // Deleting a variable that is not there changes nothing.
      expect((await save({ repo: "acme/web", env: { MISSING: null } })).json.repoSetup.envKeys).toEqual(["NODE_ENV", "STRIPE_KEY"]);
    });

    it("rejects invalid input and keeps the saved setup", async () => {
      const before = await setups();
      const error = async (input: unknown) => {
        const { status, json } = await save(input);
        return { status, error: json.error as string };
      };
      expect(await error({ repo: "not a repo" })).toEqual({ status: 400, error: "Repos look like owner/repo." });
      expect(await error({ repo: "../x" })).toEqual({ status: 400, error: "Repos look like owner/repo." });
      expect(await error({ repo: "acme/web", env: { PATH: "/tmp" } })).toEqual({ status: 400, error: "PATH is reserved by the platform." });
      expect(await error({ repo: "acme/web", env: { ANTHROPIC_API_KEY: "x" } })).toEqual({ status: 400, error: "ANTHROPIC_API_KEY is reserved by the platform." });
      expect(await error({ repo: "acme/web", env: { EMPTY: "" } })).toEqual({
        status: 400,
        error: "Empty values are not allowed; send null to delete a variable.",
      });
      expect(await error({ repo: "acme/web", env: { "1BAD": "x" } })).toEqual({
        status: 400,
        error: '"1BAD" is not a variable name: use letters, digits and _, and do not start with a digit.',
      });
      expect(await error({ repo: "acme/web", env: { "BAD-NAME": null } })).toMatchObject({ status: 400 });
      // A "__proto__" name is dropped by the parser, never stored.
      const proto = await fetch(base + "/api/repo-setup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: '{"repo":"acme/web","env":{"__proto__":"x"}}',
      });
      expect((await proto.json()).repoSetup.envKeys).toEqual(["NODE_ENV", "STRIPE_KEY"]);
      expect(await error({ repo: "acme/web", env: { BIG: "x".repeat(10_001) } })).toEqual({
        status: 400,
        error: "Variable values are limited to 10000 characters.",
      });
      expect(await error({ repo: "acme/web", env: { NUM: 5 } })).toMatchObject({ status: 400 });
      expect(await error({ repo: "acme/web", appUrl: "localhost:3000" })).toEqual({
        status: 400,
        error: "The app URL must start with http:// or https://",
      });
      expect(await error({ repo: "acme/web", setupCommand: "x".repeat(2001) })).toEqual({
        status: 400,
        error: "The setup command is limited to 2000 characters.",
      });
      expect(await error({ repo: "acme/web", startCommand: 42 })).toMatchObject({ status: 400 });

      // At most 100 variables in all, counting the ones already saved.
      const many = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`VAR_${i}`, "v"]));
      expect(await error({ repo: "acme/web", env: many })).toEqual({ status: 400, error: "At most 100 variables per repository" });
      expect(await setups()).toEqual(before);

      // A large but valid setup fits through the request size limit.
      const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`BIG_${i}`, "y".repeat(10_000)]));
      const saved = await save({ repo: "acme/big", env: big });
      expect(saved.status).toBe(200);
      expect(saved.json.repoSetup.envKeys).toHaveLength(20);
    });

    it("deletes a setup, and 404s when there is none", async () => {
      const res = await post("/api/repo-setup/delete", { repo: "ACME/web" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(Object.keys(await setups())).toEqual(["acme/big"]);

      const again = await post("/api/repo-setup/delete", { repo: "acme/web" });
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: "Not found." });
      expect((await post("/api/repo-setup/delete", { repo: "bad repo" })).status).toBe(400);
      expect((await post("/api/repo-setup/delete", { repo: "acme/big" })).status).toBe(200);
      expect(await setups()).toEqual({});
    });
  });

  describe("project notes", () => {
    const listNotes = async () => (await get("/api/notes")).json() as Promise<{ notes: { repo: string; chars: number; updatedAt: string }[]; max: number }>;

    it("creates, reads, lists and deletes notes", async () => {
      expect(await listNotes()).toEqual({ notes: [], max: NOTES_MAX_CHARS });

      const created = await post("/api/notes", { repo: "Acme/web.app", text: "  - Tests: npm test\n- Uses pnpm  " });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({ ok: true });
      expect((await post("/api/notes", { repo: "acme/api", text: "Express API" })).status).toBe(200);

      const read = await get("/api/notes/acme/web.app");
      expect(read.status).toBe(200);
      const note = await read.json();
      expect(note).toEqual({ repo: "Acme/web.app", text: "- Tests: npm test\n- Uses pnpm", updatedAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(note.updatedAt))).toBe(false);

      const listed = await listNotes();
      expect(listed.max).toBe(8000);
      expect(listed.notes.map((n) => n.repo).sort()).toEqual(["Acme/web.app", "acme/api"]);
      expect(listed.notes.find((n) => n.repo === "acme/api")).toEqual({ repo: "acme/api", chars: 11, updatedAt: expect.any(String) });

      const deleted = await post("/api/notes", { repo: "acme/api", text: "   " });
      expect(deleted.status).toBe(200);
      const gone = await get("/api/notes/acme/api");
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: "No notes for acme/api yet." });
      expect((await listNotes()).notes.map((n) => n.repo)).toEqual(["Acme/web.app"]);
    });

    it("rejects notes that are too long or for a bad repo, and keeps the old text", async () => {
      const tooLong = await post("/api/notes", { repo: "acme/web.app", text: "x".repeat(NOTES_MAX_CHARS + 1) });
      expect(tooLong.status).toBe(400);
      expect((await tooLong.json()).error).toBe(`Project notes are limited to ${NOTES_MAX_CHARS} characters; condense them.`);

      const badRepo = await post("/api/notes", { repo: "not a repo", text: "hello" });
      expect(badRepo.status).toBe(400);
      expect((await badRepo.json()).error).toBe("Repos look like owner/repo.");

      expect((await post("/api/notes", { repo: "acme/web.app" })).status).toBe(400);
      expect((await post("/api/notes", { repo: 42, text: "hello" })).status).toBe(400);
      expect((await get("/api/notes/bad%20owner/web")).status).toBe(400);

      expect((await (await get("/api/notes/acme/web.app")).json()).text).toBe("- Tests: npm test\n- Uses pnpm");
    });
  });

  describe("monday.com", () => {
    const TOKEN = "eyJmonday-test-token-0123456789abcdef";
    const monday = async () => (await state()).config.monday;

    it("needs a token before board settings, and lists no boards while disconnected", async () => {
      expect(await monday()).toEqual({ connected: false, userName: null, accountName: null, defaultBoardId: null, allowedBoardIds: [], automation: { enabled: false, webhookConfigured: false, boards: {} } });

      const settingsOnly = await post("/api/monday", { defaultBoardId: "123" });
      expect(settingsOnly.status).toBe(400);
      expect(await settingsOnly.json()).toEqual({ error: "Connect monday.com with an API token first." });

      const boards = await get("/api/monday/boards");
      expect(boards.status).toBe(400);
      expect(await boards.json()).toEqual({ error: "monday.com is not connected." });
      expect((await monday()).connected).toBe(false);
    });

    it("connects with a token and saves board settings, never showing the token", async () => {
      const res = await post("/api/monday", { token: ` ${TOKEN} `, allowedBoardIds: ["111", "222", "111"], defaultBoardId: "222" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, userName: "test", accountName: "test" });
      expect(await monday()).toEqual({ connected: true, userName: "test", accountName: "test", defaultBoardId: "222", allowedBoardIds: ["111", "222"], automation: { enabled: false, webhookConfigured: false, boards: {} } });
      expect(JSON.stringify(await state())).not.toContain(TOKEN.slice(-16));

      // Board settings alone keep the connection; empty values clear them.
      expect((await post("/api/monday", { defaultBoardId: "", allowedBoardIds: [] })).status).toBe(200);
      expect(await monday()).toEqual({ connected: true, userName: "test", accountName: "test", defaultBoardId: null, allowedBoardIds: [], automation: { enabled: false, webhookConfigured: false, boards: {} } });
      expect((await post("/api/monday", { defaultBoardId: "333" })).status).toBe(200);
      expect((await monday()).defaultBoardId).toBe("333");
    });

    it("validates the token and board settings", async () => {
      const error = async (input: unknown) => {
        const res = await post("/api/monday", input);
        return { status: res.status, error: (await res.json()).error as string };
      };
      expect(await error({ allowedBoardIds: ["abc"] })).toEqual({ status: 400, error: "Board ids are numbers, like 1234567890." });
      expect(await error({ defaultBoardId: "12x" })).toEqual({ status: 400, error: "Board ids are numbers, like 1234567890." });
      expect((await error({ allowedBoardIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) })).status).toBe(400);
      expect(await error({ allowedBoardIds: ["111"] })).toEqual({
        status: 400,
        error: "The default board must be one of the boards Pointer may use.",
      });
      expect(await error({ token: "short" })).toEqual({ status: 400, error: "That doesn't look like a monday.com API token." });

      expect(await monday()).toEqual({ connected: true, userName: "test", accountName: "test", defaultBoardId: "333", allowedBoardIds: [], automation: { enabled: false, webhookConfigured: false, boards: {} } });
    });

    it("lists boards through the monday.com API, with errors redacted", async () => {
      const realFetch = globalThis.fetch;
      const calls: { auth: string | null; variables: Record<string, unknown> }[] = [];
      let reply: () => Response = () =>
        Response.json({
          data: {
            boards: [
              { id: "111", name: "Bugs", type: "board", workspace: { name: "Engineering" } },
              { id: "222", name: "Roadmap", type: "board", workspace: null },
            ],
          },
        });
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== MONDAY_API_URL) return realFetch(input, init);
        calls.push({ auth: new Headers(init?.headers).get("authorization"), variables: JSON.parse(String(init?.body)).variables });
        return reply();
      });
      try {
        const all = await get("/api/monday/boards");
        expect(all.status).toBe(200);
        expect(await all.json()).toEqual({
          boards: [
            { id: "111", name: "Bugs", workspace: "Engineering" },
            { id: "222", name: "Roadmap" },
          ],
        });
        expect(calls).toEqual([{ auth: TOKEN, variables: { limit: 50, page: 1 } }]);

        const searched = await get("/api/monday/boards?search=bug");
        expect(await searched.json()).toEqual({ boards: [{ id: "111", name: "Bugs", workspace: "Engineering" }] });

        reply = () => Response.json({ errors: [{ message: `Not authenticated: ${TOKEN}` }] }, { status: 500 });
        const failed = await get("/api/monday/boards");
        expect(failed.status).toBe(400);
        const { error } = await failed.json();
        expect(error).toMatch(/^monday\.com API error/);
        expect(error).not.toContain(TOKEN);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("disconnects but keeps the board settings", async () => {
      expect((await post("/api/monday", { defaultBoardId: "111", allowedBoardIds: ["111"] })).status).toBe(200);
      const res = await post("/api/monday/disconnect", {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await monday()).toEqual({ connected: false, userName: null, accountName: null, defaultBoardId: "111", allowedBoardIds: ["111"], automation: { enabled: false, webhookConfigured: false, boards: {} } });

      expect((await get("/api/monday/boards")).status).toBe(400);
      expect((await post("/api/monday", { allowedBoardIds: [] })).status).toBe(400);
    });
  });

  describe("Slack events", () => {
    const signed = (payload: unknown, headers: Record<string, string> = {}) => {
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex");
      return fetch(base + "/slack/events", {
        method: "POST",
        headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig, ...headers },
        body,
      });
    };
    const message: SlackMessageEvent = {
      type: "message",
      channel: "D0DM",
      channel_type: "im",
      user: "U1",
      text: "hello",
      ts: "1700000000.000100",
    };

    it("answers Slack's URL check and rejects unsigned events", async () => {
      const challenge = await fetch(base + "/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
      });
      expect(await challenge.json()).toEqual({ challenge: "abc" });

      const body = JSON.stringify({ type: "event_callback", event_id: "E0", event: message });
      const unsigned = await fetch(base + "/slack/events", { method: "POST", body });
      expect(unsigned.status).toBe(401);
      expect(dispatched).toHaveLength(0);
    });

    it("answers 200 at once and hands message events to the Slack layer in the background", async () => {
      const started = Date.now();
      const res = await signed({ type: "event_callback", event_id: "E1", event: message });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(Date.now() - started).toBeLessThan(1000);

      expect(dispatched).toHaveLength(1);
      const { event, deps } = dispatched[0]!;
      expect(event).toEqual(message);
      expect(deps.memory).toBeInstanceOf(MemoryRepo);
      expect(typeof deps.brain.reply).toBe("function");
      expect(typeof deps.slack).toBe("function");
      expect(deps.configRepo).toBeDefined();
      expect(deps.tasks).toBeDefined();
      expect(deps.runner.kind).toBe("local");
    });

    it("dispatches app_mention too, and drops duplicates, retries and other event types", async () => {
      const mention = { ...message, type: "app_mention", channel: "C123", channel_type: undefined };
      expect((await signed({ type: "event_callback", event_id: "E2", event: mention })).status).toBe(200);
      expect((await signed({ type: "event_callback", event_id: "E2", event: mention })).status).toBe(200);
      expect((await signed({ type: "event_callback", event_id: "E3", event: mention }, { "x-slack-retry-num": "1" })).status).toBe(200);
      expect((await signed({ type: "event_callback", event_id: "E4", event: { type: "reaction_added", user: "U1" } })).status).toBe(200);
      expect(dispatched.map((d) => d.event.type)).toEqual(["message", "app_mention"]);
    });
  });
});
