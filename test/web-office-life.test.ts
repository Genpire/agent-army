import { describe, expect, it } from "vitest";
import type { OfficeMeeting, OfficePerson, OfficeState } from "../src/team/office.js";
import { type BubbleRequest, TAG_DY, around, fixedRects, overlap, placeBubbles, tagWidth } from "../web/src/pages/office/bubbles.js";
import { BEANBAG_Z, type Floor, type LifeSpot, PINGPONG, type SceneLayout, STAND_Z, deskSeat, officeLayout, project } from "../web/src/pages/office/layout.js";
import {
  type Activity,
  BOUNCE_K,
  type LifePerson,
  type LifeState,
  LOOKBACK_MS,
  MAX_AWAY,
  MISS_MS,
  SLOT_MS,
  STROKE_MS,
  WALK,
  advance,
  ballAt,
  ballFrames,
  legAt,
  lifeNote,
  lifePeople,
  nextChange,
  nextEvent,
  pointsAt,
  positionAt,
  proposalsBetween,
  sayingAt,
  scoreAt,
  slotPlan,
  trackFrames,
} from "../web/src/pages/office/life.js";
import { isClear, isInside, pathLength, route } from "../web/src/pages/office/paths.js";
import {
  MIN_LEFT_MS,
  READ_MIN_MS,
  TALK_TEXT_MAX,
  type TalkLine,
  cleanLines,
  leftThePlan,
  picksModel,
  plannedTalk,
  readMs,
  settingsDraft,
  shownLines,
  talkDue,
  talkRequest,
  talkSchedule,
  talksOf,
  talkTitle,
  withProvider,
  withTalk,
} from "../web/src/pages/office/talk.js";

const NAMES = ["Sara", "Omar", "Lina", "Kenji", "Maya", "Noor", "Diego", "Ada", "Ravi", "Iris", "Tomas", "Yuki", "Zane", "Bea", "Cyd", "Dov", "Eli", "Fay", "Gus", "Hal"];

function person(id: string, state: OfficeState = "free", kind: OfficePerson["kind"] = "agent", role = "Coder"): OfficePerson {
  return { id, name: id === "pointer" ? "Pointer" : NAMES[Number(id.slice(1))] ?? id, role, emoji: ":robot_face:", avatar: id, kind, state, today: { tasks: 0, minutes: 0 } };
}

/** Pointer and `n` agents (the last one HR when `hr`), all free unless `busy` says otherwise. */
function team(n: number, busy: Record<string, OfficeState> = {}, hr = true): OfficePerson[] {
  return [
    person("pointer", busy.pointer ?? "free", "lead", "Lead"),
    ...Array.from({ length: n }, (_, i) => person(`a${i}`, busy[`a${i}`] ?? "free", "agent", hr && i === n - 1 ? "HR" : "Coder")),
  ];
}

function meeting(people: string[]): OfficeMeeting {
  return { taskId: "t-1", title: "Dark mode", repo: "acme/web", channel: "web", step: "build", plan: { done: 1, total: 4 }, people, since: new Date(0).toISOString() };
}

const T0 = 1_800_000_000_000;

function setup(n: number, busy: Record<string, OfficeState> = {}, meetings: OfficeMeeting[] = []) {
  const people = team(n, busy);
  const layout = officeLayout(people, meetings);
  return { people, layout, life: lifePeople({ people }, layout) };
}

/** Steps the director every `step` ms from `from` to `to`, calling `check` after each step. */
function run(layout: SceneLayout, people: LifePerson[], from: number, to: number, step: number, check?: (s: LifeState, t: number) => void, start?: LifeState): LifeState {
  let state = start ?? advance(undefined, people, layout, from);
  check?.(state, from);
  for (let t = from + step; t <= to; t += step) {
    state = advance(state, people, layout, t);
    check?.(state, t);
  }
  return state;
}

const away = (s: LifeState) => new Set(s.activities.flatMap((a) => a.people));

/** Every spot a free agent can go to. */
function allSpots(layout: SceneLayout): LifeSpot[] {
  const l = layout.life;
  return [l.coffee, ...l.cafe, ...l.sofa, ...l.foosball.ends, ...l.pingpong.ends, l.pinball.player, l.pinball.watcher, ...l.gaming.seats, l.shelf, ...l.windows, ...l.plants];
}

function expectWalkable(layout: SceneLayout, points: Floor[]) {
  // The first and last steps leave and reach a seat (inside its chair); every step between keeps clear of furniture.
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    expect(isClear(layout.obstacles, p, q), `step ${i} from (${Math.round(p.x)}, ${Math.round(p.y)}) to (${Math.round(q.x)}, ${Math.round(q.y)})`).toBe(true);
  }
}

describe("office paths", () => {
  const sizes = [0, 1, 3, 6, 7, 9, 12, 16, 20];

  it("puts every spot's door and every desk's aisle on open floor, inside the room", () => {
    for (const n of sizes) {
      const { layout } = setup(n);
      for (const spot of allSpots(layout)) {
        expect(layout.obstacles.some((o) => isInside(o, spot.door)), `${n} agents: door ${JSON.stringify(spot.door)}`).toBe(false);
        expect(spot.door.x).toBeGreaterThan(0);
        expect(spot.door.y).toBeGreaterThan(0);
        expect(spot.door.x).toBeLessThan(layout.a);
        expect(spot.door.y).toBeLessThan(layout.b);
      }
      for (const d of layout.desks) expect(layout.obstacles.some((o) => isInside(o, d.door)), `${n} agents: desk ${d.key}`).toBe(false);
    }
  });

  it("reaches every spot from every desk without walking through furniture, for any team size", () => {
    for (const n of sizes) {
      const { layout } = setup(n);
      for (const desk of layout.desks) {
        for (const spot of allSpots(layout)) {
          const path = route(layout, desk.door, spot.door);
          expect(path[0]).toEqual(desk.door);
          expect(path.at(-1)).toEqual(spot.door);
          expectWalkable(layout, path);
        }
      }
    }
  });

  it("reaches the meeting table's chairs from the desks", () => {
    const { layout, life } = setup(7, { pointer: "meeting", a0: "working", a1: "meeting" }, [meeting(["pointer", "a0", "a1"])]);
    const seats = life.filter((p) => !p.home.atDesk);
    expect(seats).toHaveLength(3);
    for (const p of seats) {
      for (const desk of layout.desks) expectWalkable(layout, route(layout, desk.door, p.home.spot.door));
    }
  });

  it("walks straight when nothing is in the way, and round a desk when one is", () => {
    const { layout } = setup(6);
    const open = { x: 300, y: 120 };
    const near = { x: 340, y: 150 };
    expect(route(layout, open, near)).toEqual([open, near]);
    // From behind the first row to in front of it: straight through a desk is not allowed.
    const desk = layout.desks.find((d) => d.kind === "agent")!;
    const behind = { x: desk.x + desk.w / 2, y: desk.y - 26 };
    const front = desk.door;
    expect(isClear(layout.obstacles, behind, front)).toBe(false);
    const path = route(layout, behind, front);
    expect(path.length).toBeGreaterThan(2);
    expectWalkable(layout, path);
    expect(pathLength(path)).toBeLessThan(3 * Math.hypot(front.x - behind.x, front.y - behind.y) + 200);
  });

  it("is the same walk every time (cached, deterministic)", () => {
    const { layout } = setup(7);
    const a = route(layout, layout.desks[1]!.door, layout.life.coffee.door);
    const b = route(officeLayout(team(7), []), layout.desks[1]!.door, layout.life.coffee.door);
    expect(b).toEqual(a);
  });
});

