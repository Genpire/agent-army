import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { AcademicCapIcon, MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { SectionHeader } from "../projects/components/SectionHeader";
import { AddSkillDrawer, type AddSkillStart } from "./AddSkillDrawer";
import { FindSkills } from "./FindSkills";
import { SkillDrawer } from "./SkillDrawer";
import { SkillsTable } from "./SkillsTable";
import type { SkillView } from "./skills";
import { useSkillLibrary } from "./useSkillLibrary";

const ANTHROPIC_SKILLS = "https://github.com/anthropics/skills";

/**
 * Skills: the team's skills library and the Skills Scout who finds new ones.
 * Routes: #/skills (the library), #/skills/skill/<name> (a skill's drawer),
 * #/skills/add (the add drawer), #/skills/find and #/skills/find/<need>
 * (the Scout, searching for that need at once; HR links here).
 */
export default function SkillsPage() {
  const { config, refresh } = useConfig();
  const route = useRoute();
  const library = useSkillLibrary();
  const agents = config.team.agents;
  const scoutName = agents.find((a) => a.id === "scout")?.name ?? "The Skills Scout";

  const [section, arg] = route.rest;
  const tab = section === "find" ? "find" : "library";

  // The skill drawer follows the route; the last skill stays while it animates out.
  const routedSkill = section === "skill" ? arg : undefined;
  const [shownSkill, setShownSkill] = useState(routedSkill);
  useEffect(() => {
    if (routedSkill) setShownSkill(routedSkill);
  }, [routedSkill]);

  // The add drawer is the page's own state, so the Scout's results stay while it is open; #/skills/add opens it too.
  const [add, setAdd] = useState<{ isOpen: boolean; start: AddSkillStart }>({ isOpen: section === "add", start: {} });
  useEffect(() => {
    if (section === "add") setAdd((a) => (a.isOpen ? a : { isOpen: true, start: {} }));
  }, [section]);
  const openAdd = useCallback((start: AddSkillStart = {}) => setAdd({ isOpen: true, start }), []);
  const closeAdd = useCallback(() => {
    setAdd((a) => ({ ...a, isOpen: false }));
    if (section === "add") navigate("skills");
  }, [section]);

  const changed = useCallback(async () => {
    await Promise.all([library.reload(), refresh()]);
  }, [library, refresh]);

  const installed = async (skill: SkillView) => {
    setAdd((a) => ({ ...a, isOpen: false }));
    await changed();
    navigate("skills", "skill", skill.name);
  };

  const skills = library.data?.skills ?? [];
  const addButton = <Button label="Add a skill" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={() => openAdd()} />;

  return (
    <PageFrame
      title="Skills"
      description="The skills library: Claude skills your agents can use, and the Skills Scout who finds new ones."
      actions={addButton}
      nav={
        <TabList value={tab} onChange={(value) => navigate("skills", ...(value === "find" ? ["find"] : []))} hasDivider isFullBleed>
          <Tab value="library" label="Library" href={href("skills")} />
          <Tab value="find" label="Find skills" href={href("skills", "find")} />
        </TabList>
      }>
      {tab === "find" ? (
        <FindSkills routeNeed={section === "find" ? arg : undefined} agents={agents} scoutName={scoutName} onPreview={openAdd} />
      ) : (
        <VStack gap={4}>
          <SectionHeader
            title="Library"
            description={
              <>
                A skill teaches an agent a task: a folder with a SKILL.md (its name, when to use it, then instructions), sometimes with scripts or reference files. Agents
                have the skills given to them loaded when they start work, and {config.team.pointer.name} can use any installed skill. Skill scripts run in the agents'
                shell like repository code, so install only skills you trust.{" "}
                <Link href={ANTHROPIC_SKILLS} isExternalLink>
                  Anthropic's skills
                </Link>{" "}
                are a good place to start.
              </>
            }
          />
          {library.error ? (
            <Banner
              status="error"
              title="Couldn't load the skills library"
              description={library.error}
              collapsible={false}
              endContent={<Button label="Try again" size="sm" clickAction={library.reload} />}
            />
          ) : (
            <Card padding={0}>
              <SkillsTable
                skills={skills}
                agents={agents}
                emptyState={
                  library.data ? (
                    <EmptyState
                      title="No skills yet"
                      description={`Add a skill from a GitHub folder or paste a SKILL.md, or ask ${scoutName} to find skills for what your team does.`}
                      icon={<Icon icon={AcademicCapIcon} size="lg" />}
                      actions={
                        <HStack gap={2} hAlign="center" wrap="wrap">
                          {addButton}
                          <Button label="Find skills" icon={<Icon icon={MagnifyingGlassIcon} />} href={href("skills", "find")} />
                        </HStack>
                      }
                    />
                  ) : (
                    <EmptyState isCompact title="Loading skills…" />
                  )
                }
              />
            </Card>
          )}
          {library.data && skills.length > 0 && (
            <Text type="supporting">
              {skills.length} of {library.data.limits.maxSkills} skills. Each skill may hold {library.data.limits.maxFiles} text files and{" "}
              {library.data.limits.maxBytes / 1024 / 1024} MB.
            </Text>
          )}
        </VStack>
      )}

      <SkillDrawer isOpen={routedSkill !== undefined} name={shownSkill} agents={agents} onClose={() => navigate("skills")} onChanged={changed} />
      <AddSkillDrawer isOpen={add.isOpen} start={add.start} agents={agents} onClose={closeAdd} onInstalled={installed} />
    </PageFrame>
  );
}
