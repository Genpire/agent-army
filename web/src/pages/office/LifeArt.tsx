/**
 * The moving parts of the office, drawn like the room (OfficeArt.tsx, whose
 * helpers and token colours this reuses): a person out of their seat (legs,
 * shirt, arms and what they carry: a paddle that swings at each stroke, hands
 * on a pinball's buttons, a controller in the lap) and the props of what they
 * do (a cup brewing under the coffee machine, the foosball, the ping pong ball
 * flying from paddle to paddle, a pinball game's ball, flippers and lights,
 * the video game on the TV, water for a plant).
 *
 * Motion is transform and opacity only, in CSS keyframes or a Web Animation
 * (the ping pong ball, whose path life.ts computes), so it runs on the
 * compositor; `isPaused` (a hidden tab) holds it. The scene leaves all of
 * this out under prefers-reduced-motion. Decorative: aria-hidden.
 */
import { durationVars, easeVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";
import { type SceneLayout, TV, project } from "./layout";
import { type Activity, type Pose, type Prop, ballFrames } from "./life";
import { Box, Poly, SHIRTS, fill, playfieldPoint, r1, screenTransform, tvScreen } from "./OfficeArt";

// ---------- Motion ----------

// StyleX resolves these at build time, so they live here rather than being imported from OfficeArt.
const REDUCE = "@media (prefers-reduced-motion: reduce)";
const rise = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(4px)" },
  "40%": { opacity: 0.8 },
  "100%": { opacity: 0, transform: "translateY(-10px)" },
});
const swing = stylex.keyframes({
  "0%": { transform: "rotate(16deg)" },
  "50%": { transform: "rotate(-16deg)" },
  "100%": { transform: "rotate(16deg)" },
});
const appear = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(4px) scale(0.92)" },
  "100%": { opacity: 1, transform: "translateY(0) scale(1)" },
});
const pour = stylex.keyframes({
  "0%": { opacity: 0 },
  "10%": { opacity: 1 },
  "85%": { opacity: 1 },
  "100%": { opacity: 0 },
});
const fall = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(0)" },
  "30%": { opacity: 1 },
  "100%": { opacity: 0, transform: "translateY(9px)" },
});
// The ball's rally over the pitch, in screen units from its centre (world offsets projected: x → (1, ½), y → (−1, ½)).
const rally = stylex.keyframes({
  "0%": { transform: "translate(-16px, -14px)" },
  "18%": { transform: "translate(-16px, 0px)" },
  "36%": { transform: "translate(10px, 1px)" },
  "54%": { transform: "translate(14px, 13px)" },
  "72%": { transform: "translate(12px, -2px)" },
  "88%": { transform: "translate(-14px, -5px)" },
  "100%": { transform: "translate(-16px, -14px)" },
});

// A paddle's stroke: back, through the ball, and back to rest.
const stroke = stylex.keyframes({
  "0%": { transform: "rotate(-32deg)" },
  "45%": { transform: "rotate(26deg)" },
  "100%": { transform: "rotate(0deg)" },
});
// Fingers on a pinball's buttons.
const tap = stylex.keyframes({
  "0%": { transform: "translateY(0)" },
  "20%": { transform: "translateY(1.6px)" },
  "40%": { transform: "translateY(0)" },
  "100%": { transform: "translateY(0)" },
});
const flipLeft = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "12%": { transform: "rotate(-34deg)" },
  "30%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(0deg)" },
});
const flipRight = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "12%": { transform: "rotate(34deg)" },
  "30%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(0deg)" },
});
const flash = stylex.keyframes({
  "0%": { opacity: 0.15 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.15 },
});
// The pinball's ball round the playfield, in screen units from its centre (playfield offsets projected: across → (18, 9), up the slope → (29, −18.5)).
const run = stylex.keyframes({
  "0%": { transform: "translate(-11px, 7px)" },
  "16%": { transform: "translate(13.2px, -3.3px)" },
  "32%": { transform: "translate(8.6px, -9.6px)" },
  "48%": { transform: "translate(8px, -1px)" },
  "64%": { transform: "translate(-4px, -3.6px)" },
  "82%": { transform: "translate(-4px, 4.6px)" },
  "100%": { transform: "translate(-11px, 7px)" },
});