describe("office life: the plan", () => {
  it("is the same for the same slot, different across slots, and in order", () => {
    expect(slotPlan(1234)).toEqual(slotPlan(1234));
    const plans = Array.from({ length: 40 }, (_, i) => JSON.stringify(slotPlan(i).map((p) => [p.size, p.at % SLOT_MS])));
    expect(new Set(plans).size).toBeGreaterThan(5);
    const list = proposalsBetween(T0, T0 + 10 * SLOT_MS);
    expect(list.length).toBeGreaterThan(3);
    for (let i = 1; i < list.length; i++) expect(list[i]!.at).toBeGreaterThanOrEqual(list[i - 1]!.at);
    for (const p of list) expect(p.at).toBeGreaterThan(T0);
  });
});

describe("office life: the director", () => {
  it("is deterministic: the same office at the same moment gives the same outings, however often it ticks", () => {
    const { layout, life } = setup(7);
    const a = advance(undefined, life, layout, T0);
    const b = advance(undefined, lifePeople({ people: team(7) }, officeLayout(team(7), [])), officeLayout(team(7), []), T0);
    expect(JSON.stringify(b.activities)).toBe(JSON.stringify(a.activities));
    // One big step or a step a second: the same outcome.
    const coarse = advance(a, life, layout, T0 + 5 * 60_000);
    const fine = run(layout, life, T0, T0 + 5 * 60_000, 1_000, undefined, a);
    expect(JSON.stringify(fine.activities)).toBe(JSON.stringify(coarse.activities));
    // Rests still to come agree too (past ones no longer matter).
    const ahead = (rest: Record<string, number>) => Object.fromEntries(Object.entries(rest).filter(([, t]) => t > T0 + 5 * 60_000));
    expect(ahead(fine.rest)).toEqual(ahead(coarse.rest));
  });

  it("replays the last two minutes for a new viewer, so outings already under way show", () => {
    const { layout, life } = setup(7);
    let seen = 0;
    for (let k = 0; k < 20; k++) if (advance(undefined, life, layout, T0 + k * 47_000).activities.length) seen++;
    expect(seen).toBeGreaterThan(5);
    expect(LOOKBACK_MS).toBeGreaterThanOrEqual(90_000);
  });

  it(`never has more than ${MAX_AWAY} people away, and only free people at their desks go out`, () => {
    const { layout, life } = setup(9, { a2: "working", a5: "thinking" });
    const kinds = new Set<string>();
    run(layout, life, T0, T0 + 2 * 3_600_000, 1_000, (s) => {
      expect(away(s).size).toBeLessThanOrEqual(MAX_AWAY);
      for (const a of s.activities) {
        kinds.add(a.kind);
        expect(a.people).not.toContain("a2");
        expect(a.people).not.toContain("a5");
        if (a.kind === "chat" || a.kind === "foosball" || a.kind === "pingpong") {
          expect(new Set(a.people).size).toBe(2);
        } else if (a.kind === "coffee" || a.kind === "pinball" || a.kind === "gaming") {
          // Alone, or for two: one makes the coffees, one plays pinball while the other watches, or two race on the TV.
          expect(new Set(a.people).size).toBe(a.people.length);
          expect(a.people.length).toBeLessThanOrEqual(2);
        } else {
          expect(a.people).toHaveLength(1);
        }
      }
    });
    // Varied: coffee, chats, games and solo moments all happen in two hours.
    for (const k of ["coffee", "chat", "foosball", "pingpong", "pinball", "gaming", "read", "water", "stretch", "window"]) expect(kinds, k).toContain(k);
  });

  it("does nothing when nobody is free, and pairs only when two are", () => {
    const busy = Object.fromEntries(["pointer", ...Array.from({ length: 6 }, (_, i) => `a${i}`)].map((id) => [id, "working" as OfficeState]));
    const none = setup(6, busy);
    run(none.layout, none.life, T0, T0 + 30 * 60_000, 2_000, (s) => expect(s.activities).toHaveLength(0));
    const one = setup(6, { ...busy, a3: "free" });
    run(one.layout, one.life, T0, T0 + 30 * 60_000, 2_000, (s) => {
      for (const a of s.activities) expect(a.people).toEqual(["a3"]);
    });
  });

  it("gives each outing a continuous track that starts and ends in the person's seat", () => {
    const { layout, life } = setup(7);
    const seen = new Map<string, Activity>();
    run(layout, life, T0, T0 + 30 * 60_000, 5_000, (s) => s.activities.forEach((a) => seen.set(a.id, a)));
    expect(seen.size).toBeGreaterThan(10);
    for (const a of seen.values()) {
      for (const t of a.tracks) {
        const home = life.find((p) => p.id === t.personId)!.home.spot;
        const first = t.legs[0]!;
        const last = t.legs.at(-1)!;
        expect(first.from).toEqual({ x: home.at.x, y: home.at.y, z: home.z });
        expect(last.to).toEqual({ x: home.at.x, y: home.at.y, z: home.z });
        expect(t.start).toBe(a.start === t.start ? a.start : t.start);
        for (let i = 1; i < t.legs.length; i++) {
          expect(t.legs[i]!.t0).toBeCloseTo(t.legs[i - 1]!.t1, 6);
          expect(t.legs[i]!.from).toEqual(t.legs[i - 1]!.to);
        }
        for (const leg of t.legs) {
          expect(leg.t1).toBeGreaterThanOrEqual(leg.t0);
          if (leg.pose === "walk") {
            // An even walking pace, standing up.
            const d = Math.hypot(leg.to.x - leg.from.x, leg.to.y - leg.from.y);
            expect((leg.t1 - leg.t0) * WALK).toBeCloseTo(d, 3);
            expect(leg.to.z).toBe(STAND_Z);
          }
        }
        // The walking part keeps clear of furniture (the steps out of and into a seat aside).
        const walked = t.legs.filter((l) => l.pose === "walk");
        for (const leg of walked.slice(1, -1)) expect(isClear(layout.obstacles, leg.from, leg.to)).toBe(true);
      }
    }
  });

  it("sends someone who gets work straight back to their desk, with a 'back to work' bubble; their partner goes back too", () => {
    const { people, layout, life } = setup(7);
    let state = advance(undefined, life, layout, T0);
    let t = T0;
    // Find a game or a chat in progress.
    let pair: Activity | undefined;
    for (; t < T0 + 3 * 3_600_000 && !pair; t += 1_000) {
      state = advance(state, life, layout, t);
      pair = state.activities.find((a) => (a.kind === "chat" || a.kind === "foosball") && a.together && t > a.together.t0);
    }
    expect(pair).toBeDefined();
    const [worker, partner] = pair!.people as [string, string];
    const where = positionAt(pair!.tracks.find((tr) => tr.personId === worker)!, t);
    const now = t;
    const busyPeople = people.map((p) => (p.id === worker ? { ...p, state: "working" as const, doing: "Editing src/app.ts" } : p));
    const next = advance(state, lifePeople({ people: busyPeople }, layout), layout, now);
    expect(next.activities.find((a) => a.id === pair!.id)).toBeUndefined();
    const back = next.activities.find((a) => a.kind === "return" && a.people[0] === worker)!;
    expect(back.gotWork).toBe(true);
    expect(back.start).toBe(now);
    expect(back.tracks[0]!.says[0]).toMatchObject({ text: "back to work", t0: now });
    // From where they are, not from a jump.
    expect(back.tracks[0]!.legs[0]!.from.x).toBeCloseTo(where.x, 6);
    expect(back.tracks[0]!.legs[0]!.from.y).toBeCloseTo(where.y, 6);
    const desk = layout.desks.find((d) => d.personId === worker)!;
    expect(back.tracks[0]!.legs.at(-1)!.to).toMatchObject({ x: desk.chair.x, y: desk.chair.y });
    const partnerBack = next.activities.find((a) => a.kind === "return" && a.people[0] === partner)!;
    expect(partnerBack.gotWork).toBe(false);
    expect(partnerBack.tracks[0]!.says).toHaveLength(0);
    expect(lifeNote(back, worker, () => undefined, now)).toBeUndefined();
  });

  it("walks someone who gets pulled into a meeting to the table, and back to the desk when it ends", () => {
    const { layout, life } = setup(7, { a0: "working" });
    const start = advance(undefined, life, layout, T0);
    const inMeeting = officeLayout(team(7, { a0: "working", pointer: "meeting" }), [meeting(["pointer", "a0"])]);
    const people2 = lifePeople({ people: team(7, { a0: "working", pointer: "meeting" }) }, inMeeting);
    const s1 = advance(start, people2, inMeeting, T0 + 1_000);
    const commute = s1.activities.find((a) => a.kind === "commute" && a.people[0] === "a0");
    expect(commute).toBeDefined();
    const seat = people2.find((p) => p.id === "a0")!.home.spot;
    expect(commute!.tracks[0]!.legs.at(-1)!.to).toEqual({ x: seat.at.x, y: seat.at.y, z: seat.z });
    // Mid-walk the meeting ends: they turn round for their desk from where they are.
    const mid = (commute!.start + commute!.end) / 2;
    const s2 = advance(s1, life, layout, mid);
    const back = s2.activities.find((a) => a.people[0] === "a0" && a.id !== commute!.id)!;
    expect(back).toBeDefined();
    const desk = deskSeat(layout.desks.find((d) => d.personId === "a0")!);
    expect(back.tracks[0]!.legs.at(-1)!.to).toEqual({ x: desk.at.x, y: desk.at.y, z: desk.z });
    const p = positionAt(commute!.tracks[0]!, mid);
    expect(back.tracks[0]!.legs[0]!.from.x).toBeCloseTo(p.x, 6);
  });

  it("keeps the lounge quiet during a meeting at the big table: no game, sofa or library next to it, and a game under way stops", () => {
    const busy = { pointer: "meeting" as const, a0: "meeting" as const, a1: "working" as const };
    const people = team(8, busy);
    const layout = officeLayout(people, [meeting(["pointer", "a0", "a1"])]);
    const life = lifePeople({ people }, layout);
    const kinds = new Set<string>();
    run(layout, life, T0, T0 + 3_600_000, 2_000, (s) => {
      for (const a of s.activities) {
        kinds.add(a.kind);
        expect(a.venues).not.toContain("foosball");
        expect(a.venues).not.toContain("sofa");
        expect(a.venues).not.toContain("shelf");
      }
    });
    expect(kinds).toContain("coffee");
    // A game started before the meeting: the meeting starts, the players go back to their desks (still free, so no "back to work").
    const calm = setup(8);
    let state = advance(undefined, calm.life, calm.layout, T0);
    let t = T0;
    let game: Activity | undefined;
    for (; t < T0 + 3 * 3_600_000 && !game; t += 1_000) {
      state = advance(state, calm.life, calm.layout, t);
      game = state.activities.find((a) => a.kind === "foosball" && a.together && t > a.together.t0 && !a.people.some((id) => ["pointer", "a0", "a1"].includes(id)));
    }
    expect(game).toBeDefined();
    const next = advance(state, life, layout, t);
    expect(next.activities.find((a) => a.id === game!.id)).toBeUndefined();
    for (const id of game!.people) {
      const back = next.activities.find((a) => a.kind === "return" && a.people[0] === id)!;
      expect(back.gotWork).toBe(false);
      expect(back.tracks[0]!.says).toHaveLength(0);
    }
  });

  it("wakes up only at events, never in a busy loop", () => {
    const { layout, life } = setup(7);
    let state = advance(undefined, life, layout, T0);
    for (let i = 0; i < 50; i++) {
      const at = nextEvent(state);
      expect(at).toBeGreaterThan(state.t);
      state = advance(state, life, layout, at);
    }
    // Nothing changed and no plan moment passed: the same state comes back (no redraw).
    expect(advance(state, life, layout, state.t)).toBe(state);
  });
});

