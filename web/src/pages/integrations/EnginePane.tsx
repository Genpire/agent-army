/** The Codex and Gemini CLI panes. Placeholder until the engines work package replaces it. */
import { CommandLineIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

type Props = { summary: IntegrationSummary; onBack?: () => void };

export function CodexPane({ summary, onBack }: Props) {
  return <PaneHeader icon={CommandLineIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}

export function GeminiPane({ summary, onBack }: Props) {
  return <PaneHeader icon={CommandLineIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
