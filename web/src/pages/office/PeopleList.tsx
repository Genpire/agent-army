import { Badge } from "@astryxdesign/core/Badge";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Face } from "./Face";
import { MeetingCard } from "./MeetingCard";
import type { LifeNote } from "./life";
import { type OfficePerson, type OfficeView, STATE_INFO, minutesText, nameTag, personSummary } from "./model";
import type { OfficeLife } from "./useOfficeLife";

function PersonCard({ person, note, onOpen }: { person: OfficePerson; note: LifeNote | undefined; onOpen: (id: string) => void }) {
  const info = STATE_INFO[person.state];
  const under = person.state === "thinking" ? person.conversation?.title : person.task ? `${person.task.repo} · ${person.task.title}` : undefined;
  return (
    <ClickableCard label={`${personSummary(person)}${note ? ` ${note.text}.` : ""} Open details.`} onClick={() => onOpen(person.id)} padding={3} width="100%">
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
            {note && (
              <Text type="supporting" maxLines={1}>
                {note.emoji} {note.text}
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

/** The office as a list, for phones and for anyone who prefers it: meetings first, then everyone with what they do (a free person's outing too: "Playing foosball with Omar"). */
export function PeopleList({ view, life, onOpen }: { view: OfficeView; life: OfficeLife; onOpen: (id: string) => void }) {
  const now = Date.now();
  return (
    <VStack gap={3}>
      {view.meetings.map((m) => (
        <MeetingCard key={m.taskId} meeting={m} people={view.people} width="100%" />
      ))}
      {view.people.map((p) => (
        <PersonCard key={p.id} person={p} note={p.state === "free" ? life.noteOf(p.id, now) : undefined} onOpen={onOpen} />
      ))}
    </VStack>
  );
}
