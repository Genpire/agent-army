import { Avatar } from "@astryxdesign/core/Avatar";
import { Center } from "@astryxdesign/core/Center";
import { Text } from "@astryxdesign/core/Text";
import { emojiGlyph } from "./emoji";

export interface AgentEmojiProps {
  /** The Slack emoji code, e.g. ":hammer_and_wrench:". */
  emoji: string;
  /** Used for the initials when the code has no known glyph. */
  name: string;
  size?: "sm" | "md";
}

/** An agent's Slack emoji as the browser draws it, or its initials for custom and unknown codes. Decorative: the name is always next to it. */
export function AgentEmoji({ emoji, name, size = "md" }: AgentEmojiProps) {
  const glyph = emojiGlyph(emoji);
  const box = size === "md" ? 32 : 24;
  if (!glyph) return <Avatar name={name || "?"} size={box} shape="rounded" tooltip={false} alt="" />;
  return (
    <Center width={box} height={box}>
      <Text size={size === "md" ? "xl" : "base"} aria-hidden>
        {glyph}
      </Text>
    </Center>
  );
}
