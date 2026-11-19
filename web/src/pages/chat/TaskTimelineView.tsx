import { Badge } from "@astryxdesign/core/Badge";
import { Code } from "@astryxdesign/core/Code";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import {
  CheckCircleIcon,
  ClockIcon,
  CommandLineIcon,
  EllipsisHorizontalCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  GlobeAltIcon,
  PencilSquareIcon,
  PlayCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { CheckItem, PhaseInfo, Task, TaskEvent, TaskTimeline } from "../../lib/types";
import { TASK_PHASE_ORDER } from "../../lib/types";
import { useTaskTimeline } from "./hooks";
import { EVENT_VERB, PHASE_LABEL, type StatusTone, agentWork, between, formatMs, isActiveTask, plainLabel } from "./labels";
import { PreviewStatus } from "./PreviewStatus";
import { ScreenshotStrip } from "./Screenshots";

/** Rows shown per list before the rest are summarised. */
const SHOWN = 40;

/** The stepper's phases: the timeline's, or derived from the task when it has none (older tasks). */
function phasesOf(task: Task, timeline: TaskTimeline | null | undefined): PhaseInfo[] {
  if (timeline?.phases.length) return timeline.phases;
  const current = task.stage?.phase;
  const at = current ? TASK_PHASE_ORDER.indexOf(current) : -1;
  return TASK_PHASE_ORDER.map((phase, i) => ({
    phase,
    state: task.status === "done" ? "done" : i < at ? "done" : i === at ? (isActiveTask(task) ? "active" : "failed") : "pending",
  }));
}

function PhaseStepper({ phases }: { phases: PhaseInfo[] }) {
  const active = phases.findIndex((p) => p.state === "active");
  const lastRan = phases.reduce((last, p, i) => (p.state === "done" || p.state === "failed" ? i : last), -1);
  const activeStep = active >= 0 ? active : phases.every((p) => p.state !== "pending") ? phases.length : lastRan + 1;
  return (
    <Stepper activeStep={activeStep} density="compact" label="Task steps">
      {phases.map((p, i) => {
        const took = formatMs(between(p.startedAt, p.endedAt));
        const description = p.state === "skipped" ? "Skipped" : p.state === "failed" ? p.note || "Stopped here" : p.state === "active" ? "Now" : took || undefined;
        return (
          <Step
            key={p.phase}
            step={i}
            label={PHASE_LABEL[p.phase]}
            description={description}
            status={p.state === "failed" ? "error" : undefined}
            isDisabled={p.state === "skipped"}
            indicator={p.state === "failed" ? <Icon icon={XCircleIcon} size="sm" /> : "auto"}
          />
        );
      })}
    </Stepper>
  );
}

const CHECK_TONE: Record<CheckItem["state"], StatusTone> = {
  passed: "success",
  failed: "error",
  running: "info",
  queued: "neutral",
  skipped: "neutral",
  neutral: "neutral",
};

function Part({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Collapsible
      defaultIsOpen={defaultOpen}
      trigger={
        <HStack gap={2} vAlign="center">
          <Text type="label" weight="semibold">
            {title}
          </Text>
          {count !== undefined && <Badge label={String(count)} />}
        </HStack>
      }>
      {children}
    </Collapsible>
  );
}

function More({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <Text type="supporting" color="secondary">
      …and {total - shown} more
    </Text>
  );
}

const stepIcon = (e: TaskEvent) =>
  e.kind === "edit"
    ? PencilSquareIcon
    : e.kind === "command"
      ? CommandLineIcon
      : e.kind === "browser"
        ? GlobeAltIcon
        : e.kind === "preview"
          ? EyeIcon
          : e.kind === "error"
            ? ExclamationTriangleIcon
            : ClockIcon;

function EventRow({ e, showAgent = true }: { e: TaskEvent; showAgent?: boolean }) {
  const who = showAgent && e.agent ? `${e.agent} · ` : "";
  const took = e.ms !== undefined ? ` · ${formatMs(e.ms)}` : "";
  return (
    <ListItem
      label={e.kind === "command" || e.kind === "edit" ? <Code>{e.text}</Code> : e.text}
      description={`${who}${EVENT_VERB[e.kind]} · ${PHASE_LABEL[e.phase]}${took}`}
      startContent={<Icon icon={e.ok === false ? XCircleIcon : stepIcon(e)} size="sm" color={e.ok === false || e.kind === "error" ? "error" : "secondary"} />}
      endContent={<Timestamp value={e.at} format="time" />}
      align="first-line"
    />
  );
}

export interface TaskTimelineViewProps {
  task: Task;
}

/**
 * Everything happening inside a repo task, live: the step it is on, its plan,
 * what each team member did and for how long, files, commands, the pull
 * request's checks, its preview deployment, screenshots, and the full event log.
 */
export function TaskTimelineView({ task }: TaskTimelineViewProps) {
  const { timeline, error } = useTaskTimeline(task, true);
  const events = timeline?.events ?? [];
  const progress = task.progress;
  const plan = progress?.plan ?? [];
  const planDone = plan.filter((p) => p.status === "completed").length;
  const work = agentWork(events);
  const commands = events.filter((e) => e.kind === "command");
  const checks = timeline?.checks ?? [];
  const previewEvents = events.filter((e) => e.kind === "preview");
  const log = events.slice(-100);

  return (
    <VStack gap={4}>
      <PhaseStepper phases={phasesOf(task, timeline)} />
      {timeline === undefined && !error && <Spinner size="sm" label="Loading the timeline" />}
      {error && (
        <Text type="supporting" color="secondary">
          The timeline could not be loaded: {error}
        </Text>
      )}

      {plan.length > 0 && (
        <Part title={`Plan · ${planDone} of ${plan.length} done`} defaultOpen>
          <List density="compact">
            {plan.map((p, i) => (
              <ListItem
                key={`${i}-${p.content}`}
                label={p.content}
                startContent={
                  <Icon
                    icon={p.status === "completed" ? CheckCircleIcon : p.status === "in_progress" ? PlayCircleIcon : EllipsisHorizontalCircleIcon}
                    size="sm"
                    color={p.status === "completed" ? "success" : p.status === "in_progress" ? "accent" : "tertiary"}
                  />
                }
              />
            ))}
          </List>
        </Part>
      )}

      {work.length > 0 && (
        <Part title="Team" count={work.length} defaultOpen>
          <VStack gap={2}>
            {work.map((w) => (
              <Collapsible
                key={w.agent}
                defaultIsOpen={w.working}
                trigger={
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="semibold">{w.agent}</Text>
                    <Badge
                      label={w.working ? "Working" : w.failed ? "Stopped with an error" : w.runs ? "Done" : "Steps"}
                      variant={w.working ? "info" : w.failed ? "error" : "neutral"}
                    />
                    <Text type="supporting" color="secondary">
                      {[w.ms ? formatMs(w.ms) : "", `${w.steps.length} step${w.steps.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </Text>
                  </HStack>
                }>
                <VStack gap={2}>
                  {w.assignment && (
                    <Text type="supporting">
                      <Text type="supporting" weight="semibold">
                        Asked to:{" "}
                      </Text>
                      {w.assignment}
                    </Text>
                  )}
                  {w.outcome && !w.working && (
                    <Text type="supporting">
                      <Text type="supporting" weight="semibold">
                        Reported:{" "}
                      </Text>
                      {w.outcome}
                    </Text>
                  )}
                  {w.steps.length > 0 && (
                    <List density="compact">
                      {w.steps.slice(-SHOWN).map((e, i) => (
                        <EventRow key={`${e.at}-${i}`} e={e} showAgent={false} />
                      ))}
                    </List>
                  )}
                  <More shown={SHOWN} total={w.steps.length} />
                </VStack>
              </Collapsible>
            ))}
          </VStack>
        </Part>
      )}

      {progress && progress.filesCount > 0 && (
        <Part title="Files changed" count={progress.filesCount}>
          <List density="compact">
            {progress.files.map((f) => (
              <ListItem key={f} label={<Code>{f}</Code>} startContent={<Icon icon={PencilSquareIcon} size="sm" color="secondary" />} />
            ))}
          </List>
          <More shown={progress.files.length} total={progress.filesCount} />
        </Part>
      )}

      {commands.length > 0 && (
        <Part title="Commands run" count={commands.length}>
          <List density="compact">
            {commands.slice(-SHOWN).map((e, i) => (
              <EventRow key={`${e.at}-${i}`} e={e} />
            ))}
          </List>
          <More shown={SHOWN} total={commands.length} />
        </Part>
      )}

      {checks.length > 0 && (
        <Part title="Pull request checks" count={checks.length} defaultOpen>
          <List density="compact">
            {checks.map((c) => (
              <ListItem
                key={c.name}
                label={c.url ? <Link href={c.url} isExternalLink>{c.name}</Link> : c.name}
                endContent={<Badge label={c.state} variant={CHECK_TONE[c.state]} />}
              />
            ))}
          </List>
        </Part>
      )}

      {(previewEvents.length > 0 || (task.preview && task.preview.state !== "skipped")) && (
        <Part title="Preview deployment" defaultOpen>
          <VStack gap={2}>
            <PreviewStatus task={task} noteLines={0} />
            {previewEvents.length > 0 && (
              <List density="compact">
                {previewEvents.slice(-SHOWN).map((e, i) => (
                  <EventRow key={`${e.at}-${i}`} e={e} showAgent={false} />
                ))}
              </List>
            )}
          </VStack>
        </Part>
      )}

      {(task.screenshots ?? 0) > 0 && (
        <Part title="Screenshots" count={task.screenshots} defaultOpen>
          <ScreenshotStrip taskId={task.id} count={task.screenshots} />
        </Part>
      )}

      {log.length > 0 && (
        <Part title="Everything that happened" count={events.length + (timeline?.dropped ?? 0)}>
          <VStack gap={1}>
            {(timeline?.dropped ?? 0) > 0 || events.length > log.length ? (
              <Text type="supporting" color="secondary">
                Showing the latest {log.length} events.
              </Text>
            ) : null}
            <List density="compact">
              {log.map((e, i) => (
                <EventRow key={`${e.at}-${i}`} e={{ ...e, text: plainLabel(e.text) }} />
              ))}
            </List>
          </VStack>
        </Part>
      )}
    </VStack>
  );
}
