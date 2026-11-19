/** The Jira pane. Placeholder until the Jira work package replaces it. */
import { TicketIcon } from "@heroicons/react/24/outline";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader } from "./parts";

export function JiraPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  return <PaneHeader icon={TicketIcon} title={summary.name} tone={summary.tone} status={summary.status} description={summary.enables} onBack={onBack} />;
}
