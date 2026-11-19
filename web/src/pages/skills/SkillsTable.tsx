import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Link } from "@astryxdesign/core/Link";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";
import { href } from "../../lib/router";
import type { AgentSpec } from "../../lib/types";
import { ScriptsToken } from "./parts";
import { type SkillView, assignedLabel, sourceLabel } from "./skills";

type SkillRow = SkillView & Record<string, unknown>;

export const skillHref = (name: string) => href("skills", "skill", name);

export interface SkillsTableProps {
  skills: SkillView[];
  agents: Pick<AgentSpec, "id" | "name">[];
  emptyState: ReactNode;
}

/** The library: one row per installed skill; the name opens its drawer. */
export function SkillsTable({ skills, agents, emptyState }: SkillsTableProps) {
  const isNarrow = useMediaQuery("(max-width: 720px)");

  const skillColumn: TableColumn<SkillRow> = {
    key: "name",
    header: "Skill",
    width: proportional(1, { minWidth: 200 }),
    renderCell: (s) => (
      <VStack gap={0.5}>
        <Link href={skillHref(s.name)} weight="semibold" color="primary" isStandalone>
          {s.name}
        </Link>
        <Text type="supporting" maxLines={2}>
          {s.description}
        </Text>
        {isNarrow && (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <ScriptsToken hasScripts={s.hasScripts} />
            <Text type="supporting">{assignedLabel(s.assignedTo, agents)}</Text>
          </HStack>
        )}
      </VStack>
    ),
  };

  const columns: TableColumn<SkillRow>[] = isNarrow
    ? [skillColumn]
    : [
        skillColumn,
        {
          key: "source",
          header: "Source",
          width: pixel(176),
          renderCell: (s) => (
            <Text color={s.source ? "primary" : "secondary"} maxLines={2}>
              {sourceLabel(s.source)}
            </Text>
          ),
        },
        { key: "scripts", header: "Contains", width: pixel(136), renderCell: (s) => <ScriptsToken hasScripts={s.hasScripts} /> },
        {
          key: "assigned",
          header: "Used by",
          width: pixel(160),
          renderCell: (s) => (
            <Text color={s.assignedTo === "all" || s.assignedTo.length ? "primary" : "secondary"} maxLines={2}>
              {assignedLabel(s.assignedTo, agents)}
            </Text>
          ),
        },
        { key: "installedAt", header: "Installed", width: pixel(128), renderCell: (s) => <Timestamp value={s.installedAt} format="auto" type="body" /> },
      ];

  return <Table<SkillRow> data={skills as SkillRow[]} columns={columns} idKey="name" density="balanced" hasHover emptyState={emptyState} />;
}
