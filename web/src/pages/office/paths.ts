/**
 * How people get round the office: a walk goes from waypoint to waypoint
 * (layout.ts puts them in the aisles and on the open floor) along straight
 * lines that keep clear of the furniture, the shortest way. Two waypoints are
 * linked when the line between them misses every obstacle; a walk's start
 * and end join the nearest waypoints they can see. Pure, and cached per room
 * shape, so re-reading the office every few seconds costs nothing.
 */
import type { Floor, Obstacle, SceneLayout } from "./layout";

/** Keeps a walk this far from the walls. */
const WALL_GAP = 12;

/** Whether a floor point is inside an obstacle. */
export function isInside(o: Obstacle, p: Floor): boolean {
  if (o.kind === "box") return p.x > o.x0 && p.x < o.x1 && p.y > o.y0 && p.y < o.y1;
  const dx = (p.x - o.cx) / o.rx;
  const dy = (p.y - o.cy) / o.ry;
  return dx * dx + dy * dy < 1;
}

/** Whether the segment p→q passes through an obstacle (touching its edge is fine). */
export function crosses(o: Obstacle, p: Floor, q: Floor): boolean {
  if (o.kind === "box") {
    // Liang–Barsky: clip the segment against the box; an overlap of positive length crosses it.
    let t0 = 0;
    let t1 = 1;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const edges: [number, number][] = [
      [-dx, p.x - o.x0],
      [dx, o.x1 - p.x],
      [-dy, p.y - o.y0],
      [dy, o.y1 - p.y],
    ];
    for (const [d, n] of edges) {
      if (d === 0) {
        if (n <= 0) return false;
        continue;
      }
      const t = n / d;
      if (d < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 >= t1) return false;
    }
    return t1 - t0 > 1e-6;
  }
  // An oval: scale it to the unit circle and measure the segment's closest approach.
  const ax = (p.x - o.cx) / o.rx;
  const ay = (p.y - o.cy) / o.ry;
  const bx = (q.x - o.cx) / o.rx;
  const by = (q.y - o.cy) / o.ry;
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2));
  const cx = ax + vx * t;
  const cy = ay + vy * t;
  return cx * cx + cy * cy < 1 - 1e-6;
}

/** Whether a walk can go straight from p to q. Obstacles that hold p or q (the chair someone sits on) do not count. */
export function isClear(obstacles: Obstacle[], p: Floor, q: Floor): boolean {
  for (const o of obstacles) {
    if (isInside(o, p) || isInside(o, q)) continue;
    if (crosses(o, p, q)) return false;
  }
  return true;
}

export interface WalkGraph {
  nodes: Floor[];
  /** For each node, its neighbours and the distance to them. */
  links: { to: number; d: number }[][];
}

const dist = (p: Floor, q: Floor) => Math.hypot(q.x - p.x, q.y - p.y);

/** By room shape (a re-read office has a new layout object but usually the same room). */
const cache = new Map<string, WalkGraph>();
/** By layout object, so the many walks planned for one layout skip even the shape key. */
const byLayout = new WeakMap<object, WalkGraph>();

/** The waypoints that are on open floor, linked wherever a straight walk is clear. */
export function walkGraph(layout: Pick<SceneLayout, "a" | "b" | "waypoints" | "obstacles">): WalkGraph {
  const same = byLayout.get(layout.obstacles);
  if (same) return same;
  const key = JSON.stringify([layout.a, layout.b, layout.waypoints, layout.obstacles]);
  const hit = cache.get(key);
  if (hit) {
    byLayout.set(layout.obstacles, hit);
    return hit;
  }
  const inRoom = (p: Floor) => p.x >= WALL_GAP && p.y >= WALL_GAP && p.x <= layout.a - WALL_GAP && p.y <= layout.b - WALL_GAP;
  const nodes = layout.waypoints.filter((p) => inRoom(p) && !layout.obstacles.some((o) => isInside(o, p)));
  const links: WalkGraph["links"] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!isClear(layout.obstacles, nodes[i]!, nodes[j]!)) continue;
      const d = dist(nodes[i]!, nodes[j]!);
      links[i]!.push({ to: j, d });
      links[j]!.push({ to: i, d });
    }
  }
  const graph = { nodes, links };
  if (cache.size > 8) cache.clear();
  cache.set(key, graph);
  byLayout.set(layout.obstacles, graph);
  return graph;
}

/**
 * The shortest walk from `from` to `to` through the waypoints, as the
 * points to walk through (both ends included). A straight line when nothing
 * is in the way; also when no way round is found, so a walk always ends.
 */
export function route(layout: Pick<SceneLayout, "a" | "b" | "waypoints" | "obstacles">, from: Floor, to: Floor): Floor[] {
  const { obstacles } = layout;
  if (dist(from, to) < 0.5) return [from];
  if (isClear(obstacles, from, to)) return [from, to];
  const g = walkGraph(layout);
  const n = g.nodes.length;
  // Dijkstra from the start (index n) to the end (index n + 1) over the waypoints.
  const START = n;
  const END = n + 1;
  const point = (i: number) => (i === START ? from : i === END ? to : g.nodes[i]!);
  const neighbours = (i: number): { to: number; d: number }[] => {
    if (i === START) return g.nodes.flatMap((p, j) => (isClear(obstacles, from, p) ? [{ to: j, d: dist(from, p) }] : []));
    const out = [...g.links[i]!];
    if (isClear(obstacles, g.nodes[i]!, to)) out.push({ to: END, d: dist(g.nodes[i]!, to) });
    return out;
  };
  const best = new Array<number>(n + 2).fill(Number.POSITIVE_INFINITY);
  const prev = new Array<number>(n + 2).fill(-1);
  const done = new Array<boolean>(n + 2).fill(false);
  best[START] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n + 2; i++) if (!done[i] && best[i]! < Number.POSITIVE_INFINITY && (u < 0 || best[i]! < best[u]!)) u = i;
    if (u < 0 || u === END) break;
    done[u] = true;
    for (const e of neighbours(u)) {
      const d = best[u]! + e.d;
      if (d < best[e.to]!) {
        best[e.to] = d;
        prev[e.to] = u;
      }
    }
  }
  if (prev[END] === -1) return [from, to];
  const path: Floor[] = [];
  for (let i = END; i !== -1; i = prev[i]!) path.unshift(point(i));
  return path;
}

/** The length of a walk through these points. */
export const pathLength = (points: Floor[]) => points.reduce((sum, p, i) => (i ? sum + dist(points[i - 1]!, p) : 0), 0);
