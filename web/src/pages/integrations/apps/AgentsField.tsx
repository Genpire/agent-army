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
}

/** Which team agents may use an app besides Pointer. */
export function AgentsField({ value, onChange, agents, lead, isDisabled }: AgentsFieldProps) {
  return (
    <MultiSelector
      label="Agents that may use it"
      placeholder={`Only ${lead}`}
      options={agents.map((a) => ({ value: a.id, label: agentLabel(a) }))}
      value={value.filter((id) => agents.some((a) => a.id === id))}
      onChange={onChange}
      triggerDisplay="labels"
      hasSearch={agents.length > 12}
      description={`${lead} can always use it. Agents get it in repo tasks (agents that only look get its read-only tools) and its read-only tools in Slack conversations.`}
      isDisabled={isDisabled}
      isOptional
      width="100%"
    />
  );
}
