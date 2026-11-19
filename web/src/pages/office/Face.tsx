import { Avatar } from "@astryxdesign/core/Avatar";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars, radiusVars, shadowVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { BoltIcon, ChatBubbleOvalLeftEllipsisIcon, CheckIcon, UsersIcon } from "@heroicons/react/20/solid";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { OfficeState } from "./model";

/**
 * A person's face: a DiceBear "Notionists" portrait (CC0 art) made from their
 * avatar seed, on a soft disc, inside a ring in their state's colour with a
 * small badge whose icon says the state without colour. The art is loaded on
 * first use, so it stays out of the console's main bundle; until then the
 * Avatar shows initials.
 */

type MakeFace = (seed: string) => string;
let loading: Promise<MakeFace> | undefined;
let ready: MakeFace | undefined;

function loadFaces(): Promise<MakeFace> {
  loading ??= Promise.all([import("@dicebear/core"), import("@dicebear/notionists")]).then(([core, style]) => {
    const cache = new Map<string, string>();
    ready = (seed) => {
      let uri = cache.get(seed);
      if (!uri) {
        uri = core.createAvatar(style, { seed, size: 96 }).toDataUri();
        cache.set(seed, uri);
      }
      return uri;
    };
    return ready;
  });
  return loading;
}

/** The face for a seed, or undefined while the art loads. */
export function useFaceSrc(seed: string): string | undefined {
  const [make, setMake] = useState<MakeFace | undefined>(() => ready);
  useEffect(() => {
    if (make) return;
    let cancelled = false;
    void loadFaces().then((fn) => {
      if (!cancelled) setMake(() => fn);
    });
    return () => {
      cancelled = true;
    };
  }, [make]);
  return make?.(seed);
}

const W = colorVars["--color-on-dark"];
const RING = {
  free: colorVars["--color-icon-green"],
  working: colorVars["--color-icon-blue"],
  thinking: colorVars["--color-icon-purple"],
  meeting: colorVars["--color-icon-orange"],
} as const;

const SURFACE = colorVars["--color-background-surface"];
const GAP = spacingVars["--spacing-0-5"];

const styles = stylex.create({
  // A ring in the state's colour, a thin gap in the surface colour, then the face.
  ring: { borderRadius: radiusVars["--radius-full"], padding: spacingVars["--spacing-1"], boxShadow: shadowVars["--shadow-low"] },
  free: { backgroundColor: RING.free },
  working: { backgroundColor: RING.working },
  thinking: { backgroundColor: RING.thinking },
  meeting: { backgroundColor: RING.meeting },
  gap: { boxShadow: `0 0 0 ${GAP} ${SURFACE}` },
  // The portrait is line art on a transparent background: a light disc keeps it readable in both themes.
  disc0: { backgroundColor: `color-mix(in oklab, ${colorVars["--color-icon-yellow"]} 16%, ${W})` },
  disc1: { backgroundColor: `color-mix(in oklab, ${colorVars["--color-icon-teal"]} 16%, ${W})` },
  disc2: { backgroundColor: `color-mix(in oklab, ${colorVars["--color-icon-pink"]} 14%, ${W})` },
  disc3: { backgroundColor: `color-mix(in oklab, ${colorVars["--color-icon-blue"]} 14%, ${W})` },
  badgeHolder: { position: "relative" },
  badge: {
    position: "absolute",
    insetInlineEnd: `calc(-1 * ${GAP})`,
    bottom: `calc(-1 * ${GAP})`,
    borderRadius: radiusVars["--radius-full"],
    borderWidth: GAP,
    borderStyle: "solid",
    borderColor: SURFACE,
    color: W,
  },
});

const DISCS = [styles.disc0, styles.disc1, styles.disc2, styles.disc3];
const BADGE_ICON = { free: CheckIcon, working: BoltIcon, thinking: ChatBubbleOvalLeftEllipsisIcon, meeting: UsersIcon } as const;

/** A small number from a string, to vary colours per person. */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

export interface FaceProps {
  seed: string;
  name: string;
  /** The ring and badge; omit for a plain face (the face picker). */
  state?: OfficeState;
  size?: 24 | 32 | 40 | 48 | 64 | 96;
  /** Makes the face a button. */
  onClick?: () => void;
  /** The button's accessible name, or the tooltip of a plain face. */
  label?: string;
  hasTooltip?: boolean;
}

export function Face({ seed, name, state, size = 48, onClick, label, hasTooltip = true }: FaceProps) {
  const src = useFaceSrc(seed);
  const avatar = (
    <Avatar
      src={src}
      name={name}
      alt={label ?? name}
      size={size}
      tooltip={hasTooltip ? (label ?? name) : false}
      onClick={onClick}
      xstyle={[DISCS[hueOf(seed) % DISCS.length], state && styles.gap]}
    />
  );
  if (!state) return avatar;
  const badge = size >= 40 ? 18 : 14;
  return (
    <Center xstyle={styles.badgeHolder}>
      <Center xstyle={[styles.ring, styles[state]]}>{avatar}</Center>
      <Center width={badge} height={badge} xstyle={[styles.badge, styles[state]]} aria-hidden>
        <Icon icon={BADGE_ICON[state]} size="xsm" color="inherit" />
      </Center>
    </Center>
  );
}
