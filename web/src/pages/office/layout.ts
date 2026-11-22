/**
 * Where everything goes in the office: an isometric room whose size follows
 * the team (one desk per agent, in rows of three to five), the fixed corners
 * (meeting table, kitchen, skills library, HR corner, Pointer's desk at the
 * front) and where each person is right now (at their desk, or around the
 * meeting table or the kitchen table when they are in a meeting). It also
 * holds what the office's life needs (life.ts, paths.ts): the spots free
 * agents go to (coffee machine, kitchen table, sofa, foosball, ping pong
 * table, pinball machine, the video game corner's beanbags, library,
 * windows, plants), the waypoints in the
 * aisles and on the open floor that walks go through, and the furniture they
 * walk round. Pure: the art
 * (OfficeArt) and the people on top of it (OfficeScene) both draw from it.
 *
 * World units: x runs along the back-right wall, y along the back-left wall,
 * z up. The 2:1 projection puts (0, 0, 0), the back corner, at the origin.
 */
import type { OfficeMeeting, OfficePerson } from "./model";

export interface Pt {
  x: number;
  y: number;
}

export const project = (x: number, y: number, z = 0): Pt => ({ x: x - y, y: (x + y) / 2 - z });

/** A point on the floor, in world units. */
export interface Floor {
  x: number;
  y: number;
}

export const WALL_H = 120;
export const FLOOR_T = 14;
export const DESK = { w: 64, d: 36, h: 30 };
export const LEAD_DESK = { w: 100, d: 44, h: 30 };
/** How high a sitting person's face is. */
export const FACE_Z = 52;
/** A standing person's face. */
export const STAND_Z = 70;
/** On a chair at a table (meeting or kitchen): a little lower than at a desk. */
export const SEAT_Z = FACE_Z - 6;
/** On the sofa, the lowest seat. */
export const SOFA_Z = FACE_Z - 4;

/**
 * A place someone goes to when they leave their desk: where they stand or
 * sit, the open floor they step in from (`door`), how high their face is
 * there and which way they look (1: right on screen, -1: left).
 */
export interface LifeSpot {
  at: Floor;
  door: Floor;
  z: number;
  pose: "stand" | "sit";
  look: 1 | -1;
}

/** Furniture people walk round, in world units, already widened by a person's half-width. */
export type Obstacle = { kind: "box"; x0: number; y0: number; x1: number; y1: number } | { kind: "oval"; cx: number; cy: number; rx: number; ry: number };

export interface Plant {
  x: number;
  y: number;
  size: number;
}

/** A game table's footprint (world units) and where its two players stand. */
export interface GameTable {
  x: number;
  y: number;
  w: number;
  d: number;
  ends: [LifeSpot, LifeSpot];
}

/** The video game corner: the TV's low stand against the back-left wall (its footprint; the screen faces the room, along +x) and the two beanbags in front of it. */
export interface GameCorner {
  x: number;
  y: number;
  w: number;
  d: number;
  seats: [LifeSpot, LifeSpot];
}

/** The free agents' places: the coffee machine, the kitchen table, the sofa, the foosball and ping pong tables, the pinball machine, the video game corner, the library, the windows and the plants. */
export interface LifeSpots {
  coffee: LifeSpot;
  /** Where a fresh cup appears under the machine's spout (world, with its height). */
  cup: { x: number; y: number; z: number };
  /** Two seats at the kitchen table. */
  cafe: LifeSpot[];
  /** Two seats on the sofa (none without a lounge). */
  sofa: LifeSpot[];
  /** The foosball table's footprint and its two ends. */
  foosball: GameTable;
  /** The ping pong table, between the meeting table and the kitchen: its footprint and its two ends. */
  pingpong: GameTable;
  /** The pinball machine, by the lounge (or right of Pointer's desk in a small room): its footprint (the head at the back), where its player stands and where a friend watches. */
  pinball: { x: number; y: number; w: number; d: number; player: LifeSpot; watcher: LifeSpot };
  /** The video game corner, against the back-left wall: where the lounge would be in a small room, else under the lounge's window. */
  gaming: GameCorner;
  shelf: LifeSpot;
  windows: LifeSpot[];
  /** One spot beside each plant, in `plants` order. */
  plants: LifeSpot[];
}

const COL_PITCH = 112;
const ROW_PITCH = 146;
const GRID_X = 262;
const GRID_Y = 218;
/** From a desk chair to the aisle behind it. */
const AISLE = 28;

