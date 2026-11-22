import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GitHubReader, type PointerToolOptions, projectNotesRead } from "../../src/chat/pointer-tools.js";
import { MemoryRepo } from "../../src/chat/memory.js";
import { NotesRepo } from "../../src/chat/notes.js";
import { ConfigSchema } from "../../src/core/config.js";
import { decrypt, deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { teamQueryOptions } from "../../src/tasks/worker.js";
import { LESSON_AREA_MAX_CHARS, LESSON_TEXT_MAX_CHARS, type LessonsContext, orchestratorPrompt } from "../../src/team/agents.js";
import {
  LESSONS_INDEX_FILE,
  LESSONS_MAX_PER_REPO,
  type Lesson,
  LessonsRepo,
  type RepoLessons,
  areaFileName,
  lessonMatchKey,
  lessonsNote,
  lessonsSection,
  materializeLessons,
  normaliseArea,
  saveTaskLessons,
  writeLessonsFolder,
} from "../../src/team/lessons.js";
import { REPO_RULES } from "../../src/team/team.js";

const KEY = deriveKey("lessons");
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "army-lessons-"));
  const store = new FsStore(root);
  return { root, store, lessons: new LessonsRepo(store, KEY) };
};
const tmp = () => mkdtemp(join(tmpdir(), "army-lessons-dir-"));
const at = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the lessons store", () => {
  it("keeps one encrypted blob per repository under lessons/, named like the notes", async () => {
    const { store, lessons } = await setup();
    expect(await lessons.get("Acme/web")).toBeNull();
    const saved = await lessons.add("Acme/web", [{ area: "billing", lesson: "Refunds are in cents, not dollars." }], { source: "task", taskId: "t-1" });
    expect(saved).toMatchObject({ ok: true, repeated: [] });
    expect(await store.list("lessons/")).toEqual(["lessons/acme__web.enc"]);
    const raw = (await store.get("lessons/acme__web.enc"))!;
    expect(raw.toString("utf8")).not.toContain("Refunds");
    expect(decrypt(KEY, raw)).toContain("Refunds are in cents");

    const found = await lessons.get("acme/WEB");
    expect(found?.repo).toBe("Acme/web");
    expect(found?.lessons).toEqual([
      {
        id: expect.stringMatching(/^l-[0-9a-f]{8}$/),
        area: "billing",
        lesson: "Refunds are in cents, not dollars.",
        createdAt: expect.any(String),
        lastSeenAt: expect.any(String),
        seen: 1,
        taskId: "t-1",
        source: "task",
      },
    ]);
  });

  it("never writes outside lessons/: other hosts get flat names, and ids that could leave the folder are refused", async () => {
    const { root, store, lessons } = await setup();
    await lessons.add("gitlab:Acme/Platform/web", [{ area: "", lesson: "GitLab lesson" }], { source: "owner" });
    await lessons.add("bitbucket:acme/web", [{ area: "", lesson: "Bitbucket lesson" }], { source: "owner" });
    for (const repo of ["../acme/web", "gitlab:../secrets", "gitlab:acme/../../x", "bitbucket:acme/web/extra", "acme/web/../x", "gitlab:acme/~web"]) {
      expect(await lessons.add(repo, [{ area: "a", lesson: "x" }], { source: "owner" })).toMatchObject({ ok: false });
      expect(await lessons.get(repo)).toBeNull();
      expect(await lessons.remove(repo, "l-00000000")).toBe(false);
    }
    expect(await readdir(root)).toEqual(["lessons"]);
    expect((await store.list("lessons/")).sort()).toEqual(["lessons/bitbucket~acme~web.enc", "lessons/gitlab~acme~platform~web.enc"]);
    expect((await lessons.list()).map((l) => l.repo).sort()).toEqual(["bitbucket:acme/web", "gitlab:Acme/Platform/web"]);
  });

  it("counts a lesson reported again as seen again, whatever its case, spacing and punctuation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { lessons } = await setup();
    at("2026-11-01T10:00:00Z");
    await lessons.add("acme/web", [{ area: "billing", lesson: "Refunds are in cents, not dollars." }], { source: "task", taskId: "t-1" });
    at("2026-11-05T10:00:00Z");
    const again = await lessons.add(
      "acme/web",
      [
        { area: "payments", lesson: "  refunds ARE in cents -- not dollars!  " },
        // The same lesson twice in one report is seen once.
        { area: "payments", lesson: "Refunds are in cents; not dollars" },
        { area: "billing", lesson: "Refunds are in euros." },
      ],
      { source: "task", taskId: "t-2" },
    );
    expect(again.ok && again.repeated.map((l) => l.lesson)).toEqual(["Refunds are in cents, not dollars."]);
    expect(again.ok && again.added.map((l) => l.lesson)).toEqual(["Refunds are in euros."]);

    const stored = (await lessons.get("acme/web"))!.lessons;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      lesson: "Refunds are in cents, not dollars.",
      // Its area stays: only "general" moves to a named area.
      area: "billing",
      seen: 2,
      createdAt: "2026-11-01T10:00:00.000Z",
      lastSeenAt: "2026-11-05T10:00:00.000Z",
      taskId: "t-2",
    });
    expect(lessonMatchKey("Use `npm ci`, not `npm install`.")).toBe(lessonMatchKey("use npm ci not npm install"));
    expect(lessonMatchKey("Use npm ci")).not.toBe(lessonMatchKey("Use pnpm ci"));
  });

  it("files lessons under normalised areas: lower case, one line, bounded, general when empty", async () => {
    const { lessons } = await setup();
    expect(normaliseArea("  Billing\n\tAPI ")).toBe("billing api");
    expect(normaliseArea("")).toBe("general");
    expect(normaliseArea(" \u0000\u0085 ")).toBe("general");
    expect(normaliseArea("x".repeat(500))).toHaveLength(LESSON_AREA_MAX_CHARS);

    await lessons.add("acme/web", [{ area: "   ", lesson: "Run the migrations before the seed." }], { source: "owner" });
    await lessons.add("acme/web", [{ area: "SRC/Migrations", lesson: "  Run the migrations\nbefore the seed  " }], { source: "task" });
    const [only] = (await lessons.get("acme/web"))!.lessons;
    expect(only).toMatchObject({ area: "src/migrations", lesson: "Run the migrations before the seed.", seen: 2, source: "owner" });

    // A new lesson is stored on one line, without control characters, and bounded.
    await lessons.add("acme/api", [{ area: "db", lesson: "  Lock the table\n\tfirst,\u0000 then migrate.  " }, { area: "db", lesson: "y".repeat(5000) }], { source: "task" });
    expect((await lessons.get("acme/api"))!.lessons.map((l) => l.lesson.length > 100 ? l.lesson.length : l.lesson)).toEqual([
      "Lock the table first, then migrate.",
      LESSON_TEXT_MAX_CHARS,
    ]);
  });

  it("redacts secrets in the area and the text before anything is stored", async () => {
    const { store, lessons } = await setup();
    const secret = "sk-ant-api03-very-secret-value";
    const redact = (t: string) => t.split(secret).join("[redacted]");
    await saveTaskLessons(lessons, "acme/web", [{ area: `keys ${secret}`, lesson: `The key ${secret} is only for staging.` }], "t-9", redact);
    const raw = decrypt(KEY, (await store.get("lessons/acme__web.enc"))!);
    expect(raw).not.toContain(secret);
    expect((await lessons.get("acme/web"))!.lessons[0]).toMatchObject({ area: "keys [redacted]", lesson: "The key [redacted] is only for staging." });
  });

  it("keeps each repository's lessons apart", async () => {
    const { lessons } = await setup();
    await lessons.add("acme/web", [{ area: "ui", lesson: "The sidebar collapses under 768px." }], { source: "task" });
    await lessons.add("acme/api", [{ area: "db", lesson: "Migrations need a lock." }], { source: "task" });
    const web = (await lessons.get("acme/web"))!.lessons[0]!;
    const api = (await lessons.get("acme/api"))!.lessons[0]!;
    // The same lesson in another repository is that repository's own.
    await lessons.add("acme/api", [{ area: "ui", lesson: "The sidebar collapses under 768px." }], { source: "task" });
    expect((await lessons.get("acme/web"))!.lessons.map((l) => l.seen)).toEqual([1]);
    expect((await lessons.get("acme/api"))!.lessons).toHaveLength(2);

    expect(await lessons.remove("acme/api", web.id)).toBe(false);
    expect(await lessons.remove("acme/web", web.id)).toBe(true);
    expect(await lessons.get("acme/web")).toBeNull();
    expect((await lessons.get("acme/api"))!.lessons.map((l) => l.id)).toContain(api.id);
    expect((await lessons.list()).map((l) => [l.repo, l.count])).toEqual([["acme/api", 2]]);
  });

  it(`keeps at most ${LESSONS_MAX_PER_REPO} per repository, dropping the ones seen longest ago`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { lessons } = await setup();
    at("2026-01-01T00:00:00Z");
    const many = Array.from({ length: LESSONS_MAX_PER_REPO }, (_, i) => ({ area: "bulk", lesson: `Lesson number ${i}` }));
    await lessons.add("acme/web", many, { source: "task" });
    at("2026-02-01T00:00:00Z");
    await lessons.add("acme/web", [{ area: "bulk", lesson: "Lesson number 0" }], { source: "task" });
    at("2026-03-01T00:00:00Z");
    await lessons.add("acme/web", [{ area: "new", lesson: "A new lesson" }, { area: "new", lesson: "Another new lesson" }], { source: "task" });

    const kept = (await lessons.get("acme/web"))!.lessons.map((l) => l.lesson);
    expect(kept).toHaveLength(LESSONS_MAX_PER_REPO);
    // Lesson 0 was seen again, so 1 and 2 were seen longest ago.
    expect(kept).toContain("Lesson number 0");
    expect(kept).not.toContain("Lesson number 1");
    expect(kept).not.toContain("Lesson number 2");
    expect(kept).toContain("Lesson number 3");
    expect(kept.slice(-2)).toEqual(["A new lesson", "Another new lesson"]);
  });

  it("skips lessons with no text and writes nothing for them", async () => {
    const { store, lessons } = await setup();
    expect(await lessons.add("acme/web", [{ area: "a", lesson: "   " }, { area: "b", lesson: "?!..." }], { source: "task" })).toEqual({
      ok: true,
      added: [],
      repeated: [],
    });
    expect(await store.list("lessons/")).toEqual([]);
  });

  it("does not lose concurrent additions", async () => {
    const { lessons } = await setup();
    await Promise.all(Array.from({ length: 8 }, (_, i) => lessons.add("acme/web", [{ area: "a", lesson: `Lesson ${i}` }], { source: "task" })));
    expect((await lessons.get("acme/web"))!.lessons).toHaveLength(8);
  });
});