describe("office life: words, score and frames", () => {
  const { layout, life } = setup(7);
  const seen = new Map<string, Activity>();
  run(layout, life, T0, T0 + 2 * 3_600_000, 4_000, (s) => s.activities.forEach((a) => seen.set(a.kind, a)));
  const names = new Map([...life.map((p) => [p.id, p.name] as const)]);

  it("says what each outing is, with the partner's name", () => {
    const game = seen.get("foosball")!;
    const [a, b] = game.people as [string, string];
    expect(lifeNote(game, a, (id) => names.get(id), game.start)?.text).toBe(`Playing foosball with ${names.get(b)}`);
    const chat = seen.get("chat")!;
    expect(lifeNote(chat, chat.people[0]!, (id) => names.get(id), chat.start)?.text).toMatch(/^Chatting with /);
    const coffee = seen.get("coffee")!;
    expect(lifeNote(coffee, coffee.people[0]!, () => undefined, coffee.start)?.text).toBe("Making coffee");
    expect(lifeNote(coffee, coffee.people[0]!, () => undefined, coffee.brew!.t1)?.text).toBe("Having a coffee");
    expect(lifeNote(coffee, coffee.people[0]!, () => undefined, 0)?.short).toBe("coffee break");
  });

  it("keeps a foosball score that only goes up", () => {
    const game = seen.get("foosball")!;
    expect(game.goals!.length).toBeGreaterThan(0);
    let last = 0;
    for (let t = game.together!.t0; t <= game.together!.t1; t += 500) {
      const [x, y] = scoreAt(game, t);
      expect(x + y).toBeGreaterThanOrEqual(last);
      last = x + y;
    }
    expect(last).toBe(game.goals!.length);
  });

  it("animates a track as keyframes in percent of the picture, in order, ending in the seat", () => {
    const coffee = seen.get("coffee")!;
    const track = coffee.tracks[0]!;
    const frames = trackFrames(track, layout.view);
    expect(frames[0]!.offset).toBe(0);
    expect(frames.at(-1)!.offset).toBe(1);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.offset).toBeGreaterThanOrEqual(frames[i - 1]!.offset);
    for (const f of frames) expect(f.transform).toMatch(/^translate\(-?[\d.]+%, -?[\d.]+%\)$/);
    const home = life.find((p) => p.id === track.personId)!.home.spot;
    const s = project(home.at.x, home.at.y, home.z);
    const x = ((s.x - layout.view.x) / layout.view.width) * 100;
    expect(frames.at(-1)!.transform).toBe(`translate(${x.toFixed(3)}%, ${(((s.y - layout.view.y) / layout.view.height) * 100).toFixed(3)}%)`);
    // The scene redraws at the next leg or line, not per frame.
    const next = nextChange([coffee], coffee.start + 1);
    expect(next).toBeGreaterThan(coffee.start + 1);
    expect(next).toBeLessThanOrEqual(coffee.end);
    expect(nextChange([coffee], coffee.end + 1)).toBeUndefined();
  });
});

