import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ProgressTracker, describeTask, describeTasks, formatProgress, oneLine, taskIdFromResult } from "../src/progress.js";
import type { Task } from "../src/tasks.js";

const T0 = Date.parse("2026-11-18T12:00:00Z");

/** A tracker on a fake clock; `at(min)` moves the clock. */
function setup() {
  let now = T0;
  const tracker = new ProgressTracker({
    lead: "Pointer",
    label: (type) => (type === "coder" ? ":hammer_and_wrench: Coder" : type === "qa" ? ":test_tube: QA" : `:robot_face: ${type ?? "agent"}`),
    repoDir: "/work/repo",
    now: () => now,
  });
  return { tracker, at: (min: number) => (now = T0 + min * 60_000) };
}

const assistant = (parent: string | null, ...blocks: { id: string; name: string; input: unknown }[]) =>
  ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: blocks.map((b) => ({ type: "tool_use", ...b })) },
  }) as unknown as SDKMessage;

const toolResult = (id: string, content: unknown, isError = false) =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  }) as unknown as SDKMessage;

describe("ProgressTracker", () => {
  it("follows the plan, the agents, their steps and their reports", () => {
    const { tracker, at } = setup();
    expect(tracker.snapshot().now).toBe("Reading the repository and planning");

    at(1);
    expect(
      tracker.onMessage(
        assistant(null, {
          id: "todo1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Read the ticket", status: "completed", activeForm: "Reading" },
              { content: "Build the sidebar status", status: "in_progress", activeForm: "Building" },
              { content: "Review and test", status: "pending", activeForm: "Reviewing" },
            ],
          },
        }),
      ),
    ).toBe(true);

    at(2);
    tracker.onMessage(assistant(null, { id: "a1", name: "Agent", input: { subagent_type: "coder", description: "Build the sidebar status" } }));
    at(4);
    tracker.onMessage(assistant("a1", { id: "x1", name: "Read", input: { file_path: "/work/repo/app/sidebar.tsx" } }));
    tracker.onMessage(assistant("a1", { id: "x2", name: "Edit", input: { file_path: "/work/repo/app/sidebar.tsx" } }));
    tracker.onMessage(assistant("a1", { id: "x3", name: "Edit", input: { file_path: "/work/repo/app/sidebar.tsx" } }));
    tracker.onMessage(assistant("a1", { id: "x4", name: "Bash", input: { command: "npm test\nnpm run lint" } }));
    // An unknown parent (e.g. a built-in subagent we did not see start) is ignored.
    expect(tracker.onMessage(assistant("zzz", { id: "x5", name: "Edit", input: { file_path: "/work/repo/x.ts" } }))).toBe(false);
    tracker.setFiles(["app/sidebar.tsx", "app/status.ts"]);

    let s = tracker.snapshot();
    expect(s.now).toBe(":hammer_and_wrench: Coder — Build the sidebar status");
    expect(s.plan.map((p) => p.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(s.agents).toEqual([
      { label: ":hammer_and_wrench: Coder", description: "Build the sidebar status", state: "working", minutes: 2, toolUses: 4 },
    ]);
    expect(s.recent).toEqual([
      "[2m] :hammer_and_wrench: Coder started: Build the sidebar status",
      "[4m] :hammer_and_wrench: Coder edited app/sidebar.tsx",
      "[4m] :hammer_and_wrench: Coder ran `npm test`",
    ]);
    expect(s.filesCount).toBe(2);

    at(9);
    tracker.onMessage(toolResult("a1", [{ type: "text", text: "## Done\nAdded the status dot to the sidebar; tests pass." }]));
    s = tracker.snapshot();
    expect(s.agents[0]).toMatchObject({ state: "done", minutes: 7, outcome: "Done" });
    expect(s.recent.at(-1)).toBe("[9m] :hammer_and_wrench: Coder finished after 7 min: Done");
    expect(s.now).toBe("Pointer is checking the results");

    tracker.onMessage(assistant(null, { id: "a2", name: "Task", input: { subagent_type: "qa", description: "Run the tests" } }));
    tracker.onMessage(toolResult("a2", "Tests failed: 2", true));
    expect(tracker.snapshot().recent.at(-1)).toBe("[9m] :test_tube: QA stopped with an error after 1 min: Tests failed: 2");
  });

  it("builds the plan from TaskCreate and TaskUpdate", () => {
    const { tracker } = setup();
    tracker.onMessage(assistant(null, { id: "c1", name: "TaskCreate", input: { subject: "Implement", description: "…" } }));
    tracker.onMessage(assistant(null, { id: "c2", name: "TaskCreate", input: { subject: "Verify", description: "…" } }));
    tracker.onMessage(toolResult("c1", JSON.stringify({ task: { id: "1", subject: "Implement" } })));
    tracker.onMessage(toolResult("c2", "Task #2 created successfully: Verify"));
    tracker.onMessage(assistant(null, { id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }));
    tracker.onMessage(assistant(null, { id: "u2", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } }));
    expect(tracker.snapshot().plan).toEqual([
      { content: "Implement", status: "completed" },
      { content: "Verify", status: "in_progress" },
    ]);
    // An update for an unknown task changes nothing.
    expect(tracker.onMessage(assistant(null, { id: "u3", name: "TaskUpdate", input: { taskId: "9", status: "completed" } }))).toBe(false);
  });

  it("keeps the latest steps only and counts tool uses from task_progress", () => {
    const { tracker, at } = setup();
    tracker.onMessage(assistant(null, { id: "a1", name: "Agent", input: { subagent_type: "coder", description: "Work" } }));
    for (let i = 0; i < 20; i++) {
      at(i);
      tracker.onMessage(assistant("a1", { id: `e${i}`, name: "Write", input: { file_path: `/work/repo/f${i}.ts` } }));
    }
    tracker.onMessage({ type: "system", subtype: "task_progress", tool_use_id: "a1", usage: { tool_uses: 57 } } as unknown as SDKMessage);
    const s = tracker.snapshot();
    expect(s.recent).toHaveLength(8);
    expect(s.recent.at(-1)).toBe("[19m] :hammer_and_wrench: Coder edited f19.ts");
    expect(s.agents[0]!.toolUses).toBe(57);
  });
});

