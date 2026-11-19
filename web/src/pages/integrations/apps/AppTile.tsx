import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { BrandLogo } from "../../../components/BrandLogo";
import type { StatusTone } from "../catalog";
import { StatusLine } from "../parts";

export interface AppTileProps {
  name: string;
  /** Its logo (BrandLogo id: a catalog or integration id); its initials without one. */
  logoId?: string;
  /** What it does, in a line. */
  description: string;
  /** Above the description, e.g. the category or "MCP Registry · io.example". */
  caption?: string;
  /** For a connected app: whether it can be used and what it may do. */
  status?: { tone: StatusTone; text: string };
  /** The tile's button: "Connect", "Sign in", "Open"… */
  actionLabel: string;
  onAction: () => void | Promise<void>;
  /** The primary look for the main call to action (e.g. not connected yet). */
  isPrimary?: boolean;
  isDisabled?: boolean;
  /** A second, quieter button, e.g. "Use a key" beside "Sign in". */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

/**
 * One app in a grid: its logo (bundled, never fetched from the vendor), name,
 * a line on what it does, its status when connected, and its buttons.
 */
export function AppTile({ name, logoId, description, caption, status, actionLabel, onAction, isPrimary, isDisabled, secondaryActionLabel, onSecondaryAction }: AppTileProps) {
  return (
    <Card height="100%">
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
          <Text type="supporting" maxLines={3}>
            {description}
          </Text>
        </StackItem>
        <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
          {status ? <StatusLine tone={status.tone} text={status.text} /> : <StackItem size="fill" />}
          <HStack gap={1} vAlign="center">
            {secondaryActionLabel && onSecondaryAction && <Button label={secondaryActionLabel} size="sm" variant="ghost" onClick={onSecondaryAction} isDisabled={isDisabled} />}
            <Button label={actionLabel} size="sm" variant={isPrimary ? "primary" : "secondary"} clickAction={onAction} isDisabled={isDisabled} />
          </HStack>
        </HStack>
      </VStack>
    </Card>
  );
}
