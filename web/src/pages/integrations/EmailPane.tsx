/** Placeholder until its work package replaces it. */
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

export function EmailPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  return <PaneHeader icon={EnvelopeIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
