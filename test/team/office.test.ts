import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../src/chat/conversations.js";
import {
  OFFICE_LEAD_ID,
  STALE_ANSWER_MS,
  STALE_TASK_MS,
  buildOffice,
  dayStartMs,
  describeStep,
  gerund,
  labelIndex,
  loadOffice,
  taskTitle,
} from "../../src/team/office.js";
import type { ProgressSnapshot } from "../../src/progress.js";
import { createApp } from "../../src/server.js";
import type { Store } from "../../src/core/store.js";
import { type TaskEvent, type TaskTimeline, emptyTimeline, timelineKey } from "../../src/task-events.js";
import { type Task, WEB_CHANNEL, newTaskId } from "../../src/tasks.js";
import { type Team, agentLabel, defaultTeam } from "../../src/team/team.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-19T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function team(): Team {
  const t = defaultTeam();
  const coder = t.agents.find((a) => a.id === "coder")!;
  coder.name = "Sara";
  coder.avatar = "sara-2";
  t.agents.find((a) => a.id === "writer")!.enabled = false;
  return t;
}

const label = (t: Team, id: string) => agentLabel(t.agents.find((a) => a.id === id)!);
const plain = (t: Team, id: string) => {
  const a = t.agents.find((x) => x.id === id)!;
  return a.name === a.role ? a.name : `${a.name} (${a.role})`;
};

function task(over: Partial<Task> & { startedMin: number }): Task {
  const created = NOW - over.startedMin * MIN;
  return {
    id: newTaskId(created),
    createdAt: iso(created),
    updatedAt: iso(NOW - MIN),
    status: "running",
    repo: "acme/web",
    channel: WEB_CHANNEL,
    threadTs: "c-000000001-aaaaaa",
    userId: "admin",
    instruction: "Add a dark mode toggle to the header\nwith a remembered choice",
    ...over,
  };
}

function progress(agents: ProgressSnapshot["agents"], over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    updatedAt: iso(NOW - MIN),
    startedAt: iso(NOW - 20 * MIN),
    now: "Pointer is checking the results",
    plan: [
      { content: "Read the code", status: "completed" },
      { content: "Make the change", status: "completed" },
      { content: "Review the diff", status: "in_progress" },
      { content: "Check it in the browser", status: "pending" },
    ],
    agents,
    recent: [],
    files: [],
    filesCount: 0,
    ...over,
  };
}

function timeline(taskId: string, events: Omit<TaskEvent, "phase">[], phase: TaskEvent["phase"] = "build"): TaskTimeline {
  const t = emptyTimeline(taskId, new Date(NOW));
  for (const p of t.phases) {
    if (p.phase === phase) {
      p.state = "active";
      break;
    }
    p.state = "done";
  }
  t.events = events.map((e) => ({ phase, ...e }));
  return t;
}

const input = (over: Partial<Parameters<typeof buildOffice>[0]> = {}) => ({
  team: team(),
  tasks: [],
  timelines: new Map(),
  conversations: [],
  now: NOW,
  dayStart: dayStartMs(NOW),
  ...over,
});

describe("office: words", () => {
  it("turns an assignment into what someone is doing", () => {
    expect(gerund("Review the diff")).toBe("Reviewing the diff");
    expect(gerund("Make the change")).toBe("Making the change");
    expect(gerund("Run the tests")).toBe("Running the tests");
    expect(gerund("Fix the login redirect")).toBe("Fixing the login redirect");
    expect(gerund("Check it in the browser")).toBe("Checking it in the browser");
    expect(gerund("Dark mode toggle")).toBe("Dark mode toggle");
  });

  it("describes timeline steps as present work", () => {
    expect(describeStep({ kind: "edit", text: "src/components/Header.tsx" })).toBe("Editing src/components/Header.tsx");
    expect(describeStep({ kind: "command", text: "npm test" })).toBe("Running npm test");
    expect(describeStep({ kind: "browser", text: "Opened: http://localhost:3000/checkout" })).toBe("Checking http://localhost:3000/checkout in the browser");
    expect(describeStep({ kind: "browser", text: "Took a screenshot: home.png" })).toBe("Taking a screenshot: home.png");
    expect(describeStep({ kind: "browser", text: "Read the page" })).toBe("Reading the page in the browser");
    expect(describeStep({ kind: "agent-start", text: "Review the diff: look for missing tests" })).toBe("Reviewing the diff");
    expect(describeStep({ kind: "push", text: "Pushed" })).toBeUndefined();
    expect(describeStep({ kind: "command", text: `npm run ${"x".repeat(200)}` })!.length).toBeLessThanOrEqual(90);
  });

  it("names a task by its report, its ticket or its first line", () => {
    expect(taskTitle({ instruction: "Fix it\nmore", report: undefined, ticket: undefined })).toBe("Fix it");
    expect(taskTitle({ instruction: "Work on this monday.com ticket: x", ticket: { boardId: "1", itemId: "2", name: "Pay button overlaps" } })).toBe("Pay button overlaps");
    expect(taskTitle({ instruction: "x", report: { title: "Dark mode toggle", summary: "", verification: "", risks: "" } })).toBe("Dark mode toggle");
  });

  it("starts the day at the owner's midnight", () => {
    expect(iso(dayStartMs(NOW))).toBe("2026-11-19T00:00:00.000Z");
    // UTC+2 (getTimezoneOffset -120): midnight there is 22:00 UTC the day before.
    expect(iso(dayStartMs(NOW, -120))).toBe("2026-11-18T22:00:00.000Z");
    // UTC-8 at 03:00 UTC is still the 18th there.
    expect(iso(dayStartMs(Date.parse("2026-11-19T03:00:00.000Z"), 480))).toBe("2026-11-18T08:00:00.000Z");
  });

  it("maps progress and timeline labels to agent ids", () => {
    const t = team();
    const idOf = labelIndex(t.agents);
    expect(idOf(label(t, "coder"))).toBe("coder");
    expect(idOf("Sara (Coder)")).toBe("coder");
    expect(idOf(":robot_face: qa")).toBe("qa");
    expect(idOf("Someone else")).toBeUndefined();
  });
});

