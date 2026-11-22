/**
 * Office life: what free agents do between tasks. Every now and then one or
 * two of them get up and make coffee (alone, or one makes two and they sit at
 * the kitchen table), chat at the kitchen table or on the sofa, play foosball
 * or ping pong, play pinball (a friend may watch), read at the Skills
 * library, water a plant, stretch or look out of the window, then come back
 * to their desk.
 *
 * Purely presentational and derived on the client from the office's state:
 * the server model never changes. Deterministic: time is cut into slots, and
 * each slot's plan (when something may start, how many people, what they
 * do) and who takes part come from seeds made of the slot number and the
 * people's ids, so everyone who opens the office sees the same thing.
 *
 * `advance` is the director, a pure step from one moment to the next: it
 * starts what the plan says when there is room (never more than MAX_AWAY
 * people away, only free people at their desks, a rest between outings),
 * ends what is over, and when someone away gets work (or their seat moves,
 * e.g. to a meeting) they walk back there at once with a "back to work"
 * bubble; a partner goes back too. Someone seated whose place changes (a
 * meeting starts or ends) walks there instead of jumping.
 *
 * Each person's part is a Track: timed legs (stand up, walk a straight
 * stretch, stay, sit down) through the waypoints (paths.ts), plus the words
 * in their bubble. The scene animates a track with one Web Animation; this
 * file only does the arithmetic. The games keep their own: a foosball or ping
 * pong game's points (and a ping pong rally's every stroke, so the ball flies
 * from paddle to paddle), a pinball game's score. A chat, a coffee for two, a
 * game for two and pinball with a friend watching have a window when everyone
 * is there (`together`): real talk (talk.ts) fills it when the AI answers.
 */
import { type Floor, type GameTable, type LifeSpot, PINGPONG, SEAT_Z, type SceneLayout, STAND_Z, deskSeat, lookFrom, meetingSeat, project, seatsAround } from "./layout";
import type { OfficeView } from "./model";
import { route } from "./paths";

/** One slot of the plan: at most one outing for two and one for one. */
export const SLOT_MS = 30_000;
/** Never more people away from their seats than this (walking back included). */
export const MAX_AWAY = 3;
/** After an outing, a person stays at their desk at least this long. */
export const REST_MS = 25_000;
/** A newly opened office replays this much of the plan, so outings already under way show. */
export const LOOKBACK_MS = 120_000;
/** Walking pace, in world units per ms. */
export const WALK = 0.07;
/** Standing up or sitting down. */
export const RISE_MS = 320;
/** After a longer gap than this (a hidden tab), seat changes are not walked: they happened long ago. */
const STALE_MS = 15_000;

/** Between people leaving their seats for a meeting (or leaving it). */
const COMMUTE_STAGGER_MS = 260;
const BREW_MS = 5_000;
const SIP_MS = 7_000;
const LINE_MS = 2_600;
const SAY_MS = 2_000;
/** One crossing of the ping pong table, from one paddle to the other. */
export const STROKE_MS = 760;
/** After a point, the ball flies past the one who missed and drops this long. */
export const MISS_MS = 520;
/** From a point to the next serve. */
const SERVE_MS = 1_500;
/** The end of a game: the winner's (or the high score's) moment, before they walk back. */
const CHEER_MS = 2_400;
/** A shout during a game ("point!", "jackpot!"). */
const SHOUT_MS = 1_600;

export type ActivityKind = "coffee" | "chat" | "foosball" | "pingpong" | "pinball" | "read" | "water" | "stretch" | "window" | "return" | "commute";
export type Pose = "sit" | "stand" | "walk";
export type Prop = "cup" | "book" | "can" | "paddle";

/** A floor point and the height of the face above it. */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface Leg {
  t0: number;
  t1: number;
  from: P3;
  to: P3;
  pose: Pose;
  /** Which way they look on screen: 1 right, -1 left. */
  look: 1 | -1;
  prop?: Prop;
  isStretch?: boolean;
  /** At the pinball machine, hands on the flipper buttons. */
  isAtPinball?: boolean;
}

export interface Say {
  t0: number;
  t1: number;
  text: string;
  /** A line of real talk (talk.ts), not a canned one: its bubble wraps. */
  isTalk?: boolean;
}

export interface Track {
  personId: string;
  legs: Leg[];
  says: Say[];
  start: number;
  end: number;
  /** The seat it ends at (Home.key). */
  home: string;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  people: string[];
  start: number;
  end: number;
  tracks: Track[];
  /** What it holds while it lasts, so no one else uses it: "coffee", "cafe", "sofa", "foosball", "pingpong", "pinball", "shelf", "window:1", "plant:2". */
  venues: string[];
  /** A chat, a coffee for two or a game: when everyone is there (and the game is on). */
  together?: { t0: number; t1: number };
  /** Coffee: when the cup (two cups, for two) brews at the machine. */
  brew?: { t0: number; t1: number };
  /** Watering: which plant, and when. */
  water?: { t0: number; t1: number; plant: number };
  /** Foosball and ping pong: each goal or point, and who scored it (an index into `people`). */
  goals?: { at: number; by: number }[];
  /** Ping pong: each stroke, rally by rally: who hit the ball, and where across the table (-1 to 1). */
  strokes?: { at: number; by: number; v: number }[];
  /** Pinball: what the ball scores, now and then. */
  bumps?: { at: number; points: number }[];
  /** A walk back: true when the person got work (else their outing was cut short). */
  gotWork?: boolean;
}

/** Where a person belongs right now: their desk, or their chair at a meeting. */
export interface Home {
  key: string;
  spot: LifeSpot;
  atDesk: boolean;
}

/** A person as life sees them. */
export interface LifePerson {
  id: string;
  name: string;
  isFree: boolean;
  home: Home;
}

export interface LifeState {
  /** The plan is done up to this time. */
  t: number;
  activities: Activity[];
  /** When each person may go out again. */
  rest: Record<string, number>;
  /** Where each person belonged at the last step. */
  homes: Record<string, Home>;
}

