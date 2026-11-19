/** The Miro pane. Placeholder until the Miro work package replaces it. */
import { PresentationChartLineIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

export function MiroPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  return <PaneHeader icon={PresentationChartLineIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