const lesson = (area: string, text: string, seen = 1, lastSeenAt = "2026-11-01T00:00:00.000Z"): Lesson => ({
  id: `l-${Math.random().toString(16).slice(2, 10)}`,
  area,
  lesson: text,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt,
  seen,
  source: "task",
});
const library = (lessons: Lesson[]): RepoLessons => ({ repo: "acme/web", lessons, updatedAt: "2026-11-01T00:00:00.000Z" });

describe("the lessons folder the team reads", () => {
  it("names area files safely, whatever the area says", async () => {
    const parent = await tmp();
    const dir = join(parent, "lessons");
    const hostile = ["../../etc", "a/b", "..", "index", "INDEX", "\u0000\u001b[31mred", "C:\\windows\\system32", "الفوترة", "billing", "Billing!"];
    const context = await writeLessonsFolder(library(hostile.map((a, i) => lesson(a, `Lesson ${i}`))), dir);

    const files = (await readdir(dir)).sort();
    expect(await readdir(parent)).toEqual(["lessons"]);
    expect(files).toContain(LESSONS_INDEX_FILE);
    const areaFiles = files.filter((f) => f !== LESSONS_INDEX_FILE);
    expect(areaFiles).toHaveLength(hostile.length);
    for (const f of areaFiles) expect(f).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.md$/);
    // Never INDEX.md under another case (one file on a case-insensitive disk).
    expect(areaFiles.map((f) => f.toLowerCase())).not.toContain("index.md");
    expect(areaFiles).toEqual(expect.arrayContaining(["etc.md", "a-b.md", "index-2.md", "index-3.md", "billing.md", "billing-2.md"]));
    // ".." and the Arabic area have no Latin letters: a hash of their text each.
    expect(areaFiles.filter((f) => /^area-[0-9a-f]{8}\.md$/.test(f))).toHaveLength(2);
    expect(context?.count).toBe(hostile.length);

    // Every file's lessons are in the file the index names for its area.
    const index = await readFile(join(dir, LESSONS_INDEX_FILE), "utf8");
    expect(index).toContain("- ../../etc (1): etc.md");
    expect(index).toContain("- a/b (1): a-b.md");
    expect(await readFile(join(dir, "a-b.md"), "utf8")).toContain("- Lesson 1 (seen once");

    const taken = new Set<string>();
    expect(areaFileName("", taken)).toMatch(/^area-[0-9a-f]{8}\.md$/);
    expect(areaFileName("x".repeat(500), taken)).toBe(`${"x".repeat(50)}.md`);
  });

  it("lists the areas with the most lessons first, then the most repeated lessons; each area's file most repeated first", async () => {
    const dir = join(await tmp(), "lessons");
    const context = await writeLessonsFolder(
      library([
        lesson("ui", "Check the sidebar on mobile.", 1),
        lesson("billing", "Refunds are in cents.", 4),
        lesson("billing", "Invoices are numbered per year.", 1),
        lesson("billing", "Taxes round half up.", 2, "2026-11-02T00:00:00.000Z"),
        lesson("auth", "Sessions expire after 12 hours.", 3),
        lesson("auth", "Tokens are hashed.", 1),
      ]),
      dir,
    );
    expect(context).toEqual({
      dir,
      count: 6,
      areas: [
        { area: "billing", count: 3 },
        { area: "auth", count: 2 },
        { area: "ui", count: 1 },
      ],
    });
    const index = await readFile(join(dir, LESSONS_INDEX_FILE), "utf8");
    const order = (text: string, parts: string[]) => parts.map((p) => text.indexOf(p));
    const areaLines = order(index, ["- billing (3): billing.md", "- auth (2): auth.md", "- ui (1): ui.md"]);
    expect(areaLines.every((i) => i >= 0)).toBe(true);
    expect(areaLines).toEqual([...areaLines].sort((a, b) => a - b));
    const repeated = order(index, ["[billing] Refunds are in cents. (seen 4 times)", "[auth] Sessions expire after 12 hours. (seen 3 times)", "[billing] Taxes round half up. (seen 2 times)"]);
    expect(repeated.every((i) => i > index.indexOf("## Most repeated"))).toBe(true);
    expect(repeated).toEqual([...repeated].sort((a, b) => a - b));
    // Lessons seen once are in their area's file, not in the most repeated list.
    expect(index).not.toContain("Invoices are numbered");

    const billing = await readFile(join(dir, "billing.md"), "utf8");
    expect(billing).toContain("3 lessons from earlier tasks on acme/web");
    const inFile = order(billing, ["Refunds are in cents.", "Taxes round half up.", "Invoices are numbered per year."]);
    expect(inFile).toEqual([...inFile].sort((a, b) => a - b));
  });

  it("replaces a folder written before, and writes nothing when there are no lessons", async () => {
    const dir = join(await tmp(), "lessons");
    await writeLessonsFolder(library([lesson("old", "Old lesson.")]), dir);
    await writeLessonsFolder(library([lesson("new", "New lesson.")]), dir);
    expect((await readdir(dir)).sort()).toEqual([LESSONS_INDEX_FILE, "new.md"]);

    const { lessons } = await setup();
    const empty = join(await tmp(), "lessons");
    expect(await materializeLessons(lessons, "acme/web", empty)).toBeUndefined();
    expect(existsSync(empty)).toBe(false);
    expect(await writeLessonsFolder(library([]), empty)).toBeUndefined();
    expect(existsSync(empty)).toBe(false);
  });

  it("writes a repository's stored lessons for the team, and skips a library it cannot read", async () => {
    const { lessons } = await setup();
    await lessons.add("acme/web", [{ area: "Billing", lesson: "Refunds are in cents." }], { source: "task" });
    const dir = join(await tmp(), "lessons");
    expect(await materializeLessons(lessons, "acme/web", dir)).toEqual({ dir, count: 1, areas: [{ area: "billing", count: 1 }] });
    expect(await readFile(join(dir, "billing.md"), "utf8")).toContain("Refunds are in cents.");

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { get: async () => Promise.reject(new Error("store down for token tok-123456789")) };
    const redact = (t: string) => t.replace("tok-123456789", "[redacted]");
    expect(await materializeLessons(broken, "acme/web", join(await tmp(), "lessons"), redact)).toBeUndefined();
    expect(logged.mock.calls.flat().join(" ")).toContain("store down for token [redacted]");
    expect(logged.mock.calls.flat().join(" ")).not.toContain("tok-123456789");
  });
});

