/**
 * The office, drawn: an isometric room (floor, two walls with windows, a
 * whiteboard and a clock), the meeting table, the kitchen and its table, the
 * skills library shelf, the HR corner, a desk with a monitor for every agent
 * and Pointer's desk at the front. People's bodies sit on their chairs; their
 * faces, name tags and speech bubbles are HTML on top (OfficeScene).
 *
 * An illustration is the one place this app draws SVG, so its markup stays in
 * this file. Every colour is an Astryx colour token, mixed in light-dark() so
 * the room is warm in the light theme and calm in the dark one; monitors glow
 * and type only while their owner works, and every animation stops under
 * prefers-reduced-motion. Decorative: the page describes everyone in text.
 */
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { DESK, type Desk, FLOOR_T, type MeetingSpot, type Pt, type SceneLayout, WALL_H, project, seatsAround } from "./layout";

// ---------- Colours: Astryx tokens only ----------

const S = colorVars["--color-background-surface"];
const W = colorVars["--color-on-dark"];
const K = colorVars["--color-on-light"];
const ORANGE = colorVars["--color-icon-orange"];
const YELLOW = colorVars["--color-icon-yellow"];
const GREEN = colorVars["--color-icon-green"];
const TEAL = colorVars["--color-icon-teal"];
const BLUE = colorVars["--color-icon-blue"];
const PURPLE = colorVars["--color-icon-purple"];
const RED = colorVars["--color-icon-red"];
const PINK = colorVars["--color-icon-pink"];
const GRAY = colorVars["--color-icon-gray"];
const ACCENT = colorVars["--color-accent"];

const FLOOR = `light-dark(color-mix(in oklab, ${ORANGE} 12%, ${W}), color-mix(in oklab, ${ORANGE} 15%, ${S}))`;
const FLOOR_LINE = `light-dark(color-mix(in oklab, ${ORANGE} 20%, ${W}), color-mix(in oklab, ${ORANGE} 22%, ${S}))`;
const WOOD = `light-dark(color-mix(in oklab, ${ORANGE} 34%, ${W}), color-mix(in oklab, ${ORANGE} 38%, ${S}))`;
const WHITE = `light-dark(${W}, color-mix(in oklab, ${W} 15%, ${S}))`;
const DARK = `color-mix(in oklab, ${K} 80%, ${GRAY})`;
const GLASS = `light-dark(color-mix(in oklab, ${BLUE} 18%, ${W}), color-mix(in oklab, ${BLUE} 30%, ${K}))`;
const SCREEN_ON = `color-mix(in oklab, ${ACCENT} 40%, ${W})`;
const SCREEN_THINK = `color-mix(in oklab, ${PURPLE} 38%, ${W})`;
const SCREEN_OFF = `light-dark(color-mix(in oklab, ${K} 72%, ${GRAY}), color-mix(in oklab, ${K} 60%, ${GRAY}))`;
const TERRACOTTA = `color-mix(in oklab, ${ORANGE} 62%, ${RED})`;

