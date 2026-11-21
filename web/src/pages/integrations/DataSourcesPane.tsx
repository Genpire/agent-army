/** Placeholder until its work package replaces it. */
import { CircleStackIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

export function DataSourcesPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  return <PaneHeader icon={CircleStackIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
