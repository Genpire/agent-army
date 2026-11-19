import { AvatarGroup } from "@astryxdesign/core/AvatarGroup";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, radiusVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { CalendarDaysIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { Face } from "./Face";
import { type OfficeMeeting, type OfficePerson, meetingStep, taskHref } from "./model";

const styles = stylex.create({
  // The calendar event's colour bar.
  bar: {
    alignSelf: "stretch",
    width: spacingVars["--spacing-1"],
    borderRadius: radiusVars["--radius-full"],
    backgroundColor: colorVars["--color-icon-orange"],
  },
});

export interface MeetingCardProps {
  meeting: OfficeMeeting;
  /** Everyone in the office, to show who sits at the table and what the one working does. */
  people: OfficePerson[];
  width?: number | string;
}

/**
 * A running task with several agents, as a calendar event: repo, task, step,
 * the plan's progress, who is at the table and what the one working is doing.
 * Opens the task's conversation (or Activity).
 */
export function MeetingCard({ meeting, people, width }: MeetingCardProps) {
  const attendees = meeting.people.map((id) => people.find((p) => p.id === id)).filter((p): p is OfficePerson => Boolean(p));
  const busy = attendees.filter((p) => p.kind === "agent" && p.state === "working" && p.doing);
  return (
    <ClickableCard label={`Meeting: ${meeting.title}. Open the task`} href={taskHref({ id: meeting.taskId, conversationId: meeting.conversationId })} elevation="med" padding={3} width={width}>
      <HStack gap={3}>
        <StackItem xstyle={styles.bar} />
        <StackItem size="fill">
          <VStack gap={2}>
            <HStack gap={2} vAlign="center">
              <Icon icon={CalendarDaysIcon} size="sm" color="secondary" />
              <StackItem size="fill">
                <Text type="supporting" color="secondary" maxLines={1}>
                  Meeting · since <Timestamp value={meeting.since} format="time" hasTooltip={false} />
                </Text>
              </StackItem>
              <StatusDot variant="warning" label="In progress" isPulsing />
            </HStack>
            <VStack gap={0.5}>
              <Text weight="semibold" maxLines={2}>
                {meeting.title}
              </Text>
              <Text type="supporting" color="secondary" maxLines={1}>
                {meeting.repo} · {meetingStep(meeting)}
              </Text>
            </VStack>
            {meeting.plan.total > 0 && (
              <ProgressBar label={`Plan: ${meeting.plan.done} of ${meeting.plan.total} done`} isLabelHidden value={meeting.plan.done} max={meeting.plan.total} />
            )}
            {busy.map((p) => (
              <Text key={p.id} type="supporting" maxLines={2}>
                <Text type="supporting" weight="semibold">
                  {p.name}:{" "}
                </Text>
                {p.doing}
              </Text>
            ))}
            <AvatarGroup size={24}>
              {attendees.slice(0, 6).map((p) => (
                <Face key={p.id} seed={p.avatar} name={p.name} size={24} />
              ))}
            </AvatarGroup>
          </VStack>
        </StackItem>
      </HStack>
    </ClickableCard>
  );
}
