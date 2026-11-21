import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Link } from "@astryxdesign/core/Link";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { usd } from "../../lib/format";
import { href, navigate } from "../../lib/router";
import { type AgentSpendView, CAP_VARIANT, spendText, useSpending } from "../overview/spending";
import type { AgentSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { AccessToken } from "./AccessToken";
import { AgentEmoji } from "./AgentEmoji";
import { effortLabel, modelLabel } from "./team";

export interface AgentsTableProps {
  agents: AgentSpec[];
  /** Pointer's name, as the owner set it. */
  lead: string;
  /** Saves the agent's enabled flag straight away. */
  onToggle: (agent: AgentSpec, enabled: boolean) => Promise<void>;
}

export const agentHref = (id: string) => href("team", "agent", id);

/** Name and role, linking to the agent's edit drawer. */
function AgentCell({ agent, isNarrow }: { agent: AgentSpec; isNarrow: boolean }) {
  return (
    <HStack gap={3} vAlign="center">
      <AgentEmoji emoji={agent.emoji} name={agent.name} />
      <VStack gap={0.5}>
        <Link href={agentHref(agent.id)} weight="semibold" color="primary" isStandalone>
          {agent.name}
        </Link>
        <Text type="supporting">{agent.role}</Text>
        {isNarrow && (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <AccessToken access={agent.access} />
          </HStack>
        )}
      </VStack>
    </HStack>
  );
}

/** This month's spend against its monthly cap ("$3.10 of $20.00"), with a bar when it has one. */
function AgentSpend({ view }: { view: AgentSpendView | undefined }) {
  if (!view) return <Text color="secondary">–</Text>;
  const spent = spendText(view);
  return (
    <VStack gap={1}>
      {view.capUsd ? (
        <ProgressBar label={`${view.name} this month`} isLabelHidden value={Math.min(view.usd, view.capUsd)} max={view.capUsd} variant={CAP_VARIANT[view.level]} />
      ) : null}
      <Text hasTabularNumbers maxLines={1}>
        {view.capUsd ? `${spent} of ${usd(view.capUsd)}` : spent}
      </Text>
      {view.perTaskCapUsd ? <Text type="supporting">{`${usd(view.perTaskCapUsd)} per task`}</Text> : null}
    </VStack>
  );
}

function EnabledSwitch({ agent, onToggle }: Pick<AgentsTableProps, "onToggle"> & { agent: AgentSpec }) {
  const { run } = useAction();
  return (
    <Switch
      label={`${agent.name} enabled`}
      isLabelHidden
      value={agent.enabled}
      changeAction={async (enabled) => {
        await run(() => onToggle(agent, enabled), { success: `${agent.name} ${enabled ? "enabled" : "disabled"}.` });
      }}
    />
  );
}

/** The roster: one row per agent, dense. Click a name (or Edit) to open its drawer; the switch saves at once. */
export function AgentsTable({ agents, lead, onToggle }: AgentsTableProps) {
  const isNarrow = useMediaQuery("(max-width: 720px)");
  const spending = useSpending();
  const spend = new Map((spending.data?.agents ?? []).map((a) => [a.agentId, a]));

  const agentColumn: TableColumn<AgentSpec> = {
    key: "agent",
    header: "Agent",
    width: isNarrow ? proportional(1, { minWidth: 180 }) : pixel(208),
    renderCell: (a) => <AgentCell agent={a} isNarrow={isNarrow} />,
  };
  const enabledColumn: TableColumn<AgentSpec> = {
    key: "enabled",
    header: "Enabled",
    width: pixel(88),
    renderCell: (a) => <EnabledSwitch agent={a} onToggle={onToggle} />,
  };

  const columns: TableColumn<AgentSpec>[] = isNarrow
    ? [agentColumn, enabledColumn]
    : [
        agentColumn,
        {
          key: "description",
          header: `When ${lead} uses it`,
          width: proportional(1, { minWidth: 220 }),
          renderCell: (a) => (
            <Text color="secondary" maxLines={2}>
              {a.description}
            </Text>
          ),
        },
        { key: "access", header: "Access", width: pixel(156), renderCell: (a) => <AccessToken access={a.access} /> },
        {
          key: "model",
          header: "Model and effort",
          width: pixel(152),
          renderCell: (a) => (
            <VStack gap={0.5}>
              {a.model ? <Text>{modelLabel(a.model)}</Text> : <Text color="secondary">Same as {lead}</Text>}
              <Text type="supporting">{a.effort ? `${effortLabel(a.effort)} effort` : "Effort follows the work"}</Text>
            </VStack>
          ),
        },
        {
          key: "spend",
          header: "This month",
          width: pixel(164),
          renderCell: (a) => <AgentSpend view={spend.get(a.id)} />,
        },
        enabledColumn,
        {
          key: "edit",
          header: "",
          width: pixel(56),
          align: "end",
          renderCell: (a) => (
            <IconButton label={`Edit ${a.name}`} tooltip="Edit" variant="ghost" size="sm" icon={<Icon icon={PencilSquareIcon} />} onClick={() => navigate("team", "agent", a.id)} />
          ),
        },
      ];

  return <Table data={agents} columns={columns} idKey="id" density="balanced" />;
}
