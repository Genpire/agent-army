import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function OfficePage() {
  return (
    <PageFrame title="Office" description="Your team at their desks: who is working on what, right now.">
      <EmptyState title="Office" description="This page is being built." />
    </PageFrame>
  );
}
