import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowPathIcon, ChatBubbleLeftRightIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { ENGINE_NAME, engineReady } from "../../lib/engines";
import { headline } from "../../lib/format";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { AgentSpec, PublicConfig } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { useTasks } from "../activity/usePolled";
import { taskStatus } from "../chat/labels";
import { TaskCard } from "../chat/TaskCard";
import { ACCESS_INFO, effortLabel, modelLabel } from "../team/team";
import { useTeamSave } from "../team/useTeamSave";
import { AskComposer } from "./AskComposer";
import { Face } from "./Face";
import { type OfficePerson, STATE_INFO, faceChoices, minutesText, nameTag, taskHref, tasksOf } from "./model";
import { talksOf } from "./talk";
import { TalkLog } from "./TalkLog";
import { useTalkLog } from "./useOfficeTalk";

const RECENT = 5;

function Part({ title, children, end }: { title: string; children: ReactNode; end?: ReactNode }) {
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Heading level={3}>{title}</Heading>
        {end}
      </HStack>
      {children}
    </VStack>
  );
}

/** Model and effort in words, for an agent or for Pointer. */
function modelLines(person: OfficePerson, agent: AgentSpec | undefined, config: PublicConfig): { label: string; value: string }[] {
  const pointer = config.team.pointer;
  // On another provider, an empty chat model runs on that provider's main model.
  const claude =
    config.ai.chatProvider !== "anthropic"
      ? `${config.ai.chat.name}'s default`
      : config.anthropic.model
        ? modelLabel(config.anthropic.model)
        : "The Claude default";
  if (person.kind === "lead") {
    return [
      { label: "Model", value: pointer.model ? modelLabel(pointer.model) : claude },
      { label: "Effort", value: `${effortLabel(pointer.effort)} in chat, ${effortLabel(pointer.taskEffort).toLowerCase()} in repo tasks` },
    ];
  }
  if (!agent) return [];
  return [
    { label: "Model", value: agent.model ? modelLabel(agent.model) : `Same as ${pointer.name}` },
    { label: "Effort", value: agent.effort ? effortLabel(agent.effort) : "Same as the chat or repo task" },
  ];
}

function FacePicker({ person, agent, onChanged }: { person: OfficePerson; agent: AgentSpec; onChanged: () => void }) {
  const saveTeam = useTeamSave();
  const { run, pending } = useAction();
  const [round, setRound] = useState(0);
  const [picked, setPicked] = useState<string>();
  const current = agent.avatar || agent.id;
  const choices = faceChoices(current, agent.id, round);
  const choose = async (seed: string) => {
    setPicked(seed);
    const ok = await run(
      () => saveTeam((t) => ({ ...t, agents: t.agents.map((a) => (a.id === agent.id ? { ...a, avatar: seed === a.id ? "" : seed } : a)) })),
      { success: `${person.name} has a new face.` },
    );
    setPicked(undefined);
    if (ok) onChanged();
  };
  return (
    <VStack gap={3}>
      <Grid columns={{ minWidth: 56, max: 6 }} gap={2}>
        {choices.map((seed, i) => (
          <VStack key={seed} gap={1} hAlign="center">
            <Face
              seed={seed}
              name={person.name}
              size={48}
              label={seed === current ? `${person.name}'s face now` : `Face ${i}: use it for ${person.name}`}
              onClick={pending || seed === current ? undefined : () => void choose(seed)}
            />
            {seed === current ? (
              <Text type="supporting" color="secondary">
                Now
              </Text>
            ) : picked === seed ? (
              <Spinner size="sm" label="Saving" />
            ) : null}
          </VStack>
        ))}
      </Grid>
      <HStack gap={2} wrap="wrap">
        <Button label="More faces" size="sm" variant="secondary" icon={<Icon icon={ArrowPathIcon} size="sm" />} onClick={() => setRound((r) => r + 1)} isDisabled={pending} />
        {agent.avatar && <Button label="Back to the first face" size="sm" variant="ghost" clickAction={() => choose(agent.id)} isDisabled={pending} />}
      </HStack>
    </VStack>
  );
}