// ---------- Seeds ----------

/** FNV-1a: a stable 32-bit number from a string. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Mulberry32: a small seeded random generator, numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

// ---------- The plan ----------

/** A moment when an outing may start: for one person or two. */
export interface Proposal {
  at: number;
  slot: number;
  size: 1 | 2;
  seed: number;
}

/** A slot's plan: maybe an outing for two early on, maybe one for one later. */
export function slotPlan(slot: number): Proposal[] {
  const r = seeded(hash(`office-life:${slot}`));
  const base = slot * SLOT_MS;
  const out: Proposal[] = [];
  const pair = r() < 0.6;
  const pairAt = base + 1_000 + Math.floor(r() * 9_000);
  const solo = r() < 0.75;
  const soloAt = base + 13_000 + Math.floor(r() * 15_000);
  if (pair) out.push({ at: pairAt, slot, size: 2, seed: hash(`pair:${slot}`) });
  if (solo) out.push({ at: soloAt, slot, size: 1, seed: hash(`solo:${slot}`) });
  return out;
}

/** The plan's moments in (from, to], in order. */
export function proposalsBetween(from: number, to: number): Proposal[] {
  const out: Proposal[] = [];
  for (let s = Math.floor(from / SLOT_MS); s <= Math.floor(to / SLOT_MS); s++) {
    for (const p of slotPlan(s)) if (p.at > from && p.at <= to) out.push(p);
  }
  return out;
}

// ---------- People ----------

/** Who is in the office and where they belong, from the office's state and its layout. */
export function lifePeople(view: Pick<OfficeView, "people">, layout: SceneLayout): LifePerson[] {
  const desks = new Map(layout.desks.flatMap((d) => (d.personId ? [[d.personId, d] as const] : [])));
  const byId = new Map(view.people.map((p) => [p.id, p]));
  return layout.placements.flatMap((pl): LifePerson[] => {
    const person = byId.get(pl.personId);
    if (!person) return [];
    const isFree = person.state === "free";
    if (pl.where === "meeting" && pl.spot !== undefined) {
      const key = `meeting:${pl.spot}:${Math.round(pl.chair.x)}:${Math.round(pl.chair.y)}`;
      return [{ id: person.id, name: person.name, isFree, home: { key, spot: meetingSeat(layout.spots[pl.spot]!, pl.chair), atDesk: false } }];
    }
    const desk = desks.get(pl.personId);
    return desk ? [{ id: person.id, name: person.name, isFree, home: { key: `desk:${desk.key}:${desk.chair.x}:${desk.chair.y}`, spot: deskSeat(desk), atDesk: true } }] : [];
  });
}

// ---------- Tracks ----------

const at3 = (s: LifeSpot): P3 => ({ x: s.at.x, y: s.at.y, z: s.z });
const floor = (p: P3): Floor => ({ x: p.x, y: p.y });

/** Builds one person's track, leg by leg, from a start time and place. */
class Steps {
  legs: Leg[] = [];
  says: Say[] = [];
  constructor(
    readonly personId: string,
    public t: number,
    public at: P3,
    public look: 1 | -1,
  ) {}

  private push(to: P3, ms: number, pose: Pose, extra: Partial<Leg>) {
    this.legs.push({ t0: this.t, t1: this.t + ms, from: this.at, to, pose, look: this.look, ...extra });
    this.t += ms;
    this.at = to;
  }

  /** Up from a chair (no-op when already standing). */
  rise(extra: Partial<Leg> = {}) {
    if (this.at.z < STAND_Z - 0.5) this.push({ ...this.at, z: STAND_Z }, RISE_MS, "stand", extra);
  }

  sit(spot: LifeSpot, extra: Partial<Leg> = {}) {
    this.look = spot.look;
    if (spot.pose === "sit") this.push(at3(spot), RISE_MS, "sit", extra);
  }

  /** Walk through these points, one straight leg each. */
  walk(points: Floor[], extra: Partial<Leg> = {}) {
    for (const p of points) {
      const d = Math.hypot(p.x - this.at.x, p.y - this.at.y);
      if (d < 0.5) continue;
      this.look = lookFrom(this.at, p);
      this.push({ x: p.x, y: p.y, z: STAND_Z }, d / WALK, "walk", extra);
    }
  }

  /** Walk to a spot through the waypoints, leaving the current place by `via` (its door). */
  goTo(layout: SceneLayout, spot: LifeSpot, via: Floor | undefined, extra: Partial<Leg> = {}) {
    const start = via ?? floor(this.at);
    this.walk([...(via ? [via] : []), ...route(layout, start, spot.door).slice(1), spot.at], extra);
    this.look = spot.look;
  }

  stay(ms: number, extra: Partial<Leg> = {}) {
    if (ms > 0) this.push(this.at, ms, this.at.z < STAND_Z - 0.5 ? "sit" : "stand", extra);
  }

  until(t: number, extra: Partial<Leg> = {}) {
    this.stay(t - this.t, extra);
  }

  say(text: string, ms = SAY_MS, at = this.t) {
    this.says.push({ t0: at, t1: at + ms, text });
  }

  track(home: string): Track {
    return { personId: this.personId, legs: this.legs, says: this.says, start: this.legs[0]?.t0 ?? this.t, end: this.t, home };
  }
}

const startFrom = (p: LifePerson, t: number) => new Steps(p.id, t, at3(p.home.spot), p.home.spot.look);

/** Up from the desk, out to `spot`, …, and back: the common shape of a solo outing. */
function outing(p: LifePerson, start: number, layout: SceneLayout, spot: LifeSpot, stayMs: number, extra: Partial<Leg>, words: string): Steps {
  const s = startFrom(p, start);
  s.rise();
  s.goTo(layout, spot, p.home.spot.door);
  s.say(words, SAY_MS, s.t + 300);
  s.stay(stayMs, extra);
  s.goTo(layout, p.home.spot, spot.door);
  s.sit(p.home.spot);
  return s;
}

