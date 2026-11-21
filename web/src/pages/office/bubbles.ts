/**
 * Where each speech bubble goes. Faces, name tags, meeting cards and labels
 * are fixed; each bubble is small (one line: a busy person's status card,
 * whose details open on hover or focus, or a short pill) and tries spots
 * round its face in order of preference: just above, a little to the side,
 * stacked higher, beside, under the name tag. It takes the first spot that
 * covers nothing (no face, no name tag, no other bubble, no card, inside
 * the picture); when every spot covers something, the one that covers the
 * least, faces and names counting most. Sizes are estimates in CSS pixels
 * (the overlays do not scale with the drawing). Pure.
 */
import type { Pt, SceneLayout } from "./layout";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BubbleSpot {
  /** The bubble's centre, relative to the face's centre, in px. */
  dx: number;
  dy: number;
  /** The bubble's size, in px. */
  width: number;
  height: number;
  /** Where the tail sits on the bubble's bottom edge (px from its left), when the bubble is just above the face. */
  tail?: number;
}

export type BubbleKind = "card" | "pill";

export interface BubbleRequest {
  id: string;
  at: Pt;
  /** The longest line it shows, in characters. */
  chars: number;
  /** "card" (default): a busy person's status, one line; "pill": a short note ("☕ coffee break"). */
  kind?: BubbleKind;
}

/** Rough text widths for Figtree at the supporting size. */
const CHAR_PX = 6.6;
/** A one-line card: icon, text and padding. */
export const CARD_H = 34;
export const PILL_H = 26;
/** Space kept between a bubble and anything it avoids. */
const GAP = 4;

export function bubbleSize(chars: number, maxWidth = 190, kind: BubbleKind = "card") {
  if (kind === "pill") return { width: Math.min(maxWidth, Math.round(chars * 7) + 28), height: PILL_H };
  return { width: Math.min(maxWidth, Math.max(120, Math.round(chars * CHAR_PX) + 44)), height: CARD_H };
}

export const tagWidth = (text: string) => Math.round(text.length * 7.2) + 22;
/** A name tag's centre, below its face's. */
export const TAG_DY = 44;
const TAG_H = 26;

export const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

export const around = (c: Pt, w: number, h: number): Rect => ({ x0: c.x - w / 2, y0: c.y - h / 2, x1: c.x + w / 2, y1: c.y + h / 2 });

const grow = (r: Rect, by: number): Rect => ({ x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by });

/** How much covering each kind of thing costs, per px². */
const WEIGHT = { face: 12, tag: 10, box: 4, bubble: 8, outside: 10 } as const;

export interface BubbleInput {
  layout: Pick<SceneLayout, "view">;
  /** CSS px per drawing unit. */
  scale: number;
  /** A face's radius with its ring, in px. */
  faceRadius: number;
  /** Every face on the picture, with its tag's text. */
  faces: { id: string; at: Pt; tag: string }[];
  /** Other fixed boxes (meeting cards, labels), in px. */
  boxes: Rect[];
  bubbles: BubbleRequest[];
  maxWidth?: number;
}

/** The boxes (px, in the picture) that bubbles keep clear of: every face and name tag, and the fixed boxes. */
export function fixedRects({ layout, scale, faceRadius: r, faces, boxes }: Omit<BubbleInput, "bubbles">) {
  const px = (p: Pt): Pt => ({ x: (p.x - layout.view.x) * scale, y: (p.y - layout.view.y) * scale });
  return [
    ...faces.flatMap((f) => {
      const c = px(f.at);
      return [
        { id: f.id, kind: "face" as const, r: around(c, r * 2, r * 2) },
        { id: f.id, kind: "tag" as const, r: around({ x: c.x, y: c.y + TAG_DY }, tagWidth(f.tag), TAG_H) },
      ];
    }),
    ...boxes.map((b) => ({ id: undefined, kind: "box" as const, r: b })),
  ];
}

/**
 * Where a w×h bubble may go round a face of radius r (centre offsets, px),
 * nearest the face first, above preferred: just above (the default, with a
 * tail), slid sideways, stacked one or two bubbles higher, beside the face,
 * under the name tag; stacked three higher only as a last resort.
 */
export function spotsAround(r: number, w: number, h: number): { dx: number; dy: number; cost: number }[] {
  const above = -(r + 8 + h / 2);
  const up = h + 6;
  const shift = Math.max(0, w / 2 - 26);
  const side = r + 10 + w / 2;
  const besideY = -h / 2;
  const below = TAG_DY + TAG_H / 2 + 6 + h / 2;
  const levels = [above, above - up, above - 2 * up, besideY, below, above - 3 * up];
  const xs = [0, shift / 2, -shift / 2, shift, -shift, side, -side];
  const out: { dx: number; dy: number; cost: number }[] = [];
  for (const dy of levels) {
    for (const dx of xs) {
      // Beside the face means clear of it.
      if (dy === besideY && Math.abs(dx) < side) continue;
      const lean = dy === below ? 15 : dy < besideY ? -20 : 0;
      out.push({ dx, dy, cost: Math.abs(dx) * 0.2 + Math.abs(dy) * 0.5 + lean });
    }
  }
  return out.sort((p, q) => p.cost - q.cost);
}

export function placeBubbles(input: BubbleInput): Record<string, BubbleSpot> {
  const { layout, scale, faceRadius: r, bubbles, maxWidth = 190 } = input;
  const px = (p: Pt): Pt => ({ x: (p.x - layout.view.x) * scale, y: (p.y - layout.view.y) * scale });
  const bounds: Rect = { x0: 4, y0: 4, x1: layout.view.width * scale - 4, y1: layout.view.height * scale - 4 };
  const fixed = fixedRects(input);
  const placed: Rect[] = [];
  const out: Record<string, BubbleSpot> = {};
  // Front people first: they are drawn on top, so their bubbles get the first pick.
  for (const b of [...bubbles].sort((p, q) => q.at.y - p.at.y || p.id.localeCompare(q.id))) {
    const c = px(b.at);
    const { width: w, height: h } = bubbleSize(b.chars, maxWidth, b.kind);
    const above = -(r + 8 + h / 2);
    const candidates = spotsAround(r, w, h);
    let best = candidates[0]!;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const box = around({ x: c.x + cand.dx, y: c.y + cand.dy }, w, h);
      const padded = grow(box, GAP);
      let covered = 0;
      for (const f of fixed) {
        // A bubble may sit against its own face (the tail touches it), never on its own name.
        if (f.id === b.id && f.kind === "face") continue;
        covered += overlap(padded, f.r) * WEIGHT[f.kind];
      }
      for (const p of placed) covered += overlap(padded, p) * WEIGHT.bubble;
      covered += (w * h - overlap(box, bounds)) * WEIGHT.outside;
      if (covered === 0) {
        best = cand;
        break;
      }
      const cost = cand.cost + covered;
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    placed.push(around({ x: c.x + best.dx, y: c.y + best.dy }, w, h));
    const isJustAbove = best.dy === above && Math.abs(best.dx) < w / 2 - 10;
    out[b.id] = { dx: best.dx, dy: best.dy, width: w, height: h, ...(isJustAbove ? { tail: Math.min(w - 18, Math.max(18, w / 2 - best.dx)) } : {}) };
  }
  return out;
}
