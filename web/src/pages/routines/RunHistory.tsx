import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ClockIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { href } from "../../lib/router";
import { usd } from "../../lib/format";
import { type DeliveryOutcome, type RoutineRun, type RoutineView, type RunSummary, STATUS_LABEL, STATUS_VARIANT, TRIGGER_LABEL, routinePath, runPath, runTime } from "./model";

const outcomeText = (o: DeliveryOutcome | null): string | undefined => (o === null ? undefined : o.ok ? (o.detail ?? "Delivered") : `Not delivered: ${o.error}`);

/** Where one run's report went. */
function Deliveries({ run, conversationId }: { run: RunSummary; conversationId: string | null }) {
  const rows = [
    { label: "Email", text: outcomeText(run.delivered.email) },
    { label: "Slack", text: outcomeText(run.delivered.slack) },
    { label: "Console", text: outcomeText(run.delivered.console) },
  ].filter((r) => r.text !== undefined);
  if (!rows.length && !run.note && !run.error) return null;
  return (
    <MetadataList label={{ position: "start", width: 80 }}>
      {run.note && (
        <MetadataListItem label="Note">
          <Text>{run.note}</Text>
        </MetadataListItem>
      )}
      {run.error && (
        <MetadataListItem label="Error">
          <Text>{run.error}</Text>
        </MetadataListItem>
      )}
      {rows.map((r) => (
        <MetadataListItem key={r.label} label={r.label}>
          {r.label === "Console" && run.delivered.console?.ok && conversationId ? (
            <Link href={href("chat", conversationId)}>Open the conversation</Link>
          ) : (
            <Text>{r.text}</Text>
          )}
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

/** One run: its status line, and its report (loaded when opened) rendered like Pointer's chat answers. */
function RunRow({ routine, run, isFirst }: { routine: RoutineView; run: RunSummary; isFirst: boolean }) {
  const [isOpen, setIsOpen] = useState(isFirst && run.hasReport);
  const [detail, setDetail] = useState<RoutineRun>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen || !run.hasReport || detail?.id === run.id) return;
    let live = true;
    api
      .get<{ run: RoutineRun }>(runPath(routine.id, run.id))
      .then((r) => live && setDetail(r.run))
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [isOpen, run.hasReport, run.id, routine.id, detail?.id]);

  const trigger = (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Badge label={STATUS_LABEL[run.status]} variant={STATUS_VARIANT[run.status]} />
      <Text weight="medium">{runTime(run.scheduledFor, routine.schedule.timezone)}</Text>
      <Text type="supporting">{TRIGGER_LABEL[run.trigger]}</Text>
      {run.costUsd !== undefined && <Text type="supporting">{usd(run.costUsd)}</Text>}
    </HStack>
  );

  return (
    <Collapsible trigger={trigger} isOpen={isOpen} onOpenChange={setIsOpen}>
      <VStack gap={3}>
        <Deliveries run={run} conversationId={routine.conversationId} />
        {run.status === "running" && <Spinner size="sm" label="Running: the report appears here when it is done." />}
        {run.hasReport &&
          (error ? (
            <Banner status="error" title="Couldn't load the report" description={error} collapsible={false} />
          ) : detail?.report ? (
            <Card variant="muted">
              <Markdown density="compact" headingLevelStart={4}>
                {detail.report}
              </Markdown>
            </Card>
          ) : (
            <Spinner size="sm" label="Loading the report" />
          ))}
      </VStack>
    </Collapsible>
  );
}

export interface RunHistoryProps {
  routine: RoutineView;
  /** Bumped by the page after Run now, so the list reloads. */
  version: number;
}

/** A routine's last runs, newest first; reloads while one is running. */
export function RunHistory({ routine, version }: RunHistoryProps) {
  const [runs, setRuns] = useState<RunSummary[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setRuns((await api.get<{ runs: RunSummary[] }>(`${routinePath(routine.id)}/runs`)).runs);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [routine.id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const running = routine.running || runs?.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (error) {
    return <Banner status="error" title="Couldn't load the runs" description={error} collapsible={false} endContent={<Button label="Try again" size="sm" clickAction={load} />} />;
  }
  if (!runs) return <Spinner label="Loading the runs" />;
  if (!runs.length) {
    return (
      <EmptyState
        isCompact
        icon={<Icon icon={ClockIcon} size="lg" />}
        title="No runs yet"
        description={routine.nextRuns[0] ? `The first run is ${runTime(routine.nextRuns[0], routine.schedule.timezone)}. Run it now to see a report.` : "Run it now to see a report."}
      />
    );
  }
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting">The last {runs.length === 1 ? "run" : `${runs.length} runs`}, newest first. The last 50 are kept.</Text>
        </StackItem>
        <Button label="Refresh" size="sm" variant="ghost" clickAction={load} />
      </HStack>
      {runs.map((run, i) => (
        <RunRow key={run.id} routine={routine} run={run} isFirst={i === 0} />
      ))}
    </VStack>
  );
}
