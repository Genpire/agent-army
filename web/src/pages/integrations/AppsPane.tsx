/** The Apps pane. Placeholder until the Apps work package replaces it. */
import { SquaresPlusIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

export function AppsPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  return <PaneHeader icon={SquaresPlusIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
