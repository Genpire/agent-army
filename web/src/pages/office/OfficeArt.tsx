/**
 * The office, drawn: an isometric room (floor, two walls with windows, a
 * whiteboard and a clock), the meeting table, the kitchen and its table, the
 * skills library shelf, the HR corner, the games (foosball, ping pong,
 * pinball, a video game corner with its TV, console and beanbags), a desk
 * with a monitor for every agent and Pointer's desk at the front. People's
 * bodies sit on their chairs; their
 * faces, name tags and speech bubbles are HTML on top (OfficeScene).
 *
 * An illustration is the one place this app draws SVG, so its markup stays in
 * this file. Every colour is an Astryx colour token, mixed in light-dark() so
 * the room is warm in the light theme and calm in the dark one; monitors glow
 * and type only while their owner works, and every animation stops under
 * prefers-reduced-motion. Decorative: the page describes everyone in text.
 * What moves with the office's life (people walking, a cup brewing, the
 * foosball, a ping pong rally, a pinball game, the video game on the TV) is
 * drawn by LifeArt.tsx with the same helpers and colours.
 */
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { BEANBAG_R, DESK, type Desk, FLOOR_T, type GameCorner, type MeetingSpot, PINGPONG, type Pt, type SceneLayout, TV, WALL_H, project, seatsAround } from "./layout";

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

