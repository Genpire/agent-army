import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function ActivityPage() {
  return (
    <PageFrame title="Activity" description="Repo tasks, their progress and what they cost.">
      <EmptyState title="Activity" description="This page is being built." />
    </PageFrame>
  );
}
