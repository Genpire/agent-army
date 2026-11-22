import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIPTION } from "../../src/chat/transcribe.js";
import { createApp } from "../../src/server.js";

const GEMINI_KEY = "AIzaSy-office-route-secret-0123456789";
const LINES = [
  { speaker: "pointer", text: "Good game! The checks on acme/web passed." },
  { speaker: "coder", text: "One more round, then the next task." },
];

/** The office talk routes through the real HTTP API (Gemini itself faked). */
describe("Office talk API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const geminiCalls: string[] = [];
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const talk = async (body: unknown) => {
    const res = await post("/api/office/talk", body);
    return { status: res.status, body: await res.json() };
  };
  const save = async (body: unknown) => {
    const res = await post("/api/office/talk/settings", body);
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(TRANSCRIPTION.geminiBase)) return realFetch(input, init);
      geminiCalls.push(url);
      const answer = { candidates: [{ content: { parts: [{ text: JSON.stringify({ lines: LINES }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    });
    const dir = await mkdtemp(join(tmpdir(), "army-office-talk-"));
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
    expect((await post("/api/office/talk", { activityId: "a", kind: "chat", people: ["pointer"] }, false)).status).toBe(401);
    expect((await get("/api/office/talk/settings", false)).status).toBe(401);
    expect((await post("/api/office/talk/settings", { enabled: false, provider: "auto", model: "", dailyMax: 1 }, false)).status).toBe(401);
  });

  it("shows the default settings, in /api/state too", async () => {
    const res = await get("/api/office/talk/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, provider: "auto", model: "", dailyMax: 40, usedToday: 0, available: { gemini: false, chat: false } });
    expect((await (await get("/api/state")).json()).config.office).toEqual({ talk: { enabled: true, provider: "auto", model: "", dailyMax: 40 } });
  });

  it("refuses invalid talk requests: a bad id, an unknown activity or person, too many people", async () => {
    const ok = { activityId: "pingpong:abc-1", kind: "pingpong", people: ["pointer", "coder"] };
    expect(await talk({ ...ok, activityId: "has space" })).toEqual({ status: 400, body: { error: "Activity ids are 1 to 120 letters, digits and : . _ -." } });
    expect((await talk({ ...ok, activityId: "x".repeat(121) })).status).toBe(400);
    expect((await talk({ ...ok, activityId: "" })).status).toBe(400);
    expect(await talk({ ...ok, kind: "darts" })).toEqual({ status: 400, body: { error: 'The activity is "chat", "coffee", "foosball", "pingpong", "pinball".' } });
    expect(await talk({ ...ok, people: ["pointer", "nobody"] })).toEqual({
      status: 400,
      body: { error: '"nobody" is not in the office: people are enabled agents\' ids or "pointer".' },
    });
    expect((await talk({ ...ok, people: [] })).status).toBe(400);
    expect((await talk({ ...ok, people: ["pointer", "coder", "qa", "reviewer"] })).status).toBe(400);
    expect((await talk({ activityId: "a" })).status).toBe(400);
  });

  it("answers unavailable with no model connected, and a conversation once Gemini is, the same for the same activity", async () => {
    const body = { activityId: "pingpong:abc-1", kind: "pingpong", people: ["pointer", "coder", "coder"] };
    expect(await talk(body)).toEqual({ status: 200, body: { lines: [], reason: "unavailable" } });
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY })).status).toBe(200);
    const first = await talk({ ...body, activityId: "pingpong:abc-2" });
    expect(first).toEqual({ status: 200, body: { lines: LINES, provider: "gemini", model: TRANSCRIPTION.geminiModels[0] } });
    expect(await talk({ ...body, activityId: "pingpong:abc-2" })).toEqual(first);
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]).not.toContain(GEMINI_KEY);
    const settings = await (await get("/api/office/talk/settings")).json();
    expect(settings).toMatchObject({ usedToday: 1, available: { gemini: true, chat: false } });
  });

  it("saves the settings and answers as GET; refuses bad ones", async () => {
    const saved = await save({ enabled: false, provider: "gemini", model: "gemini-2.5-flash", dailyMax: 12 });
    expect(saved).toEqual({
      status: 200,
      body: { enabled: false, provider: "gemini", model: "gemini-2.5-flash", dailyMax: 12, usedToday: 1, available: { gemini: true, chat: false } },
    });
    expect(await (await get("/api/office/talk/settings")).json()).toEqual(saved.body);
    expect(await talk({ activityId: "chat:off-1", kind: "chat", people: ["coder", "qa"] })).toEqual({ status: 200, body: { lines: [], reason: "off" } });

    expect(await save({ enabled: true, provider: "auto", model: "bad model", dailyMax: 1 })).toEqual({
      status: 400,
      body: { error: "A model id is letters, digits and . _ : / -, like the CLI's --model takes." },
    });
    // The chat provider takes any model id an AI provider spells.
    expect((await save({ enabled: true, provider: "chat", model: "kimi-k3[1m]", dailyMax: 1 })).status).toBe(200);
    expect((await save({ enabled: true, provider: "gemini", model: "kimi-k3[1m]", dailyMax: 1 })).status).toBe(400);
    expect(await save({ enabled: true, provider: "auto", model: "", dailyMax: 501 })).toEqual({
      status: 400,
      body: { error: "The daily maximum is a whole number of conversations from 0 to 500." },
    });
    expect((await save({ enabled: true, provider: "auto", model: "", dailyMax: 1.5 })).status).toBe(400);
    expect((await save({ enabled: true, provider: "openai", model: "", dailyMax: 1 })).status).toBe(400);
    expect((await save({ provider: "auto", model: "", dailyMax: 1 })).status).toBe(400);
    // The last good save stands.
    expect(await (await get("/api/office/talk/settings")).json()).toMatchObject({ enabled: true, provider: "chat", model: "kimi-k3[1m]", dailyMax: 1 });
  });
});
