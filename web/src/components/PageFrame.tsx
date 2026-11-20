import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { useRoute } from "../lib/router";
import { hasChatFab } from "../pages/chat/fab";

const styles = stylex.create({
  // The button's height plus its offset from the viewport's edge (36 + 24
  // desktop, 32 + 16 narrow; see ChatLauncher) and a gap. The frame's own end
  // padding does not count: full-bleed tables reach into it.
  fabClearance: {
    flexShrink: 0,
    height: {
      default: `calc(${spacingVars["--spacing-12"]} + ${spacingVars["--spacing-6"]})`,
      "@media (max-width: 768px)": `calc(${spacingVars["--spacing-12"]} + ${spacingVars["--spacing-3"]})`,
    },
  },
});

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
  const { page } = useRoute();
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
          {/* Room under the last content for the floating chat button, so at the end of the scroll it covers nothing. */}
          {hasChatFab(page) && <VStack aria-hidden xstyle={styles.fabClearance} />}
        </LayoutContent>
      }
    />
  );
}
