import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { usePolled } from "../activity/usePolled";
import { AskComposer } from "./AskComposer";
import { officeLayout } from "./layout";
import { OFFICE_EVERY_MS, type OfficePerson, type OfficeView, isBusy, officePath } from "./model";
import { OfficeScene } from "./OfficeScene";
import { OfficeTalkButton } from "./OfficeTalkSettings";
import { PeopleList } from "./PeopleList";
import { PersonDrawer } from "./PersonDrawer";
import { useOfficeLife } from "./useOfficeLife";
import { useWidth } from "./useWidth";

/** Narrower than this, the office is a list of people (phones, narrow windows). */
const SCENE_MIN_WIDTH = 680;
/** The drawing is never shrunk below this share of its size: wider teams scroll sideways inside it. */
const MIN_SCALE = 0.62;

const styles = stylex.create({
  minWidth: (px: number) => ({ minWidth: px }),
});

function Counts({ view, isLive }: { view: OfficeView | undefined; isLive: boolean }) {
  const busy = view?.people.filter(isBusy).length ?? 0;
  const free = (view?.people.length ?? 0) - busy;
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <HStack gap={1.5} vAlign="center">
        <StatusDot variant={isLive ? "success" : "warning"} label={isLive ? "Live" : "Reconnecting"} isPulsing={isLive} />
        <Text type="supporting" color="secondary">
          {isLive ? "Live" : "Reconnecting…"}
        </Text>
      </HStack>
      {view && (
        <>
          <Badge label={`${busy} working`} variant="info" />
          <Badge label={`${free} free`} variant="success" />
        </>
      )}
    </HStack>
  );
}

/**
 * The virtual office: the team at their desks, who is busy and with what, and
 * a composer to ask Pointer for work. `#/office/<personId>` opens a person.
 *
 * Responsive contract:
 *   container ≥ 680px  the illustrated office (a List view is one click away)
 *   narrower           the same people as a list of cards
 * The office is re-read every 3 s while the tab is visible. Free agents get
 * up now and then (useOfficeLife, the same for everyone who looks): the
 * picture shows them walking, the list says what they do. While the picture
 * moves, their conversations can be real talk (Office talk, in the actions).
 */
export default function OfficePage() {
  const { config } = useConfig();
  const lead = config.team.pointer.name || "Pointer";
  const route = useRoute();
  const path = useMemo(() => officePath(), []);
  const office = usePolled<OfficeView>(path, OFFICE_EVERY_MS);
  const [frameRef, width] = useWidth<HTMLDivElement>();
  const isPhone = useMediaQuery("(max-width: 640px)");
  const [mode, setMode] = useState<"office" | "list">("office");
  const isNarrow = isPhone || (width !== undefined && width < SCENE_MIN_WIDTH);
  const showList = isNarrow || mode === "list";

  const view = office.data;
  const selectedId = route.rest[0];
  const selected = view?.people.find((p) => p.id === selectedId);
  // The drawer keeps the last person while it animates out.
  const [shown, setShown] = useState<OfficePerson>();
  useEffect(() => {
    if (selected) setShown(selected);
  }, [selected]);

  const open = useCallback((id: string) => navigate("office", id), []);
  const close = useCallback(() => navigate("office"), []);
  const reload = office.reload;

  const layout = useMemo(() => (view ? officeLayout(view.people, view.meetings) : undefined), [view]);
  const isReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Real talk only where its bubbles show: the moving picture.
  const life = useOfficeLife(view, layout, !showList && !isReducedMotion);
  const sceneWidth = layout?.view.width ?? 0;
  const needsScroll = width !== undefined && sceneWidth * MIN_SCALE > width;
  const hasAgents = Boolean(view?.people.some((p) => p.kind === "agent"));

  let body: React.ReactNode;
  if (!view) {
    body = office.error ? (
      <EmptyState
        title="The office could not be loaded"
        description={office.error}
        icon={<Icon icon={BuildingOffice2Icon} size="lg" />}
        actions={<Button label="Try again" clickAction={reload} />}
      />
    ) : (
      <Center minHeight={320}>
        <Spinner label="Opening the office" />
      </Center>
    );
  } else if (showList || !layout) {
    body = <PeopleList view={view} life={life} onOpen={open} />;
  } else {
    const scene = <OfficeScene view={view} layout={layout} life={life} isReducedMotion={isReducedMotion} onOpen={open} now={new Date(office.loadedAt ?? Date.now())} />;
    body = needsScroll ? (
      <ScrollableArea axis="inline" label="The office">
        <VStack xstyle={styles.minWidth(Math.ceil(sceneWidth * MIN_SCALE))}>{scene}</VStack>
      </ScrollableArea>
    ) : (
      scene
    );
  }

  return (
    <PageFrame
      title="Office"
      description={`Your team at their desks: who is free, who is busy and with what, right now. Click someone to see their work or ask ${lead} for more.`}
      actions={
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Counts view={view} isLive={!office.error} />
          <OfficeTalkButton />
          {!isNarrow && (
            <SegmentedControl label="Show the office as" value={mode} onChange={(v) => setMode(v === "list" ? "list" : "office")} size="sm">
              <SegmentedControlItem value="office" label="Office" />
              <SegmentedControlItem value="list" label="List" />
            </SegmentedControl>
          )}
        </HStack>
      }>
      <VStack gap={4} ref={frameRef}>
        {view && !hasAgents && (
          <Banner
            status="info"
            title={`${lead} works alone for now`}
            description="Add agents on the Team page and they get a desk here."
            endContent={<Button label="Add an agent" size="sm" href={href("team", "new-agent")} />}
          />
        )}
        {body}
        {/* Under the office, never over it: the composer that puts the team to work. */}
        <AskComposer
          lead={lead}
          label={`Message to ${lead}`}
          placeholder={`Ask ${lead}… for a change, a question, research or a draft`}
          onSent={() => void reload()}
          maxRows={3}
          isCompact
        />
      </VStack>
      <PersonDrawer person={shown} isOpen={Boolean(selected)} onClose={close} onChanged={() => void reload()} people={view?.people} />
    </PageFrame>
  );
}
