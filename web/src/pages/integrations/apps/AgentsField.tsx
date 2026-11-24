import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import type { AgentSpec } from "../../../lib/types";
import { agentLabel } from "./apps";

export interface AgentsFieldProps {
  /** Agent ids. */
  value: string[];
  onChange: (ids: string[]) => void;
  agents: Pick<AgentSpec, "id" | "name" | "role" | "enabled">[];
  /** Pointer's name. */
  lead: string;
  isDisabled?: boolean;
  /** The app is "Only for me": no agent gets it, whatever is chosen here. */
  ownerOnly?: boolean;
}

/** Which team agents may use an app besides Pointer. */
export function AgentsField({ value, onChange, agents, lead, isDisabled, ownerOnly }: AgentsFieldProps) {
  return (
    <MultiSelector
      label="Agents that may use it"
      placeholder={`Only ${lead}`}
      options={agents.map((a) => ({ value: a.id, label: agentLabel(a) }))}
      value={value.filter((id) => agents.some((a) => a.id === id))}
      onChange={onChange}
      triggerDisplay="labels"
      hasSearch={agents.length > 12}
      description={
        ownerOnly
          ? `It is only for you, so team members never get it, in chat or in repo tasks, whatever agents are chosen here. Turn off "Only for me" to give it to them.`
          : `${lead} can always use it. Agents get it in repo tasks (agents that only look get its read-only tools) and its read-only tools in Slack conversations.`
      }
      isDisabled={isDisabled || ownerOnly}
      isOptional
      width="100%"
    />
  );
}