const fill = stylex.create({
  floor: { fill: FLOOR },
  floorLine: { stroke: FLOOR_LINE, strokeWidth: 1.5, fill: "none" },
  floorSideL: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 36%, ${W}), color-mix(in oklab, ${ORANGE} 26%, ${K}))` },
  floorSideR: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 48%, ${W}), color-mix(in oklab, ${ORANGE} 18%, ${K}))` },
  wallL: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 6%, color-mix(in oklab, ${GRAY} 9%, ${W})), color-mix(in oklab, ${K} 22%, ${S}))` },
  wallR: { fill: `light-dark(color-mix(in oklab, ${YELLOW} 7%, ${W}), color-mix(in oklab, ${W} 4%, ${S}))` },
  wallTop: { fill: `light-dark(color-mix(in oklab, ${GRAY} 22%, ${W}), color-mix(in oklab, ${W} 16%, ${S}))` },
  baseboard: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 26%, ${W}), color-mix(in oklab, ${ORANGE} 16%, ${S}))` },
  woodTop: { fill: WOOD },
  woodL: { fill: `color-mix(in oklab, ${WOOD} 86%, ${K})` },
  woodR: { fill: `color-mix(in oklab, ${WOOD} 72%, ${K})` },
  whiteTop: { fill: WHITE },
  whiteL: { fill: `color-mix(in oklab, ${WHITE} 90%, ${GRAY})` },
  whiteR: { fill: `color-mix(in oklab, ${WHITE} 78%, ${GRAY})` },
  leg: { fill: `light-dark(color-mix(in oklab, ${GRAY} 50%, ${W}), color-mix(in oklab, ${W} 28%, ${S}))` },
  dark: { fill: DARK },
  darkSide: { fill: `color-mix(in oklab, ${K} 90%, ${GRAY})` },
  screenOff: { fill: SCREEN_OFF },
  screenOn: { fill: SCREEN_ON },
  screenThink: { fill: SCREEN_THINK },
  glass: { fill: GLASS },
  glassShine: { fill: W, fillOpacity: 0.35 },
  frame: { fill: WHITE, stroke: `light-dark(color-mix(in oklab, ${GRAY} 35%, ${W}), color-mix(in oklab, ${W} 24%, ${S}))`, strokeWidth: 1 },
  shadow: { fill: K, fillOpacity: 0.1 },
  rugBlue: { fill: `light-dark(color-mix(in oklab, ${BLUE} 14%, ${W}), color-mix(in oklab, ${BLUE} 20%, ${S}))` },
  rugBlueEdge: { fill: "none", stroke: `light-dark(color-mix(in oklab, ${BLUE} 30%, ${W}), color-mix(in oklab, ${BLUE} 34%, ${S}))`, strokeWidth: 2 },
  rugGreen: { fill: `light-dark(color-mix(in oklab, ${GREEN} 14%, ${W}), color-mix(in oklab, ${GREEN} 18%, ${S}))` },
  rugGreenEdge: { fill: "none", stroke: `light-dark(color-mix(in oklab, ${GREEN} 30%, ${W}), color-mix(in oklab, ${GREEN} 32%, ${S}))`, strokeWidth: 2 },
  rugPink: { fill: `light-dark(color-mix(in oklab, ${PINK} 12%, ${W}), color-mix(in oklab, ${PINK} 18%, ${S}))` },
  leaf: { fill: GREEN },
  leafDark: { fill: `color-mix(in oklab, ${GREEN} 68%, ${K})` },
  potL: { fill: TERRACOTTA },
  potR: { fill: `color-mix(in oklab, ${TERRACOTTA} 76%, ${K})` },
  potTop: { fill: `color-mix(in oklab, ${ORANGE} 30%, ${K})` },
  tealTop: { fill: `light-dark(color-mix(in oklab, ${TEAL} 30%, ${W}), color-mix(in oklab, ${TEAL} 40%, ${S}))` },
  tealL: { fill: `light-dark(color-mix(in oklab, ${TEAL} 45%, ${W}), color-mix(in oklab, ${TEAL} 32%, ${S}))` },
  tealR: { fill: `light-dark(color-mix(in oklab, ${TEAL} 58%, ${W}), color-mix(in oklab, ${TEAL} 24%, ${S}))` },
  purpleTop: { fill: `light-dark(color-mix(in oklab, ${PURPLE} 30%, ${W}), color-mix(in oklab, ${PURPLE} 42%, ${S}))` },
  purpleL: { fill: `light-dark(color-mix(in oklab, ${PURPLE} 44%, ${W}), color-mix(in oklab, ${PURPLE} 32%, ${S}))` },
  purpleR: { fill: `light-dark(color-mix(in oklab, ${PURPLE} 56%, ${W}), color-mix(in oklab, ${PURPLE} 24%, ${S}))` },
  codeA: { stroke: `color-mix(in oklab, ${ACCENT} 80%, ${K})`, strokeWidth: 1.6, strokeLinecap: "round", fill: "none" },
  codeB: { stroke: `color-mix(in oklab, ${TEAL} 75%, ${K})`, strokeWidth: 1.6, strokeLinecap: "round", fill: "none" },
  codeC: { stroke: `color-mix(in oklab, ${PURPLE} 75%, ${K})`, strokeWidth: 1.6, strokeLinecap: "round", fill: "none" },
  ink: { stroke: `light-dark(color-mix(in oklab, ${GRAY} 70%, ${W}), color-mix(in oklab, ${W} 45%, ${S}))`, strokeWidth: 1.6, strokeLinecap: "round", fill: "none" },
  inkBlue: { stroke: BLUE, strokeWidth: 2, strokeLinecap: "round", fill: "none" },
  inkOrange: { stroke: ORANGE, strokeWidth: 2, strokeLinecap: "round", fill: "none" },
  inkGreen: { stroke: GREEN, strokeWidth: 2, strokeLinecap: "round", fill: "none" },
  hand: { stroke: K, strokeWidth: 1.6, strokeLinecap: "round" },
  tick: { fill: K },
  clockRim: { fill: `light-dark(color-mix(in oklab, ${K} 70%, ${GRAY}), color-mix(in oklab, ${W} 30%, ${S}))` },
  steam: { stroke: `light-dark(color-mix(in oklab, ${GRAY} 45%, ${W}), color-mix(in oklab, ${W} 45%, ${S}))`, strokeWidth: 2, strokeLinecap: "round", fill: "none" },
  red: { fill: RED },
  white: { fill: W },
  glow: { fill: ACCENT },
  glowThink: { fill: PURPLE },
  thinkDot: { fill: `color-mix(in oklab, ${PURPLE} 80%, ${K})` },
  link: { stroke: ORANGE, strokeWidth: 2, strokeDasharray: "5 5", strokeLinecap: "round", opacity: 0.8 },
  linkEnd: { fill: ORANGE },
  // Book spines.
  b0: { fill: BLUE },
  b1: { fill: RED },
  b2: { fill: YELLOW },
  b3: { fill: GREEN },
  b4: { fill: PURPLE },
  b5: { fill: TEAL },
  b6: { fill: ORANGE },
  b7: { fill: PINK },
  // Shirts, by person.
  s0: { fill: `color-mix(in oklab, ${BLUE} 75%, ${W})` },
  s1: { fill: `color-mix(in oklab, ${TEAL} 78%, ${W})` },
  s2: { fill: `color-mix(in oklab, ${PURPLE} 70%, ${W})` },
  s3: { fill: `color-mix(in oklab, ${ORANGE} 80%, ${W})` },
  s4: { fill: `color-mix(in oklab, ${PINK} 72%, ${W})` },
  s5: { fill: `color-mix(in oklab, ${GREEN} 72%, ${W})` },
  collar: { fill: W, fillOpacity: 0.85 },
});