// The video game on the TV, in the screen's units: the city scrolls one tile (the screen's width) per loop, the lane dashes one dash.
const TILE = 72;
const DASH = 8;
const scroll = stylex.keyframes({
  "0%": { transform: "translateX(0)" },
  "100%": { transform: `translateX(-${TILE}px)` },
});
const rush = stylex.keyframes({
  "0%": { transform: "translateX(0)" },
  "100%": { transform: `translateX(-${DASH}px)` },
});
const bump = stylex.keyframes({
  "0%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-0.5px)" },
  "100%": { transform: "translateY(0)" },
});
// The other car overtakes and falls back, lap after lap.
const race = stylex.keyframes({
  "0%": { transform: "translateX(-9px)" },
  "50%": { transform: "translateX(8px)" },
  "100%": { transform: "translateX(-9px)" },
});
// The player's dot round the mini-map's block.
const lap = stylex.keyframes({
  "0%": { transform: "translate(0, 0)" },
  "30%": { transform: "translate(8px, 0)" },
  "50%": { transform: "translate(8px, 4px)" },
  "80%": { transform: "translate(0, 4px)" },
  "100%": { transform: "translate(0, 0)" },
});

const anim = stylex.create({
  leg: { transformBox: "fill-box", transformOrigin: "50% 0%" },
  walking: {
    animationName: { default: swing, [REDUCE]: "none" },
    animationDuration: "0.84s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  // The other leg is half a stride behind.
  stride: { animationDelay: "-0.42s" },
  appear: {
    animationName: { default: appear, [REDUCE]: "none" },
    animationDuration: durationVars["--duration-medium-min"],
    animationTimingFunction: easeVars["--ease-entrance"],
    animationFillMode: "both",
  },
  pour: { animationName: { default: pour, [REDUCE]: "none" }, animationDuration: "3.2s", animationFillMode: "both", animationTimingFunction: "linear" },
  steam: {
    opacity: 0,
    animationName: { default: rise, [REDUCE]: "none" },
    animationDuration: "1.8s",
    animationTimingFunction: "ease-out",
    animationIterationCount: "infinite",
  },
  fall: { animationName: { default: fall, [REDUCE]: "none" }, animationDuration: "0.8s", animationTimingFunction: "ease-in", animationIterationCount: "infinite" },
  rally: {
    animationName: { default: rally, [REDUCE]: "none" },
    animationDuration: "2.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  // The paddle arm turns at the shoulder (figure units).
  arm: { transformOrigin: "12px 31px" },
  stroke: { animationName: { default: stroke, [REDUCE]: "none" }, animationDuration: "0.42s", animationTimingFunction: easeVars["--ease-move"], animationFillMode: "both" },
  tap: { animationName: { default: tap, [REDUCE]: "none" }, animationDuration: "0.7s", animationIterationCount: "infinite" },
  tapOther: { animationDuration: "0.95s", animationDelay: "-0.3s" },
  flipper: { transformBox: "fill-box" },
  pivotLeft: { transformOrigin: "0% 0%" },
  pivotRight: { transformOrigin: "100% 100%" },
  flipLeft: { animationName: { default: flipLeft, [REDUCE]: "none" }, animationDuration: "0.9s", animationIterationCount: "infinite" },
  flipRight: { animationName: { default: flipRight, [REDUCE]: "none" }, animationDuration: "1.3s", animationDelay: "-0.5s", animationIterationCount: "infinite" },
  flash: { opacity: 0.15, animationName: { default: flash, [REDUCE]: "none" }, animationDuration: "0.8s", animationIterationCount: "infinite" },
  run: { animationName: { default: run, [REDUCE]: "none" }, animationDuration: "3.2s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  scrollFar: { animationName: { default: scroll, [REDUCE]: "none" }, animationDuration: "12s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  scrollNear: { animationName: { default: scroll, [REDUCE]: "none" }, animationDuration: "4s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  rush: { animationName: { default: rush, [REDUCE]: "none" }, animationDuration: "0.32s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  bump: { animationName: { default: bump, [REDUCE]: "none" }, animationDuration: "0.36s", animationIterationCount: "infinite" },
  race: { animationName: { default: race, [REDUCE]: "none" }, animationDuration: "5.5s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite" },
  lap: { animationName: { default: lap, [REDUCE]: "none" }, animationDuration: "6s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  // The TV's picture: clipped to the screen.
  screen: { overflow: "hidden" },
  /** When an animation starts (ms from now; negative when it started before this was drawn). */
  delay: (ms: number) => ({ animationDelay: `${Math.round(ms)}ms` }),
  paused: { animationPlayState: "paused" },
});

// ---------- A person out of their seat ----------

/** The figure's box around the face's centre, in drawing units. */
const FIG = { x: -30, y: -14, w: 60, h: 88 } as const;

const figure = stylex.create({
  root: {
    position: "absolute",
    overflow: "visible",
    pointerEvents: "none",
    transitionProperty: "transform",
    transitionDuration: durationVars["--duration-fast"],
    transitionTimingFunction: easeVars["--ease-move"],
  },
  box: (w: number, h: number, left: number, top: number) => ({ width: w, height: h, left, top }),
  flip: { transform: "scaleX(-1)" },
});

export interface FigureProps {
  pose: Pose;
  prop?: Prop;
  isStretch?: boolean;
  /** At a pinball machine: hands on the buttons. */
  isAtPinball?: boolean;
  /** A paddle's last stroke: its time (the animation restarts for each) and how long ago it was, in ms. */
  swing?: { at: number; since: number };
  /** The shirt, by person (as at their desk). */
  hue: number;
  look: 1 | -1;
  /** CSS px per drawing unit. */
  scale: number;
  isPaused: boolean;
}

/** An arm: a rounded bar from the shoulder to the hand. */
function Arm({ from, to, shirt }: { from: [number, number]; to: [number, number]; shirt: stylex.StyleXStyles }) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const deg = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
  return <rect x={from[0]} y={from[1] - 2.6} width={len} height={5.2} rx={2.6} transform={`rotate(${r1(deg)} ${from[0]} ${from[1]})`} {...stylex.props(shirt)} />;
}

/**
 * Someone standing, walking (legs in stride) or sitting (shoulders only, on
 * the chair or sofa drawn in the room), drawn under their face; it turns
 * with the way they walk. Placed around the face's centre.
 */
export function Figure({ pose, prop, isStretch, isAtPinball, swing, hue, look, scale, isPaused }: FigureProps) {
  const shirt = SHIRTS[hue % SHIRTS.length]!;
  const box = figure.box(FIG.w * scale, FIG.h * scale, FIG.x * scale, FIG.y * scale);
  if (pose === "sit") {
    return (
      <svg viewBox={`${FIG.x} ${FIG.y} ${FIG.w} ${FIG.h}`} aria-hidden="true" focusable="false" {...stylex.props(figure.root, box, look < 0 && figure.flip)}>
        <path d="M -19 46 C -20 22 -11 16 0 16 C 11 16 20 22 19 46 Z" {...stylex.props(shirt)} />
        <path d="M -7 18 L 0 26 L 7 18 Z" {...stylex.props(fill.collar)} />
        {prop === "cup" && <Cup x={11} y={30} />}
        {prop === "controller" && (
          // Both hands on a controller in the lap, thumbs busy.
          <>
            <Arm from={[-13, 30]} to={[-6, 40]} shirt={shirt} />
            <Arm from={[13, 30]} to={[6, 40]} shirt={shirt} />
            <rect x={-8} y={37.5} width={16} height={6} rx={3} {...stylex.props(fill.dark)} />
            <g {...stylex.props(anim.tap, isPaused && anim.paused)}>
              <circle cx={-4} cy={39.6} r={1.1} {...stylex.props(fill.consoleLight)} />
            </g>
            <g {...stylex.props(anim.tap, anim.tapOther, isPaused && anim.paused)}>
              <circle cx={4} cy={39.6} r={1.1} {...stylex.props(fill.neonPink)} />
            </g>
          </>
        )}
      </svg>
    );
  }
  const isWalking = pose === "walk";
  const legStyle = (other: boolean) => stylex.props(anim.leg, isWalking && anim.walking, isWalking && other && anim.stride, isPaused && anim.paused);
  // Standing, the face is drawn a little smaller (OfficeLife), so the shirt shows below it from about 26 units down; the feet are on the floor at STAND_Z.
  return (
    <svg viewBox={`${FIG.x} ${FIG.y} ${FIG.w} ${FIG.h}`} aria-hidden="true" focusable="false" {...stylex.props(figure.root, box, look < 0 && figure.flip)}>
      <g {...legStyle(false)}>
        <rect x={-7.4} y={47} width={6.6} height={21} rx={3.3} {...stylex.props(fill.trousers)} />
        <ellipse cx={-3.2} cy={68.6} rx={5} ry={2.5} {...stylex.props(fill.shoe)} />
      </g>
      <g {...legStyle(true)}>
        <rect x={0.8} y={47} width={6.6} height={21} rx={3.3} {...stylex.props(fill.trousers)} />
        <ellipse cx={5} cy={68.6} rx={5} ry={2.5} {...stylex.props(fill.shoe)} />
      </g>
      <path d="M -15 53 C -16 34 -10 22 0 22 C 10 22 16 34 15 53 Z" {...stylex.props(shirt)} />
      <path d="M -5.5 23 L 0 31 L 5.5 23 Z" {...stylex.props(fill.collar)} />
      {isStretch ? (
        <>
          <Arm from={[-12, 30]} to={[-30, -4]} shirt={shirt} />
          <Arm from={[12, 30]} to={[30, -4]} shirt={shirt} />
        </>
      ) : prop === "book" ? (
        <>
          <Arm from={[-12, 31]} to={[-5, 42]} shirt={shirt} />
          <Arm from={[12, 31]} to={[5, 42]} shirt={shirt} />
          <rect x={-10} y={33} width={20} height={14} rx={1.5} {...stylex.props(fill.b4)} />
          <rect x={-9} y={34} width={18} height={2.2} {...stylex.props(fill.white)} />
        </>
      ) : prop === "can" ? (
        <>
          <Arm from={[12, 31]} to={[18, 43]} shirt={shirt} />
          <rect x={14} y={39} width={11} height={10} rx={2} {...stylex.props(fill.tealR)} />
          <path d="M 24 42 L 31 35" {...stylex.props(fill.rod)} />
        </>
      ) : prop === "cup" ? (
        <>
          <Arm from={[12, 31]} to={[16, 43]} shirt={shirt} />
          <Cup x={14} y={38} />
        </>
      ) : prop === "paddle" ? (
        // Towards the table: red at one end, black at the other (as they lie on the table).
        <g key={swing?.at} {...stylex.props(anim.arm, swing && anim.stroke, swing && anim.delay(-swing.since), isPaused && anim.paused)}>
          <Arm from={[12, 31]} to={[20, 37]} shirt={shirt} />
          <line x1={21} y1={37} x2={24} y2={33.5} {...stylex.props(fill.rod)} />
          <ellipse cx={26.5} cy={29.5} rx={5} ry={5.6} {...stylex.props(look > 0 ? fill.paddleRed : fill.paddleBlack)} />
        </g>
      ) : isAtPinball ? (
        <>
          <g {...stylex.props(anim.tap, isPaused && anim.paused)}>
            <Arm from={[-12, 31]} to={[-17, 44]} shirt={shirt} />
          </g>
          <g {...stylex.props(anim.tap, anim.tapOther, isPaused && anim.paused)}>
            <Arm from={[12, 31]} to={[17, 44]} shirt={shirt} />
          </g>
        </>
      ) : null}
    </svg>
  );
}

/** A mug in someone's hand, in figure units. */
function Cup({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={7} height={8} rx={1.4} {...stylex.props(fill.white)} />
      <rect x={x} y={y + 2} width={7} height={2.2} {...stylex.props(fill.red)} />
      <path d={`M ${x + 7} ${y + 2} q 3 1.5 0 4`} {...stylex.props(fill.rod)} />
    </g>
  );
}

// ---------- What they use ----------

const props = stylex.create({
  root: { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" },
});

/** The cup that fills under the coffee machine while someone brews: it appears, coffee pours, steam rises. */
function Brew({ layout, t0, now, isPaused }: { layout: SceneLayout; t0: number; now: number; isPaused: boolean }) {
  const { cup } = layout.life;
  const spout = project(cup.x + 3, cup.y + 3, cup.z + 15);
  const lip = project(cup.x + 3, cup.y + 3, cup.z + 8);
  const steam = project(cup.x + 3, cup.y + 3, cup.z + 12);
  const since = now - t0;
  const held = isPaused && anim.paused;
  return (
    <g>
      <g {...stylex.props(anim.appear, anim.delay(-since), held)}>
        <Box x={cup.x} y={cup.y} z={cup.z} w={6} d={6} h={8} m={{ top: fill.white, left: fill.red, right: fill.red }} />
      </g>
      <line x1={r1(spout.x)} y1={r1(spout.y)} x2={r1(lip.x)} y2={r1(lip.y)} {...stylex.props(fill.coffee, anim.pour, anim.delay(300 - since), held)} />
      {[0, 1].map((i) => (
        <path
          key={i}
          d={`M ${r1(steam.x - 2 + i * 5)} ${r1(steam.y)} c -3 -5 3 -8 0 -13 c -3 -5 3 -8 0 -13`}
          {...stylex.props(fill.steam, anim.steam, anim.delay(1_600 + i * 700 - since), held)}
        />
      ))}
    </g>
  );
}

/** The ball in play on the foosball pitch. */
function Ball({ layout, isPaused }: { layout: SceneLayout; isPaused: boolean }) {
  const f = layout.life.foosball;
  const c = project(f.x + f.w / 2, f.y + f.d / 2, 26.6);
  return (
    <g transform={`translate(${r1(c.x)} ${r1(c.y)})`}>
      <circle r={2.4} {...stylex.props(fill.ball, anim.rally, isPaused && anim.paused)} />
    </g>
  );
}

/** Water falling from the can onto a plant. */
function Drops({ layout, plant, isPaused }: { layout: SceneLayout; plant: number; isPaused: boolean }) {
  const p = layout.plants[plant];
  if (!p) return null;
  const top = project(p.x, p.y, 16 * p.size + 20);
  return (
    <g transform={`translate(${r1(top.x)} ${r1(top.y)})`}>
      {[-4, 0, 4].map((dx, i) => (
        <ellipse key={dx} cx={dx} cy={i % 2 ? -3 : 0} rx={1.3} ry={2} {...stylex.props(fill.drop, anim.fall, anim.delay(-i * 270), isPaused && anim.paused)} />
      ))}
    </g>
  );
}

/**
 * The ping pong ball over a whole game: one Web Animation along the path
 * life.ts computes (from paddle to paddle, a bounce on the far half, past the
 * one who missed), caught up with the clock when shown, held while paused.
 */
function PingPongBall({ activity, layout, isPaused }: { activity: Activity; layout: SceneLayout; isPaused: boolean }) {
  const ref = useRef<SVGCircleElement>(null);
  const animation = useRef<Animation | undefined>(undefined);
  const { x, y, w, d } = layout.life.pingpong;
  const strokes = activity.strokes;

  useLayoutEffect(() => {
    const el = ref.current;
    const path = ballFrames({ strokes }, { x, y, w, d });
    if (!el || !path || typeof el.animate !== "function") return;
    const a = el.animate(path.frames, { duration: Math.max(1, path.end - path.start), fill: "both" });
    a.currentTime = Date.now() - path.start;
    animation.current = a;
    return () => {
      a.cancel();
      animation.current = undefined;
    };
  }, [strokes, x, y, w, d]);

  // A hidden tab holds the ball; back in view it catches up with the clock.
  useEffect(() => {
    const a = animation.current;
    const first = strokes?.[0]?.at;
    if (!a || first === undefined) return;
    if (isPaused) a.pause();
    else {
      a.currentTime = Date.now() - first;
      a.play();
    }
  }, [isPaused, strokes]);

  return <circle ref={ref} r={2} opacity={0} {...stylex.props(fill.pongBall)} />;
}

/** A pinball game on: the ball runs round the playfield, the flippers flick, the bumpers and the head's lights flash, the display glows. */
function PinballPlay({ layout, isPaused }: { layout: SceneLayout; isPaused: boolean }) {
  const m = layout.life.pinball;
  const held = isPaused && anim.paused;
  const at = (u: number, v: number, dz = 0.7) => playfieldPoint(m, u, v, dz);
  const centre = at(0.5, 0.5, 1.4);
  const flippers = [
    { from: at(0.18, 0.14), to: at(0.4, 0.07), s: [anim.pivotLeft, anim.flipLeft] },
    { from: at(0.82, 0.14), to: at(0.6, 0.07), s: [anim.pivotRight, anim.flipRight] },
  ];
  const bumpers = [
    [0.3, 0.74],
    [0.7, 0.74],
    [0.5, 0.56],
  ] as const;
  const head = (u: number, z: number) => project(m.x + 1 + u * (m.w - 2), m.y + 7, z);
  return (
    <g>
      {bumpers.map(([u, v], i) => {
        const c = at(u, v, 0.9);
        return <ellipse key={`${u}-${v}`} cx={r1(c.x)} cy={r1(c.y)} rx={3.4} ry={2.2} {...stylex.props(fill.white, anim.flash, anim.delay(-i * 270), held)} />;
      })}
      {[0.15, 0.38, 0.62, 0.85].map((u, i) => {
        const c = head(u, 62);
        return <circle key={u} cx={r1(c.x)} cy={r1(c.y)} r={1.3} {...stylex.props([fill.lightYellow, fill.lightRed, fill.lightGreen, fill.lightBlue][i]!, anim.flash, anim.delay(-i * 200), held)} />;
      })}
      <Poly points={[head(0.05, 40), head(0.95, 40), head(0.95, 47), head(0.05, 47)]} s={[fill.backglassArt, anim.flash, held]} />
      {flippers.map((f, i) => (
        <line key={i} x1={r1(f.from.x)} y1={r1(f.from.y)} x2={r1(f.to.x)} y2={r1(f.to.y)} {...stylex.props(fill.flipper, anim.flipper, ...f.s, held)} />
      ))}
      <g transform={`translate(${r1(centre.x)} ${r1(centre.y)})`}>
        <circle r={1.5} {...stylex.props(fill.steel, anim.run, held)} />
      </g>
    </g>
  );
}

/** The city's blocks, one screen wide (drawn twice, so the scroll loops): left, width, height above the street. */
const FAR_BLOCKS = [
  [0, 7, 9],
  [7, 5, 12],
  [12, 8, 7],
  [20, 6, 14],
  [26, 9, 9],
  [35, 5, 15],
  [40, 8, 8],
  [48, 6, 11],
  [54, 10, 13],
  [64, 8, 10],
] as const;
const NEAR_BLOCKS = [
  [1, 10, 9],
  [13, 8, 13],
  [23, 11, 7],
  [36, 7, 12],
  [45, 11, 8],
  [57, 6, 14],
  [64, 7, 10],
] as const;
/** Where the street starts, from the screen's top. */
const STREET = 28;

/** One copy of the near blocks, with their lit windows and a neon sign. */
function NearBlocks({ dx }: { dx: number }) {
  return (
    <g>
      {NEAR_BLOCKS.map(([x, w, h], i) => (
        <g key={x}>
          <rect x={dx + x} y={STREET - h} width={w} height={h} {...stylex.props(fill.cityNear)} />
          {Array.from({ length: Math.floor((h - 3) / 3) }, (_, row) =>
            Array.from({ length: Math.floor((w - 2) / 2.5) }, (_, col) =>
              (row * 3 + col + i) % 3 === 0 ? null : (
                <rect key={`${row}-${col}`} x={dx + x + 1.4 + col * 2.5} y={STREET - h + 2 + row * 3} width={1.1} height={1.3} {...stylex.props((row + col + i) % 4 ? fill.neonYellow : fill.neonTeal)} />
              ),
            ),
          )}
          {i === 2 && <rect x={dx + x + 2} y={STREET - h - 2.4} width={w - 4} height={1.6} rx={0.8} {...stylex.props(fill.neonPink)} />}
        </g>
      ))}
    </g>
  );
}

/** A car seen from the side, heading right: its wheels on `y`. */
function Car({ x, y, s }: { x: number; y: number; s: stylex.StyleXStyles }) {
  return (
    <g>
      <polygon points={`${x + 13},${y - 3.6} ${x + 21},${y - 5.4} ${x + 21},${y - 1.4} ${x + 13},${y - 2.6}`} {...stylex.props(fill.beam)} />
      <rect x={x - 5} y={y - 3.4} width={4} height={0.5} {...stylex.props(fill.glassShine)} />
      <rect x={x - 6} y={y - 2.2} width={4.5} height={0.5} {...stylex.props(fill.glassShine)} />
      <polygon points={`${x + 3},${y - 4} ${x + 5},${y - 6.4} ${x + 9.6},${y - 6.4} ${x + 11.4},${y - 4}`} {...stylex.props(fill.carGlass)} />
      <rect x={x} y={y - 4.4} width={13.4} height={3} rx={1.2} {...stylex.props(s)} />
      <rect x={x - 0.2} y={y - 3.8} width={1} height={1} {...stylex.props(fill.lightRed)} />
      <rect x={x + 12.6} y={y - 3.8} width={1} height={1} {...stylex.props(fill.neonYellow)} />
      <circle cx={x + 3.2} cy={y - 1.3} r={1.4} {...stylex.props(fill.dark)} />
      <circle cx={x + 10.4} cy={y - 1.3} r={1.4} {...stylex.props(fill.dark)} />
    </g>
  );
}

/**
 * The video game on the TV while people play: an open-world driving game of
 * our own (no real game, brand or look). A neon city at sunset scrolls by in
 * two layers, the lane dashes rush past under the player's car (a second car
 * races it when two play), and a mini-map in the corner shows the player's
 * dot going round the block. Drawn in the screen's own units, clipped to it.
 */
function GameScreen({ layout, isForTwo, isPaused }: { layout: SceneLayout; isForTwo: boolean; isPaused: boolean }) {
  const { w: W, h: H } = TV.screen;
  const held = isPaused && anim.paused;
  return (
    <g transform={screenTransform(layout.life.gaming)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} {...stylex.props(anim.screen)}>
        <rect width={W} height={11} {...stylex.props(fill.skyTop)} />
        <rect y={11} width={W} height={8} {...stylex.props(fill.skyMid)} />
        <rect y={19} width={W} height={STREET - 19} {...stylex.props(fill.skyLow)} />
        <circle cx={52} cy={14} r={7} {...stylex.props(fill.sun)} />
        {[15.5, 17.5, 19.3].map((y) => (
          <rect key={y} x={44} y={y} width={16} height={0.8} {...stylex.props(fill.skyMid)} />
        ))}
        <g {...stylex.props(anim.scrollFar, held)}>
          {[0, TILE].map((dx) => FAR_BLOCKS.map(([x, w, h]) => <rect key={`${dx}-${x}`} x={dx + x} y={STREET - h} width={w} height={h} {...stylex.props(fill.cityFar)} />))}
        </g>
        <g {...stylex.props(anim.scrollNear, held)}>
          <NearBlocks dx={0} />
          <NearBlocks dx={TILE} />
        </g>
        <rect y={STREET} width={W} height={H - STREET} {...stylex.props(fill.road)} />
        <rect y={STREET} width={W} height={0.9} {...stylex.props(fill.kerb)} />
        <g {...stylex.props(anim.rush, held)}>
          {Array.from({ length: Math.ceil(W / DASH) + 1 }, (_, i) => (
            <rect key={i} x={i * DASH} y={33.6} width={4.4} height={0.8} {...stylex.props(fill.lane)} />
          ))}
        </g>
        {isForTwo && (
          <g {...stylex.props(anim.race, held)}>
            <g {...stylex.props(anim.bump, anim.tapOther, held)}>
              <Car x={34} y={32.6} s={fill.carB} />
            </g>
          </g>
        )}
        <g {...stylex.props(anim.bump, held)}>
          <Car x={16} y={38.6} s={fill.carA} />
        </g>
        <rect x={2} y={2} width={13} height={9} rx={1} {...stylex.props(fill.mapBack)} />
        <path d="M 4 3 V 10 M 12 3 V 10 M 2.5 4.5 H 14.5 M 2.5 8.5 H 14.5" {...stylex.props(fill.mapRoad)} />
        <g transform="translate(4 4.5)">
          <circle r={1} {...stylex.props(fill.neonPink, anim.lap, held)} />
        </g>
      </svg>
    </g>
  );
}

export interface LifePropsProps {
  layout: SceneLayout;
  activities: Activity[];
  now: number;
  isPaused: boolean;
}

/** The props of what people do, over the room and under the people. */
export function LifeProps({ layout, activities, now, isPaused }: LifePropsProps) {
  const isOn = (a: Activity, kind: Activity["kind"]) => a.kind === kind && a.together !== undefined && now >= a.together.t0 && now < a.together.t1;
  const brewing = activities.filter((a) => a.brew && now >= a.brew.t0 && now < a.brew.t1);
  const playing = activities.some((a) => isOn(a, "foosball"));
  const rallies = activities.filter((a) => isOn(a, "pingpong"));
  const pinball = activities.some((a) => isOn(a, "pinball"));
  const gaming = activities.find((a) => isOn(a, "gaming"));
  const watering = activities.filter((a) => a.water && now >= a.water.t0 && now < a.water.t1);
  if (!brewing.length && !playing && !rallies.length && !pinball && !gaming && !watering.length) return null;
  const { view } = layout;
  return (
    <svg viewBox={`${r1(view.x)} ${r1(view.y)} ${r1(view.width)} ${r1(view.height)}`} aria-hidden="true" focusable="false" {...stylex.props(props.root)}>
      {brewing.map((a) => (
        <Brew key={a.id} layout={layout} t0={a.brew!.t0} now={now} isPaused={isPaused} />
      ))}
      {playing && <Ball layout={layout} isPaused={isPaused} />}
      {rallies.map((a) => (
        <PingPongBall key={a.id} activity={a} layout={layout} isPaused={isPaused} />
      ))}
      {pinball && <PinballPlay layout={layout} isPaused={isPaused} />}
      {gaming && <GameScreen layout={layout} isForTwo={gaming.people.length > 1} isPaused={isPaused} />}
      {watering.map((a) => (
        <Drops key={a.id} layout={layout} plant={a.water!.plant} isPaused={isPaused} />
      ))}
    </svg>
  );
}


/** Where a game table's score is shown: on the floor in front of the table, clear of both players. */
export const tableFront = (table: SceneLayout["life"]["foosball"]) => project(table.x + table.w / 2 + 10, table.y + table.d + 22, 0);

/** Where a pinball game's score is shown: on the machine's back glass, like its own display (under the talk bubbles above the faces). */
export const pinballDisplay = (layout: SceneLayout) => {
  const m = layout.life.pinball;
  return project(m.x + m.w / 2, m.y + 7, 52);
};

/** Where a video game's cash or race score is shown: just over the TV, clear of its picture. */
export const tvDisplay = (layout: SceneLayout) => {
  const s = tvScreen(layout.life.gaming);
  return project(s.x, s.y - TV.screen.w * 0.2, s.z + 16);
};
