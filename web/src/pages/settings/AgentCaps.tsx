import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { api } from "../../lib/api";
import { ENGINE_NAME } from "../../lib/engines";
import { plural } from "../../lib/format";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { PublicConfig } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { type AgentSpendView, CAP_MAX, CAP_VARIANT, LEAD_ID, type UsageView, capError, capsFor, spendAgainstCap } from "../overview/spending";
import { SaveRow } from "./parts";

type Budget = PublicConfig["budget"];

interface AgentRow extends Record<string, unknown> {
  agentId: string;
  view: AgentSpendView;
}

/** "3 repo tasks · 12 chat replies", or that it has not worked this month. */
export function workLine(a: Pick<AgentSpendView, "tasks" | "chats">): string {
  const parts = [a.tasks ? plural(a.tasks, "repo task") : "", a.chats ? plural(a.chats, "chat reply", "chat replies") : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No work this month";
}

function CapInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const error = capError(value);
  return (
    <NumberInput
      label={label}
      isLabelHidden
      value={value}
      onChange={onChange}
      min={0}
      max={CAP_MAX}
      step={1}
      units="USD"
      width={120}
      isWheelEnabled={false}
      status={error ? { type: "error", message: error } : undefined}
      statusVariant="tooltip"
    />
  );
}

/**
 * Caps per agent: a monthly cap on its share of repo tasks and chat (an agent
 * over it sits out new repo tasks; Pointer over its own refuses new work), and
 * what it may spend in one repo task (past it, its tool calls are denied and
 * it is told to wrap up). Removed agents keep their spend in Activity, not here.
 */
export function AgentCaps({ saved, usage, reload }: { saved: Budget; usage: UsageView | undefined; reload: () => Promise<void> }) {
  const { config, refresh } = useConfig();
  const { run, pending } = useAction();
  const [monthly, setMonthly] = useState<Record<string, number>>(saved.perAgentUsd);
  const [perTask, setPerTask] = useState<Record<string, number>>(saved.perTaskAgentUsd);
  const teamIds = config.team.agents.map((a) => a.id);
  const ids = [LEAD_ID, ...teamIds];
  const listed = new Set(ids);
  const agents = (usage?.agents ?? []).filter((a) => listed.has(a.agentId));
  const capOf = (caps: Record<string, number>, id: string) => caps[id] ?? 0;
  const isDirty =
    ids.some((id) => capOf(monthly, id) !== capOf(saved.perAgentUsd, id)) || teamIds.some((id) => capOf(perTask, id) !== capOf(saved.perTaskAgentUsd, id));
  const invalid = ids.some((id) => capError(capOf(monthly, id)) || capError(capOf(perTask, id)));

  const save = () =>
    void run(
      async () => {
        await api.post("/api/budget", { perAgentUsd: capsFor(monthly, ids), perTaskAgentUsd: capsFor(perTask, teamIds) });
        await Promise.all([refresh(), reload()]);
      },
      { success: "Agent caps saved." },
    );

  const columns: TableColumn<AgentRow>[] = [
    {
      key: "agent",
      header: "Agent",
      width: proportional(1.2, { minWidth: 140 }),
      renderCell: ({ view }) => (
        <VStack gap={0.5}>
          <Text weight="medium">{view.name}</Text>
          <Text type="supporting">
            {view.lead ? "Leads chat and repo tasks" : [view.engine && view.engine !== "claude" ? `Works through ${ENGINE_NAME[view.engine]}` : "", view.enabled === false ? "Off" : ""].filter(Boolean).join(" · ") || "Team member"}
          </Text>
        </VStack>
      ),
    },
    {
      key: "used",
      header: "This month",
      width: proportional(2, { minWidth: 180 }),
      renderCell: ({ view }) => (
        <VStack gap={1}>
          {view.capUsd ? (
            <ProgressBar label={`${view.name} this month`} isLabelHidden value={Math.min(view.usd, view.capUsd)} max={view.capUsd} variant={CAP_VARIANT[view.level]} />
          ) : null}
          <Text hasTabularNumbers>{spendAgainstCap(view)}</Text>
          <Text type="supporting">{workLine(view)}</Text>
        </VStack>
      ),
    },
    {
      key: "monthly",
      header: "Monthly cap",
      width: pixel(136),
      renderCell: ({ agentId, view }) => (
        <CapInput label={`Monthly cap for ${view.name}`} value={capOf(monthly, agentId)} onChange={(v) => setMonthly((m) => ({ ...m, [agentId]: v }))} />
      ),
    },
    {
      key: "perTask",
      header: "Per task",
      width: pixel(136),
      renderCell: ({ agentId, view }) =>
        view.lead ? (
          <Text type="supporting">The task's budget</Text>
        ) : (
          <CapInput label={`What ${view.name} may spend in one task`} value={capOf(perTask, agentId)} onChange={(v) => setPerTask((m) => ({ ...m, [agentId]: v }))} />
        ),
    },
  ];

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4} accessibilityLevel={3}>
          Per agent
        </Heading>
        <Text type="supporting">
          Each agent's share of repo tasks and chat this month. An agent past its monthly cap sits out new repo tasks; past its per-task cap, it is told to wrap up and report. Shares that include Codex or Gemini CLI runs are estimated. Also on each agent on the{" "}
          <Link href={href("team")} isStandalone>
            Team page
          </Link>
          .
        </Text>
      </VStack>
      <Table<AgentRow>
        data={agents.map((view) => ({ agentId: view.agentId, view }))}
        columns={columns}
        idKey="agentId"
        density="balanced"
        textOverflow="wrap"
        emptyState={<EmptyState isCompact title="Loading" description="Reading this month's spend." />}
      />
      <SaveRow label="Save agent caps" isDirty={isDirty} isInvalid={invalid} pending={pending} onSave={save} />
    </VStack>
  );
}