function DrawerBody({ person, people, onClose, onChanged }: { person: OfficePerson; people: OfficePerson[]; onClose: () => void; onChanged: () => void }) {
  const { config } = useConfig();
  // What they said in the office this session, when the team talks with AI.
  const talks = talksOf(useTalkLog(), person.id, Date.now());
  const lead = config.team.pointer.name || "Pointer";
  const agent = person.kind === "agent" ? config.team.agents.find((a) => a.id === person.id) : undefined;
  const tasks = useTasks();
  const all = tasks.data ?? [];
  const current = person.task ? all.find((t) => t.id === person.task!.id) : undefined;
  const recent = tasksOf(all, person, agent)
    .filter((t) => t.id !== person.task?.id)
    .slice(0, RECENT);
  const [changingFace, setChangingFace] = useState(false);
  const info = STATE_INFO[person.state];
  const description =
    person.kind === "lead"
      ? `Leads every conversation in Slack and Chat. For repo tasks ${lead} plans the work, hands each part to the agent whose “When to use” line fits, and checks the results before the pull request opens.`
      : agent?.description;

  return (
    <Layout
      header={<DrawerHeader title={person.name} subtitle={`${person.role} · ${info.label}`} onOpenChange={(open) => !open && onClose()} />}
      content={
        <LayoutContent>
          <VStack gap={6}>
            <HStack gap={4} vAlign="center">
              <Face seed={person.avatar} name={person.name} state={person.state} size={96} hasTooltip={false} />
              <StackItem size="fill">
                <VStack gap={1}>
                  <Heading level={2}>{nameTag(person)}</Heading>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Badge label={info.label} variant={info.badge} />
                    {person.since && (
                      <Text type="supporting" color="secondary">
                        {person.state === "free" ? "Last worked" : "Since"} <Timestamp value={person.since} format="relative" isLive />
                      </Text>
                    )}
                  </HStack>
                  {person.doing && <Text>{person.doing}</Text>}
                </VStack>
              </StackItem>
            </HStack>

            {description && (
              <Part title={person.kind === "lead" ? `What ${lead} does` : `When ${lead} uses them`}>
                <Text>{description}</Text>
              </Part>
            )}

            <MetadataList>
              {agent && (
                <MetadataListItem label="Access">
                  <Text>
                    {ACCESS_INFO[agent.access].label}: {ACCESS_INFO[agent.access].summary}
                  </Text>
                </MetadataListItem>
              )}
              {agent && agent.engine !== "claude" && (
                <MetadataListItem label="Engine">
                  <Text>
                    Works through {ENGINE_NAME[agent.engine]}
                    {engineReady(config, agent.engine) ? "" : " (not connected: works as Claude)"}
                  </Text>
                </MetadataListItem>
              )}
              {modelLines(person, agent, config).map((m) => (
                <MetadataListItem key={m.label} label={m.label}>
                  <Text>{m.value}</Text>
                </MetadataListItem>
              ))}
              {agent && (
                <MetadataListItem label="Skills">
                  {agent.skills.length ? (
                    <HStack gap={1} wrap="wrap">
                      {agent.skills.map((s) => (
                        <Token key={s} label={s} size="sm" />
                      ))}
                    </HStack>
                  ) : (
                    <Text color="secondary">
                      None yet. <Link href={href("skills")}>Browse the skills library</Link>
                    </Text>
                  )}
                </MetadataListItem>
              )}
              <MetadataListItem label="Today">
                <Text>
                  {person.today.tasks} task{person.today.tasks === 1 ? "" : "s"} · {minutesText(person.today.minutes)}
                </Text>
              </MetadataListItem>
            </MetadataList>

            <Divider />
            <Part title="Working on now">
              {person.state === "thinking" && person.conversation && (
                <Text>
                  Answering <Link href={href("chat", person.conversation.id)}>{person.conversation.title}</Link> in Chat.
                </Text>
              )}
              {person.task ? (
                current ? (
                  <TaskCard task={current} />
                ) : tasks.data === undefined ? (
                  <Spinner size="sm" label="Loading the task" />
                ) : (
                  <Link href={taskHref(person.task)}>
                    {person.task.repo} · {person.task.title}
                  </Link>
                )
              ) : person.state !== "thinking" ? (
                <Text color="secondary">Nothing right now: {person.name} is free for work.</Text>
              ) : null}
            </Part>

            <Part title="Recent tasks">
              {tasks.data === undefined ? (
                <Spinner size="sm" label="Loading recent tasks" />
              ) : recent.length ? (
                <List density="compact" edge="flush">
                  {recent.map((t) => {
                    const status = taskStatus(t);
                    return (
                      <ListItem
                        key={t.id}
                        label={t.report?.title || t.ticket?.name || headline(t.instruction, 80)}
                        description={
                          <>
                            {t.repo} · <Timestamp value={t.createdAt} format="relative" />
                          </>
                        }
                        endContent={<Badge label={status.label} variant={status.tone} />}
                        href={taskHref({ id: t.id, conversationId: t.channel === "web" ? t.threadTs : undefined })}
                      />
                    );
                  })}
                </List>
              ) : (
                <Text color="secondary">No recent tasks{person.kind === "agent" ? ` with ${person.name}` : ""}.</Text>
              )}
            </Part>

            {talks.length > 0 && (
              <>
                <Divider />
                <Part title="Said in the office">
                  <TalkLog talks={talks} personId={person.id} people={people} />
                </Part>
              </>
            )}

            <Divider />
            <Part title={`Ask ${lead} for work`}>
              <AskComposer
                key={person.id}
                lead={lead}
                initial={person.kind === "lead" ? "" : `Ask ${person.name} to `}
                label={`Message to ${lead} about ${person.name}`}
                placeholder={person.kind === "lead" ? `Ask ${lead} for anything…` : `Ask ${person.name} to …`}
                onSent={onChanged}
              />
              <Text type="supporting" color="secondary">
                {lead} reads it, picks who does the work and replies in Chat.
              </Text>
            </Part>

            {agent && (
              <>
                <Divider />
                <Part
                  title="Face"
                  end={!changingFace ? <Button label="Change face" size="sm" variant="secondary" onClick={() => setChangingFace(true)} /> : <Button label="Done" size="sm" variant="ghost" onClick={() => setChangingFace(false)} />}>
                  {changingFace ? (
                    <FacePicker person={person} agent={agent} onChanged={onChanged} />
                  ) : (
                    <Text type="supporting" color="secondary">
                      Faces are drawn from a seed (Notionists by DiceBear, CC0). Pick another one if this one does not fit.
                    </Text>
                  )}
                </Part>
              </>
            )}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} hAlign="end" wrap="wrap">
            {person.task && (
              <Button
                label={person.task.conversationId ? "Follow in Chat" : "Follow in Activity"}
                variant="secondary"
                icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />}
                href={taskHref(person.task)}
              />
            )}
            <Button
              label={person.kind === "lead" ? `${lead}'s settings` : "Edit on the Team page"}
              variant="primary"
              icon={<Icon icon={PencilSquareIcon} size="sm" />}
              href={person.kind === "lead" ? href("team") : href("team", "agent", person.id)}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

export interface PersonDrawerProps {
  /** Kept while the drawer animates out. */
  person: OfficePerson | undefined;
  isOpen: boolean;
  onClose: () => void;
  /** Something changed (a face, a new conversation): re-read the office now. */
  onChanged: () => void;
  /** Everyone in the office, for the names and faces of who they talked with. */
  people?: OfficePerson[];
}

/** A person's details: what they do and when, their settings, current and recent work, what they said in the office, and asking Pointer for work. */
export function PersonDrawer({ person, isOpen, onClose, onChanged, people = [] }: PersonDrawerProps) {
  return (
    <Drawer isOpen={isOpen} onOpenChange={(open) => !open && onClose()} label={person ? `${person.name}, ${person.role}` : "Person"} width={520} experimental={{ isFullWidthOnMobile: true }}>
      {person && <DrawerBody key={person.id} person={person} people={people} onClose={onClose} onChanged={onChanged} />}
    </Drawer>
  );
}
