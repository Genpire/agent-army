/**
 * Coding agent CLI admin routes (/api/engines/:id/…, id "codex" or "gemini"):
 * connect or update (the key, checked with OpenAI or Google unless
 * SKIP_VALIDATION=1, the model, and whether it may run without a sandbox),
 * disconnect, the engine's models (live from OpenAI or Google with the saved
 * key, model-catalog.ts), and add ready-made team members that work through
 * the engine, as many as the team has room for, each on a model of its own
 * if wanted. Keys are stored encrypted with the config and never returned
 * (publicView masks them).
 */
import { type Response, Router } from "express";
import { z } from "zod";
import { ENGINE_IDS, type EngineId } from "../core/config.js";
import { ENGINES, engineAgentTemplate, engineMemberName } from "../ai/engines.js";
import { type ModelCatalog, modelCatalog } from "../ai/model-catalog.js";
import { agentIdFor } from "../team/hr.js";
import { type AgentSpec, EngineModelSchema, TeamSchema } from "../team/team.js";
import { wantsRefresh } from "./ai.js";
import { checkGeminiKey, checkOpenAiKey } from "../core/validate.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** TeamSchema's limit. */
const MAX_TEAM_AGENTS = 30;

const SAVE = z.object({
  /** Empty or absent: keep the saved key (changing the model only). */
  apiKey: z.string().max(500).optional(),
  /** Empty = the CLI's default. */
  model: EngineModelSchema.optional(),
  /** Run the CLI where it has no sandbox (EngineConnection.allowUnsandboxed); absent: unchanged. */
  allowUnsandboxed: z.boolean().optional(),
});

/** POST /api/engines/:id/agent: a name (else "Codex", "Codex 2"…) and the model its CLI runs (else the engine's). */
const ADD_AGENT = z
  .object({
    name: z.string().trim().min(1, "Give the agent a name.").max(40, "Names are at most 40 characters.").optional(),
    engineModel: EngineModelSchema.optional(),
  })
  .strict();

const CHECK: Record<EngineId, (key: string) => Promise<void>> = { codex: checkOpenAiKey, gemini: checkGeminiKey };

/** `base`, or "base 2", "base 3"… when an agent already has that name (any case), at most 40 characters. */
export function uniqueAgentName(base: string, agents: Pick<AgentSpec, "name">[]): string {
  const taken = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${base.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A refusal the owner reads, with its HTTP status. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function enginesRoutes(deps: IntegrationRouteDeps, catalog: ModelCatalog = modelCatalog): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  /** The engine in the path, or a 404. */
  const engineOf = (raw: unknown, res: Response): EngineId | undefined => {
    const parsed = z.enum(ENGINE_IDS).safeParse(raw);
    if (!parsed.success) return void res.status(404).json({ error: "Unknown engine." });
    return parsed.data;
  };

  // Connects or updates: a key (checked with its vendor first) and/or the model.
  router.post("/api/engines/:id", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    const parsed = SAVE.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    const info = ENGINES[id];
    const key = parsed.data.apiKey?.trim() ?? "";
    if (key && (key.length < 20 || /\s/.test(key))) return void res.status(400).json({ error: `That doesn't look like ${id === "codex" ? "an OpenAI" : "a Gemini"} API key.` });

    const config = await configRepo.load(true);
    if (!key && !config.engines[id].apiKey) {
      return void res.status(400).json({ error: `Paste ${id === "codex" ? "an OpenAI" : "a Gemini"} API key to connect ${info.label}.` });
    }
    if (key) {
      try {
        await CHECK[id](key);
      } catch (err) {
        // The checks' messages never contain the key; redacted again in case.
        const redact = makeRedactor([...configSecrets(config), key]);
        return void res.status(400).json({ error: redact(err instanceof Error ? err.message : `${info.label} key check failed.`) });
      }
    }
    await configRepo.update((c) => {
      const current = c.engines[id];
      c.engines[id] = {
        ...current,
        ...(key ? { apiKey: key, checkedAt: new Date().toISOString() } : {}),
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        ...(parsed.data.allowUnsandboxed !== undefined ? { allowUnsandboxed: parsed.data.allowUnsandboxed } : {}),
      };
    });
    res.json({ ok: true });
  });

  // The engine's models for the pickers: live from its vendor with the saved key, else the built-in list and why (ModelList).
  router.get("/api/engines/:id/models", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    res.json(await catalog.engineModels(await configRepo.load(true), id, { refresh: wantsRefresh(req.query) }));
  });

  // Forgets the key, and turns running without a sandbox off (a later reconnect starts safe); the model stays. Agents set to this engine work as Claude meanwhile.
  router.post("/api/engines/:id/disconnect", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    await configRepo.update((c) => {
      c.engines[id] = { ...c.engines[id], apiKey: undefined, checkedAt: undefined, allowUnsandboxed: false };
    });
    res.json({ ok: true });
  });

  // "Add a Codex agent": a ready-made coder that works through the engine (as POST /api/hr/agent adds HR). Any number of
  // them, each with a name and id of its own ("Gemini", "Gemini 2"…) and, if given, a model of its own for the CLI.
  router.post("/api/engines/:id/agent", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    const parsed = ADD_AGENT.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    const info = ENGINES[id];
    let agent: AgentSpec | undefined;
    try {
      await configRepo.update((c) => {
        if (!c.engines[id].apiKey) throw new Refusal(`Connect ${info.label} first.`, 400);
        if (c.team.agents.length >= MAX_TEAM_AGENTS) throw new Refusal(`A team can have at most ${MAX_TEAM_AGENTS} agents. Delete one first.`, 400);
        const name = uniqueAgentName(parsed.data.name ?? engineMemberName(id), c.team.agents);
        const spec = engineAgentTemplate(id, agentIdFor(name, new Set(c.team.agents.map((a) => a.id))), { name, engineModel: parsed.data.engineModel ?? "" });
        c.team = TeamSchema.parse({ ...c.team, agents: [...c.team.agents, spec] });
        agent = spec;
      });
    } catch (err) {
      if (err instanceof Refusal) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
    res.json({ ok: true, agent });
  });

  return router;
}