export interface Desk {
  key: string;
  personId?: string;
  kind: "agent" | "lead" | "hr";
  x: number;
  y: number;
  w: number;
  d: number;
  /** Where its owner's face is when they sit here. */
  seat: Pt;
  /** The chair, in world units. */
  chair: { x: number; y: number };
  /** The aisle in front of the chair, where its owner steps out to. */
  door: Floor;
}

export interface MeetingSpot {
  kind: "table" | "cafe";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** The corner of the picture its meeting card is pinned to (the empty space above the walls). */
  corner: "start" | "end";
  /** Chairs drawn round it, taken or not. */
  chairs: number;
}

export interface Placement {
  personId: string;
  /** The face's centre. */
  at: Pt;
  /** The chair's position in world units, for the body drawn under the face. */
  chair: { x: number; y: number };
  where: "desk" | "meeting";
  /** At a meeting spot, which side the person faces (for the body). */
  spot?: number;
}

export interface SceneLayout {
  /** Room size in world units. */
  a: number;
  b: number;
  view: { x: number; y: number; width: number; height: number };
  desks: Desk[];
  spots: MeetingSpot[];
  /** Spot index of each meeting shown in the room; undefined when there is no spot left for it. */
  meetingSpot: (number | undefined)[];
  placements: Placement[];
  /** Label anchors. */
  shelf: Pt;
  hr: Pt;
  /** The lounge (sofa) fits between the meeting table and the HR corner. */
  hasLounge: boolean;
  plants: Plant[];
  /** Where free agents go (OfficeLife), and what they walk round. */
  life: LifeSpots;
  /** Waypoints in the aisles and the open floor that walks go through (paths.ts links them). */
  waypoints: Floor[];
  obstacles: Obstacle[];
}

/** Half a person's width: how far a walk keeps from furniture. */
const CLEAR = 8;

const box = (x0: number, y0: number, x1: number, y1: number): Obstacle => ({ kind: "box", x0: x0 - CLEAR, y0: y0 - CLEAR, x1: x1 + CLEAR, y1: y1 + CLEAR });
const chairBox = (c: Floor) => box(c.x - 11, c.y - 11, c.x + 11, c.y + 11);

/** A step from a seat away from what it faces, onto the open floor. */
function outward(seat: Floor, centre: Floor, by: number): Floor {
  const dx = seat.x - centre.x;
  const dy = seat.y - centre.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: seat.x + (dx / len) * by, y: seat.y + (dy / len) * by };
}

/** Which way a person at `from` looks on screen when facing `to`. */
export const lookFrom = (from: Floor, to: Floor): 1 | -1 => (to.x - from.x - (to.y - from.y) >= 0 ? 1 : -1);

/** A seat round a table, seen from the walkway. */
function tableSeat(spot: MeetingSpot, chair: Floor, z: number): LifeSpot {
  return { at: chair, door: outward(chair, { x: spot.cx, y: spot.cy }, 30), z, pose: "sit", look: lookFrom(chair, { x: spot.cx, y: spot.cy }) };
}

/** A meeting seat as a place to walk to. */
export const meetingSeat = (spot: MeetingSpot, chair: Floor): LifeSpot => tableSeat(spot, chair, SEAT_Z);

/** A desk chair as a place to walk to: its owner faces the monitor. */
export const deskSeat = (desk: Desk): LifeSpot => ({ at: desk.chair, door: desk.door, z: FACE_Z, pose: "sit", look: 1 });

const stand = (x: number, y: number, look: 1 | -1): LifeSpot => ({ at: { x, y }, door: { x, y }, z: STAND_Z, pose: "stand", look });

/** The ping pong table: the size of a desk and a bit, its net across the middle. */
export const PINGPONG = { w: 72, d: 40, h: 28 };
/** The pinball machine: a narrow cabinet, long from its head (at the back) to the flippers (at the front). */
export const PINBALL = { w: 22, d: 40 };
/** The video game corner's TV: its low stand (`long` along the wall, `deep` into the room), and the 16:9 screen on it (`z0` up from the floor). */
export const TV = { long: 80, deep: 12, h: 14, screen: { w: 72, h: 40, z0: 18 } };
/** On a beanbag, lower still than on the sofa. */
export const BEANBAG_Z = FACE_Z - 10;
/** A beanbag's radius on the floor. */
export const BEANBAG_R = 12;