describe("office: who is doing what", () => {
  it("shows Pointer and every enabled agent free when nothing runs", () => {
    const view = buildOffice(input());
    expect(view.people.map((p) => p.id)).toEqual([OFFICE_LEAD_ID, "coder", "reviewer", "qa", "researcher", "hr", "scout"]);
    expect(view.people.every((p) => p.state === "free")).toBe(true);
    expect(view.people[0]).toMatchObject({ kind: "lead", name: "Pointer", avatar: "pointer", today: { tasks: 0, minutes: 0 } });
    expect(view.people.find((p) => p.id === "coder")).toMatchObject({ name: "Sara", role: "Coder", avatar: "sara-2", kind: "agent" });
    expect(view.people.find((p) => p.id === "qa")!.avatar).toBe("qa");
    expect(view.meetings).toEqual([]);
    expect(view.updatedAt).toBe(iso(NOW));
  });

  it("puts one agent to work with its latest step, and Pointer leading it", () => {
    const t = team();
    const running = task({ startedMin: 12, progress: progress([{ label: label(t, "coder"), description: "Make the change", state: "working", minutes: 6, toolUses: 20 }]) });
    const tl = timeline(running.id, [
      { at: iso(NOW - 8 * MIN), kind: "agent-start", agent: plain(t, "coder"), text: "Make the change: add the toggle" },
      { at: iso(NOW - 5 * MIN), kind: "edit", agent: plain(t, "coder"), text: "src/theme/store.ts" },
      { at: iso(NOW - 2 * MIN), kind: "edit", agent: plain(t, "coder"), text: "src/components/Header.tsx" },
      { at: iso(NOW - MIN), kind: "push", text: "not an agent step" },
    ]);
    const view = buildOffice(input({ team: t, tasks: [running], timelines: new Map([[running.id, tl]]) }));
    const coder = view.people.find((p) => p.id === "coder")!;
    expect(coder).toMatchObject({
      state: "working",
      doing: "Editing src/components/Header.tsx",
      since: iso(NOW - 8 * MIN),
      task: { id: running.id, repo: "acme/web", title: "Add a dark mode toggle to the header", conversationId: "c-000000001-aaaaaa", channel: "web" },
      today: { tasks: 1, minutes: 6 },
    });
    const pointer = view.people[0]!;
    expect(pointer).toMatchObject({ state: "working", doing: "Leading Sara on acme/web", task: { id: running.id }, since: running.createdAt });
    expect(view.people.find((p) => p.id === "reviewer")!.state).toBe("free");
    expect(view.meetings).toEqual([]);
  });

  it("makes a running task with two agents a meeting around the table", () => {
    const t = team();
    const running = task({
      startedMin: 20,
      channel: "C0SLACK",
      threadTs: "1763380000.000100",
      progress: progress([
        { label: label(t, "coder"), description: "Make the change", state: "done", minutes: 9, toolUses: 31, outcome: "Done" },
        { label: label(t, "reviewer"), description: "Review the diff", state: "working", minutes: 2, toolUses: 4 },
      ]),
    });
    const tl = timeline(
      running.id,
      [
        { at: iso(NOW - 15 * MIN), kind: "agent-start", agent: plain(t, "coder"), text: "Make the change" },
        { at: iso(NOW - 6 * MIN), kind: "agent-done", agent: plain(t, "coder"), text: "Added the toggle", ok: true, ms: 9 * MIN },
        { at: iso(NOW - 5 * MIN), kind: "agent-start", agent: plain(t, "reviewer"), text: "Review the diff: check for missing tests" },
      ],
      "verify",
    );
    const view = buildOffice(input({ team: t, tasks: [running], timelines: new Map([[running.id, tl]]) }));
    expect(view.meetings).toEqual([
      {
        taskId: running.id,
        title: "Add a dark mode toggle to the header",
        repo: "acme/web",
        channel: "C0SLACK",
        step: "verify",
        plan: { done: 2, total: 4 },
        people: [OFFICE_LEAD_ID, "coder", "reviewer"],
        since: running.createdAt,
      },
    ]);
    const byId = Object.fromEntries(view.people.map((p) => [p.id, p]));
    expect(byId.pointer).toMatchObject({ state: "meeting", doing: "Leading Reviewer on acme/web" });
    expect(byId.reviewer).toMatchObject({ state: "working", doing: "Reviewing the diff", since: iso(NOW - 5 * MIN) });
    expect(byId.coder).toMatchObject({ state: "meeting", doing: "In the meeting: Reviewer is reviewing the diff", since: iso(NOW - 6 * MIN), task: { id: running.id } });
    expect(byId.coder!.task!.conversationId).toBeUndefined();
    expect(byId.qa!.state).toBe("free");
  });

  it("keeps the meeting going while Pointer publishes, after every agent is done", () => {
    const t = team();
    const publishing = task({
      startedMin: 30,
      stage: { phase: "publish", text: "Publishing the branch and opening the pull request", at: iso(NOW - MIN) },
      progress: progress([
        { label: label(t, "coder"), description: "Make the change", state: "done", minutes: 9, toolUses: 31 },
        { label: label(t, "qa"), description: "Check it in the browser", state: "done", minutes: 4, toolUses: 9 },
      ]),
    });
    const view = buildOffice(input({ team: t, tasks: [publishing] }));
    expect(view.meetings).toHaveLength(1);
    const byId = Object.fromEntries(view.people.map((p) => [p.id, p]));
    expect(byId.pointer).toMatchObject({ state: "meeting", doing: "Publishing the branch and opening the pull request" });
    expect(byId.qa).toMatchObject({ state: "meeting", doing: "In the meeting with Pointer" });
  });

  it("falls back to the progress snapshot when a task has no timeline", () => {
    const t = team();
    const running = task({ startedMin: 5, progress: progress([{ label: label(t, "qa"), description: "Check it in the browser", state: "working", minutes: 3, toolUses: 2 }]) });
    const view = buildOffice(input({ team: t, tasks: [running] }));
    expect(view.people.find((p) => p.id === "qa")).toMatchObject({ state: "working", doing: "Checking it in the browser", since: iso(NOW - MIN - 3 * MIN) });
  });

  it("says what Pointer does in the worker's own steps", () => {
    const cloning = task({ startedMin: 1, stage: { phase: "clone", text: "Cloning acme/web", at: iso(NOW - MIN) } });
    const view = buildOffice(input({ tasks: [cloning] }));
    expect(view.people[0]).toMatchObject({ state: "working", doing: "Cloning acme/web" });
    const queued = task({ startedMin: 1, status: "queued" });
    expect(buildOffice(input({ tasks: [queued] })).people[0]!.doing).toBe("Waiting for a worker for acme/web");
    const checking = task({ startedMin: 30, progress: progress([]) });
    expect(buildOffice(input({ tasks: [checking] })).people[0]!.doing).toBe("Checking the results");
  });

  it("shows Pointer thinking while it answers in Chat, and ignores an interrupted answer", () => {
    const conversations: ConversationSummary[] = [
      { id: "c-000000002-bbbbbb", title: "What changed this week?", updatedAt: iso(NOW - 20_000), pending: true, messageCount: 1, taskCount: 0 },
      { id: "c-000000003-cccccc", title: "Old", updatedAt: iso(NOW - STALE_ANSWER_MS - MIN), pending: true, messageCount: 1, taskCount: 0 },
      { id: "c-000000004-dddddd", title: "Answered", updatedAt: iso(NOW), pending: false, messageCount: 2, taskCount: 0 },
    ];
    const view = buildOffice(input({ conversations }));
    expect(view.people[0]).toMatchObject({
      state: "thinking",
      doing: "Answering “What changed this week?”",
      conversation: { id: "c-000000002-bbbbbb", title: "What changed this week?" },
      since: iso(NOW - 20_000),
    });
    expect(buildOffice(input({ conversations: conversations.slice(1) })).people[0]!.state).toBe("free");
  });

  it("ignores a task its worker stopped saving long ago", () => {
    const t = team();
    const stale = task({
      startedMin: 600,
      updatedAt: iso(NOW - STALE_TASK_MS - MIN),
      progress: progress([{ label: label(t, "coder"), description: "Make the change", state: "working", minutes: 9, toolUses: 1 }], { updatedAt: iso(NOW - STALE_TASK_MS - MIN) }),
    });
    const view = buildOffice(input({ team: t, tasks: [stale] }));
    expect(view.people.every((p) => p.state === "free")).toBe(true);
  });

  it("counts today's tasks and minutes per person", () => {
    const t = team();
    const yesterday = task({
      startedMin: 24 * 60,
      status: "done",
      updatedAt: iso(NOW - 23 * 60 * MIN),
      progress: progress([{ label: label(t, "coder"), description: "Fix", state: "done", minutes: 30, toolUses: 1 }]),
    });
    const morning = task({
      startedMin: 5 * 60,
      status: "done",
      updatedAt: iso(NOW - 5 * 60 * MIN + 26 * MIN),
      progress: progress([
        { label: label(t, "coder"), description: "Build", state: "done", minutes: 9, toolUses: 1 },
        { label: label(t, "qa"), description: "Check", state: "done", minutes: 6, toolUses: 1 },
        { label: label(t, "coder"), description: "Fix review notes", state: "done", minutes: 4, toolUses: 1 },
      ]),
    });
    const answer = task({ startedMin: 60, status: "done", kind: "answer", updatedAt: iso(NOW - 50 * MIN) });
    const view = buildOffice(input({ team: t, tasks: [yesterday, morning, answer] }));
    const byId = Object.fromEntries(view.people.map((p) => [p.id, p]));
    expect(byId.coder!.today).toEqual({ tasks: 1, minutes: 13 });
    expect(byId.qa!.today).toEqual({ tasks: 1, minutes: 6 });
    expect(byId.reviewer!.today).toEqual({ tasks: 0, minutes: 0 });
    expect(byId.pointer!.today).toEqual({ tasks: 2, minutes: 36 });
    expect(byId.coder).toMatchObject({ state: "free", since: morning.updatedAt });
  });

  it("leaves disabled agents out, even when a task still names them", () => {
    const t = team();
    const running = task({
      startedMin: 5,
      progress: progress([
        { label: label(t, "writer"), description: "Write the notes", state: "working", minutes: 1, toolUses: 1 },
        { label: label(t, "coder"), description: "Make the change", state: "working", minutes: 1, toolUses: 1 },
      ]),
    });
    const view = buildOffice(input({ team: t, tasks: [running] }));
    expect(view.people.some((p) => p.id === "writer")).toBe(false);
    expect(view.meetings).toEqual([]);
    expect(view.people.find((p) => p.id === "coder")!.state).toBe("working");
  });
});

