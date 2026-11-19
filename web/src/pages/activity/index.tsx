import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowPathIcon, ChatBubbleLeftRightIcon, FunnelIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { STATUS_FILTERS, type StatusFilter, monthName } from "./model";
import { TaskDrawer } from "./TaskDrawer";
import { TaskTable } from "./TaskTable";
import { LiveNote, StatTile, TopTasksTable, spendTiles } from "./Usage";
import { useTasks, useUsage } from "./usePolled";

function TasksSkeleton() {
  return (
    <VStack gap={2}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} height={36} index={i} />
      ))}
    </VStack>
  );
}

export default function ActivityPage() {
  const { config } = useConfig();
  const route = useRoute();
  const tasks = useTasks();
  const usage = useUsage();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const pointer = config.team.pointer.name;

  const visible = useMemo(() => {
    const matches = STATUS_FILTERS.find((f) => f.value === filter)?.matches ?? (() => true);
    return (tasks.data ?? []).filter(matches);
  }, [tasks.data, filter]);

  const all = tasks.data ?? [];

  return (
    <PageFrame
      title="Activity"
      description="Repo tasks from Slack and the console: their progress, results and what they cost."
      actions={
        <>
          <LiveNote error={tasks.error} />
          <Button
            label="Refresh"
            variant="secondary"
            icon={<Icon icon={ArrowPathIcon} />}
            clickAction={async () => {
              await Promise.all([tasks.reload(), usage.reload()]);
            }}
          />
        </>
      }>
      <VStack gap={10}>
        <VStack gap={4}>
          <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
            <SegmentedControl label="Filter by status" value={filter} onChange={(v) => setFilter(v as StatusFilter)}>
              {STATUS_FILTERS.map((f) => (
                <SegmentedControlItem key={f.value} value={f.value} label={f.label} />
              ))}
            </SegmentedControl>
            <Text type="supporting">
              {tasks.data
                ? filter === "all"
                  ? `The ${all.length} most recent tasks`
                  : `${visible.length} of the ${all.length} most recent tasks`
                : "Loading tasks"}
            </Text>
          </HStack>

          {tasks.error && !tasks.data && <Banner status="error" title="Could not load the tasks" description={tasks.error} collapsible={false} />}

          {!tasks.data ? (
            !tasks.error && <TasksSkeleton />
          ) : all.length === 0 ? (
            <EmptyState
              title="No repo tasks yet"
              description={`Ask ${pointer} in Chat or in Slack to change a repository, for example "in owner/repo: fix the login bug". Its progress shows up here.`}
              icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No tasks with this status"
              description="None of the recent tasks match the filter."
              icon={<Icon icon={FunnelIcon} size="lg" />}
              actions={<Button label="Show all" variant="secondary" onClick={() => setFilter("all")} />}
            />
          ) : (
            <TaskTable tasks={visible} />
          )}
        </VStack>

        <Divider />

        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>{usage.data ? `Spend in ${monthName(usage.data.month)}` : "Spend this month"}</Heading>
            <Text color="secondary">Claude credit used this calendar month (UTC), by chat replies and repo tasks.</Text>
          </VStack>
          {usage.error && <Banner status="error" title="Could not load this month's spend" description={usage.error} collapsible={false} />}
          <Grid columns={{ minWidth: 150, repeat: "fit" }} gap={3}>
            {spendTiles(usage.data).map((tile) => (
              <StatTile key={tile.label} {...tile} />
            ))}
          </Grid>
          <Card>
            <VStack gap={4}>
              <Heading level={3}>Most expensive tasks</Heading>
              {usage.data && usage.data.topTasks.length > 0 ? (
                <TopTasksTable topTasks={usage.data.topTasks} />
              ) : (
                <Text color="secondary">{usage.data ? "No repo task has a cost yet this month." : "Loading"}</Text>
              )}
            </VStack>
          </Card>
        </VStack>
      </VStack>

      <TaskDrawer taskId={route.rest[0]} tasks={tasks.data} onClose={() => navigate("activity")} />
    </PageFrame>
  );
}
