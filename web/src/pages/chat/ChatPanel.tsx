import type { ReactNode } from "react";
import { useConfig } from "../../lib/state";
import { useChatSession } from "./ChatSession";
import { NewTaskDialog } from "./NewTaskDialog";
import { ConversationThread, NewConversation } from "./Thread";

export interface ChatPanelProps {
  /** The conversation to show; undefined shows a new one. */
  id: string | undefined;
  /**
   * Another conversation should be shown: one just created or started as a
   * repo task, or none (undefined) once the shown one is deleted. The Chat page
   * navigates; the chat window just shows it.
   */
  onOpen: (id: string | undefined) => void;
  /** Something a conversation list shows changed (one created, deleted, answered). */
  onListChanged?: () => void;
  /** Shown on narrow screens, where the Chat page's list and thread take turns. */
  onBack?: () => void;
  /** The "new repo task" dialog, controlled so a conversation list beside the panel can open it too. */
  isTaskOpen: boolean;
  onTaskOpenChange: (isOpen: boolean) => void;
  /** Shown instead of the conversation (the narrow Chat page's list); the repo task dialog stays available. */
  replacement?: ReactNode;
}

/**
 * The chat itself, shared by the Chat page and the chat window: a
 * conversation (or a new one), the repo task dialog, and the shared
 * "current conversation" kept in step with what is created and deleted.
 */
export function ChatPanel({ id, onOpen, onListChanged, onBack, isTaskOpen, onTaskOpenChange, replacement }: ChatPanelProps) {
  const { config } = useConfig();
  const pointerName = config.team.pointer.name || "Pointer";
  const { setCurrentId } = useChatSession();

  const open = (next: string) => {
    onListChanged?.();
    setCurrentId(next);
    onOpen(next);
  };

  return (
    <>
      {replacement ?? (id ? (
        <ConversationThread
          key={id}
          id={id}
          pointerName={pointerName}
          onBack={onBack}
          onChanged={() => onListChanged?.()}
          onDeleted={() => {
            onListChanged?.();
            setCurrentId((current) => (current === id ? undefined : current));
            onOpen(undefined);
          }}
        />
      ) : (
        <NewConversation pointerName={pointerName} onBack={onBack} onCreated={open} onNewTask={() => onTaskOpenChange(true)} />
      ))}
      <NewTaskDialog isOpen={isTaskOpen} onOpenChange={onTaskOpenChange} onStarted={open} />
    </>
  );
}
