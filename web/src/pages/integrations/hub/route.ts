/**
 * What the hub opens over itself, from the address: `#/integrations` (the
 * hub alone), `#/integrations/<id>` (a built-in integration's drawer),
 * `#/integrations/apps/<app id>` (a connected app's drawer). The OAuth
 * callback comes back with `?signin=ok|error&reason=…&check=failed` on the
 * last segment (src/routes/apps.ts).
 */
import { type NativeId, isNativeId } from "./model";

export type HubTarget = { kind: "hub" } | { kind: "native"; id: NativeId } | { kind: "app"; appId: string };

/** Back from a vendor's sign-in. */
export interface SignInReturn {
  ok: boolean;
  /** Why it failed: invalid, expired, denied, failed. */
  reason?: string;
  /** Signed in, but the app's tools could not be listed yet. */
  checkFailed: boolean;
}

/** Mirrors APP_ID_RE in src/config.ts. */
const APP_ID_RE = /^app-[a-z0-9][a-z0-9-]{1,40}$/;

export function parseHubRoute(rest: string[]): { target: HubTarget; signIn?: SignInReturn } {
  const segments = [...rest];
  let flags = new URLSearchParams();
  const last = segments.length - 1;
  if (last >= 0 && segments[last]!.includes("?")) {
    const [segment = "", query = ""] = segments[last]!.split("?");
    segments[last] = segment;
    flags = new URLSearchParams(query);
  }
  const [first, second] = segments;
  const target: HubTarget =
    first === "apps" && second && APP_ID_RE.test(second) ? { kind: "app", appId: second } : isNativeId(first) ? { kind: "native", id: first } : { kind: "hub" };
  const signin = flags.get("signin");
  if (!signin) return { target };
  return { target, signIn: { ok: signin === "ok", reason: flags.get("reason") ?? undefined, checkFailed: flags.get("check") === "failed" } };
}