const BOOKS = [fill.b0, fill.b1, fill.b2, fill.b3, fill.b4, fill.b5, fill.b6, fill.b7];
const SHIRTS = [fill.s0, fill.s1, fill.s2, fill.s3, fill.s4, fill.s5];

// ---------- Motion (off under prefers-reduced-motion) ----------

const typing = stylex.keyframes({
  "0%": { strokeDashoffset: 1 },
  "55%": { strokeDashoffset: 0 },
  "100%": { strokeDashoffset: 0 },
});
const breathe = stylex.keyframes({
  "0%": { opacity: 0.18 },
  "50%": { opacity: 0.42 },
  "100%": { opacity: 0.18 },
});
const rise = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(4px)" },
  "40%": { opacity: 0.8 },
  "100%": { opacity: 0, transform: "translateY(-10px)" },
});
const blink = stylex.keyframes({
  "0%": { opacity: 0.25 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.25 },
});

const REDUCE = "@media (prefers-reduced-motion: reduce)";
const motion = stylex.create({
  type: {
    strokeDasharray: 1,
    animationName: { default: typing, [REDUCE]: "none" },
    animationDuration: "2.4s",
    animationTimingFunction: "steps(12, end)",
    animationIterationCount: "infinite",
  },
  glow: {
    opacity: 0.3,
    animationName: { default: breathe, [REDUCE]: "none" },
    animationDuration: "2.8s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  steam: {
    opacity: { default: 0, [REDUCE]: 0.5 },
    animationName: { default: rise, [REDUCE]: "none" },
    animationDuration: "3.2s",
    animationTimingFunction: "ease-out",
    animationIterationCount: "infinite",
  },
  dot: {
    animationName: { default: blink, [REDUCE]: "none" },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  delay1: { animationDelay: "0.4s" },
  delay2: { animationDelay: "0.8s" },
  delay3: { animationDelay: "1.2s" },
});

// ---------- Drawing helpers ----------

const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (list: Pt[]) => list.map((p) => `${r1(p.x)},${r1(p.y)}`).join(" ");

type Style = stylex.StyleXStyles;
interface Material {
  top: Style;
  left: Style;
  right: Style;
}

const WOOD_M: Material = { top: fill.woodTop, left: fill.woodL, right: fill.woodR };
const WHITE_M: Material = { top: fill.whiteTop, left: fill.whiteL, right: fill.whiteR };
const DARK_M: Material = { top: fill.dark, left: fill.darkSide, right: fill.dark };
const TEAL_M: Material = { top: fill.tealTop, left: fill.tealL, right: fill.tealR };
const PURPLE_M: Material = { top: fill.purpleTop, left: fill.purpleL, right: fill.purpleR };
const LEG_M: Material = { top: fill.leg, left: fill.leg, right: fill.leg };

function Poly({ points, s }: { points: Pt[]; s: Style | Style[] }) {
  return <polygon points={pts(points)} {...stylex.props(s)} />;
}

/** A box from (x, y, z) to (x + w, y + d, z + h): its top and the two sides that face the viewer. */
function Box({ x, y, z = 0, w, d, h, m }: { x: number; y: number; z?: number; w: number; d: number; h: number; m: Material }) {
  const P = (px: number, py: number, pz: number) => project(px, py, pz);
  return (
    <g>
      <Poly points={[P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)]} s={m.left} />
      <Poly points={[P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)]} s={m.right} />
      <Poly points={[P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]} s={m.top} />
    </g>
  );
}

/** A world ellipse (centre, radii along x and y) at height z, as a polygon. */
function ring(cx: number, cy: number, rx: number, ry: number, z: number, steps = 36): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (2 * Math.PI * i) / steps;
    return project(cx + rx * Math.cos(t), cy + ry * Math.sin(t), z);
  });
}

