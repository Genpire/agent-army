import { CursorArrowRaysIcon, UserIcon } from "@heroicons/react/24/outline";
import { BrandLogo, type BrandLogoProps } from "../../components/BrandLogo";
import type { FollowupSource } from "./model";

/** The brand logos for Slack, Gmail and Calendar (lib/logos.ts); the owner's and Pointer's own marks on the same tile. */
const MARK: Record<FollowupSource, Pick<BrandLogoProps, "id" | "icon">> = {
  slack: { id: "slack" },
  gmail: { id: "gmail" },
  calendar: { id: "google-calendar" },
  owner: { icon: UserIcon },
  pointer: { icon: CursorArrowRaysIcon },
};

/** Where an item came from, as a small tile. */
export function SourceMark({ source, label }: { source: FollowupSource; label: string }) {
  return <BrandLogo {...MARK[source]} name={label} size="sm" />;
}
