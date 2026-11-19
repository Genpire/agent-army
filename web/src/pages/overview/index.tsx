import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatBubbleLeftRightIcon, PauseCircleIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { PageFrame } from "../../components/PageFrame";
import { plural } from "../../lib/format";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { PublicConfig, Task } from "../../lib/types";
import { isActive, planProgress, plainText, requestHeadline, taskDuration, taskStatus } from "../activity/model";
import { TaskTable } from "../activity/TaskTable";
import { LiveNote, StatTile, spendTiles } from "../activity/Usage";
import { useTasks, useUsage } from "../activity/usePolled";

interface Readiness {
  /** The integration pane: #/integrations/<id>. */
  id: string;
  label: string;
  connected: boolean;
  isOptional?: boolean;
  /** Who or what it is connected as, or what connecting it gives. */
  detail: string;
}

function readiness(c: PublicConfig): Readiness[] {
  const githubConnected = c.github.connected || c.github.extra.length > 0;
  const githubAs = [c.github.login, ...c.github.extra.map((x) => x.login)].filter(Boolean);
  return [
    {
      id: "claude",
      label: "Claude",
      connected: c.anthropic.connected,
      detail: c.anthropic.connected ? `API key ${c.anthropic.key ?? ""}${c.anthropic.model ? ` · ${c.anthropic.model}` : ""}`.trim() : "The agents think with your Anthropic API key.",
    },
    {
      id: "slack",
      label: "Slack",
      connected: c.slack.connected,
      detail: c.slack.connected ? `Workspace ${c.slack.teamName ?? "connected"}` : "Where people talk to Pointer.",
    },
    {
      id: "github",
      label: "GitHub",
      connected: githubConnected,
      detail: githubConnected ? (githubAs.length ? `Signed in as ${githubAs.join(", ")}` : "Token saved") : "Lets the team read repos and open pull requests.",
    },
    {
      id: "monday",
      label: "monday.com",
      connected: c.monday.connected,
      isOptional: true,
      detail: c.monday.connected ? [c.monday.accountName, c.monday.userName].filter(Boolean).join(" · ") || "Connected" : "Optional. Pointer can open and update tickets.",
    },
    {
      id: "github",
      label: "Pull request reviews",
      connected: c.github.webhook.configured,
      isOptional: true,
      detail: c.github.webhook.configured ? "Review feedback on GitHub starts follow-up tasks." : "Optional. Review feedback on GitHub starts follow-up tasks.",
    },
  ];
}

function ReadinessList({ items }: { items: Readiness[] }) {
  return (
    <List hasDividers edge="bleed">
      {items.map((r) => (
        <ListItem
          key={r.label}
          label={r.label}
          description={<Text type="supporting">{r.detail}</Text>}
          startContent={
            r.connected ? (
              <StatusDot variant="success" label="Connected" />
            ) : r.isOptional ? (
              <StatusDot variant="neutral" label="Not set up (optional)" />
            ) : (
              <StatusDot variant="warning" label="Not connected" />
            )
          }
          endContent={
            r.connected ? (
              <Text type="supporting">Connected</Text>
            ) : (
              <Button label={r.isOptional ? "Set up" : "Connect"} size="sm" variant={r.isOptional ? "ghost" : "secondary"} href={href("integrations", r.id)} />
            )
          }
        />
      ))}
    </List>
  );
}

function RunningRow({ task, now }: { task: Task; now: number }) {
  const status = taskStatus(task);
  const plan = planProgress(task.progress);
  const elapsed = taskDuration(task, now);
  const doing = task.status === "queued" ? "Waiting for a free worker" : task.progress ? plainText(task.progress.now) : "Starting";
  return (
    <ListItem
      href={href("activity", task.id)}
      label={requestHeadline(task, 80)}
      description={`${task.repo} · ${doing}`}
      startContent={<StatusDot variant={status.variant} label={status.label} isPulsing={status.isPulsing} />}
      endContent={
        <VStack gap={1} hAlign="end" width={112}>
          <Text type="supporting" hasTabularNumbers>
            {[plan && `${plan.done}/${plan.total}`, elapsed].filter(Boolean).join(" · ") || status.label}
          </Text>
          {plan && <ProgressBar label="Plan progress" isLabelHidden value={plan.done} max={plan.total} />}
        </VStack>
      }
    />
  );
}

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <VStack gap={4}>
        <HStack gap={3} hAlign="between" vAlign="center">
          <Heading level={3} accessibilityLevel={2}>
            {title}
          </Heading>
          {aside}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}

