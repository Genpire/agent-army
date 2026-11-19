import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { navigate } from "../../lib/router";
import type { AgentSpec, Team } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { AccessToken } from "./AccessToken";
import { agentHref } from "./AgentsTable";
import { type AgentChanges, type ChangeField, type Decision, FIELD_LABEL, type HrProposal, type HrReview, KIND_INFO, STATUS_INFO, hrApi, raisesAccess } from "./hr";
import { ACCESS_INFO, effortLabel, modelLabel } from "./team";

export interface HrProposalRowProps {
  review: HrReview;
  proposal: HrProposal;
  /** The team as it is now. */
  team: Team;
  /** After a decision: the review as the server stored it, and what was decided. */
  onDecided: (decision: Decision) => Promise<void>;
}

const modelText = (model: string, lead: string) => (model ? modelLabel(model) : `Same as ${lead}`);
const effortText = (effort: AgentSpec["effort"]) => (effort ? `${effortLabel(effort)} effort` : "Follows the work");

/** One field's value, for the hire's details and the change's diff. */
function fieldValue(field: ChangeField, value: AgentChanges[ChangeField], lead: string): ReactNode {
  switch (field) {
    case "access":
      return value ? <AccessToken access={value as AgentSpec["access"]} /> : null;
    case "model":
      return <Text>{modelText(String(value ?? ""), lead)}</Text>;
    case "effort":
      return <Text>{effortText((value ?? "") as AgentSpec["effort"])}</Text>;
    case "skills":
      return <Text>{Array.isArray(value) && value.length ? value.join(", ") : "None"}</Text>;
    default:
      return <Text>{String(value ?? "") || "–"}</Text>;
  }
}

/** The full proposed agent: who it is, when it is used, its access, model and instructions. */
function HireDetails({ agent, lead }: { agent: AgentSpec; lead: string }) {
  return (
    <VStack gap={3}>
      <MetadataList>
        <MetadataListItem label="Name and role">
          <Text>
            {agent.name}, {agent.role}
          </Text>
        </MetadataListItem>
        <MetadataListItem label={`When ${lead} uses it`}>
          <Text>{agent.description}</Text>
        </MetadataListItem>
        <MetadataListItem label="Access">
          <VStack gap={1}>
            <HStack>
              <AccessToken access={agent.access} />
            </HStack>
            <Text type="supporting">{ACCESS_INFO[agent.access].summary}</Text>
          </VStack>
        </MetadataListItem>
        <MetadataListItem label="Model and effort">
          <Text>
            {modelText(agent.model, lead)} · {effortText(agent.effort)}
          </Text>
        </MetadataListItem>
        {agent.skills.length > 0 && (
          <MetadataListItem label="Skills">
            <Text>{agent.skills.join(", ")}</Text>
          </MetadataListItem>
        )}
      </MetadataList>
      <Collapsible defaultIsOpen={false} trigger={<Text weight="semibold">Instructions</Text>}>
        <Markdown density="compact">{agent.instructions}</Markdown>
      </Collapsible>
    </VStack>
  );
}

/** Long text as before and after, behind a toggle. */
function TextDiff({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <Collapsible defaultIsOpen={false} trigger={<Text weight="semibold">{label}: before and proposed</Text>}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="label" color="secondary">
            Before
          </Text>
          <Markdown density="compact">{before}</Markdown>
        </VStack>
        <VStack gap={1}>
          <Text type="label" color="secondary">
            Proposed
          </Text>
          <Markdown density="compact">{after}</Markdown>
        </VStack>
      </VStack>
    </Collapsible>
  );
}

/** The fields a change sets: each as it was when HR reviewed, and as proposed. */
function ChangeDetails({ proposal, team }: { proposal: HrProposal; team: Team }) {
  const lead = team.pointer.name;
  const changes = proposal.changes ?? {};
  const before = proposal.before ?? {};
  const fields = (Object.keys(changes) as ChangeField[]).filter((f) => f in FIELD_LABEL);
  const short = fields.filter((f) => f !== "instructions");
  const stillThere = team.agents.some((a) => a.id === proposal.agentId);
  return (
    <VStack gap={3}>
      {!stillThere && proposal.status === "open" && <Text color="secondary">{proposal.agentName ?? "This agent"} is no longer on the team.</Text>}
      {short.length > 0 && (
        <MetadataList>
          {short.map((field) => (
            <MetadataListItem key={field} label={FIELD_LABEL[field]}>
              {field === "description" ? (
                <VStack gap={1}>
                  <Text color="secondary" hasStrikethrough>
                    {String(before.description ?? "")}
                  </Text>
                  <Text>{String(changes.description ?? "")}</Text>
                </VStack>
              ) : (
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {fieldValue(field, before[field], lead)}
                  <Text color="secondary">→</Text>
                  {fieldValue(field, changes[field], lead)}
                  {field === "access" && raisesAccess(before.access, changes.access) && <Token size="sm" color="orange" label="More access" />}
                </HStack>
              )}
            </MetadataListItem>
          ))}
        </MetadataList>
      )}
      {changes.instructions !== undefined && <TextDiff label="Instructions" before={before.instructions ?? ""} after={changes.instructions} />}
    </VStack>
  );
}

