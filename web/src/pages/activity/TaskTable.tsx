import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn, TablePlugin } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { usd } from "../../lib/format";
import { href, navigate } from "../../lib/router";
import type { CiSummary, Task } from "../../lib/types";
import { checksView, prLabel, requestHeadline, taskDuration, taskStatus } from "./model";

/** A StatusDot with its label, e.g. "● PR opened". */
export function StatusLabel({ label, variant, description, isPulsing }: ReturnType<typeof taskStatus>) {
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={variant} label={label} tooltip={description} isPulsing={isPulsing} />
      <Text>{label}</Text>
    </HStack>
  );
}

export const TaskStatus = ({ task }: { task: Task }) => <StatusLabel {...taskStatus(task)} />;

export const ChecksStatus = ({ ci }: { ci: CiSummary }) => <StatusLabel {...checksView(ci)} />;

/** Marks a task started by feedback on its pull request rather than a Slack message. */
export const ReviewMarker = () => (
  <StackItem>
    <Token size="sm" color="purple" label="Review" description="Started by feedback on the pull request" />
  </StackItem>
);

const NONE = (
  <Text color="secondary" type="supporting">
    –
  </Text>
);

type TaskRow = { id: string; task: Task };

export type TaskColumnKey = "status" | "request" | "repo" | "started" | "duration" | "cost" | "checks" | "pr";

const COLUMNS: Record<TaskColumnKey, TableColumn<TaskRow>> = {
  status: { key: "status", header: "Status", width: pixel(120), renderCell: ({ task }) => <TaskStatus task={task} /> },
  request: {
    key: "request",
    header: "Request",
    width: proportional(3, { minWidth: 240 }),
    renderCell: ({ task }) => (
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Link href={href("activity", task.id)} color="primary" maxLines={1}>
            {requestHeadline(task)}
          </Link>
        </StackItem>
        {task.trigger === "review" && <ReviewMarker />}
      </HStack>
    ),
  },
  repo: {
    key: "repo",
    header: "Repository",
    width: proportional(1.5, { minWidth: 120 }),
    renderCell: ({ task }) => (
      <Text color="secondary" maxLines={1}>
        {task.repo}
      </Text>
    ),
  },
  started: { key: "started", header: "Started", width: pixel(128), renderCell: ({ task }) => <Timestamp value={task.createdAt} format="auto" type="body" /> },
  duration: {
    key: "duration",
    header: "Duration",
    width: pixel(80),
    renderCell: ({ task }) => {
      const d = taskDuration(task);
      return d ? <Text hasTabularNumbers>{d}</Text> : NONE;
    },
  },
  cost: {
    key: "cost",
    header: "Cost",
    width: pixel(88),
    align: "end",
    renderCell: ({ task }) => (task.costUsd === undefined ? NONE : <Text hasTabularNumbers>{usd(task.costUsd)}</Text>),
  },
  checks: { key: "checks", header: "Checks", width: pixel(112), renderCell: ({ task }) => (task.ci ? <ChecksStatus ci={task.ci} /> : NONE) },
  pr: {
    key: "pr",
    header: "PR",
    width: pixel(88),
    renderCell: ({ task }) =>
      task.prUrl ? (
        <Link href={task.prUrl} isExternalLink tooltip={task.status === "failed" ? "Draft pull request with the unfinished work" : "Open the pull request on GitHub"}>
          {prLabel(task.prUrl)}
        </Link>
      ) : (
        NONE
      ),
  },
};

export const ALL_COLUMNS: TaskColumnKey[] = ["status", "request", "repo", "started", "duration", "cost", "checks", "pr"];

// Table rows have no clickable prop, and a row plugin cannot use
// useClickableContainer (it is not a component), so the pointer cursor is ours.
const styles = stylex.create({
  clickable: { cursor: "pointer" },
});

/**
 * Makes every body row open the task (#/activity/<id>). The request cell holds
 * a real link too, so the row is reachable by keyboard; clicks on links inside
 * the row (the PR link) keep their own target, and selecting text does not open it.
 */
function useRowOpensTask(): TablePlugin<TaskRow> {
  return useMemo(
    () => ({
      transformBodyRow: (props, item) => ({
        ...props,
        xstyle: [...props.xstyle, styles.clickable],
        htmlProps: {
          ...props.htmlProps,
          onClick: (e) => {
            props.htmlProps.onClick?.(e);
            if (e.target instanceof Element && e.target.closest("a, button")) return;
            if (window.getSelection()?.toString()) return;
            navigate("activity", item.task.id);
          },
        },
      }),
    }),
    [],
  );
}

export interface TaskTableProps {
  tasks: Task[];
  columns?: TaskColumnKey[];
  density?: "compact" | "balanced";
}

/** Repo tasks as rows; a row opens the task's details on the Activity page. */
export function TaskTable({ tasks, columns = ALL_COLUMNS, density = "balanced" }: TaskTableProps) {
  const rowOpens = useRowOpensTask();
  const rows = useMemo(() => tasks.map((task) => ({ id: task.id, task })), [tasks]);
  const cols = useMemo(() => columns.map((k) => COLUMNS[k]), [columns]);
  return <Table<TaskRow> data={rows} columns={cols} idKey="id" density={density} hasHover textOverflow="truncate" plugins={{ rowOpens }} />;
}
