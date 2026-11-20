/**
 * The hub's three kinds of tile, all one AppTile: a built-in integration, a
 * connected app, and a catalog app not connected yet.
 */
import { href } from "../../../lib/router";
import { AppTile } from "../apps/AppTile";
import { type AppSource, type CatalogApp, appTileStatus, signsInDirectly } from "../apps/apps";
import { type ConnectedApp, NATIVE_CATEGORY, type NativeSummary, requiredNote } from "./model";

/** Claude, Slack, GitHub…: "Manage" once connected, "Connect" before; either opens its drawer (#/integrations/<id>). */
export function NativeTile({ row }: { row: NativeSummary }) {
  return row.connected ? (
    <AppTile
      name={row.name}
      logoId={row.id}
      caption={NATIVE_CATEGORY[row.id]}
      status={{ tone: row.tone, text: row.status }}
      actionLabel="Manage"
      href={href("integrations", row.id)}
    />
  ) : (
    <AppTile
      name={row.name}
      logoId={row.id}
      caption={NATIVE_CATEGORY[row.id]}
      description={row.enables}
      status={requiredNote(row)}
      actionLabel="Connect"
      href={href("integrations", row.id)}
    />
  );
}

/** A connected app: whether it can be used and what it may do; opens its drawer (#/integrations/apps/<app id>). */
export function ConnectedAppTile({ app, preset }: ConnectedApp) {
  return (
    <AppTile
      name={app.name}
      logoId={app.presetId ?? undefined}
      caption={preset?.category ?? "Custom app"}
      status={appTileStatus(app)}
      actionLabel="Manage"
      href={href("integrations", "apps", app.id)}
    />
  );
}

export interface CatalogTileProps {
  entry: CatalogApp;
  /** One click for an app that only needs a sign-in: add it and go to the vendor. */
  onSignIn: (app: CatalogApp) => void | Promise<void>;
  /** The add drawer, for everything else (a key, an address to fill in, a client to register). */
  onConnect: (source: AppSource) => void;
}

/** A catalog app not connected yet, under its category's heading: "Sign in" when one click is enough, "Connect" otherwise. */
export function CatalogTile({ entry, onSignIn, onConnect }: CatalogTileProps) {
  const direct = signsInDirectly(entry);
  const source: AppSource = { kind: "catalog", app: entry };
  return (
    <AppTile
      name={entry.name}
      logoId={entry.id}
      description={entry.description}
      actionLabel={direct ? "Sign in" : "Connect"}
      onAction={() => (direct ? onSignIn(entry) : onConnect(source))}
      {...(direct && entry.altAuth && entry.altAuth !== "oauth" ? { secondaryActionLabel: "Use a key", onSecondaryAction: () => onConnect(source) } : {})}
    />
  );
}
