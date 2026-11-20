import { Button } from "@astryxdesign/core/Button";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { BrandLogo } from "../../../components/BrandLogo";
import type { StatusTone } from "../catalog";
import { StatusLine } from "../parts";

export interface AppTileProps {
  name: string;
  /** Its logo (BrandLogo id: a catalog or integration id); its initials without one. */
  logoId?: string;
  /** What it does, in a line or two. */
  description?: string;
  /** Under the name, e.g. the category or "MCP Registry · io.example". */
  caption?: string;
  /** Whether it is connected and how: "Connected as octocat", "Signed in · 12 tools · read only". */
  status?: { tone: StatusTone; text: string };
  /** What opening the tile does, shown at its end and read out with the name: "Manage", "Connect", "Sign in". */
  actionLabel: string;
  /** Where the tile leads: the whole tile is a link (e.g. #/integrations/github). */
  href?: string;
  /** What the tile does when it has no href; a spinner shows until it settles. */
  onAction?: () => void | Promise<void>;
  isDisabled?: boolean;
  /** A second, quieter button inside the tile, e.g. "Use a key" beside "Sign in". */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

/**
 * One integration or app in the hub's grids: its logo (bundled, never fetched
 * from the vendor), name, what it does or how it is connected, and what
 * opening it does. The whole tile is one link or button, so Tab and the arrow
 * keys (TileGrid) stop once per tile; a second action is a button of its own.
 */
export function AppTile({ name, logoId, description, caption, status, actionLabel, href, onAction, isDisabled, secondaryActionLabel, onSecondaryAction }: AppTileProps) {
  const [pending, setPending] = useState(false);
  const act = async () => {
    if (!onAction || pending) return;
    setPending(true);
    try {
      await onAction();
    } finally {
      setPending(false);
    }
  };
  const label = status ? `${actionLabel} ${name}, ${status.text}` : `${actionLabel} ${name}`;

  return (
    <ClickableCard label={label} href={href} onClick={href ? undefined : act} isDisabled={isDisabled || pending} height="100%">
      <VStack gap={3} height="100%">
        <HStack gap={3} vAlign="center">
          <BrandLogo id={logoId} name={name} size="md" />
          <StackItem size="fill">
            <VStack gap={0.5}>
              <Text weight="semibold" maxLines={1}>
                {name}
              </Text>
              {caption && (
                <Text type="supporting" color="secondary" maxLines={1}>
                  {caption}
                </Text>
              )}
            </VStack>
          </StackItem>
        </HStack>
        <StackItem size="fill">
          {description && (
            <Text type="supporting" maxLines={2}>
              {description}
            </Text>
          )}
        </StackItem>
        <HStack gap={2} hAlign="between" vAlign="center">
          <StackItem size="fill">{status && <StatusLine tone={status.tone} text={status.text} />}</StackItem>
          <HStack gap={2} vAlign="center">
            {secondaryActionLabel && onSecondaryAction && (
              <Button label={`${secondaryActionLabel} for ${name}`} size="sm" variant="ghost" onClick={onSecondaryAction} isDisabled={isDisabled}>
                {secondaryActionLabel}
              </Button>
            )}
            <HStack gap={1} vAlign="center">
              <Text weight="semibold" color={isDisabled ? "disabled" : "accent"}>
                {actionLabel}
              </Text>
              {pending ? <Spinner size="sm" /> : <Icon icon={ChevronRightIcon} size="sm" color={isDisabled ? "secondary" : "accent"} />}
            </HStack>
          </HStack>
        </HStack>
      </VStack>
    </ClickableCard>
  );
}
