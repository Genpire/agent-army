import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { ConversationList } from "./ConversationList";
import { useConversations } from "./hooks";
import { NewTaskDialog } from "./NewTaskDialog";
import { ConversationThread, NewConversation } from "./Thread";

/**
 * Chat with Pointer from the console: `#/chat` (a new conversation),
 * `#/chat/<conversationId>`, and on narrow screens `#/chat/new`.
 *
 * Responsive contract:
 *   >768px  conversation list panel 300 | thread
 *   <=768px one region: the list at #/chat, the thread (with a back button) when one is open
 */
export default function ChatPage() {
  const route = useRoute();
  const { config } = useConfig();
  const pointerName = config.team.pointer.name || "Pointer";
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const conversations = useConversations();
  const [isTaskOpen, setTaskOpen] = useState(false);

  const selected = route.rest[0];
  const id = selected && selected !== "new" ? selected : undefined;
  const showListOnly = isNarrow && !selected;
  const back = isNarrow ? () => navigate("chat") : undefined;

  const list = (
    <ConversationList
      items={conversations.items}
      error={conversations.error}
      selectedId={id}
      onSelect={(next) => navigate("chat", next)}
      onNew={() => (isNarrow ? navigate("chat", "new") : navigate("chat"))}
      onNewTask={() => setTaskOpen(true)}
    />
  );

  const main = id ? (
    <ConversationThread
      key={id}
      id={id}
      pointerName={pointerName}
      onBack={back}
      onChanged={() => void conversations.refresh()}
      onDeleted={() => {
        void conversations.refresh();
        navigate("chat");
      }}
    />
  ) : (
    <NewConversation
      pointerName={pointerName}
      onBack={back}
      onCreated={(created) => {
        void conversations.refresh();
        navigate("chat", created);
      }}
      onNewTask={() => setTaskOpen(true)}
    />
  );

  return (
    <>
      <Layout
        height="fill"
        start={
          isNarrow ? undefined : (
            <LayoutPanel width={300} hasDivider label="Conversations" padding={4}>
              {list}
            </LayoutPanel>
          )
        }
        content={
          <LayoutContent padding={0} label={id ? "Conversation" : "New conversation"}>
            {showListOnly ? <VStack padding={4}>{list}</VStack> : main}
          </LayoutContent>
        }
      />
      <NewTaskDialog
        isOpen={isTaskOpen}
        onOpenChange={setTaskOpen}
        onStarted={(conversationId) => {
          void conversations.refresh();
          navigate("chat", conversationId);
        }}
      />
    </>
  );
}
