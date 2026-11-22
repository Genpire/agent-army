import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt, deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { createApp } from "../../src/server.js";
import { LESSON_AREA_MAX_CHARS, LESSON_TEXT_MAX_CHARS } from "../../src/team/agents.js";
import { LESSONS_MAX_PER_REPO, LessonsRepo } from "../../src/team/lessons.js";

const REPO_HINT = "Repositories look like owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo.";
const CLAUDE_KEY = "sk-ant-api03-lessons-route-secret";
const EMPTY_LIST = { repos: [], max: LESSONS_MAX_PER_REPO, areaMaxChars: LESSON_AREA_MAX_CHARS, lessonMaxChars: LESSON_TEXT_MAX_CHARS };

/** The lessons library's admin routes through the real HTTP API. */
describe("lessons admin API", () => {
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
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const failure = async (res: Response | Promise<Response>) => {
    const r = await res;
    return { status: r.status, error: ((await r.json()) as { error: string }).error };
  };
  const repoLessons = async (repo: string) => (await get(`/api/lessons/repo?repo=${encodeURIComponent(repo)}`)).json();

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    dir = await mkdtemp(join(tmpdir(), "army-lessons-api-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/api/anthropic", { apiKey: CLAUDE_KEY })).status).toBe(200);
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    expect((await get("/api/lessons", false)).status).toBe(401);
    expect((await get("/api/lessons/repo?repo=acme/web", false)).status).toBe(401);
    expect((await post("/api/lessons", { repo: "acme/web", area: "a", lesson: "x" }, false)).status).toBe(401);
    expect((await post("/api/lessons/delete", { repo: "acme/web", id: "l-1" }, false)).status).toBe(401);
    expect(await (await get("/api/lessons")).json()).toEqual(EMPTY_LIST);
  });

  it("validates what it is given", async () => {
    expect(await failure(get("/api/lessons/repo"))).toEqual({ status: 400, error: REPO_HINT });
    expect(await failure(get("/api/lessons/repo?repo=../etc/passwd"))).toEqual({ status: 400, error: REPO_HINT });
    expect(await failure(post("/api/lessons", { repo: "gitlab:../x", area: "a", lesson: "x" }))).toEqual({ status: 400, error: REPO_HINT });
    expect(await failure(post("/api/lessons", { area: "a", lesson: "x" }))).toEqual({ status: 400, error: "Give the repository." });
    expect(await failure(post("/api/lessons", { repo: "acme/web", area: "a", lesson: "   " }))).toEqual({ status: 400, error: "Write the lesson." });
    expect(await failure(post("/api/lessons", { repo: "acme/web", area: "a", lesson: 42 }))).toEqual({ status: 400, error: "Write the lesson." });
    expect(await failure(post("/api/lessons", { repo: "acme/web", area: "a", lesson: "x".repeat(LESSON_TEXT_MAX_CHARS + 1) }))).toEqual({
      status: 400,
      error: `Lessons are at most ${LESSON_TEXT_MAX_CHARS} characters.`,
    });
    expect(await failure(post("/api/lessons", { repo: "acme/web", area: "a".repeat(LESSON_AREA_MAX_CHARS + 1), lesson: "x" }))).toEqual({
      status: 400,
      error: `Areas are at most ${LESSON_AREA_MAX_CHARS} characters.`,
    });
    // Only punctuation: nothing to keep.
    expect(await failure(post("/api/lessons", { repo: "acme/web", area: "a", lesson: "?!" }))).toEqual({ status: 400, error: "Write the lesson." });
    expect(await failure(post("/api/lessons/delete", { repo: "acme/web" }))).toEqual({ status: 400, error: "Give the lesson's id." });
    expect(await failure(post("/api/lessons/delete", { repo: "nope", id: "l-1" }))).toEqual({ status: 400, error: REPO_HINT });
    expect(await (await get("/api/lessons")).json()).toEqual(EMPTY_LIST);
  });

  it("adds, lists, counts a repeat and deletes", async () => {
    const first = await post("/api/lessons", { repo: " Acme/web ", area: "  Billing ", lesson: "Refunds are in cents." });
    expect(first.status).toBe(200);
    const added = await first.json();
    expect(added).toMatchObject({ ok: true, repeated: false, lesson: { area: "billing", lesson: "Refunds are in cents.", seen: 1, source: "owner" } });
    expect(added.lesson.taskId).toBeUndefined();

    const again = await (await post("/api/lessons", { repo: "acme/web", lesson: "refunds are in cents" })).json();
    expect(again).toMatchObject({ ok: true, repeated: true, lesson: { id: added.lesson.id, seen: 2, area: "billing" } });
    await new Promise((r) => setTimeout(r, 5));
    const other = await (await post("/api/lessons", { repo: "gitlab:acme/platform/web", lesson: "Deploys need the VPN." })).json();
    expect(other.lesson.area).toBe("general");

    const list = await (await get("/api/lessons")).json();
    expect(list.repos.map((r: { repo: string; count: number }) => [r.repo, r.count])).toEqual([
      ["gitlab:acme/platform/web", 1],
      ["Acme/web", 1],
    ]);
    expect(await repoLessons("ACME/WEB")).toMatchObject({ repo: "Acme/web", lessons: [{ id: added.lesson.id, seen: 2 }], updatedAt: expect.any(String) });
    // A repository without lessons is an empty list, not a 404.
    expect(await repoLessons("acme/api")).toEqual({ repo: "acme/api", lessons: [], updatedAt: null });

    expect(await failure(post("/api/lessons/delete", { repo: "gitlab:acme/platform/web", id: added.lesson.id }))).toEqual({ status: 404, error: "Lesson not found." });
    expect(await (await post("/api/lessons/delete", { repo: "acme/web", id: added.lesson.id })).json()).toEqual({ ok: true });
    expect(await repoLessons("acme/web")).toEqual({ repo: "acme/web", lessons: [], updatedAt: null });
    expect((await (await get("/api/lessons")).json()).repos.map((r: { repo: string }) => r.repo)).toEqual(["gitlab:acme/platform/web"]);
  });

  it("lists a repository's lessons, the most recently seen first", async () => {
    await post("/api/lessons", { repo: "acme/api", area: "db", lesson: "Migrations need a lock." });
    await new Promise((r) => setTimeout(r, 5));
    await post("/api/lessons", { repo: "acme/api", area: "db", lesson: "Seeds run after migrations." });
    const texts = async () => ((await repoLessons("acme/api")).lessons as { lesson: string }[]).map((l) => l.lesson);
    expect(await texts()).toEqual(["Seeds run after migrations.", "Migrations need a lock."]);
    await new Promise((r) => setTimeout(r, 5));
    // Seen again: it comes first again.
    await post("/api/lessons", { repo: "acme/api", area: "db", lesson: "migrations need a lock" });
    expect(await texts()).toEqual(["Migrations need a lock.", "Seeds run after migrations."]);
  });

  it("redacts the platform's credentials from what the owner adds", async () => {
    const res = await (await post("/api/lessons", { repo: "acme/keys", area: `keys ${CLAUDE_KEY}`, lesson: `The key ${CLAUDE_KEY} is for staging.` })).json();
    expect(res.lesson).toMatchObject({ area: "keys [redacted]", lesson: "The key [redacted] is for staging." });
    const raw = await new FsStore(dir).get("lessons/acme__keys.enc");
    expect(decrypt(deriveKey("m"), raw!)).not.toContain(CLAUDE_KEY);
    // The same library the worker reads.
    expect((await new LessonsRepo(new FsStore(dir), deriveKey("m")).get("acme/keys"))?.lessons).toHaveLength(1);
  });
});
