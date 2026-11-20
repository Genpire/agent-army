/**
 * The AI providers as the console uses them (GET /api/ai/providers): the
 * hook that loads them, the words for their model tiers and what each can
 * do, and the model lists the Team page's pickers offer.
 */
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { AiProviderId, AiProviderView, AiProvidersView, ModelTier } from "./types";

/** The providers and their saved connections; reload() after a change. Nothing is loaded while `enabled` is false. */
export function useAiProviders(enabled = true): { view: AiProvidersView | undefined; error: string | undefined; reload: () => Promise<void> } {
  const [view, setView] = useState<AiProvidersView>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setView(await api.get<AiProvidersView>("/api/ai/providers"));
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { view, error, reload };
}

export const providerById = (view: AiProvidersView | undefined, id: AiProviderId): AiProviderView | undefined =>
  view?.providers.find((p) => p.id === id);

/** What each tier is for, in the words of the AI model pane. */
export const TIER_INFO: Record<ModelTier, { label: string; description: string }> = {
  main: { label: "Main model", description: "Chat and the lead in repo tasks, when the Team page sets no model." },
  opus: { label: "Large model", description: "What Claude's Opus models (and the opus alias) run on." },
  sonnet: { label: "Medium model", description: "What Claude's Sonnet models run on, e.g. the routing's small and medium tasks." },
  haiku: { label: "Small model", description: "What Claude's Haiku models run on: background work and task sizing." },
  subagent: { label: "Agents' model", description: "Agents without a model of their own." },
};

/** The model each tier runs on: the saved choice, else the preset's default ("" = Claude Code's own choice). */
export function tierModels(p: AiProviderView): Record<ModelTier, string> {
  const saved = Object.fromEntries(Object.entries(p.saved?.models ?? {}).filter((e): e is [string, string] => Boolean(e[1])));
  return { ...p.defaults, ...saved } as Record<ModelTier, string>;
}

/** A model's name from the provider's list, else its id. */
export const presetModelLabel = (p: AiProviderView, id: string): string => p.models.find((m) => m.id === id)?.label ?? id;

/** "Ready", "Ready · chat and repo tasks", the problem, or "Not set up". */
export function providerStatus(p: AiProviderView): { tone: "success" | "warning" | "neutral"; text: string } {
  if (!p.saved) return { tone: "neutral", text: "Not set up" };
  if (p.problem) return { tone: "warning", text: p.problem };
  const uses = [p.usedFor.chat ? "chat" : "", p.usedFor.task ? "repo tasks" : ""].filter(Boolean);
  return { tone: "success", text: uses.length ? `Runs ${uses.join(" and ")}` : "Ready, not in use" };
}

/** What the provider can and cannot do, one line each. */
export function capabilityLines(p: AiProviderView): { ok: boolean; text: string }[] {
  const c = p.capabilities;
  const effort =
    c.effort.length === 0
      ? "Effort: not sent"
      : c.effort.length === 5
        ? "Effort: every level"
        : `Effort: ${c.effort.join(", ")}; other levels go to the nearest one`;
  return [
    { ok: c.webSearch, text: c.webSearch ? "Web search: available" : `Web search: not available on ${p.short}` },
    { ok: c.pdf, text: c.pdf ? "PDFs: supported" : "PDFs: not supported" },
    { ok: c.images, text: c.images ? "Images: supported" : "Images: not supported on the default models" },
    { ok: c.effort.length > 0, text: effort },
    { ok: true, text: c.thinkingOff ? "Thinking: can be turned off" : "Thinking: always on" },
  ];
}
