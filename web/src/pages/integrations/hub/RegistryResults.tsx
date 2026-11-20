import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useMemo } from "react";
import { AppTile } from "../apps/AppTile";
import { type AppSource, type AppView, useRegistrySearch } from "../apps/apps";
import { HubGroup } from "./HubSection";
import { TileGrid } from "./TileGrid";

export interface RegistryResultsProps {
  /** The hub's search (searched shortly after typing stops). */
  query: string;
  /** Connected apps: a server at one of their addresses shows as connected. */
  connected: AppView[];
  /** Opens the add drawer for a server found in the registry. */
  onConnect: (source: AppSource) => void;
  columns: number;
}

const normalUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();

/** "More from the MCP Registry": remote MCP servers matching a search that finds few apps in the catalog. */
export function RegistryResults({ query, connected, onConnect, columns }: RegistryResultsProps) {
  const registry = useRegistrySearch(query, true);
  const connectedUrls = useMemo(() => new Set(connected.map((a) => normalUrl(a.url))), [connected]);

  return (
    <HubGroup
      title="More from the MCP Registry"
      description="Servers others published in the official MCP Registry. They are not checked by this console: look at who publishes one before you connect it.">
      {registry.error && <Banner status="warning" title={registry.error} collapsible={false} />}
      {registry.loading ? (
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text color="secondary">Searching the registry…</Text>
        </HStack>
      ) : (
        !registry.error &&
        (registry.apps.length ? (
          <TileGrid columns={columns}>
            {registry.apps.map((entry) => {
              const isConnected = connectedUrls.has(normalUrl(entry.url));
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
          </TileGrid>
        ) : (
          <Text color="secondary">No remote MCP server in the registry matches “{query.trim()}”.</Text>
        ))
      )}
    </HubGroup>
  );
}