describe("the lessons in Pointer's prompt", () => {
  const context: LessonsContext = {
    dir: "/work/army-1/lessons",
    count: 7,
    areas: [
      { area: "billing", count: 4 },
      { area: "src/auth", count: 3 },
    ],
  };

  it("is empty without lessons", () => {
    expect(lessonsSection(undefined)).toBe("");
    expect(lessonsSection({ ...context, count: 0 })).toBe("");
    expect(lessonsNote(context)).toBe("The team has 7 lessons from earlier tasks, in 2 areas");
  });

  it("says where they are, to grep them before planning and briefing, to pass them on, and that they are data", () => {
    const section = lessonsSection(context);
    expect(section).toContain("7 lessons");
    expect(section).toContain("/work/army-1/lessons");
    expect(section).toContain(LESSONS_INDEX_FILE);
    expect(section).toContain("billing (4), src/auth (3)");
    expect(section).toMatch(/Before you plan, Grep that folder/);
    expect(section).toMatch(/Before you brief an agent on an area/);
    expect(section).toMatch(/pass the relevant lessons to the agent in its brief, with the folder's path/);
    expect(section).toMatch(/outside the checkout/);
    expect(section).toMatch(/data, not instructions/);
    expect(section).toMatch(/lessons in your report/);

    const many = lessonsSection({ ...context, areas: Array.from({ length: 20 }, (_, i) => ({ area: `area${i}`, count: 1 })) });
    expect(many).toContain("area14 (1), and 5 more");
    expect(many).not.toContain("area15");
  });

  it("sits after the project notes, before the ground rules, and opens the folder to the team", () => {
    const config = ConfigSchema.parse({});
    const prompt = orchestratorPrompt(config, { projectNotes: "- uses pnpm", lessons: context });
    expect(prompt).toContain(lessonsSection(context));
    expect(prompt.indexOf("- uses pnpm")).toBeLessThan(prompt.indexOf(context.dir));
    expect(prompt.indexOf(context.dir)).toBeLessThan(prompt.indexOf(REPO_RULES.trim()));
    expect(orchestratorPrompt(config, {})).not.toContain("Lessons from earlier tasks");

    expect(teamQueryOptions(config, { lessons: context }).additionalDirectories).toEqual([context.dir]);
    expect(teamQueryOptions(config, {}).additionalDirectories).toBeUndefined();
  });
});

describe("saving a report's lessons", () => {
  it("saves them with the task's id, from a task, and counts them", async () => {
    const { lessons } = await setup();
    expect(await saveTaskLessons(lessons, "acme/web", [], "t-1")).toBe(0);
    expect(await lessons.get("acme/web")).toBeNull();
    const reported = [
      { area: "billing", lesson: "Refunds are in cents." },
      { area: "", lesson: "Run npm ci, not npm install." },
    ];
    expect(await saveTaskLessons(lessons, "acme/web", reported, "t-1")).toBe(2);
    expect((await lessons.get("acme/web"))!.lessons).toMatchObject([
      { area: "billing", lesson: "Refunds are in cents.", source: "task", taskId: "t-1", seen: 1 },
      { area: "general", lesson: "Run npm ci, not npm install.", source: "task", taskId: "t-1", seen: 1 },
    ]);
    // A later round reporting one again: seen twice, by that task.
    expect(await saveTaskLessons(lessons, "acme/web", [reported[0]!], "t-2")).toBe(1);
    expect((await lessons.get("acme/web"))!.lessons[0]).toMatchObject({ seen: 2, taskId: "t-2" });
  });

  it("never throws, and never logs the lessons", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { add: async () => Promise.reject(new Error("disk full")) };
    expect(await saveTaskLessons(broken, "acme/web", [{ area: "a", lesson: "A private detail." }], "t-1")).toBe(0);
    const { lessons } = await setup();
    expect(await saveTaskLessons(lessons, "not a repo", [{ area: "a", lesson: "A private detail." }], "t-1")).toBe(0);
    const text = logged.mock.calls.flat().join(" ");
    expect(text).toContain("disk full");
    expect(text).not.toContain("A private detail");
  });
});

