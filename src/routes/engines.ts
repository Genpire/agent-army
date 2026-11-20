/**
 * Coding agent CLI admin routes (/api/engines/:id/…, id "codex" or "gemini"):
 * connect or update (the key, checked with OpenAI or Google unless
 * SKIP_VALIDATION=1, the model, and whether it may run without a sandbox),
 * disconnect, and add a ready-made team member that works through the engine. Keys are stored encrypted with the
 * config and never returned (publicView masks them).
 */
import { type Response, Router } from "express";
import { z } from "zod";
import { ENGINE_IDS, type EngineId } from "../core/config.js";
import { ENGINES, engineAgentTemplate, engineAgents } from "../ai/engines.js";
import { agentIdFor } from "../team/hr.js";
import { type AgentSpec, TeamSchema } from "../team/team.js";
import { checkGeminiKey, checkOpenAiKey } from "../core/validate.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** TeamSchema's limit. */
const MAX_TEAM_AGENTS = 30;

const SAVE = z.object({
  /** Empty or absent: keep the saved key (changing the model only). */
  apiKey: z.string().max(500).optional(),
  /** Empty = the CLI's default. */
  model: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$|^$/, "A model id is letters, digits and . _ : / -, like the CLI's --model takes.")
    .optional(),
  /** Run the CLI where it has no sandbox (EngineConnection.allowUnsandboxed); absent: unchanged. */
  allowUnsandboxed: z.boolean().optional(),
});

const CHECK: Record<EngineId, (key: string) => Promise<void>> = { codex: checkOpenAiKey, gemini: checkGeminiKey };

/** A refusal the owner reads, with its HTTP status. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function enginesRoutes(deps: IntegrationRouteDeps): Router {
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

  // Forgets the key, and turns running without a sandbox off (a later reconnect starts safe); the model stays. Agents set to this engine work as Claude meanwhile.
  router.post("/api/engines/:id/disconnect", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    await configRepo.update((c) => {
      c.engines[id] = { ...c.engines[id], apiKey: undefined, checkedAt: undefined, allowUnsandboxed: false };
    });
    res.json({ ok: true });
  });

  // "Add Codex to the team": a ready-made coder that works through the engine (as POST /api/hr/agent adds HR).
  router.post("/api/engines/:id/agent", requireAdmin, async (req, res) => {
    const id = engineOf(req.params.id, res);
    if (!id) return;
    const info = ENGINES[id];
    let agent: AgentSpec | undefined;
    try {
      await configRepo.update((c) => {
        if (!c.engines[id].apiKey) throw new Refusal(`Connect ${info.label} first.`, 400);
        const existing = engineAgents(c.team, id)[0];
        if (existing) throw new Refusal(`${existing.name} already works through ${info.label}.`, 409);
        if (c.team.agents.length >= MAX_TEAM_AGENTS) throw new Refusal(`A team can have at most ${MAX_TEAM_AGENTS} agents. Delete one first.`, 400);
        const spec = engineAgentTemplate(id, agentIdFor(id === "codex" ? "Codex" : "Gemini", new Set(c.team.agents.map((a) => a.id))));
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
