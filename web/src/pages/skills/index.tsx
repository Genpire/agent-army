import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function SkillsPage() {
  return (
    <PageFrame title="Skills" description="The skills library: Claude skills your agents can use, and the Skills Scout who finds new ones.">
      <EmptyState title="Skills" description="This page is being built." />
    </PageFrame>
  );
}
