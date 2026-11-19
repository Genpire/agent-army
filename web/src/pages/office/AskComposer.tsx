import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { href } from "../../lib/router";
import type { ConversationSent } from "../../lib/types";

const MESSAGE_MAX = 8000;

export interface AskComposerProps {
  /** Pointer's name, as the owner set it. */
  lead: string;
  /** Text the composer starts with ("Ask Sara to "). */
  initial?: string;
  placeholder?: string;
  /** The input's accessible name. */
  label: string;
  /** Called with the new conversation's id once Pointer has the message. */
  onSent?: (conversationId: string) => void;
  maxRows?: number;
  /** Confirm with a toast instead of a banner above the composer (the page's docked composer). */
  isCompact?: boolean;
}

/**
 * Starts a console conversation with Pointer (POST /api/conversations) and
 * links to it; Pointer answers in Chat, and the office shows it thinking.
 * Enter sends, Shift+Enter adds a line; a failed send keeps the text.
 */
export function AskComposer({ lead, initial = "", placeholder, label, onSent, maxRows = 4, isCompact = false }: AskComposerProps) {
  const [value, setValue] = useState(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<{ id: string; title: string }>();
  const showToast = useToast();

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || body.length > MESSAGE_MAX) return;
    setSending(true);
    setError(undefined);
    try {
      const res = await api.post<ConversationSent>("/api/conversations", { text: body });
      const conversation = { id: res.conversation.id, title: res.conversation.title };
      setValue("");
      if (isCompact) {
        showToast({
          body: `${lead} has it: “${conversation.title}”`,
          type: "info",
          uniqueID: `asked-${conversation.id}`,
          autoHideDuration: 8000,
          endContent: <Button label="Open in Chat" size="sm" variant="ghost" href={href("chat", conversation.id)} />,
        });
      } else {
        setSent(conversation);
      }
      onSent?.(res.conversation.id);
    } catch (err) {
      setError(errorMessage(err));
      setValue(text);
    } finally {
      setSending(false);
    }
  };

  const tooLong = value.length > MESSAGE_MAX;
  return (
    <VStack gap={2}>
      {sent && (
        <Banner
          status="success"
          title={`${lead} has it`}
          description={`“${sent.title}”: ${lead} is answering in Chat.`}
          isDismissable
          onDismiss={() => setSent(undefined)}
          endContent={<Button label="Open in Chat" size="sm" href={href("chat", sent.id)} />}
        />
      )}
      <ChatComposer
        value={value}
        onChange={(v) => {
          setValue(v);
          setError(undefined);
        }}
        onSubmit={(text) => void send(text)}
        isDisabled={sending}
        placeholder={placeholder ?? `Ask ${lead}…`}
        density="compact"
        input={<ChatComposerInput label={label} maxRows={maxRows} pasteAsToken={false} hasHistory={false} />}
        status={
          tooLong
            ? { type: "error", message: `Messages are limited to ${MESSAGE_MAX} characters (${value.length} now).` }
            : error
              ? { type: "error", message: error }
              : undefined
        }
      />
    </VStack>
  );
}
