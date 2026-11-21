import { describe, expect, it } from "vitest";
import type { OfficeMeeting, OfficePerson, OfficeState } from "../src/team/office.js";
import { type BubbleRequest, TAG_DY, around, fixedRects, overlap, placeBubbles, tagWidth } from "../web/src/pages/office/bubbles.js";
import { type Floor, type LifeSpot, type SceneLayout, STAND_Z, deskSeat, officeLayout, project } from "../web/src/pages/office/layout.js";
import {
  type Activity,
  type LifePerson,
  type LifeState,
  LOOKBACK_MS,
  MAX_AWAY,
  SLOT_MS,
  WALK,
  advance,
  lifeNote,
  lifePeople,
  nextChange,
  nextEvent,
  positionAt,
  proposalsBetween,
  scoreAt,
  slotPlan,
  trackFrames,
} from "../web/src/pages/office/life.js";
import { isClear, isInside, pathLength, route } from "../web/src/pages/office/paths.js";

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
  return [l.coffee, ...l.cafe, ...l.sofa, ...l.foosball.ends, l.shelf, ...l.windows, ...l.plants];
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
        if (a.kind === "chat" || a.kind === "foosball") {
          expect(new Set(a.people).size).toBe(2);
        } else {
          expect(a.people).toHaveLength(1);
        }
      }
    });
    // Varied: coffee, chats, games and solo moments all happen in two hours.
    for (const k of ["coffee", "chat", "foosball", "read", "water", "stretch", "window"]) expect(kinds, k).toContain(k);
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
