import { StackItem } from "@astryxdesign/core/Stack";
import { durationVars, easeVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Face, hueOf } from "./Face";
import { FACE_Z, STAND_Z, type SceneLayout, project, toPercent } from "./layout";
import { type Activity, type Track, legAt, nextChange, sayingAt, scoreAt, trackFrames } from "./life";
import { Figure, LifeProps, foosballFront } from "./LifeArt";
import { type OfficePerson, personSummary } from "./model";
import { Tag } from "./Tags";
import type { OfficeLife as Life } from "./useOfficeLife";

const bob = stylex.keyframes({
  "0%": { transform: "translateY(0)" },
  "50%": { transform: `translateY(calc(-1 * ${spacingVars["--spacing-0-5"]}))` },
  "100%": { transform: "translateY(0)" },
});
const pop = stylex.keyframes({
  "0%": { opacity: 0, transform: `translateY(${spacingVars["--spacing-1"]}) scale(0.92)` },
  "100%": { opacity: 1, transform: "translateY(0) scale(1)" },
});
const fade = stylex.keyframes({
  "0%": { opacity: 1 },
  "100%": { opacity: 0 },
});

/** The face's size while standing, against its size seated. */
const UP_SCALE = 0.84;

const styles = stylex.create({
  // A layer the size of the picture; the Web Animation moves it, so the person's face (at its top-left corner) follows the path.
  layer: { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", willChange: "transform" },
  z: (z: number) => ({ zIndex: z }),
  origin: { position: "absolute", left: 0, top: 0, width: 0, height: 0 },
  // Two small steps a stride while walking.
  bobbing: { animationName: bob, animationDuration: "0.42s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite" },
  paused: { animationPlayState: "paused" },
  face: {
    position: "absolute",
    left: 0,
    top: 0,
    pointerEvents: "auto",
    transform: "translate(-50%, -50%)",
    transitionProperty: "transform",
    transitionDuration: durationVars["--duration-fast"],
    transitionTimingFunction: easeVars["--ease-move"],
  },
  // Standing up, the face is a little smaller so the body shows under it; walking, it leans into the walk.
  up: { transform: `translate(-50%, -50%) scale(${UP_SCALE})` },
  leanRight: { transform: `translate(-50%, -50%) rotate(4deg) scale(${UP_SCALE})` },
  leanLeft: { transform: `translate(-50%, -50%) rotate(-4deg) scale(${UP_SCALE})` },
  below: { position: "absolute", left: 0, top: spacingVars["--spacing-8"], transform: "translateX(-50%)", whiteSpace: "nowrap" },
  // Standing, the name goes under the feet (px below the face's centre).
  belowFeet: (top: number) => ({ top }),
  say: { position: "absolute", left: 0, transform: "translateX(-50%)", whiteSpace: "nowrap" },
  sayAt: (bottom: number) => ({ bottom }),
  pop: {
    transformOrigin: "50% 100%",
    animationName: pop,
    animationDuration: durationVars["--duration-fast"],
    animationTimingFunction: easeVars["--ease-entrance"],
    animationFillMode: "both",
  },
  fadeOut: { animationName: fade, animationDuration: durationVars["--duration-fast"], animationTimingFunction: easeVars["--ease-exit"], animationFillMode: "forwards" },
  delay: (ms: number) => ({ animationDelay: `${Math.round(ms)}ms` }),
  anchor: { position: "absolute", width: 0, height: 0 },
  at: (left: string, top: string) => ({ left, top }),
  centred: { position: "absolute", left: 0, top: 0, transform: "translate(-50%, -50%)", whiteSpace: "nowrap" },
});

/** Redraws at the next moment something changes (a leg ends, a line is said, a goal), never per frame; holds while paused. */
function useLifeClock(activities: Activity[], isPaused: boolean): number {
  const [, setTick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (isPaused) return;
    const next = nextChange(activities, now);
    if (next === undefined) return;
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(16, next - Date.now() + 5));
    return () => clearTimeout(timer);
  });
  return now;
}

/** A short line over someone's head: it pops in and fades out as it ends. */
function SayBubble({ text, bottom, endsIn, isPaused }: { text: string; bottom: number; endsIn: number; isPaused: boolean }) {
  return (
    <StackItem xstyle={[styles.say, styles.sayAt(bottom)]} aria-hidden>
      <StackItem xstyle={[styles.pop, isPaused && styles.paused]}>
        <StackItem xstyle={[styles.fadeOut, styles.delay(Math.max(0, endsIn - 200)), isPaused && styles.paused]}>
          <Tag text={text} />
        </StackItem>
      </StackItem>
    </StackItem>
  );
}

interface WalkerProps {
  person: OfficePerson;
  track: Track;
  layout: SceneLayout;
  scale: number;
  isCompact: boolean;
  now: number;
  isPaused: boolean;
  /** Their outing, in words, for the face's name ("… Making coffee."). */
  note: string | undefined;
  onOpen: (id: string) => void;
}