function activity(id: string, kind: ActivityKind, steps: { s: Steps; home: string }[], venues: string[], more: Partial<Activity> = {}): Activity {
  const tracks = steps.map(({ s, home }) => s.track(home));
  return {
    id,
    kind,
    people: tracks.map((t) => t.personId),
    start: Math.min(...tracks.map((t) => t.start)),
    end: Math.max(...tracks.map((t) => t.end)),
    tracks,
    venues,
    ...more,
  };
}

function coffee(id: string, p: LifePerson, start: number, layout: SceneLayout, cafeSeat: LifeSpot | undefined): Activity {
  const { coffee: machine } = layout.life;
  const s = startFrom(p, start);
  s.rise();
  s.goTo(layout, machine, p.home.spot.door);
  const brew = { t0: s.t, t1: s.t + BREW_MS };
  s.say("☕", SAY_MS, s.t + 200);
  s.stay(BREW_MS);
  const cup = { prop: "cup" as const };
  if (cafeSeat) {
    s.goTo(layout, cafeSeat, machine.door, cup);
    s.sit(cafeSeat, cup);
    s.say("😌", SAY_MS, s.t + 2_000);
    s.stay(SIP_MS, cup);
    s.rise(cup);
    s.goTo(layout, p.home.spot, cafeSeat.door, cup);
  } else {
    s.goTo(layout, p.home.spot, machine.door, cup);
  }
  s.sit(p.home.spot, cup);
  return activity(id, "coffee", [{ s, home: p.home.key }], cafeSeat ? ["coffee", "cafe"] : ["coffee"], { brew });
}

const OPENERS = ["hey 👋", "☕?", "😄", "lunch?", "how's it going?"] as const;
const REPLIES = ["👍", "nice!", "haha", "😂", "🙌", "sure!", "agreed", "🍕?", "✨", "same!", "😄", "☕"] as const;

/** Two people sit down together (kitchen table or sofa) and trade a few short lines. */
function chat(id: string, a: LifePerson, b: LifePerson, start: number, layout: SceneLayout, seats: LifeSpot[], venue: string, r: () => number): Activity {
  const sa = startFrom(a, start);
  const sb = startFrom(b, start);
  // The second one gets up a moment later: nobody moves in unison.
  sb.stay(700 + Math.floor(r() * 1_400));
  for (const [s, p, seat] of [
    [sa, a, seats[0]!],
    [sb, b, seats[1]!],
  ] as const) {
    s.rise();
    s.goTo(layout, seat, p.home.spot.door);
    s.sit(seat);
  }
  const t0 = Math.max(sa.t, sb.t) + 600;
  // Long enough for a real conversation (talk.ts) when the AI answers; canned lines meanwhile.
  const lines = 7 + Math.floor(r() * 3);
  for (let i = 0; i < lines; i++) (i % 2 ? sb : sa).say(i === 0 ? pick(r, OPENERS) : pick(r, REPLIES), SAY_MS, t0 + i * LINE_MS);
  const t1 = t0 + lines * LINE_MS;
  sa.until(t1);
  sb.until(t1 + 500);
  for (const [s, p, seat] of [
    [sa, a, seats[0]!],
    [sb, b, seats[1]!],
  ] as const) {
    s.rise();
    s.goTo(layout, p.home.spot, seat.door);
    s.sit(p.home.spot);
  }
  return activity(id, "chat", [{ s: sa, home: a.home.key }, { s: sb, home: b.home.key }], [venue], { together: { t0, t1 } });
}

/** Walks two players to a game table's ends, one a moment after the other (with what they carry: a paddle). */
function toTheEnds(a: LifePerson, b: LifePerson, start: number, layout: SceneLayout, ends: [LifeSpot, LifeSpot], r: () => number, extra: Partial<Leg> = {}): [Steps, Steps] {
  const sa = startFrom(a, start);
  const sb = startFrom(b, start);
  sb.stay(600 + Math.floor(r() * 1_200));
  [a, b].forEach((p, i) => {
    const s = i ? sb : sa;
    s.rise(extra);
    s.goTo(layout, ends[i]!, p.home.spot.door, extra);
  });
  return [sa, sb];
}

/** Two people play a game of foosball: goals now and then, a winner at the end. */
function foosball(id: string, a: LifePerson, b: LifePerson, start: number, layout: SceneLayout, r: () => number): Activity {
  const ends = layout.life.foosball.ends;
  const steps = toTheEnds(a, b, start, layout, ends, r);
  const [sa, sb] = steps;
  const t0 = Math.max(sa.t, sb.t) + 500;
  const t1 = t0 + 18_000 + Math.floor(r() * 7_000);
  const goals: { at: number; by: number }[] = [];
  for (let t = t0 + 2_500 + r() * 2_500; t < t1 - 1_500; t += 2_800 + r() * 3_400) {
    const by = r() < 0.5 ? 0 : 1;
    goals.push({ at: Math.round(t), by });
    steps[by]!.say(pick(r, ["⚽", "goal!", "😄", "yes!"]), 1_600, Math.round(t));
  }
  const score = [0, 1].map((i) => goals.filter((g) => g.by === i).length);
  const winner = score[0]! === score[1]! ? -1 : score[0]! > score[1]! ? 0 : 1;
  steps.forEach((s, i) => {
    s.say(winner === -1 ? "gg!" : winner === i ? "🏆" : "gg!", 2_200, t1);
    s.until(t1 + 2_400 + i * 500);
  });
  [a, b].forEach((p, i) => {
    steps[i]!.goTo(layout, p.home.spot, ends[i]!.door);
    steps[i]!.sit(p.home.spot);
  });
  return activity(id, "foosball", [{ s: sa, home: a.home.key }, { s: sb, home: b.home.key }], ["foosball"], { together: { t0, t1 }, goals });
}

