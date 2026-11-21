import { Grid } from "@astryxdesign/core/Grid";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { useConfig } from "../../lib/state";
import { CAP_MAX, CAP_VARIANT, capError, saveAgentCaps, spendAgainstCap, useSpending } from "../overview/spending";
import { workLine } from "../settings/AgentCaps";

export interface AgentBudgetDraft {
  /** Its monthly cap, USD; 0 = none. */
  monthlyUsd: number;
  /** What it may spend in one repo task, USD; 0 = only the task's own budget. */
  perTaskUsd: number;
}

export interface AgentBudget {
  agentId: string | undefined;
  draft: AgentBudgetDraft;
  setDraft: (draft: AgentBudgetDraft) => void;
  /** After the agent itself is saved (a new agent must be on the team before it can have a cap): its caps, when they changed. Throws the server's error. */
  save: (agentId: string) => Promise<void>;
}

/** The drawer's budget fields for one agent (undefined: a new agent), saved with Settings → Spending's caps. */
export function useAgentBudget(agentId: string | undefined): AgentBudget {
  const { config, refresh } = useConfig();
  const saved: AgentBudgetDraft = {
    monthlyUsd: (agentId && config.budget.perAgentUsd[agentId]) || 0,
    perTaskUsd: (agentId && config.budget.perTaskAgentUsd[agentId]) || 0,
  };
  const [draft, setDraft] = useState<AgentBudgetDraft>(saved);
  const save = async (id: string) => {
    if (draft.monthlyUsd === saved.monthlyUsd && draft.perTaskUsd === saved.perTaskUsd) return;
    const invalid = capError(draft.monthlyUsd) ?? capError(draft.perTaskUsd);
    if (invalid) throw new Error(`The agent was saved, but not its budget: ${invalid}`);
    await saveAgentCaps(
      config.budget,
      config.team.agents.map((a) => a.id),
      id,
      draft,
    );
    await refresh();
  };
  return { agentId, draft, setDraft, save };
}

/** The agent's monthly cap and per-task cap, with this month's spend against the cap. */
export function AgentBudgetField({ budget }: { budget: AgentBudget }) {
  const usage = useSpending();
  const { draft, setDraft } = budget;
  const view = budget.agentId ? usage.data?.agents.find((a) => a.agentId === budget.agentId) : undefined;
  const monthlyError = capError(draft.monthlyUsd);
  const perTaskError = capError(draft.perTaskUsd);
  return (
    <VStack gap={4}>
      <Grid columns={{ minWidth: 200, max: 2 }} gap={4} align="start">
        <NumberInput
          label="Monthly cap"
          description="Its share of repo tasks and chat per month (UTC). Past it, it sits out new repo tasks. 0 means no cap."
          value={draft.monthlyUsd}
          onChange={(monthlyUsd) => setDraft({ ...draft, monthlyUsd })}
          min={0}
          max={CAP_MAX}
          step={1}
          units="USD"
          hasNumberSteppers
          status={monthlyError ? { type: "error", message: monthlyError } : undefined}
        />
        <NumberInput
          label="Per task"
          description="What it may spend in one repo task. Past it, its tool calls are denied and it wraps up. 0 means only the task's budget."
          value={draft.perTaskUsd}
          onChange={(perTaskUsd) => setDraft({ ...draft, perTaskUsd })}
          min={0}
          max={CAP_MAX}
          step={1}
          units="USD"
          hasNumberSteppers
          isOptional
          status={perTaskError ? { type: "error", message: perTaskError } : undefined}
        />
      </Grid>
      {!budget.agentId ? (
        <Text type="supporting">A new agent has spent nothing yet. Its spend shows here and under Settings → Spending.</Text>
      ) : !view ? (
        <Text type="supporting">{usage.error ? `This month's spend could not be read: ${usage.error}` : "Reading this month's spend…"}</Text>
      ) : (
        <VStack gap={1}>
          {view.capUsd ? (
            <ProgressBar label={`${view.name} this month`} isLabelHidden value={Math.min(view.usd, view.capUsd)} max={view.capUsd} variant={CAP_VARIANT[view.level]} />
          ) : null}
          <Text hasTabularNumbers>{spendAgainstCap(view)}</Text>
          <Text type="supporting">{workLine(view)}</Text>
        </VStack>
      )}
    </VStack>
  );
}