/** A rectangle on the back-right wall (y = 0) or the back-left wall (x = 0). */
function onWall(wall: "right" | "left", from: number, to: number, z0: number, z1: number, inset = 0): Pt[] {
  const at = (u: number, z: number) => (wall === "right" ? project(u, inset, z) : project(inset, u, z));
  return [at(from, z0), at(to, z0), at(to, z1), at(from, z1)];
}

function Shadow({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return <Poly points={ring(cx, cy, r, r * 0.8, 0, 24)} s={fill.shadow} />;
}

// ---------- Room ----------

function Floor({ a, b }: { a: number; b: number }) {
  const planks: ReactNode[] = [];
  for (let x = 40; x < a; x += 40) {
    planks.push(<line key={`p${x}`} {...lineProps(project(x, 0), project(x, b))} {...stylex.props(fill.floorLine)} />);
  }
  return (
    <g>
      <Poly points={[project(0, b, 0), project(a, b, 0), project(a, b, -FLOOR_T), project(0, b, -FLOOR_T)]} s={fill.floorSideL} />
      <Poly points={[project(a, 0, 0), project(a, b, 0), project(a, b, -FLOOR_T), project(a, 0, -FLOOR_T)]} s={fill.floorSideR} />
      <Poly points={[project(0, 0), project(a, 0), project(a, b), project(0, b)]} s={fill.floor} />
      {planks}
    </g>
  );
}

const lineProps = (p: Pt, q: Pt) => ({ x1: r1(p.x), y1: r1(p.y), x2: r1(q.x), y2: r1(q.y) });

function Windows({ wall, spans }: { wall: "right" | "left"; spans: [number, number][] }) {
  return (
    <g>
      {spans.map(([from, to]) => {
        const mid = (from + to) / 2;
        return (
          <g key={`${wall}${from}`}>
            <Poly points={onWall(wall, from - 4, to + 4, 46, 104)} s={fill.frame} />
            <Poly points={onWall(wall, from, mid - 2, 50, 100)} s={fill.glass} />
            <Poly points={onWall(wall, mid + 2, to, 50, 100)} s={fill.glass} />
            <Poly points={onWall(wall, from + 4, from + 12, 58, 92)} s={fill.glassShine} />
            <Poly points={onWall(wall, from - 6, to + 6, 42, 46, 4)} s={fill.whiteTop} />
          </g>
        );
      })}
    </g>
  );
}

function Walls({ a, b }: { a: number; b: number }) {
  const T = 8;
  return (
    <g>
      {/* Back-left wall (x = 0) and back-right wall (y = 0), with their top edges and baseboards. */}
      <Poly points={[project(0, 0, 0), project(0, b, 0), project(0, b, WALL_H), project(0, 0, WALL_H)]} s={fill.wallL} />
      <Poly points={[project(0, 0, 0), project(a, 0, 0), project(a, 0, WALL_H), project(0, 0, WALL_H)]} s={fill.wallR} />
      <Poly points={[project(-T, -T, WALL_H), project(-T, b, WALL_H), project(0, b, WALL_H), project(0, 0, WALL_H)]} s={fill.wallTop} />
      <Poly points={[project(-T, -T, WALL_H), project(a, -T, WALL_H), project(a, 0, WALL_H), project(0, 0, WALL_H)]} s={fill.wallTop} />
      <Poly points={[project(0, b, 0), project(-T, b, 0), project(-T, b, WALL_H), project(0, b, WALL_H)]} s={fill.wallTop} />
      <Poly points={[project(a, 0, 0), project(a, -T, 0), project(a, -T, WALL_H), project(a, 0, WALL_H)]} s={fill.wallTop} />
      <Poly points={onWall("left", 0, b, 0, 6)} s={fill.baseboard} />
      <Poly points={onWall("right", 0, a, 0, 6)} s={fill.baseboard} />
    </g>
  );
}

function Whiteboard({ isOn }: { isOn: boolean }) {
  return (
    <g>
      <Poly points={onWall("right", 22, 160, 44, 106, 1)} s={fill.frame} />
      {/* A week planner: three rows of tasks, coloured while a meeting is on. */}
      {[0, 1, 2].map((i) => (
        <line
          key={i}
          {...lineProps(project(34 + i * 6, 1, 92 - i * 14), project(isOn ? 112 - i * 18 : 80 - i * 10, 1, 92 - i * 14))}
          {...stylex.props(isOn ? [fill.inkBlue, fill.inkOrange, fill.inkGreen][i]! : fill.ink)}
        />
      ))}
      <Poly points={onWall("right", 130, 150, 54, 60, 2)} s={fill.red} />
    </g>
  );
}

/** The wall clock on the back-right wall, showing the time of the last update. */
function Clock({ now, x }: { now: Date; x: number }) {
  const z = 82;
  // A point on the clock face: `u` along the wall, `v` up.
  const at = (u: number, v: number) => project(x + u, 1, z + v);
  const circle = (r: number) => Array.from({ length: 28 }, (_, i) => at(r * Math.cos((2 * Math.PI * i) / 28), r * Math.sin((2 * Math.PI * i) / 28)));
  const hand = (turn: number, length: number) => at(Math.sin(turn * 2 * Math.PI) * length, Math.cos(turn * 2 * Math.PI) * length);
  const minute = now.getMinutes() / 60;
  const hour = ((now.getHours() % 12) + minute) / 12;
  return (
    <g>
      <Poly points={circle(15)} s={fill.clockRim} />
      <Poly points={circle(12.5)} s={fill.whiteTop} />
      {Array.from({ length: 12 }, (_, i) => {
        const p = hand(i / 12, 10.5);
        return <circle key={i} cx={r1(p.x)} cy={r1(p.y)} r={i % 3 === 0 ? 1.1 : 0.6} {...stylex.props(fill.tick)} />;
      })}
      <line {...lineProps(at(0, 0), hand(hour, 6))} {...stylex.props(fill.hand)} />
      <line {...lineProps(at(0, 0), hand(minute, 9.5))} {...stylex.props(fill.hand)} />
      <circle cx={r1(at(0, 0).x)} cy={r1(at(0, 0).y)} r={1.4} {...stylex.props(fill.red)} />
    </g>
  );
}

function ArtFrame({ y0, y1 }: { y0: number; y1: number }) {
  return (
    <g>
      <Poly points={onWall("left", y0, y1, 58, 104, 1)} s={fill.frame} />
      <Poly points={onWall("left", y0 + 6, y0 + 22, 66, 82, 2)} s={fill.b5} />
      <Poly points={onWall("left", y0 + 18, y1 - 6, 74, 96, 2)} s={fill.b6} />
      <Poly points={onWall("left", y0 + 10, y1 - 14, 62, 70, 2)} s={fill.b7} />
    </g>
  );
}

// ---------- Furniture ----------

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const p = 9 * size;
  const top = project(x, y, 16 * size);
  const leaves = [
    [-12, -8, 9, 15],
    [10, -12, 8, 16],
    [0, -22, 9, 17],
    [-6, -30, 7, 13],
    [7, -26, 7, 12],
  ] as const;
  return (
    <g>
      <Shadow cx={x} cy={y} r={p + 3} />
      <Box x={x - p / 2} y={y - p / 2} w={p} d={p} h={16 * size} m={{ top: fill.potTop, left: fill.potL, right: fill.potR }} />
      {leaves.map(([dx, dy, rx, ry], i) => (
        <ellipse
          key={i}
          cx={r1(top.x + dx * size)}
          cy={r1(top.y + dy * size)}
          rx={r1(rx * size)}
          ry={r1(ry * size)}
          transform={`rotate(${dx * 2.2} ${r1(top.x + dx * size)} ${r1(top.y + dy * size)})`}
          {...stylex.props(i % 2 ? fill.leafDark : fill.leaf)}
        />
      ))}
    </g>
  );
}

