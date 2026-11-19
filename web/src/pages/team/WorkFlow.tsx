import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowUpOnSquareIcon, ClipboardDocumentListIcon, ShieldCheckIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { AgentSpec, Team } from "../../lib/types";
import { agentHref } from "./AgentsTable";
import { emojiGlyph } from "./emoji";

/** The agents filling one step, each linking to its drawer; `empty` when there are none. */
function Roster({ label, agents, empty }: { label: string; agents: AgentSpec[]; empty?: ReactNode }) {
  if (agents.length === 0) return empty ?? null;
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type="supporting">{label}</Text>
      {agents.map((a) => (
        <Token key={a.id} label={[emojiGlyph(a.emoji), a.name].filter(Boolean).join(" ")} size="sm" href={agentHref(a.id)} />
      ))}
    </HStack>
  );
}

function Missing({ children }: { children: string }) {
  return (
    <HStack gap={1.5} vAlign="center">
      <Icon icon="warning" color="warning" size="sm" />
      <Text type="supporting" color="primary">
        {children}
      </Text>
    </HStack>
  );
}

/**
 * How a repo task moves through the team, with the enabled agents that can
 * fill each step by access level (README, "Repo tasks"): Pointer plans, an
 * agent that changes code builds, agents that run commands review and test
 * (in the browser for visible changes), and the platform opens the pull request.
 */
export function WorkFlow({ team }: { team: Team }) {
  const enabled = team.agents.filter((a) => a.enabled);
  const lookers = enabled.filter((a) => a.access === "read");
  const builders = enabled.filter((a) => a.access === "write");
  const verifiers = enabled.filter((a) => a.access !== "read");
  const lead = team.pointer.name;

  return (
    <VStack gap={4}>
      <Stepper activeStep={-1} orientation="vertical" indicatorPosition="on-track" density="spacious" label="How a repo task flows">
        <Step
          step={0}
          label={`${lead} plans`}
          description="Reads the request, the repository and its project notes, writes a plan with acceptance criteria and picks agents by their “When to use” line."
          indicator={<Icon icon={ClipboardDocumentListIcon} size="sm" />}>
          <Roster label="Research help" agents={lookers} />
        </Step>
        <Step
          step={1}
          label="An agent builds it"
          description="An agent that can change code makes the change and runs the project's formatter, linter and nearest tests."
          status={builders.length ? undefined : "warning"}
          indicator={<Icon icon={WrenchScrewdriverIcon} size="sm" />}>
          <Roster
            label="Can build"
            agents={builders}
            empty={<Missing>No enabled agent can change code, so tasks that need code come back blocked.</Missing>}
          />
        </Step>
        <Step
          step={2}
          label="Another agent verifies it"
          description="A different agent reviews the diff or runs the tests. For changes people can see, it starts the app, checks it in a headless browser and takes screenshots. Up to three rounds."
          indicator={<Icon icon={ShieldCheckIcon} size="sm" />}>
          <Roster
            label="Can verify"
            agents={verifiers}
            empty={<Missing>No enabled agent can run commands, so Pointer skips this step and says so.</Missing>}
          />
        </Step>
        <Step
          step={3}
          label="The platform opens a pull request"
          description={`It commits, pushes the branch and opens the pull request, waits for CI and has the team fix failing checks. ${lead} posts the summary and the link in the Slack thread.`}
          indicator={<Icon icon={ArrowUpOnSquareIcon} size="sm" />}
        />
      </Stepper>
      <Text type="supporting">In Slack conversations every agent can only search the web and read GitHub, project notes and monday.com, whatever its access.</Text>
    </VStack>
  );
}
