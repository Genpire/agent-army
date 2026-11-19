import { useEffect, useState } from "react";

/**
 * Hash routes, so the server only ever serves index.html: `#/team`,
 * `#/integrations/github`, `#/activity/<taskId>`… The first segment is the
 * page, the rest is the page's own (a tab, a selected item).
 */
export const PAGES = ["overview", "team", "integrations", "projects", "activity", "memory", "settings"] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  page: Page;
  /** Segments after the page, decoded. */
  rest: string[];
}

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  const page = (PAGES as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as Page) : "overview";
  return { page, rest: page === parts[0] ? parts.slice(1) : [] };
}

/** `href("integrations", "github")` → "#/integrations/github". */
export const href = (page: Page, ...rest: string[]) => `#/${[page, ...rest].map(encodeURIComponent).join("/")}`;

export function navigate(page: Page, ...rest: string[]): void {
  window.location.hash = href(page, ...rest);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
