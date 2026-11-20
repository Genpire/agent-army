/**
 * Integrations: one hub for Claude and Slack; GitHub, GitLab and Bitbucket;
 * monday.com and Jira; Miro; and apps connected through their MCP servers.
 * A status line, one search over everything (with the MCP Registry when the
 * catalog has little), what is connected, then what can be added. Opening
 * one shows it in a drawer over the hub, which keeps its search and scroll:
 * `#/integrations/<id>` for a built-in integration, `#/integrations/apps/<app id>`
 * for an app; closing goes back to `#/integrations`.
 *
 * Speed: the hub is in the console's main chunk; each pane and the app
 * drawers are chunks of their own, fetched on first open or while idle. The
 * catalog is fetched once and kept in memory; search filters in the browser.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { api, errorMessage } from "../../lib/api";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { type AddAppResult, type AppSource, type AppView, type CatalogApp, REGISTRY_MIN_QUERY, useAppCatalog } from "./apps/apps";
import { summarize } from "./catalog";
import type { AddingState } from "./hub/AppDrawers";
import { HubGroup, HubSection } from "./hub/HubSection";
import { CatalogTile, ConnectedAppTile, NativeTile } from "./hub/HubTiles";
import { HubToolbar } from "./hub/HubToolbar";
import { IntegrationDrawer, preloadPanes } from "./hub/IntegrationDrawer";
import {
  ALL_CATEGORIES,
  NATIVE_CATEGORY,
  byCategory,
  connectedLine,
  filterCatalog,
  filterConnectedApps,
  filterNatives,
  isNative,
  listText,
  missingRequired,
} from "./hub/model";
import { RegistryResults } from "./hub/RegistryResults";
import { parseHubRoute } from "./hub/route";
import { TileGrid, useTileColumns } from "./hub/TileGrid";

const loadAppDrawers = () => import("./hub/AppDrawers");
const AppDrawers = lazy(loadAppDrawers);

/** Below this many matches, a search also looks in the MCP Registry. */
const FEW_MATCHES = 3;

