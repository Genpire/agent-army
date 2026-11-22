import { describe, expect, it } from "vitest";
import type { RepoLessonsView } from "../src/routes/lessons.js";
import { type LessonsAnswer, loadRepoLessons } from "../web/src/pages/projects/LessonsTab.js";

/** The lessons tab while the owner switches repositories: answers can come back in any order. */

const view = (repo: string): RepoLessonsView => ({ repo, lessons: [], updatedAt: null });

/** A fake API whose answers the test sends, one repository at a time, in the order it likes. */
function slowApi() {
  const waiting = new Map<string, { answer: (v: RepoLessonsView) => void; fail: (err: Error) => void }>();
  const get = (path: string) =>
    new Promise<RepoLessonsView>((answer, fail) => {
      waiting.set(new URL(path, "http://x").searchParams.get("repo") ?? "", { answer, fail });
    });
  const answer = (repo: string) => waiting.get(repo)!.answer(view(repo));
  const fail = (repo: string, message: string) => waiting.get(repo)!.fail(new Error(message));
  return { get, answer, fail };
}

describe("the lessons tab, switching repositories", () => {
  it("drops a slow answer for a repository no longer on screen", async () => {
    const api = slowApi();
    let onScreen = "acme/web";
    const shown: LessonsAnswer[] = [];
    const o = { get: api.get, onScreen: () => onScreen, show: (a: LessonsAnswer) => shown.push(a) };

    const web = loadRepoLessons("acme/web", o);
    onScreen = "gitlab:acme/platform/api";
    const gitlab = loadRepoLessons("gitlab:acme/platform/api", o);
    api.answer("gitlab:acme/platform/api");
    await gitlab;
    // acme/web's answer comes back last: it must not replace the one on screen.
    api.answer("acme/web");
    await web;
    expect(shown).toEqual([{ view: view("gitlab:acme/platform/api") }]);
  });

  it("drops a failure for a repository no longer on screen, and shows one for the current", async () => {
    const api = slowApi();
    let onScreen = "acme/web";
    const shown: LessonsAnswer[] = [];
    const o = { get: api.get, onScreen: () => onScreen, show: (a: LessonsAnswer) => shown.push(a) };

    const web = loadRepoLessons("acme/web", o);
    onScreen = "acme/api";
    const other = loadRepoLessons("acme/api", o);
    api.fail("acme/web", "acme/web failed");
    await web;
    expect(shown).toEqual([]);
    api.fail("acme/api", "acme/api failed");
    await other;
    expect(shown).toEqual([{ error: "acme/api failed" }]);
  });
});
