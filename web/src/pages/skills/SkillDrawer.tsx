import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import type { AgentSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { AssignField } from "./AssignField";
import { Block, FilesList, ScriptsToken, SkillMarkdown, SourceLink } from "./parts";
import { type SkillAssignment, type SkillDetail, formatBytes, skillPath, sourceLabel } from "./skills";

export interface SkillDrawerProps {
  isOpen: boolean;
  /** Kept while the drawer animates out. */
  name: string | undefined;
  agents: Pick<AgentSpec, "id" | "name" | "role" | "enabled">[];
  onClose: () => void;
  /** After an assignment or removal: reload the library (and the team). */
  onChanged: () => Promise<void>;
}

const sameAssignment = (a: SkillAssignment, b: SkillAssignment) =>
  a === "all" || b === "all" ? a === b : a.length === b.length && a.every((id) => b.includes(id));

/** One installed skill: where it is from, who uses it, its files and its instructions. */
export function SkillDrawer({ isOpen, name, agents, onClose, onChanged }: SkillDrawerProps) {
  const [detail, setDetail] = useState<SkillDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [assigned, setAssigned] = useState<SkillAssignment>("all");
  const [tried, setTried] = useState(false);
  const save = useAction();
  const remove = useAction();

  const load = useCallback(async (skill: string) => {
    setLoadError(undefined);
    try {
      const found = await api.get<SkillDetail>(skillPath(skill));
      setDetail(found);
      setAssigned(found.skill.assignedTo);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !name) return;
    setDetail(undefined);
    setTried(false);
    void load(name);
  }, [isOpen, name, load]);

  const skill = detail?.skill;
  const changed = skill ? !sameAssignment(assigned, skill.assignedTo) : false;
  const noneChosen = assigned !== "all" && assigned.length === 0;

  const saveAssignment = async () => {
    if (!skill) return;
    setTried(true);
    if (noneChosen) return;
    const ok = await save.run(() => api.post(`${skillPath(skill.name)}/assign`, { assignedTo: assigned }), { success: `Saved who uses ${skill.name}.` });
    if (ok) {
      await onChanged();
      await load(skill.name);
    }
  };

  return (
    <Drawer isOpen={isOpen} onOpenChange={(open) => !open && onClose()} label={name ? `Skill ${name}` : "Skill"} purpose="form" width={680} experimental={{ isFullWidthOnMobile: true }}>
      <Layout
        header={<DrawerHeader title={name ?? "Skill"} subtitle={skill ? `Skill · ${sourceLabel(skill.source)}` : "Skill"} onOpenChange={(open) => !open && onClose()} />}
        content={
          <LayoutContent>
            {loadError ? (
              <Banner
                status="error"
                title="Couldn't load the skill"
                description={loadError}
                collapsible={false}
                endContent={name ? <Button label="Try again" size="sm" clickAction={() => load(name)} /> : undefined}
              />
            ) : !skill || !detail ? (
              <Spinner label="Loading the skill" />
            ) : (
              <VStack gap={6}>
                <Text>{skill.description}</Text>
                <MetadataList label={{ width: 120 }}>
                  <MetadataListItem label="Source">
                    <SourceLink source={skill.source} />
                  </MetadataListItem>
                  <MetadataListItem label="Licence">
                    <Text color={skill.license ? "primary" : "secondary"}>{skill.license ?? "Not stated"}</Text>
                  </MetadataListItem>
                  <MetadataListItem label="Contains">
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <ScriptsToken hasScripts={skill.hasScripts} />
                      <Text type="supporting">
                        {plural(skill.files.length, "file")} · {formatBytes(skill.bytes)}
                      </Text>
                    </HStack>
                  </MetadataListItem>
                  <MetadataListItem label="Installed">
                    <Timestamp value={skill.installedAt} format="auto" type="body" />
                  </MetadataListItem>
                </MetadataList>

                {skill.hasScripts && (
                  <Banner
                    status="warning"
                    title="This skill runs scripts"
                    description="When an agent uses it in a repo task, its scripts run in the agent's shell like the repository's own code: with the same access and the same command guard. Keep only skills you trust."
                    collapsible={false}
                  />
                )}

                <Divider />
                <Block title="Who uses it" description="Agents with the skill have it loaded when they start work. Pointer can use every installed skill.">
                  <AssignField
                    value={assigned}
                    onChange={setAssigned}
                    agents={agents}
                    status={tried && noneChosen ? { type: "error", message: "Pick at least one agent, or choose every agent." } : undefined}
                  />
                  <HStack gap={2} hAlign="end">
                    <Button label="Save" variant="primary" isDisabled={!changed} isLoading={save.pending} clickAction={saveAssignment} />
                  </HStack>
                </Block>

                <Divider />
                <Block title="Files">
                  <FilesList files={skill.files} />
                </Block>

                <Divider />
                <Block title="Instructions" description="SKILL.md, as the agents read it.">
                  <SkillMarkdown skillMd={detail.skillMd} />
                </Block>
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center">
              <StackItem size="fill">
                {skill && (
                  <ConfirmButton
                    label="Remove skill"
                    confirmLabel="Click again to remove"
                    size="md"
                    isDisabled={remove.pending}
                    onConfirm={async () => {
                      const ok = await remove.run(() => api.post(`${skillPath(skill.name)}/delete`), { success: `Removed ${skill.name}.` });
                      if (ok) {
                        onClose();
                        await onChanged();
                      }
                    }}
                  />
                )}
              </StackItem>
              <Button label="Close" variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}