/**
 * Someone out of their seat. One Web Animation moves a picture-sized layer
 * along their track (transform only, on the compositor); React redraws only
 * when the leg changes (walking, standing, sitting, what they hold, which way
 * they look). The face stays a button that opens their drawer.
 */
function Walker({ person, track, layout, scale, isCompact, now, isPaused, note, onOpen }: WalkerProps) {
  const layerRef = useRef<HTMLElement>(null);
  const animation = useRef<Animation | undefined>(undefined);
  const { x, y, width, height } = layout.view;

  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el || typeof el.animate !== "function") return;
    const a = el.animate(trackFrames(track, { x, y, width, height }), { duration: Math.max(1, track.end - track.start), fill: "both" });
    a.currentTime = Date.now() - track.start;
    animation.current = a;
    return () => {
      a.cancel();
      animation.current = undefined;
    };
  }, [track, x, y, width, height]);

  // A hidden tab holds the walk; back in view it catches up with the clock.
  useEffect(() => {
    const a = animation.current;
    if (!a) return;
    if (isPaused) a.pause();
    else {
      a.currentTime = Date.now() - track.start;
      a.play();
    }
  }, [isPaused, track]);

  const leg = legAt(track, now);
  const pose = leg?.pose ?? "sit";
  const look = leg?.look ?? 1;
  const say = sayingAt(track, now);
  const isSeatedAtTable = track.home.startsWith("meeting") && leg === track.legs.at(-1) && pose === "sit";
  const size = isSeatedAtTable ? (isCompact ? 32 : 40) : isCompact ? 40 : 48;
  // In front of what they pass: ordered like the seated faces, by the floor point nearest the viewer.
  const depth = leg ? Math.max(project(leg.from.x, leg.from.y, FACE_Z).y, project(leg.to.x, leg.to.y, FACE_Z).y) : 0;
  const label = `${personSummary(person)}${note ? ` ${note}.` : ""} Open details.`;
  const isUp = pose !== "sit";
  // The face's half-height with its ring, as drawn now.
  const faceHalf = ((size + 8) / 2) * (isUp ? UP_SCALE : 1);
  return (
    <StackItem ref={layerRef} xstyle={[styles.layer, styles.z(Math.round(depth + 1000))]} data-walker={person.id}>
      <StackItem xstyle={[styles.origin, pose === "walk" && styles.bobbing, isPaused && styles.paused]}>
        <Figure pose={pose} prop={leg?.prop} isStretch={leg?.isStretch} hue={hueOf(person.avatar)} look={look} scale={scale} isPaused={isPaused} />
        <StackItem xstyle={[styles.face, pose === "stand" && styles.up, pose === "walk" && (look > 0 ? styles.leanRight : styles.leanLeft)]}>
          <Face seed={person.avatar} name={person.name} state={person.state} size={size} label={label} onClick={() => onOpen(person.id)} />
        </StackItem>
        <StackItem xstyle={[styles.below, isUp && styles.belowFeet(Math.round((STAND_Z + 3) * scale))]}>
          <Tag text={person.name} />
        </StackItem>
        {say && <SayBubble key={say.t0} text={say.text} bottom={Math.round(faceHalf + 6)} endsIn={say.t1 - now} isPaused={isPaused} />}
      </StackItem>
    </StackItem>
  );
}

/** The foosball score, on the floor in front of the table while a game is on. */
function Score({ activity, layout, now }: { activity: Activity; layout: SceneLayout; now: number }) {
  const [a, b] = scoreAt(activity, now);
  const pos = toPercent(layout.view, foosballFront(layout));
  return (
    <StackItem xstyle={[styles.anchor, styles.at(pos.left, pos.top), styles.z(990)]}>
      <StackItem xstyle={styles.centred}>
        <Tag text={`⚽ ${a} – ${b}`} />
      </StackItem>
    </StackItem>
  );
}

export interface OfficeLifeProps {
  life: Life;
  layout: SceneLayout;
  people: Map<string, OfficePerson>;
  /** CSS px per drawing unit. */
  scale: number;
  isCompact: boolean;
  onOpen: (id: string) => void;
}

/** Everyone out of their seat, and the props of what they do, over the room. */
export function OfficeLife({ life, layout, people, scale, isCompact, onOpen }: OfficeLifeProps) {
  const now = useLifeClock(life.activities, life.isPaused);
  const games = life.activities.filter((a) => a.kind === "foosball" && a.together && now >= a.together.t0 && now < a.together.t1 + 2_000);
  return (
    <>
      <LifeProps layout={layout} activities={life.activities} now={now} isPaused={life.isPaused} />
      {games.map((g) => (
        <Score key={g.id} activity={g} layout={layout} now={now} />
      ))}
      {[...life.parts.values()].map(({ track }) => {
        const person = people.get(track.personId);
        if (!person) return null;
        return (
          <Walker
            key={person.id}
            person={person}
            track={track}
            layout={layout}
            scale={scale}
            isCompact={isCompact}
            now={now}
            isPaused={life.isPaused}
            note={life.noteOf(person.id, now)?.text}
            onOpen={onOpen}
          />
        );
      })}
    </>
  );
}