/**
 * Two people play ping pong. Rallies of 2 to 8 strokes, each crossing the
 * table in STROKE_MS; the last one to hit the ball wins the point (the other
 * misses it), the serve changes every two points, a pause between rallies,
 * the score on the floor and a winner at the end. Each carries a paddle for
 * the whole outing (the table's own pair is not drawn meanwhile).
 */
function pingpong(id: string, a: LifePerson, b: LifePerson, start: number, layout: SceneLayout, r: () => number): Activity {
  const table = layout.life.pingpong;
  const paddle = { prop: "paddle" as const };
  const steps = toTheEnds(a, b, start, layout, table.ends, r, paddle);
  const t0 = Math.max(steps[0].t, steps[1].t) + 500;
  const t1 = t0 + 22_000 + Math.floor(r() * 8_000);
  const strokes: { at: number; by: number; v: number }[] = [];
  const goals: { at: number; by: number }[] = [];
  for (let t = t0 + 900; ; ) {
    const server = Math.floor(goals.length / 2) % 2;
    const length = 2 + Math.floor(r() * 7);
    const point = t + length * STROKE_MS;
    // The point and its cheer are over before the game ends (the winner's moment is its own).
    if (point + Math.max(MISS_MS, SHOUT_MS) > t1) break;
    for (let i = 0; i < length; i++) strokes.push({ at: t + i * STROKE_MS, by: (server + i) % 2, v: Math.round((r() * 1.2 - 0.6) * 100) / 100 });
    const by = (server + length - 1) % 2;
    goals.push({ at: point, by });
    steps[by]!.say(pick(r, ["🏓", "yes!", "nice!", "point!"]), SHOUT_MS, point);
    t = point + SERVE_MS;
  }
  const [x, y] = scoreAt({ goals }, t1);
  const winner = x === y ? -1 : x > y ? 0 : 1;
  steps.forEach((s, i) => {
    s.say(winner === i ? "🏆" : "gg!", CHEER_MS - 200, t1);
    s.until(t1 + CHEER_MS + i * 500, paddle);
  });
  [a, b].forEach((p, i) => {
    steps[i]!.goTo(layout, p.home.spot, table.ends[i]!.door, paddle);
    steps[i]!.sit(p.home.spot, paddle);
  });
  return activity(id, "pingpong", [{ s: steps[0], home: a.home.key }, { s: steps[1], home: b.home.key }], ["pingpong"], { together: { t0, t1 }, goals, strokes });
}

const PINBALL_POINTS = [10, 10, 50, 100, 100, 250, 500, 1_000, 5_000] as const;

/**
 * Someone plays pinball (a friend may stand beside them and watch): the ball
 * scores now and then, the score counts up, and the game ends on a high
 * score. The game starts when everyone is there.
 */
function pinball(id: string, p: LifePerson, watcher: LifePerson | undefined, start: number, layout: SceneLayout, r: () => number): Activity {
  const m = layout.life.pinball;
  const sp = startFrom(p, start);
  sp.rise();
  sp.goTo(layout, m.player, p.home.spot.door);
  const sw = watcher ? startFrom(watcher, start) : undefined;
  if (sw && watcher) {
    sw.stay(900 + Math.floor(r() * 1_400));
    sw.rise();
    sw.goTo(layout, m.watcher, watcher.home.spot.door);
  }
  const t0 = Math.max(sp.t, sw?.t ?? 0) + 400;
  const t1 = t0 + 18_000 + Math.floor(r() * 8_000);
  const bumps: { at: number; points: number }[] = [];
  for (let t = t0 + 500 + Math.floor(r() * 600); t < t1 - 300; t += 450 + Math.floor(r() * 1_300)) {
    const points = pick(r, PINBALL_POINTS);
    bumps.push({ at: t, points });
    // A shout, now and then, that is over before the high score.
    if (t + SHOUT_MS > t1) continue;
    if (points >= 1_000 && r() < 0.6) sp.say(pick(r, ["jackpot!", "c'mon!", "multiball!", "yes!"]), SHOUT_MS, t);
    else if (sw && r() < 0.12) sw.say(pick(r, ["nice!", "👀", "go go go", "wow"]), SHOUT_MS, t);
  }
  const atMachine = { isAtPinball: true };
  sp.say("high score! 🎉", CHEER_MS - 200, t1);
  sp.until(t1 + CHEER_MS, atMachine);
  sp.goTo(layout, p.home.spot, m.player.door);
  sp.sit(p.home.spot);
  const tracks = [{ s: sp, home: p.home.key }];
  if (sw && watcher) {
    sw.say("👏", CHEER_MS - 500, t1 + 300);
    sw.until(t1 + CHEER_MS + 500);
    sw.goTo(layout, watcher.home.spot, m.watcher.door);
    sw.sit(watcher.home.spot);
    tracks.push({ s: sw, home: watcher.home.key });
  }
  return activity(id, "pinball", tracks, ["pinball"], { together: { t0, t1 }, bumps });
}

const COFFEE_LINES = ["needed this ☕", "so good", "😌", "how's your day?", "busy one", "haha", "same!", "👍", "nice!", "🍪?"] as const;

/**
 * Coffee for two: the first one makes two cups while the other takes two
 * seats at the kitchen table; they sit with their cups, talk, and take them
 * back to their desks.
 */
