/**
 * Where everything goes in the office: an isometric room whose size follows
 * the team (one desk per agent, in rows of three to five), the fixed corners
 * (meeting table, kitchen, skills library, HR corner, Pointer's desk at the
 * front) and where each person is right now (at their desk, or around the
 * meeting table or the kitchen table when they are in a meeting). Pure: the
 * art (OfficeArt) and the people on top of it (OfficeScene) both draw from it.
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

export const WALL_H = 120;
export const FLOOR_T = 14;
export const DESK = { w: 64, d: 36, h: 30 };
export const LEAD_DESK = { w: 100, d: 44, h: 30 };
/** How high a sitting person's face is. */
export const FACE_Z = 52;

const COL_PITCH = 112;
const ROW_PITCH = 146;
const GRID_X = 262;
const GRID_Y = 218;

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
    return { key, kind, x, y, w: size.w, d: size.d, chair, seat: project(chair.x, chair.y, FACE_Z), ...(personId ? { personId } : {}) };
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
    hasLounge: b - 170 - 230 >= 80,
  };
}

/** A point of the scene as a percentage of its box, for placing HTML on top of the drawing. */
export const toPercent = (view: SceneLayout["view"], p: Pt) => ({
  left: `${(((p.x - view.x) / view.width) * 100).toFixed(3)}%`,
  top: `${(((p.y - view.y) / view.height) * 100).toFixed(3)}%`,
});

