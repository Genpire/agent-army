import { Avatar } from "@astryxdesign/core/Avatar";
import { Suspense, lazy } from "react";

/** The logo glyphs live in their own chunk (lib/logos.ts), fetched when the first logo is shown. */
const BrandLogoGlyph = lazy(() => import("./BrandLogoGlyph"));

export type BrandLogoSize = "sm" | "md" | "lg";

export interface BrandLogoProps {
  /** A catalog app id or a native integration id ("stripe", "github"…); without a logo, the initials are shown. */
  id?: string;
  /** The app's name: its initials, and the logo's accessible name. */
  name: string;
  /** sm 24, md 36, lg 48: the sizes of the initials tile it replaces. */
  size?: BrandLogoSize;
}

/** The initials tile shown without a logo, and while the logos load. */
export function InitialsTile({ name, size = "md" }: Pick<BrandLogoProps, "name" | "size">) {
  return <Avatar name={name} shape="rounded" size={size} tooltip={false} />;
}

/**
 * A brand's logo (Simple Icons) in its colour on a neutral tile, or the
 * name's initials when there is no logo for the id.
 */
export function BrandLogo({ id, name, size = "md" }: BrandLogoProps) {
  if (!id) return <InitialsTile name={name} size={size} />;
  return (
    <Suspense fallback={<InitialsTile name={name} size={size} />}>
      <BrandLogoGlyph id={id} name={name} size={size} />
    </Suspense>
  );
}
