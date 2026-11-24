/**
 * The logo itself, loaded lazily by BrandLogo with the logos (lib/logos.ts).
 * The SVG element is the logo's own artwork, which no Astryx icon carries;
 * Astryx's Icon sizes and colours it. A logo in several colours (Slack,
 * monday.com) keeps its own colours: the brand reads from all of them at once.
 */
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars, radiusVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ComponentType, SVGProps } from "react";
import { type BrandIcon, brandColorFits, logoFor } from "../lib/logos";
import { type BrandLogoProps, type BrandLogoSize, InitialsTile } from "./BrandLogo";

/** The tile matches the initials it replaces (Avatar sm, md, lg). */
const TILE: Record<BrandLogoSize, number> = { sm: 24, md: 36, lg: 48 };
const GLYPH: Record<BrandLogoSize, "sm" | "md" | "lg"> = { sm: "sm", md: "md", lg: "lg" };

const styles = stylex.create({
  tile: { backgroundColor: colorVars["--color-background-muted"], borderRadius: radiusVars["--radius-element"], flexShrink: 0 },
  color: (color: string) => ({ color }),
});

const glyphs = new Map<string, ComponentType<SVGProps<SVGSVGElement>>>();

/** One component per logo, made once, so React keeps it between renders. */
function glyphOf(icon: BrandIcon): ComponentType<SVGProps<SVGSVGElement>> {
  const known = glyphs.get(icon.path);
  if (known) return known;
  const Glyph = (props: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      {icon.parts ? icon.parts.map((part) => <path key={part.path} d={part.path} fill={`#${part.hex}`} />) : <path d={icon.path} />}
    </svg>
  );
  glyphs.set(icon.path, Glyph);
  return Glyph;
}

/** The brand colour in each theme where it stands out on the tile, the theme's text colour where it does not. */
function colorOf(icon: BrandIcon): string {
  const fits = brandColorFits(icon.hex);
  const brand = `#${icon.hex}`;
  const text = colorVars["--color-text-primary"];
  if (fits.light && fits.dark) return brand;
  return `light-dark(${fits.light ? brand : text}, ${fits.dark ? brand : text})`;
}

export default function BrandLogoGlyph({ id, name, size = "md", icon: fallback }: BrandLogoProps) {
  const icon = id ? logoFor(id) : undefined;
  if (!icon && fallback) {
    return (
      <Center width={TILE[size]} height={TILE[size]} xstyle={styles.tile}>
        <Icon icon={fallback} size={GLYPH[size]} color="secondary" label={name} />
      </Center>
    );
  }
  if (!icon) return <InitialsTile name={name} size={size} />;
  return (
    <Center width={TILE[size]} height={TILE[size]} xstyle={styles.tile}>
      <Icon icon={glyphOf(icon)} size={GLYPH[size]} label={name} xstyle={styles.color(colorOf(icon))} />
    </Center>
  );
}
