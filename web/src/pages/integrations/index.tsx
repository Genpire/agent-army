import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function IntegrationsPage() {
  return (
    <PageFrame title="Integrations" description="Claude, Slack, GitHub and monday.com.">
      <EmptyState title="Integrations" description="This page is being built." />
    </PageFrame>
  );
}