function Chair({ x, y, m = TEAL_M }: { x: number; y: number; m?: Material }) {
  const base = project(x, y, 0);
  const back = project(x, y, 20);
  return (
    <g>
      <Shadow cx={x} cy={y} r={11} />
      <line {...lineProps(base, project(x, y, 16))} {...stylex.props(fill.ink)} />
      <rect x={r1(back.x - 9)} y={r1(back.y - 26)} width={18} height={24} rx={5} {...stylex.props(m.right)} />
      <Poly points={ring(x, y, 11, 11, 18, 20)} s={m.left} />
      <Poly points={ring(x, y, 10, 10, 20, 20)} s={m.top} />
    </g>
  );
}

/** A sitting person's shoulders, under the face drawn on top. */
function Body({ at, hue }: { at: Pt; hue: number }) {
  const { x, y } = at;
  const d = `M ${r1(x - 19)} ${r1(y + 46)} C ${r1(x - 20)} ${r1(y + 22)} ${r1(x - 11)} ${r1(y + 16)} ${r1(x)} ${r1(y + 16)} C ${r1(x + 11)} ${r1(y + 16)} ${r1(x + 20)} ${r1(y + 22)} ${r1(x + 19)} ${r1(y + 46)} Z`;
  return (
    <g>
      <path d={d} {...stylex.props(SHIRTS[hue % SHIRTS.length]!)} />
      <path d={`M ${r1(x - 7)} ${r1(y + 18)} L ${r1(x)} ${r1(y + 26)} L ${r1(x + 7)} ${r1(y + 18)} Z`} {...stylex.props(fill.collar)} />
    </g>
  );
}

export type ScreenState = "off" | "on" | "think";

