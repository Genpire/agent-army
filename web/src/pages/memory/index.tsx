import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function MemoryPage() {
  return (
    <PageFrame title="Memory" description="Facts Pointer carries into every conversation.">
      <EmptyState title="Memory" description="This page is being built." />
    </PageFrame>
  );
}
