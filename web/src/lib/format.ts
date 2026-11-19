/** "$12.34" */
export const usd = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? "–" : `$${n.toFixed(2)}`);

/** "1 task", "3 tasks" */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date for anything older than a week. */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "–";
  const min = Math.round((now - then) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return plural(d, "day") + " ago";
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Minutes between two ISO times, at least 1: "12 min". */
export function duration(fromIso: string, toIso: string): string {
  const min = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** The first line of a request, cut to `max` characters. */
export function headline(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