function lifeSpots(a: number, b: number, spots: MeetingSpot[], plants: Plant[], hasLounge: boolean, lead: Desk): LifeSpots {
  const cafe = spots[1]!;
  // Two kitchen-table chairs side by side as the viewer sees them (the front one and the right one), so neither hides the other.
  const chairs = seatsAround(cafe, cafe.chairs).map((s) => s.chair);
  const front = chairs.reduce((p, q) => (q.y > p.y ? q : p));
  const right = chairs.filter((c) => c !== front).reduce((p, q) => (q.x - q.y > p.x - p.y ? q : p));
  const cafeSeats = [front, right].map((c) => tableSeat(cafe, c, SEAT_Z));
  const foos = { x: 150, y: 250, w: 60, d: 30 };
  const fy = foos.y + foos.d / 2;
  // On the open floor between the meeting table and the kitchen, behind the first row of desks.
  const pong = { x: 312, y: 70, ...PINGPONG };
  const py = pong.y + pong.d / 2;
  // In front of the foosball, by the lounge, its head towards the back wall; a small room (no lounge, the HR desk there) has it right of Pointer's desk.
  const pin = hasLounge ? { x: 150, y: 320, ...PINBALL } : { x: lead.x + lead.w + 40, y: lead.y + 14, ...PINBALL };
  // The friend who watches stands beside the player, on the side with room.
  const watcher = hasLounge ? stand(pin.x - 47, pin.y + pin.d + 24, 1) : stand(pin.x + pin.w + 28, pin.y + pin.d + 6, -1);
  // Against the back-left wall, the screen towards the room: where the sofa would be in a small room, else under the lounge's window (which moves up over the sofa). The players sit right of it on screen, so their faces leave it in view.
  const tv = { x: 2, y: hasLounge ? 322 : 222, w: TV.deep, d: TV.long };
  const beanbag = (y: number): LifeSpot => {
    const at = { x: tv.x + tv.w + 50, y };
    return { at, door: { x: at.x + 26, y }, z: BEANBAG_Z, pose: "sit", look: lookFrom(at, { x: tv.x + tv.w, y: tv.y + tv.d / 2 }) };
  };
  return {
    coffee: stand(a - 161, 52, 1),
    cup: { x: a - 162, y: 21, z: 37 },
    cafe: cafeSeats,
    sofa: hasLounge
      ? [
          { at: { x: 34, y: 242 }, door: { x: 58, y: 236 }, z: SOFA_Z, pose: "sit", look: 1 },
          { at: { x: 34, y: 302 }, door: { x: 58, y: 308 }, z: SOFA_Z, pose: "sit", look: 1 },
        ]
      : [],
    foosball: { ...foos, ends: [stand(foos.x - 18, fy, 1), stand(foos.x + foos.w + 18, fy, -1)] },
    pingpong: { x: pong.x, y: pong.y, w: pong.w, d: pong.d, ends: [stand(pong.x - 18, py, 1), stand(pong.x + pong.w + 18, py, -1)] },
    pinball: { ...pin, player: stand(pin.x + pin.w / 2, pin.y + pin.d + 18, 1), watcher },
    gaming: { ...tv, seats: [beanbag(tv.y + 18), beanbag(tv.y + tv.d - 22)] },
    shelf: stand(38, 128, -1),
    windows: [stand(229, 30, 1)],
    plants: plants.map((p) => {
      const isFront = p.y > b / 2;
      const isEast = p.x > a / 2;
      return stand(isEast ? p.x - 26 : p.x + 22, isFront ? p.y - 16 : p.y + 14, isEast ? 1 : -1);
    }),
  };
}

/** The HR corner's occupant: the agent with id "hr", else one whose role is HR. */
export function hrPerson(people: OfficePerson[]): OfficePerson | undefined {
  const agents = people.filter((p) => p.kind === "agent");
  return agents.find((p) => p.id === "hr") ?? agents.find((p) => p.role.trim().toLowerCase() === "hr");
}

/**
 * Chairs round a table, evenly spaced as the viewer sees them (the
 * projection squashes the table's front and back, so equal angles would
 * crowd the far side). The first chair, Pointer's, is at the head: the
 * table's right end.
 */
