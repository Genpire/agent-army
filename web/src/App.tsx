import { AppShell } from "@astryxdesign/core/AppShell";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  ArrowRightStartOnRectangleIcon,
  BoltIcon,
  ChartBarSquareIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  CursorArrowRaysIcon,
  FolderIcon,
  LightBulbIcon,
  PuzzlePieceIcon,
  Squares2X2Icon,
  UserGroupIcon,
  BuildingOffice2Icon,
  AcademicCapIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";
import { api } from "./lib/api";
import { aiReady, hasCodeHost } from "./pages/integrations/catalog";
import { type Page, href, useRoute } from "./lib/router";
import { useAppState } from "./lib/state";
import type { PublicConfig } from "./lib/types";
import ActivityPage from "./pages/activity";
import { LoginScreen, SetupScreen } from "./pages/auth";
import ChatPage from "./pages/chat";
import { ChatLauncher } from "./pages/chat/ChatLauncher";
import { ChatSessionProvider } from "./pages/chat/ChatSession";
import IntegrationsPage from "./pages/integrations";
import MemoryPage from "./pages/memory";
import OfficePage from "./pages/office";
import OverviewPage from "./pages/overview";
import ProjectsPage from "./pages/projects";
import RoutinesPage from "./pages/routines";
import SettingsPage from "./pages/settings";
import SkillsPage from "./pages/skills";
import TeamPage from "./pages/team";

const PAGE_COMPONENTS: Record<Page, ComponentType> = {
  office: OfficePage,
  skills: SkillsPage,
  overview: OverviewPage,
  chat: ChatPage,
  team: TeamPage,
  integrations: IntegrationsPage,
  projects: ProjectsPage,
  routines: RoutinesPage,
  activity: ActivityPage,
  memory: MemoryPage,
  settings: SettingsPage,
};

const NAV: { page: Page; label: string; icon: typeof Squares2X2Icon }[] = [
  { page: "overview", label: "Overview", icon: Squares2X2Icon },
  { page: "office", label: "Office", icon: BuildingOffice2Icon },
  { page: "chat", label: "Chat", icon: ChatBubbleLeftRightIcon },
  { page: "team", label: "Team", icon: UserGroupIcon },
  { page: "skills", label: "Skills", icon: AcademicCapIcon },
  { page: "integrations", label: "Integrations", icon: PuzzlePieceIcon },
  { page: "projects", label: "Projects", icon: FolderIcon },
  { page: "activity", label: "Activity", icon: ChartBarSquareIcon },
  { page: "routines", label: "Routines", icon: ClockIcon },
  { page: "memory", label: "Memory", icon: LightBulbIcon },
];

/** How many of the core integrations (the AI model, Slack, a code host) still need connecting. */
function missingIntegrations(config: PublicConfig): number {
  return [aiReady(config), config.slack.connected, hasCodeHost(config)].filter((c) => !c).length;
}

export function App() {
  const { state, loadError } = useAppState();
  if (!state) {
    return (
      <Center height="100vh">
        {loadError ? <EmptyState title="Cannot reach the server" description={loadError} icon={<Icon icon={BoltIcon} size="lg" />} /> : <Spinner label="Loading" />}
      </Center>
    );
  }
  if (state.setupRequired) return <SetupScreen />;
  if (!state.authed || !state.config) return <LoginScreen />;
  return <Console config={state.config} />;
}

function Console({ config }: { config: PublicConfig }) {
  const route = useRoute();
  const { refresh } = useAppState();
  const PageComponent = PAGE_COMPONENTS[route.page];
  const missing = missingIntegrations(config);

  return (
    // The chat window (opened by the floating button) and the Chat page share the current conversation.
    <ChatSessionProvider>
      <AppShell
        contentPadding={0}
        sideNav={
          <SideNav
            collapsible
            resizable={{ defaultWidth: 248, minWidth: 208, maxWidth: 320 }}
            header={
              <SideNavHeading
                heading="Agent Army"
                icon={<NavIcon icon={<Icon icon={CursorArrowRaysIcon} size="sm" />} />}
                headingHref={href("overview")}
              />
            }
            footer={
              <SideNavSection title="Account" isHeaderHidden>
                <SideNavItem label="Settings" icon={Cog6ToothIcon} href={href("settings")} isSelected={route.page === "settings"} />
                <SideNavItem
                  label="Sign out"
                  icon={ArrowRightStartOnRectangleIcon}
                  onClick={async () => {
                    await api.post("/api/logout").catch(() => undefined);
                    await refresh();
                  }}
                />
              </SideNavSection>
            }>
            <SideNavSection title="Console" isHeaderHidden>
              {NAV.map((item) => (
                <SideNavItem
                  key={item.page}
                  label={item.label}
                  icon={item.icon}
                  href={href(item.page)}
                  isSelected={route.page === item.page}
                  endContent={
                    item.page === "integrations" && missing > 0 ? (
                      <StatusDot variant="warning" label={`${missing} to connect`} tooltip={`${missing} of Claude, Slack and a code host still to connect`} />
                    ) : undefined
                  }
                />
              ))}
            </SideNavSection>
            <Divider />
          </SideNav>
        }>
        <PageComponent key={route.page} />
      </AppShell>
      <ChatLauncher page={route.page} />
    </ChatSessionProvider>
  );
}
