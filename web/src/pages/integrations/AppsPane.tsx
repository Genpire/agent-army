/**
 * The Apps pane: apps connected through their MCP servers, and the catalog
 * to connect more (`#/integrations/apps`). `#/integrations/apps/<app id>`
 * opens one app; the OAuth callback comes back to it with
 * `?signin=ok|error&reason=…`, shown once as a toast.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { SquaresPlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { AddAppDrawer } from "./apps/AddAppDrawer";
import { AppCatalog } from "./apps/AppCatalog";
import { AppDrawer } from "./apps/AppDrawer";
import { type AddAppResult, type AppSource, type CatalogApp, presetOf, useAppCatalog } from "./apps/apps";
import { ConnectedApps } from "./apps/ConnectedApps";
import type { IntegrationSummary } from "./catalog";
import { PaneHeader, PaneSection } from "./parts";

const SIGN_IN_ERRORS: Record<string, string> = {
  invalid: "That sign-in link was not valid or was already used. Start the sign-in again.",
  expired: "The sign-in took too long. Start it again.",
  denied: "The sign-in was cancelled at the app.",
  failed: "The sign-in failed at the last step. Start it again; if it keeps failing, check the app's OAuth settings.",
};

/** "app-linear?signin=ok" → the app id and the flags the OAuth callback added. */
function parseTarget(segment: string | undefined): { appId?: string; flags: URLSearchParams } {
  const [id = "", query = ""] = (segment ?? "").split("?");
  const flags = new URLSearchParams(query);
  return { ...(/^app-[a-z0-9][a-z0-9-]{1,40}$/.test(id) ? { appId: id } : {}), flags };
}

export function AppsPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const lead = config.team.pointer.name;
  const route = useRoute();
  const showToast = useToast();
  const catalog = useAppCatalog();
  const [adding, setAdding] = useState<{ isOpen: boolean; source?: AppSource }>({ isOpen: false });
  const { appId, flags } = parseTarget(route.rest[1]);
  const signin = flags.get("signin");
  const app = config.apps.find((a) => a.id === appId);
  // Kept while the drawer animates out.
  const [shownApp, setShownApp] = useState(app);
  useEffect(() => {
    if (app) setShownApp(app);
  }, [app]);

  // Back from a vendor's sign-in: say how it went once, then drop the flags from the address.
  useEffect(() => {
    if (!signin) return;
    const name = app?.name ?? "The app";
    if (signin === "ok") {
      showToast({
        body: flags.get("check") === "failed" ? `${name} is signed in, but its tools could not be listed yet. Try "List tools again".` : `${name} is signed in and ready.`,
        type: flags.get("check") === "failed" ? "error" : "info",
      });
    } else {
      showToast({ body: SIGN_IN_ERRORS[flags.get("reason") ?? ""] ?? SIGN_IN_ERRORS.failed!, type: "error" });
    }
    if (appId) navigate("integrations", "apps", appId);
    else navigate("integrations", "apps");
    // Once per return from a sign-in: the flags are gone after the navigation above.
  }, [signin]);

  const connect = (source: AppSource) => setAdding({ isOpen: true, source });

  // OAuth apps that need nothing else sign in with one click; access and agents are set afterwards.
  const signIn = async (preset: CatalogApp) => {
    try {
      const { signInUrl } = await api.post<AddAppResult>("/api/apps", {
        presetId: preset.id,
        name: preset.name,
        url: preset.url,
        transport: preset.transport,
        auth: { type: "oauth" },
        access: "read",
      });
      if (signInUrl) return window.location.assign(signInUrl);
    } catch (err) {
      // The drawer has the other ways in (a registered client, an API key): open it after the reason.
      showToast({ body: errorMessage(err), type: "error" });
      connect({ kind: "catalog", app: preset });
    }
  };

  const redirectUrl = catalog.data?.redirectUrl ?? "";
  const description = `Connect apps through their own MCP servers: issue trackers, docs, monitoring, payments, deploys and more. ${lead} can use every app that is on; agents use the apps you give them, in Slack conversations (looking only) and in repo tasks. What an app returns is treated as data, never as instructions.`;

  return (
    <VStack gap={6}>
      <PaneHeader icon={SquaresPlusIcon} title={summary.name} tone={summary.tone} status={summary.status} description={description} onBack={onBack} />

      {config.apps.length > 0 && (
        <PaneSection title="Connected apps" description="Open one to choose its tools, what it may do and which agents have it.">
          <ConnectedApps apps={config.apps} agents={config.team.agents} lead={lead} selectedId={appId} />
        </PaneSection>
      )}

      <PaneSection title="Add an app" description="Sign in, or paste an API key; the app's tools are listed before it is used. Not in the list? Search the MCP Registry, or add any app by its MCP server's address.">
        {catalog.error && <Banner status="error" title={`Couldn't load the catalog: ${catalog.error}`} collapsible={false} />}
        {!catalog.data && !catalog.error && (
          <HStack gap={2} vAlign="center">
            <Spinner size="sm" />
            <Text color="secondary">Loading the catalog…</Text>
          </HStack>
        )}
        {catalog.data && (
          <AppCatalog
            catalog={catalog.data.apps}
            categories={catalog.data.categories}
            connected={config.apps}
            onSignIn={signIn}
            onConnect={connect}
            onOpen={(a) => navigate("integrations", "apps", a.id)}
            onAddCustom={() => setAdding({ isOpen: true, source: { kind: "custom" } })}
          />
        )}
      </PaneSection>

      <AddAppDrawer
        isOpen={adding.isOpen}
        source={adding.source}
        redirectUrl={redirectUrl}
        onOpenChange={(isOpen) => setAdding((s) => ({ ...s, isOpen }))}
        onAdded={(added) => {
          showToast({ body: `${added.name} added with ${added.tools.length} tools.`, type: "info" });
          navigate("integrations", "apps", added.id);
        }}
      />
      <AppDrawer
        isOpen={Boolean(app) && !signin}
        app={shownApp}
        preset={shownApp ? presetOf(catalog.data?.apps, shownApp) : undefined}
        redirectUrl={redirectUrl}
        onOpenChange={(isOpen) => !isOpen && navigate("integrations", "apps")}
      />
    </VStack>
  );
}
