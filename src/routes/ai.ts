/**
 * AI provider admin routes (/api/ai/…): the presets with each one's saved
 * connection (secrets masked), saving and testing a connection, removing one,
 * and choosing the providers chat and repo tasks run on. Anthropic's key
 * stays in config.anthropic (POST /api/anthropic keeps working); the others
 * live in config.ai.providers. See ai-providers.ts and ai-presets.ts.
 */
import { Router } from "express";
import { z } from "zod";
import type { AiPreset, ModelPrice, PresetCapabilities, PresetField, PresetKind, PresetModel } from "../ai/ai-presets.js";
import {
  AI_PRESETS,
  type ConnectionTestDeps,
  type ConnectionValues,
  buildRuntime,
  connectionOf,
  connectionProblem,
  presetFor,
  providerProblem,
  testConnection,
} from "../ai/ai-providers.js";
import { AI_PROVIDER_IDS, type AiProviderId, type Config, MODEL_TIERS, type ModelTier, mask } from "../core/config.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** One provider as the console sees it: the preset, and the saved connection without its secrets. */
export interface AiProviderView {
  id: AiProviderId;
  name: string;
  short: string;
  kind: PresetKind;
  logo: string;
  docsUrl: string;
  keyHelp: string;
  notes: string[];
  bestEffort: boolean;
  fields: PresetField[];
  /** The model each tier runs on when none is chosen ("" = Claude Code's own choice). */
  defaults: Record<ModelTier, string>;
  models: PresetModel[];
  /** With the saved settings applied (a custom endpoint's web search). */
  capabilities: PresetCapabilities;
  pricing: Record<string, ModelPrice>;
  /** Saved and complete: it can run chat or repo tasks. */
  configured: boolean;
  /** Saved but not usable, and why. */
  problem: string | null;
  /** The saved connection: secrets masked (last four characters), settings and models as saved. */
  saved: {
    secrets: Record<string, string | null>;
    settings: Record<string, string>;
    models: Partial<Record<ModelTier, string>>;
    checkedAt: string | null;
  } | null;
  /** It is the provider chat or repo tasks run on. */
  usedFor: { chat: boolean; task: boolean };
}

/** GET /api/ai/providers */
export interface AiProvidersView {
  chatProvider: AiProviderId;
  taskProvider: AiProviderId;
  providers: AiProviderView[];
}

export function providerView(config: Config, preset: AiPreset): AiProviderView {
  const conn = connectionOf(config, preset.id);
  // As providerProblem: a saved Anthropic key is enough.
  const problem = conn && preset.id !== "anthropic" ? (connectionProblem(preset.id, conn) ?? null) : null;
  const capabilities = conn && !problem ? buildRuntime(preset.id, conn).capabilities : preset.capabilities;
  return {
    id: preset.id,
    name: preset.name,
    short: preset.short,
    kind: preset.kind,
    logo: preset.logo,
    docsUrl: preset.docsUrl,
    keyHelp: preset.keyHelp,
    notes: preset.notes,
    bestEffort: preset.bestEffort,
    fields: preset.fields,
    defaults: preset.defaults,
    models: preset.models,
    capabilities,
    pricing: preset.pricing,
    configured: Boolean(conn) && !problem,
    problem,
    saved: conn
      ? {
          secrets: Object.fromEntries(Object.entries(conn.secrets).map(([k, v]) => [k, mask(v)])),
          settings: conn.settings,
          models: conn.models,
          checkedAt: conn.checkedAt ?? null,
        }
      : null,
    usedFor: { chat: config.ai.chatProvider === preset.id, task: config.ai.taskProvider === preset.id },
  };
}

export function providersView(config: Config): AiProvidersView {
  return {
    chatProvider: config.ai.chatProvider,
    taskProvider: config.ai.taskProvider,
    providers: AI_PRESETS.map((p) => providerView(config, p)),
  };
}

const FIELD_KEY = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/, "Unknown field.");
const PROVIDER_ID = z.enum(AI_PROVIDER_IDS);

