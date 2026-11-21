import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatBubbleLeftRightIcon, ClockIcon, ComputerDesktopIcon, EnvelopeIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { api } from "../../lib/api";
import { navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { usePolled } from "../activity/usePolled";
import { SectionHeader } from "../projects/components/SectionHeader";
import { EXAMPLES, ROUTINES_PATH, type RoutineExample, type RoutineList, type RoutineView, STATUS_LABEL, STATUS_VARIANT, deliveryText, routinePath, runTime } from "./model";
import { type DrawerTab, RoutineDrawer } from "./RoutineDrawer";
import { TickSection } from "./TickSection";

type RoutineRow = RoutineView & Record<string, unknown>;

/** How the list re-reads: often while a run is going, else once a minute (next runs and last runs move). */
const EVERY_MS = 30_000;

/** Email, Slack and console icons for where a routine reports. */
function DeliveryIcons({ routine }: { routine: RoutineView }) {
  const items = [
    routine.deliver.email.length ? { key: "email", icon: EnvelopeIcon, tip: `Email: ${routine.deliver.email.join(", ")}` } : undefined,
    routine.deliver.slack ? { key: "slack", icon: ChatBubbleLeftRightIcon, tip: `Slack: ${routine.deliver.slack}` } : undefined,
    routine.deliver.console ? { key: "console", icon: ComputerDesktopIcon, tip: "Console: a conversation on the Chat page" } : undefined,
  ].filter((x) => x !== undefined);
  if (!items.length) return <Text type="supporting">Nowhere</Text>;
  return (
    <HStack gap={2} vAlign="center">
      {items.map((i) => (
        <Tooltip key={i.key} content={i.tip}>
          <Icon icon={i.icon} size="sm" color="secondary" label={i.tip} />
        </Tooltip>
      ))}
    </HStack>
  );
}

function LastRun({ routine }: { routine: RoutineView }) {
  if (routine.running) return <Spinner size="sm" label="Running now" />;
  const last = routine.lastRun;
  if (!last) return <Text type="supporting">Not run yet</Text>;
  return (
    <VStack gap={0.5}>
      <HStack gap={2} vAlign="center">
        <Badge label={STATUS_LABEL[last.status]} variant={STATUS_VARIANT[last.status]} />
      </HStack>
      <Timestamp value={last.startedAt} format="relative" />
    </VStack>
  );
}

function ScheduleCell({ routine }: { routine: RoutineView }) {
  const next = routine.nextRuns[0];
  return (
    <VStack gap={0.5}>
      <Text>{routine.scheduleText}</Text>
      <Text type="supporting">
        {routine.problem ?? (!routine.enabled ? "Paused" : next ? `Next ${runTime(next, routine.schedule.timezone)}` : "No upcoming runs")}
      </Text>
    </VStack>
  );
}

function RoutinesTable({ routines, onToggle }: { routines: RoutineView[]; onToggle: (r: RoutineView, enabled: boolean) => Promise<void> }) {
  const isNarrow = useMediaQuery("(max-width: 760px)");
  const nameColumn: TableColumn<RoutineRow> = {
    key: "name",
    header: "Routine",
    width: proportional(1, { minWidth: 220 }),
    renderCell: (r) => (
      <VStack gap={0.5}>
        <Link href={`#/routines/${encodeURIComponent(r.id)}`} weight="semibold" color="primary" isStandalone>
          {r.name}
        </Link>
        <Text type="supporting" maxLines={2}>
          {r.instruction}
        </Text>
        {isNarrow && (
          <Text type="supporting">
            {r.scheduleText} · {deliveryText(r)}
          </Text>
        )}
      </VStack>
    ),
  };
  const enabledColumn: TableColumn<RoutineRow> = {
    key: "enabled",
    header: "On",
    width: pixel(72),
    renderCell: (r) => <Switch label={r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`} isLabelHidden value={r.enabled} changeAction={(on) => onToggle(r, on)} />,
  };
  const columns: TableColumn<RoutineRow>[] = isNarrow
    ? [nameColumn, enabledColumn]
    : [
        nameColumn,
        { key: "schedule", header: "Schedule", width: pixel(220), renderCell: (r) => <ScheduleCell routine={r} /> },
        { key: "deliver", header: "Reports to", width: pixel(112), renderCell: (r) => <DeliveryIcons routine={r} /> },
        { key: "lastRun", header: "Last run", width: pixel(128), renderCell: (r) => <LastRun routine={r} /> },
        enabledColumn,
      ];
  return <Table<RoutineRow> data={routines as RoutineRow[]} columns={columns} idKey="id" density="balanced" hasHover />;
}

/** The empty page: what routines are, and three to add in one click. */
function Examples({ pointer, onAdd, adding }: { pointer: string; onAdd: (example: RoutineExample) => void; adding: string | undefined }) {
  return (
    <VStack gap={6}>
      <EmptyState
        icon={<Icon icon={ClockIcon} size="lg" />}
        title="No routines yet"
        description={`Ask ${pointer} once, for example “every morning at 8, email me what happened on GitHub yesterday”, and it runs on its own from then on. Or add one of these:`}
      />
      <Grid columns={{ minWidth: 240 }} gap={4}>
        {EXAMPLES.map((ex) => (
          <ClickableCard key={ex.key} label={`Add ${ex.name}`} onClick={() => onAdd(ex)} isDisabled={adding !== undefined}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center">
                <Heading level={4}>{ex.name}</Heading>
                {adding === ex.key && <Spinner size="sm" label="Adding" />}
              </HStack>
              <Text type="supporting">{ex.summary}</Text>
              <Text type="supporting" color="accent">
                Add it
              </Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>
    </VStack>
  );
}

/**
 * Routines: work Pointer does on its own on a schedule, read-only, with
 * reports to email, Slack and the console. Routes: #/routines, #/routines/new,
 * #/routines/<id> (its drawer) and #/routines/<id>/runs.
 */
export default function RoutinesPage() {
  const { config } = useConfig();
  const route = useRoute();
  const list = usePolled<RoutineList>(ROUTINES_PATH, EVERY_MS);
  const toggle = useAction();
  const add = useAction();
  const [adding, setAdding] = useState<string>();
  const pointer = config.team.pointer.name;

  const [first, second] = route.rest;
  const isNew = first === "new";
  const routineId = first && !isNew ? first : undefined;
  const tab: DrawerTab = second === "runs" ? "runs" : "routine";
  const routines = list.data?.routines ?? [];
  const routed = routineId ? routines.find((r) => r.id === routineId) : undefined;

  // The drawer keeps the last routine while it animates out.
  const [shown, setShown] = useState<RoutineView>();
  useEffect(() => {
    if (routed) setShown(routed);
  }, [routed]);

  // While a run is going, the list follows it.
  const running = routines.some((r) => r.running);
  const { reload } = list;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [running, reload]);

  const close = useCallback(() => navigate("routines"), []);

  const changed = async (routine?: RoutineView) => {
    await reload();
    if (routine && (isNew || !routineId)) navigate("routines", routine.id);
  };

  const onToggle = async (r: RoutineView, enabled: boolean) => {
    await toggle.run(() => api.post(routinePath(r.id), { enabled }), { success: enabled ? `Resumed “${r.name}”.` : `Paused “${r.name}”.` });
    await reload();
  };

  const addExample = async (ex: RoutineExample) => {
    setAdding(ex.key);
    let created: RoutineView | undefined;
    await add.run(
      async () => {
        const res = await api.post<{ routine: RoutineView }>(ROUTINES_PATH, {
          name: ex.name,
          instruction: ex.instruction,
          schedule: { cron: ex.cron, timezone: list.data?.timezone ?? config.timezone },
          deliver: { email: [], slack: "", console: true },
          budgetUsd: 1,
        });
        created = res.routine;
      },
      { success: `Added “${ex.name}”. Its reports go to the console; add email or Slack here.` },
    );
    setAdding(undefined);
    await reload();
    if (created) navigate("routines", created.id);
  };

  const newButton = <Button label="New routine" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={() => navigate("routines", "new")} />;
  const max = list.data?.max ?? 50;

  return (
    <PageFrame title="Routines" description={`Work ${pointer} does on its own on a schedule: read-only, with each report sent only to the recipients you choose.`} actions={newButton}>
      <VStack gap={8}>
        {list.error && !list.data ? (
          <Banner status="error" title="Couldn't load the routines" description={list.error} collapsible={false} endContent={<Button label="Try again" size="sm" clickAction={reload} />} />
        ) : !list.data ? (
          <Spinner label="Loading routines" />
        ) : routines.length === 0 ? (
          <Examples pointer={pointer} onAdd={(ex) => void addExample(ex)} adding={adding} />
        ) : (
          <VStack gap={3}>
            <Card padding={0}>
              <RoutinesTable routines={routines} onToggle={onToggle} />
            </Card>
            <Text type="supporting">
              {routines.length} of {max} routines. Times are in each routine's timezone; the organisation's is {list.data.timezone} (Settings). Routines run at most every{" "}
              {list.data.minIntervalMin} minutes.
            </Text>
          </VStack>
        )}

        <VStack gap={4}>
          <SectionHeader
            title="Waking the service"
            description={`${pointer} checks for due routines every minute while the service runs. On a platform that stops idle services (Cloud Run with no minimum instances), have a scheduler call this address every minute; a routine missed while the service was down runs once if it is less than an hour late.`}
          />
          <TickSection />
        </VStack>
      </VStack>

      <RoutineDrawer
        isOpen={isNew || routed !== undefined}
        routine={isNew ? undefined : (routed ?? shown)}
        tab={tab}
        onTabChange={(t) => routineId && navigate("routines", routineId, ...(t === "runs" ? ["runs"] : []))}
        timezone={list.data?.timezone ?? config.timezone}
        emailReady={list.data?.emailReady ?? config.email.configured}
        onClose={close}
        onChanged={changed}
      />
    </PageFrame>
  );
}
