import { Avatar } from "@astryxdesign/core/Avatar";
import { type ComponentType, type SVGProps, Suspense, lazy } from "react";

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
  /** Drawn on the same tile instead of the initials when there is no logo, for marks that are not brands (a person, the console). */
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

/** The initials tile shown without a logo, and while the logos load. */
export function InitialsTile({ name, size = "md" }: Pick<BrandLogoProps, "name" | "size">) {
  return <Avatar name={name} shape="rounded" size={size} tooltip={false} />;
}

/**
 * A brand's logo (Simple Icons) in its colour on a neutral tile, else the
 * given icon on the same tile, else the name's initials.
 */
export function BrandLogo({ id, name, size = "md", icon }: BrandLogoProps) {
  if (!id && !icon) return <InitialsTile name={name} size={size} />;
  return (
    <Suspense fallback={<InitialsTile name={name} size={size} />}>
      <BrandLogoGlyph id={id} name={name} size={size} icon={icon} />
    </Suspense>
  );
}
