import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, durationVars, easeVars, radiusVars, shadowVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { AcademicCapIcon, CodeBracketSquareIcon, HeartIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { href } from "../../lib/router";
import { type BubbleSpot, type Rect, placeBubbles } from "./bubbles";
import { Face, hueOf } from "./Face";
import { type Placement, type SceneLayout, officeLayout, project, toPercent } from "./layout";
import { MeetingCard } from "./MeetingCard";
import { type OfficePerson, type OfficeView, isBusy, nameTag, personSummary } from "./model";
import { OfficeArt, type ScreenState } from "./OfficeArt";
import { useWidth } from "./useWidth";

const styles = stylex.create({
  stage: { position: "relative", width: "100%" },
  // A point on the drawing; what it holds is placed around it.
  anchor: {
    position: "absolute",
    width: 0,
    height: 0,
    transitionProperty: { default: "left, top", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionDuration: durationVars["--duration-slow-max"],
    transitionTimingFunction: easeVars["--ease-move"],
  },
  at: (left: string, top: string, z: number) => ({ left, top, zIndex: z }),
  raise: { zIndex: { default: null, ":hover": 2000, ":focus-within": 2000 } },
  face: { position: "absolute", left: 0, top: 0, transform: "translate(-50%, -50%)" },
  below: { position: "absolute", left: 0, top: spacingVars["--spacing-8"], transform: "translateX(-50%)", whiteSpace: "nowrap" },
  aboveCard: { position: "absolute", left: 0, bottom: 0, transform: "translateX(-50%)" },
  // A bubble's centre, relative to its face (computed by placeBubbles, in px).
  bubbleAt: (dx: number, dy: number, width: number) => ({ left: dx, top: dy, width }),
  bubble: { position: "absolute", transform: "translate(-50%, -50%)" },
  tail: {
    position: "absolute",
    bottom: `calc(-1 * ${spacingVars["--spacing-1-5"]})`,
    width: spacingVars["--spacing-3"],
    height: spacingVars["--spacing-3"],
    transform: "translateX(-50%) rotate(45deg)",
    backgroundColor: colorVars["--color-background-card"],
    borderRadius: radiusVars["--radius-inner"],
  },
  tailAt: (left: number) => ({ left }),
  tag: {
    backgroundColor: colorVars["--color-background-card"],
    borderRadius: radiusVars["--radius-full"],
    boxShadow: shadowVars["--shadow-low"],
  },
  // Isolated: the scene's own z-indexes (up to the thousands) stay inside it, under the console's floating chat button.
  frame: { overflow: "hidden", isolation: "isolate" },
  pinned: { position: "absolute", top: spacingVars["--spacing-4"], zIndex: 1500 },
  pinStart: { insetInlineStart: spacingVars["--spacing-4"] },
  pinEnd: { insetInlineEnd: spacingVars["--spacing-4"] },
});

export interface OfficeSceneProps {
  view: OfficeView;
  onOpen: (personId: string) => void;
  now: Date;
}

/** The second line of a busy person's bubble: the task, or the conversation Pointer answers. */
const bubbleLine = (person: OfficePerson) =>
  person.state === "thinking" ? person.conversation?.title : person.task ? `${person.task.repo} · ${person.task.title}` : undefined;

/** A busy person's speech bubble: what they do, with the task under it. */
function Bubble({ person, spot, layout, placement }: { person: OfficePerson; spot: BubbleSpot; layout: SceneLayout; placement: Placement }) {
  const pos = toPercent(layout.view, placement.at);
  const line = bubbleLine(person);
  return (
    <VStack xstyle={[styles.anchor, styles.at(pos.left, pos.top, 2500), styles.raise]}>
      <Card elevation="med" padding={2} xstyle={[styles.bubble, styles.bubbleAt(spot.dx, spot.dy, spot.width)]}>
        <VStack gap={0.5}>
          <HStack gap={1.5} vAlign="start">
            {person.state === "thinking" ? <Spinner size="sm" label="Thinking" /> : <Icon icon={CodeBracketSquareIcon} size="sm" color="accent" />}
            <StackItem size="fill">
              <Text type="supporting" weight="semibold" maxLines={2}>
                {person.doing ?? "Working"}
              </Text>
            </StackItem>
          </HStack>
          {line && (
            <Text type="supporting" color="secondary" maxLines={1}>
              {line}
            </Text>
          )}
        </VStack>
        {spot.tail !== undefined && <StackItem xstyle={[styles.tail, styles.tailAt(spot.tail)]} />}
      </Card>
    </VStack>
  );
}

const tagText = (person: OfficePerson, isShort: boolean) => (isShort ? person.name : nameTag(person));

function NameTag({ person, isShort }: { person: OfficePerson; isShort: boolean }) {
  return (
    <HStack gap={1} vAlign="center" paddingInline={2} paddingBlock={0.5} xstyle={styles.tag}>
      <Text type="supporting" weight="semibold" maxLines={1}>
        {tagText(person, isShort)}
      </Text>
    </HStack>
  );
}

function Marker({
  person,
  placement,
  layout,
  isCompact,
  onOpen,
}: {
  person: OfficePerson;
  placement: Placement;
  layout: SceneLayout;
  /** The drawing is shown smaller than its size: smaller faces keep neighbours apart. */
  isCompact: boolean;
  onOpen: (id: string) => void;
}) {
  const pos = toPercent(layout.view, placement.at);
  const atTable = placement.where === "meeting";
  const size = atTable ? (isCompact ? 32 : 40) : isCompact ? 40 : 48;
  return (
    <VStack xstyle={[styles.anchor, styles.at(pos.left, pos.top, Math.round(placement.at.y + 1000)), styles.raise]}>
      <StackItem xstyle={styles.face}>
        <Face seed={person.avatar} name={person.name} state={person.state} size={size} label={`${personSummary(person)} Open details.`} onClick={() => onOpen(person.id)} />
      </StackItem>
      <StackItem xstyle={styles.below}>
        <NameTag person={person} isShort={atTable} />
      </StackItem>
    </VStack>
  );
}

/** Below this scale (px per drawing unit) faces and bubbles get smaller, so neighbours stay apart. */
const COMPACT_BELOW = 0.85;

/** Meeting cards are pinned in the empty top corners of the picture, above the walls (px). */
const CARD_W = 272;
const CARD_H = 190;
const CARD_INSET = 16;

function cardBox(corner: "start" | "end", stageWidth: number): Rect {
  const x0 = corner === "start" ? CARD_INSET : stageWidth - CARD_INSET - CARD_W;
  return { x0, y0: CARD_INSET, x1: x0 + CARD_W, y1: CARD_INSET + CARD_H };
}

/** Estimated boxes (px) of the meeting cards and labels, which bubbles keep clear of. */
function fixedBoxes(layout: SceneLayout, scale: number, meetings: number): Rect[] {
  const px = (p: { x: number; y: number }) => ({ x: (p.x - layout.view.x) * scale, y: (p.y - layout.view.y) * scale });
  const above = (p: { x: number; y: number }, w: number, h: number): Rect => {
    const c = px(p);
    return { x0: c.x - w / 2, y0: c.y - h, x1: c.x + w / 2, y1: c.y };
  };
  const boxes = [above(layout.shelf, 150, 34), above(layout.hr, 110, 28)];
  layout.meetingSpot.slice(0, meetings).forEach((s) => {
    if (s !== undefined) boxes.push(cardBox(layout.spots[s]!.corner, layout.view.width * scale));
  });
  return boxes;
}

/** From inside a pinned card to its table, in drawing units. */
function cardLink(layout: SceneLayout, spot: number, scale: number) {
  const s = layout.spots[spot]!;
  const box = cardBox(s.corner, layout.view.width * scale);
  const fromPx = { x: s.corner === "start" ? box.x1 - 40 : box.x0 + 40, y: box.y1 - 40 };
  return {
    from: { x: layout.view.x + fromPx.x / scale, y: layout.view.y + fromPx.y / scale },
    to: project(s.cx, s.cy, s.kind === "table" ? 30 : 32),
  };
}

function Anchored({ layout, at, children, z = 900 }: { layout: SceneLayout; at: { x: number; y: number }; children: React.ReactNode; z?: number }) {
  const pos = toPercent(layout.view, at);
  return (
    <VStack xstyle={[styles.anchor, styles.at(pos.left, pos.top, z), styles.raise]}>
      <StackItem xstyle={styles.aboveCard}>{children}</StackItem>
    </VStack>
  );
}

/**
 * The office as a picture: the room (OfficeArt) with everyone on top, each at
 * their desk or around a meeting table, faces as buttons that open the
 * person's drawer. People walk to the table when a meeting starts.
 */
export function OfficeScene({ view, onOpen, now }: OfficeSceneProps) {
  const layout = useMemo(() => officeLayout(view.people, view.meetings), [view.people, view.meetings]);
  const byId = useMemo(() => new Map(view.people.map((p) => [p.id, p])), [view.people]);
  const [stageRef, stageWidth] = useWidth<HTMLDivElement>();
  const scale = (stageWidth ?? layout.view.width) / layout.view.width;

  // People at their desks say what they do in a bubble; at a meeting table, the meeting card does.
  const bubbleSpots = useMemo(() => {
    const atDesk = layout.placements.filter((p) => p.where === "desk" && isBusy(byId.get(p.personId) ?? { state: "free" }));
    const isCompact = scale < COMPACT_BELOW;
    return placeBubbles({
      layout,
      scale,
      faceRadius: isCompact ? 24 : 28,
      maxWidth: isCompact ? 196 : 240,
      faces: layout.placements.flatMap((p) => {
        const person = byId.get(p.personId);
        return person ? [{ id: p.personId, at: p.at, tag: tagText(person, p.where === "meeting") }] : [];
      }),
      boxes: fixedBoxes(layout, scale, view.meetings.length),
      bubbles: atDesk.map((p) => {
        const person = byId.get(p.personId)!;
        return { id: p.personId, at: p.at, chars: Math.max(person.doing?.length ?? 0, bubbleLine(person)?.length ?? 0) };
      }),
    });
  }, [layout, scale, byId, view.meetings.length]);

  const screens: Record<string, ScreenState> = {};
  for (const d of layout.desks) {
    const p = d.personId ? byId.get(d.personId) : undefined;
    const atDesk = p && layout.placements.some((x) => x.personId === p.id && x.where === "desk");
    screens[d.key] = !p || !atDesk ? "off" : p.state === "thinking" ? "think" : p.state === "working" || p.state === "meeting" ? "on" : "off";
  }
  const seated = Object.fromEntries(view.people.map((p) => [p.id, hueOf(p.avatar)]));
  const activeSpots = new Set(layout.meetingSpot.filter((s): s is number => s !== undefined));
  const workingAt = new Set(layout.placements.filter((p) => p.where === "meeting" && byId.get(p.personId)?.state === "working").map((p) => p.personId));
  const hr = layout.desks.find((d) => d.kind === "hr");

  return (
    <Card padding={0} variant="muted" xstyle={styles.frame}>
      <VStack xstyle={styles.stage} ref={stageRef}>
        <OfficeArt
          layout={layout}
          screens={screens}
          seated={seated}
          activeSpots={activeSpots}
          workingAt={workingAt}
          links={[...activeSpots].map((s) => cardLink(layout, s, scale))}
          now={now}
        />

        <Anchored layout={layout} at={layout.shelf} z={800}>
          <Button label="Skills library" size="sm" elevation="low" icon={<Icon icon={AcademicCapIcon} size="sm" />} href={href("skills")} tooltip="The skills your agents can use" />
        </Anchored>
        {hr && !hr.personId && (
          <Anchored layout={layout} at={layout.hr} z={800}>
            <Token label="HR corner" size="sm" icon={<Icon icon={HeartIcon} size="xsm" />} />
          </Anchored>
        )}

        {view.meetings.map((m, i) => {
          const spot = layout.meetingSpot[i];
          if (spot === undefined) return null;
          return (
            <StackItem key={m.taskId} xstyle={[styles.pinned, layout.spots[spot]!.corner === "start" ? styles.pinStart : styles.pinEnd]}>
              <MeetingCard meeting={m} people={view.people} width={CARD_W} />
            </StackItem>
          );
        })}

        {layout.placements.map((placement) => {
          const person = byId.get(placement.personId);
          return person ? <Marker key={person.id} person={person} placement={placement} layout={layout} isCompact={scale < COMPACT_BELOW} onOpen={onOpen} /> : null;
        })}

        {layout.placements.map((placement) => {
          const person = byId.get(placement.personId);
          const spot = bubbleSpots[placement.personId];
          return person && spot ? <Bubble key={`b-${person.id}`} person={person} spot={spot} layout={layout} placement={placement} /> : null;
        })}
      </VStack>
    </Card>
  );
}
