import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { ArrowsPointingOutIcon, ChatBubbleLeftRightIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { type Page, navigate } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { ChatPanel } from "./ChatPanel";
import { useChatSession } from "./ChatSession";
import { shouldShowChatFab } from "./fab";

/** Clear of the edge, and of a phone's rounded corners and home indicator. */
const edge = (space: string, side: "right" | "bottom") => `max(${space}, env(safe-area-inset-${side}, ${spacingVars["--spacing-0"]}))`;
const NARROW = "@media (max-width: 768px)";

const styles = stylex.create({
  // Astryx has no floating/affix primitive (Toast's viewport is the only fixed
  // layer, at z-index 500), so the button pins itself to the viewport. Above
  // page content, below toasts; dialogs, popovers and tooltips sit in the
  // browser's top layer, above any z-index.
  fab: {
    position: "fixed",
    insetInlineEnd: { default: edge(spacingVars["--spacing-6"], "right"), [NARROW]: edge(spacingVars["--spacing-4"], "right") },
    bottom: { default: edge(spacingVars["--spacing-6"], "bottom"), [NARROW]: edge(spacingVars["--spacing-4"], "bottom") },
    zIndex: 400,
  },
  // Hidden, not unmounted: the dialog returns focus to the button that opened it.
  hidden: { visibility: "hidden" },
  // The window keeps its size while the conversation loads or is empty.
  window: { height: "80dvh" },
});

/**
 * The floating "Open chat" button and the chat window it opens, on every
 * console page but Chat. The window shows the shared current conversation
 * (see ChatSession), so it and the Chat page continue the same chat.
 */
export function ChatLauncher({ page }: { page: Page }) {
  const [isOpen, setOpen] = useState(false);
  const [isTaskOpen, setTaskOpen] = useState(false);
  const { currentId, setCurrentId } = useChatSession();
  const { config } = useConfig();
  const pointerName = config.team.pointer.name || "Pointer";
  const isNarrow = useMediaQuery("(max-width: 768px)");

  // The Chat page is the chat already: arriving there (by a link, the back button…) closes the window.
  useEffect(() => {
    if (page === "chat") {
      setOpen(false);
      setTaskOpen(false);
    }
  }, [page]);

  // Closing the window also closes the repo-task dialog inside it, so it does not reopen with the window.
  const onOpenChange = (open: boolean) => {
    setOpen(open);
    if (!open) setTaskOpen(false);
  };

  const openFullPage = () => {
    setOpen(false);
    setTaskOpen(false);
    if (currentId) navigate("chat", currentId);
    else navigate("chat");
  };

  const actions = (
    <HStack gap={1} vAlign="center">
      {currentId &&
        (isNarrow ? (
          <IconButton label="New conversation" tooltip="New conversation" variant="ghost" icon={<Icon icon={PencilSquareIcon} />} onClick={() => setCurrentId(undefined)} />
        ) : (
          <Button label="New conversation" variant="ghost" size="sm" icon={<Icon icon={PencilSquareIcon} size="sm" />} onClick={() => setCurrentId(undefined)} />
        ))}
      {isNarrow ? (
        <IconButton label="Open full page" tooltip="Open full page" variant="ghost" icon={<Icon icon={ArrowsPointingOutIcon} />} onClick={openFullPage} />
      ) : (
        <Button label="Open full page" variant="ghost" size="sm" icon={<Icon icon={ArrowsPointingOutIcon} size="sm" />} onClick={openFullPage} />
      )}
    </HStack>
  );

  return (
    <>
      <IconButton
        label="Open chat"
        tooltip="Open chat"
        variant="primary"
        size={isNarrow ? "md" : "lg"}
        elevation="high"
        icon={<Icon icon={ChatBubbleLeftRightIcon} />}
        onClick={() => setOpen(true)}
        xstyle={[styles.fab, !shouldShowChatFab(page, isOpen) && styles.hidden]}
      />
      <Dialog
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        variant={isNarrow ? "fullscreen" : "standard"}
        width={720}
        maxHeight="80dvh"
        xstyle={isNarrow ? undefined : styles.window}>
        <Layout
          header={<DialogHeader title={`Chat with ${pointerName}`} endContent={actions} onOpenChange={onOpenChange} />}
          content={
            <LayoutContent padding={0} label={currentId ? "Conversation" : "New conversation"}>
              {/* Mounted only while open: a closed window must not keep polling the conversation. */}
              {isOpen && <ChatPanel id={currentId} onOpen={setCurrentId} isTaskOpen={isTaskOpen} onTaskOpenChange={setTaskOpen} />}
            </LayoutContent>
          }
        />
      </Dialog>
    </>
  );
}