const SIGN_IN_ERRORS: Record<string, string> = {
  invalid: "That sign-in link was not valid or was already used. Start the sign-in again.",
  expired: "The sign-in took too long. Start it again.",
  denied: "The sign-in was cancelled at the app.",
  failed: "The sign-in failed at the last step. Start it again; if it keeps failing, check the app's OAuth settings.",
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function IntegrationsPage() {
  const { config } = useConfig();
  const route = useRoute();
  const showToast = useToast();
  const catalog = useAppCatalog();
  const columns = useTileColumns();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [adding, setAdding] = useState<AddingState>({ isOpen: false });

  const { target, signIn } = parseHubRoute(route.rest);
  const rows = summarize(config);
  const missing = missingRequired(config);

  // Typing stays instant: the tiles follow the search a moment later when there are many.
  const search = useDeferredValue(query);
  const filter = useMemo(() => ({ query: search, category }), [search, category]);
  const natives = filterNatives(rows, filter);
  const connectedNatives = natives.filter((r) => r.connected);
  const otherNatives = natives.filter((r) => !r.connected);
  const connectedApps = useMemo(() => filterConnectedApps(config.apps, catalog.data?.apps, filter), [config.apps, catalog.data, filter]);
  const catalogApps = useMemo(() => (catalog.data ? filterCatalog(catalog.data.apps, config.apps, filter) : []), [catalog.data, config.apps, filter]);
  const groups = useMemo(() => (catalog.data ? byCategory(catalogApps, catalog.data.categories) : []), [catalogApps, catalog.data]);
  const categories = catalog.data?.categories ?? [...new Set(Object.values(NATIVE_CATEGORY))].sort();

  const matches = natives.length + connectedApps.length + catalogApps.length;
  const searchRegistry = Boolean(catalog.data) && search.trim().length >= REGISTRY_MIN_QUERY && matches < FEW_MATCHES;
  const connectedCount = connectedNatives.length + connectedApps.length;
  const addCount = otherNatives.length + catalogApps.length;

  // The pane chunks and the app drawers load while the browser is idle, so opening one does not wait.
  useEffect(() => {
    const preload = () => {
      preloadPanes();
      loadAppDrawers().catch(() => undefined);
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(preload, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(preload, 1500);
    return () => clearTimeout(id);
  }, []);

  // Back from a vendor's sign-in: say how it went once, then drop the flags from the address.
  const signInKey = signIn ? route.rest.join("/") : "";
  useEffect(() => {
    if (!signIn) return;
    const name = (target.kind === "app" && config.apps.find((a) => a.id === target.appId)?.name) || "The app";
    if (!signIn.ok) showToast({ body: SIGN_IN_ERRORS[signIn.reason ?? ""] ?? SIGN_IN_ERRORS.failed!, type: "error" });
    else if (signIn.checkFailed) showToast({ body: `${name} is signed in, but its tools could not be listed yet. Try "List tools again".`, type: "error" });
    else showToast({ body: `${name} is signed in and ready.`, type: "info" });
    if (target.kind === "app") navigate("integrations", "apps", target.appId);
    else navigate("integrations");
    // Once per return from a sign-in: the flags are gone after the navigation above.
  }, [signInKey]);

  const connect = (source: AppSource) => setAdding({ isOpen: true, source });

  // Catalog apps that need nothing but a sign-in go straight to the vendor; access and agents are set afterwards.
  const signInTo = async (preset: CatalogApp) => {
    try {
      const { signInUrl } = await api.post<AddAppResult>("/api/apps", {
        presetId: preset.id,
        name: preset.name,
        url: preset.url,
        transport: preset.transport,
        auth: { type: "oauth" },
        access: "read",
      });
      if (signInUrl) window.location.assign(signInUrl);
    } catch (err) {
      // The add drawer has the other ways in (a registered client, an API key): open it after the reason.
      showToast({ body: errorMessage(err), type: "error" });
      connect({ kind: "catalog", app: preset });
    }
  };

  const onAdded = (app: AppView) => {
    showToast({ body: `${app.name} added with ${app.tools.length} tools.`, type: "info" });
    navigate("integrations", "apps", app.id);
  };

  // The app drawers' chunk mounts on first use and then stays, so the drawers can slide out.
  const needsAppDrawers = adding.isOpen || target.kind === "app";
  const [appDrawersMounted, setAppDrawersMounted] = useState(needsAppDrawers);
  if (needsAppDrawers && !appDrawersMounted) setAppDrawersMounted(true);

  const nativeSummary = target.kind === "native" ? rows.filter(isNative).find((r) => r.id === target.id) : undefined;
  const clearFilters = () => {
    setQuery("");
    setCategory(ALL_CATEGORIES);
  };

  return (
    <PageFrame title="Integrations" description={connectedLine(rows, config.apps.length)}>
      <VStack gap={8}>
        <VStack gap={4}>
          {missing.length > 0 && (
            <Banner
              status="warning"
              title={`${capitalize(listText(missing.map((m) => m.label)))} still ${missing.length === 1 ? "needs" : "need"} connecting`}
              description="Claude, Slack and one code host (GitHub, GitLab or Bitbucket) are needed before the team can work. Everything else is optional."
              endContent={<Button label={`Connect ${missing[0]!.name}`} variant="primary" href={href("integrations", missing[0]!.id)} />}
              collapsible={false}
            />
          )}
          <HubToolbar
            query={query}
            onQueryChange={setQuery}
            category={category}
            onCategoryChange={setCategory}
            categories={categories}
            onAddCustom={() => setAdding({ isOpen: true, source: { kind: "custom" } })}
          />
        </VStack>

        {connectedCount > 0 && (
          <HubSection title="Connected" count={connectedCount}>
            <TileGrid columns={columns}>
              {connectedNatives.map((row) => (
                <NativeTile key={row.id} row={row} />
              ))}
              {connectedApps.map((c) => (
                <ConnectedAppTile key={c.app.id} {...c} />
              ))}
            </TileGrid>
          </HubSection>
        )}

        {(addCount > 0 || !catalog.data) && (
          <HubSection title="Add more" count={catalog.data ? addCount : undefined}>
            <VStack gap={6}>
              {otherNatives.length > 0 && (
                <HubGroup title="Built in">
                  <TileGrid columns={columns}>
                    {otherNatives.map((row) => (
                      <NativeTile key={row.id} row={row} />
                    ))}
                  </TileGrid>
                </HubGroup>
              )}
              {catalog.error && <Banner status="error" title={`Couldn't load the app catalog: ${catalog.error}`} collapsible={false} />}
              {!catalog.data && !catalog.error && (
                <HStack gap={2} vAlign="center">
                  <Spinner size="sm" />
                  <Text color="secondary">Loading the app catalog…</Text>
                </HStack>
              )}
              {groups.map((group) => (
                <HubGroup key={group.category} title={group.category}>
                  <TileGrid columns={columns}>
                    {group.apps.map((entry) => (
                      <CatalogTile key={entry.id} entry={entry} onSignIn={signInTo} onConnect={connect} />
                    ))}
                  </TileGrid>
                </HubGroup>
              ))}
            </VStack>
          </HubSection>
        )}

        {matches === 0 && catalog.data && !searchRegistry && (
          <EmptyState
            title="Nothing matches"
            description="Try another word or category, or add the app as a custom app with its MCP server's address."
            actions={
              <HStack gap={2} wrap="wrap" hAlign="center">
                <Button label="Clear the search" variant="secondary" onClick={clearFilters} />
                <Button label="Custom app" variant="secondary" onClick={() => setAdding({ isOpen: true, source: { kind: "custom" } })} />
              </HStack>
            }
          />
        )}

        {searchRegistry && <RegistryResults query={search} connected={config.apps} onConnect={connect} columns={columns} />}
      </VStack>

      <IntegrationDrawer summary={nativeSummary} onClose={() => navigate("integrations")} />
      {appDrawersMounted && (
        <Suspense fallback={null}>
          <AppDrawers
            appId={target.kind === "app" ? target.appId : undefined}
            adding={adding}
            onAddingOpenChange={(isOpen) => setAdding((s) => ({ ...s, isOpen }))}
            onAdded={onAdded}
            onAppClose={() => navigate("integrations")}
          />
        </Suspense>
      )}
    </PageFrame>
  );
}