describe("office cards: collision layout", () => {
  /** Faces and their tags, as the scene places them, for a team where everyone at a desk is busy. */
  function scene(n: number, scale: number) {
    const people = team(n, Object.fromEntries(["pointer", ...Array.from({ length: n }, (_, i) => `a${i}`)].map((id) => [id, "working" as OfficeState])));
    const layout = officeLayout(people, []);
    const byId = new Map(people.map((p) => [p.id, p]));
    const faces = layout.placements.map((p) => {
      const person = byId.get(p.personId)!;
      return { id: p.personId, at: p.at, tag: `${person.name} · ${person.role}` };
    });
    const bubbles: BubbleRequest[] = layout.placements.map((p, i) => ({ id: p.personId, at: p.at, chars: 24 + (i % 4) * 9 }));
    const input = { layout, scale, faceRadius: scale < 0.85 ? 24 : 28, faces, boxes: [], bubbles, maxWidth: scale < 0.85 ? 160 : 190 };
    return { layout, input, spots: placeBubbles(input) };
  }

  for (const [n, scale] of [
    [7, 0.92],
    [7, 0.75],
    [12, 0.8],
    [3, 1],
  ] as const) {
    it(`keeps every card off every face, name tag and other card (${n} agents, scale ${scale})`, () => {
      const { layout, input, spots } = scene(n, scale);
      const fixed = fixedRects(input);
      const boxes = input.bubbles.map((b) => {
        const s = spots[b.id]!;
        const c = { x: (b.at.x - layout.view.x) * scale + s.dx, y: (b.at.y - layout.view.y) * scale + s.dy };
        return { id: b.id, r: around(c, s.width, s.height) };
      });
      for (const b of boxes) {
        for (const f of fixed) {
          if (f.id === b.id && f.kind === "face") continue;
          expect(overlap(b.r, f.r), `${b.id}'s card on ${f.id}'s ${f.kind}`).toBe(0);
        }
        for (const o of boxes) if (o !== b) expect(overlap(b.r, o.r), `${b.id}'s card on ${o.id}'s card`).toBe(0);
        expect(b.r.x0).toBeGreaterThanOrEqual(0);
        expect(b.r.y0).toBeGreaterThanOrEqual(0);
        expect(b.r.x1).toBeLessThanOrEqual(layout.view.width * scale);
      }
    });
  }

  it("moves a card that would hide the name tag in front of it, and keeps the tail only when just above", () => {
    const layout = { view: { x: 0, y: 0, width: 600, height: 400 } };
    // Pointer sits right below Gemini: Gemini's card above its face is fine; Pointer's own card must not cover Gemini's tag.
    const gemini = { id: "gemini", at: { x: 300, y: 160 }, tag: "Gemini · Researcher" };
    const pointer = { id: "pointer", at: { x: 300, y: 250 }, tag: "Pointer · Lead" };
    const input = { layout, scale: 1, faceRadius: 28, faces: [gemini, pointer], boxes: [], bubbles: [gemini, pointer].map((f) => ({ id: f.id, at: f.at, chars: 40 })) };
    const spots = placeBubbles(input);
    const tagOf = (f: typeof gemini) => around({ x: f.at.x, y: f.at.y + TAG_DY }, tagWidth(f.tag), 26);
    const cardOf = (f: typeof gemini) => around({ x: f.at.x + spots[f.id]!.dx, y: f.at.y + spots[f.id]!.dy }, spots[f.id]!.width, spots[f.id]!.height);
    expect(overlap(cardOf(pointer), tagOf(gemini))).toBe(0);
    expect(overlap(cardOf(gemini), tagOf(pointer))).toBe(0);
    expect(overlap(cardOf(gemini), cardOf(pointer))).toBe(0);
    expect(spots.gemini!.tail).toBeDefined();
    expect(placeBubbles(input)).toEqual(spots);
  });

  it("makes short pills for notes and one-line cards for statuses", () => {
    const layout = { view: { x: 0, y: 0, width: 400, height: 300 } };
    const spots = placeBubbles({
      layout,
      scale: 1,
      faceRadius: 28,
      faces: [{ id: "x", at: { x: 200, y: 150 }, tag: "X" }],
      boxes: [],
      bubbles: [{ id: "x", at: { x: 200, y: 150 }, chars: 14, kind: "pill" }],
    });
    expect(spots.x!.height).toBeLessThan(30);
    expect(spots.x!.width).toBeLessThan(150);
  });
});

/** Every outing the director starts over `ms` from T0, by id. */
function outings(n: number, ms: number, step = 2_000) {
  const { people, layout, life } = setup(n);
  const byId = new Map<string, Activity>();
  run(layout, life, T0, T0 + ms, step, (s) => s.activities.forEach((a) => byId.set(a.id, a)));
  return { people, layout, life, all: [...byId.values()], names: new Map(life.map((p) => [p.id, p.name])) };
}

