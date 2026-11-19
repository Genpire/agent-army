import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";
import { plural, usd } from "../../lib/format";
import { href } from "../../lib/router";
import type { MonthUsage } from "../../lib/types";
import { TASKS_EVERY_MS } from "./usePolled";
import { type TopTask, monthName, requestHeadline } from "./model";

export interface StatTileProps {
  label: string;
  value: string;
  /** One supporting line under the value. */
  detail?: ReactNode;
}

/** A headline number in a dashboard row. */
export function StatTile({ label, value, detail }: StatTileProps) {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        <Heading level={2}>{value}</Heading>
        {detail && <Text type="supporting">{detail}</Text>}
      </VStack>
    </Card>
  );
}

/** This month's Claude spend as three tiles: total, chat replies, repo tasks. */
export function spendTiles(usage: MonthUsage | undefined): StatTileProps[] {
  const loading = "Loading";
  return [
    { label: "Claude spend", value: usage ? usd(usage.totalUsd) : "–", detail: usage ? `${monthName(usage.month)}, UTC` : loading },
    { label: "Chat replies", value: usage ? usd(usage.chat.usd) : "–", detail: usage ? plural(usage.chat.count, "reply", "replies") : loading },
    { label: "Repo tasks", value: usage ? usd(usage.tasks.usd) : "–", detail: usage ? plural(usage.tasks.count, "task") : loading },
  ];
}

type TopRow = { id: string; top: TopTask };

/** The month's most expensive repo tasks, highest first, with their share of the costliest one. */
export function TopTasksTable({ topTasks }: { topTasks: TopTask[] }) {
  const max = Math.max(...topTasks.map((t) => t.costUsd ?? 0), 0.01);
  const columns: TableColumn<TopRow>[] = [
    {
      key: "request",
      header: "Request",
      width: proportional(3, { minWidth: 240 }),
      renderCell: ({ top }) => (
        <Link href={href("activity", top.id)} color="primary" maxLines={1}>
          {requestHeadline(top)}
        </Link>
      ),
    },
    { key: "repo", header: "Repository", width: proportional(1.5, { minWidth: 120 }), renderCell: ({ top }) => <Text color="secondary" maxLines={1}>{top.repo}</Text> },
    { key: "started", header: "Started", width: pixel(124), renderCell: ({ top }) => <Timestamp value={top.createdAt} format="auto" type="body" /> },
    {
      key: "cost",
      header: "Cost",
      width: proportional(1.5, { minWidth: 120 }),
      renderCell: ({ top }) => (
        <VStack gap={1}>
          <ProgressBar label={`Cost of ${requestHeadline(top, 40)}`} isLabelHidden value={top.costUsd ?? 0} max={max} />
          <Text type="supporting" hasTabularNumbers>
            {usd(top.costUsd)}
          </Text>
        </VStack>
      ),
    },
  ];
  return <Table<TopRow> data={topTasks.map((top) => ({ id: top.id, top }))} columns={columns} idKey="id" density="compact" hasHover textOverflow="truncate" />;
}

/** "● Live, refreshes every 10 s", or why the last refresh failed. */
export function LiveNote({ error }: { error: string | undefined }) {
  return error ? (
    <HStack gap={2} vAlign="center">
      <StatusDot variant="error" label="Not refreshing" tooltip={error} />
      <Text type="supporting">Could not refresh</Text>
    </HStack>
  ) : (
    <HStack gap={2} vAlign="center">
      <StatusDot variant="success" label="Live" isPulsing tooltip={`Refreshes every ${TASKS_EVERY_MS / 1000} seconds while this page is open`} />
      <Text type="supporting">Live</Text>
    </HStack>
  );
}
