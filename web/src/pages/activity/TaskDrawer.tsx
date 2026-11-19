import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useRef } from "react";
import { plural, usd } from "../../lib/format";
import { href } from "../../lib/router";
import type { Task } from "../../lib/types";
import { checksView, isActive, plainText, prLabel, requestHeadline, taskDuration, taskStatus } from "./model";
import { ChecksStatus, StatusLabel } from "./TaskTable";
import { TaskTimelineView } from "../chat/TaskTimelineView";

/** Started from the admin console (Chat or a direct task), not Slack. */
const fromConsole = (task: Task) => task.channel === "web";

/** Longest request first line shown whole as the drawer's title. */
const TITLE_MAX = 160;


function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <VStack gap={2}>
      <HStack gap={3} hAlign="between" vAlign="center">
        <Heading level={3}>{title}</Heading>
        {aside}
      </HStack>
      {children}
    </VStack>
  );
}

function Outcome({ task }: { task: Task }) {
  if (task.status === "failed") {
    return (
      <Banner
        status={task.prUrl ? "warning" : "error"}
        title={task.prUrl ? "Stopped before finishing" : "The task failed"}
        description={[
          task.error,
          task.prUrl &&
            (fromConsole(task)
              ? "The work so far is in a draft pull request; continue in its conversation in Chat."
              : "The work so far is in a draft pull request; reply in the Slack thread to continue."),
        ]
          .filter(Boolean)
          .join(" ")}
        collapsible={false}
      />
    );
  }
  if (task.status === "done" && task.kind === "blocked") {
    return <Banner status="warning" title="Blocked" description="The team could not go on. The summary below says why." collapsible={false} />;
  }
  return null;
}

function Details({ task }: { task: Task }) {
  const status = taskStatus(task);
  const elapsed = taskDuration(task);
  return (
    <MetadataList label={{ position: "start", width: 132 }}>
      <MetadataListItem label="Status">
        <VStack gap={1}>
          <StatusLabel {...status} />
          <Text type="supporting">{status.description}</Text>
        </VStack>
      </MetadataListItem>
      <MetadataListItem label="Pull request">
        {task.prUrl ? (
          <Link href={task.prUrl} isExternalLink>
            {`${prLabel(task.prUrl)}${task.status === "failed" ? " (draft)" : ""}`}
          </Link>
        ) : (
          <Text color="secondary">None</Text>
        )}
      </MetadataListItem>
      <MetadataListItem label="Branch">{task.branch ? <Code>{task.branch}</Code> : <Text color="secondary">{isActive(task) ? "Not created yet" : "None"}</Text>}</MetadataListItem>
      <MetadataListItem label="Checks">
        {task.ci ? (
          <VStack gap={1}>
            <ChecksStatus ci={task.ci} />
            <Text type="supporting">{checksView(task.ci).description}</Text>
          </VStack>
        ) : (
          <Text color="secondary">{task.prUrl ? "Not followed" : "No pull request"}</Text>
        )}
      </MetadataListItem>
      <MetadataListItem label="Screenshots">
        <Text>{task.screenshots ? `${plural(task.screenshots, "screenshot")}${fromConsole(task) ? "" : ", also in the Slack thread"}` : "None"}</Text>
      </MetadataListItem>
      <MetadataListItem label="Cost">
        <Text hasTabularNumbers>
          {task.costUsd === undefined ? "–" : usd(task.costUsd)}
          {task.turns !== undefined ? ` · ${plural(task.turns, "turn")}` : ""}
        </Text>
      </MetadataListItem>
      <MetadataListItem label="Started">
        <Timestamp value={task.createdAt} format="date_time" type="body" color="primary" />
      </MetadataListItem>
      <MetadataListItem label={task.status === "running" ? "Running for" : "Duration"}>
        <Text>{elapsed ?? "Not started"}</Text>
      </MetadataListItem>
      <MetadataListItem label="Started by">
        {task.trigger === "review" ? (
          <Text>Feedback on the pull request</Text>
        ) : fromConsole(task) ? (
          <Link href={href("chat", task.threadTs)}>The admin console: open the conversation</Link>
        ) : (
          <Text>A message in Slack</Text>
        )}
      </MetadataListItem>
      <MetadataListItem label="Task ID">
        <Code color="secondary">{task.id}</Code>
      </MetadataListItem>
    </MetadataList>
  );
}

function TaskDetails({ task }: { task: Task }) {
  const lines = task.instruction.split("\n").map(plainText).filter(Boolean);
  // The drawer's title is the request's first line; the full request shows only when there is more to it.
  const hasMore = lines.length > 1 || lines[0] !== requestHeadline(task, TITLE_MAX);
  return (
    <VStack gap={8}>
      <Outcome task={task} />
      {hasMore && (
        <Block title="Request">
          <VStack gap={2}>
            {lines.map((line, i) => (
              <Text key={i} display="block">
                {line}
              </Text>
            ))}
          </VStack>
        </Block>
      )}
      {task.status === "queued" && <Text color="secondary">Waiting for a free worker. Progress shows here once the team starts.</Text>}
      {task.status !== "queued" && (
        <Block title={task.status === "running" ? "Live progress" : "What happened"}>
          <TaskTimelineView task={task} />
        </Block>
      )}
      {task.summary && (
        <Block title={task.kind === "answer" ? "Answer" : "Summary"}>
          <Markdown density="compact" headingLevelStart={4}>
            {task.summary}
          </Markdown>
        </Block>
      )}
      <Block title="Details">
        <Details task={task} />
      </Block>
    </VStack>
  );
}

export interface TaskDrawerProps {
  /** The task id in the route, or undefined when the drawer is closed. */
  taskId: string | undefined;
  /** The loaded tasks; undefined while the first load runs. */
  tasks: Task[] | undefined;
  onClose: () => void;
}

/** A task's details, opened from a row (#/activity/<id>). The page's polling keeps it fresh while it is open. */
export function TaskDrawer({ taskId, tasks, onClose }: TaskDrawerProps) {
  const found = taskId ? tasks?.find((t) => t.id === taskId) : undefined;
  // Keep the last task rendered while the drawer slides out.
  const last = useRef<Task | undefined>(undefined);
  if (found) last.current = found;
  const task = taskId ? found : last.current;
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <Drawer isOpen={Boolean(taskId)} onOpenChange={onOpenChange} label={task ? `Task: ${requestHeadline(task, 60)}` : "Task"} width={560}>
      <Layout
        header={
          <DrawerHeader
            title={task ? requestHeadline(task, TITLE_MAX) : "Task"}
            subtitle={task ? task.repo : undefined}
            onOpenChange={onOpenChange}
            hasDivider
          />
        }
        content={
          <LayoutContent>
            {task ? (
              <TaskDetails task={task} />
            ) : tasks === undefined ? (
              <Spinner label="Loading the task" />
            ) : (
              <EmptyState
                title="Task not in the recent list"
                description="Only the 30 most recent repo tasks are shown here."
                icon={<Icon icon={MagnifyingGlassIcon} size="lg" />}
              />
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="Close" variant="secondary" onClick={onClose} />
              {task?.prUrl && <Button label={task.status === "failed" ? "Open draft PR" : "Open pull request"} variant="primary" href={task.prUrl} target="_blank" />}
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}