describe("office games: ping pong, pinball, video games and coffee for two", () => {
  const { layout, life, all, names } = outings(7, 6 * 3_600_000);
  const games = all.filter((a) => a.kind === "pingpong");
  const pinball = all.filter((a) => a.kind === "pinball");

  it("plays ping pong in rallies: strokes alternate, the last to hit wins the point, the serve changes every two points, a winner at the end", () => {
    expect(games.length).toBeGreaterThan(2);
    for (const g of games) {
      const { t0, t1 } = g.together!;
      const strokes = g.strokes!;
      const goals = g.goals!;
      // Strokes a crossing apart make a rally; a point and a pause come between rallies.
      const rallies: (typeof strokes)[] = [];
      for (const s of strokes) {
        const last = rallies.at(-1);
        if (last && s.at - last.at(-1)!.at === STROKE_MS) last.push(s);
        else rallies.push([s]);
      }
      expect(goals.length).toBeGreaterThan(0);
      expect(rallies).toHaveLength(goals.length);
      rallies.forEach((rally, k) => {
        expect(rally[0]!.by, `rally ${k}: the server`).toBe(Math.floor(k / 2) % 2);
        expect(rally.length).toBeGreaterThanOrEqual(2);
        expect(rally.length).toBeLessThanOrEqual(8);
        rally.forEach((s, i) => i > 0 && expect(s.by).toBe(1 - rally[i - 1]!.by));
        const last = rally.at(-1)!;
        expect(goals[k]).toEqual({ at: last.at + STROKE_MS, by: last.by });
        expect(rally[0]!.at).toBeGreaterThanOrEqual(t0);
        expect(goals[k]!.at + MISS_MS).toBeLessThanOrEqual(t1);
      });
      const [a, b] = scoreAt(g, t1);
      expect(a + b).toBe(goals.length);
      expect(scoreAt(g, t0)).toEqual([0, 0]);
      const cheers = g.tracks.map((t) => sayingAt(t, t1)?.text);
      expect(cheers).toEqual(a === b ? ["gg!", "gg!"] : a > b ? ["🏆", "gg!"] : ["gg!", "🏆"]);
    }
  });

  it("keeps each ping pong player at their end of the table, paddle in hand from leaving their desk to sitting back down", () => {
    for (const g of games) {
      g.tracks.forEach((t, i) => {
        const end = layout.life.pingpong.ends[i]!;
        expect(legAt(t, g.together!.t0 + 1)!.to).toEqual({ x: end.at.x, y: end.at.y, z: STAND_Z });
        for (const leg of t.legs.filter((l) => l.pose !== "sit")) expect(leg.prop).toBe("paddle");
      });
    }
  });

  it("flies the ball from paddle to paddle: at the hitter's end on each stroke, over the net, a bounce on the far half, past the one who missed, hidden between rallies", () => {
    const table = layout.life.pingpong;
    const cx = table.x + table.w / 2;
    const reach = table.w / 2 + 6;
    const top = PINGPONG.h + 2;
    for (const g of games) {
      expect(ballAt(g, table, g.strokes![0]!.at - 1)).toBeUndefined();
      for (const s of g.strokes!) {
        const toward = s.by === 0 ? 1 : -1;
        expect(ballAt(g, table, s.at)!.x).toBeCloseTo(cx - toward * reach, 6);
        expect(ballAt(g, table, s.at + STROKE_MS / 2)!.z).toBeGreaterThan(PINGPONG.h + 6);
        const bounce = ballAt(g, table, s.at + STROKE_MS * BOUNCE_K)!;
        expect(bounce.z).toBeCloseTo(top, 3);
        expect(Math.sign(bounce.x - cx)).toBe(toward);
      }
      for (const goal of g.goals!) {
        const dropped = ballAt(g, table, goal.at + MISS_MS - 1)!;
        expect(Math.abs(dropped.x - cx)).toBeGreaterThan(reach);
        expect(dropped.z).toBeLessThan(5);
        expect(ballAt(g, table, goal.at + MISS_MS + 10)).toBeUndefined();
      }
      // The scene's one Web Animation for the game: in order, hidden between rallies.
      const path = ballFrames(g, table)!;
      expect(path.start).toBe(g.strokes![0]!.at);
      expect(path.frames[0]!.offset).toBe(0);
      for (let i = 1; i < path.frames.length; i++) expect(path.frames[i]!.offset).toBeGreaterThanOrEqual(path.frames[i - 1]!.offset);
      expect(path.frames.filter((f) => f.opacity === 0).length).toBeGreaterThanOrEqual(g.goals!.length);
      for (const f of path.frames) expect(f.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
    }
  });

  it("plays pinball: the score counts up to what the ball scored, hands on the buttons, a friend beside the player, a high score at the end", () => {
    expect(pinball.some((g) => g.people.length === 1)).toBe(true);
    expect(pinball.some((g) => g.people.length === 2)).toBe(true);
    const m = layout.life.pinball;
    for (const g of pinball) {
      const { t0, t1 } = g.together!;
      const bumps = g.bumps!;
      expect(bumps.length).toBeGreaterThan(5);
      for (const b of bumps) {
        expect(b.at).toBeGreaterThan(t0);
        expect(b.at).toBeLessThan(t1);
      }
      expect(pointsAt(g, t0)).toBe(0);
      let last = 0;
      for (let t = t0; t <= t1 + 3_000; t += 250) {
        const score = pointsAt(g, t);
        expect(score).toBeGreaterThanOrEqual(last);
        last = score;
      }
      expect(last).toBe(bumps.reduce((sum, b) => sum + b.points, 0));
      const [player, watcher] = g.tracks;
      const playing = legAt(player!, t0 + 1)!;
      expect(playing.isAtPinball).toBe(true);
      expect(playing.to).toEqual({ x: m.player.at.x, y: m.player.at.y, z: STAND_Z });
      expect(sayingAt(player!, t1)?.text).toBe("high score! 🎉");
      if (watcher) {
        const watching = legAt(watcher, t0 + 1)!;
        expect(watching.to).toEqual({ x: m.watcher.at.x, y: m.watcher.at.y, z: STAND_Z });
        expect(watching.isAtPinball).toBeUndefined();
        expect(lifeNote(g, watcher.personId, (id) => names.get(id), t0)?.text).toBe(`Watching ${names.get(player!.personId)} play pinball`);
      }
      expect(lifeNote(g, player!.personId, (id) => names.get(id), t0)?.text).toBe("Playing pinball");
    }
    const g = games[0]!;
    expect(lifeNote(g, g.people[0]!, (id) => names.get(id), g.start)?.text).toBe(`Playing ping pong with ${names.get(g.people[1]!)}`);
  });

  it("makes coffee for two: the first one brews both cups, the other waits at the kitchen table without one until it comes", () => {
    const two = all.filter((a) => a.kind === "coffee" && a.people.length === 2);
    expect(two.length).toBeGreaterThan(0);
    for (const c of two) {
      expect(c.venues).toEqual(["coffee", "cafe"]);
      expect(c.brew!.t1 - c.brew!.t0).toBe(8_000);
      const [maker, friend] = c.tracks;
      const served = maker!.legs.find((l) => l.pose === "sit" && l.prop === "cup")!.t1;
      for (const leg of friend!.legs.filter((l) => l.t1 <= served)) expect(leg.prop).toBeUndefined();
      expect(legAt(friend!, c.together!.t0 + 1)!.prop).toBe("cup");
      const [a, b] = c.people as [string, string];
      expect(lifeNote(c, a, (id) => names.get(id), c.brew!.t0 + 1)?.text).toBe(`Making coffee for ${names.get(b)}`);
      expect(lifeNote(c, a, (id) => names.get(id), c.together!.t0)?.text).toBe(`Having a coffee with ${names.get(b)}`);
      expect(lifeNote(c, b, (id) => names.get(id), c.brew!.t0 + 1)?.text).toBe(`Having a coffee with ${names.get(a)}`);
    }
  });

  it("plays video games on the beanbags: alone, the cash climbs to a new record; for two, races and a winner", () => {
    const gaming = all.filter((a) => a.kind === "gaming");
    const solo = gaming.filter((g) => g.people.length === 1);
    const pairs = gaming.filter((g) => g.people.length === 2);
    expect(solo.length).toBeGreaterThan(0);
    expect(pairs.length).toBeGreaterThan(0);
    for (const g of solo) {
      const { t0, t1 } = g.together!;
      expect(g.goals).toBeUndefined();
      expect(g.bumps!.length).toBeGreaterThan(5);
      for (const b of g.bumps!) {
        expect(b.at).toBeGreaterThan(t0);
        expect(b.at).toBeLessThan(t1);
      }
      expect(pointsAt(g, t0)).toBe(0);
      let last = 0;
      for (let t = t0; t <= t1; t += 250) {
        expect(pointsAt(g, t)).toBeGreaterThanOrEqual(last);
        last = pointsAt(g, t);
      }
      expect(last).toBe(g.bumps!.reduce((sum, b) => sum + b.points, 0));
      expect(sayingAt(g.tracks[0]!, t1)?.text).toBe("new record! 🎉");
      expect(lifeNote(g, g.people[0]!, (id) => names.get(id), t0)).toEqual({ emoji: "🎮", text: "Playing video games", short: "video games" });
    }
    for (const g of pairs) {
      const { t0, t1 } = g.together!;
      expect(g.bumps).toBeUndefined();
      expect(g.goals!.length).toBeGreaterThan(1);
      for (const race of g.goals!) {
        expect(race.at).toBeGreaterThan(t0);
        // Each race's shout is over before the winner's moment.
        expect(race.at + 1_600).toBeLessThanOrEqual(t1);
        expect(sayingAt(g.tracks[race.by]!, race.at)).toBeDefined();
      }
      const [a, b] = scoreAt(g, t1);
      expect(a + b).toBe(g.goals!.length);
      expect(g.tracks.map((t) => sayingAt(t, t1)?.text)).toEqual(a === b ? ["gg!", "gg!"] : a > b ? ["🏆", "gg!"] : ["gg!", "🏆"]);
      const [p, q] = g.people as [string, string];
      expect(lifeNote(g, p, (id) => names.get(id), t0)?.text).toBe(`Playing video games with ${names.get(q)}`);
      expect(lifeNote(g, q, (id) => names.get(id), t0)?.text).toBe(`Playing video games with ${names.get(p)}`);
    }
  });

  it("seats the video game players on the beanbags facing the TV, a controller in hand only while they sit there", () => {
    const { seats } = layout.life.gaming;
    for (const g of all.filter((a) => a.kind === "gaming")) {
      expect(g.venues).toEqual(["gaming"]);
      g.tracks.forEach((t, i) => {
        const seat = seats[i]!;
        const playing = legAt(t, g.together!.t0 + 1)!;
        expect(playing.to).toEqual({ x: seat.at.x, y: seat.at.y, z: BEANBAG_Z });
        expect(playing.pose).toBe("sit");
        // The TV is on the back-left wall: they look left, at it.
        expect(playing.look).toBe(-1);
        expect(seat.look).toBe(-1);
        for (const leg of t.legs) {
          const isOnBeanbag = leg.pose === "sit" && leg.to.x === seat.at.x && leg.to.y === seat.at.y;
          expect(leg.prop === "controller", `${g.id}: a ${leg.pose} leg`).toBe(isOnBeanbag);
        }
      });
    }
  });

  it("sends video game players back when one gets work, and closes the corner while a meeting sits next to it", () => {
    const { people, layout: l, life: lp } = setup(7);
    let state = advance(undefined, lp, l, T0);
    let t = T0;
    let game: Activity | undefined;
    for (; t < T0 + 6 * 3_600_000 && !game; t += 1_000) {
      state = advance(state, lp, l, t);
      game = state.activities.find((a) => a.kind === "gaming" && a.people.length === 2 && a.together && t > a.together.t0);
    }
    expect(game).toBeDefined();
    const [worker, friend] = game!.people as [string, string];
    const busy = people.map((p) => (p.id === worker ? { ...p, state: "working" as const } : p));
    const next = advance(state, lifePeople({ people: busy }, l), l, t);
    expect(next.activities.find((a) => a.id === game!.id)).toBeUndefined();
    expect(next.activities.find((a) => a.kind === "return" && a.people[0] === worker)!.gotWork).toBe(true);
    expect(next.activities.find((a) => a.kind === "return" && a.people[0] === friend)!.gotWork).toBe(false);
    // A meeting at the big table: its card is over the corner, and a meeting wants quiet. With a lounge or without.
    for (const n of [3, 7]) {
      const busyTeam = team(n, { pointer: "meeting", a0: "meeting" });
      const room = officeLayout(busyTeam, [meeting(["pointer", "a0"])]);
      const kinds = new Set<string>();
      run(room, lifePeople({ people: busyTeam }, room), T0, T0 + 2 * 3_600_000, 2_000, (s) => {
        for (const a of s.activities) {
          kinds.add(a.kind);
          expect(a.venues, `${n} agents`).not.toContain("gaming");
        }
      });
      expect(kinds.size, `${n} agents`).toBeGreaterThan(2);
    }
  });

  it("holds the ping pong table, the pinball machine and the video game corner while they are in use: nobody else starts a game there", () => {
    // Someone (unseen) holds all three for two hours: no game starts at any.
    const start = advance(undefined, life, layout, T0);
    const holder: Activity = { id: "held", kind: "pingpong", people: [], start: T0, end: T0 + 2 * 3_600_000, tracks: [], venues: ["pingpong", "pinball", "gaming"] };
    const kinds = new Set<string>();
    run(
      layout,
      life,
      T0,
      T0 + 2 * 3_600_000 - 1_000,
      2_000,
      (s) => {
        for (const a of s.activities) {
          kinds.add(a.kind);
          if (a === holder) continue;
          expect(a.venues).not.toContain("pingpong");
          expect(a.venues).not.toContain("pinball");
          expect(a.venues).not.toContain("gaming");
        }
      },
      { ...start, activities: [...start.activities, holder] },
    );
    expect(kinds).toContain("foosball");
    // Left alone, the machine and the TV are never played twice at once (a game for one and one for two could otherwise overlap).
    run(layout, life, T0, T0 + 6 * 3_600_000, 1_000, (s) => {
      for (const venue of ["pingpong", "pinball", "foosball", "gaming"]) expect(s.activities.filter((a) => a.venues.includes(venue)).length, venue).toBeLessThanOrEqual(1);
    });
  });

  it("puts every game's players clear of the seated people's faces and name tags, for any team size", () => {
    const FACE = 28;
    const STANDING = 24;
    for (const n of [0, 1, 3, 6, 7, 9, 12, 16, 20]) {
      const { people, layout: l } = setup(n);
      const byId = new Map(people.map((p) => [p.id, p]));
      const seated = l.placements.flatMap((p) => {
        const who = byId.get(p.personId)!;
        return [
          { what: `${p.personId}'s face`, r: around(p.at, FACE * 2, FACE * 2) },
          { what: `${p.personId}'s name`, r: around({ x: p.at.x, y: p.at.y + TAG_DY }, tagWidth(`${who.name} · ${who.role}`), 26) },
        ];
      });
      const g = l.life;
      for (const [name, spot] of [
        ["ping pong 1", g.pingpong.ends[0]],
        ["ping pong 2", g.pingpong.ends[1]],
        ["pinball", g.pinball.player],
        ["watcher", g.pinball.watcher],
      ] as const) {
        const face = around(project(spot.at.x, spot.at.y, STAND_Z), STANDING * 2, STANDING * 2);
        const feet = project(spot.at.x, spot.at.y, 3);
        const tag = around({ x: feet.x, y: feet.y + 13 }, tagWidth("Kenji"), 26);
        for (const s of seated) {
          expect(overlap(face, s.r), `${n} agents: the ${name} player's face on ${s.what}`).toBe(0);
          if (s.what.endsWith("face")) expect(overlap(tag, s.r), `${n} agents: the ${name} player's name on ${s.what}`).toBe(0);
        }
      }
      // On the beanbags they sit: a seated face, its name under it.
      g.gaming.seats.forEach((seat, i) => {
        const at = project(seat.at.x, seat.at.y, BEANBAG_Z);
        const face = around(at, FACE * 2, FACE * 2);
        const tag = around({ x: at.x, y: at.y + TAG_DY }, tagWidth("Kenji"), 26);
        for (const s of seated) {
          expect(overlap(face, s.r), `${n} agents: video game player ${i + 1}'s face on ${s.what}`).toBe(0);
          if (s.what.endsWith("face")) expect(overlap(tag, s.r), `${n} agents: video game player ${i + 1}'s name on ${s.what}`).toBe(0);
        }
      });
    }
  });
});

describe("office talk: real lines in the bubbles", () => {
  const { all, names } = outings(7, 6 * 3_600_000);
  const chat = all.find((a) => a.kind === "chat")!;
  const game = all.find((a) => a.kind === "pingpong")!;
  const lines = (a: Activity, texts: string[]): TalkLine[] => texts.map((text, i) => ({ speaker: a.people[i % a.people.length]!, text }));

  it("asks only for a chat, a coffee for two, a game for two (a video game too) or pinball with a friend, by an id made of the slot and the people", () => {
    const asked = new Set<string>();
    for (const a of all) {
      const r = talkRequest(a);
      const isSocial = a.together !== undefined && a.people.length >= 2 && ["chat", "coffee", "foosball", "pingpong", "pinball", "gaming"].includes(a.kind);
      expect(Boolean(r), `${a.kind} for ${a.people.length}`).toBe(isSocial);
      if (!r) continue;
      expect(r).toEqual({ activityId: `${a.id}:${a.people.join(".")}`, kind: a.kind, people: a.people });
      expect(r.activityId).toMatch(/^[A-Za-z0-9:._-]{1,120}$/);
      asked.add(r.activityId);
    }
    for (const kind of ["chat", "coffee", "foosball", "pingpong", "pinball", "gaming"]) expect([...asked].some((id) => id.startsWith(`${kind}:`)), kind).toBe(true);
    // A video game alone has no talk: it takes two.
    const solo = all.find((a) => a.kind === "gaming" && a.people.length === 1)!;
    expect(solo.together).toBeDefined();
    expect(talkRequest(solo)).toBeUndefined();
    expect(talkRequest({ ...chat, people: [chat.people[0]!] })).toBeUndefined();
    expect(talkRequest({ ...chat, together: undefined })).toBeUndefined();
  });

  it("asks once per conversation, and never for one whose talk is over (an outing replayed from the past)", () => {
    const now = chat.together!.t0;
    const due = talkDue([chat], now, new Set());
    expect(due).toEqual([{ request: talkRequest(chat), window: chat.together }]);
    expect(talkDue([chat], now, new Set([talkRequest(chat)!.activityId]))).toEqual([]);
    expect(talkDue([chat], chat.together!.t1, new Set())).toEqual([]);
    expect(talkDue([chat], chat.together!.t1 - 1, new Set())).toHaveLength(1);
    expect(talkDue(all.filter((a) => a.people.length === 1), 0, new Set())).toEqual([]);
  });

  it("keeps only lines said by the people, as one plain line of at most 140 characters, at most eight, and needs two", () => {
    const [a, b] = chat.people as [string, string];
    const long = "word ".repeat(60);
    const cleaned = cleanLines(
      [{ speaker: a, text: "  hi\n there  " }, { speaker: "mallory", text: "not here" }, { speaker: b, text: 42 }, null, { speaker: b, text: long }, { speaker: a, text: "   " }],
      [a, b],
    );
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]).toEqual({ speaker: a, text: "hi there" });
    expect(cleaned[1]!.speaker).toBe(b);
    expect(cleaned[1]!.text.length).toBeLessThanOrEqual(TALK_TEXT_MAX);
    expect(cleaned[1]!.text.endsWith("…")).toBe(true);
    expect(cleanLines([{ speaker: a, text: "alone" }], [a, b])).toEqual([]);
    expect(cleanLines("nope", [a, b])).toEqual([]);
    expect(cleanLines(Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? a : b, text: `line ${i}` })), [a, b])).toHaveLength(8);
  });

  it("gives each line time to read by its length, in turn, and squeezes or ends the talk to fit its window", () => {
    expect(readMs("ok")).toBe(READ_MIN_MS);
    expect(readMs("x".repeat(60))).toBeGreaterThan(readMs("x".repeat(30)));
    const said = lines(chat, ["Morning! Coffee first?", "Always. Did the deploy go out?", "It did, all green.", "Nice work."]);
    const roomy = talkSchedule(said, { t0: 1_000, t1: 200_000 });
    expect(roomy.map((l) => l.speaker)).toEqual(said.map((l) => l.speaker));
    expect(roomy[0]!.t0).toBe(1_000);
    roomy.forEach((l, i) => {
      expect(l.t1 - l.t0).toBe(readMs(l.text));
      if (i) expect(l.t0).toBe(roomy[i - 1]!.t1 + 350);
    });
    // A short window: every line shorter alike, all of them in.
    const total = roomy.at(-1)!.t1 - roomy[0]!.t0;
    const tight = talkSchedule(said, { t0: 0, t1: Math.round(total * 0.75) });
    expect(tight).toHaveLength(said.length);
    tight.forEach((l, i) => expect(l.t1 - l.t0).toBeLessThan(roomy[i]!.t1 - roomy[i]!.t0));
    expect(tight.at(-1)!.t1).toBeLessThanOrEqual(Math.round(total * 0.75));
    // Far too short: never below a readable minimum; the talk ends before the first line that does not fit.
    const cut = talkSchedule(said, { t0: 0, t1: 4_000 });
    expect(cut.map((l) => l.text)).toEqual(said.slice(0, cut.length).map((l) => l.text));
    expect(cut.length).toBeLessThan(said.length);
    for (const l of cut) expect(l.t1 - l.t0).toBeGreaterThanOrEqual(1_600);
  });

  it("shows the talk in the bubbles instead of the canned lines, from the moment it arrives, without touching the walk or the lines outside the window", () => {
    const said = lines(game, ["Your serve. Did the deploy go out?", "It did! Lina fixed the flaky test.", "3-1 me, by the way.", "Not for long."]);
    const { t0, t1 } = game.together!;
    const talked = withTalk(game, said, t0 - 5_000);
    const schedule = talkSchedule(said, game.together!);
    talked.tracks.forEach((track, i) => {
      const before = game.tracks[i]!;
      // The same legs: the scene keeps animating the walk as it was.
      expect(track.legs).toBe(before.legs);
      const inWindow = track.says.filter((s) => s.t0 >= t0 && s.t0 < t1);
      expect(inWindow.every((s) => s.isTalk)).toBe(true);
      expect(inWindow.map((s) => s.text)).toEqual(schedule.filter((l) => l.speaker === track.personId).map((l) => l.text));
      // The game's end ("🏆", "gg!") stays.
      expect(track.says.filter((s) => s.t0 >= t1)).toEqual(before.says.filter((s) => s.t0 >= t1));
    });
    // Each line in its time, on the right person.
    for (const l of schedule) expect(sayingAt(talked.tracks.find((t) => t.personId === l.speaker)!, l.t0 + 1)?.text).toBe(l.text);
    // The scene redraws when a line starts.
    expect(nextChange([talked], schedule[1]!.t0 - 1)).toBe(schedule[1]!.t0);
  });

  it("keeps the canned lines already said when the talk arrives late, and plays the canned ones when there is no talk", () => {
    const said = lines(chat, ["Hey, how was the planning call?", "Long, but we have a plan.", "Good. Lunch later?", "Yes, at one."]);
    const schedule = talkSchedule(said, chat.together!);
    const late = schedule[1]!.t0 + 1_000;
    const talked = withTalk(chat, said, late);
    const says = talked.tracks.flatMap((t) => t.says).sort((p, q) => p.t0 - q.t0);
    // What was said before stays (cut where the talk starts); the first talk line still readable shows from its arrival.
    for (const s of chat.tracks.flatMap((t) => t.says).filter((x) => x.t0 < late)) {
      expect(says.some((x) => !x.isTalk && x.t0 === s.t0 && x.text === s.text && x.t1 === Math.min(s.t1, late))).toBe(true);
    }
    const shown = says.filter((s) => s.isTalk);
    expect(shown[0]).toMatchObject({ text: schedule[1]!.text, t0: late });
    expect(shown.map((s) => s.text)).toEqual(schedule.slice(1).map((l) => l.text));
    expect(says.filter((s) => !s.isTalk && s.t0 >= late && s.t0 < chat.together!.t1)).toEqual([]);
    // No lines, or too late for any: the activity as planned.
    expect(withTalk(chat, [], chat.start)).toBe(chat);
    expect(withTalk(chat, said, chat.together!.t1)).toBe(chat);
  });

  it("lists what a person said in the office, newest first, with the lines said so far", () => {
    const a = chat.people[0]!;
    const entry = (id: string, at: number) => ({ activityId: id, kind: "chat" as const, people: chat.people, lines: talkSchedule(lines(chat, ["one", "two", "three"]), { t0: at, t1: at + 60_000 }) });
    const older = entry("chat:1:2", 1_000);
    const newer = entry("chat:2:2", 100_000);
    const later = entry("chat:3:2", 900_000);
    const log = talksOf([older, newer, later], a, newer.lines[1]!.t0);
    expect(log.map((e) => e.activityId)).toEqual(["chat:2:2", "chat:1:2"]);
    expect(log[0]!.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(talksOf([older], "nobody", 1e12)).toEqual([]);
    expect(talkTitle({ kind: "pingpong", people: game.people }, game.people[0]!, (id) => names.get(id)!)).toBe(`Ping pong with ${names.get(game.people[1]!)}`);
    expect(talkTitle({ kind: "chat", people: ["a", "b", "c"] }, "a", (id) => id.toUpperCase())).toBe("Chat with B and C");
    expect(talkTitle({ kind: "gaming", people: ["a", "b"] }, "b", (id) => id.toUpperCase())).toBe("Video games with A");
  });

  /** The lines of real talk in an activity's bubbles, in order. */
  const talkOf = (a: Activity) =>
    a.tracks
      .flatMap((t) => t.says)
      .filter((x) => x.isTalk)
      .sort((p, q) => p.t0 - q.t0);

  it("ends the talk at the first line that does not fit: a reply never shows without the line before it", () => {
    const [a, b] = chat.people as [string, string];
    // Squeezed into 6 s, the long third line does not fit; the short last one alone would.
    const said: TalkLine[] = [
      { speaker: a, text: "Coffee?" },
      { speaker: b, text: "Yes please." },
      { speaker: a, text: "So the flaky checkout test was a race between the cart reload and the price refresh, and Lina found it in the end." },
      { speaker: b, text: "Ha, nice." },
    ];
    const window = { t0: 0, t1: 6_000 };
    const cut = talkSchedule(said, window);
    expect(cut.map((l) => l.text)).toEqual([said[0]!.text, said[1]!.text]);
    expect(window.t1 - cut[1]!.t1).toBeGreaterThan(1_600 + 350);
  });

  it("drops a line the answer came too late for: less than MIN_LEFT_MS left to read it", () => {
    const said = lines(chat, ["Hey, how was the planning call?", "Long, but we have a plan.", "Good. Lunch later?", "Yes, at one."]);
    const schedule = talkSchedule(said, chat.together!);
    const line = schedule[1]!;
    // Just enough left to read it: it shows, from the answer's arrival.
    expect(talkOf(withTalk(chat, said, line.t1 - MIN_LEFT_MS))[0]).toMatchObject({ text: line.text, t0: line.t1 - MIN_LEFT_MS, t1: line.t1 });
    // A moment later it never shows: the talk starts with the next line, at its time.
    const late = talkOf(withTalk(chat, said, line.t1 - MIN_LEFT_MS + 1));
    expect(late[0]).toMatchObject({ text: schedule[2]!.text, t0: schedule[2]!.t0 });
    expect(late.map((x) => x.text)).toEqual(schedule.slice(2).map((l) => l.text));
  });

  it("keeps for the drawer only the lines that were on screen: none the answer came too late for, none after the outing was cut short", () => {
    const said = lines(game, ["Your serve.", "Did the deploy go out?", "It did, all green.", "Lina fixed the flaky test.", "Three one me, by the way.", "Not for long."]);
    const window = game.together!;
    const schedule = talkSchedule(said, window);
    // Arriving with half a second of the second line left: the bubbles and the drawer agree, from the third line on.
    const since = schedule[1]!.t1 - 500;
    const shown = shownLines(said, window, since);
    expect(shown[0]!.text).toBe(schedule[2]!.text);
    expect(talkOf(withTalk(game, said, since)).map((x) => [x.text, x.t0, x.t1])).toEqual(shown.map((l) => [l.text, l.t0, l.t1]));
    // Cut short just after the fourth line started: the lines that started before, and none after.
    const until = schedule[3]!.t0 + 300;
    const cut = shownLines(said, window, since, until);
    expect(cut.map((l) => l.text)).toEqual([schedule[2]!.text, schedule[3]!.text]);
    const entry = { activityId: "pingpong:1:2", kind: "pingpong" as const, people: game.people, lines: cut };
    expect(talksOf([entry], game.people[0]!, window.t1 + 60_000)[0]!.lines.map((l) => l.text)).toEqual([schedule[2]!.text, schedule[3]!.text]);
  });

  it("notes when a conversation leaves the plan: someone got work and walked back", () => {
    const { people, layout: l, life: lp } = setup(7);
    let state = advance(undefined, lp, l, T0);
    let t = T0;
    let talk: Activity | undefined;
    for (; t < T0 + 3 * 3_600_000 && !talk; t += 1_000) {
      state = advance(state, lp, l, t);
      talk = state.activities.find((a) => talkRequest(a) && a.together && t > a.together.t0 + 3_000);
    }
    expect(talk).toBeDefined();
    const id = talkRequest(talk!)!.activityId;
    const was = plannedTalk(state.activities);
    expect(was.has(id)).toBe(true);
    // Nothing changed: nothing left.
    expect(leftThePlan(was, plannedTalk(advance(state, lp, l, t).activities))).toEqual([]);
    const busy = people.map((p) => (p.id === talk!.people[0] ? { ...p, state: "working" as const } : p));
    const next = advance(state, lifePeople({ people: busy }, l), l, t);
    expect(leftThePlan(was, plannedTalk(next.activities))).toEqual([id]);
    // From then on, nothing more of it is listed.
    const said = lines(talk!, ["one", "two", "three", "four", "five", "six"]);
    const listed = shownLines(said, talk!.together!, talk!.together!.t0, t);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(shownLines(said, talk!.together!, talk!.together!.t0).length);
    for (const line of listed) expect(line.t0).toBeLessThan(t);
  });
});

describe("office talk settings", () => {
  it("sets a model only with Gemini or the chat model: Auto always uses the default models", () => {
    expect(picksModel("auto")).toBe(false);
    expect(picksModel("gemini")).toBe(true);
    expect(picksModel("chat")).toBe(true);
    const saved = { enabled: true, provider: "auto" as const, model: "gemini-2.5-flash", dailyMax: 40 };
    // A model left on Auto from before: the dialog drops it, so saving is never refused; the view's extra fields stay out.
    expect(settingsDraft({ ...saved, usedToday: 3, available: { gemini: true, chat: true } })).toEqual({ ...saved, model: "" });
    expect(settingsDraft({ ...saved, provider: "gemini" })).toEqual({ ...saved, provider: "gemini" });
    // Another provider starts at its default model.
    expect(withProvider({ ...saved, provider: "gemini" }, "chat")).toEqual({ ...saved, provider: "chat", model: "" });
    expect(withProvider({ ...saved, provider: "chat" }, "auto")).toEqual({ ...saved, model: "" });
  });
});
