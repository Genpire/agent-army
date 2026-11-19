import { Badge } from "@astryxdesign/core/Badge";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Face } from "./Face";
import { MeetingCard } from "./MeetingCard";
import { type OfficePerson, type OfficeView, STATE_INFO, minutesText, nameTag, personSummary } from "./model";

function PersonCard({ person, onOpen }: { person: OfficePerson; onOpen: (id: string) => void }) {
  const info = STATE_INFO[person.state];
  const under = person.state === "thinking" ? person.conversation?.title : person.task ? `${person.task.repo} · ${person.task.title}` : undefined;
  return (
    <ClickableCard label={`${personSummary(person)} Open details.`} onClick={() => onOpen(person.id)} padding={3} width="100%">
      <HStack gap={3} vAlign="start">
        <Face seed={person.avatar} name={person.name} state={person.state} size={48} hasTooltip={false} />
        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                <Text weight="semibold" maxLines={1}>
                  {nameTag(person)}
                </Text>
              </StackItem>
              <Badge label={info.label} variant={info.badge} />
            </HStack>
            {person.doing && (
              <Text type="supporting" maxLines={2}>
                {person.doing}
              </Text>
            )}
            {under && (
              <Text type="supporting" color="secondary" maxLines={1}>
                {under}
              </Text>
            )}
            <Text type="supporting" color="secondary">
              Today: {person.today.tasks} task{person.today.tasks === 1 ? "" : "s"} · {minutesText(person.today.minutes)}
            </Text>
          </VStack>
        </StackItem>
      </HStack>
    </ClickableCard>
  );
}

/** The office as a list, for phones and for anyone who prefers it: meetings first, then everyone with what they do. */
export function PeopleList({ view, onOpen }: { view: OfficeView; onOpen: (id: string) => void }) {
  return (
    <VStack gap={3}>
      {view.meetings.map((m) => (
        <MeetingCard key={m.taskId} meeting={m} people={view.people} width="100%" />
      ))}
      {view.people.map((p) => (
        <PersonCard key={p.id} person={p} onOpen={onOpen} />
      ))}
    </VStack>
  );
}