function coffeeForTwo(id: string, a: LifePerson, b: LifePerson, start: number, layout: SceneLayout, r: () => number): Activity {
  const { coffee: machine, cafe } = layout.life;
  const sa = startFrom(a, start);
  const sb = startFrom(b, start);
  sb.stay(800 + Math.floor(r() * 1_200));
  sa.rise();
  sa.goTo(layout, machine, a.home.spot.door);
  const brew = { t0: sa.t, t1: sa.t + Math.round(BREW_MS * 1.6) };
  sa.say("☕☕", SAY_MS, sa.t + 200);
  sa.stay(brew.t1 - brew.t0);
  const cup = { prop: "cup" as const };
  sa.goTo(layout, cafe[0]!, machine.door, cup);
  sa.sit(cafe[0]!, cup);
  sb.rise();
  sb.goTo(layout, cafe[1]!, b.home.spot.door);
  sb.sit(cafe[1]!);
  // Without a cup until the coffee arrives.
  sb.until(sa.t);
  sb.say("thanks! ☕", SAY_MS, Math.max(sa.t, sb.t) + 300);
  const t0 = Math.max(sa.t, sb.t) + 2_600;
  const lines = 6 + Math.floor(r() * 3);
  for (let i = 0; i < lines; i++) (i % 2 ? sb : sa).say(pick(r, COFFEE_LINES), SAY_MS, t0 + i * LINE_MS);
  const t1 = t0 + lines * LINE_MS;
  sa.until(t1, cup);
  sb.until(t1 + 500, cup);
  for (const [s, p, seat] of [
    [sa, a, cafe[0]!],
    [sb, b, cafe[1]!],
  ] as const) {
    s.rise(cup);
    s.goTo(layout, p.home.spot, seat.door, cup);
    s.sit(p.home.spot, cup);
  }
  return activity(id, "coffee", [{ s: sa, home: a.home.key }, { s: sb, home: b.home.key }], ["coffee", "cafe"], { together: { t0, t1 }, brew });
}

/** A walk back from wherever they are (mid-walk, at the foosball table, on the sofa) to where they belong now. */
function walkBack(id: string, p: LifePerson, from: { at: P3; look: 1 | -1; door?: Floor }, now: number, layout: SceneLayout, gotWork: boolean, kind: "return" | "commute"): Activity {
  const s = new Steps(p.id, now, from.at, from.look);
  if (gotWork) s.say("back to work", 2_400, now);
  // When a meeting starts or ends, people get up one after another, not in unison.
  if (kind === "commute") s.stay(COMMUTE_STAGGER_MS * (hash(p.id) % 5));
  s.rise();
  s.goTo(layout, p.home.spot, from.door);
  s.sit(p.home.spot);
  return activity(id, kind, [{ s, home: p.home.key }], [], kind === "return" ? { gotWork } : {});
}

/** The leg a track is on at time t (the first before it starts, the last after it ends). */
export function legAt(track: Pick<Track, "legs">, t: number): Leg | undefined {
  for (const leg of track.legs) if (t < leg.t1) return leg;
  return track.legs.at(-1);
}

/** Where a person on a track is at time t. */
export function positionAt(track: Pick<Track, "legs">, t: number): P3 {
  const leg = legAt(track, t);
  if (!leg) return { x: 0, y: 0, z: 0 };
  const k = leg.t1 > leg.t0 ? Math.max(0, Math.min(1, (t - leg.t0) / (leg.t1 - leg.t0))) : 1;
  return { x: leg.from.x + (leg.to.x - leg.from.x) * k, y: leg.from.y + (leg.to.y - leg.from.y) * k, z: leg.from.z + (leg.to.z - leg.from.z) * k };
}

/** What a person says at time t, if anything. */
export const sayingAt = (track: Pick<Track, "says">, t: number): Say | undefined => track.says.find((s) => t >= s.t0 && t < s.t1);

/** Astryx's --ease-move: standing up and sitting down settle softly. */
const EASE_MOVE = "cubic-bezier(0.24, 1, 0.4, 1)";

/**
 * A track as Web Animation keyframes for a layer the size of the picture:
 * `translate(x%, y%)` puts the face's centre where the person is (percentages
 * of the layer, so a resize needs no new keyframes). Walking is linear (an
 * even pace through the waypoints); standing up and sitting down ease.
 */
export function trackFrames(track: Pick<Track, "legs" | "start" | "end">, view: SceneLayout["view"]): { offset: number; transform: string; easing?: string }[] {
  const total = Math.max(1, track.end - track.start);
  const at = (p: P3) => {
    const s = project(p.x, p.y, p.z);
    return `translate(${(((s.x - view.x) / view.width) * 100).toFixed(3)}%, ${(((s.y - view.y) / view.height) * 100).toFixed(3)}%)`;
  };
  const clamp = (k: number) => Math.max(0, Math.min(1, k));
  const frames: { offset: number; transform: string; easing?: string }[] = track.legs.map((leg) => ({
    offset: clamp((leg.t0 - track.start) / total),
    transform: at(leg.from),
    easing: leg.pose === "walk" ? "linear" : EASE_MOVE,
  }));
  const last = track.legs.at(-1);
  if (last) frames.push({ offset: 1, transform: at(last.to) });
  return frames;
}

/** The next moment after `now` when something on the picture changes (a leg, a line, a goal, a stroke, a pinball score, the brew): the scene redraws then, not every frame. */
export function nextChange(activities: Activity[], now: number): number | undefined {
  let next = Number.POSITIVE_INFINITY;
  const see = (t: number) => {
    if (t > now && t < next) next = t;
  };
  for (const a of activities) {
    for (const t of a.tracks) {
      for (const leg of t.legs) {
        see(leg.t0);
        see(leg.t1);
      }
      for (const s of t.says) {
        see(s.t0);
        see(s.t1);
      }
    }
    for (const g of a.goals ?? []) see(g.at);
    for (const s of a.strokes ?? []) see(s.at);
    for (const b of a.bumps ?? []) see(b.at);
    for (const w of [a.brew, a.water, a.together]) {
      if (w) {
        see(w.t0);
        see(w.t1);
      }
    }
  }
  return Number.isFinite(next) ? next : undefined;
}

// ---------- The director ----------

/** A face at a venue this close (screen units) to a meeting seat's would sit on the meeting: the venue waits until it ends. */
const CROWD = 80;

/**
 * Venues a meeting closes: any whose people would be drawn on top of the
 * people at the meeting (the foosball and the library next to the big table,
 * the coffee machine next to the kitchen table), the kitchen table when a
 * meeting sits there, the sofa while one is on at the big table (the lounge
 * is under the meeting's card, and a meeting wants quiet) and the ping pong
 * table, between the two tables, while either has a meeting.
 */
