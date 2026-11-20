import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { useStreamingText } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Markdown } from "@astryxdesign/core/Markdown";
import { markdownSoftBreaksPlugin } from "@astryxdesign/core/Markdown/plugins";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { VStack } from "@astryxdesign/core/VStack";
import {
  ArrowLeftIcon,
  ChatBubbleLeftRightIcon,
  CodeBracketSquareIcon,
  LightBulbIcon,
  MagnifyingGlassIcon,
  QuestionMarkCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { Fragment, type ReactNode, useCallback, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ApiError, api, errorMessage } from "../../lib/api";
import { usd } from "../../lib/format";
import type { ChatMessage as Message, ConversationSent, LiveReply, Task } from "../../lib/types";
import { Composer } from "./Composer";
import { useChatOptions, useConversation } from "./hooks";
import { activitySummary, toolCall } from "./labels";
import { MessageFiles } from "./MessageFiles";
import { ScreenshotStrip } from "./Screenshots";
import { TaskCard } from "./TaskCard";
import { useComposerFiles } from "./useComposerFiles";
import { useFileDrop } from "./useFileDrop";

const SOFT_BREAKS = [markdownSoftBreaksPlugin];

/** Puts a voice message's transcript at the end of the draft, for the owner to check before sending. */
const withTranscript = (draft: string, transcript: string) => (draft.trim() ? `${draft.trimEnd()} ${transcript}` : transcript);

// ---------- Messages ----------

function StreamingMarkdown({ text }: { text: string }) {
  const shown = useStreamingText(text, true, { speed: "fast" });
  return (
    <Markdown density="compact" isStreaming>
      {shown}
    </Markdown>
  );
}

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

function TaskCards({ ids, tasks }: { ids: string[]; tasks: Map<string, Task> }) {
  return (
    <>
      {ids.map((id) => {
        const task = tasks.get(id);
        return task ? (
          <ChatMessageBubble key={id} variant="ghost" width="100%">
            <TaskCard task={task} />
          </ChatMessageBubble>
        ) : null;
      })}
    </>
  );
}

interface MessageViewProps {
  conversationId: string;
  message: Message;
  tasks: Map<string, Task>;
  pointerName: string;
}

function MessageView({ conversationId, message: m, tasks, pointerName }: MessageViewProps) {
  if (m.role === "user") {
    const metadata = <ChatMessageMetadata timestamp={<Timestamp value={m.at} format="time" />} />;
    const files = m.files ?? [];
    return (
      <ChatMessage sender="user">
        {m.text && (
          <ChatMessageBubble group={files.length ? "first" : undefined} metadata={files.length ? undefined : metadata}>
            <Markdown density="compact" plugins={SOFT_BREAKS}>
              {m.text}
            </Markdown>
          </ChatMessageBubble>
        )}
        {files.length > 0 && (
          <ChatMessageBubble variant="ghost" width="80%" metadata={metadata}>
            <MessageFiles conversationId={conversationId} files={files} align="end" />
          </ChatMessageBubble>
        )}
      </ChatMessage>
    );
  }
  const footer: ReactNode[] = [];
  if (m.isError) footer.push(<Badge key="error" label="Error" variant="error" />);
  if (m.costUsd !== undefined) {
    footer.push(
      <Text key="cost" type="supporting" color="secondary">
        {usd(m.costUsd)}
      </Text>,
    );
  }
  const endOf = m.result?.milestone === "end" ? tasks.get(m.result.taskId) : undefined;
  return (
    <ChatMessage sender="assistant" avatar={<Avatar name={pointerName} size="md" />} name={pointerName}>
      {m.activity && m.activity.length > 0 && <ChatToolCalls calls={m.activity.map(toolCall)} label={activitySummary(m.activity)} />}
      <ChatMessageBubble
        variant="ghost"
        metadata={
          <ChatMessageMetadata
            timestamp={<Timestamp value={m.at} format="time" />}
            footer={footer.length ? <HStack gap={2} vAlign="center">{footer}</HStack> : undefined}
          />
        }>
        <Markdown density="compact">{m.text}</Markdown>
      </ChatMessageBubble>
      {endOf && (endOf.screenshots ?? 0) > 0 && (
        <ChatMessageBubble variant="ghost" width="100%">
          <ScreenshotStrip taskId={endOf.id} count={endOf.screenshots} />
        </ChatMessageBubble>
      )}
      {m.tasks && <TaskCards ids={m.tasks} tasks={tasks} />}
    </ChatMessage>
  );
}

/** The answer being written: Pointer's steps as they happen, then the text as it streams in. */
function LiveReplyView({ live, tasks, pointerName }: { live: LiveReply | undefined; tasks: Map<string, Task>; pointerName: string }) {
  const steps = live?.activity ?? [];
  const running = steps.filter((s) => !s.endedAt).length;
  return (
    <ChatMessage sender="assistant" avatar={<Avatar name={pointerName} size="md" />} name={pointerName}>
      {steps.length > 0 && (
        <ChatToolCalls
          calls={steps.map(toolCall)}
          defaultIsExpanded
          label={running ? `Working · ${steps.length} step${steps.length === 1 ? "" : "s"}` : activitySummary(steps)}
        />
      )}
      <ChatMessageBubble variant="ghost">
        {live?.text ? <StreamingMarkdown text={live.text} /> : <Spinner size="sm" label={steps.length ? "Working…" : "Thinking…"} />}
      </ChatMessageBubble>
      {live && live.tasks.length > 0 && <TaskCards ids={live.tasks} tasks={tasks} />}
    </ChatMessage>
  );
}

type Row = { at: string; key: string; node: ReactNode };

/** Messages in order, plus the cards of tasks no message announced (started by a webhook, say) at their time. */
function threadRows(conversationId: string, messages: Message[], tasks: Task[], live: LiveReply | undefined, pointerName: string): Row[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const anchored = new Set([...messages.flatMap((m) => m.tasks ?? []), ...(live?.tasks ?? [])]);
  const rows: Row[] = messages.map((m) => ({
    at: m.at,
    key: m.id,
    node: <MessageView conversationId={conversationId} message={m} tasks={byId} pointerName={pointerName} />,
  }));
  for (const t of tasks) {
    if (anchored.has(t.id)) continue;
    rows.push({
      at: t.createdAt,
      key: `task-${t.id}`,
      node: (
        <ChatMessage sender="assistant" avatar={<Avatar name={pointerName} size="md" />} name={pointerName}>
          <TaskCards ids={[t.id]} tasks={byId} />
        </ChatMessage>
      ),
    });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------- A conversation ----------

export interface ConversationThreadProps {
  id: string;
  pointerName: string;
  /** Shown on narrow screens, where the list and the thread take turns. */
  onBack?: () => void;
  /** Something the list shows changed (a message sent, an answer arrived). */
  onChanged: () => void;
  onDeleted: () => void;
}

export function ConversationThread({ id, pointerName, onBack, onChanged, onDeleted }: ConversationThreadProps) {
  const { state, refresh, replace } = useConversation(id, onChanged);
  const [draft, setDraft] = useState("");
  const options = useChatOptions();
  const onTranscript = useCallback((text: string) => setDraft((d) => withTranscript(d, text)), []);
  const files = useComposerFiles({ conversationId: id, options, onTranscript });
  const isAnswering = state.status === "ready" && (state.view.conversation.pending || Boolean(state.view.live));
  const drop = useFileDrop(files.add, state.status !== "ready" || isAnswering);

  const back =onBack ? <IconButton label="Back to conversations" icon={<Icon icon={ArrowLeftIcon} size="sm" />} onClick={onBack} /> : null;

  if (state.status !== "ready") {
    return (
      <VStack height="100%">
        {back && <Toolbar label="Conversation" dividers={["bottom"]} startContent={back} />}
        <VStack height="100%" hAlign="center" vAlign="center" padding={6}>
          {state.status === "loading" && <Spinner label="Loading the conversation" />}
          {state.status === "missing" && (
            <EmptyState title="Conversation not found" description="It may have been deleted." icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />} />
          )}
          {state.status === "error" && <EmptyState title="Cannot load the conversation" description={state.error} />}
        </VStack>
      </VStack>
    );
  }

  const { conversation, tasks, live } = state.view;
  const answering = isAnswering;
  const rows = threadRows(id, conversation.messages, tasks, live, pointerName);

  const send = async (text: string, attachmentIds: string[]): Promise<string | null> => {
    try {
      const sent = await api.post<ConversationSent>(`/api/conversations/${encodeURIComponent(id)}/messages`, { text, attachmentIds });
      replace(sent.conversation);
      onChanged();
      void refresh();
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) void refresh();
      return errorMessage(err);
    }
  };

  return (
    // Files dropped anywhere on the conversation are attached to the next message.
    <VStack height="100%" {...drop.handlers}>
      {/* A row, not a Toolbar: the title must shrink (and truncate) so Delete stays on screen at phone width. */}
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
        {back}
        <StackItem size="fill">
          <Heading level={2} maxLines={1}>
            {conversation.title}
          </Heading>
        </StackItem>
        {/* A static StackItem neither grows nor shrinks: the button keeps its whole label. */}
        <StackItem>
          <ConfirmButton
            label="Delete"
            confirmLabel="Click again to delete"
            onConfirm={async () => {
              try {
                await api.post(`/api/conversations/${encodeURIComponent(id)}/delete`);
                onDeleted();
              } catch {
                void refresh();
              }
            }}
          />
        </StackItem>
      </HStack>
      <Divider />
      {/* ChatLayout fills what the toolbar leaves (flex 1, min-height 0) and scrolls inside itself. */}
      <ChatLayout
        composer={
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            files={files}
            options={options}
            isDragging={drop.isDragging}
            isDisabled={answering}
            isAnswering={answering}
          />
        }>
        <ChatMessageList isStreaming={answering}>
          {rows.map((row, i) => (
            <Fragment key={row.key}>
              {(i === 0 || !sameDay(rows[i - 1]!.at, row.at)) && (
                <ChatSystemMessage variant="divider">
                  <Timestamp value={row.at} format="date_weekday" type="inherit" hasTooltip={false} />
                </ChatSystemMessage>
              )}
              {row.node}
            </Fragment>
          ))}
          {answering && <LiveReplyView live={live} tasks={new Map(tasks.map((t) => [t.id, t]))} pointerName={pointerName} />}
        </ChatMessageList>
      </ChatLayout>
    </VStack>
  );
}

// ---------- A new conversation ----------

const STARTERS: { icon: typeof LightBulbIcon; title: string; body: string; prompt: string }[] = [
  {
    icon: QuestionMarkCircleIcon,
    title: "Ask a question",
    body: "About your repositories, pull requests, issues or anything else.",
    prompt: "What changed in owner/repo this week?",
  },
  {
    icon: MagnifyingGlassIcon,
    title: "Research something",
    body: "Pointer searches the web and asks the team's researchers.",
    prompt: "Compare the options for ",
  },
  {
    icon: WrenchScrewdriverIcon,
    title: "Change code",
    body: "Pointer puts the team on a repository; the work becomes a pull request.",
    prompt: "In owner/repo, ",
  },
];

export interface NewConversationProps {
  pointerName: string;
  onBack?: () => void;
  onCreated: (id: string) => void;
  onNewTask: () => void;
}

/** The empty page: what you can ask, and the composer that starts a conversation. */
export function NewConversation({ pointerName, onBack, onCreated, onNewTask }: NewConversationProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const options = useChatOptions();
  const onTranscript = useCallback((text: string) => setDraft((d) => withTranscript(d, text)), []);
  // No conversation yet: the first upload starts a draft, which the conversation takes when it is sent.
  const files = useComposerFiles({ conversationId: undefined, options, onTranscript });
  const drop = useFileDrop(files.add, sending);

  const send = async (text: string, attachmentIds: string[], draftId: string | undefined): Promise<string | null> => {
    setSending(true);
    try {
      const sent = await api.post<ConversationSent>("/api/conversations", {
        text,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(draftId && attachmentIds.length ? { conversationId: draftId } : {}),
      });
      onCreated(sent.conversation.id);
      return null;
    } catch (err) {
      return errorMessage(err);
    } finally {
      setSending(false);
    }
  };

  const intro = (
    <VStack gap={6} padding={4}>
      <EmptyState
        icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />}
        title={`Ask ${pointerName} anything`}
        description={`Questions, research, writing and planning, GitHub lookups, monday.com tickets, and code changes: ${pointerName} puts the team on a repository and they open a pull request. Repo tasks started here have no Slack thread: their live progress, screenshots and result appear in this conversation and on the pull request.`}
      />
      <Grid columns={{ minWidth: 200, max: 4 }} gap={3}>
        {STARTERS.map((s) => (
          <ClickableCard key={s.title} label={s.title} onClick={() => setDraft(s.prompt)} variant="muted" padding={3}>
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Icon icon={s.icon} size="sm" color="accent" />
                <Text type="label" weight="semibold">
                  {s.title}
                </Text>
              </HStack>
              <Text type="supporting" color="secondary">
                {s.body}
              </Text>
            </VStack>
          </ClickableCard>
        ))}
        <ClickableCard label="Start a repo task directly" onClick={onNewTask} variant="muted" padding={3}>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Icon icon={CodeBracketSquareIcon} size="sm" color="accent" />
              <Text type="label" weight="semibold">
                Start a repo task
              </Text>
            </HStack>
            <Text type="supporting" color="secondary">
              Skip the chat: pick a repository and say what to build.
            </Text>
          </VStack>
        </ClickableCard>
      </Grid>
    </VStack>
  );

  return (
    <VStack height="100%" {...drop.handlers}>
      {onBack && (
        <Toolbar
          label="New conversation"
          dividers={["bottom"]}
          startContent={
            <HStack gap={2} vAlign="center">
              <IconButton label="Back to conversations" icon={<Icon icon={ArrowLeftIcon} size="sm" />} onClick={onBack} />
              <Heading level={2}>New conversation</Heading>
            </HStack>
          }
          endContent={<Button label="Repo task" variant="ghost" size="sm" icon={<Icon icon={CodeBracketSquareIcon} size="sm" />} onClick={onNewTask} />}
        />
      )}
      <ChatLayout
        emptyState={intro}
        composer={
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            files={files}
            options={options}
            isDragging={drop.isDragging}
            isDisabled={sending}
            isAnswering={false}
          />
        }>
        {null}
      </ChatLayout>
    </VStack>
  );
}
