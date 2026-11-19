import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PlusIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { AgentSpec, PointerSpec } from "../../lib/types";
import { AgentDrawer, type AgentTarget } from "./AgentDrawer";
import { AgentsTable } from "./AgentsTable";
import { HrSection } from "./HrSection";
import { PointerSettings, SettingsRow } from "./PointerSettings";
import { MAX_AGENTS } from "./team";
import { useTeamSave } from "./useTeamSave";
import { WorkFlow } from "./WorkFlow";

/**
 * Team: who is on it (the agents), how a repo task moves through it, and
 * Pointer's own settings. An agent opens in a drawer at #/team/agent/<id>;
 * #/team/new-agent opens an empty one.
 */
export default function TeamPage() {
  const { config } = useConfig();
  const team = config.team;
  const route = useRoute();
  const saveTeam = useTeamSave();

  const enabled = team.agents.filter((a) => a.enabled);
  const canChangeCode = enabled.some((a) => a.access === "write");
  const isFull = team.agents.length >= MAX_AGENTS;

  // The drawer follows the route; the last target stays while it animates out.
  const [mode, id] = route.rest;
  const routed: AgentTarget | undefined = useMemo(() => {
    if (mode === "new-agent") return isFull ? undefined : { kind: "new" };
    const agent = mode === "agent" ? team.agents.find((a) => a.id === id) : undefined;
    return agent ? { kind: "edit", agent } : undefined;
  }, [mode, id, team.agents, isFull]);
  const [target, setTarget] = useState<AgentTarget | undefined>(routed);
  useEffect(() => {
    if (routed) setTarget(routed);
  }, [routed]);
  const close = useCallback(() => navigate("team"), []);

  const takenIds = useMemo(() => new Set(team.agents.map((a) => a.id)), [team.agents]);

  const saveAgent = (spec: AgentSpec, isNew: boolean) =>
    saveTeam((t) => {
      if (isNew && t.agents.length >= MAX_AGENTS) throw new Error(`A team can have at most ${MAX_AGENTS} agents.`);
      return { ...t, agents: isNew ? [...t.agents, spec] : t.agents.map((a) => (a.id === spec.id ? spec : a)) };
    });
  const deleteAgent = (agent: AgentSpec) => saveTeam((t) => ({ ...t, agents: t.agents.filter((a) => a.id !== agent.id) }));
  const toggleAgent = (agent: AgentSpec, on: boolean) =>
    saveTeam((t) => ({ ...t, agents: t.agents.map((a) => (a.id === agent.id ? { ...a, enabled: on } : a)) }));
  const savePointer = (patch: Partial<PointerSpec>) => saveTeam((t) => ({ ...t, pointer: { ...t.pointer, ...patch } }));

  const addButton = (
    <Button
      label="Add agent"
      variant="primary"
      icon={<Icon icon={PlusIcon} />}
      href={href("team", "new-agent")}
      isDisabled={isFull}
      tooltip={isFull ? `A team can have at most ${MAX_AGENTS} agents.` : undefined}
    />
  );

  return (
    <PageFrame title="Team" description={`${team.pointer.name} leads in Slack and hands work to the agents. Only this page changes the team.`}>
      <VStack gap={8}>
        <VStack gap={4}>
          <HStack gap={4} hAlign="between" vAlign="end" wrap="wrap">
            <VStack gap={1}>
              <Heading level={2}>Agents</Heading>
              <Text type="supporting">
                {team.agents.length === 0
                  ? `${team.pointer.name} has nobody to hand work to yet.`
                  : `${enabled.length} of ${team.agents.length} enabled. ${team.pointer.name} picks an agent by its “When to use” line; open one to edit it.`}
              </Text>
            </VStack>
            {team.agents.length > 0 && addButton}
          </HStack>
          {!canChangeCode && team.agents.length > 0 && (
            <Banner
              status="warning"
              title="No enabled agent can change code"
              description="Repo tasks that need code changes come back blocked. Enable an agent with Changes code access, or add one."
            />
          )}
          {team.agents.length === 0 ? (
            <Card>
              <EmptyState
                title="No agents yet"
                description={`${team.pointer.name} answers on its own until you add an agent. Add one that can change code so repo tasks can run.`}
                icon={<Icon icon={UserGroupIcon} size="lg" />}
                actions={addButton}
              />
            </Card>
          ) : (
            <Card padding={0}>
              <AgentsTable agents={team.agents} lead={team.pointer.name} onToggle={toggleAgent} />
            </Card>
          )}
        </VStack>

        <HrSection />

        <Divider />

        <SettingsRow
          title="How a repo task flows"
          description={`When someone asks for a code change in Slack, ${team.pointer.name} leads the team in a fresh checkout of the repository. Each step goes to the enabled agents whose access fits it.`}>
          <WorkFlow team={team} />
        </SettingsRow>

        <Divider />

        <PointerSettings pointer={team.pointer} claudeModel={config.anthropic.model ?? ""} onSave={savePointer} />
      </VStack>

      <AgentDrawer isOpen={routed !== undefined} target={target} takenIds={takenIds} lead={team.pointer.name} onClose={close} onSave={saveAgent} onDelete={deleteAgent} />
    </PageFrame>
  );
}