function closedVenues(layout: SceneLayout): Set<string> {
  const closed = new Set<string>();
  const seats = layout.meetingSpot.flatMap((s) => {
    if (s === undefined) return [];
    const chairs = Math.max(layout.placements.filter((p) => p.spot === s).length, layout.spots[s]!.chairs);
    return seatsAround(layout.spots[s]!, chairs).map(({ chair }) => project(chair.x, chair.y, SEAT_Z));
  });
  if (!seats.length) return closed;
  const near = (spot: LifeSpot) => {
    const p = project(spot.at.x, spot.at.y, spot.z);
    return seats.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < CROWD);
  };
  const life = layout.life;
  const check = (venue: string, spots: LifeSpot[]) => spots.some(near) && closed.add(venue);
  check("coffee", [life.coffee]);
  check("cafe", life.cafe);
  check("sofa", life.sofa);
  check("foosball", life.foosball.ends);
  check("pingpong", life.pingpong.ends);
  check("pinball", [life.pinball.player, life.pinball.watcher]);
  check("shelf", [life.shelf]);
  life.windows.forEach((w, i) => check(`window:${i}`, [w]));
  life.plants.forEach((p, i) => check(`plant:${i}`, [p]));
  if (layout.meetingSpot.includes(1)) closed.add("cafe");
  if (layout.meetingSpot.includes(0)) closed.add("sofa");
  closed.add("pingpong");
  return closed;
}

/** Venues a new outing can use now. */
function openVenues(layout: SceneLayout, activities: Activity[]) {
  const shut = new Set([...activities.flatMap((a) => a.venues), ...closedVenues(layout)]);
  const life = layout.life;
  return {
    cafe: !shut.has("cafe") && life.cafe.length >= 2,
    sofa: !shut.has("sofa") && life.sofa.length >= 2,
    foosball: !shut.has("foosball"),
    pingpong: !shut.has("pingpong"),
    pinball: !shut.has("pinball"),
    coffee: !shut.has("coffee"),
    shelf: !shut.has("shelf"),
    windows: life.windows.map((_, i) => i).filter((i) => !shut.has(`window:${i}`)),
    plants: life.plants.map((_, i) => i).filter((i) => !shut.has(`plant:${i}`)),
  };
}

/** An option for `weighted`, only when it is open. */
const option = <T>(isOpen: boolean, value: T, weight: number): [T, number][] => (isOpen ? [[value, weight]] : []);

/** Choose by weight: `roll` in [0, 1). */
function weighted<T>(roll: number, options: [T, number][]): T | undefined {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let x = roll * total;
  for (const [o, w] of options) {
    if (x < w) return o;
    x -= w;
  }
  return options.at(-1)?.[0];
}

/** Starts the outing a proposal plans, when there is room and someone free to go. */
function tryStart(prop: Proposal, activities: Activity[], rest: Record<string, number>, people: LifePerson[], layout: SceneLayout): Activity | undefined {
  const out = new Set(activities.flatMap((a) => a.people));
  if (out.size + prop.size > MAX_AWAY) return undefined;
  const rank = (id: string) => hash(`${prop.slot}:${prop.size}:${id}`);
  const eligible = people
    .filter((p) => p.isFree && p.home.atDesk && !out.has(p.id) && (rest[p.id] ?? Number.NEGATIVE_INFINITY) <= prop.at)
    .sort((p, q) => rank(p.id) - rank(q.id) || p.id.localeCompare(q.id));
  if (eligible.length < prop.size) return undefined;
  const r = seeded(prop.seed);
  const open = openVenues(layout, activities);
  const id = `${prop.slot}:${prop.size}`;
  if (prop.size === 2) {
    const [a, b] = [eligible[0]!, eligible[1]!];
    // Ping pong comes up as often as foosball; pinball for two (one plays, one watches) and a coffee for two less often.
    type Pair = "cafe" | "sofa" | "foosball" | "pingpong" | "pinball" | "coffee";
    const kind = weighted<Pair>(r(), [
      ...option<Pair>(open.cafe, "cafe", 1),
      ...option<Pair>(open.sofa, "sofa", 1),
      ...option<Pair>(open.foosball, "foosball", 1.4),
      ...option<Pair>(open.pingpong, "pingpong", 1.4),
      ...option<Pair>(open.pinball, "pinball", 0.6),
      ...option<Pair>(open.coffee && open.cafe, "coffee", 0.8),
    ]);
    if (kind === "foosball") return foosball(`foosball:${id}`, a, b, prop.at, layout, r);
    if (kind === "pingpong") return pingpong(`pingpong:${id}`, a, b, prop.at, layout, r);
    if (kind === "pinball") return pinball(`pinball:${id}`, a, b, prop.at, layout, r);
    if (kind === "coffee") return coffeeForTwo(`coffee:${id}`, a, b, prop.at, layout, r);
    if (kind === "cafe") return chat(`chat:${id}`, a, b, prop.at, layout, layout.life.cafe, "cafe", r);
    if (kind === "sofa") return chat(`chat:${id}`, a, b, prop.at, layout, layout.life.sofa, "sofa", r);
    return undefined;
  }
  const p = eligible[0]!;
  const kind = weighted<ActivityKind>(r(), [
    ...option<ActivityKind>(open.coffee, "coffee", 3),
    ...option<ActivityKind>(open.shelf, "read", 2),
    ...option<ActivityKind>(open.plants.length > 0, "water", 1.5),
    ["stretch", 1.2],
    ...option<ActivityKind>(open.windows.length > 0, "window", 1.5),
    ...option<ActivityKind>(open.pinball, "pinball", 1),
  ]);
  const life = layout.life;
  switch (kind) {
    case "pinball":
      return pinball(`pinball:${id}`, p, undefined, prop.at, layout, r);
    case "coffee":
      return coffee(`coffee:${id}`, p, prop.at, layout, open.cafe && r() < 0.6 ? life.cafe[r() < 0.5 ? 0 : 1] : undefined);
    case "read": {
      const s = outing(p, prop.at, layout, life.shelf, 9_000, { prop: "book" }, "📖");
      return activity(`read:${id}`, "read", [{ s, home: p.home.key }], ["shelf"]);
    }
    case "water": {
      const plant = pick(r, open.plants);
      const s = outing(p, prop.at, layout, life.plants[plant]!, 5_000, { prop: "can" }, "🌱");
      const stay = s.legs.find((l) => l.prop === "can")!;
      return activity(`water:${id}`, "water", [{ s, home: p.home.key }], [`plant:${plant}`], { water: { t0: stay.t0, t1: stay.t1, plant } });
    }
    case "window": {
      const w = pick(r, open.windows);
      const s = outing(p, prop.at, layout, life.windows[w]!, 7_000, {}, pick(r, ["☀️", "🌤️", "🐦", "🌳"]));
      return activity(`window:${id}`, "window", [{ s, home: p.home.key }], [`window:${w}`]);
    }
    default: {
      // A stretch in the aisle right behind the chair.
      const aisle: LifeSpot = { at: p.home.spot.door, door: p.home.spot.door, z: STAND_Z, pose: "stand", look: 1 };
      const s = outing(p, prop.at, layout, aisle, 4_200, { isStretch: true }, "🙆");
      return activity(`stretch:${id}`, "stretch", [{ s, home: p.home.key }], []);
    }
  }
}

