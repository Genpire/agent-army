/**
 * Where each speech bubble goes. Faces, name tags, meeting cards and labels
 * are fixed; each bubble tries spots around its face (above, a little higher,
 * above right or left, beside, below) and takes the one that covers the
 * least, with faces counting most (a covered face hides who is there; a
 * covered name tag is a small loss), and stays inside the picture. Sizes are
 * estimates in CSS pixels (the overlays do not scale with the drawing). Pure.
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
  /** The bubble's width, in px. */
  width: number;
  /** Where the tail sits on the bubble's bottom edge (px from its left), when the bubble is just above the face. */
  tail?: number;
}

export interface BubbleRequest {
  id: string;
  at: Pt;
  /** The longest line it shows, in characters. */
  chars: number;
}

/** Rough text widths for Figtree at the supporting size. */
const CHAR_PX = 6.6;

export function bubbleSize(chars: number, maxWidth = 240) {
  const width = Math.min(maxWidth, Math.max(150, Math.round(chars * CHAR_PX) + 48));
  const lines = chars * CHAR_PX > width - 40 ? 3 : 2;
  return { width, height: 20 + lines * 20 };
}

export const tagWidth = (text: string) => Math.round(text.length * 7.2) + 22;

const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

const around = (c: Pt, w: number, h: number): Rect => ({ x0: c.x - w / 2, y0: c.y - h / 2, x1: c.x + w / 2, y1: c.y + h / 2 });

const WEIGHT = { face: 12, tag: 2, box: 4, bubble: 8, outside: 10 } as const;

export interface BubbleInput {
  layout: SceneLayout;
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

export function placeBubbles({ layout, scale, faceRadius: r, faces, boxes, bubbles, maxWidth = 240 }: BubbleInput): Record<string, BubbleSpot> {
  const px = (p: Pt): Pt => ({ x: (p.x - layout.view.x) * scale, y: (p.y - layout.view.y) * scale });
  const bounds: Rect = { x0: 4, y0: 4, x1: layout.view.width * scale - 4, y1: layout.view.height * scale - 4 };
  const fixed: { id?: string; r: Rect; w: number }[] = [
    ...faces.flatMap((f) => {
      const c = px(f.at);
      return [
        { id: f.id, r: around(c, r * 2, r * 2), w: WEIGHT.face },
        { id: f.id, r: around({ x: c.x, y: c.y + 44 }, tagWidth(f.tag), 26), w: WEIGHT.tag },
      ];
    }),
    ...boxes.map((b) => ({ r: b, w: WEIGHT.box })),
  ];
  const placed: Rect[] = [];
  const out: Record<string, BubbleSpot> = {};
  // Front people first: they are drawn on top, so their bubbles get the first pick.
  for (const b of [...bubbles].sort((p, q) => q.at.y - p.at.y)) {
    const c = px(b.at);
    const { width: w, height: h } = bubbleSize(b.chars, maxWidth);
    const above = -(r + 8 + h / 2);
    const side = r + 10 + w / 2;
    const candidates = [
      { dx: 0, dy: above, cost: 0 },
      { dx: w / 2 - 26, dy: above, cost: 30 },
      { dx: -(w / 2 - 26), dy: above, cost: 40 },
      { dx: 0, dy: above - 44, cost: 60 },
      { dx: w / 2 - 26, dy: above - 44, cost: 80 },
      { dx: -(w / 2 - 26), dy: above - 44, cost: 90 },
      { dx: side, dy: -12, cost: 120 },
      { dx: -side, dy: -12, cost: 130 },
      { dx: side, dy: above, cost: 150 },
      { dx: -side, dy: above, cost: 160 },
      { dx: 0, dy: r + 40 + h / 2, cost: 220 },
    ];
    let best = candidates[0]!;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const box = around({ x: c.x + cand.dx, y: c.y + cand.dy }, w, h);
      let cost = cand.cost;
      for (const f of fixed) if (f.id !== b.id) cost += area(box, f.r) * f.w;
      for (const p of placed) cost += area(box, p) * WEIGHT.bubble;
      cost += (w * h - area(box, bounds)) * WEIGHT.outside;
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    placed.push(around({ x: c.x + best.dx, y: c.y + best.dy }, w, h));
    const isJustAbove = best.dy === above && Math.abs(best.dx) < w / 2;
    out[b.id] = { dx: best.dx, dy: best.dy, width: w, ...(isJustAbove ? { tail: Math.min(w - 18, Math.max(18, w / 2 - best.dx)) } : {}) };
  }
  return out;
}
