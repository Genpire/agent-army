/** Changes to an ordered list (a route's providers, an agent's fallbacks), as new arrays. */

/** The list with the item at `index` moved `delta` places, kept inside the list; the same order when it cannot move. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = Math.min(Math.max(index + delta, 0), list.length - 1);
  const next = [...list];
  if (index < 0 || index >= list.length || to === index) return next;
  const [item] = next.splice(index, 1) as [T];
  next.splice(to, 0, item);
  return next;
}

/** The list without the item at `index`. */
export const removeAt = <T>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);
