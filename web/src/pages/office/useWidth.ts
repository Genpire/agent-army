import { type RefObject, useEffect, useRef, useState } from "react";

/** An element's width in CSS px, followed as it resizes (undefined until it is measured). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(Math.round(next));
    });
    observer.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