const ListSkeleton = () => (
  <VStack gap={2}>
    {[0, 1, 2].map((i) => (
      <Skeleton key={i} height={40} index={i} />
    ))}
  </VStack>
);

export default function OverviewPage() {
  const { config, state } = useConfig();
  const tasks = useTasks();
  const usage = useUsage();
  const now = tasks.loadedAt ?? Date.now();
  const pointer = config.team.pointer.name;

  const items = readiness(config);
  const missing = items.filter((r) => !r.connected && !r.isOptional);
  const active = (tasks.data ?? []).filter(isActive);
  const running = active.filter((t) => t.status === "running").length;
  const queued = active.length - running;
  const recent = (tasks.data ?? []).slice(0, 5);

  return (
    <PageFrame
      title="Overview"
      description={`${config.orgName ? `${config.orgName}: what` : "What"} ${pointer} and the team are doing, and what still needs setting up.`}
      actions={
        state.ready && (
          <HStack gap={2} vAlign="center">
            <StatusDot variant="success" label="Ready" />
            <Text type="supporting">Ready for requests</Text>
          </HStack>
        )
      }>
      <VStack gap={6}>
        {!state.ready && missing[0] && (
          <Banner
            status="warning"
            title={`${plural(missing.length, "integration")} to connect`}
            description={`Still missing: ${missing.map((m) => m.label).join(", ")}. ${pointer} needs Claude and Slack to answer, and GitHub to change code.`}
            endContent={<Button label={`Connect ${missing[0].label}`} variant="primary" href={href("integrations", missing[0].id)} />}
            collapsible={false}
          />
        )}

        <Grid columns={{ minWidth: 150, repeat: "fit" }} gap={3}>
          {spendTiles(usage.data).map((tile) => (
            <StatTile key={tile.label} {...tile} />
          ))}
          <StatTile
            label="Active tasks"
            value={tasks.data ? String(active.length) : "–"}
            detail={tasks.data ? `${running} running · ${queued} queued` : "Loading"}
          />
        </Grid>

        <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={3}>
          <Panel title="Running now" aside={<LiveNote error={tasks.error} />}>
            {!tasks.data ? (
              tasks.error ? <Text color="secondary">{tasks.error}</Text> : <ListSkeleton />
            ) : active.length === 0 ? (
              <EmptyState
                isCompact
                title="Nothing running"
                description={`Repo tasks show up here while the team works on them.`}
                icon={<Icon icon={PauseCircleIcon} size="lg" />}
              />
            ) : (
              <List hasDividers edge="bleed">
                {active.map((t) => (
                  <RunningRow key={t.id} task={t} now={now} />
                ))}
              </List>
            )}
          </Panel>
          <Panel title="Readiness" aside={<Text type="supporting">{`${items.filter((r) => r.connected).length} of ${items.length} set up`}</Text>}>
            <ReadinessList items={items} />
          </Panel>
        </Grid>

        <Divider />

        <VStack gap={4}>
          <HStack gap={3} hAlign="between" vAlign="center">
            <Heading level={2}>Recent tasks</Heading>
            <Link href={href("activity")} isStandalone>
              All activity
            </Link>
          </HStack>
          {!tasks.data ? (
            !tasks.error && <ListSkeleton />
          ) : recent.length === 0 ? (
            <EmptyState
              title="No repo tasks yet"
              description={`Ask ${pointer} in Slack to change a repository, for example "@${pointer} in owner/repo: fix the login bug".`}
              icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />}
            />
          ) : (
            <TaskTable tasks={recent} columns={["status", "request", "repo", "started", "cost"]} />
          )}
        </VStack>
      </VStack>
    </PageFrame>
  );
}