describe("office: loading", () => {
  it("reads the recent tasks and only the active tasks' timelines", async () => {
    const t = team();
    const running = task({ startedMin: 3, progress: progress([{ label: label(t, "coder"), description: "Make the change", state: "working", minutes: 1, toolUses: 1 }]) });
    const done = task({ startedMin: 90, status: "done" });
    const tl = timeline(running.id, [
      { at: iso(NOW - 2 * MIN), kind: "agent-start", agent: plain(t, "coder"), text: "Make the change" },
      { at: iso(NOW - MIN), kind: "command", agent: plain(t, "coder"), text: "npm test" },
    ]);
    const read: string[] = [];
    const store: Pick<Store, "get"> = {
      get: async (key) => {
        read.push(key);
        return key === timelineKey(running.id) ? Buffer.from(JSON.stringify(tl)) : null;
      },
    };
    let scanned = 0;
    const view = await loadOffice(
      {
        store,
        tasks: { recent: async (n) => ((scanned = n ?? 0), [running, done]) },
        conversations: { list: async () => [] },
        team: t,
      },
      { now: NOW },
    );
    expect(scanned).toBe(30);
    expect(read).toEqual([timelineKey(running.id)]);
    expect(view.people.find((p) => p.id === "coder")).toMatchObject({ state: "working", doing: "Running npm test" });
  });

  it("serves GET /api/office to the signed-in admin only", async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-office-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-office", RUNNER: "local" }, { runner: { kind: "local", launch: async () => undefined } });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/api/office`)).status).toBe(401);
      const setup = await fetch(`${base}/api/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken: "setup-office", password: "longpassword1" }),
      });
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const res = await fetch(`${base}/api/office?tz=-120`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const view = (await res.json()) as { people: { id: string; state: string }[]; meetings: unknown[]; updatedAt: string };
      expect(view.people.map((p) => p.id)).toEqual([OFFICE_LEAD_ID, "coder", "reviewer", "qa", "researcher", "writer", "hr", "scout"]);
      expect(view.people.every((p) => p.state === "free")).toBe(true);
      expect(view.meetings).toEqual([]);
      expect(typeof view.updatedAt).toBe("string");
      expect((await fetch(`${base}/api/office?tz=nonsense`, { headers: { cookie } })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
