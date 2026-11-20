import { Grid } from "@astryxdesign/core/Grid";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import type { KeyboardEvent, ReactNode } from "react";

/** A tile is never narrower than this, whatever the column count: below it the grid drops a column. */
const MIN_TILE_WIDTH = 220;

/**
 * How many tiles fit in a row at this screen width: one on phones, two from
 * 640px, three from 1120px. Not four on very wide screens: the page frame
 * keeps content at 1080px, where four tiles wrap every status line.
 */
export function useTileColumns(): number {
  const two = useMediaQuery("(min-width: 640px)");
  const three = useMediaQuery("(min-width: 1120px)");
  return three ? 3 : two ? 2 : 1;
}

const STEP: Record<string, "next" | "previous" | "down" | "up" | undefined> = {
  ArrowRight: "next",
  ArrowLeft: "previous",
  ArrowDown: "down",
  ArrowUp: "up",
};

/** Arrow keys move between tiles: left and right along the grid, up and down a row. */
function moveBetweenTiles(event: KeyboardEvent<HTMLDivElement>): void {
  const step = STEP[event.key];
  if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tiles = Array.from(event.currentTarget.children) as HTMLElement[];
  const at = tiles.findIndex((t) => t.contains(event.target as Node));
  if (at < 0) return;
  // The rendered row length: the tiles that share the first one's top.
  const perRow = Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0]!.offsetTop).length);
  const delta = step === "next" ? 1 : step === "previous" ? -1 : step === "down" ? perRow : -perRow;
  // A tile's first focusable element is the tile itself (its link or button).
  const target = tiles[at + delta]?.querySelector<HTMLElement>("a[href], button, [tabindex]");
  if (!target) return;
  event.preventDefault();
  target.focus();
}

/** The hub's tiles (AppTile) in a responsive grid. */
export function TileGrid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <Grid columns={{ minWidth: MIN_TILE_WIDTH, max: columns }} gap={3} onKeyDown={moveBetweenTiles}>
      {children}
    </Grid>
  );
}
