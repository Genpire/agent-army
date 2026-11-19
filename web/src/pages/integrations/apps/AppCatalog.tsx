import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { AppTile } from "./AppTile";
import { type AppCategory, type AppSource, type AppView, type CatalogApp, REGISTRY_MIN_QUERY, appStatus, matchesQuery, signsInDirectly, useRegistrySearch } from "./apps";

/** Below this many catalog matches, a search also looks in the MCP Registry. */
const FEW_MATCHES = 3;
const ALL = "all";

export interface AppCatalogProps {
  catalog: CatalogApp[];
  categories: readonly AppCategory[];
  /** Connected apps: their catalog tiles show their status and open them. */
  connected: AppView[];
  /** One click for a catalog app that only needs a sign-in (signsInDirectly): add it and go to the vendor. */
  onSignIn: (app: CatalogApp) => void | Promise<void>;
  /** Opens the add flow (AddAppDrawer) for a catalog entry or a registry server. */
  onConnect: (source: AppSource) => void;
  onOpen: (app: AppView) => void;
  onAddCustom: () => void;
  /** Search the MCP Registry when a search finds few catalog apps. */
  hasRegistry?: boolean;
}

/** The catalog: searchable, filtered by category in the browser, one tile per app. */
export function AppCatalog({ catalog, categories, connected, onSignIn, onConnect, onOpen, onAddCustom, hasRegistry = true }: AppCatalogProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const shown = useMemo(
    () => catalog.filter((a) => (category === ALL || a.category === category) && matchesQuery(a, query)),
    [catalog, category, query],
  );
  const searchRegistry = hasRegistry && query.trim().length >= REGISTRY_MIN_QUERY && shown.length < FEW_MATCHES;
  const registry = useRegistrySearch(query, searchRegistry);
  const byPreset = useMemo(() => new Map(connected.filter((a) => a.presetId).map((a) => [a.presetId!, a])), [connected]);
  const connectedUrls = useMemo(() => new Set(connected.map((a) => a.url.replace(/\/+$/, "").toLowerCase())), [connected]);

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="end" wrap="wrap">
        <StackItem size="fill">
          <TextInput
            type="search"
            label="Search apps"
            isLabelHidden
            placeholder="Search apps, e.g. issues, payments, Sentry"
            startIcon={MagnifyingGlassIcon}
            enterKeyHint="search"
            value={query}
            onChange={setQuery}
            width="100%"
          />
        </StackItem>
        <Selector
          label="Category"
          isLabelHidden
          options={[{ value: ALL, label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
          value={category}
          onChange={setCategory}
        />
        <Button label="Custom app" variant="secondary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={onAddCustom} />
      </HStack>

      {shown.length > 0 ? (
        <Grid columns={{ minWidth: 240, max: 3 }} gap={3}>
          {shown.map((entry) => {
            const app = byPreset.get(entry.id);
            if (app) {
              return (
                <AppTile
                  key={entry.id}
                  name={app.name}
                  logoId={entry.id}
                  caption={entry.category}
                  description={entry.description}
                  status={appStatus(app)}
                  actionLabel="Open"
                  onAction={() => onOpen(app)}
                />
              );
            }
            const direct = signsInDirectly(entry);
            const source: AppSource = { kind: "catalog", app: entry };
            return (
              <AppTile
                key={entry.id}
                name={entry.name}
                logoId={entry.id}
                caption={entry.category}
                description={entry.description}
                actionLabel={direct ? "Sign in" : "Connect"}
                onAction={() => (direct ? onSignIn(entry) : onConnect(source))}
                {...(direct && entry.altAuth && entry.altAuth !== "oauth" ? { secondaryActionLabel: "Use a key", onSecondaryAction: () => onConnect(source) } : {})}
              />
            );
          })}
        </Grid>
      ) : (
        !searchRegistry && (
          <EmptyState
            isCompact
            title="No app in the catalog matches"
            description="Try another word, or add it as a custom app with its MCP server's address."
            actions={<Button label="Custom app" variant="secondary" onClick={onAddCustom} />}
          />
        )
      )}

      {searchRegistry && (
        <VStack gap={3}>
          <VStack gap={1}>
            <Text weight="semibold">More from the MCP Registry</Text>
            <Text type="supporting" color="secondary">
              Servers others published in the official MCP Registry. They are not checked by this console: look at who publishes one before you connect it.
            </Text>
          </VStack>
          {registry.error && <Banner status="warning" title={registry.error} collapsible={false} />}
          {registry.loading ? (
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text color="secondary">Searching the registry…</Text>
            </HStack>
          ) : (
            !registry.error &&
            (registry.apps.length ? (
              <Grid columns={{ minWidth: 240, max: 3 }} gap={3}>
                {registry.apps.map((entry) => {
                  const isConnected = connectedUrls.has(entry.url.replace(/\/+$/, "").toLowerCase());
                  return (
                    <AppTile
                      key={entry.id}
                      name={entry.name}
                      caption={`MCP Registry · ${entry.publisher}${entry.onPublisherDomain ? " · its own domain" : ""}`}
                      description={entry.description || entry.url}
                      actionLabel={isConnected ? "Connected" : "Connect"}
                      isDisabled={isConnected}
                      onAction={() => onConnect({ kind: "registry", app: entry })}
                    />
                  );
                })}
              </Grid>
            ) : (
              <Text color="secondary">No remote MCP server in the registry matches “{query.trim()}”.</Text>
            ))
          )}
        </VStack>
      )}
    </VStack>
  );
}
