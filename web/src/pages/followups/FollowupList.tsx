import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowUturnLeftIcon, BellIcon, BellSnoozeIcon, CalendarDaysIcon, CheckCircleIcon, CheckIcon } from "@heroicons/react/24/outline";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { timeAgo } from "../../lib/format";
import { type FollowupItem, OPEN_IN, atText, isSnoozed, reminderText, snoozeChoices, sourceLabel } from "./model";
import { SourceMark } from "./SourceMark";

export interface FollowupListProps {
  /** Open items (with Done and Snooze) or done ones (with Reopen). */
  status: "open" | "done";
  items: FollowupItem[];
  /** The organisation's timezone: every time is shown in it. */
  timezone: string;
  /** Pointer's name, for the items it added. */
  pointer: string;
  onDone?: (item: FollowupItem) => Promise<void>;
  onSnooze?: (item: FollowupItem, until: string) => Promise<void>;
  /** "Pick a time…": the page asks for the time. */
  onPickSnooze?: (item: FollowupItem) => void;
  onReopen?: (item: FollowupItem) => Promise<void>;
}

/** One small fact under an item: an icon and a few words. */
function Hint({ icon, color, children }: { icon: ComponentType<SVGProps<SVGSVGElement>>; color?: "success" | "secondary"; children: ReactNode }) {
  return (
    <HStack gap={1} vAlign="center">
      <Icon icon={icon} size="xsm" color={color ?? "secondary"} />
      <Text type="supporting">{children}</Text>
    </HStack>
  );
}

/** "Slack · Fadi Shqerat · 3 h ago", "You added it 2 days ago". */
function origin(item: FollowupItem, pointer: string): string {
  if (item.source === "owner") return `You added it ${timeAgo(item.createdAt)}`;
  return [sourceLabel(item.source, pointer), item.from, timeAgo(item.createdAt)].filter(Boolean).join(" · ");
}

function Hints({ item, status, timezone }: { item: FollowupItem; status: "open" | "done"; timezone: string }) {
  const now = new Date();
  const reminder = status === "open" ? reminderText(item, timezone, now) : undefined;
  const snoozed = status === "open" && isSnoozed(item, now.getTime()) && item.snoozedUntil ? `Snoozed until ${atText(item.snoozedUntil, timezone, now).replace(/^at /, "")}` : undefined;
  const hints = [
    status === "done" && item.doneAt ? <Hint key="done" icon={CheckCircleIcon} color="success">{`Done ${timeAgo(item.doneAt)}`}</Hint> : null,
    snoozed ? <Hint key="snoozed" icon={BellSnoozeIcon}>{snoozed}</Hint> : null,
    reminder ? <Hint key="reminder" icon={BellIcon}>{reminder}</Hint> : null,
    item.answeredAt && status === "open" ? <Hint key="answered" icon={CheckIcon} color="success">{`You replied ${timeAgo(item.answeredAt)}`}</Hint> : null,
    item.link ? (
      <Link key="link" href={item.link} isExternalLink type="supporting">
        {OPEN_IN[item.source]}
      </Link>
    ) : null,
  ].filter(Boolean);
  if (!hints.length) return null;
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      {hints}
    </HStack>
  );
}

function OpenActions({ item, timezone, onDone, onSnooze, onPickSnooze }: Pick<FollowupListProps, "timezone" | "onDone" | "onSnooze" | "onPickSnooze"> & { item: FollowupItem }) {
  const choices = snoozeChoices(timezone);
  return (
    <HStack gap={1} vAlign="center">
      <Button label={`Mark #${item.n} done`} size="sm" variant="secondary" icon={<Icon icon={CheckIcon} />} onClick={() => void onDone?.(item)}>
        Done
      </Button>
      <DropdownMenu
        button={{ label: `Snooze #${item.n}`, children: "Snooze", size: "sm", variant: "ghost", icon: <Icon icon={BellSnoozeIcon} /> }}
        alignment="end"
        items={[
          ...choices.map((c) => ({ id: c.key, label: c.label, description: c.when, onClick: () => void onSnooze?.(item, c.until) })),
          ...(choices.length ? [{ type: "divider" as const }] : []),
          { id: "pick", label: "Pick a time…", icon: <Icon icon={CalendarDaysIcon} />, onClick: () => onPickSnooze?.(item) },
        ]}
      />
    </HStack>
  );
}

/**
 * The owner's follow-ups as a numbered list (#n is theirs to keep: "done 12"
 * in Slack closes the same one): where each came from, its own reminder,
 * snooze and answered hints, a link to its source, and its actions.
 */
export function FollowupList({ status, items, timezone, pointer, onDone, onSnooze, onPickSnooze, onReopen }: FollowupListProps) {
  const isNarrow = useMediaQuery("(max-width: 640px)");
  return (
    <List hasDividers edge="flush" header={<VisuallyHidden>{status === "open" ? "Open follow-ups" : "Done follow-ups"}</VisuallyHidden>}>
      {items.map((item) => {
        const actions =
          status === "open" ? (
            <OpenActions item={item} timezone={timezone} onDone={onDone} onSnooze={onSnooze} onPickSnooze={onPickSnooze} />
          ) : (
            <Button label={`Reopen #${item.n}`} size="sm" variant="secondary" icon={<Icon icon={ArrowUturnLeftIcon} />} onClick={() => void onReopen?.(item)}>
              Reopen
            </Button>
          );
        return (
          <ListItem
            key={item.n}
            itemKey={item.n}
            align="start"
            startContent={<SourceMark source={item.source} label={sourceLabel(item.source, pointer)} />}
            label={
              <VStack gap={1}>
                <Text weight="medium" color={status === "done" ? "secondary" : "primary"}>
                  <Text color="secondary" hasTabularNumbers>
                    #{item.n}
                  </Text>{" "}
                  {item.title}
                </Text>
                <Text type="supporting">{origin(item, pointer)}</Text>
                {item.detail && (
                  <Text type="supporting" maxLines={2}>
                    {item.detail}
                  </Text>
                )}
                <Hints item={item} status={status} timezone={timezone} />
                {isNarrow && actions}
              </VStack>
            }
            endContent={isNarrow ? undefined : actions}
          />
        );
      })}
    </List>
  );
}
