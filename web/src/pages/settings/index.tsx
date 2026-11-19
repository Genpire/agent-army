import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function SettingsPage() {
  return (
    <PageFrame title="Settings" description="Limits, access and this deployment.">
      <EmptyState title="Settings" description="This page is being built." />
    </PageFrame>
  );
}