function RetireDetails({ proposal, team }: { proposal: HrProposal; team: Team }) {
  const agent = team.agents.find((a) => a.id === proposal.agentId);
  const name = proposal.agentName ?? agent?.name ?? "This agent";
  const lastWriter =
    agent?.enabled && agent.access === "write" && team.agents.filter((a) => a.enabled && a.access === "write").length === 1 && proposal.status === "open";
  return (
    <VStack gap={2}>
      <Text color="secondary">
        {name} is disabled, not deleted: {team.pointer.name} stops handing it work, and you can turn it back on in the table above.
      </Text>
      {lastWriter && (
        <Banner
          status="warning"
          title={`${name} is the only enabled agent that can change code`}
          description="Repo tasks that need code changes come back blocked until another agent with Changes code access is enabled."
        />
      )}
    </VStack>
  );
}

function SkillDetails({ proposal }: { proposal: HrProposal }) {
  return (
    <Text color="secondary">
      Apply opens the Skills page with a search for “{proposal.skillNeed}”.
      {proposal.agentName ? ` HR suggests ${proposal.agentName} uses it.` : ""}
    </Text>
  );
}

/**
 * One proposal: its kind, title, reason and evidence, what would change, and
 * Apply / Dismiss. Retiring takes two clicks. Decided proposals show how they
 * were decided instead of the buttons.
 */
export function HrProposalRow({ review, proposal, team, onDecided }: HrProposalRowProps) {
  const apply = useAction();
  const dismiss = useAction();
  const kind = KIND_INFO[proposal.kind];
  const isOpen = proposal.status === "open";
  const name = proposal.agentName ?? "the agent";
  const hiredId = proposal.appliedAgentId;
  const hired = hiredId ? team.agents.find((a) => a.id === hiredId) : undefined;

  const doApply = async () => {
    await apply.run(
      async () => {
        const decision = await hrApi.apply(review, proposal);
        await onDecided(decision);
        // The Skills page's search (#/skills/find/<need>) takes it from here.
        if (decision.skillNeed) navigate("skills", "find", decision.skillNeed);
      },
      { success: successText(proposal, name) },
    );
  };

  const doDismiss = async () => {
    await dismiss.run(async () => onDecided(await hrApi.dismiss(review, proposal)), { success: "Dismissed." });
  };

  return (
    <VStack gap={3}>
      <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Token size="sm" color={kind.color} label={kind.label} description={kind.description} />
              <Text weight="semibold">{proposal.title}</Text>
              {proposal.status !== "open" && <Token size="sm" color={STATUS_INFO[proposal.status].color} label={STATUS_INFO[proposal.status].label} />}
            </HStack>
            <Text color="secondary">{proposal.reason}</Text>
          </VStack>
        </StackItem>
        {isOpen ? (
          <HStack gap={2} vAlign="center">
            {proposal.kind === "retire" ? (
              <ConfirmButton label="Retire" confirmLabel={`Click again to retire ${name}`} onConfirm={doApply} isDisabled={dismiss.pending} />
            ) : (
              <Button label="Apply" variant="primary" size="sm" isLoading={apply.pending} isDisabled={dismiss.pending} clickAction={doApply} />
            )}
            <Button label="Dismiss" variant="ghost" size="sm" isLoading={dismiss.pending} isDisabled={apply.pending} clickAction={doDismiss} />
          </HStack>
        ) : (
          hired && (
            <Link href={agentHref(hired.id)} weight="semibold" color="primary" isStandalone>
              Open {hired.name}
            </Link>
          )
        )}
      </HStack>
      {proposal.evidence.length > 0 && (
        <List listStyle="disc" density="compact" edge="flush">
          {proposal.evidence.map((fact, i) => (
            <ListItem key={i} label={<Text type="supporting">{fact}</Text>} />
          ))}
        </List>
      )}
      {proposal.kind === "hire" && proposal.agent && <HireDetails agent={proposal.agent} lead={team.pointer.name} />}
      {proposal.kind === "change" && <ChangeDetails proposal={proposal} team={team} />}
      {proposal.kind === "retire" && <RetireDetails proposal={proposal} team={team} />}
      {proposal.kind === "skill" && <SkillDetails proposal={proposal} />}
    </VStack>
  );
}

function successText(proposal: HrProposal, name: string): string {
  switch (proposal.kind) {
    case "hire":
      return `${proposal.agent?.name ?? "The new agent"} joined the team.`;
    case "change":
      return `${name} is updated.`;
    case "retire":
      return `${name} is disabled. Turn it back on in the table any time.`;
    case "skill":
      return "Marked as applied. Find the skill on the Skills page.";
  }
}
