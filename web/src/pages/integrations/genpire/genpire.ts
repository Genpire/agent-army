/**
 * Genpire, the product design studio, as a built-in integration: underneath
 * it is an app connection added from the catalog's "genpire" preset
 * (src/integrations/apps/apps-catalog-more.ts), so its tools are always the
 * ones Genpire's MCP server lists. This is how its row reads and how it
 * connects in one click.
 */
import { plural } from "../../../lib/format";
import type { StatusTone } from "../catalog";
import { type AddAppResult, type AppView, type CatalogApp, type SignInDeps, addAndSignIn, allowedTools, isSignedOut } from "../apps/apps";

/** The catalog entry Genpire connects from (catalogApp("genpire") on the server). */
export const GENPIRE_PRESET_ID = "genpire";

/** Requests to try, for the pane. */
export const GENPIRE_EXAMPLES = [
  "In Genpire, design a canvas tote bag with our brand style",
  "Show my latest Genpire products",
  "Make a tech pack for the linen shirt",
  "Prepare a factory quote request for the tote",
];

/** The connection Genpire uses: the first one added from its preset. */
export const genpireApp = (apps: AppView[]): AppView | undefined => apps.find((a) => a.presetId === GENPIRE_PRESET_ID);

/**
 * How the Genpire row reads: connected once its app is on and signed in.
 * "Signed in · 12 tools · can design", "… · look only", "Sign-in expired",
 * "Optional" before it is added. The tone is set only where it differs from
 * what `connected` gives.
 */
export function genpireStatus(app: AppView | undefined): { connected: boolean; status: string; tone?: StatusTone } {
  if (!app) return { connected: false, status: "Optional" };
  if (!app.enabled) return { connected: false, status: "Off" };
  if (isSignedOut(app)) return { connected: false, status: app.checkedAt ? "Sign-in expired" : "Not signed in", tone: "warning" };
  if (!app.tools.length) return { connected: true, status: "Signed in · tools not listed yet", tone: "warning" };
  const usable = allowedTools(app).length;
  return { connected: true, status: `Signed in · ${plural(usable, "tool")} · ${app.access === "write" ? "can design" : "look only"}`, ...(usable ? {} : { tone: "warning" }) };
}

/**
 * The pane's one click: adds the Genpire connection from its catalog entry,
 * allowed to design (Genpire's own page then asks what Pointer may do), and
 * opens Genpire's sign-in page.
 */
export async function connectGenpire(catalog: CatalogApp[] | undefined, deps?: SignInDeps): Promise<AddAppResult> {
  const preset = catalog?.find((c) => c.id === GENPIRE_PRESET_ID);
  if (!preset) throw new Error("Genpire is not in this version's app catalog.");
  return addAndSignIn(preset, { access: "write" }, deps);
}
