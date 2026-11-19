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
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowPathIcon, EllipsisHorizontalCircleIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { type ReactNode, useRef } from "react";
import { plural, usd } from "../../lib/format";
import type { ProgressSnapshot, Task } from "../../lib/types";
import { checksView, isActive, parseStep, planProgress, plainText, prLabel, requestHeadline, taskDuration, taskStatus } from "./model";
import { ChecksStatus, StatusLabel } from "./TaskTable";

/** Longest request first line shown whole as the drawer's title. */
const TITLE_MAX = 160;

const PLAN_ICON = {
  completed: <Icon icon={CheckCircleIcon} size="sm" color="success" label="Done" />,
  in_progress: <Icon icon={ArrowPathIcon} size="sm" color="accent" label="In progress" />,
  pending: <Icon icon={EllipsisHorizontalCircleIcon} size="sm" color="secondary" label="To do" />,
} as const;

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

/** The live dashboard of a running task, the same one Pointer edits in its Slack thread. */
function LiveProgress({ progress }: { progress: ProgressSnapshot }) {
  const plan = planProgress(progress);
  const extraFiles = progress.filesCount - progress.files.length;
  return (
    <VStack gap={6}>
      <Block
        title="Now"
        aside={
          <Text type="supporting">
            Updated <Timestamp value={progress.updatedAt} format="relative" isLive type="inherit" color="inherit" />
          </Text>
        }>
        <HStack gap={2} vAlign="center">
          <StatusDot variant="accent" label="Working" isPulsing />
          <Text weight="semibold">{plainText(progress.now) || "Working"}</Text>
        </HStack>
      </Block>

      {plan && (
        <Block
          title="Plan"
          aside={
            <Text type="supporting" hasTabularNumbers>
              {plan.done} of {plan.total} done
            </Text>
          }>
          <ProgressBar label="Plan progress" isLabelHidden value={plan.done} max={plan.total} />
          <List density="compact" edge="flush">
            {progress.plan.map((item, i) => (
              <ListItem key={`${i}-${item.content}`} label={<Text>{plainText(item.content)}</Text>} startContent={PLAN_ICON[item.status]} align="first-line" />
            ))}
          </List>
        </Block>
      )}

      {progress.agents.length > 0 && (
        <Block title="Agents">
          <List density="compact" hasDividers edge="flush">
            {progress.agents.map((a, i) => (
              <ListItem
                key={`${i}-${a.label}`}
                align="first-line"
                label={plainText(a.label)}
                description={<Text type="supporting">{plainText(a.outcome ? `${a.description}. ${a.outcome}` : a.description)}</Text>}
                startContent={
                  a.state === "working" ? <StatusDot variant="accent" label="Working" isPulsing /> : <StatusDot variant="success" label="Done" />
                }
                endContent={
                  <Text type="supporting" hasTabularNumbers>
                    {a.minutes} min · {plural(a.toolUses, "tool use")}
                  </Text>
                }
              />
            ))}
          </List>
        </Block>
      )}

      {progress.recent.length > 0 && (
        <Block title="Latest steps">
          <List density="compact" edge="flush">
            {[...progress.recent].reverse().map((line, i) => {
              const step = parseStep(line);
              return (
                <ListItem
                  key={`${i}-${line}`}
                  label={<Text>{step.text}</Text>}
                  align="first-line"
                  endContent={
                    step.minute && (
                      <Text type="supporting" hasTabularNumbers>
                        {step.minute}
                      </Text>
                    )
                  }
                />
              );
            })}
          </List>
        </Block>
      )}

      {progress.filesCount > 0 && (
        <Block title="Files changed" aside={<Text type="supporting">{plural(progress.filesCount, "file")}</Text>}>
          <List density="compact" edge="flush">
            {progress.files.map((f) => (
              <ListItem key={f} label={<Code>{f}</Code>} />
            ))}
            {extraFiles > 0 && <ListItem label={<Text color="secondary">and {extraFiles} more</Text>} />}
          </List>
        </Block>
      )}
    </VStack>
  );
}

function Outcome({ task }: { task: Task }) {
  if (task.status === "failed") {
    return (
      <Banner
        status={task.prUrl ? "warning" : "error"}
        title={task.prUrl ? "Stopped before finishing" : "The task failed"}
        description={[task.error, task.prUrl && "The work so far is in a draft pull request; reply in the Slack thread to continue."].filter(Boolean).join(" ")}
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
        <Text>{task.screenshots ? `${plural(task.screenshots, "screenshot")} in the Slack thread` : "None"}</Text>
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
        <Text>{task.trigger === "review" ? "Feedback on the pull request" : "A message in Slack"}</Text>
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
      {task.status === "running" && task.progress && <LiveProgress progress={task.progress} />}
      {task.status === "queued" && <Text color="secondary">Waiting for a free worker. Progress shows here once the team starts.</Text>}
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
