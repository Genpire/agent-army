import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import type { AgentSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { AssignField } from "./AssignField";
import { Block, FilesList, ScriptsToken, SkillMarkdown, SourceLink } from "./parts";
import { type SkillAssignment, type SkillInput, type SkillPreview, type SkillView, extraFields, formatBytes } from "./skills";

/** What the drawer opens with: empty, or a GitHub folder (from the Skills Scout) to preview at once. */
export interface AddSkillStart {
  url?: string;
  /** The agents the Scout suggested; the owner can change them before installing. */
  forAgents?: string[];
}

export interface AddSkillDrawerProps {
  isOpen: boolean;
  start: AddSkillStart;
  agents: Pick<AgentSpec, "id" | "name" | "role" | "enabled">[];
  onClose: () => void;
  /** After an install: reload the library and open the new skill. */
  onInstalled: (skill: SkillView) => Promise<void>;
}

type Mode = "github" | "paste";

const EXAMPLE_URL = "https://github.com/anthropics/skills/tree/main/skills/pdf";

/** Add a skill: a GitHub folder or a pasted SKILL.md, previewed first, installed on the owner's click. */
export function AddSkillDrawer({ isOpen, start, agents, onClose, onInstalled }: AddSkillDrawerProps) {
  const [mode, setMode] = useState<Mode>("github");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<SkillPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [assigned, setAssigned] = useState<SkillAssignment>("all");
  const [tried, setTried] = useState(false);
  const install = useAction();
  const latest = useRef(0);

  const input = (): SkillInput | undefined => (mode === "github" ? (url.trim() ? { url: url.trim() } : undefined) : pasted.trim() ? { skillMd: pasted } : undefined);

  const runPreview = useCallback(async (what: SkillInput) => {
    const run = ++latest.current;
    setPreviewing(true);
    setPreviewError(undefined);
    setPreview(undefined);
    try {
      const got = await api.post<{ preview: SkillPreview }>("/api/skills/preview", what);
      if (run === latest.current) setPreview(got.preview);
    } catch (err) {
      if (run === latest.current) setPreviewError(errorMessage(err));
    } finally {
      if (run === latest.current) setPreviewing(false);
    }
  }, []);

  // Every opening starts fresh; a folder from the Scout is previewed straight away.
  useEffect(() => {
    if (!isOpen) return;
    latest.current++;
    setMode("github");
    setUrl(start.url ?? "");
    setPasted("");
    setPreview(undefined);
    setPreviewError(undefined);
    setPreviewing(false);
    setTried(false);
    setAssigned(start.forAgents?.length ? start.forAgents : "all");
    if (start.url) void runPreview({ url: start.url });
  }, [isOpen, start, runPreview]);

  const clearPreview = () => {
    latest.current++;
    setPreview(undefined);
    setPreviewError(undefined);
    setPreviewing(false);
  };

  const noneChosen = assigned !== "all" && assigned.length === 0;
  const canInstall = Boolean(preview && preview.problems.length === 0);

  const doInstall = async () => {
    const what = input();
    setTried(true);
    if (!what || !preview || !canInstall || noneChosen) return;
    let installed: SkillView | undefined;
    const ok = await install.run(
      async () => {
        installed = (await api.post<{ skill: SkillView }>("/api/skills/install", { ...what, assignedTo: assigned })).skill;
      },
      { success: preview.installed ? `Replaced ${preview.name}.` : `Installed ${preview.name}.` },
    );
    if (ok && installed) await onInstalled(installed);
  };

  return (
    <Drawer isOpen={isOpen} onOpenChange={(open) => !open && onClose()} label="Add a skill" purpose="form" width={680} experimental={{ isFullWidthOnMobile: true }}>
      <Layout
        header={<DrawerHeader title="Add a skill" subtitle="Preview it first: nothing is installed until you click Install." onOpenChange={(open) => !open && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={6}>
              <VStack gap={4}>
                <SegmentedControl
                  label="Where the skill comes from"
                  value={mode}
                  onChange={(v) => {
                    setMode(v === "paste" ? "paste" : "github");
                    clearPreview();
                  }}>
                  <SegmentedControlItem value="github" label="From GitHub" />
                  <SegmentedControlItem value="paste" label="Paste SKILL.md" />
                </SegmentedControl>
                {mode === "github" ? (
                  <TextInput
                    label="Skill folder on GitHub"
                    value={url}
                    onChange={(v) => {
                      setUrl(v);
                      clearPreview();
                    }}
                    placeholder={EXAMPLE_URL}
                    description="The folder that holds SKILL.md. Public repositories need no token; private ones need a GitHub connection that may read them."
                    autoCapitalize="off"
                    hasAutoCorrect={false}
                    hasSpellCheck={false}
                    hasAutoFocus={!start.url}
                    width="100%"
                  />
                ) : (
                  <TextArea
                    label="SKILL.md"
                    value={pasted}
                    onChange={(v) => {
                      setPasted(v);
                      clearPreview();
                    }}
                    rows={12}
                    placeholder={"---\nname: release-notes\ndescription: Writes release notes from merged pull requests. Use when asked for a changelog or release notes.\n---\n\n# Release notes\n…"}
                    description="A single-file skill: frontmatter with name and description, then the instructions."
                  />
                )}
                <HStack gap={2}>
                  <Button
                    label={previewing ? "Previewing…" : "Preview"}
                    variant="secondary"
                    isLoading={previewing}
                    isDisabled={!input()}
                    clickAction={() => {
                      const what = input();
                      if (what) return runPreview(what);
                    }}
                  />
                </HStack>
                <Banner
                  status="warning"
                  title="Install only skills you trust"
                  description="A skill's instructions steer your agents, and in repo tasks its scripts run in their shell like the repository's own code."
                  collapsible={false}
                />
              </VStack>

              {previewError && <Banner status="error" title="Couldn't preview this skill" description={previewError} collapsible={false} />}
              {preview && (
                <PreviewView
                  preview={preview}
                  assign={
                    canInstall && (
                      <Block title="Who uses it" description="Agents with the skill have it loaded when they start work.">
                        <AssignField
                          value={assigned}
                          onChange={setAssigned}
                          agents={agents}
                          status={tried && noneChosen ? { type: "error", message: "Pick at least one agent, or choose every agent." } : undefined}
                        />
                      </Block>
                    )
                  }
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label={preview?.installed ? "Replace skill" : "Install skill"}
                variant="primary"
                isDisabled={!canInstall}
                isLoading={install.pending}
                clickAction={doInstall}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}

/** What the preview found: the skill's facts, what blocks it, who would use it (`assign`), its files and instructions. */
function PreviewView({ preview, assign }: { preview: SkillPreview; assign: ReactNode }) {
  const extras = extraFields(preview.frontmatter);
  const license = [preview.license, preview.licenseFile && `${preview.licenseFile.title || "Licence file"} (${preview.licenseFile.path})`].filter(Boolean).join(" · ");
  return (
    <VStack gap={6}>
      <Divider />
      {preview.problems.length > 0 && (
        <Banner status="error" title="This skill can't be installed" collapsible={false}>
          <VStack gap={1}>
            {preview.problems.map((p) => (
              <Text key={p}>{p}</Text>
            ))}
          </VStack>
        </Banner>
      )}
      {preview.installed && (
        <Banner
          status="info"
          title={`${preview.name} is already installed`}
          description={
            <Text type="inherit" color="inherit">
              Installed <Timestamp value={preview.installed.installedAt} format="auto" type="inherit" color="inherit" />. Installing replaces it; who uses it stays the same unless you change it below.
            </Text>
          }
          collapsible={false}
        />
      )}
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={3}>{preview.name || "Unnamed skill"}</Heading>
          {preview.description && <Text>{preview.description}</Text>}
        </VStack>
        <MetadataList label={{ width: 120 }}>
          <MetadataListItem label="Source">
            <SourceLink source={preview.source} />
          </MetadataListItem>
          <MetadataListItem label="Licence">
            <Text color={license ? "primary" : "secondary"}>{license || "Not stated"}</Text>
          </MetadataListItem>
          <MetadataListItem label="Contains">
            <HStack gap={2} vAlign="center" wrap="wrap">
              <ScriptsToken hasScripts={preview.hasScripts} />
              <Text type="supporting">
                {plural(preview.files.length, "file")} · {formatBytes(preview.bytes)}
              </Text>
            </HStack>
          </MetadataListItem>
          {extras.map(([key, value]) => (
            <MetadataListItem key={key} label={key}>
              <Code size="inherit">{value}</Code>
            </MetadataListItem>
          ))}
        </MetadataList>
      </VStack>
      {assign && (
        <>
          <Divider />
          {assign}
          <Divider />
        </>
      )}
      <Block title="Files">
        <FilesList files={preview.files} />
      </Block>
      {preview.skillMd && (
        <Block title="Instructions" description="SKILL.md, as the agents would read it.">
          <SkillMarkdown skillMd={preview.skillMd} />
        </Block>
      )}
    </VStack>
  );
}
