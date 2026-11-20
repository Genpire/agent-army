import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Screenshot } from "../src/browser.js";
import { type Config, ConfigRepo, ConfigSchema, resolveMasterKey } from "../src/core/config.js";
import type { ConversationService } from "../src/conversations.js";
import { deriveKey } from "../src/core/crypto.js";
import { MemoryRepo } from "../src/memory.js";
import { type QueryFn, createPointerBrain } from "../src/pointer.js";
import type { PointerActivity, PointerBrain, PointerContext, PointerReply, PointerRequest } from "../src/pointer-types.js";
import { ProgressTracker, type TrackerEvent, browserAction } from "../src/progress.js";
import { ScreenshotRepo, screenshotName } from "../src/screenshots.js";
import { createApp } from "../src/server.js";
import { FsStore, type Store } from "../src/core/store.js";
import {
  TASK_EVENTS_MAX,
  TimelineRecorder,
  addEvent,
  checkItems,
  closeTimeline,
  describeTimeline,
  emptyTimeline,
  enterPhase,
  plainLine,
  readTimeline,
  trackerToEvent,
} from "../src/task-events.js";
import { TaskRepo, isWebTask } from "../src/tasks.js";
import { startThreadTask } from "../src/thread-task.js";
import {
  draftPrBody,
  newScreenshots,
  onboardingError,
  prFooter,
  screenshotsSection,
  stoppedComment,
  taskPrompt,
  taskReport,
} from "../src/worker.js";

// A 1×1 PNG (signature + IHDR is enough for the type check).
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const JPEG = Buffer.from("ffd8ffe000104a46494600", "hex");

