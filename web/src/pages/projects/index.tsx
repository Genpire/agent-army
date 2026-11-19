import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function ProjectsPage() {
  return (
    <PageFrame title="Projects" description="Channels, repositories, setup and what the team learned about each repo.">
      <EmptyState title="Projects" description="This page is being built." />
    </PageFrame>
  );
}