/** Ends what is over by time t; those who were out rest a while. */
function finish(activities: Activity[], t: number, rest: Record<string, number>): Activity[] {
  return activities.filter((a) => {
    if (a.end > t) return true;
    for (const id of a.people) rest[id] = Math.max(rest[id] ?? 0, a.end + REST_MS);
    return false;
  });
}

/** Where someone on a track is now, and the open floor they leave by. */
function whereNow(track: Track | undefined, fallback: Home, now: number): { at: P3; look: 1 | -1; door?: Floor } {
  if (!track) return { at: at3(fallback.spot), look: fallback.spot.look, door: fallback.spot.door };
  const leg = legAt(track, now);
  return { at: positionAt(track, now), look: leg?.look ?? 1 };
}

const sameList = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The director's step: plays the plan from `state.t` to `now` (outings start
 * and end in time order) and then reacts to the office as it is now (who got
 * work, whose seat moved). Returns `state` itself when nothing changed.
 */
export function advance(state: LifeState | undefined, people: LifePerson[], layout: SceneLayout, now: number): LifeState {
  const prev = state ?? { t: now - LOOKBACK_MS, activities: [], rest: {}, homes: {} };
  const rest = { ...prev.rest };
  let activities = prev.activities;
  const proposals = proposalsBetween(prev.t, now);
  for (const p of proposals) {
    activities = finish(activities, p.at, rest);
    const started = tryStart(p, activities, rest, people, layout);
    if (started) activities = [...activities, started];
  }
  activities = finish(activities, now, rest);

  // Now: whoever is out and got work (or whose seat moved) walks back; a partner comes back too.
  const byId = new Map(people.map((p) => [p.id, p]));
  const closed = closedVenues(layout);
  const next: Activity[] = [];
  for (const a of activities) {
    const isWalkBack = a.kind === "return" || a.kind === "commute";
    const isClosed = a.venues.some((v) => closed.has(v));
    const cut = a.tracks.some((t) => {
      const p = byId.get(t.personId);
      return !p || p.home.key !== t.home || (!isWalkBack && (!p.isFree || isClosed));
    });
    if (!cut) {
      next.push(a);
      continue;
    }
    for (const t of a.tracks) {
      const p = byId.get(t.personId);
      if (!p) continue;
      const gotWork = isWalkBack ? Boolean(a.gotWork) : !p.isFree;
      next.push(walkBack(`${a.id}>${p.id}@${now}`, p, whereNow(t, p.home, now), now, layout, gotWork, "return"));
    }
  }

  // Seated people whose place changed (a meeting starts or ends) walk there.
  const isFresh = now - prev.t <= STALE_MS;
  for (const p of people) {
    const was = prev.homes[p.id];
    if (!isFresh || !was || was.key === p.home.key || next.some((a) => a.people.includes(p.id))) continue;
    next.push(walkBack(`commute>${p.id}@${now}`, p, whereNow(undefined, was, now), now, layout, false, "commute"));
  }

  const homes: Record<string, Home> = Object.fromEntries(people.map((p) => [p.id, p.home]));
  for (const id of Object.keys(rest)) if (rest[id]! < now) delete rest[id];
  const sameHomes = Object.keys(homes).length === Object.keys(prev.homes).length && people.every((p) => prev.homes[p.id]?.key === p.home.key);
  if (state && proposals.length === 0 && sameList(next, prev.activities) && sameHomes) return state;
  return { t: now, activities: sameList(next, prev.activities) ? prev.activities : next, rest, homes };
}

/** When the director next has something to do: an outing that ends, or a moment in the plan. */
export function nextEvent(state: LifeState): number {
  let next = state.t + 4 * SLOT_MS;
  for (const a of state.activities) if (a.end > state.t) next = Math.min(next, a.end);
  for (const p of proposalsBetween(state.t, state.t + 4 * SLOT_MS)) next = Math.min(next, p.at);
  return next;
}

// ---------- Words ----------

export interface LifeNote {
  emoji: string;
  /** For the list: "Playing foosball with Omar". */
  text: string;
  /** For a small bubble: "coffee break". */
  short: string;
}