export function seatsAround(spot: Pick<MeetingSpot, "kind" | "cx" | "cy" | "rx" | "ry">, count: number): { at: Pt; chair: { x: number; y: number } }[] {
  const pad = spot.kind === "table" ? 30 : 26;
  const rx = spot.rx + pad;
  const ry = spot.ry + pad;
  const STEPS = 360;
  const head = -Math.PI / 4;
  const world = (t: number) => ({ x: spot.cx + rx * Math.cos(t), y: spot.cy + ry * Math.sin(t) });
  const lengths = [0];
  let prev = project(world(head).x, world(head).y);
  for (let i = 1; i <= STEPS; i++) {
    const w = world(head + (2 * Math.PI * i) / STEPS);
    const p = project(w.x, w.y);
    lengths.push(lengths[i - 1]! + Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const total = lengths[STEPS]!;
  return Array.from({ length: count }, (_, k) => {
    const target = (total * k) / count;
    const i = Math.max(0, lengths.findIndex((l) => l >= target));
    const chair = world(head + (2 * Math.PI * i) / STEPS);
    return { at: project(chair.x, chair.y, FACE_Z - 6), chair };
  });
}

export function officeLayout(people: OfficePerson[], meetings: OfficeMeeting[]): SceneLayout {
  const lead = people.find((p) => p.kind === "lead");
  const hr = hrPerson(people);
  const deskAgents = people.filter((p) => p.kind === "agent" && p !== hr);
  const n = deskAgents.length;
  const cols = n <= 6 ? 3 : n <= 12 ? 4 : 5;
  const rows = Math.max(1, Math.ceil(n / cols));

  const gridX1 = GRID_X + (cols - 1) * COL_PITCH + DESK.w;
  const gridY1 = GRID_Y + (rows - 1) * ROW_PITCH + DESK.d + 40;
  const a = Math.max(536, gridX1 + 40);
  const leadX = Math.round((GRID_X + gridX1) / 2 - LEAD_DESK.w / 2);
  const leadY = gridY1 + 20;
  const b = Math.max(470, leadY + LEAD_DESK.d + 62);

  const desk = (key: string, kind: Desk["kind"], x: number, y: number, size: { w: number; d: number }, personId?: string): Desk => {
    const chair = { x: x + size.w / 2, y: y + size.d + 16 };
    const door = { x: chair.x, y: chair.y + AISLE };
    return { key, kind, x, y, w: size.w, d: size.d, chair, door, seat: project(chair.x, chair.y, FACE_Z), ...(personId ? { personId } : {}) };
  };
  // Pointer's desk first, so the people read in team order (Pointer, then the agents).
  const desks: Desk[] = [
    desk("lead", "lead", leadX, leadY, LEAD_DESK, lead?.id),
    ...deskAgents.map((p, i) => desk(`agent-${p.id}`, "agent", GRID_X + (i % cols) * COL_PITCH, GRID_Y + Math.floor(i / cols) * ROW_PITCH, DESK, p.id)),
    desk("hr", "hr", 44, b - 150, DESK, hr?.id),
  ];

  const spots: MeetingSpot[] = [
    { kind: "table", cx: 150, cy: 132, rx: 72, ry: 40, corner: "start", chairs: 6 },
    { kind: "cafe", cx: a - 92, cy: 104, rx: 22, ry: 22, corner: "end", chairs: 3 },
  ];

  // Meetings take the spots in order; Pointer sits at the first one it leads.
  const placed = new Set<string>();
  const placements: Placement[] = [];
  const known = new Set(people.map((p) => p.id));
  const meetingSpot = meetings.map((_, i) => (i < spots.length ? i : undefined));
  meetings.forEach((m, i) => {
    const spot = meetingSpot[i];
    if (spot === undefined) return;
    const who = m.people.filter((id) => known.has(id) && !placed.has(id));
    const seats = seatsAround(spots[spot]!, Math.max(who.length, spots[spot]!.chairs));
    who.forEach((id, k) => {
      placed.add(id);
      placements.push({ personId: id, at: seats[k]!.at, chair: seats[k]!.chair, where: "meeting", spot });
    });
  });
  for (const d of desks) {
    if (d.personId && !placed.has(d.personId)) {
      placed.add(d.personId);
      placements.push({ personId: d.personId, at: d.seat, chair: d.chair, where: "desk" });
    }
  }

  const hasLounge = b - 170 - 230 >= 80;
  const plants: Plant[] = [
    { x: a - 24, y: 150, size: 1.2 },
    { x: 26, y: 180, size: 1 },
    { x: a - 26, y: b - 26, size: 1.3 },
    { x: 24, y: b - 24, size: 1.1 },
  ];
  const life = lifeSpots(a, b, spots, plants, hasLounge, desks[0]!);

  // What a walk keeps clear of: desks and their chairs, both tables with their chairs, the kitchen, the shelf, the lounge, the games (the TV and its beanbags too) and the plants.
  const chairsAt = (s: number) => Math.max(placements.filter((p) => p.spot === s).length, spots[s]!.chairs);
  const { gaming } = life;
  const obstacles: Obstacle[] = [
    ...desks.flatMap((d) => [box(d.x, d.y, d.x + d.w, d.y + d.d), chairBox(d.chair)]),
    ...spots.flatMap((s, i) => [
      { kind: "oval" as const, cx: s.cx, cy: s.cy, rx: s.rx + CLEAR, ry: s.ry + CLEAR },
      ...seatsAround(s, chairsAt(i)).map((seat) => chairBox(seat.chair)),
    ]),
    box(a - 254, 0, a - 20, 34),
    box(0, 30, 24, 158),
    ...[life.foosball, life.pingpong, life.pinball, gaming].map((g) => box(g.x, g.y, g.x + g.w, g.y + g.d)),
    ...gaming.seats.map((s) => box(s.at.x - BEANBAG_R, s.at.y - BEANBAG_R, s.at.x + BEANBAG_R, s.at.y + BEANBAG_R)),
    ...(hasLounge ? [box(10, 226, 46, 318), box(64, 252, 94, 292)] : []),
    ...plants.map((p) => box(p.x - 6 * p.size, p.y - 6 * p.size, p.x + 6 * p.size, p.y + 6 * p.size)),
  ];

  // Waypoints: the aisle behind the first row, the aisle in front of every row, the front aisle, a column down each side of the desks and a few on the open floor.
  const westX = GRID_X - 24;
  const eastX = gridX1 + 20;
  const leadDesk = desks[0]!;
  const rowYs = Array.from({ length: rows }, (_, r) => GRID_Y + r * ROW_PITCH + DESK.d + 16 + AISLE);
  const colXs = Array.from({ length: cols }, (_, c) => GRID_X + c * COL_PITCH + DESK.w / 2);
  const gapXs = Array.from({ length: cols - 1 }, (_, c) => GRID_X + c * COL_PITCH + DESK.w + (COL_PITCH - DESK.w) / 2);
  const backY = GRID_Y - 26;
  const frontY = leadDesk.door.y;
  const waypoints: Floor[] = [
    ...[backY, ...rowYs].flatMap((y) => [westX, ...colXs, ...gapXs, eastX].map((x) => ({ x, y }))),
    { x: life.coffee.at.x, y: backY },
    { x: westX, y: frontY },
    { x: leadDesk.door.x, y: frontY },
    { x: leadDesk.x + leadDesk.w + 24, y: frontY },
    ...(desks.at(-1)!.kind === "hr" ? [{ x: westX, y: desks.at(-1)!.door.y }] : []),
    // The open floor round the meeting table, by the lounge and the video game corner, and between the table and the kitchen.
    { x: 150, y: 232 },
    { x: 104, y: 248 },
    { x: 60, y: 212 },
    { x: 270, y: 120 },
    { x: 290, y: 46 },
    { x: 112, y: 330 },
    { x: 200, y: 320 },
  ];

  // The scene's box in screen units, with room for the walls above and name tags below.
  const left = -b - 18;
  const right = a + 18;
  const top = -WALL_H - 14;
  const bottom = (a + b) / 2 + FLOOR_T + 24;
  return {
    a,
    b,
    view: { x: left, y: top, width: right - left, height: bottom - top },
    desks,
    spots,
    meetingSpot,
    placements,
    shelf: project(10, 96, 128),
    hr: project(92, b - 14, 0),
    hasLounge,
    plants,
    life,
    waypoints,
    obstacles,
  };
}

/** A point of the scene as a percentage of its box, for placing HTML on top of the drawing. */
export const toPercent = (view: SceneLayout["view"], p: Pt) => ({
  left: `${(((p.x - view.x) / view.width) * 100).toFixed(3)}%`,
  top: `${(((p.y - view.y) / view.height) * 100).toFixed(3)}%`,
});

