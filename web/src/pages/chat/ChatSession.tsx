import { type Dispatch, type ReactNode, type SetStateAction, createContext, useContext, useMemo, useState } from "react";

/**
 * The conversation the owner is on, shared by the Chat page and the chat
 * window the floating button opens: a conversation started in one is the one
 * the other shows. It lives in the console (not in a page) so it survives
 * moving between pages. The Chat page's URL stays the source of truth there;
 * the page writes its conversation here when the URL changes.
 */
interface ChatSessionValue {
  /** Undefined: a new conversation. */
  currentId: string | undefined;
  setCurrentId: Dispatch<SetStateAction<string | undefined>>;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [currentId, setCurrentId] = useState<string>();
  const value = useMemo(() => ({ currentId, setCurrentId }), [currentId]);
  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("useChatSession must be used inside ChatSessionProvider");
  return value;
}