/** A monitor whose screen faces the chair in front of the desk; it glows and types while its owner works. */
function Monitor({ cx, y, z, screen, w = 34 }: { cx: number; y: number; z: number; screen: ScreenState; w?: number }) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const sy = y + 4;
  const face = (u0: number, u1: number, z0: number, z1: number) => [project(u0, sy, z0), project(u1, sy, z0), project(u1, sy, z1), project(u0, sy, z1)];
  const lines = [
    { u: 4, len: 0.62, z: 21, s: fill.codeA, delay: undefined },
    { u: 8, len: 0.48, z: 17, s: fill.codeB, delay: motion.delay1 },
    { u: 8, len: 0.7, z: 13, s: fill.codeA, delay: motion.delay2 },
    { u: 4, len: 0.38, z: 9, s: fill.codeC, delay: motion.delay3 },
  ];
  return (
    <g>
      {screen !== "off" && <Poly points={face(x0 - 6, x1 + 6, z - 4, z + 30)} s={[screen === "on" ? fill.glow : fill.glowThink, motion.glow]} />}
      <Box x={cx - 3} y={y} z={z - 8} w={6} d={4} h={10} m={DARK_M} />
      <Box x={x0} y={y} z={z} w={w} d={4} h={24} m={DARK_M} />
      <Poly points={face(x0 + 2, x1 - 2, z + 2, z + 22)} s={screen === "on" ? fill.screenOn : screen === "think" ? fill.screenThink : fill.screenOff} />
      {screen === "on" &&
        lines.map((l, i) => {
          const from = project(x0 + l.u, sy, z + l.z - 2);
          const to = project(x0 + l.u + (w - 10) * l.len, sy, z + l.z - 2);
          return <line key={i} {...lineProps(from, to)} pathLength={1} {...stylex.props(l.s, motion.type, l.delay)} />;
        })}
      {screen === "think" &&
        [0, 1, 2].map((i) => {
          const p = project(cx - 8 + i * 8, sy, z + 12);
          return <circle key={i} cx={r1(p.x)} cy={r1(p.y)} r={2.2} {...stylex.props(fill.thinkDot, motion.dot, i === 1 && motion.delay1, i === 2 && motion.delay2)} />;
        })}
    </g>
  );
}

function DeskArt({ desk, screen, seated, hue, index }: { desk: Desk; screen: ScreenState; seated: boolean; hue: number; index: number }) {
  const { x, y, w, d } = desk;
  const isLead = desk.kind === "lead";
  const z = DESK.h;
  const cx = x + w / 2;
  const chairM = isLead ? { top: fill.woodTop, left: fill.potL, right: fill.potR } : desk.kind === "hr" ? PURPLE_M : TEAL_M;
  return (
    <g>
      <Shadow cx={cx} cy={y + d / 2} r={w / 2} />
      <Box x={x + 2} y={y + 2} w={3} d={d - 4} h={z - 4} m={LEG_M} />
      <Box x={x + w - 5} y={y + 2} w={3} d={d - 4} h={z - 4} m={LEG_M} />
      <Box x={x} y={y} z={z - 4} w={w} d={d} h={4} m={isLead ? WOOD_M : WHITE_M} />
      {isLead ? (
        <>
          <Monitor cx={cx - 22} y={y + 3} z={z + 8} screen={screen} w={32} />
          <Monitor cx={cx + 20} y={y + 3} z={z + 8} screen={screen === "think" ? "on" : screen} w={32} />
        </>
      ) : (
        <Monitor cx={cx} y={y + 3} z={z + 8} screen={screen} />
      )}
      {/* Keyboard, a mug, sometimes a small plant or a lamp. */}
      <Box x={cx - 12} y={y + d - 14} z={z} w={24} d={7} h={1.5} m={DARK_M} />
      <Box x={x + w - 12} y={y + d - 16} z={z} w={5} d={5} h={6} m={index % 2 ? { top: fill.white, left: fill.red, right: fill.red } : WHITE_M} />
      {index % 3 === 1 && <Plant x={x + 8} y={y + 8} size={0.55} />}
      {isLead && <Box x={x + 6} y={y + d - 12} z={z} w={16} d={5} h={4} m={{ top: fill.potTop, left: fill.b2, right: fill.b6 }} />}
      <Chair x={desk.chair.x} y={desk.chair.y} m={chairM} />
      {seated && <Body at={desk.seat} hue={hue} />}
    </g>
  );
}

function Bookshelf() {
  // Against the back-left wall, facing the room (its +x side shows the books).
  const y0 = 30;
  const y1 = 158;
  const shelves = [8, 36, 64, 92];
  const books: ReactNode[] = [];
  shelves.forEach((sz, row) => {
    let y = y0 + 5;
    let k = row * 3;
    while (y < y1 - 10) {
      const t = 5 + ((k * 7) % 5);
      const h = 15 + ((k * 5) % 9);
      const lean = k % 9 === 4;
      books.push(
        <Poly
          key={`${row}-${k}`}
          points={[project(21, y, sz + 1), project(21, y + t, sz + 1), project(21, y + t + (lean ? 3 : 0), sz + h), project(21, y + (lean ? 3 : 0), sz + h)]}
          s={BOOKS[k % BOOKS.length]!}
        />,
      );
      y += t + (k % 4 === 3 ? 6 : 1);
      k++;
    }
  });
  return (
    <g>
      <Box x={0} y={y0} w={24} d={y1 - y0} h={118} m={WOOD_M} />
      {shelves.map((sz) => (
        <Poly key={sz} points={[project(24, y0 + 4, sz), project(24, y1 - 4, sz), project(24, y1 - 4, sz + 24), project(24, y0 + 4, sz + 24)]} s={fill.woodR} />
      ))}
      {books}
    </g>
  );
}