describe("progress text", () => {
  const snapshot = () => {
    const { tracker, at } = setup();
    tracker.onMessage(
      assistant(null, {
        id: "t",
        name: "TodoWrite",
        input: { todos: [{ content: "Build", status: "in_progress" }, { content: "Review", status: "pending" }] },
      }),
    );
    tracker.onMessage(assistant(null, { id: "a1", name: "Agent", input: { subagent_type: "coder", description: "Build" } }));
    at(3);
    tracker.onMessage(assistant("a1", { id: "e", name: "Edit", input: { file_path: "/work/repo/app/a.ts" } }));
    tracker.setFiles(Array.from({ length: 17 }, (_, i) => `f${i}.ts`));
    return tracker.snapshot();
  };

  it("formats the live message and the periodic update for Slack", () => {
    const s = snapshot();
    const live = formatProgress(s, { kind: "live", everyMin: 5, now: T0 + 6 * 60_000 });
    expect(live.split("\n")[0]).toBe(":gear: *Working* · 6 min · an update is posted here every 5 min");
    expect(live).toContain("*Now:* :hammer_and_wrench: Coder — Build");
    expect(live).toContain("*Plan* (0/2 done)\n:arrow_forward: Build\n:white_square: Review");
    expect(live).toContain("*Working:* :hammer_and_wrench: Coder (3 min, 1 tool uses)");
    expect(live).toContain("• [3m] :hammer_and_wrench: Coder edited app/a.ts");
    expect(live).toContain("*Changed so far:* 17 files — `f0.ts`");
    expect(live).toContain("+2 more");
    const update = formatProgress(s, { kind: "update", now: T0 + 10 * 60_000 });
    expect(update.split("\n")[0]).toBe(":hourglass_flowing_sand: *Update · 10 min in*");
  });

  const task = (patch: Partial<Task>): Task => ({
    id: "t-1",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    status: "running",
    repo: "acme/web",
    channel: "C1",
    threadTs: "1.1",
    userId: "U1",
    instruction: "Build the sidebar status\nwith details",
    ...patch,
  });

  it("describes a running task with its saved progress for Pointer", () => {
    const text = describeTask(task({ progress: snapshot(), branch: "army/sidebar" }), T0 + 12 * 60_000);
    expect(text).toContain("Task t-1 on acme/web: running, started 12 min ago, branch army/sidebar.");
    expect(text).toContain("Request: Build the sidebar status");
    expect(text).toContain("Progress (saved 9 min ago): :hammer_and_wrench: Coder — Build");
    expect(text).toContain("Plan (0/2 done):\n  [>] Build\n  [ ] Review");
    expect(text).toContain("Agent :hammer_and_wrench: Coder: Build — working for 3 min, 1 tool uses");
    expect(text).toContain("Files changed so far (17)");
    expect(describeTask(task({}), T0)).toContain("No progress saved yet");
    expect(describeTask(task({}), T0 + 20 * 60_000)).toContain("started before progress tracking was available");
  });

  it("describes finished and failed tasks, and picks this thread's tasks first", () => {
    const done = task({ status: "done", prUrl: "https://github.com/acme/web/pull/7", summary: "Added it.", costUsd: 3.2, progress: snapshot() });
    const doneText = describeTask(done, T0);
    expect(doneText).toContain("Pull request: https://github.com/acme/web/pull/7");
    expect(doneText).toContain("Cost: $3.20");
    expect(doneText).not.toContain("Progress");
    expect(describeTask(task({ status: "failed", error: "Timed out after 50 minutes." }), T0)).toContain("Error: Timed out");

    expect(describeTasks([done], [task({ id: "t-9" })], T0)).toContain("started in this conversation");
    const elsewhere = describeTasks([], [task({ id: "t-9" })], T0);
    expect(elsewhere).toContain("Tasks running elsewhere");
    expect(elsewhere).toContain("t-9");
    expect(describeTasks([], [], T0)).toBe("No repo task was started in this conversation, and none is running.");
  });
});

describe("helpers", () => {
  it("shortens text to one line without Markdown markers", () => {
    expect(oneLine("\n\n## Summary\nmore")).toBe("Summary");
    expect(oneLine("- item  with   spaces")).toBe("item with spaces");
    expect(oneLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("reads TaskCreate ids from JSON or text", () => {
    expect(taskIdFromResult('{"task":{"id":"4","subject":"x"}}')).toBe("4");
    expect(taskIdFromResult('{"task":{"id":5}}')).toBe("5");
    expect(taskIdFromResult("Task #12 created successfully")).toBe("12");
    expect(taskIdFromResult("nothing here")).toBeUndefined();
  });
});