/** A connection's changes: a secret "" keeps the saved one and null removes it; a setting or model "" goes back to the default. */
const CHANGES = z
  .object({
    secrets: z.record(FIELD_KEY, z.union([z.string().max(20_000, "That value is too long."), z.null()])).optional(),
    settings: z.record(FIELD_KEY, z.string().max(500, "That value is too long.")).optional(),
    models: z.partialRecord(z.enum(MODEL_TIERS), z.string().trim().max(200, "Model ids are at most 200 characters.")).optional(),
  })
  .strict();
type Changes = z.infer<typeof CHANGES>;

const ACTIVE = z
  .object({ chatProvider: PROVIDER_ID.optional(), taskProvider: PROVIDER_ID.optional() })
  .strict()
  .refine((x) => x.chatProvider || x.taskProvider, "Choose the provider for chat, for repo tasks, or both.");

/** The saved connection with the changes applied, or why the changes do not fit the preset. */
export function applyChanges(preset: AiPreset, saved: ConnectionValues | undefined, changes: Changes): { conn: ConnectionValues } | { error: string } {
  const secretKeys = new Set(preset.fields.filter((f) => f.secret).map((f) => f.key));
  const settingKeys = new Set(preset.fields.filter((f) => !f.secret).map((f) => f.key));
  const unknown =
    Object.keys(changes.secrets ?? {}).find((k) => !secretKeys.has(k)) ?? Object.keys(changes.settings ?? {}).find((k) => !settingKeys.has(k));
  if (unknown) return { error: `${preset.name} has no field "${unknown}".` };
  if (preset.id === "anthropic" && Object.keys(changes.models ?? {}).some((t) => t !== "main")) {
    return { error: "Anthropic runs Claude's own models: only the main model can be chosen." };
  }
  const secrets = { ...(saved?.secrets ?? {}) };
  for (const [key, value] of Object.entries(changes.secrets ?? {})) {
    if (value === null) delete secrets[key];
    else if (value.trim()) secrets[key] = value.trim();
  }
  const settings = { ...(saved?.settings ?? {}) };
  for (const [key, value] of Object.entries(changes.settings ?? {})) {
    if (value.trim()) settings[key] = value.trim();
    else delete settings[key];
  }
  const models: Partial<Record<ModelTier, string>> = { ...(saved?.models ?? {}) };
  for (const [tier, value] of Object.entries(changes.models ?? {}) as [ModelTier, string][]) {
    if (value) models[tier] = value;
    else delete models[tier];
  }
  return { conn: { secrets, settings, models, ...(saved?.checkedAt ? { checkedAt: saved.checkedAt } : {}) } };
}

/** Stores a connection: Anthropic's key and model in config.anthropic, the others in config.ai.providers. */
function store(c: Config, id: AiProviderId, conn: ConnectionValues, checkedAt: string | undefined): void {
  if (id === "anthropic") {
    c.anthropic = { apiKey: conn.secrets.apiKey, model: conn.models.main ?? "" };
    return;
  }
  c.ai.providers[id] = { secrets: conn.secrets, settings: conn.settings, models: conn.models, ...(checkedAt ? { checkedAt } : {}) };
}

