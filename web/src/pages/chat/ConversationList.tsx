import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatBubbleLeftRightIcon, CodeBracketSquareIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { plural, timeAgo } from "../../lib/format";
import type { ConversationSummary } from "../../lib/types";

export interface ConversationListProps {
  items: ConversationSummary[] | undefined;
  error: string | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewTask: () => void;
}

/** The conversations with Pointer, newest activity first, with the page's two ways to start something. */
export function ConversationList({ items, error, selectedId, onSelect, onNew, onNewTask }: ConversationListProps) {
  return (
    <VStack gap={4}>
      <VStack gap={3}>
        <Heading level={1}>Chat</Heading>
        <HStack gap={2} wrap="wrap">
          <Button label="New chat" variant="primary" size="sm" icon={<Icon icon={PencilSquareIcon} size="sm" />} onClick={onNew} />
          <Button label="New repo task" variant="secondary" size="sm" icon={<Icon icon={CodeBracketSquareIcon} size="sm" />} onClick={onNewTask} />
        </HStack>
      </VStack>
      {items === undefined && !error && <Spinner size="sm" label="Loading conversations" />}
      {error && items === undefined && (
        <Text type="supporting" color="secondary">
          {error}
        </Text>
      )}
      {items?.length === 0 && (
        <EmptyState
          isCompact
          icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />}
          title="No conversations yet"
          description="Ask Pointer something, or start a repo task."
        />
      )}
      {items && items.length > 0 && (
        <List density="compact" header={<Text type="label" color="secondary">Conversations</Text>}>
          {items.map((c) => (
            <ListItem
              key={c.id}
              label={c.title}
              description={[timeAgo(c.updatedAt), c.taskCount ? plural(c.taskCount, "task") : ""].filter(Boolean).join(" · ")}
              isSelected={c.id === selectedId}
              onClick={() => onSelect(c.id)}
              endContent={c.pending ? <StatusDot variant="accent" label="Pointer is answering" tooltip="Pointer is answering" isPulsing /> : undefined}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}
