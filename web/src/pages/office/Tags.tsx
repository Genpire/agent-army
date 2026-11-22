import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, radiusVars, shadowVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  tag: {
    backgroundColor: colorVars["--color-background-card"],
    borderRadius: radiusVars["--radius-full"],
    boxShadow: shadowVars["--shadow-low"],
  },
  // A few lines of talk: a rounded box rather than a pill.
  wrapped: { borderRadius: radiusVars["--radius-container"] },
});

/**
 * A rounded label on the picture: a person's name under their face, a short
 * line in a bubble, a game's score; with `maxLines` above one, a line of
 * real talk wrapped (evenly) over a few lines.
 */
export function Tag({ text, isBold = true, maxLines = 1 }: { text: string; isBold?: boolean; maxLines?: number }) {
  const isWrapped = maxLines > 1;
  return (
    <HStack gap={1} vAlign="center" paddingInline={2} paddingBlock={isWrapped ? 1 : 0.5} xstyle={[styles.tag, isWrapped && styles.wrapped]}>
      <Text type="supporting" weight={isBold ? "semibold" : "normal"} maxLines={maxLines} textWrap={isWrapped ? "pretty" : undefined}>
        {text}
      </Text>
    </HStack>
  );
}
