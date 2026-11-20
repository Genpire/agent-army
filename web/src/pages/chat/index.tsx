import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useState } from "react";
import { navigate, useRoute } from "../../lib/router";
import { ChatPanel } from "./ChatPanel";
import { useChatSession } from "./ChatSession";
import { ConversationList } from "./ConversationList";
import { useConversations } from "./hooks";

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
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const conversations = useConversations();
  const [isTaskOpen, setTaskOpen] = useState(false);
  const { setCurrentId } = useChatSession();

  const selected = route.rest[0];
  const id = selected && selected !== "new" ? selected : undefined;
  const showListOnly = isNarrow && !selected;
  const back = isNarrow ? () => navigate("chat") : undefined;

  // The conversation open here is the one the chat window shows. A bare #/chat
  // (the side nav's link) keeps the shared one, so the window does not lose it.
  useEffect(() => {
    if (id) setCurrentId(id);
  }, [id, setCurrentId]);

  const list = (
    <ConversationList
      items={conversations.items}
      error={conversations.error}
      selectedId={id}
      onSelect={(next) => navigate("chat", next)}
      onNew={() => {
        // A new chat is the shared one too: the chat window must not reopen the previous conversation.
        setCurrentId(undefined);
        if (isNarrow) navigate("chat", "new");
        else navigate("chat");
      }}
      onNewTask={() => setTaskOpen(true)}
    />
  );

  return (
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
          <ChatPanel
            id={id}
            onOpen={(next) => (next ? navigate("chat", next) : navigate("chat"))}
            onListChanged={() => void conversations.refresh()}
            onBack={back}
            isTaskOpen={isTaskOpen}
            onTaskOpenChange={setTaskOpen}
            replacement={showListOnly ? <VStack padding={4}>{list}</VStack> : undefined}
          />
        </LayoutContent>
      }
    />
  );
}
