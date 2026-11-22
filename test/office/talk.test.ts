import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, ConfigRepo, ConfigSchema } from "../../src/core/config.js";
import { deriveKey, encrypt } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { OfficeTalk, TALK_RATE, TALK_RETRY_MS, type TalkRequest, talkDay, talkDayKey } from "../../src/office/talk.js";
import { UsageRepo } from "../../src/spending/usage.js";
import { type Task, TaskRepo, WEB_CHANNEL, newTaskId } from "../../src/tasks/tasks.js";

const GEMINI_KEY = "AIzaSy-office-gemini-secret-0123456789";
const ANTHROPIC_KEY = "sk-ant-office-secret-0123456789";
const GITHUB_TOKEN = "ghp_officeTalkGithubToken0123456789abcd";
const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const REQ: TalkRequest = { activityId: "pingpong:coder-qa-1", kind: "pingpong", people: ["coder", "qa"] };
const LINES = [
  { speaker: "coder", text: "Nice serve! Did the dark mode PR pass?" },
  { speaker: "qa", text: "All three checks are green." },
];

interface Seen {
  url: string;
  body: { contents: { parts: { text: string }[] }[] };
}

/** Gemini, faked: every call answers `LINES`, priced on gemini-2.5-flash-lite when the owner picks it. */
function fakeGemini(answer: () => Response = () => geminiAnswer(LINES)) {
  const calls: Seen[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return answer();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const geminiAnswer = (lines: unknown) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function setup(over: (c: Config) => void = () => undefined) {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-talk-")));
  const tasks = new TaskRepo(store);
  const usage = new UsageRepo(store, tasks);
  const config = ConfigSchema.parse({});
  config.engines.gemini.apiKey = GEMINI_KEY;
  // A priced model, so costs are not 0 (a model is set only with a chosen provider).
  config.office.talk.provider = "gemini";
  config.office.talk.model = "gemini-2.5-flash-lite";
  over(config);
  const configRepo = { load: async () => config };
  let now = NOW;
  const gemini = fakeGemini();
  const notify = vi.fn(async () => undefined);
  const make = (fetchFn: typeof fetch = gemini.fetch) =>
    new OfficeTalk({ configRepo, store, tasks, usage, spending: { notify }, fetch: fetchFn, now: () => now });
  return { store, tasks, usage, config, gemini, notify, make, talk: make(), at: (ms: number) => void (now = ms) };
}

const task = (over: Partial<Task> = {}): Task => ({
  id: newTaskId(NOW - 3_600_000),
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW - 3_000_000).toISOString(),
  status: "done",
  repo: "acme/web",
  channel: WEB_CHANNEL,
  threadTs: "c-000000001-aaaaaa",
  userId: "admin",
  instruction: "Add a dark mode toggle",
  prUrl: "https://github.com/acme/web/pull/12",
  ci: { state: "passed", fixRounds: 0, names: [], total: 3 },
  agentCosts: { pointer: { usd: 1 }, coder: { usd: 2 } },
  ...over,
});

afterEach(() => void vi.restoreAllMocks());

describe("OfficeTalk", () => {
  it("writes a conversation about the recent work and keeps it: the same activity gets the same lines without another call", async () => {
    const s = await setup();
    await s.tasks.save(task({ report: { title: "Dark mode toggle", summary: "Added the toggle.", verification: "", risks: "" } }));
    const first = await s.talk.talk(REQ);
    expect(first).toEqual({ lines: LINES, provider: "gemini", model: "gemini-2.5-flash-lite" });
    expect(s.gemini.calls).toHaveLength(1);
    expect(s.gemini.calls[0]!.body.contents[0]!.parts[0]!.text).toContain('acme/web: "Dark mode toggle": pull request opened, checks passed.');

    expect(await s.talk.talk(REQ)).toEqual(first);
    // Another instance (a restart, another page) reads it from the store.
    expect(await s.make().talk(REQ)).toEqual(first);
    expect(s.gemini.calls).toHaveLength(1);
    const day = JSON.parse((await s.store.get(talkDayKey(talkDay(NOW))))!.toString("utf8"));
    expect(day.count).toBe(1);
    expect(day.talks).toEqual([expect.objectContaining({ id: REQ.activityId, kind: "pingpong", people: ["coder", "qa"], lines: LINES, provider: "gemini" })]);
  });

  it("sends Gemini a prompt redacted with the platform's secrets: the task records and the people's descriptions", async () => {
    const s = await setup((c) => {
      c.anthropic.apiKey = ANTHROPIC_KEY;
      c.github.token = GITHUB_TOKEN;
      c.team.agents.find((a) => a.id === "qa")!.description = `Tests with ${GITHUB_TOKEN} at hand. More.`;
    });
    await s.tasks.save(
      task({
        instruction: `Rotate ${GITHUB_TOKEN} in the deploy`,
        report: { title: "", summary: `Moved ${ANTHROPIC_KEY} into the vault.`, verification: "", risks: "" },
      }),
    );
    expect((await s.talk.talk(REQ)).lines).toEqual(LINES);
    const sent = s.gemini.calls[0]!.body.contents[0]!.parts[0]!.text;
    expect(sent).toContain('acme/web: "Rotate [redacted] in the deploy": pull request opened, checks passed.');
    expect(sent).toContain("Summary: Moved [redacted] into the vault.");
    expect(sent).toContain("Tests with [redacted] at hand.");
    expect(sent).not.toContain(GITHUB_TOKEN);
    expect(sent).not.toContain(ANTHROPIC_KEY);
  });

  it("answers an activity id's conversation only to a request it fits: the same kind, every speaker one of the people", async () => {
    const s = await setup();
    const first = await s.talk.talk(REQ);
    expect(first.lines).toEqual(LINES);
    // The same people in another order, or with one more, still fit.
    expect(await s.talk.talk({ ...REQ, people: ["qa", "coder"] })).toEqual(first);
    expect(await s.talk.talk({ ...REQ, people: ["qa", "coder", "writer"] })).toEqual(first);
    // Another kind, or a speaker missing: unavailable, and nothing is paid for a second one.
    expect(await s.talk.talk({ ...REQ, kind: "foosball" })).toEqual({ lines: [], reason: "unavailable" });
    expect(await s.talk.talk({ ...REQ, people: ["coder", "writer"] })).toEqual({ lines: [], reason: "unavailable" });
    expect(await s.make().talk({ ...REQ, people: ["coder"] })).toEqual({ lines: [], reason: "unavailable" });
    expect(s.gemini.calls).toHaveLength(1);
  });

  it("answers a running conversation only to a request it fits, and starts no second one", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeGemini();
    const talk = s.make((async (input: string | URL | Request, init?: RequestInit) => {
      await gate;
      return slow.fetch(input, init);
    }) as typeof fetch);
    // What a request answers before the running call ends.
    const soon = (answer: Promise<unknown>) => Promise.race([answer, new Promise((r) => setTimeout(() => r("still waiting"), 100))]);
    const first = talk.talk(REQ);
    await new Promise((r) => setTimeout(r, 20));
    const more = talk.talk({ ...REQ, people: ["writer", "qa", "coder"] });
    expect(await soon(talk.talk({ ...REQ, kind: "chat" }))).toEqual({ lines: [], reason: "unavailable" });
    expect(await soon(talk.talk({ ...REQ, people: ["coder"] }))).toEqual({ lines: [], reason: "unavailable" });
    expect(await soon(more)).toBe("still waiting");
    release();
    expect(await first).toEqual({ lines: LINES, provider: "gemini", model: "gemini-2.5-flash-lite" });
    expect(await more).toEqual(await first);
    expect(slow.calls).toHaveLength(1);
  });

  it("keeps any activity id apart, even one named like an object's own property", async () => {
    const s = await setup();
    expect((await s.talk.talk({ ...REQ, activityId: "constructor" })).lines).toEqual(LINES);
    expect((await s.talk.talk({ ...REQ, activityId: "__proto__" })).lines).toEqual(LINES);
    expect(s.gemini.calls).toHaveLength(2);
    expect((await s.make().talk({ ...REQ, activityId: "__proto__" })).lines).toEqual(LINES);
    expect(s.gemini.calls).toHaveLength(2);
  });

  it("keeps a conversation into the next UTC day", async () => {
    const s = await setup();
    s.at(Date.parse("2026-11-22T23:59:00.000Z"));
    const first = await s.talk.talk(REQ);
    s.at(Date.parse("2026-11-23T20:00:00.000Z"));
    expect(await s.make().talk(REQ)).toEqual(first);
    expect(s.gemini.calls).toHaveLength(1);
  });

  it("writes one conversation at a time per activity: requests for it meanwhile wait for the same one", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeGemini();
    const talk = s.make((async (input: string | URL | Request, init?: RequestInit) => {
      await gate;
      return slow.fetch(input, init);
    }) as typeof fetch);
    const answers = Promise.all([talk.talk(REQ), talk.talk(REQ), talk.talk(REQ)]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b, c] = await answers;
    expect(a).toEqual({ lines: LINES, provider: "gemini", model: "gemini-2.5-flash-lite" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(slow.calls).toHaveLength(1);
  });

  it("stops at the daily maximum, counted in the store", async () => {
    const s = await setup((c) => (c.office.talk.dailyMax = 2));
    expect((await s.talk.talk({ ...REQ, activityId: "a1" })).lines).toHaveLength(2);
    s.at(NOW + 2 * TALK_RATE.windowMs);
    expect((await s.talk.talk({ ...REQ, activityId: "a2" })).lines).toHaveLength(2);
    s.at(NOW + 4 * TALK_RATE.windowMs);
    expect(await s.talk.talk({ ...REQ, activityId: "a3" })).toEqual({ lines: [], reason: "limit" });
    // A new instance reads the count: still over.
    expect(await s.make().talk({ ...REQ, activityId: "a4" })).toEqual({ lines: [], reason: "limit" });
    expect((await s.talk.settings()).usedToday).toBe(2);
    expect(s.gemini.calls).toHaveLength(2);
    // Kept ones are still answered.
    expect((await s.talk.talk({ ...REQ, activityId: "a1" })).lines).toHaveLength(2);
    // A new UTC day starts again.
    s.at(NOW + 86_400_000);
    expect((await s.talk.talk({ ...REQ, activityId: "a5" })).lines).toHaveLength(2);
  });

  it(`starts at most ${TALK_RATE.max} new conversations a minute`, async () => {
    const s = await setup();
    for (let i = 0; i < TALK_RATE.max; i++) expect((await s.talk.talk({ ...REQ, activityId: `r${i}` })).lines).toHaveLength(2);
    expect(await s.talk.talk({ ...REQ, activityId: "r-over" })).toEqual({ lines: [], reason: "limit" });
    s.at(NOW + TALK_RATE.windowMs);
    expect((await s.talk.talk({ ...REQ, activityId: "r-over" })).lines).toHaveLength(2);
    expect(s.gemini.calls).toHaveLength(TALK_RATE.max + 1);
  });

  it("is off when switched off or with a daily maximum of 0, without any call", async () => {
    const off = await setup((c) => (c.office.talk.enabled = false));
    expect(await off.talk.talk(REQ)).toEqual({ lines: [], reason: "off" });
    const zero = await setup((c) => (c.office.talk.dailyMax = 0));
    expect(await zero.talk.talk(REQ)).toEqual({ lines: [], reason: "off" });
    expect(off.gemini.calls).toHaveLength(0);
    expect(zero.gemini.calls).toHaveLength(0);
  });

  it("is unavailable without a provider, and after a failed call does not try that activity again for a while", async () => {
    const none = await setup((c) => (c.engines.gemini.apiKey = undefined));
    expect(await none.talk.talk(REQ)).toEqual({ lines: [], reason: "unavailable" });

    const s = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = fakeGemini(() => new Response(JSON.stringify({ error: { message: `bad request for ${GEMINI_KEY}` } }), { status: 400 }));
    const talk = s.make(broken.fetch);
    expect(await talk.talk(REQ)).toEqual({ lines: [], reason: "unavailable" });
    expect(await talk.talk(REQ)).toEqual({ lines: [], reason: "unavailable" });
    expect(broken.calls).toHaveLength(1);
    // Logged without the key.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("[office] no pingpong talk from gemini: Gemini answered 400");
    expect(String(errors.mock.calls[0]![0])).not.toContain(GEMINI_KEY);
    s.at(NOW + TALK_RETRY_MS);
    await talk.talk(REQ);
    expect(broken.calls).toHaveLength(2);
  });

  it("an answer with fewer than two good lines is unavailable", async () => {
    const s = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const odd = fakeGemini(() => geminiAnswer([{ speaker: "coder", text: "Hi" }, { speaker: "someone-else", text: "Hello" }]));
    expect(await s.make(odd.fetch).talk(REQ)).toEqual({ lines: [], reason: "unavailable" });
  });

  it("counts each conversation's cost with chat, on Gemini, shared between the people talking, and checks the alerts", async () => {
    const s = await setup();
    await s.talk.talk(REQ);
    await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
    const month = await s.usage.month(new Date(NOW));
    // 1000 tokens in and out at $0.10 / $0.40 per million.
    expect(month.chat).toEqual({ usd: 0.0005, count: 1 });
    expect(month.providers).toEqual([expect.objectContaining({ provider: "gemini", usd: 0.0005, chats: 1 })]);
    expect(month.agents.map((a) => [a.agentId, a.usd])).toEqual([
      ["coder", 0.00025],
      ["qa", 0.00025],
    ]);
  });

  it("writes nothing over a used-up spending cap: monthly, the provider's or a speaker's", async () => {
    const monthly = await setup((c) => (c.budget.monthlyUsd = 0.0001));
    await monthly.usage.recordChat(0.0002, new Date(NOW));
    expect(await monthly.talk.talk(REQ)).toEqual({ lines: [], reason: "limit" });
    const provider = await setup((c) => (c.budget.perProviderUsd = { gemini: 0.0001 }));
    await provider.usage.recordChat({ costUsd: 0.0002, provider: "gemini" }, new Date(NOW));
    expect(await provider.talk.talk(REQ)).toEqual({ lines: [], reason: "limit" });
    const agent = await setup((c) => (c.budget.perAgentUsd = { qa: 0.0001 }));
    await agent.usage.recordChat({ costUsd: 0.0002, agentCosts: { qa: { usd: 0.0002 } } }, new Date(NOW));
    expect(await agent.talk.talk(REQ)).toEqual({ lines: [], reason: "limit" });
    expect(monthly.gemini.calls.length + provider.gemini.calls.length + agent.gemini.calls.length).toBe(0);
    // Another agent's cap does not stop these two.
    const other = await setup((c) => (c.budget.perAgentUsd = { writer: 0.0001 }));
    await other.usage.recordChat({ costUsd: 0.0002, agentCosts: { writer: { usd: 0.0002 } } }, new Date(NOW));
    expect((await other.talk.talk(REQ)).lines).toHaveLength(2);
  });

  it("shows the settings with today's count and which providers are there", async () => {
    const s = await setup((c) => (c.anthropic.apiKey = ANTHROPIC_KEY));
    await s.talk.talk(REQ);
    expect(await s.talk.settings()).toEqual({
      enabled: true,
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      dailyMax: 40,
      usedToday: 1,
      available: { gemini: true, chat: true },
    });
  });
});

describe("office talk settings in the config", () => {
  it("default for an older config without them, and keep loading it", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-talk-old-")));
    const key = deriveKey("k");
    // A config saved before the office talk existed.
    await store.put("config.enc", encrypt(key, JSON.stringify({ orgName: "Acme", anthropic: { apiKey: ANTHROPIC_KEY, model: "" } })));
    const repo = new ConfigRepo(store, key, 0);
    const config = await repo.load();
    expect(config.orgName).toBe("Acme");
    expect(config.office.talk).toEqual({ enabled: true, provider: "auto", model: "", dailyMax: 40 });
    // Each config gets its own copy of the defaults.
    config.office.talk.dailyMax = 5;
    expect(ConfigSchema.parse({}).office.talk.dailyMax).toBe(40);
    // A partial setting fills in the rest.
    expect(ConfigSchema.parse({ office: { talk: { enabled: false } } }).office.talk).toEqual({ enabled: false, provider: "auto", model: "", dailyMax: 40 });
  });

  it("load a model set on auto without it: auto always uses the default models", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-talk-auto-")));
    const key = deriveKey("k");
    const talk = { enabled: true, provider: "auto", model: "gemini-2.5-flash", dailyMax: 9 };
    await store.put("config.enc", encrypt(key, JSON.stringify({ office: { talk } })));
    expect((await new ConfigRepo(store, key, 0).load()).office.talk).toEqual({ ...talk, model: "" });
    // A chosen provider keeps its model.
    expect(ConfigSchema.parse({ office: { talk: { ...talk, provider: "gemini" } } }).office.talk.model).toBe("gemini-2.5-flash");
    expect(ConfigSchema.parse({ office: { talk: { ...talk, provider: "chat" } } }).office.talk.model).toBe("gemini-2.5-flash");
  });
});
