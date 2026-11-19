import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronDownIcon, ChevronUpIcon, CodeBracketSquareIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { headline, usd } from "../../lib/format";
import type { Task } from "../../lib/types";
import { checksStatus, isActiveTask, plainLabel, prLabel, taskNow, taskStatus } from "./labels";
import { ScreenshotStrip } from "./Screenshots";
import { TaskTimelineView } from "./TaskTimelineView";

export interface TaskCardProps {
  task: Task;
}

/**
 * A repo task inline in the thread: status, what the team is doing now, plan
 * progress, pull request and checks, cost and screenshots. "Details" opens
 * the live timeline (steps, team, files, commands, checks, every event).
 */
export function TaskCard({ task }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const status = taskStatus(task);
  const checks = checksStatus(task);
  const active = isActiveTask(task);
  const plan = task.progress?.plan ?? [];
  const planDone = plan.filter((p) => p.status === "completed").length;
  const title = task.report?.title || headline(task.instruction, 120);

  return (
    <Card variant="muted" padding={3} width="100%">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Icon icon={CodeBracketSquareIcon} size="sm" color="secondary" />
          <Text type="label" weight="semibold">
            {task.repo}
          </Text>
          <Badge label={status.label} variant={status.tone} />
          {active && <StatusDot variant="accent" label="Working" isPulsing />}
          <StackItem size="fill">
            <Text type="supporting" color="secondary" maxLines={1}>
              {task.branch ? task.branch : ""}
            </Text>
          </StackItem>
          <Button
            label={expanded ? "Hide details" : "Details"}
            variant="ghost"
            size="sm"
            icon={<Icon icon={expanded ? ChevronUpIcon : ChevronDownIcon} size="sm" />}
            onClick={() => setExpanded((x) => !x)}
          />
        </HStack>

        <Text weight="medium" maxLines={2}>
          {title}
        </Text>

        {active && (
          <VStack gap={2}>
            <Text type="supporting">
              <Text type="supporting" weight="semibold">
                Now:{" "}
              </Text>
              {taskNow(task)}
            </Text>
            {plan.length > 0 && (
              <ProgressBar
                label={`Plan: ${planDone} of ${plan.length} steps done`}
                value={planDone}
                max={plan.length}
                hasValueLabel
                formatValueLabel={(v, m) => `${v}/${m}`}
              />
            )}
          </VStack>
        )}

        {!active && task.status === "failed" && task.error && (
          <Text type="supporting" color="secondary" maxLines={3}>
            {plainLabel(task.error)}
          </Text>
        )}

        <HStack gap={3} vAlign="center" wrap="wrap">
          {task.prUrl && (
            <Link href={task.prUrl} isExternalLink>
              {task.prDraft ? `Draft ${prLabel(task.prUrl).toLowerCase()}` : prLabel(task.prUrl)}
            </Link>
          )}
          {checks && <Badge label={checks.label} variant={checks.tone} />}
          {task.costUsd !== undefined && (
            <Text type="supporting" color="secondary">
              {usd(task.costUsd)}
            </Text>
          )}
          {task.progress && task.progress.filesCount > 0 && (
            <Text type="supporting" color="secondary">
              {task.progress.filesCount} file{task.progress.filesCount === 1 ? "" : "s"} changed
            </Text>
          )}
          <Text type="supporting" color="secondary">
            Started <Timestamp value={task.createdAt} format="relative" isLive />
          </Text>
          {task.trigger === "review" && <Badge label="From PR review" variant="purple" />}
        </HStack>

        {!expanded && <ScreenshotStrip taskId={task.id} count={task.screenshots} />}

        {expanded && (
          <>
            <Divider />
            <TaskTimelineView task={task} />
            {task.branch && (
              <Text type="supporting" color="secondary">
                Branch <Code>{task.branch}</Code> · task <Code>{task.id}</Code>
              </Text>
            )}
          </>
        )}
      </VStack>
    </Card>
  );
}
