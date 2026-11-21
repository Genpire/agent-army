/**
 * Routines admin routes (/api/routines, behind requireAdmin) and the tick
 * (POST /routines/tick, outside /api): an external scheduler sends the tick
 * secret in the X-Routines-Secret header to wake a service that scales to
 * zero, and the request lasts until the runs it started have ended.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { ROUTINE_ID_RE } from "../core/config.js";
import { RUN_ID_RE } from "../routines/runs.js";
import { type RoutineDraft, type RoutineService, TICK_HEADER, TICK_PATH } from "../routines/service.js";
import type { IntegrationRouteDeps } from "./types.js";

/** GET /api/routines/tick: how an external scheduler wakes this service. */
export interface TickInfo {
  url: string;
  header: string;
  secret: string;
  method: "POST";
}

const NOT_FOUND = "Routine not found.";
/** Failed tick attempts allowed per address per 10 minutes (successful ones are not counted). */
const MAX_TICK_FAILURES = 20;

const DELIVER = z
  .object({
    email: z.array(z.string().max(200, "Email addresses are at most 200 characters.")).max(20, "A routine emails at most 20 addresses.").optional(),
    slack: z.string().max(200).optional(),
    console: z.boolean().optional(),
  })
  .optional();
const BUDGET = z.number("The budget per run is a number of USD.").min(0.05, "The budget per run is at least $0.05.").max(20, "The budget per run is at most $20.");

/** A routine as the page sends it (the shape of config.routines). */
const ROUTINE_BODY = z.object({
  name: z.string().max(200).optional(),
  instruction: z.string().max(8000, "The instruction is limited to 8 000 characters.").optional(),
  schedule: z.object({ cron: z.string().max(100).optional(), timezone: z.string().max(64).optional() }).optional(),
  deliver: DELIVER,
  budgetUsd: BUDGET.optional(),
  enabled: z.boolean().optional(),
});
const PREVIEW_BODY = z.object({ cron: z.string().max(100), timezone: z.string().max(64).optional() });

function toDraft(input: z.infer<typeof ROUTINE_BODY>): RoutineDraft {
  const draft: RoutineDraft = {};
  if (input.name !== undefined) draft.name = input.name;
  if (input.instruction !== undefined) draft.instruction = input.instruction;
  if (input.schedule?.cron !== undefined) draft.cron = input.schedule.cron;
  if (input.schedule?.timezone !== undefined) draft.timezone = input.schedule.timezone;
  if (input.deliver?.email !== undefined) draft.email = input.deliver.email;
  if (input.deliver?.slack !== undefined) draft.slack = input.deliver.slack;
  if (input.deliver?.console !== undefined) draft.console = input.deliver.console;
  if (input.budgetUsd !== undefined) draft.budgetUsd = input.budgetUsd;
  if (input.enabled !== undefined) draft.enabled = input.enabled;
  return draft;
}

export function routinesRoutes(deps: IntegrationRouteDeps & { routines: RoutineService }): Router {
  const { requireAdmin, routines, configRepo } = deps;
  const router = Router();

  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };
  const routineId = (req: Request, res: Response): string | undefined => {
    const id = String(req.params.id ?? "");
    if (ROUTINE_ID_RE.test(id)) return id;
    res.status(404).json({ error: NOT_FOUND });
    return undefined;
  };
  const tickInfo = async (req: Request): Promise<TickInfo> => ({ url: `${deps.baseUrl(req)}${TICK_PATH}`, header: "X-Routines-Secret", secret: await routines.repo.tickSecret(), method: "POST" });

  // ---------- The tick (no session: the secret header) ----------

  const failures = new Map<string, { n: number; resetAt: number }>();
  router.post(TICK_PATH, async (req, res) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = failures.get(key);
    if (entry && entry.resetAt > now && entry.n >= MAX_TICK_FAILURES) return void res.status(429).json({ error: "Too many attempts. Try again later." });
    const header = req.get(TICK_HEADER);
    if (!(await routines.checkTickSecret(header))) {
      if (!entry || entry.resetAt <= now) failures.set(key, { n: 1, resetAt: now + 10 * 60_000 });
      else entry.n += 1;
      if (failures.size > 10_000) failures.clear();
      return void res.status(401).json({ error: "Send the routines tick secret in the X-Routines-Secret header." });
    }
    try {
      const { finished, ...result } = await routines.scheduler.tick();
      // The runs this tick started are awaited: on a platform that only gives CPU during requests they finish inside it.
      const runs = await finished;
      res.json({ ok: true, ...result, finished: runs.map((r) => ({ routineId: r.routineId, runId: r.id, status: r.status })) });
    } catch (err) {
      console.error("[routines] tick failed:", err instanceof Error ? err.message.slice(0, 300) : "unknown error");
      res.status(500).json({ error: "The tick failed." });
    }
  });

  // ---------- Admin ----------

  router.get("/api/routines", requireAdmin, async (_req, res) => {
    res.json(await routines.list());
  });

  router.post("/api/routines", requireAdmin, async (req, res) => {
    const input = body(ROUTINE_BODY, req, res);
    if (!input) return;
    const result = await routines.create(toDraft(input), "Admin (console)");
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true, routine: result.routine });
  });

  router.post("/api/routines/preview", requireAdmin, async (req, res) => {
    const input = body(PREVIEW_BODY, req, res);
    if (!input) return;
    const preview = routines.preview(input.cron, input.timezone, await configRepo.load());
    if (!preview.ok) return void res.status(400).json({ error: preview.error });
    res.json(preview);
  });

  router.get("/api/routines/tick", requireAdmin, async (req, res) => {
    res.json(await tickInfo(req));
  });

  router.post("/api/routines/tick/rotate", requireAdmin, async (req, res) => {
    await routines.repo.rotateTickSecret();
    res.json({ ok: true, ...(await tickInfo(req)) });
  });

  router.get("/api/routines/:id", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    const routine = await routines.get(id);
    if (!routine) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ routine });
  });

  router.post("/api/routines/:id", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    const input = body(ROUTINE_BODY, req, res);
    if (!input) return;
    const result = await routines.update(id, toDraft(input));
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true, routine: result.routine });
  });

  router.post("/api/routines/:id/delete", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    if (!(await routines.remove(id))) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ ok: true });
  });

  router.post("/api/routines/:id/run", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    const started = await routines.runNow(id);
    if (!started.ok) return void res.status(started.status).json({ error: started.error });
    res.status(202).json({ ok: true, run: started.run });
  });

  router.get("/api/routines/:id/runs", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    if (!(await routines.get(id))) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ runs: await routines.runs(id) });
  });

  router.get("/api/routines/:id/runs/:runId", requireAdmin, async (req, res) => {
    const id = routineId(req, res);
    if (!id) return;
    const runId = String(req.params.runId ?? "");
    const run = RUN_ID_RE.test(runId) ? await routines.run(id, runId) : null;
    if (!run) return void res.status(404).json({ error: "Run not found." });
    res.json({ run });
  });

  return router;
}
