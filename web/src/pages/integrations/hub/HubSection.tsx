import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

export interface HubSectionProps {
  title: string;
  /** How many tiles it holds, beside the title. */
  count?: number;
  children: ReactNode;
}

/** One of the hub's parts ("Connected", "Add more"): a heading with how many it holds, then its tiles or groups. */
export function HubSection({ title, count, children }: HubSectionProps) {
  return (
    <VStack as="section" aria-label={title} gap={4}>
      <HStack gap={2} vAlign="center">
        <Heading level={2}>{title}</Heading>
        {count !== undefined && <Text color="secondary">{count}</Text>}
      </HStack>
      {children}
    </VStack>
  );
}

export interface HubGroupProps {
  title: string;
  /** A sentence under the title. */
  description?: string;
  children: ReactNode;
}

/** A group of tiles in a section, under a smaller heading: "Built in", a category, the MCP Registry. */
export function HubGroup({ title, description, children }: HubGroupProps) {
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        {description && (
          <Text type="supporting" color="secondary">
            {description}
          </Text>
        )}
      </VStack>
      {children}
    </VStack>
  );
}
