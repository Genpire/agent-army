import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Link } from "@astryxdesign/core/Link";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { href, navigate } from "../../lib/router";
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