/** What a person's outing is, in words (undefined for walks back to work and to meetings). */
export function lifeNote(a: Activity, personId: string, nameOf: (id: string) => string | undefined, now: number): LifeNote | undefined {
  const other = a.people.find((id) => id !== personId);
  const withName = other ? nameOf(other) : undefined;
  switch (a.kind) {
    case "coffee": {
      // For two, the first one makes both cups.
      const isMaking = a.people[0] === personId && a.brew !== undefined && now < a.brew.t1;
      const text = isMaking ? (withName ? `Making coffee for ${withName}` : "Making coffee") : withName ? `Having a coffee with ${withName}` : "Having a coffee";
      return { emoji: "☕", text, short: "coffee break" };
    }
    case "chat":
      return { emoji: "💬", text: withName ? `Chatting with ${withName}` : "Chatting", short: "chatting" };
    case "foosball":
      return { emoji: "⚽", text: withName ? `Playing foosball with ${withName}` : "Playing foosball", short: "foosball" };
    case "pingpong":
      return { emoji: "🏓", text: withName ? `Playing ping pong with ${withName}` : "Playing ping pong", short: "ping pong" };
    case "pinball":
      // The first one plays; a second one watches.
      if (a.people[0] !== personId) {
        const player = nameOf(a.people[0]!);
        return { emoji: "🕹️", text: player ? `Watching ${player} play pinball` : "Watching a pinball game", short: "watching pinball" };
      }
      return { emoji: "🕹️", text: "Playing pinball", short: "pinball" };
    case "read":
      return { emoji: "📖", text: "Reading in the Skills library", short: "reading" };
    case "water":
      return { emoji: "🌱", text: "Watering the plants", short: "watering plants" };
    case "stretch":
      return { emoji: "🙆", text: "Stretching", short: "stretching" };
    case "window":
      return { emoji: "☀️", text: "Looking out of the window", short: "window break" };
    default:
      return undefined;
  }
}

/** The score of a foosball or ping pong game at time t. */
export function scoreAt(a: Pick<Activity, "goals">, t: number): [number, number] {
  const done = (a.goals ?? []).filter((g) => g.at <= t);
  return [done.filter((g) => g.by === 0).length, done.filter((g) => g.by === 1).length];
}

/** A pinball game's score at time t: it only counts up. */
export const pinballScoreAt = (a: Pick<Activity, "bumps">, t: number): number => (a.bumps ?? []).reduce((sum, b) => (b.at <= t ? sum + b.points : sum), 0);

/** The ping pong ball at time t: in flight from one paddle to the other (a bounce on the far half), flying past the one who missed after a point, or nowhere (between rallies). */
export function ballAt(a: Pick<Activity, "strokes">, table: Pick<GameTable, "x" | "y" | "w" | "d">, t: number): P3 | undefined {
  const strokes = a.strokes ?? [];
  let i = -1;
  while (i + 1 < strokes.length && strokes[i + 1]!.at <= t) i++;
  if (i < 0) return undefined;
  const s = strokes[i]!;
  const next = strokes[i + 1];
  // The rally's last stroke: nobody hits it back.
  const isLast = !next || next.at - s.at > STROKE_MS;
  const k = (t - s.at) / STROKE_MS;
  const dir = s.by === 0 ? 1 : -1;
  const at = (u: number, v: number, z: number): P3 => ({ x: table.x + table.w / 2 + u * (table.w / 2 + 6), y: table.y + table.d / 2 + v * (table.d / 2 - 5), z });
  const top = PINGPONG.h + 2;
  if (k < 1) {
    const v = s.v + ((isLast ? s.v : next.v) - s.v) * k;
    return at(dir * (-1 + 2 * k), v, top + flightHeight(k));
  }
  const m = (t - s.at - STROKE_MS) / MISS_MS;
  if (!isLast || m >= 1) return undefined;
  // Past the end of the table and down to the floor.
  return at(dir * (1 + 0.9 * m), s.v, 2 + (top - 2 + HIT_Z) * (1 - m * m));
}

/** Above the table top, the ball leaves a paddle this high and is met this high on the other side. */
const HIT_Z = 9;
/** Where in a crossing the ball bounces: on the far half of the table. */
export const BOUNCE_K = 0.62;

/** The ball's height above the table top over one crossing (k from 0 to 1): an arc over the net down to the bounce, a smaller one up to the paddle. */
export function flightHeight(k: number): number {
  if (k < BOUNCE_K) {
    const q = k / BOUNCE_K;
    return HIT_Z * (1 - q) + 48 * q * (1 - q);
  }
  const q = (k - BOUNCE_K) / (1 - BOUNCE_K);
  return HIT_Z * q + 24 * q * (1 - q);
}

/**
 * The ping pong ball as Web Animation keyframes for a whole game (an SVG
 * circle drawn at the origin, moved in drawing units): sampled along every
 * crossing, hidden between rallies. Undefined without strokes.
 */
export function ballFrames(a: Pick<Activity, "strokes">, table: Pick<GameTable, "x" | "y" | "w" | "d">): { start: number; end: number; frames: { offset: number; transform: string; opacity: number }[] } | undefined {
  const strokes = a.strokes ?? [];
  if (!strokes.length) return undefined;
  const start = strokes[0]!.at;
  const end = strokes.at(-1)!.at + STROKE_MS + MISS_MS;
  const times: number[] = [];
  strokes.forEach((s, i) => {
    for (let j = 0; j < 8; j++) times.push(s.at + (j * STROKE_MS) / 8);
    const next = strokes[i + 1];
    if (!next || next.at - s.at > STROKE_MS) {
      for (let j = 0; j <= 4; j++) times.push(s.at + STROKE_MS + (j * MISS_MS) / 4 - (j === 4 ? 1 : 0));
      // Hidden from just after the drop until the next serve.
      times.push(s.at + STROKE_MS + MISS_MS);
      if (next) times.push(next.at - 1);
    }
  });
  let last: P3 = { x: table.x + table.w / 2, y: table.y + table.d / 2, z: PINGPONG.h };
  const frames = times.map((t) => {
    const p = ballAt(a, table, t);
    if (p) last = p;
    const s = project(last.x, last.y, last.z);
    return { offset: Math.max(0, Math.min(1, (t - start) / (end - start))), transform: `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`, opacity: p ? 1 : 0 };
  });
  return { start, end, frames };
}
