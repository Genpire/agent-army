import { Tab, TabList } from "@astryxdesign/core/TabList";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { ChannelsTab } from "./ChannelsTab";
import { NotesTab } from "./NotesTab";
import { RepoSetupTab } from "./RepoSetupTab";

/** The page's sections, each its own route: `#/projects/channels`, `#/projects/setup`, `#/projects/notes`. */
const TABS = [
  { value: "channels", label: "Channels" },
  { value: "setup", label: "Repo setup" },
  { value: "notes", label: "Project notes" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

export default function ProjectsPage() {
  const route = useRoute();
  const tab: TabValue = TABS.find((t) => t.value === route.rest[0])?.value ?? "channels";

  return (
    <PageFrame
      title="Projects"
      description="Which Slack channel works on which repository, how each repository is set up, and what the team has learned about it."
      nav={
        <TabList value={tab} onChange={(value) => navigate("projects", value)} hasDivider isFullBleed>
          {TABS.map((t) => (
            <Tab key={t.value} value={t.value} label={t.label} href={href("projects", t.value)} />
          ))}
        </TabList>
      }>
      {tab === "channels" ? <ChannelsTab /> : tab === "setup" ? <RepoSetupTab /> : <NotesTab />}
    </PageFrame>
  );
}
