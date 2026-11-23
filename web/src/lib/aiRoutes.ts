/**
 * Routes as the AI model pane shows them (config.ai.routes, src/ai/routing.ts):
 * each kind of work in people's words, each kind's providers in order (or its
 * default, for a server that does not send routes), the providers a route can
 * add, and what a save says.
 */
import type { AiProviderId, AiProviderView, AiProvidersView, PublicConfig, RouteStepView, RouteView, RoutesView, WorkKind } from "./types";

/** The pane's one explanation of a route. */
export const ROUTE_EXPLANATION =
  "The first provider that can run does the work. If it fails (rate limit, out of credit, outage) or its monthly cap is used up, the next one takes over.";

/** What each kind of work is, with the lead's name (Pointer, as the owner set it). */
export const workKindInfo = (lead: string): Record<WorkKind, { label: string; description: string; byDefault: string }> => ({
  chat: { label: "Chat", description: `${lead}'s replies (Slack and console)`, byDefault: "The default: the provider set to Use for chat." },
  routines: { label: "Routines", description: "Scheduled routines", byDefault: "The default: the same providers as chat." },
  tasks: { label: "Repo tasks", description: "The team's repo tasks", byDefault: "The default: the provider set to Use for repo tasks." },
  light: { label: "Light work", description: "Short jobs: HR review, Skills Scout, the office's talk", byDefault: "The default: the same providers as chat." },
});

/**
 * Each kind's route: the server's, or for a server that does not send routes
 * the default it runs (chat, routines and light work on the chat provider,
 * repo tasks on the task provider).
 */
export function routesOf(config: PublicConfig): RoutesView {
  if (config.ai.routes) return config.ai.routes;
  const only = ({ provider, name, ready }: { provider: AiProviderId; name: string; ready: boolean }): RouteView => ({ custom: false, steps: [{ provider, name, ready }] });
  const chat = only(config.ai.chat);
  return { chat, routines: chat, tasks: only(config.ai.task), light: chat };
}

/**
 * The providers a route the owner changes starts from: its own, or for a
 * default route only those that can run. A default provider that cannot (Claude
 * before it is connected) was never the owner's choice, so adding a provider
 * to it starts the owner's route without it.
 */
export const routeBase = (route: RouteView): AiProviderId[] => route.steps.filter((s) => route.custom || s.ready).map((s) => s.provider);

/** The connected providers (a saved connection, complete or not) a route does not have yet, in the presets' order. */
export const addableProviders = (view: AiProvidersView, route: readonly AiProviderId[]): AiProviderView[] =>
  view.providers.filter((p) => p.saved && !route.includes(p.id));

/** The words for a step that cannot run now. */
export const stepProblem = (step: RouteStepView): string => step.problem ?? "Cannot run now: skipped until it can";

/** The toast after a save: "Chat: Gemini, then Claude." or "Chat: back to the default (Claude)." */
export function routeSavedText(label: string, route: RouteView | undefined, toDefault: boolean): string {
  const names = route?.steps.map((s) => s.name) ?? [];
  if (toDefault) return names.length ? `${label}: back to the default (${names.join(", then ")}).` : `${label}: back to the default.`;
  return names.length ? `${label}: ${names.join(", then ")}.` : `${label} saved.`;
}
