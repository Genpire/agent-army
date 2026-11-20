/**
 * The drawers for apps connected through their MCP servers, over the hub:
 * one connects an app (a catalog entry, a server from the MCP Registry or a
 * custom one), the other shows a connected app (`#/integrations/apps/<app id>`).
 * The hub loads this chunk the first time either opens, or while idle.
 */
import { useEffect, useState } from "react";
import { useConfig } from "../../../lib/state";
import { AddAppDrawer } from "../apps/AddAppDrawer";
import { AppDrawer } from "../apps/AppDrawer";
import { type AppSource, type AppView, presetOf, useAppCatalog } from "../apps/apps";

/** The add drawer: open or not, and what it connects (kept while it slides out). */
export interface AddingState {
  isOpen: boolean;
  source?: AppSource;
}

export interface AppDrawersProps {
  /** The connected app to show; its drawer is closed without one. */
  appId?: string;
  adding: AddingState;
  onAddingOpenChange: (isOpen: boolean) => void;
  /** After an app with a key (or none) is added: the hub opens it. */
  onAdded: (app: AppView) => void;
  onAppClose: () => void;
}

export default function AppDrawers({ appId, adding, onAddingOpenChange, onAdded, onAppClose }: AppDrawersProps) {
  const { config } = useConfig();
  const catalog = useAppCatalog();
  const app = config.apps.find((a) => a.id === appId);
  // Kept while the drawer slides out.
  const [shownApp, setShownApp] = useState(app);
  useEffect(() => {
    if (app) setShownApp(app);
  }, [app]);
  const redirectUrl = catalog.data?.redirectUrl ?? "";

  return (
    <>
      <AddAppDrawer isOpen={adding.isOpen} source={adding.source} redirectUrl={redirectUrl} onOpenChange={onAddingOpenChange} onAdded={onAdded} />
      <AppDrawer
        isOpen={Boolean(app)}
        app={shownApp}
        preset={shownApp ? presetOf(catalog.data?.apps, shownApp) : undefined}
        redirectUrl={redirectUrl}
        onOpenChange={(isOpen) => !isOpen && onAppClose()}
      />
    </>
  );
}
