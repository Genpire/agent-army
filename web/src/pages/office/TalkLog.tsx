import { Button } from "@astryxdesign/core/Button";
import { ChatMessage, ChatMessageBubble, ChatMessageList } from "@astryxdesign/core/Chat";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Face } from "./Face";
import type { OfficePerson } from "./model";
import { type TalkEntry, readMs, talkTitle } from "./talk";

/** One conversation, from one person's side: their lines on the right, the others' on the left; Replay plays it again line by line, at the office's pace. */
function TalkCard({ entry, personId, byId }: { entry: TalkEntry; personId: string; byId: Map<string, OfficePerson> }) {
  const [shown, setShown] = useState<number>();
  const lines = entry.lines;
  const total = lines.length;
  const count = shown ?? total;
  const isReplaying = shown !== undefined && shown < total;
  // The line on show stays up as long as it did in the office.
  const wait = shown === undefined ? 0 : readMs(lines[shown - 1]?.text ?? "");

  useEffect(() => {
    if (shown === undefined) return;
    if (shown >= total) {
      setShown(undefined);
      return;
    }
    const timer = setTimeout(() => setShown(shown + 1), wait);
    return () => clearTimeout(timer);
  }, [shown, total, wait]);

  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Text weight="semibold">{talkTitle(entry, personId, nameOf)}</Text>
            <Text type="supporting" color="secondary">
              <Timestamp value={new Date(lines[0]!.t0).toISOString()} format="relative" isLive />
              {entry.model ? ` · ${entry.model}` : ""}
            </Text>
          </VStack>
        </StackItem>
        <Button label="Replay" size="sm" variant="ghost" icon={<Icon icon={PlayIcon} size="sm" />} isDisabled={isReplaying} onClick={() => setShown(1)} />
      </HStack>
      <ChatMessageList density="compact" align="top">
        {lines.slice(0, count).map((line) => {
          const speaker = byId.get(line.speaker);
          const isOwn = line.speaker === personId;
          return (
            <ChatMessage
              key={`${line.t0}-${line.speaker}`}
              sender={isOwn ? "user" : "assistant"}
              avatar={isOwn || !speaker ? undefined : <Face seed={speaker.avatar} name={speaker.name} size={32} hasTooltip={false} />}>
              <ChatMessageBubble name={isOwn ? undefined : nameOf(line.speaker)}>{line.text}</ChatMessageBubble>
            </ChatMessage>
          );
        })}
      </ChatMessageList>
    </VStack>
  );
}

/** What a person said in the office this session (real talk only, talk.ts's talksOf): their last few conversations, newest first, with who they were with. */
export function TalkLog({ talks, personId, people }: { talks: TalkEntry[]; personId: string; people: OfficePerson[] }) {
  const byId = new Map(people.map((p) => [p.id, p]));
  return (
    <VStack gap={5}>
      {talks.map((entry) => (
        <TalkCard key={entry.activityId} entry={entry} personId={personId} byId={byId} />
      ))}
    </VStack>
  );
}
