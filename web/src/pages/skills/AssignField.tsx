import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentSpec } from "../../lib/types";
import type { SkillAssignment } from "./skills";

export interface AssignFieldProps {
  value: SkillAssignment;
  onChange: (value: SkillAssignment) => void;
  agents: Pick<AgentSpec, "id" | "name" | "role" | "enabled">[];
  /** Shown under the agent picker, e.g. an error. */
  status?: { type: "error"; message: string };
  isDisabled?: boolean;
}

/** "Sara (Coder)", "QA", "Writer (off)". */
function agentOption(a: Pick<AgentSpec, "name" | "role" | "enabled">): string {
  const notes = [a.name === a.role ? "" : a.role, a.enabled ? "" : "off"].filter(Boolean);
  return notes.length ? `${a.name} (${notes.join(", ")})` : a.name;
}

/** Who has a skill preloaded: every agent (agents added later too), or the chosen ones. */
export function AssignField({ value, onChange, agents, status, isDisabled }: AssignFieldProps) {
  const chosen = value === "all" ? [] : value;
  return (
    <VStack gap={3}>
      <RadioList
        label="Who uses this skill"
        isLabelHidden
        value={value === "all" ? "all" : "chosen"}
        onChange={(v) => onChange(v === "all" ? "all" : chosen)}
        isDisabled={isDisabled}>
        <RadioListItem value="all" label="Every agent" description="Agents you add later get it too." align="first-line" />
        <RadioListItem value="chosen" label="Chosen agents" description="Only the agents you pick below." align="first-line" />
      </RadioList>
      {value !== "all" && (
        <MultiSelector
          label="Agents"
          placeholder="Pick agents"
          options={agents.map((a) => ({ value: a.id, label: agentOption(a) }))}
          value={chosen}
          onChange={(ids) => onChange(ids)}
          triggerDisplay="labels"
          hasSearch={agents.length > 12}
          hasSelectAll={agents.length > 3}
          description="Each picked agent has the skill loaded when it starts work. Pointer can use every installed skill."
          status={status}
          isDisabled={isDisabled}
          width="100%"
        />
      )}
    </VStack>
  );
}
