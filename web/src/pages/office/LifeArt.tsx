/**
 * The moving parts of the office, drawn like the room (OfficeArt.tsx, whose
 * helpers and token colours this reuses): a person out of their seat (legs,
 * shirt, arms and what they carry) and the props of what they do (a cup
 * brewing under the coffee machine, the foosball, water for a plant).
 *
 * Motion is transform and opacity only, in CSS keyframes, so it runs on the
 * compositor; `isPaused` (a hidden tab) holds it. The scene leaves all of
 * this out under prefers-reduced-motion. Decorative: aria-hidden.
 */
import { durationVars, easeVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { type SceneLayout, project } from "./layout";
import type { Activity, Pose, Prop } from "./life";
import { Box, SHIRTS, fill, r1 } from "./OfficeArt";

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
export function Figure({ pose, prop, isStretch, hue, look, scale, isPaused }: FigureProps) {
  const shirt = SHIRTS[hue % SHIRTS.length]!;
  const box = figure.box(FIG.w * scale, FIG.h * scale, FIG.x * scale, FIG.y * scale);
  if (pose === "sit") {
    return (
      <svg viewBox={`${FIG.x} ${FIG.y} ${FIG.w} ${FIG.h}`} aria-hidden="true" focusable="false" {...stylex.props(figure.root, box, look < 0 && figure.flip)}>
        <path d="M -19 46 C -20 22 -11 16 0 16 C 11 16 20 22 19 46 Z" {...stylex.props(shirt)} />
        <path d="M -7 18 L 0 26 L 7 18 Z" {...stylex.props(fill.collar)} />
        {prop === "cup" && <Cup x={11} y={30} />}
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

export interface LifePropsProps {
  layout: SceneLayout;
  activities: Activity[];
  now: number;
  isPaused: boolean;
}

/** The props of what people do, over the room and under the people. */
export function LifeProps({ layout, activities, now, isPaused }: LifePropsProps) {
  const brewing = activities.filter((a) => a.brew && now >= a.brew.t0 && now < a.brew.t1);
  const playing = activities.some((a) => a.kind === "foosball" && a.together && now >= a.together.t0 && now < a.together.t1);
  const watering = activities.filter((a) => a.water && now >= a.water.t0 && now < a.water.t1);
  if (!brewing.length && !playing && !watering.length) return null;
  const { view } = layout;
  return (
    <svg viewBox={`${r1(view.x)} ${r1(view.y)} ${r1(view.width)} ${r1(view.height)}`} aria-hidden="true" focusable="false" {...stylex.props(props.root)}>
      {brewing.map((a) => (
        <Brew key={a.id} layout={layout} t0={a.brew!.t0} now={now} isPaused={isPaused} />
      ))}
      {playing && <Ball layout={layout} isPaused={isPaused} />}
      {watering.map((a) => (
        <Drops key={a.id} layout={layout} plant={a.water!.plant} isPaused={isPaused} />
      ))}
    </svg>
  );
}

/** Where the foosball score is shown: on the floor in front of the table, clear of both players. */
export const foosballFront = (layout: SceneLayout) => {
  const f = layout.life.foosball;
  return project(f.x + f.w / 2 + 10, f.y + f.d + 22, 0);
};
