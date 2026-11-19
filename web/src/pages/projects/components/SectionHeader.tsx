import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

export interface SectionHeaderProps {
  title: string;
  /** One or two sentences: what this section is for. May hold inline Code (give it size="inherit"). */
  description?: ReactNode;
  /** Actions at the end of the title row, e.g. the section's one primary button. */
  actions?: ReactNode;
}

/**
 * A section's heading inside a page: the title with its actions on one row,
 * then the description at full width under both, so a long description never
 * pushes the actions onto a line of their own.
 */
export function SectionHeader({ title, description, actions }: SectionHeaderProps) {
  return (
    <VStack gap={1}>
      <HStack gap={4} vAlign="center">
        <StackItem size="fill">
          <Heading level={2}>{title}</Heading>
        </StackItem>
        {actions && (
          <HStack gap={2} vAlign="center">
            {actions}
          </HStack>
        )}
      </HStack>
      {description && (
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      )}
    </VStack>
  );
}
