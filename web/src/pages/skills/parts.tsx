import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { CommandLineIcon, DocumentTextIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { type SkillSource, formatBytes, skillBody, sourceLabel } from "./skills";

/** Whether a skill ships scripts the agents run, as a token. */
export function ScriptsToken({ hasScripts }: { hasScripts: boolean }) {
  return hasScripts ? (
    <Tooltip content="It ships scripts the agents run in their shell, like the repository's own code.">
      <Token label="Runs scripts" color="orange" size="sm" icon={<Icon icon={CommandLineIcon} size="xsm" />} />
    </Tooltip>
  ) : (
    <Tooltip content="Instructions and reference files only.">
      <Token label="Instructions" color="gray" size="sm" icon={<Icon icon={DocumentTextIcon} size="xsm" />} />
    </Tooltip>
  );
}

/** Where a skill came from: a link to its GitHub folder, or "Pasted". */
export function SourceLink({ source }: { source: SkillSource | undefined }) {
  if (!source) return <Text color="secondary">Pasted in the console</Text>;
  return (
    <Link href={source.url} isExternalLink>
      {sourceLabel(source)}
    </Link>
  );
}

/** A titled part of a drawer. */
export function Block({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        {description && <Text type="supporting">{description}</Text>}
      </VStack>
      {children}
    </VStack>
  );
}

/** A skill's files with their sizes; binaries are marked (they block an install). */
export function FilesList({ files }: { files: { path: string; size: number; binary?: boolean }[] }) {
  return (
    <List density="compact" hasDividers edge="flush">
      {files.map((f) => (
        <ListItem
          key={f.path}
          label={<Code size="inherit">{f.path}</Code>}
          startContent={<Icon icon={f.binary ? ExclamationTriangleIcon : DocumentTextIcon} size="sm" color={f.binary ? "warning" : "secondary"} />}
          endContent={
            <HStack gap={2} vAlign="center">
              {f.binary && <Token label="Not text" color="red" size="sm" />}
              <Text type="supporting" hasTabularNumbers>
                {formatBytes(f.size)}
              </Text>
            </HStack>
          }
        />
      ))}
    </List>
  );
}

/** SKILL.md's instructions, rendered (the frontmatter is shown as facts instead). */
export function SkillMarkdown({ skillMd }: { skillMd: string }) {
  const body = skillBody(skillMd);
  if (!body) return <Text color="secondary">SKILL.md has no instructions after its frontmatter.</Text>;
  return (
    <Markdown density="compact" headingLevelStart={4} contentWidth="100%">
      {body}
    </Markdown>
  );
}
