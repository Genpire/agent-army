import { useCallback, useEffect, useMemo, useState } from "react";
import type { FollowupItem } from "./model";

/** What an action shows before the list confirms it: the item gone (done, reopened), or some of its fields changed (snoozed). */
export type Override = { kind: "hide" } | { kind: "patch"; patch: Partial<FollowupItem> };

function confirmed(item: FollowupItem | undefined, override: Override): boolean {
  if (!item) return true;
  return override.kind === "patch" && Object.entries(override.patch).every(([key, value]) => item[key as keyof FollowupItem] === value);
}

/**
 * A polled list with the owner's last actions shown at once. Each change
 * stays until a list arrives that shows it (the item gone, or its new
 * values), so a poll that started before the action cannot bring the old
 * item back; a failed action takes its change back with `clear`.
 */
export function useOptimisticItems(items: FollowupItem[] | undefined) {
  const [overrides, setOverrides] = useState<ReadonlyMap<number, Override>>(new Map());

  useEffect(() => {
    if (!items) return;
    setOverrides((prev) => {
      const next = new Map([...prev].filter(([n, o]) => !confirmed(items.find((i) => i.n === n), o)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const shown = useMemo(
    () =>
      (items ?? []).flatMap((item) => {
        const o = overrides.get(item.n);
        if (!o) return [item];
        return o.kind === "hide" ? [] : [{ ...item, ...o.patch }];
      }),
    [items, overrides],
  );

  const set = useCallback((n: number, override: Override) => setOverrides((prev) => new Map(prev).set(n, override)), []);
  const clear = useCallback(
    (n: number) =>
      setOverrides((prev) => {
        if (!prev.has(n)) return prev;
        const next = new Map(prev);
        next.delete(n);
        return next;
      }),
    [],
  );

  return { shown, set, clear };
}
