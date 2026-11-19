import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

export interface PageFrameProps {
  title: string;
  /** One sentence under the title: what this page is for. */
  description?: string;
  /** Page-level actions at the end of the header (one primary at most). */
  actions?: ReactNode;
  /** Under the header, e.g. a TabList for the page's sections. */
  nav?: ReactNode;
  children: ReactNode;
}

/** Every page's frame: a header with title, description and actions, then the content at a readable width. */
export function PageFrame({ title, description, actions, nav, children }: PageFrameProps) {
  return (
    <Layout
      height="fill"
      contentWidth={1080}
      // One inset for the header and the content, so their edges line up at every width.
      padding={6}
      header={
        <LayoutHeader hasDivider={!nav} label={title} paddingBlockEnd={nav ? 0 : undefined}>
          <VStack gap={3}>
            <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={1}>
                <Heading level={1}>{title}</Heading>
                {description && (
                  <Text type="supporting" color="secondary">
                    {description}
                  </Text>
                )}
              </VStack>
              {actions && (
                <HStack gap={2} vAlign="center">
                  {actions}
                </HStack>
              )}
            </HStack>
            {nav}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent isScrollable>
          {children}
        </LayoutContent>
      }
    />
  );
}
