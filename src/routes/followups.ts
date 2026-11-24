/**
 * The owner's follow-ups in the console (/api/followups, admin only): the
 * list, adding one, closing, reopening and snoozing an item by its number,
 * and the reminders' settings (config.followups: the morning brief, the
 * reminder before meetings, following Gmail). See followups/types.ts.
 * Times without an offset ("2026-11-24T15:00", as a browser's date-time
 * field gives them) are in the organisation's timezone. No item is logged.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { type FollowupSettings, FollowupSettingsSchema } from "../core/config.js";
import { remindersPaused } from "../followups/reminders.js";
import { FOLLOWUP_LIMITS, type FollowupStore } from "../followups/store.js";
import { parseWhen, zoneOf } from "../followups/time.js";
import type { IntegrationRouteDeps } from "./types.js";

const LIST = z.object({ status: z.enum(["open", "done"], "status is open or done.").optional() });
const ADD = z.object({
  title: z.string("Say what to follow up on.").trim().min(1, "Say what to follow up on.").max(FOLLOWUP_LIMITS.title, `A title has at most ${FOLLOWUP_LIMITS.title} characters.`),
  detail: z.string().max(FOLLOWUP_LIMITS.detail, `The detail has at most ${FOLLOWUP_LIMITS.detail} characters.`).optional(),
  remindAt: z.string().trim().max(40).optional(),
  repeatMin: z
    .number()
    .int()
    .min(0)
    .max(FOLLOWUP_LIMITS.maxRepeatMin, "Repeat at least once a week.")
    .refine((m) => m === 0 || m >= FOLLOWUP_LIMITS.minRepeatMin, `Repeat at most every ${FOLLOWUP_LIMITS.minRepeatMin} minutes.`)
    .optional(),
});
const SNOOZE = z.object({ until: z.string("Say until when.").trim().min(1, "Say until when.").max(40) });
const SETTINGS = z
  .object({
    morningBrief: z
      .object({
        enabled: z.boolean(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, like 08:30"),
        days: z.array(z.number().int().min(0).max(6)).max(7),
      })
      .partial()
      .optional(),
    meetingReminderMin: z.number().int().min(0).max(240).optional(),
    trackGmail: z.boolean().optional(),
  })
  .refine((s) => Object.keys(s).length > 0, "Send morningBrief, meetingReminderMin or trackGmail.");
const NUMBER_RE = /^[1-9]\d{0,5}$/;

export function followupsRoutes(deps: Pick<IntegrationRouteDeps, "configRepo" | "requireAdmin"> & { followups: FollowupStore; now?: () => Date }): Router {
  const { configRepo, requireAdmin, followups } = deps;
  const now = deps.now ?? (() => new Date());
  const router = Router();

  const parse = <T extends z.ZodType>(schema: T, input: unknown, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };
  /** The item's number from the path, or a 404. */
  const numberOf = (req: Request, res: Response): number | undefined => {
    const n = String(req.params.n ?? "");
    if (NUMBER_RE.test(n)) return Number(n);
    res.status(404).json({ error: "Follow-up not found." });
    return undefined;
  };
  const timeZone = async () => zoneOf((await configRepo.load()).timezone);

  router.get("/api/followups", requireAdmin, async (req, res) => {
    const query = parse(LIST, req.query, res);
    if (!query) return;
    const [items, config] = await Promise.all([followups.list({ status: query.status ?? "open" }), configRepo.load()]);
    const user = config.slack.user?.userId;
    // Why no reminder goes out now although an account is connected (the list is not that account's), for the page.
    const paused = user ? await remindersPaused(followups, user) : undefined;
    res.json({ items, settings: config.followups, ...(paused ? { paused } : {}) });
  });

  router.post("/api/followups", requireAdmin, async (req, res) => {
    const input = parse(ADD, req.body, res);
    if (!input) return;
    let remindAt: string | undefined;
    if (input.remindAt) {
      const when = parseWhen(input.remindAt, await timeZone(), now());
      if (!when.ok) return void res.status(400).json({ error: when.error });
      remindAt = when.at.toISOString();
    }
    if (input.repeatMin && !remindAt) return void res.status(400).json({ error: "A repeat needs remindAt: when to remind the first time." });
    const added = await followups.add({
      title: input.title,
      source: "owner",
      ...(input.detail ? { detail: input.detail } : {}),
      ...(remindAt ? { remindAt } : {}),
      ...(input.repeatMin ? { repeatMin: input.repeatMin } : {}),
    });
    if (added.status === "full") return void res.status(409).json({ error: `The list holds ${FOLLOWUP_LIMITS.items} open items, the most it can. Close some first.` });
    res.json({ ok: true, item: added.item });
  });

  router.post("/api/followups/settings", requireAdmin, async (req, res) => {
    const input = parse(SETTINGS, req.body, res);
    if (!input) return;
    let settings: FollowupSettings | undefined;
    let problem: string | undefined;
    await configRepo.update((c) => {
      const next = {
        ...c.followups,
        ...(input.meetingReminderMin !== undefined ? { meetingReminderMin: input.meetingReminderMin } : {}),
        ...(input.trackGmail !== undefined ? { trackGmail: input.trackGmail } : {}),
        morningBrief: {
          ...c.followups.morningBrief,
          ...input.morningBrief,
          ...(input.morningBrief?.days ? { days: [...new Set(input.morningBrief.days)].sort((a, b) => a - b) } : {}),
        },
      };
      const checked = FollowupSettingsSchema.safeParse(next);
      if (!checked.success) {
        problem = checked.error.issues[0]?.message ?? "Invalid settings.";
        return;
      }
      c.followups = checked.data;
      settings = checked.data;
    });
    if (problem || !settings) return void res.status(400).json({ error: problem ?? "Invalid settings." });
    res.json({ ok: true, settings });
  });

  router.post("/api/followups/:n/done", requireAdmin, async (req, res) => {
    const n = numberOf(req, res);
    if (n === undefined) return;
    const r = await followups.done([n]);
    const item = r.closed[0] ?? r.alreadyDone[0];
    if (!item) return void res.status(404).json({ error: "Follow-up not found." });
    res.json({ ok: true, item });
  });

  router.post("/api/followups/:n/reopen", requireAdmin, async (req, res) => {
    const n = numberOf(req, res);
    if (n === undefined) return;
    const item = await followups.reopen(n);
    if (!item) return void res.status(404).json({ error: "Follow-up not found." });
    res.json({ ok: true, item });
  });

  router.post("/api/followups/:n/snooze", requireAdmin, async (req, res) => {
    const n = numberOf(req, res);
    if (n === undefined) return;
    const input = parse(SNOOZE, req.body, res);
    if (!input) return;
    const at = now();
    const until = parseWhen(input.until, await timeZone(), at);
    if (!until.ok) return void res.status(400).json({ error: until.error });
    if (until.at.getTime() <= at.getTime()) return void res.status(400).json({ error: "That time has passed: snooze until a later time." });
    const r = await followups.snooze(n, until.at);
    if (!r.ok) return void res.status(r.reason === "closed" ? 409 : 404).json({ error: r.reason === "closed" ? "This follow-up is closed: reopen it first." : "Follow-up not found." });
    res.json({ ok: true, item: r.item });
  });

  return router;
}