/** End-to-end through the HTTP API with a fake brain and runner. */
describe("console chat and repo task routes", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  let store: Store;
  let conversations: ConversationService;
  const launched: string[] = [];
  const calls: PointerRequest[] = [];
  let script: (req: PointerRequest, ctx: PointerContext) => Promise<PointerReply> = async () => ({ text: "Hi! **Bold**", costUsd: 0.02, isError: false });
  const brain: PointerBrain = {
    reply: async (req, ctx) => {
      calls.push(req);
      return script(req, ctx);
    },
  };

  const send = (method: "GET" | "POST", path: string, body?: unknown, withCookie = true) =>
    fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(withCookie && cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) => send("GET", path, undefined, withCookie);
  const post = (path: string, body: unknown = {}, withCookie = true) => send("POST", path, body, withCookie);

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-web-"));
    const runner = { kind: "local" as const, launch: async (id: string) => void launched.push(id) };
    const made = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-web", RUNNER: "local" }, { brain, runner });
    store = made.store;
    conversations = made.conversations;
    const server = made.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const setup = await post("/api/setup", { setupToken: "setup-web", password: "longpassword1" }, false);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/api/anthropic", { apiKey: "sk-ant-0123456789abcd" })).status).toBe(200);
  });
  afterAll(() => close());

  it("requires a session on every new route", async () => {
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations", { text: "hi" }],
      ["GET", "/api/conversations/c-000000000-000000"],
      ["POST", "/api/conversations/c-000000000-000000/messages", { text: "hi" }],
      ["POST", "/api/conversations/c-000000000-000000/delete", {}],
      ["POST", "/api/tasks", { repo: "acme/web", instruction: "x" }],
      ["GET", "/api/tasks/abc-123456/events"],
      ["GET", "/api/tasks/abc-123456/screenshots"],
      ["GET", "/api/tasks/abc-123456/screenshots/a.png"],
    ];
    for (const [method, path, body] of routes) {
      expect((await send(method as "GET" | "POST", path, body, false)).status, `${method} ${path}`).toBe(401);
    }
    expect(calls).toHaveLength(0);
    expect(launched).toHaveLength(0);
  });

  it("creates a conversation (202), answers it and lists it", async () => {
    const res = await post("/api/conversations", { text: "Hello Pointer\nsecond line" });
    expect(res.status).toBe(202);
    const { conversation } = await res.json();
    expect(conversation).toMatchObject({ title: "Hello Pointer", pending: true });

    await conversations.idle();
    const view = await (await get(`/api/conversations/${conversation.id}`)).json();
    expect(view.conversation.pending).toBe(false);
    expect(view.conversation.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ["user", "Hello Pointer\nsecond line"],
      ["pointer", "Hi! **Bold**"],
    ]);
    expect(view.tasks).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ channel: "web", threadTs: conversation.id, userId: "admin", surface: "web" });

    const list = await (await get("/api/conversations")).json();
    expect(list.conversations[0]).toMatchObject({ id: conversation.id, title: "Hello Pointer", messageCount: 2, pending: false });
  });

  it("validates input and answers 409 while Pointer is still answering", async () => {
    expect((await post("/api/conversations", { text: "" })).status).toBe(400);
    expect((await post("/api/conversations", { text: "x".repeat(8001) })).status).toBe(400);
    expect((await post("/api/conversations", {})).status).toBe(400);
    expect((await get("/api/conversations/nope")).status).toBe(404);
    expect((await get("/api/conversations/c-000000000-000000")).status).toBe(404);
    expect((await post("/api/conversations/c-000000000-000000/messages", { text: "hi" })).status).toBe(404);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async () => {
      await gate;
      return { text: "done", isError: false };
    };
    const { conversation } = await (await post("/api/conversations", { text: "slow one" })).json();
    const busy = await post(`/api/conversations/${conversation.id}/messages`, { text: "again" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toContain("still answering");
    release();
    await conversations.idle();
    script = async () => ({ text: "second", isError: false });
    const ok = await post(`/api/conversations/${conversation.id}/messages`, { text: "again" });
    expect(ok.status).toBe(202);
    expect((await ok.json()).conversation.pending).toBe(true);
    await conversations.idle();

    expect((await post(`/api/conversations/${conversation.id}/delete`)).status).toBe(200);
    expect((await post(`/api/conversations/${conversation.id}/delete`)).status).toBe(404);
    expect((await get(`/api/conversations/${conversation.id}`)).status).toBe(404);
  });

  it("starts a direct repo task with the same checks as Slack", async () => {
    expect((await post("/api/tasks", { repo: "acme/web", instruction: "Fix it" })).status).toBe(400); // GitHub not connected
    expect((await post("/api/github", { token: "github_pat_0123456789abcdefghij", allowedOwners: ["acme"] })).status).toBe(200);
    expect((await post("/api/tasks", { repo: "not a repo", instruction: "Fix it" })).status).toBe(400);
    expect((await post("/api/tasks", { repo: "acme/web", instruction: "  " })).status).toBe(400);
    const denied = await post("/api/tasks", { repo: "other/web", instruction: "Fix it" });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toContain("Not allowed to work on other/web");

    const before = calls.length;
    const res = await post("/api/tasks", { repo: "acme/web", instruction: "Fix the login redirect" });
    expect(res.status).toBe(202);
    const { conversationId, taskId } = await res.json();
    expect(launched).toContain(taskId);
    expect(calls).toHaveLength(before);
    const task = await new TaskRepo(store).get(taskId);
    expect(task).toMatchObject({ channel: "web", threadTs: conversationId, trigger: "web", userId: "admin", status: "queued" });
    expect(isWebTask(task!)).toBe(true);

    const view = await (await get(`/api/conversations/${conversationId}`)).json();
    expect(view.conversation.messages.map((m: { role: string; tasks?: string[] }) => [m.role, m.tasks])).toEqual([
      ["user", undefined],
      ["pointer", [taskId]],
    ]);
    expect(view.tasks.map((t: { id: string }) => t.id)).toEqual([taskId]);
  });

  it("serves a task's timeline and screenshots, checking names and types", async () => {
    const { taskId } = await (await post("/api/tasks", { repo: "acme/web", instruction: "Add screenshots" })).json();
    const key = await resolveMasterKey(store, { MASTER_KEY: "m" });
    const shots = new ScreenshotRepo(store, key);
    await shots.add(taskId, [
      { name: "home page.png", bytes: PNG },
      { name: "detail.jpg", bytes: JPEG },
      { name: "fake.png", bytes: Buffer.from("not an image") },
    ]);

    expect(await (await get(`/api/tasks/${taskId}/screenshots`)).json()).toEqual({
      screenshots: [
        { name: "home-page.png", size: PNG.length },
        { name: "detail.jpg", size: JPEG.length },
      ],
    });
    const image = await get(`/api/tasks/${taskId}/screenshots/home-page.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("private");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect((await get(`/api/tasks/${taskId}/screenshots/detail.jpg`)).headers.get("content-type")).toBe("image/jpeg");
    // Stored encrypted.
    expect((await store.get(`screenshots/${taskId}/home-page.png`))!.includes(PNG.subarray(0, 8))).toBe(false);

    expect((await get(`/api/tasks/${taskId}/screenshots/missing.png`)).status).toBe(404);
    expect((await get(`/api/tasks/${taskId}/screenshots/index.enc`)).status).toBe(400);
    expect((await get(`/api/tasks/${taskId}/screenshots/..%2Fsecret.png`)).status).toBe(400);
    expect((await get(`/api/tasks/${taskId}/screenshots/.hidden.png`)).status).toBe(400);
    expect((await get(`/api/tasks/${taskId}/screenshots/a.svg`)).status).toBe(400);
    expect((await get("/api/tasks/zzz-000000/screenshots")).status).toBe(404);
    expect((await get("/api/tasks/..%2F..%2Fconfig/screenshots")).status).toBe(404);

    expect(await (await get(`/api/tasks/${taskId}/events`)).json()).toEqual({ timeline: null });
    const recorder = new TimelineRecorder(store, taskId);
    recorder.enter("clone", "Cloning acme/web");
    recorder.add({ kind: "note", text: "New branch army/x off main" });
    await recorder.flush(true);
    const { timeline } = await (await get(`/api/tasks/${taskId}/events`)).json();
    expect(timeline.phases[0]).toMatchObject({ phase: "clone", state: "active" });
    expect(timeline.events.map((e: { kind: string }) => e.kind)).toEqual(["phase", "note"]);
    expect((await get("/api/tasks/zzz-000000/events")).status).toBe(404);
  });

  it("streams Pointer's activity into the live reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async (_req, ctx) => {
      ctx.onActivity?.({ type: "step", id: "s1", label: "Reading acme/web: README.md", kind: "github" });
      ctx.onActivity?.({ type: "text", delta: "Partial answer" });
      await gate;
      return { text: "Full answer", isError: false };
    };
    const { conversation } = await (await post("/api/conversations", { text: "read the readme" })).json();
    await vi.waitFor(async () => {
      const view = await (await get(`/api/conversations/${conversation.id}`)).json();
      expect(view.live).toMatchObject({ text: "Partial answer", activity: [{ id: "s1", label: "Reading acme/web: README.md", kind: "github" }] });
    });
    release();
    await conversations.idle();
    const view = await (await get(`/api/conversations/${conversation.id}`)).json();
    expect(view.live).toBeUndefined();
    expect(view.conversation.messages.at(-1)).toMatchObject({ text: "Full answer", activity: [expect.objectContaining({ id: "s1" })] });
  });
});

// ---------- Worker helpers for console (web) tasks ----------

describe("worker without Slack", () => {
  const config = (patch: (c: Config) => void = () => undefined): Config => {
    const c = ConfigSchema.parse({});
    patch(c);
    return c;
  };

  it("needs Slack only for Slack tasks", () => {
    const claudeOnly = config((c) => {
      c.anthropic.apiKey = "sk-ant-x";
    });
    expect(onboardingError({ channel: "web" }, claudeOnly)).toBeUndefined();
    expect(onboardingError({ channel: "C123" }, claudeOnly)).toBe("Onboarding is incomplete (Claude or Slack missing).");
    expect(onboardingError({ channel: "web" }, config())).toBe("Onboarding is incomplete (Claude missing).");
    const both = config((c) => {
      c.anthropic.apiKey = "sk-ant-x";
      c.slack.botToken = "xoxb-1";
    });
    expect(onboardingError({ channel: "C123" }, both)).toBeUndefined();
  });

  it("points pull requests and prompts at the console for web tasks", () => {
    expect(prFooter("t-1", "Pointer", "web")).toBe("---\nRequested in the admin console · task `t-1` · built by Pointer and the team. A human must review and merge.");
    expect(prFooter("t-1", "Pointer")).toContain("Requested in Slack");
    expect(screenshotsSection(2, "web")).toBe("### Screenshots\n2 screenshots from the browser checks are in the admin console, on this task in its conversation.");
    expect(draftPrBody({ reason: "Stopped.", plan: [], filesChanged: 1, screenshots: 0, footer: "f", where: "web" })).toContain(
      'Reply in its conversation in the admin console (for example "continue")',
    );
    expect(stoppedComment("Stopped.", [], "web")).toContain("admin console");
    const prompt = taskPrompt({ userId: "admin", instruction: "Fix it", repo: "acme/web", base: "main", branch: "army/x", resumed: false, attachments: 0, where: "web" });
    expect(prompt.split("\n")[0]).toBe("Request from the admin console (the owner):");
    expect(taskPrompt({ userId: "admin", instruction: "x", trigger: "review", repo: "a/b", base: "main", branch: "b", resumed: true, attachments: 0, where: "web" }).split("\n")[0]).toBe(
      "Request from GitHub (user admin):",
    );
  });

  it("keeps the team's report on the task, redacted", () => {
    const redact = (t: string) => t.replace("SECRET", "[redacted]");
    expect(taskReport({ title: "T SECRET", summary: "S", verification: "V", risks: "" }, redact)).toEqual({ title: "T [redacted]", summary: "S", verification: "V", risks: "" });
  });

  it("hands out each screenshot once, by content", () => {
    const seen = new Set<string>();
    const a: Screenshot = { name: "a.png", bytes: Buffer.from("1") };
    expect(newScreenshots([a], seen)).toEqual([a]);
    expect(newScreenshots([a], seen)).toEqual([]);
    const changed: Screenshot = { name: "a.png", bytes: Buffer.from("2") };
    expect(newScreenshots([a, changed], seen)).toEqual([changed]);
  });

  it("saves a web task without posting to Slack", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-webtask-")));
    const tasks = new TaskRepo(store);
    const launched: string[] = [];
    const started = await startThreadTask(
      { tasks, runner: { kind: "local", launch: async (id) => void launched.push(id) } },
      { repo: "acme/web", channel: "web", threadTs: "c-000000001-abcdef", userId: "admin", instruction: " Fix it ", ackText: "", trigger: "web" },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await tasks.get(started.taskId)).toMatchObject({ channel: "web", instruction: "Fix it", trigger: "web", status: "queued" });
    expect((await tasks.get(started.taskId))!.progressTs).toBeUndefined();
    // A Slack task still needs Slack.
    expect(
      await startThreadTask({ tasks, runner: { kind: "local", launch: async () => undefined } }, { repo: "acme/web", channel: "C1", threadTs: "1.2", userId: "U1", instruction: "x", ackText: "ack" }),
    ).toEqual({ ok: false, error: "Could not start the task: Slack is not connected." });
  });
});

describe("screenshots in the store", () => {
  it("makes names safe and unique", () => {
    const taken = new Set<string>();
    expect(screenshotName("pages/home page.PNG", taken)).toBe("pages-home-page.png");
    expect(screenshotName("pages/home page.png", taken)).toBe("pages-home-page-2.png");
    expect(screenshotName("../../etc/passwd", taken)).toBe("etc-passwd.png");
    expect(screenshotName(".hidden.webp", taken)).toBe("hidden.webp");
    expect(screenshotName("…", taken)).toBe("screenshot.png");
  });

  it("lists nothing for unknown tasks and refuses bad names", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-shots-")));
    const repo = new ScreenshotRepo(store, deriveKey("k"));
    expect(await repo.list("abc-123456")).toEqual([]);
    expect(await repo.list("../x")).toEqual([]);
    expect(await repo.get("abc-123456", "../x.png")).toBeNull();
    await repo.add("abc-123456", [{ name: "a.png", bytes: PNG }]);
    await repo.add("abc-123456", [{ name: "a.png", bytes: PNG }]);
    expect((await repo.list("abc-123456")).map((s) => s.name)).toEqual(["a.png", "a-2.png"]);
    expect(await repo.get("abc-123456", "a-2.png")).toEqual(PNG);
  });
});

// ---------- The task timeline ----------

describe("task timeline", () => {
  const at = "2026-11-19T10:00:00.000Z";

  it("caps the events and counts what it dropped", () => {
    const t = emptyTimeline("abc-1");
    for (let i = 0; i < TASK_EVENTS_MAX + 25; i++) addEvent(t, { at, phase: "build", kind: "edit", text: `f${i}` });
    expect(t.events).toHaveLength(TASK_EVENTS_MAX);
    expect(t.dropped).toBe(25);
    expect(t.events[0]!.text).toBe("f25");
  });

  it("moves the stepper forward only, and closes it", () => {
    const t = emptyTimeline("abc-1");
    expect(enterPhase(t, "clone", at)).toBe(true);
    expect(enterPhase(t, "plan", at)).toBe(true);
    expect(t.phases.map((p) => p.state)).toEqual(["done", "skipped", "active", "pending", "pending", "pending", "pending"]);
    expect(enterPhase(t, "clone", at)).toBe(false);
    expect(enterPhase(t, "build", at)).toBe(true);
    closeTimeline(t, true, at);
    expect(t.phases.map((p) => p.state)).toEqual(["done", "skipped", "done", "done", "skipped", "skipped", "skipped"]);

    const failed = emptyTimeline("abc-2");
    enterPhase(failed, "build", at);
    closeTimeline(failed, false, at, "Timed out");
    expect(failed.phases.find((p) => p.phase === "build")).toMatchObject({ state: "failed", note: "Timed out" });

    // Stopped while building, then the work went into a draft: build failed, publish done.
    const draft = emptyTimeline("abc-3");
    enterPhase(draft, "build", at);
    enterPhase(draft, "publish", at);
    closeTimeline(draft, false, at, "Timed out", "build");
    expect(draft.phases.map((p) => [p.phase, p.state])).toEqual([
      ["clone", "skipped"],
      ["setup", "skipped"],
      ["plan", "skipped"],
      ["build", "failed"],
      ["verify", "skipped"],
      ["publish", "done"],
      ["checks", "skipped"],
    ]);
  });

  it("turns tracker events into steps: edits build, browser checks and tests verify", () => {
    expect(trackerToEvent({ kind: "edit", by: ":hammer_and_wrench: Sara (Coder)", path: "src/a.ts" }, at, "plan")).toEqual({
      event: { at, phase: "build", kind: "edit", agent: "Sara (Coder)", text: "src/a.ts" },
      phase: "build",
    });
    expect(trackerToEvent({ kind: "command", by: "Pointer", command: "npm test" }, at, "build").phase).toBe("verify");
    expect(trackerToEvent({ kind: "command", by: "Pointer", command: "ls -la" }, at, "build").phase).toBeUndefined();
    expect(trackerToEvent({ kind: "browser", by: "QA", action: "Opened", detail: "http://localhost:3000" }, at, "build")).toMatchObject({
      phase: "verify",
      event: { kind: "browser", text: "Opened: http://localhost:3000" },
    });
    expect(trackerToEvent({ kind: "agent-done", label: "QA", ms: 1000, isError: true, toolUses: 2 }, at, "verify").event).toMatchObject({ kind: "agent-done", ok: false, ms: 1000 });
    expect(plainLine(":rocket: Pushing\nthe fix")).toBe("Pushing the fix");
  });

  it("lists checks and commit statuses with their states", () => {
    expect(
      checkItems({
        checks: [
          { id: 1, name: "build", status: "completed", conclusion: "success", detailsUrl: "https://ci/1", title: null, summary: null, text: null, app: "github-actions" },
          { id: 2, name: "lint", status: "completed", conclusion: "failure", detailsUrl: "javascript:alert(1)", title: null, summary: null, text: null, app: null },
          { id: 3, name: "e2e", status: "in_progress", conclusion: null, detailsUrl: null, title: null, summary: null, text: null, app: null },
        ],
        statuses: [{ context: "vercel", state: "pending", description: null, targetUrl: "https://vercel.com/x" }],
      } as Parameters<typeof checkItems>[0]),
    ).toEqual([
      { name: "build", state: "passed", url: "https://ci/1" },
      { name: "lint", state: "failed" },
      { name: "e2e", state: "running" },
      { name: "vercel", state: "running", url: "https://vercel.com/x" },
    ]);
  });

  it("records, redacts and writes the timeline at most every few seconds", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-timeline-")));
    const puts: string[] = [];
    const spy: Pick<Store, "put"> = { put: async (k, d) => void (puts.push(k), await store.put(k, d)) };
    let now = Date.parse(at);
    const rec = new TimelineRecorder(spy, "abc-123456", { redact: (t) => t.replace("tok_SECRET", "[redacted]"), now: () => now, everyMs: 3000 });
    rec.enter("clone", "Cloning");
    await rec.flush(true);
    const forced = puts.length;
    rec.add({ kind: "command", agent: "Pointer", text: "curl -H tok_SECRET x" });
    rec.add({ kind: "note", text: "again" });
    await Promise.resolve();
    expect(puts.length).toBe(forced);
    now += 3001;
    await rec.flush();
    expect(puts.length).toBe(forced + 1);
    rec.tracker({ kind: "edit", by: "Sara", path: "src/a.ts" });
    await rec.close(true, "Done");
    const saved = (await readTimeline(store, "abc-123456"))!;
    expect(saved.events.map((e) => e.kind)).toEqual(["phase", "command", "note", "edit", "end"]);
    expect(JSON.stringify(saved)).not.toContain("tok_SECRET");
    expect(saved.phases.find((p) => p.phase === "build")?.state).toBe("done");
    expect(describeTimeline(saved, now)).toContain("Steps: [x] clone");
  });
});

describe("progress tracker events", () => {
  const assistant = (parent: string | null, ...blocks: { id: string; name: string; input: unknown }[]) =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { content: blocks.map((b) => ({ type: "tool_use", ...b })) } }) as unknown as SDKMessage;
  const result = (id: string, content: string) =>
    ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } }) as unknown as SDKMessage;

  it("reports agents, edits, commands and browser steps without changing Slack's progress", () => {
    let now = 0;
    const events: TrackerEvent[] = [];
    const opts = { lead: "Pointer", label: (t: string | undefined) => `:robot_face: ${t}`, repoDir: "/w/repo", now: () => now };
    const withEvents = new ProgressTracker({ ...opts, onEvent: (e) => events.push(e) });
    const plain = new ProgressTracker(opts);
    const messages = [
      assistant(null, { id: "a1", name: "Agent", input: { subagent_type: "coder", description: "Build it", prompt: "Build the toggle\nmore" } }),
      assistant("a1", { id: "e1", name: "Edit", input: { file_path: "/w/repo/src/a.ts" } }),
      assistant("a1", { id: "b1", name: "Bash", input: { command: "npm test" } }),
      assistant("a1", { id: "s1", name: "mcp__browser__browser_take_screenshot", input: { filename: "home.png" } }),
      assistant(null, { id: "e2", name: "Write", input: { file_path: "/w/repo/README.md" } }),
      result("a1", "Built the toggle."),
    ];
    for (const m of messages) {
      now += 60_000;
      expect(withEvents.onMessage(m)).toBe(plain.onMessage(m));
    }
    expect(withEvents.snapshot()).toEqual(plain.snapshot());
    expect(events).toEqual([
      { kind: "agent-start", label: ":robot_face: coder", description: "Build it: Build the toggle" },
      { kind: "edit", by: ":robot_face: coder", path: "src/a.ts" },
      { kind: "command", by: ":robot_face: coder", command: "npm test" },
      { kind: "browser", by: ":robot_face: coder", action: "Took a screenshot", detail: "home.png" },
      { kind: "edit", by: "Pointer", path: "README.md" },
      { kind: "agent-done", label: ":robot_face: coder", ms: 300_000, outcome: "Built the toggle.", isError: false, toolUses: 3 },
    ]);
    expect(browserAction("mcp__browser__browser_navigate", { url: "http://localhost:3000" })).toEqual({ action: "Opened", detail: "http://localhost:3000" });
    expect(browserAction("Bash", {})).toBeUndefined();
  });
});

// ---------- Pointer's brain reports live activity only when asked ----------

describe("Pointer brain activity", () => {
  async function deps() {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-brain-")));
    const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
    await configRepo.update((c) => {
      c.anthropic.apiKey = "sk-ant-secret-123456";
    });
    return { configRepo, memory: new MemoryRepo(store, deriveKey("k")) };
  }
  const stream: unknown[] = [
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "acme" } }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "results" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Answer.", total_cost_usd: 0.01, num_turns: 2, errors: [] },
  ];

  it("streams text and steps to onActivity, with partial messages on", async () => {
    const seen: { includePartialMessages?: boolean }[] = [];
    const queryFn: QueryFn = async function* (params) {
      seen.push({ includePartialMessages: params.options?.includePartialMessages });
      for (const m of stream) yield m as SDKMessage;
    };
    const events: PointerActivity[] = [];
    const req: PointerRequest = { text: "hi", userId: "admin", channel: "web", channelType: "im", threadTs: "c-1", history: [], surface: "web" };
    const reply = await createPointerBrain(await deps(), { queryFn }).reply(req, {
      startRepoTask: async () => ({ ok: false, error: "x" }),
      onActivity: (e) => {
        events.push(e);
        if (e.type === "turn") throw new Error("a listener error must not break the answer");
      },
    });
    expect(reply).toEqual({ text: "Answer.", costUsd: 0.01, isError: false });
    expect(seen).toEqual([{ includePartialMessages: true }]);
    expect(events).toEqual([
      { type: "turn" },
      { type: "text", delta: "Let me look." },
      { type: "step", id: "t1", label: "Searching the web for “acme”", kind: "web" },
      { type: "step-done", id: "t1", isError: false },
    ]);

    const slackSeen: unknown[] = [];
    const slackQuery: QueryFn = async function* (params) {
      slackSeen.push(params.options?.includePartialMessages);
      for (const m of stream) yield m as SDKMessage;
    };
    await createPointerBrain(await deps(), { queryFn: slackQuery }).reply({ ...req, channel: "D1", surface: undefined }, { startRepoTask: async () => ({ ok: false, error: "x" }) });
    expect(slackSeen).toEqual([undefined]);
  });
});
