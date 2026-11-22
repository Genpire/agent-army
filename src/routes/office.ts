/**
 * The office's AI talk (see office/talk.ts), admin only:
 *
 * - POST /api/office/talk { activityId, kind, people }: the conversation of
 *   one office activity, { lines, provider, model }, or { lines: [], reason }
 *   ("off", "limit", "unavailable") when there is none now and the page uses
 *   its canned lines. The same activity id gets the same conversation.
 *   Gaming takes two people: one playing alone has no talk.
 * - GET /api/office/talk/settings: { enabled, provider, model, dailyMax,
 *   usedToday, available: { gemini, chat } }.
 * - POST /api/office/talk/settings { enabled, provider, model, dailyMax }:
 *   saves them and answers as GET. A model is set only with "gemini" or
 *   "chat" (auto always uses the default models), checked with the model id
 *   rules of that provider (Gemini's are a coding agent CLI's).
 *
 * The bodies and answers are typed in office/talk-types.ts, which the web imports.
 */
import { Router } from "express";
import { z } from "zod";
import { modelIdProblem } from "../ai/model-ids.js";
import type { QueryFn } from "../chat/pointer.js";
import { OFFICE_TALK_DAILY_MAX, OFFICE_TALK_PROVIDERS } from "../core/config.js";
import { OfficeTalk } from "../office/talk.js";
import { TALK_MAX_PEOPLE, talkPeople } from "../office/talk-prompt.js";
import { TALK_KINDS } from "../office/talk-types.js";
import type { Spending } from "../spending/budget.js";
import type { UsageRepo } from "../spending/usage.js";
import type { IntegrationRouteDeps } from "./types.js";

export interface OfficeRouteDeps extends Pick<IntegrationRouteDeps, "configRepo" | "store" | "tasks" | "requireAdmin"> {
  usage?: Pick<UsageRepo, "month" | "recordChat">;
  spending?: Pick<Spending, "notify">;
  /** Tests pass fakes for Gemini and the Agent SDK. */
  fetch?: typeof fetch;
  queryFn?: QueryFn;
  now?: () => number;
}

const DAILY_ERROR = `The daily maximum is a whole number of conversations from 0 to ${OFFICE_TALK_DAILY_MAX}.`;

const TALK_INPUT = z
  .object({
    activityId: z.string({ error: "Name the activity." }).regex(/^[A-Za-z0-9:._-]{1,120}$/, "Activity ids are 1 to 120 letters, digits and : . _ -."),
    kind: z.enum(TALK_KINDS, { error: `The activity is ${TALK_KINDS.map((k) => `"${k}"`).join(", ")}.` }),
    people: z
      .array(z.string().max(40, "People are agent ids or \"pointer\"."), { error: "List the people in the activity." })
      .min(1, "List the people in the activity.")
      .max(TALK_MAX_PEOPLE, `At most ${TALK_MAX_PEOPLE} people talk at once.`)
      .transform((ids) => [...new Set(ids)]),
  })
  .refine((r) => r.kind !== "gaming" || r.people.length > 1, { message: "Gaming takes two people: one playing alone has no talk.", path: ["people"] });

const SETTINGS_INPUT = z
  .object({
    enabled: z.boolean({ error: "Say whether the office talks with AI (true or false)." }),
    provider: z.enum(OFFICE_TALK_PROVIDERS, { error: 'The provider is "auto", "gemini" or "chat".' }),
    model: z.string({ error: "The model is an id, or empty for the default." }).trim().max(200, "Model ids are at most 200 characters."),
    dailyMax: z.number({ error: DAILY_ERROR }).int(DAILY_ERROR).min(0, DAILY_ERROR).max(OFFICE_TALK_DAILY_MAX, DAILY_ERROR),
  })
  // Auto always uses the default models: a model belongs to the provider it runs on.
  .refine((s) => s.provider !== "auto" || !s.model, { message: "Choose Gemini or the chat provider to set a model.", path: ["model"] });

export function officeRoutes(deps: OfficeRouteDeps): Router {
  const { configRepo, requireAdmin } = deps;
  const talk = new OfficeTalk(deps);
  const router = Router();

  router.post("/api/office/talk", requireAdmin, async (req, res) => {
    const input = TALK_INPUT.safeParse(req.body);
    if (!input.success) return void res.status(400).json({ error: input.error.issues[0]?.message ?? "Invalid input." });
    const people = talkPeople((await configRepo.load()).team);
    const unknown = input.data.people.find((id) => !people.has(id));
    if (unknown !== undefined) return void res.status(400).json({ error: `"${unknown.slice(0, 40)}" is not in the office: people are enabled agents' ids or "pointer".` });
    res.json(await talk.talk(input.data));
  });

  router.get("/api/office/talk/settings", requireAdmin, async (_req, res) => {
    res.json(await talk.settings());
  });

  router.post("/api/office/talk/settings", requireAdmin, async (req, res) => {
    const input = SETTINGS_INPUT.safeParse(req.body);
    if (!input.success) return void res.status(400).json({ error: input.error.issues[0]?.message ?? "Invalid settings." });
    const settings = input.data;
    const problem = settings.model ? modelIdProblem(settings.model, settings.provider === "chat" ? "provider" : "engine") : undefined;
    if (problem) return void res.status(400).json({ error: problem });
    const config = await configRepo.update((c) => {
      c.office.talk = settings;
    });
    res.json(await talk.settings(config));
  });

  return router;
}