function Kitchen({ a }: { a: number }) {
  const x0 = a - 214;
  const m = project(a - 160, 14, 66);
  return (
    <g>
      <Box x={x0 - 40} y={0} w={38} d={34} h={104} m={WHITE_M} />
      <line {...lineProps(project(x0 - 8, 34.5, 64), project(x0 - 8, 34.5, 84))} {...stylex.props(fill.ink)} />
      <Box x={x0} y={0} w={194} d={30} h={34} m={TEAL_M} />
      <Box x={x0 - 2} y={-1} w={198} d={33} z={34} h={3} m={WHITE_M} />
      <Box x={x0 + 10} y={0} w={110} d={16} z={72} h={28} m={TEAL_M} />
      {/* Sink, coffee machine with a mug and its steam, a fruit bowl. */}
      <Poly points={[project(x0 + 128, 6, 37.2), project(x0 + 164, 6, 37.2), project(x0 + 164, 24, 37.2), project(x0 + 128, 24, 37.2)]} s={fill.leg} />
      <Box x={a - 172} y={6} z={37} w={22} d={18} h={26} m={DARK_M} />
      <Box x={a - 165} y={18} z={39} w={6} d={6} h={7} m={{ top: fill.white, left: fill.red, right: fill.red }} />
      {[0, 1].map((i) => (
        <path
          key={i}
          d={`M ${r1(m.x - 2 + i * 6)} ${r1(m.y + 6)} c -4 -6 4 -9 0 -15 c -4 -6 4 -9 0 -15`}
          {...stylex.props(fill.steam, motion.steam, i === 1 && motion.delay2)}
        />
      ))}
      <Poly points={ring(x0 + 30, 16, 9, 9, 38, 16)} s={fill.woodR} />
      <circle cx={r1(project(x0 + 28, 14, 42).x)} cy={r1(project(x0 + 28, 14, 42).y)} r={3.5} {...stylex.props(fill.b6)} />
      <circle cx={r1(project(x0 + 33, 18, 42).x)} cy={r1(project(x0 + 33, 18, 42).y)} r={3.5} {...stylex.props(fill.b3)} />
    </g>
  );
}

function Table({ spot, isOn }: { spot: MeetingSpot; isOn: boolean }) {
  const { cx, cy, rx, ry } = spot;
  const h = spot.kind === "table" ? 30 : 32;
  return (
    <g>
      <Poly points={ring(cx, cy, rx + 4, ry + 4, 0)} s={fill.shadow} />
      <Box x={cx - 4} y={cy - 4} w={8} d={8} h={h - 3} m={LEG_M} />
      <Poly points={ring(cx, cy, rx, ry, h - 4)} s={fill.woodR} />
      <Poly points={ring(cx, cy, rx, ry, h)} s={fill.woodTop} />
      {spot.kind === "table" && isOn && <Poly points={ring(cx, cy, rx * 0.45, ry * 0.4, h + 0.5)} s={[fill.glow, motion.glow]} />}
    </g>
  );
}

function Rug({ cx, cy, rx, ry, s, edge }: { cx: number; cy: number; rx: number; ry: number; s: Style; edge?: Style }) {
  const corners = [project(cx - rx, cy - ry), project(cx + rx, cy - ry), project(cx + rx, cy + ry), project(cx - rx, cy + ry)];
  const inner = [project(cx - rx + 8, cy - ry + 8), project(cx + rx - 8, cy - ry + 8), project(cx + rx - 8, cy + ry - 8), project(cx - rx + 8, cy + ry - 8)];
  return (
    <g>
      <Poly points={corners} s={s} />
      {edge && <polygon points={pts(inner)} {...stylex.props(edge)} />}
    </g>
  );
}

function Sofa({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <Shadow cx={x + 18} cy={y + 46} r={40} />
      <Box x={x} y={y} w={14} d={92} h={38} m={PURPLE_M} />
      <Box x={x} y={y} w={36} d={10} h={26} m={PURPLE_M} />
      <Box x={x + 12} y={y + 10} w={24} d={72} h={16} m={PURPLE_M} />
      <Box x={x} y={y + 82} w={36} d={10} h={26} m={PURPLE_M} />
      <Box x={x + 54} y={y + 26} w={30} d={40} h={16} m={WOOD_M} />
    </g>
  );
}

// ---------- The whole room ----------

