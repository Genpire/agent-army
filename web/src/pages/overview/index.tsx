import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function OverviewPage() {
  return (
    <PageFrame title="Overview" description="What Pointer and the team are doing, and what still needs setting up.">
      <EmptyState title="Overview" description="This page is being built." />
    </PageFrame>
  );
}