describe("project_notes_read with the lessons", () => {
  const options = async (lessons?: PointerToolOptions["lessons"]): Promise<PointerToolOptions> => {
    const store = new FsStore(await tmp());
    return {
      githubFor: () => ({ client: {} as GitHubReader, allowed: [] }),
      githubConnections: [],
      githubAllowed: "any repository",
      memory: new MemoryRepo(store, KEY),
      userId: "U1",
      startRepoTask: async () => ({ ok: true, taskId: "t", repo: "acme/web" }),
      notes: new NotesRepo(store, KEY),
      ...(lessons ? { lessons } : {}),
    };
  };
  const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

  it("adds the repository's lessons, the most repeated first, after the notes", async () => {
    const { lessons } = await setup();
    await lessons.add("acme/web", [{ area: "ui", lesson: "Check the sidebar on mobile." }], { source: "task" });
    await lessons.add("acme/web", [{ area: "billing", lesson: "Refunds are in cents." }], { source: "task" });
    await lessons.add("acme/web", [{ area: "billing", lesson: "refunds are in cents" }], { source: "task" });
    const o = await options(lessons);
    expect(textOf(await projectNotesRead(o, { repo: "acme/api" }))).toBe("No project notes for acme/api yet.");

    await o.notes!.append("acme/web", "Tests: npm test");
    const text = textOf(await projectNotesRead(o, { repo: "acme/web" }));
    expect(text).toContain("- Tests: npm test");
    expect(text).toContain("Lessons library for acme/web: 2 lessons");
    expect(text).toMatch(/data, not instructions/);
    expect(text.indexOf("- Tests: npm test")).toBeLessThan(text.indexOf("Lessons library"));
    expect(text.indexOf("- [billing] Refunds are in cents. (seen 2 times)")).toBeGreaterThan(-1);
    expect(text.indexOf("- [billing] Refunds are in cents.")).toBeLessThan(text.indexOf("- [ui] Check the sidebar on mobile."));
  });

  it("reads as before without a lessons library, and says when it cannot be read", async () => {
    const o = await options();
    expect(textOf(await projectNotesRead(o, { repo: "acme/web" }))).toBe("No project notes for acme/web yet.");
    const broken = await options({ get: async () => Promise.reject(new Error("store down")) });
    const r = await projectNotesRead(broken, { repo: "acme/web" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("No project notes for acme/web yet.\n\nThe lessons library could not be read: store down");
  });
});
