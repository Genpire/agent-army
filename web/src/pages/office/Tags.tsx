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
});

/** A rounded label on the picture: a person's name under their face, a short line in a bubble, the foosball score. */
export function Tag({ text, isBold = true }: { text: string; isBold?: boolean }) {
  return (
    <HStack gap={1} vAlign="center" paddingInline={2} paddingBlock={0.5} xstyle={styles.tag}>
      <Text type="supporting" weight={isBold ? "semibold" : "normal"} maxLines={1}>
        {text}
      </Text>
    </HStack>
  );
}
