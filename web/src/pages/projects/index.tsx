import { Tab, TabList } from "@astryxdesign/core/TabList";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { ChannelsTab } from "./ChannelsTab";
import { LessonsTab } from "./LessonsTab";
import { NotesTab } from "./NotesTab";
import { RepoSetupTab } from "./RepoSetupTab";

/** The page's sections, each its own route: `#/projects/channels`, `#/projects/setup`, `#/projects/notes`, `#/projects/lessons`. */
const TABS = [
  { value: "channels", label: "Channels" },
  { value: "setup", label: "Repo setup" },
  { value: "notes", label: "Project notes" },
  { value: "lessons", label: "Lessons" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

export default function ProjectsPage() {
  const route = useRoute();
  const tab: TabValue = TABS.find((t) => t.value === route.rest[0])?.value ?? "channels";

  return (
    <PageFrame
      title="Projects"
      description="Which Slack channel works on which repository, how each repository is set up, what the team has learned about it, and the mistakes it should not repeat."
      nav={
        <TabList value={tab} onChange={(value) => navigate("projects", value)} hasDivider isFullBleed>
          {TABS.map((t) => (
            <Tab key={t.value} value={t.value} label={t.label} href={href("projects", t.value)} />
          ))}
        </TabList>
      }>
      {tab === "channels" ? <ChannelsTab /> : tab === "setup" ? <RepoSetupTab /> : tab === "lessons" ? <LessonsTab /> : <NotesTab />}
    </PageFrame>
  );
}
