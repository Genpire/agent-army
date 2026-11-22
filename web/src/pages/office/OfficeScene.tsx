import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, radiusVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { AcademicCapIcon, CodeBracketSquareIcon, HeartIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { href } from "../../lib/router";
import { type BubbleRequest, type BubbleSpot, type Rect, placeBubbles } from "./bubbles";
import { Face, hueOf } from "./Face";
import { type Placement, type SceneLayout, project, toPercent } from "./layout";
import { MeetingCard } from "./MeetingCard";
import { type OfficePerson, type OfficeView, isBusy, nameTag, personSummary } from "./model";
import { OfficeArt, type ScreenState } from "./OfficeArt";
import { OfficeLife } from "./OfficeLife";
import { Tag } from "./Tags";
import type { OfficeLife as Life } from "./useOfficeLife";
import { useWidth } from "./useWidth";

const styles = stylex.create({
  stage: { position: "relative", width: "100%" },
  // A point on the drawing; what it holds is placed around it.
  anchor: { position: "absolute", width: 0, height: 0 },
  at: (left: string, top: string, z: number) => ({ left, top, zIndex: z }),
  raise: { zIndex: { default: null, ":hover": 2000, ":focus-within": 2000 } },
  face: { position: "absolute", left: 0, top: 0, transform: "translate(-50%, -50%)" },
  below: { position: "absolute", left: 0, top: spacingVars["--spacing-8"], transform: "translateX(-50%)", whiteSpace: "nowrap" },
  aboveCard: { position: "absolute", left: 0, bottom: 0, transform: "translateX(-50%)" },
  // A bubble's box, relative to its face (computed by placeBubbles, in px): a bubble above its face grows upwards when it opens, any other downwards.
  bubbleAt: (left: number, top: number, width: number) => ({ left, top, width }),
  bubble: { position: "absolute" },
  growUp: { transform: "translateY(-100%)" },
  open: { zIndex: 3000 },
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
  // Isolated: the scene's own z-indexes (up to the thousands) stay inside it, under the console's floating chat button.
  frame: { overflow: "hidden", isolation: "isolate" },
  pinned: { position: "absolute", top: spacingVars["--spacing-4"], zIndex: 1500 },
  pinStart: { insetInlineStart: spacingVars["--spacing-4"] },
  pinEnd: { insetInlineEnd: spacingVars["--spacing-4"] },
});

/** The second line of a busy person's card: the task, or the conversation Pointer answers. */
const bubbleLine = (person: OfficePerson) =>
  person.state === "thinking" ? person.conversation?.title : person.task ? `${person.task.repo} · ${person.task.title}` : undefined;

/** A card opens wider than its one-line form, to show the details. */
const OPEN_WIDTH = 260;

/**
 * A busy person's status card: one line (what they do) that opens on hover
 * or focus (theirs or their face's) to the details and the task.
 */
function Bubble({ person, spot, layout, placement, isOpen, onHot }: { person: OfficePerson; spot: BubbleSpot; layout: SceneLayout; placement: Placement; isOpen: boolean; onHot: (id: string | undefined) => void }) {
  const pos = toPercent(layout.view, placement.at);
  const line = bubbleLine(person);
  const isAbove = spot.dy < 0;
  const width = isOpen ? Math.max(spot.width, OPEN_WIDTH) : spot.width;
  const left = spot.dx - spot.width / 2 - (width - spot.width) / 2;
  const top = isAbove ? spot.dy + spot.height / 2 : spot.dy - spot.height / 2;
  return (
    <VStack xstyle={[styles.anchor, styles.at(pos.left, pos.top, 2500), isOpen && styles.open]} onMouseEnter={() => onHot(person.id)} onMouseLeave={() => onHot(undefined)}>
      <Card elevation="med" padding={2} xstyle={[styles.bubble, styles.bubbleAt(left, top, width), isAbove && styles.growUp]}>
        <VStack gap={0.5}>
          <HStack gap={1.5} vAlign="start">
            {person.state === "thinking" ? <Spinner size="sm" label="Thinking" /> : <Icon icon={CodeBracketSquareIcon} size="sm" color="accent" />}
            <StackItem size="fill">
              <Text type="supporting" weight="semibold" maxLines={isOpen ? 3 : 1}>
                {person.doing ?? "Working"}
              </Text>
            </StackItem>
          </HStack>
          {isOpen && line && (
            <Text type="supporting" color="secondary" maxLines={2}>
              {line}
            </Text>
          )}
        </VStack>
        {spot.tail !== undefined && !isOpen && <StackItem xstyle={[styles.tail, styles.tailAt(spot.tail)]} />}
      </Card>
    </VStack>
  );
}

/** A free person's outing, as a still note by their face (when motion is reduced, nobody walks). */
function Note({ text, spot, layout, placement }: { text: string; spot: BubbleSpot; layout: SceneLayout; placement: Placement }) {
  const pos = toPercent(layout.view, placement.at);
  return (
    <VStack xstyle={[styles.anchor, styles.at(pos.left, pos.top, 2400)]}>
      <StackItem xstyle={[styles.bubble, styles.bubbleAt(spot.dx - spot.width / 2, spot.dy - spot.height / 2, spot.width)]}>
        <Tag text={text} isBold={false} />
      </StackItem>
    </VStack>
  );
}

const tagText = (person: OfficePerson, isShort: boolean) => (isShort ? person.name : nameTag(person));

function Marker({
  person,
  placement,
  layout,
  isCompact,
  note,
  onOpen,
  onHot,
}: {
  person: OfficePerson;
  placement: Placement;
  layout: SceneLayout;
  /** The drawing is shown smaller than its size: smaller faces keep neighbours apart. */
  isCompact: boolean;
  /** Their outing, in words. */
  note: string | undefined;
  onOpen: (id: string) => void;
  onHot: (id: string | undefined) => void;
}) {
  const pos = toPercent(layout.view, placement.at);
  const atTable = placement.where === "meeting";
  const size = atTable ? (isCompact ? 32 : 40) : isCompact ? 40 : 48;
  return (
    <VStack
      xstyle={[styles.anchor, styles.at(pos.left, pos.top, Math.round(placement.at.y + 1000)), styles.raise]}
      onMouseEnter={() => onHot(person.id)}
      onMouseLeave={() => onHot(undefined)}
      onFocus={() => onHot(person.id)}
      onBlur={() => onHot(undefined)}>
      <StackItem xstyle={styles.face}>
        <Face seed={person.avatar} name={person.name} state={person.state} size={size} label={`${personSummary(person)}${note ? ` ${note}.` : ""} Open details.`} onClick={() => onOpen(person.id)} />
      </StackItem>
      <StackItem xstyle={styles.below}>
        <Tag text={tagText(person, atTable)} />
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

export interface OfficeSceneProps {
  view: OfficeView;
  layout: SceneLayout;
  /** Free agents' outings (useOfficeLife). */
  life: Life;
  /** prefers-reduced-motion: nobody walks; an outing shows as a still note by the face. */
  isReducedMotion: boolean;
  onOpen: (personId: string) => void;
  now: Date;
}

/**
 * The office as a picture: the room (OfficeArt) with everyone on top, each at
 * their desk or around a meeting table, faces as buttons that open the
 * person's drawer. Free people get up now and then (OfficeLife draws them
 * while they are out); people walk to the table when a meeting starts.
 */
export function OfficeScene({ view, layout, life, isReducedMotion, onOpen, now }: OfficeSceneProps) {
  const byId = useMemo(() => new Map(view.people.map((p) => [p.id, p])), [view.people]);
  const [stageRef, stageWidth] = useWidth<HTMLDivElement>();
  const scale = (stageWidth ?? layout.view.width) / layout.view.width;
  const isCompact = scale < COMPACT_BELOW;
  const [hot, setHot] = useState<string>();

  // Out of their seat, drawn by OfficeLife (nobody is, under reduced motion).
  const away = useMemo(() => new Set(isReducedMotion ? [] : life.parts.keys()), [isReducedMotion, life.parts]);
  // Under reduced motion, a free person's outing is a still note; its words follow the outing's start.
  const notes = useMemo(() => {
    const out = new Map<string, string>();
    if (!isReducedMotion) return out;
    for (const [id, { activity }] of life.parts) {
      const note = life.noteOf(id, activity.start);
      if (note && byId.get(id)?.state === "free") out.set(id, `${note.emoji} ${note.short}`);
    }
    return out;
  }, [isReducedMotion, life, byId]);

  // People at their desks say what they do in a card; at a meeting table, the meeting card does.
  const bubbleSpots = useMemo(() => {
    const requests: BubbleRequest[] = layout.placements.flatMap((p) => {
      const person = byId.get(p.personId);
      if (!person || away.has(p.personId)) return [];
      if (p.where === "desk" && isBusy(person)) return [{ id: p.personId, at: p.at, chars: (person.doing ?? "Working").length }];
      const note = notes.get(p.personId);
      return note ? [{ id: p.personId, at: p.at, chars: note.length, kind: "pill" as const }] : [];
    });
    return placeBubbles({
      layout,
      scale,
      faceRadius: isCompact ? 24 : 28,
      maxWidth: isCompact ? 160 : 190,
      faces: layout.placements.flatMap((p) => {
        const person = byId.get(p.personId);
        return person ? [{ id: p.personId, at: p.at, tag: tagText(person, p.where === "meeting") }] : [];
      }),
      boxes: fixedBoxes(layout, scale, view.meetings.length),
      bubbles: requests,
    });
  }, [layout, scale, isCompact, byId, away, notes, view.meetings.length]);

  const art = useMemo(() => {
    const screens: Record<string, ScreenState> = {};
    for (const d of layout.desks) {
      const p = d.personId ? byId.get(d.personId) : undefined;
      const atDesk = p && layout.placements.some((x) => x.personId === p.id && x.where === "desk");
      screens[d.key] = !p || !atDesk ? "off" : p.state === "thinking" ? "think" : p.state === "working" || p.state === "meeting" ? "on" : "off";
    }
    const seated = Object.fromEntries(view.people.map((p) => [p.id, hueOf(p.avatar)]));
    const activeSpots = new Set(layout.meetingSpot.filter((s): s is number => s !== undefined));
    const workingAt = new Set(layout.placements.filter((p) => p.where === "meeting" && byId.get(p.personId)?.state === "working").map((p) => p.personId));
    return { screens, seated, activeSpots, workingAt, links: [...activeSpots].map((s) => cardLink(layout, s, scale)) };
  }, [layout, byId, view.people, scale]);
  const hr = layout.desks.find((d) => d.kind === "hr");

  return (
    <Card padding={0} variant="muted" xstyle={styles.frame}>
      <VStack xstyle={styles.stage} ref={stageRef}>
        <OfficeArt layout={layout} {...art} now={now} away={away} isPaused={life.isPaused} isPingPongOn={!isReducedMotion && life.activities.some((a) => a.kind === "pingpong")} />

        {!isReducedMotion && <OfficeLife life={life} layout={layout} people={byId} scale={scale} isCompact={isCompact} onOpen={onOpen} />}

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
          if (!person || away.has(person.id)) return null;
          const note = isReducedMotion ? life.noteOf(person.id, Date.now())?.text : undefined;
          return <Marker key={person.id} person={person} placement={placement} layout={layout} isCompact={isCompact} note={note} onOpen={onOpen} onHot={setHot} />;
        })}

        {layout.placements.map((placement) => {
          const person = byId.get(placement.personId);
          const spot = bubbleSpots[placement.personId];
          if (!person || !spot) return null;
          const note = notes.get(person.id);
          return note ? (
            <Note key={`n-${person.id}`} text={note} spot={spot} layout={layout} placement={placement} />
          ) : (
            <Bubble key={`b-${person.id}`} person={person} spot={spot} layout={layout} placement={placement} isOpen={hot === person.id} onHot={setHot} />
          );
        })}
      </VStack>
    </Card>
  );
}
