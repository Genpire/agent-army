/** The Routines page. Placeholder until the routines work package replaces it. */
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../components/PageFrame";

export default function RoutinesPage() {
  return (
    <PageFrame title="Routines" description="Work Pointer does on its own on a schedule.">
      <EmptyState title="No routines yet" description="Ask Pointer, e.g. every morning at 8, email me what happened on GitHub yesterday." />
    </PageFrame>
  );
}
