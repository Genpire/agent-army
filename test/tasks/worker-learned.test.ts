import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactStrings } from "../../src/ai/engines.js";
import { NotesRepo } from "../../src/chat/notes.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { makeRedactor, redactedReport, saveWhatTheTeamLearned } from "../../src/tasks/worker.js";
import { CHECK_SUMMARY_MAX_CHARS, LESSON_AREA_MAX_CHARS, LESSON_TEXT_MAX_CHARS, type Report, TEST_PROOF_MAX_CHARS } from "../../src/team/agents.js";
import { LessonsRepo, materializeLessons } from "../../src/team/lessons.js";

/**
 * What the worker keeps from each run of the team: the report, redacted
 * before anything in it is cut, and the project notes and lessons in it,
 * saved after the first run and after every extra round.
 */

const SECRET = "sk-ant-api03-a-long-secret-value";
const redact = makeRedactor([SECRET]);
/** Text of `length` characters whose secret starts `inside` characters before the end, so a cut at `length` crosses it. */
const across = (length: number, inside = 10) => `${"x".repeat(length - inside)}${SECRET}`;

const setup = async () => {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-learned-")));
  const key = deriveKey("learned");
  return { notes: new NotesRepo(store, key), lessons: new LessonsRepo(store, key) };
};

const report = (over: Partial<Report> = {}): Report => ({
  kind: "change",
  title: "Fix the refunds",
  summary: "Refunds are now in cents.",
  verification: "npm test",
  testProof: "",
  checks: [],
  risks: "",
  projectNotes: "",
  lessons: [],
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the team's report, redacted before it is cut", () => {
  it("leaves no part of a secret that crosses a field's limit", () => {
    const parsed = redactedReport(
      {
        kind: "change",
        title: across(120),
        summary: `The key is ${SECRET}.`,
        verification: "",
        testProof: across(TEST_PROOF_MAX_CHARS),
        checks: [{ command: "npm test", outcome: "pass", summary: across(CHECK_SUMMARY_MAX_CHARS) }],
        risks: "",
        projectNotes: `- staging key ${SECRET}`,
        lessons: [{ area: across(LESSON_AREA_MAX_CHARS), lesson: across(LESSON_TEXT_MAX_CHARS) }],
      },
      "",
      redact,
    );
    // Its first ten characters are where the cut falls: redacted first, "[redacted]" fills them.
    const lead = SECRET.slice(0, 10);
    expect(JSON.stringify(parsed)).not.toContain(lead);
    expect(parsed.lessons).toEqual([
      { area: `${"x".repeat(LESSON_AREA_MAX_CHARS - 10)}[redacted]`, lesson: `${"x".repeat(LESSON_TEXT_MAX_CHARS - 10)}[redacted]` },
    ]);
    expect(parsed.title).toBe(`${"x".repeat(110)}[redacted]`);
    expect(parsed.testProof.endsWith("[redacted]")).toBe(true);
    expect(parsed.checks[0]!.summary.endsWith("[redacted]")).toBe(true);
    expect(parsed.summary).toBe("The key is [redacted].");
    expect(parsed.projectNotes).toBe("- staging key [redacted]");
  });

  it("redacts the plain text that stands in for a missing report", () => {
    expect(redactedReport(undefined, `Done; the key is ${SECRET}`, redact).summary).toBe("Done; the key is [redacted]");
  });

  it("redacts strings in nested arrays and objects, and leaves the rest as it is", () => {
    expect(redactStrings({ a: [[SECRET, 1], { b: { c: [`k=${SECRET}`] } }], d: null, e: true }, redact)).toEqual({
      a: [["[redacted]", 1], { b: { c: ["k=[redacted]"] } }],
      d: null,
      e: true,
    });
  });
});

describe("saving what the team learned after a run", () => {
  it("saves the report's project notes and lessons, redacted, with the task's id", async () => {
    const { notes, lessons } = await setup();
    await notes.put("acme/web", "- uses pnpm");
    await saveWhatTheTeamLearned(
      { notes, lessons, repo: "acme/web", taskId: "t-1", notesBefore: "- uses pnpm", redact },
      report({
        projectNotes: `- uses pnpm\n- the staging key is ${SECRET}`,
        lessons: [{ area: "billing", lesson: `Refunds are in cents; the test key ${SECRET} is for staging.` }],
      }),
    );
    expect((await notes.get("acme/web"))!.text).toBe("- uses pnpm\n- the staging key is [redacted]");
    expect((await lessons.get("acme/web"))!.lessons).toMatchObject([
      { area: "billing", lesson: "Refunds are in cents; the test key [redacted] is for staging.", source: "task", taskId: "t-1", seen: 1 },
    ]);
  });

  it("does nothing without a report", async () => {
    const put = vi.fn();
    const add = vi.fn();
    await saveWhatTheTeamLearned({ notes: { put }, lessons: { add }, repo: "acme/web", taskId: "t-1", notesBefore: "" }, undefined);
    expect(put).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("still saves the lessons when the notes cannot be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { lessons } = await setup();
    const notes = { put: vi.fn().mockRejectedValue(new Error("bucket unavailable")) };
    await saveWhatTheTeamLearned(
      { notes, lessons, repo: "acme/web", taskId: "t-1", notesBefore: "" },
      report({ projectNotes: "- uses pnpm", lessons: [{ area: "ci", lesson: "Run npm ci, not npm install." }] }),
    );
    expect(notes.put).toHaveBeenCalled();
    expect((await lessons.get("acme/web"))!.lessons.map((l) => l.lesson)).toEqual(["Run npm ci, not npm install."]);
  });

  it("gives the next round the lessons the run before saved, and one task's rounds count as one sighting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { notes, lessons } = await setup();
    const dir = join(await mkdtemp(join(tmpdir(), "army-learned-dir-")), "lessons");
    const learned = { notes, lessons, repo: "acme/web", taskId: "t-1", redact };
    const refunds = { area: "billing", lesson: "Refunds are in cents." };

    // The first run starts with none, and reports one.
    expect(await materializeLessons(lessons, "acme/web", dir)).toBeUndefined();
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
    await saveWhatTheTeamLearned({ ...learned, notesBefore: "" }, report({ lessons: [refunds] }));

    // A fix round of the same task starts with it, and reports it again with a new one.
    expect(await materializeLessons(lessons, "acme/web", dir)).toEqual({ dir, count: 1, areas: [{ area: "billing", count: 1 }] });
    vi.setSystemTime(new Date("2026-11-01T10:30:00Z"));
    await saveWhatTheTeamLearned({ ...learned, notesBefore: "" }, report({ lessons: [refunds, { area: "ci", lesson: "Wait for the lint job." }] }));

    // The preview round starts with both; the first is still seen once, last seen in the fix round.
    expect((await materializeLessons(lessons, "acme/web", dir))?.count).toBe(2);
    expect(await readFile(join(dir, "billing.md"), "utf8")).toContain("- Refunds are in cents. (seen once, last on 2026-11-01)");
    expect((await lessons.get("acme/web"))!.lessons[0]).toMatchObject({ seen: 1, lastSeenAt: "2026-11-01T10:30:00.000Z", taskId: "t-1" });

    // Another task reporting it: a mistake that happened again.
    await saveWhatTheTeamLearned({ ...learned, taskId: "t-2", notesBefore: "" }, report({ lessons: [refunds] }));
    expect((await lessons.get("acme/web"))!.lessons[0]).toMatchObject({ seen: 2, taskId: "t-2" });
  });
});
