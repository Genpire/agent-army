/**
 * A built-in integration's pane in a drawer over the hub, so the hub keeps
 * its search and scroll. Each pane's code is its own chunk, fetched when it
 * is first opened or while the browser is idle (preloadPanes).
 */
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { type ComponentType, type LazyExoticComponent, Suspense, lazy, useEffect, useMemo, useState } from "react";
import { BrandLogo } from "../../../components/BrandLogo";
import type { IntegrationSummary } from "../catalog";
import { PaneInDrawer } from "../parts";
import type { NativeId, NativeSummary } from "./model";

/** What every pane takes (onBack is for a pane shown on its own page). */
type PaneProps = { summary: IntegrationSummary; onBack?: () => void };
type PaneModule = { default: ComponentType<PaneProps> };

const LOADERS: Record<NativeId, () => Promise<PaneModule>> = {
  claude: () => import("../ClaudePane").then((m) => ({ default: m.ClaudePane })),
  codex: () => import("../EnginePane").then((m) => ({ default: m.CodexPane })),
  gemini: () => import("../EnginePane").then((m) => ({ default: m.GeminiPane })),
  slack: () => import("../SlackPane").then((m) => ({ default: m.SlackPane })),
  github: () => import("../GitHubPane").then((m) => ({ default: m.GitHubPane })),
  gitlab: () => import("../GitLabPane").then((m) => ({ default: m.GitLabPane })),
  bitbucket: () => import("../BitbucketPane").then((m) => ({ default: m.BitbucketPane })),
  monday: () => import("../MondayPane").then((m) => ({ default: m.MondayPane })),
  jira: () => import("../JiraPane").then((m) => ({ default: m.JiraPane })),
  miro: () => import("../MiroPane").then((m) => ({ default: m.MiroPane })),
};

/** Panes whose code is here already: shown at once, without a Suspense frame. */
const loaded: Partial<Record<NativeId, ComponentType<PaneProps>>> = {};

const load = (id: NativeId): Promise<PaneModule> =>
  LOADERS[id]().then((m) => {
    loaded[id] = m.default;
    return m;
  });

const LAZY = Object.fromEntries((Object.keys(LOADERS) as NativeId[]).map((id) => [id, lazy(() => load(id))])) as Record<
  NativeId,
  LazyExoticComponent<ComponentType<PaneProps>>
>;

/** Fetches every pane's code ahead of time, so opening one does not wait. */
export function preloadPanes(): void {
  for (const id of Object.keys(LOADERS) as NativeId[]) load(id).catch(() => undefined);
}

export interface IntegrationDrawerProps {
  /** The integration to show; undefined closes the drawer. */
  summary: NativeSummary | undefined;
  onClose: () => void;
}

export function IntegrationDrawer({ summary, onClose }: IntegrationDrawerProps) {
  // The last one shown stays in the drawer while it slides out.
  const [shown, setShown] = useState(summary);
  useEffect(() => {
    if (summary) setShown(summary);
  }, [summary]);
  const current = summary ?? shown;
  const close = (isOpen: boolean) => {
    if (!isOpen) onClose();
  };
  // Chosen once per integration: swapping the lazy wrapper for the loaded pane later would remount it and drop its input.
  const id = current?.id;
  const Pane = useMemo(() => (id ? (loaded[id] ?? LAZY[id]) : undefined), [id]);

  return (
    <Drawer isOpen={Boolean(summary)} onOpenChange={close} label={current?.name ?? "Integration"} purpose="form" width={720} experimental={{ isFullWidthOnMobile: true }}>
      {current && Pane && (
        <Layout
          header={<DrawerHeader title={current.name} subtitle={current.status} startContent={<BrandLogo id={current.id} name={current.name} size="md" />} onOpenChange={close} />}
          content={
            <LayoutContent>
              <PaneInDrawer.Provider value={true}>
                <Suspense
                  fallback={
                    <HStack gap={2} vAlign="center">
                      <Spinner size="sm" />
                      <Text color="secondary">Loading…</Text>
                    </HStack>
                  }>
                  <Pane key={current.id} summary={current} />
                </Suspense>
              </PaneInDrawer.Provider>
            </LayoutContent>
          }
        />
      )}
    </Drawer>
  );
}
