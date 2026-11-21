import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ENGINE_NAME } from "../../lib/engines";
import { usd } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { Task } from "../../lib/types";
import { type AgentCost, type AgentSpendView, CAP_VARIANT, agentDisplayName, costRows, spendAgainstCap, spendText, tokenCount } from "../overview/spending";
import { workLine } from "../settings/AgentCaps";

interface ShareRow extends Record<string, unknown> {
  agentId: string;
  name: string;
  cost: AgentCost;
}

/** "Codex: 120k tokens (~$0.40)", "Gemini CLI: 40k tokens, no price for its model". */
function engineLine(cost: AgentCost): string {
  return Object.entries(cost.engines ?? {})
    .map(([id, e]) => {
      const name = ENGINE_NAME[id as keyof typeof ENGINE_NAME] ?? id;
      return e ? `${name}: ${tokenCount(e.tokens)}${e.usd !== undefined ? ` (~${usd(e.usd)})` : ", no price for its model"}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

/** Each agent's share of one repo task (task.agentCosts), highest first. Nothing for tasks saved before shares existed. */
export function TaskAgentCosts({ task }: { task: Task }) {
  const { config } = useConfig();
  const rows: ShareRow[] = costRows(task.agentCosts).map((c) => ({ agentId: c.agentId, name: agentDisplayName(config.team, c.agentId), cost: c }));
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.cost.usd), 0.01);
  const columns: TableColumn<ShareRow>[] = [
    { key: "agent", header: "Agent", width: proportional(1.2, { minWidth: 120 }), renderCell: (r) => <Text weight="medium">{r.name}</Text> },
    {
      key: "share",
      header: "Share",
      width: proportional(1.5, { minWidth: 140 }),
      renderCell: (r) => (
        <VStack gap={1}>
          <ProgressBar label={`${r.name}'s share`} isLabelHidden value={r.cost.usd} max={max} />
          <Text type="supporting" hasTabularNumbers>
            {spendText(r.cost)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: pixel(140),
      renderCell: (r) => (
        <VStack gap={0.5}>
          <Text hasTabularNumbers>{r.cost.tokens ? tokenCount(r.cost.tokens) : "–"}</Text>
          {r.cost.engines && <Text type="supporting">{engineLine(r.cost)}</Text>}
        </VStack>
      ),
    },
  ];
  return <Table<ShareRow> data={rows} columns={columns} idKey="agentId" density="compact" textOverflow="wrap" />;
}

interface MonthRow extends Record<string, unknown> {
  agentId: string;
  view: AgentSpendView;
}

/** This month's spend by agent, highest first (agents that did nothing are left out). */
export function MonthAgentsTable({ agents, limit = 8 }: { agents: AgentSpendView[]; limit?: number }) {
  const rows: MonthRow[] = agents
    .filter((a) => a.usd > 0 || a.tokens > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit)
    .map((view) => ({ agentId: view.agentId, view }));
  if (!rows.length) return <Text color="secondary">No agent has spent anything this month.</Text>;
  const max = Math.max(...rows.map((r) => r.view.usd), 0.01);
  const columns: TableColumn<MonthRow>[] = [
    { key: "agent", header: "Agent", width: proportional(1.5, { minWidth: 140 }), renderCell: ({ view }) => <Text weight="medium">{view.name}</Text> },
    { key: "work", header: "Work", width: proportional(1.5, { minWidth: 140 }), renderCell: ({ view }) => <Text color="secondary">{workLine(view)}</Text> },
    {
      key: "spend",
      header: "Spend",
      width: proportional(2, { minWidth: 160 }),
      renderCell: ({ view }) => (
        <VStack gap={1}>
          <ProgressBar
            label={`${view.name} this month`}
            isLabelHidden
            value={Math.min(view.usd, view.capUsd ?? max)}
            max={view.capUsd ?? max}
            variant={view.capUsd ? CAP_VARIANT[view.level] : "accent"}
          />
          <Text type="supporting" hasTabularNumbers>
            {spendAgainstCap(view)}
          </Text>
        </VStack>
      ),
    },
  ];
  return <Table<MonthRow> data={rows} columns={columns} idKey="agentId" density="compact" hasHover textOverflow="truncate" />;
}
