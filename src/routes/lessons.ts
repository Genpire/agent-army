/**
 * The lessons library's admin routes (/api/lessons, behind requireAdmin): the
 * repositories with lessons, one repository's lessons, adding one by hand and
 * deleting one. Lessons added here are redacted with every credential the
 * config holds, like those from tasks (team/lessons.ts).
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { REPO_FORMAT_HINT, REPO_ID_MAX, isRepoId } from "../integrations/code-hosts/repo-id.js";
import { LESSON_AREA_MAX_CHARS, LESSON_TEXT_MAX_CHARS } from "../team/agents.js";
import { LESSONS_MAX_PER_REPO, type Lesson, type LessonsRepo, type LessonsSummary } from "../team/lessons.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** GET /api/lessons */
export interface LessonsList {
  repos: LessonsSummary[];
  /** Lessons kept per repository; beyond it, the ones seen longest ago go. */
  max: number;
  /** The longest area and lesson POST /api/lessons takes, for the page's fields. */
  areaMaxChars: number;
  lessonMaxChars: number;
}

/** GET /api/lessons/repo?repo=<id>: the lessons, the most recently seen first; none yet = an empty list and no update time. */
export interface RepoLessonsView {
  repo: string;
  lessons: Lesson[];
  updatedAt: string | null;
}

/** POST /api/lessons: the lesson as stored; `repeated` when it was already in the library (it is then seen once more). */
export interface AddLessonResult {
  ok: true;
  lesson: Lesson;
  repeated: boolean;
}

const REPO = z.string("Give the repository.").trim().max(REPO_ID_MAX).refine(isRepoId, REPO_FORMAT_HINT);
const ADD = z.object({
  repo: REPO,
  area: z.string("The area is text.").max(LESSON_AREA_MAX_CHARS, `Areas are at most ${LESSON_AREA_MAX_CHARS} characters.`).optional(),
  lesson: z
    .string("Write the lesson.")
    .trim()
    .min(1, "Write the lesson.")
    .max(LESSON_TEXT_MAX_CHARS, `Lessons are at most ${LESSON_TEXT_MAX_CHARS} characters.`),
});
const DELETE = z.object({ repo: REPO, id: z.string("Give the lesson's id.").min(1).max(100) });

export function lessonsRoutes(deps: IntegrationRouteDeps & { lessons: LessonsRepo }): Router {
  const { requireAdmin, lessons, configRepo } = deps;
  const router = Router();

  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };

  router.get("/api/lessons", requireAdmin, async (_req, res) => {
    const list: LessonsList = { repos: await lessons.list(), max: LESSONS_MAX_PER_REPO, areaMaxChars: LESSON_AREA_MAX_CHARS, lessonMaxChars: LESSON_TEXT_MAX_CHARS };
    res.json(list);
  });

  // Any repository id, in the query, like the notes: /api/lessons/repo?repo=gitlab:group/sub/project.
  router.get("/api/lessons/repo", requireAdmin, async (req, res) => {
    const repo = REPO.safeParse(req.query.repo);
    if (!repo.success) return void res.status(400).json({ error: REPO_FORMAT_HINT });
    const found = await lessons.get(repo.data);
    const view: RepoLessonsView = {
      repo: found?.repo ?? repo.data,
      lessons: [...(found?.lessons ?? [])].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      updatedAt: found?.updatedAt ?? null,
    };
    res.json(view);
  });

  router.post("/api/lessons", requireAdmin, async (req, res) => {
    const input = body(ADD, req, res);
    if (!input) return;
    const redact = makeRedactor(configSecrets(await configRepo.load(true)));
    const saved = await lessons.add(input.repo, [{ area: input.area ?? "", lesson: input.lesson }], { source: "owner", redact });
    if (!saved.ok) return void res.status(400).json({ error: saved.error });
    const lesson = saved.added[0] ?? saved.repeated[0];
    if (!lesson) return void res.status(400).json({ error: "Write the lesson." });
    res.json({ ok: true, lesson, repeated: saved.added.length === 0 } satisfies AddLessonResult);
  });

  router.post("/api/lessons/delete", requireAdmin, async (req, res) => {
    const input = body(DELETE, req, res);
    if (!input) return;
    if (!(await lessons.remove(input.repo, input.id))) return void res.status(404).json({ error: "Lesson not found." });
    res.json({ ok: true });
  });

  return router;
}