export const fill = stylex.create({
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
  // People on the move (LifeArt): trousers, shoes, arms.
  trousers: { fill: `light-dark(color-mix(in oklab, ${K} 62%, ${BLUE}), color-mix(in oklab, ${K} 45%, ${BLUE}))` },
  shoe: { fill: DARK },
  // The foosball table's pitch, its lines and the ball.
  pitch: { fill: `light-dark(color-mix(in oklab, ${GREEN} 62%, ${W}), color-mix(in oklab, ${GREEN} 48%, ${S}))` },
  pitchLine: { stroke: W, strokeOpacity: 0.75, strokeWidth: 1, fill: "none" },
  rod: { stroke: `light-dark(color-mix(in oklab, ${GRAY} 60%, ${W}), color-mix(in oklab, ${W} 55%, ${S}))`, strokeWidth: 1.4, strokeLinecap: "round" },
  ball: { fill: W, stroke: `color-mix(in oklab, ${K} 40%, ${GRAY})`, strokeWidth: 0.6 },
  // Coffee pouring and water drops.
  coffee: { stroke: `color-mix(in oklab, ${ORANGE} 40%, ${K})`, strokeWidth: 1.6, strokeLinecap: "round" },
  drop: { fill: `color-mix(in oklab, ${BLUE} 70%, ${W})` },
  // The ping pong table: a blue top with white lines, the net, the paddles and the ball.
  pongTop: { fill: `light-dark(color-mix(in oklab, ${BLUE} 62%, ${W}), color-mix(in oklab, ${BLUE} 50%, ${S}))` },
  pongL: { fill: `light-dark(color-mix(in oklab, ${BLUE} 72%, ${K}), color-mix(in oklab, ${BLUE} 40%, ${K}))` },
  pongR: { fill: `light-dark(color-mix(in oklab, ${BLUE} 60%, ${K}), color-mix(in oklab, ${BLUE} 32%, ${K}))` },
  pongLine: { stroke: W, strokeOpacity: 0.9, strokeWidth: 1, fill: "none" },
  net: { fill: K, fillOpacity: 0.32 },
  netTop: { stroke: W, strokeWidth: 1.2, strokeLinecap: "round" },
  paddleRed: { fill: RED },
  paddleBlack: { fill: DARK },
  pongBall: { fill: `color-mix(in oklab, ${ORANGE} 30%, ${W})`, stroke: `color-mix(in oklab, ${ORANGE} 70%, ${K})`, strokeWidth: 0.5 },
  // The pinball machine: the playfield under glass, its bumpers and lights, the head's back glass.
  playfield: { fill: `light-dark(color-mix(in oklab, ${BLUE} 42%, ${K}), color-mix(in oklab, ${BLUE} 34%, ${K}))` },
  backglass: { fill: `color-mix(in oklab, ${PINK} 55%, ${PURPLE})` },
  backglassArt: { fill: `color-mix(in oklab, ${YELLOW} 80%, ${ORANGE})` },
  display: { fill: `color-mix(in oklab, ${K} 85%, ${ORANGE})` },
  flipper: { stroke: W, strokeWidth: 1.6, strokeLinecap: "round" },
  steel: { fill: `light-dark(color-mix(in oklab, ${GRAY} 35%, ${W}), color-mix(in oklab, ${W} 70%, ${GRAY}))` },
  lightRed: { fill: RED },
  lightYellow: { fill: YELLOW },
  lightBlue: { fill: `color-mix(in oklab, ${BLUE} 60%, ${W})` },
  lightGreen: { fill: GREEN },
  // The video game corner: beanbags, the TV's glass while it is off, the console's light; the game on it (LifeArt): a neon city at sunset.
  beanTop: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 80%, ${W}), color-mix(in oklab, ${ORANGE} 70%, ${S}))` },
  beanSide: { fill: `light-dark(color-mix(in oklab, ${ORANGE} 85%, ${K}), color-mix(in oklab, ${ORANGE} 55%, ${K}))` },
  tvOff: { fill: `color-mix(in oklab, ${K} 88%, ${BLUE})` },
  consoleLight: { fill: `color-mix(in oklab, ${TEAL} 70%, ${W})` },
  skyTop: { fill: `color-mix(in oklab, ${PURPLE} 85%, ${K})` },
  skyMid: { fill: `color-mix(in oklab, ${PINK} 80%, ${PURPLE})` },
  skyLow: { fill: `color-mix(in oklab, ${ORANGE} 80%, ${PINK})` },
  sun: { fill: `color-mix(in oklab, ${YELLOW} 70%, ${W})` },
  cityFar: { fill: `color-mix(in oklab, ${PURPLE} 70%, ${PINK})` },
  cityNear: { fill: `color-mix(in oklab, ${PURPLE} 50%, ${K})` },
  neonPink: { fill: `color-mix(in oklab, ${PINK} 80%, ${W})` },
  neonTeal: { fill: `color-mix(in oklab, ${TEAL} 70%, ${W})` },
  neonYellow: { fill: `color-mix(in oklab, ${YELLOW} 80%, ${W})` },
  road: { fill: `color-mix(in oklab, ${K} 82%, ${PURPLE})` },
  kerb: { fill: `color-mix(in oklab, ${PINK} 45%, ${K})` },
  lane: { fill: `color-mix(in oklab, ${YELLOW} 60%, ${W})` },
  carA: { fill: `color-mix(in oklab, ${TEAL} 80%, ${W})` },
  carB: { fill: `color-mix(in oklab, ${PINK} 85%, ${W})` },
  carGlass: { fill: `color-mix(in oklab, ${BLUE} 35%, ${K})` },
  beam: { fill: `color-mix(in oklab, ${YELLOW} 80%, ${W})`, fillOpacity: 0.35 },
  mapBack: { fill: K, fillOpacity: 0.55 },
  mapRoad: { stroke: W, strokeOpacity: 0.55, strokeWidth: 0.8, fill: "none" },
});

const BOOKS = [fill.b0, fill.b1, fill.b2, fill.b3, fill.b4, fill.b5, fill.b6, fill.b7];
export const SHIRTS = [fill.s0, fill.s1, fill.s2, fill.s3, fill.s4, fill.s5];

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
  dot: {
    animationName: { default: blink, [REDUCE]: "none" },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  delay1: { animationDelay: "0.4s" },
  delay2: { animationDelay: "0.8s" },
  delay3: { animationDelay: "1.2s" },
  // A hidden tab holds every loop.
  paused: { animationPlayState: "paused" },
});

// ---------- Drawing helpers ----------

export const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (list: Pt[]) => list.map((p) => `${r1(p.x)},${r1(p.y)}`).join(" ");

type Style = stylex.StyleXStyles;
export interface Material {
  top: Style;
  left: Style;
  right: Style;
}

export const WOOD_M: Material = { top: fill.woodTop, left: fill.woodL, right: fill.woodR };
export const WHITE_M: Material = { top: fill.whiteTop, left: fill.whiteL, right: fill.whiteR };
export const DARK_M: Material = { top: fill.dark, left: fill.darkSide, right: fill.dark };
export const TEAL_M: Material = { top: fill.tealTop, left: fill.tealL, right: fill.tealR };
export const PURPLE_M: Material = { top: fill.purpleTop, left: fill.purpleL, right: fill.purpleR };
export const LEG_M: Material = { top: fill.leg, left: fill.leg, right: fill.leg };
export const PONG_M: Material = { top: fill.pongTop, left: fill.pongL, right: fill.pongR };

export function Poly({ points, s }: { points: Pt[]; s: Style | Style[] }) {
  return <polygon points={pts(points)} {...stylex.props(s)} />;
}

/** A box from (x, y, z) to (x + w, y + d, z + h): its top and the two sides that face the viewer. */
export function Box({ x, y, z = 0, w, d, h, m }: { x: number; y: number; z?: number; w: number; d: number; h: number; m: Material }) {
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
export function ring(cx: number, cy: number, rx: number, ry: number, z: number, steps = 36): Pt[] {
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

export function Shadow({ cx, cy, r }: { cx: number; cy: number; r: number }) {
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

export const lineProps = (p: Pt, q: Pt) => ({ x1: r1(p.x), y1: r1(p.y), x2: r1(q.x), y2: r1(q.y) });

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
export function Body({ at, hue }: { at: Pt; hue: number }) {
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
function Monitor({ cx, y, z, screen, w = 34, isPaused }: { cx: number; y: number; z: number; screen: ScreenState; w?: number; isPaused?: boolean }) {
  const held = isPaused && motion.paused;
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
      {screen !== "off" && <Poly points={face(x0 - 6, x1 + 6, z - 4, z + 30)} s={[screen === "on" ? fill.glow : fill.glowThink, motion.glow, held]} />}
      <Box x={cx - 3} y={y} z={z - 8} w={6} d={4} h={10} m={DARK_M} />
      <Box x={x0} y={y} z={z} w={w} d={4} h={24} m={DARK_M} />
      <Poly points={face(x0 + 2, x1 - 2, z + 2, z + 22)} s={screen === "on" ? fill.screenOn : screen === "think" ? fill.screenThink : fill.screenOff} />
      {screen === "on" &&
        lines.map((l, i) => {
          const from = project(x0 + l.u, sy, z + l.z - 2);
          const to = project(x0 + l.u + (w - 10) * l.len, sy, z + l.z - 2);
          return <line key={i} {...lineProps(from, to)} pathLength={1} {...stylex.props(l.s, motion.type, l.delay, held)} />;
        })}
      {screen === "think" &&
        [0, 1, 2].map((i) => {
          const p = project(cx - 8 + i * 8, sy, z + 12);
          return <circle key={i} cx={r1(p.x)} cy={r1(p.y)} r={2.2} {...stylex.props(fill.thinkDot, motion.dot, i === 1 && motion.delay1, i === 2 && motion.delay2, held)} />;
        })}
    </g>
  );
}

function DeskArt({ desk, screen, seated, hue, index, isPaused }: { desk: Desk; screen: ScreenState; seated: boolean; hue: number; index: number; isPaused?: boolean }) {
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
          <Monitor cx={cx - 22} y={y + 3} z={z + 8} screen={screen} w={32} isPaused={isPaused} />
          <Monitor cx={cx + 20} y={y + 3} z={z + 8} screen={screen === "think" ? "on" : screen} w={32} isPaused={isPaused} />
        </>
      ) : (
        <Monitor cx={cx} y={y + 3} z={z + 8} screen={screen} isPaused={isPaused} />
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
  return (
    <g>
      <Box x={x0 - 40} y={0} w={38} d={34} h={104} m={WHITE_M} />
      <line {...lineProps(project(x0 - 8, 34.5, 64), project(x0 - 8, 34.5, 84))} {...stylex.props(fill.ink)} />
      <Box x={x0} y={0} w={194} d={30} h={34} m={TEAL_M} />
      <Box x={x0 - 2} y={-1} w={198} d={33} z={34} h={3} m={WHITE_M} />
      <Box x={x0 + 10} y={0} w={110} d={16} z={72} h={28} m={TEAL_M} />
      {/* Sink, the coffee machine (its cup appears while someone brews: LifeArt), a fruit bowl. */}
      <Poly points={[project(x0 + 128, 6, 37.2), project(x0 + 164, 6, 37.2), project(x0 + 164, 24, 37.2), project(x0 + 128, 24, 37.2)]} s={fill.leg} />
      <Box x={a - 172} y={6} z={37} w={22} d={18} h={26} m={DARK_M} />
      <Poly points={ring(x0 + 30, 16, 9, 9, 38, 16)} s={fill.woodR} />
      <circle cx={r1(project(x0 + 28, 14, 42).x)} cy={r1(project(x0 + 28, 14, 42).y)} r={3.5} {...stylex.props(fill.b6)} />
      <circle cx={r1(project(x0 + 33, 18, 42).x)} cy={r1(project(x0 + 33, 18, 42).y)} r={3.5} {...stylex.props(fill.b3)} />
    </g>
  );
}

function Table({ spot, isOn, isPaused }: { spot: MeetingSpot; isOn: boolean; isPaused?: boolean }) {
  const { cx, cy, rx, ry } = spot;
  const h = spot.kind === "table" ? 30 : 32;
  return (
    <g>
      <Poly points={ring(cx, cy, rx + 4, ry + 4, 0)} s={fill.shadow} />
      <Box x={cx - 4} y={cy - 4} w={8} d={8} h={h - 3} m={LEG_M} />
      <Poly points={ring(cx, cy, rx, ry, h - 4)} s={fill.woodR} />
      <Poly points={ring(cx, cy, rx, ry, h)} s={fill.woodTop} />
      {spot.kind === "table" && isOn && <Poly points={ring(cx, cy, rx * 0.45, ry * 0.4, h + 0.5)} s={[fill.glow, motion.glow, isPaused && motion.paused]} />}
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

/** The lounge's foosball table: a wooden cabinet on legs, a green pitch with goals, and four rods with little players (two per team). */
function Foosball({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  const h = 26;
  const cx = x + w / 2;
  const top = (u: number, v: number, dz = 0) => project(u, v, h + dz);
  const rods = [-21, -7, 7, 21];
  return (
    <g>
      <Shadow cx={cx} cy={y + d / 2} r={w / 2 + 4} />
      {[
        [x + 2, y + 2],
        [x + w - 6, y + 2],
        [x + 2, y + d - 6],
        [x + w - 6, y + d - 6],
      ].map(([lx, ly]) => (
        <Box key={`${lx}-${ly}`} x={lx!} y={ly!} w={4} d={4} h={h - 10} m={LEG_M} />
      ))}
      <Box x={x} y={y} z={h - 10} w={w} d={d} h={10} m={WOOD_M} />
      <Poly points={[top(x + 3, y + 3, 0.2), top(x + w - 3, y + 3, 0.2), top(x + w - 3, y + d - 3, 0.2), top(x + 3, y + d - 3, 0.2)]} s={fill.pitch} />
      <line {...lineProps(top(cx, y + 3, 0.4), top(cx, y + d - 3, 0.4))} {...stylex.props(fill.pitchLine)} />
      <Poly points={ring(cx, y + d / 2, 5, 5, h + 0.4, 14)} s={fill.pitchLine} />
      <Box x={x + 1} y={y + d / 2 - 5} z={h - 2} w={3} d={10} h={3} m={DARK_M} />
      <Box x={x + w - 4} y={y + d / 2 - 5} z={h - 2} w={3} d={10} h={3} m={DARK_M} />
      {rods.map((dx, i) => {
        const team = i === 0 || i === 2 ? fill.b0 : fill.b1;
        return (
          <g key={dx}>
            <line {...lineProps(top(cx + dx, y - 7, 5), top(cx + dx, y + d + 7, 5))} {...stylex.props(fill.rod)} />
            {[0.3, 0.7].map((k) => (
              <Box key={k} x={cx + dx - 1.5} y={y + d * k - 1.5} z={h} w={3} d={3} h={6} m={{ top: team, left: team, right: team }} />
            ))}
            <Poly points={ring(cx + dx, y + d + 8, 1.6, 1.6, h + 5, 8)} s={fill.dark} />
          </g>
        );
      })}
    </g>
  );
}

/** A paddle lying on the ping pong table, in world units. */
function Paddle({ x, y, z, s }: { x: number; y: number; z: number; s: Style }) {
  return (
    <g>
      <line {...lineProps(project(x, y, z), project(x + 7, y + 3, z))} {...stylex.props(fill.rod)} />
      <Poly points={ring(x - 1, y, 4.2, 4.2, z, 14)} s={s} />
    </g>
  );
}

/** The ping pong table: a blue top on legs, white lines, the net across the middle and, while nobody plays, two paddles on it. */
function PingPong({ x, y, w, d, isInUse }: { x: number; y: number; w: number; d: number; isInUse: boolean }) {
  const h = PINGPONG.h;
  const cx = x + w / 2;
  const top = (u: number, v: number, dz = 0) => project(u, v, h + dz);
  return (
    <g>
      <Shadow cx={cx} cy={y + d / 2} r={w / 2 + 2} />
      {[x + 6, x + w - 9].flatMap((lx) => [y + 4, y + d - 7].map((ly) => <Box key={`${lx}-${ly}`} x={lx} y={ly} w={3} d={3} h={h - 3} m={LEG_M} />))}
      <Box x={x} y={y} z={h - 3} w={w} d={d} h={3} m={PONG_M} />
      <Poly points={[top(x + 1.5, y + 1.5, 0.2), top(x + w - 1.5, y + 1.5, 0.2), top(x + w - 1.5, y + d - 1.5, 0.2), top(x + 1.5, y + d - 1.5, 0.2)]} s={fill.pongLine} />
      <line {...lineProps(top(x + 1.5, y + d / 2, 0.3), top(x + w - 1.5, y + d / 2, 0.3))} {...stylex.props(fill.pongLine)} />
      {/* The net, a little wider than the table, with its posts. */}
      <Poly points={[top(cx, y - 2), top(cx, y + d + 2), top(cx, y + d + 2, 6), top(cx, y - 2, 6)]} s={fill.net} />
      <line {...lineProps(top(cx, y - 2, 6), top(cx, y + d + 2, 6))} {...stylex.props(fill.netTop)} />
      <Box x={cx - 1} y={y - 3} z={h} w={2} d={2} h={6} m={DARK_M} />
      <Box x={cx - 1} y={y + d + 1} z={h} w={2} d={2} h={6} m={DARK_M} />
      {!isInUse && (
        <>
          <Paddle x={x + 12} y={y + d - 11} z={h + 0.4} s={fill.paddleRed} />
          <Paddle x={x + w - 16} y={y + 10} z={h + 0.4} s={fill.paddleBlack} />
        </>
      )}
    </g>
  );
}

/** A point on the pinball's playfield: `u` across it (0 left, 1 right), `v` from the flippers (0) up to the head (1); it slopes up towards the head. */
export function playfieldPoint(m: { x: number; y: number; w: number; d: number }, u: number, v: number, dz = 0): Pt {
  return project(m.x + 2 + u * (m.w - 4), m.y + m.d - 2 - v * (m.d - 11), 31 + 4 * v + dz);
}

/** The pinball machine: a cabinet on legs, the sloping playfield under glass with its bumpers and flippers, and the head with its back glass and score display. */
function Pinball({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  const head = 7;
  const P = project;
  const at = (u: number, v: number, dz = 0) => playfieldPoint({ x, y, w, d }, u, v, dz);
  const bumpers = [
    [0.3, 0.74, fill.lightRed],
    [0.7, 0.74, fill.lightYellow],
    [0.5, 0.56, fill.lightBlue],
  ] as const;
  return (
    <g>
      <Shadow cx={x + w / 2} cy={y + d / 2} r={d / 2} />
      {[x + 1, x + w - 4].flatMap((lx) => [y + head + 1, y + d - 4].map((ly) => <Box key={`${lx}-${ly}`} x={lx} y={ly} w={3} d={3} h={20} m={LEG_M} />))}
      <Box x={x} y={y + head} z={18} w={w} d={d - head} h={13} m={PURPLE_M} />
      {/* The sloping playfield, and the side's wedge under it. */}
      <Poly points={[P(x + w, y + head, 31), P(x + w, y + d, 31), P(x + w, y + head, 35)]} s={fill.purpleR} />
      <Poly points={[P(x, y + head, 35), P(x + w, y + head, 35), P(x + w, y + d, 31), P(x, y + d, 31)]} s={fill.purpleTop} />
      <Poly points={[at(0, 0, 0.2), at(1, 0, 0.2), at(1, 1, 0.2), at(0, 1, 0.2)]} s={fill.playfield} />
      {bumpers.map(([u, v, s]) => {
        const c = at(u, v, 0.6);
        return <ellipse key={`${u}-${v}`} cx={r1(c.x)} cy={r1(c.y)} rx={2.6} ry={1.6} {...stylex.props(s)} />;
      })}
      <line {...lineProps(at(0.18, 0.14, 0.6), at(0.4, 0.07, 0.6))} {...stylex.props(fill.flipper)} />
      <line {...lineProps(at(0.82, 0.14, 0.6), at(0.6, 0.07, 0.6))} {...stylex.props(fill.flipper)} />
      <Poly points={[at(0.05, 0.35, 0.8), at(0.2, 0.35, 0.8), at(0.2, 0.9, 0.8), at(0.05, 0.9, 0.8)]} s={fill.glassShine} />
      {/* The head: its back glass faces the player, the score display under the art. */}
      <Box x={x - 1} y={y} z={31} w={w + 2} d={head} h={40} m={DARK_M} />
      <Poly points={[P(x + 1, y + head, 50), P(x + w - 1, y + head, 50), P(x + w - 1, y + head, 69), P(x + 1, y + head, 69)]} s={fill.backglass} />
      <Poly points={[P(x + 5, y + head, 54), P(x + w - 5, y + head, 54), P(x + w / 2, y + head, 66)]} s={fill.backglassArt} />
      <Poly points={[P(x + 2, y + head, 40), P(x + w - 2, y + head, 40), P(x + w - 2, y + head, 47), P(x + 2, y + head, 47)]} s={fill.display} />
    </g>
  );
}

/** The TV's screen in the video game corner, facing the room (+x): the plane it is on (x), its left end as seen (y, the larger) and its top (z), in world units. */
export function tvScreen(g: Pick<GameCorner, "x" | "y" | "d">): { x: number; y: number; z: number } {
  return { x: g.x + 6, y: g.y + (g.d + TV.screen.w) / 2, z: TV.screen.z0 + TV.screen.h };
}

/** Draws in the TV screen's own units (TV.screen.w wide, TV.screen.h high, from its top-left corner as seen) onto the screen: an SVG transform. */
export function screenTransform(g: Pick<GameCorner, "x" | "y" | "d">): string {
  const s = tvScreen(g);
  return `matrix(1 -0.5 0 1 ${r1(s.x - s.y)} ${r1((s.x + s.y) / 2 - s.z)})`;
}

/** A controller lying on the TV's stand, in world units. */
function Controller({ x, y, z }: { x: number; y: number; z: number }) {
  const c = project(x, y, z);
  return (
    <g>
      <Poly points={ring(x, y, 2.4, 4.4, z, 14)} s={fill.dark} />
      <circle cx={r1(c.x + 1.2)} cy={r1(c.y - 0.2)} r={0.7} {...stylex.props(fill.consoleLight)} />
    </g>
  );
}

/**
 * The video game corner's TV: a low wooden stand against the wall with the
 * console in its open shelf (its light on), and a big TV on it facing the
 * room, dark while nobody plays (LifeArt draws the game on it). The two
 * controllers lie on the stand until someone picks them up.
 */
function GameCornerTv({ g, isInUse, isPaused }: { g: GameCorner; isInUse: boolean; isPaused?: boolean }) {
  const { x, y, w, d } = g;
  const h = TV.h;
  const s = tvScreen(g);
  const { w: sw, h: sh, z0 } = TV.screen;
  // A rectangle on the stand's front, which faces the room: from v0 to v1 along it.
  const front = (v0: number, v1: number, z0: number, z1: number, dx = 0.2) => [project(x + w + dx, v0, z0), project(x + w + dx, v1, z0), project(x + w + dx, v1, z1), project(x + w + dx, v0, z1)];
  return (
    <g>
      <Poly points={ring(x + w / 2, y + d / 2, w / 2 + 4, d / 2 + 2, 0, 24)} s={fill.shadow} />
      <Box x={x} y={y} w={w} d={d} h={h} m={WOOD_M} />
      <Poly points={front(y + 8, y + 36, 3, 11)} s={fill.darkSide} />
      <Poly points={front(y + 10, y + 32, 4, 8.5, 0.4)} s={fill.dark} />
      <Poly points={front(y + 12, y + 16, 6, 6.8, 0.6)} s={[fill.consoleLight, motion.glow, isPaused && motion.paused]} />
      <Box x={x + 2} y={y + d / 2 - 7} z={h} w={4} d={14} h={z0 - h - 2} m={DARK_M} />
      <Box x={s.x - 3} y={s.y - sw - 2} z={z0 - 2} w={3} d={sw + 4} h={sh + 4} m={DARK_M} />
      <g transform={screenTransform(g)}>
        <rect width={sw} height={sh} {...stylex.props(fill.tvOff)} />
        <polygon points={`${sw * 0.1},0 ${sw * 0.22},0 ${sw * 0.08},${sh} 0,${sh} 0,${sh * 0.7}`} {...stylex.props(fill.glassShine)} />
      </g>
      {!isInUse && (
        <>
          <Controller x={x + w - 3} y={y + 14} z={h + 0.4} />
          <Controller x={x + w - 3} y={y + d - 14} z={h + 0.4} />
        </>
      )}
    </g>
  );
}

/** A beanbag, squashed where someone sits, its back raised away from the TV. */
function Beanbag({ x, y, m }: { x: number; y: number; m: { top: Style; side: Style } }) {
  const R = BEANBAG_R;
  return (
    <g>
      <Shadow cx={x} cy={y} r={R + 2} />
      <Poly points={ring(x, y, R, R, 3, 24)} s={m.side} />
      <Poly points={ring(x, y, R - 0.5, R - 0.5, 9, 24)} s={m.side} />
      <Poly points={ring(x, y, R - 2, R - 2, 12, 24)} s={m.top} />
      <Poly points={ring(x + 5, y + 1, R - 7, R - 4, 16, 20)} s={m.side} />
      <Poly points={ring(x + 5, y + 1, R - 8, R - 5, 18, 20)} s={m.top} />
    </g>
  );
}

const BEANBAGS = [
  { top: fill.beanTop, side: fill.beanSide },
  { top: fill.tealTop, side: fill.tealR },
];

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
  /** People out of their seats (OfficeLife draws them): their chairs are empty. */
  away?: ReadonlySet<string>;
  /** The tab is hidden: the monitors' and the table's loops hold. */
  isPaused?: boolean;
  /** Someone plays ping pong: the paddles are in their hands, not on the table. */
  isPingPongOn?: boolean;
  /** Someone plays a video game: the controllers are in their hands, not on the TV's stand. */
  isGamingOn?: boolean;
}

export function OfficeArt({ layout, screens, seated, activeSpots, workingAt, links, now, away, isPaused, isPingPongOn = false, isGamingOn = false }: OfficeArtProps) {
  const { a, b, view } = layout;
  const items: { depth: number; node: ReactNode }[] = [];
  const add = (depth: number, node: ReactNode) => items.push({ depth, node });

  layout.desks.forEach((desk, i) => {
    add(desk.x + desk.y + desk.w / 2 + desk.d, (
      <DeskArt
        key={desk.key}
        desk={desk}
        screen={screens[desk.key] ?? "off"}
        seated={Boolean(desk.personId && !away?.has(desk.personId) && layout.placements.some((p) => p.personId === desk.personId && p.where === "desk"))}
        hue={desk.personId ? (seated[desk.personId] ?? i) : i}
        index={i}
        isPaused={isPaused}
      />
    ));
  });

  layout.spots.forEach((spot, s) => {
    add(spot.cx + spot.cy, <Table key={`t${s}`} spot={spot} isOn={activeSpots.has(s)} isPaused={isPaused} />);
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
          {!away?.has(p.personId) && <Body at={p.at} hue={seated[p.personId] ?? 0} />}
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

  // Plants, the lounge, the foosball and ping pong tables, the pinball machine and the video game corner.
  layout.plants.forEach((p, i) => add(p.x + p.y, <Plant key={`pl${i}`} x={p.x} y={p.y} size={p.size} />));
  if (layout.hasLounge) add(30 + 270, <Sofa key="sofa" x={10} y={226} />);
  const { foosball: foos, pingpong: pong, pinball: pin, gaming: game } = layout.life;
  add(foos.x + foos.y + foos.w / 2 + foos.d, <Foosball key="foosball" x={foos.x} y={foos.y} w={foos.w} d={foos.d} />);
  add(pong.x + pong.y + pong.w / 2 + pong.d, <PingPong key="pingpong" x={pong.x} y={pong.y} w={pong.w} d={pong.d} isInUse={isPingPongOn} />);
  add(pin.x + pin.y + pin.w / 2 + pin.d, <Pinball key="pinball" x={pin.x} y={pin.y} w={pin.w} d={pin.d} />);
  add(game.x + game.y + game.w / 2 + game.d, <GameCornerTv key="tv" g={game} isInUse={isGamingOn} isPaused={isPaused} />);
  game.seats.forEach((s, i) => add(s.at.x + s.at.y, <Beanbag key={`bean${i}`} x={s.at.x} y={s.at.y} m={BEANBAGS[i % BEANBAGS.length]!} />));

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
      {/* With a lounge, a window over the sofa (the video game corner has the wall below it). */}
      <Windows wall="left" spans={layout.hasLounge ? [[236, 306]] : []} />
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