export function aiRoutes(deps: IntegrationRouteDeps, check: ConnectionTestDeps = {}): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  const providerParam = (raw: unknown): AiProviderId | undefined => {
    const parsed = PROVIDER_ID.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };
  const body = <T extends z.ZodType>(schema: T, raw: unknown): { data: z.infer<T> } | { error: string } => {
    const parsed = schema.safeParse(raw ?? {});
    return parsed.success ? { data: parsed.data } : { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  };
  /** Errors from a provider are redacted again with every secret the config holds, the new values included. */
  const redactor = (config: Config, conn: ConnectionValues) => makeRedactor([...configSecrets(config), ...Object.values(conn.secrets)]);

  router.get("/api/ai/providers", requireAdmin, async (_req, res) => {
    res.json(providersView(await configRepo.load(true)));
  });

  // Saves a connection: checked against the preset's fields, then tested with the provider (unless SKIP_VALIDATION=1).
  router.post("/api/ai/providers/:id", requireAdmin, async (req, res) => {
    const id = providerParam(req.params.id);
    if (!id) return void res.status(404).json({ error: "Unknown AI provider." });
    const input = body(CHANGES, req.body);
    if ("error" in input) return void res.status(400).json({ error: input.error });
    const config = await configRepo.load(true);
    const preset = presetFor(id);
    const merged = applyChanges(preset, connectionOf(config, id), input.data);
    if ("error" in merged) return void res.status(400).json({ error: merged.error });
    const problem = connectionProblem(id, merged.conn);
    if (problem) return void res.status(400).json({ error: problem });
    let checkedAt: string | undefined = merged.conn.checkedAt;
    if (process.env.SKIP_VALIDATION !== "1") {
      const tested = await testConnection(id, merged.conn, check);
      if (!tested.ok) return void res.status(400).json({ error: redactor(config, merged.conn)(tested.error) });
      checkedAt = new Date().toISOString();
    }
    const saved = await configRepo.update((c) => store(c, id, merged.conn, checkedAt));
    res.json({ ok: true, provider: providerView(saved, preset) });
  });

  // Tests the saved connection, or the saved one with unsaved changes (nothing is saved but the time of a passing test).
  router.post("/api/ai/providers/:id/test", requireAdmin, async (req, res) => {
    const id = providerParam(req.params.id);
    if (!id) return void res.status(404).json({ error: "Unknown AI provider." });
    const input = body(CHANGES, req.body);
    if ("error" in input) return void res.status(400).json({ error: input.error });
    const config = await configRepo.load(true);
    const preset = presetFor(id);
    const saved = connectionOf(config, id);
    const changed = Boolean(input.data.secrets || input.data.settings || input.data.models);
    if (!saved && !changed) return void res.status(400).json({ error: `${preset.name} is not set up yet.` });
    const merged = applyChanges(preset, saved, input.data);
    if ("error" in merged) return void res.status(400).json({ error: merged.error });
    const tested = await testConnection(id, merged.conn, check);
    if (!tested.ok) return void res.status(400).json({ error: redactor(config, merged.conn)(tested.error) });
    const checkedAt = new Date().toISOString();
    if (!changed && id !== "anthropic") {
      await configRepo.update((c) => {
        const current = c.ai.providers[id];
        if (current) current.checkedAt = checkedAt;
      });
    }
    res.json({ ok: true, checkedAt });
  });

  // Forgets a connection; refused while chat or repo tasks run on it.
  router.post("/api/ai/providers/:id/delete", requireAdmin, async (req, res) => {
    const id = providerParam(req.params.id);
    if (!id) return void res.status(404).json({ error: "Unknown AI provider." });
    const config = await configRepo.load(true);
    const name = presetFor(id).name;
    const uses = [config.ai.chatProvider === id ? "chat" : "", config.ai.taskProvider === id ? "repo tasks" : ""].filter(Boolean);
    if (uses.length) {
      return void res.status(409).json({ error: `${name} runs ${uses.join(" and ")}. Choose another provider for ${uses.join(" and ")} first.` });
    }
    await configRepo.update((c) => {
      if (id === "anthropic") c.anthropic = { apiKey: undefined, model: c.anthropic.model };
      else delete c.ai.providers[id];
    });
    res.json({ ok: true });
  });

  // Chooses the providers chat and repo tasks run on; each must be connected and complete.
  router.post("/api/ai/active", requireAdmin, async (req, res) => {
    const input = body(ACTIVE, req.body);
    if ("error" in input) return void res.status(400).json({ error: input.error });
    const config = await configRepo.load(true);
    for (const id of [input.data.chatProvider, input.data.taskProvider]) {
      const problem = id && providerProblem(config, id);
      if (problem) return void res.status(400).json({ error: problem.replace(/ Ask the owner to .*$/, " Connect it first.") });
    }
    const saved = await configRepo.update((c) => {
      if (input.data.chatProvider) c.ai.chatProvider = input.data.chatProvider;
      if (input.data.taskProvider) c.ai.taskProvider = input.data.taskProvider;
    });
    res.json({ ok: true, chatProvider: saved.ai.chatProvider, taskProvider: saved.ai.taskProvider });
  });

  return router;
}