export interface OfficeArtProps {
  layout: SceneLayout;
  /** Each desk's screen, by desk key. */
  screens: Record<string, ScreenState>;
  /** People sitting somewhere, with the hue of their clothes. */
  seated: Record<string, number>;
  /** Spot indexes with a meeting on. */
  activeSpots: Set<number>;
  /** Placements at meeting spots whose person is working (their tablet glows). */
  workingAt: Set<string>;
  /** Dashed lines from a meeting card (pinned in a corner) to its table, in drawing units. */
  links: { from: Pt; to: Pt }[];
  now: Date;
}

export function OfficeArt({ layout, screens, seated, activeSpots, workingAt, links, now }: OfficeArtProps) {
  const { a, b, view } = layout;
  const items: { depth: number; node: ReactNode }[] = [];
  const add = (depth: number, node: ReactNode) => items.push({ depth, node });

  layout.desks.forEach((desk, i) => {
    add(desk.x + desk.y + desk.w / 2 + desk.d, (
      <DeskArt
        key={desk.key}
        desk={desk}
        screen={screens[desk.key] ?? "off"}
        seated={Boolean(desk.personId && layout.placements.some((p) => p.personId === desk.personId && p.where === "desk"))}
        hue={desk.personId ? (seated[desk.personId] ?? i) : i}
        index={i}
      />
    ));
  });

  layout.spots.forEach((spot, s) => {
    add(spot.cx + spot.cy, <Table key={`t${s}`} spot={spot} isOn={activeSpots.has(s)} />);
    const atSpot = layout.placements.filter((p) => p.spot === s);
    // Empty chairs fill the rest of the table.
    seatsAround(spot, Math.max(atSpot.length, spot.chairs))
      .slice(atSpot.length)
      .forEach(({ chair }, k) => add(chair.x + chair.y, <Chair key={`c${s}-${k}`} x={chair.x} y={chair.y} m={spot.kind === "table" ? TEAL_M : WOOD_M} />));
    atSpot.forEach((p) => {
      const tablet = {
        x: spot.cx + (p.chair.x - spot.cx) * 0.62,
        y: spot.cy + (p.chair.y - spot.cy) * 0.62,
      };
      add(p.chair.x + p.chair.y, (
        <g key={`m${p.personId}`}>
          <Chair x={p.chair.x} y={p.chair.y} m={spot.kind === "table" ? TEAL_M : WOOD_M} />
          <Body at={p.at} hue={seated[p.personId] ?? 0} />
        </g>
      ));
      add(spot.cx + spot.cy + 0.5, (
        <Poly
          key={`l${p.personId}`}
          points={ring(tablet.x, tablet.y, 7, 5, spot.kind === "table" ? 30.6 : 32.6, 4)}
          s={workingAt.has(p.personId) ? [fill.screenOn] : [fill.dark]}
        />
      ));
    });
  });

  // Plants and the lounge.
  add(a - 24 + 150, <Plant key="pl1" x={a - 24} y={150} size={1.2} />);
  add(26 + 180, <Plant key="pl2" x={26} y={180} />);
  add(a - 26 + b - 26, <Plant key="pl3" x={a - 26} y={b - 26} size={1.3} />);
  add(24 + b - 24, <Plant key="pl4" x={24} y={b - 24} size={1.1} />);
  if (layout.hasLounge) add(30 + 270, <Sofa key="sofa" x={10} y={226} />);

  items.sort((p, q) => p.depth - q.depth);

  return (
    <svg
      viewBox={`${r1(view.x)} ${r1(view.y)} ${r1(view.width)} ${r1(view.height)}`}
      width="100%"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      {...stylex.props(svgStyles.root)}>
      <Floor a={a} b={b} />
      <Walls a={a} b={b} />
      <Windows wall="right" spans={[[196, 262], [292, Math.min(358, a - 262)]]} />
      <Windows wall="left" spans={layout.hasLounge ? [[340, 410]] : []} />
      <Whiteboard isOn={activeSpots.has(0)} />
      <Clock now={now} x={178} />
      <ArtFrame y0={b - 132} y1={b - 64} />
      <Rug cx={150} cy={132} rx={124} ry={92} s={fill.rugBlue} edge={fill.rugBlueEdge} />
      <Rug cx={86} cy={b - 96} rx={70} ry={72} s={fill.rugGreen} edge={fill.rugGreenEdge} />
      {layout.hasLounge && <Rug cx={58} cy={272} rx={46} ry={56} s={fill.rugPink} />}
      <Bookshelf />
      <Kitchen a={a} />
      {items.map((item) => item.node)}
      {links.map((l, i) => (
        <g key={`link${i}`}>
          <line {...lineProps(l.from, l.to)} {...stylex.props(fill.link)} />
          <circle cx={r1(l.to.x)} cy={r1(l.to.y)} r={4} {...stylex.props(fill.linkEnd)} />
        </g>
      ))}
    </svg>
  );
}

const svgStyles = stylex.create({
  root: { display: "block", width: "100%", height: "auto", overflow: "visible" },
});
