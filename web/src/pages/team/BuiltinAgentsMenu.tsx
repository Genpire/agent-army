import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { href } from "../../lib/router";
import type { AgentSpec } from "../../lib/types";
import { emojiGlyph } from "./emoji";
import { ACCESS_INFO, MAX_AGENTS } from "./team";

export interface BuiltinAgentsMenuProps {
  /** The built-in agents the team does not have (useMissingBuiltins). */
  agents: AgentSpec[];
  isFull: boolean;
}

/** The drawer route that adds a built-in agent, prefilled. */
export const builtinHref = (id: string) => href("team", "builtin", id);

/**
 * "Add a built-in agent": the built-in agents the team lacks, each opening
 * the agent drawer prefilled with it. Nothing when the team has them all.
 */
export function BuiltinAgentsMenu({ agents, isFull }: BuiltinAgentsMenuProps) {
  if (agents.length === 0) return null;
  return (
    <DropdownMenu
      button={{
        label: "Add a built-in agent",
        variant: "secondary",
        icon: <Icon icon={SparklesIcon} />,
        isDisabled: isFull,
        tooltip: isFull ? `A team can have at most ${MAX_AGENTS} agents.` : "Agents a fresh deployment starts with that this team does not have.",
      }}
      alignment="end"
      // Short rows: the drawer it opens shows the agent in full.
      items={agents.map((a) => ({
        id: a.id,
        label: [emojiGlyph(a.emoji), a.name].filter(Boolean).join(" "),
        description: `${a.role} · ${ACCESS_INFO[a.access].label}`,
        href: builtinHref(a.id),
      }))}
    />
  );
}
