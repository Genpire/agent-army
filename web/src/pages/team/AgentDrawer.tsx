import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useMemo, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ModelPicker } from "../../components/ModelPicker";
import { type AgentEngine, ENGINE_DESCRIPTION, ENGINE_NAME, type EngineId, isAgentEngine } from "../../lib/engines";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { ACCESS_OPTIONS, type AgentSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { useSkillLibrary } from "../skills/useSkillLibrary";
import { ACCESS_ICON } from "./AccessToken";
import { AgentBudgetField, useAgentBudget } from "./AgentBudgetField";
import { AgentEmoji } from "./AgentEmoji";
import { AgentFallbackField } from "./AgentFallbackField";
import { EngineModelField } from "./EngineModelField";
import {
  ACCESS_INFO,
  AGENT_EFFORT_SELECT_OPTIONS,
  type AgentTarget,
  CLAUDE_CHOICES,
  type ModelChoices,
  accessDescription,
  type AgentDraft,
  NEW_AGENT,
  agentErrors,
  agentModelSpecials,
  fallbackHint,
  fieldStatus,
  hasErrors,
  isAccess,
  isEffort,
  targetAgentId,
  toSpec,
} from "./team";

export type { AgentTarget } from "./team";

const targetTitle = (target: AgentTarget | undefined) =>
  target?.kind === "edit" ? `Edit ${target.agent.name}` : target?.kind === "builtin" ? `Add ${target.agent.name}` : "New agent";

export interface AgentDrawerProps {
  isOpen: boolean;
  /** Kept while the drawer animates out, so its content does not vanish mid-exit. */
  target: AgentTarget | undefined;
  /** Every agent's id, for a new agent's id to be unique. */
  takenIds: ReadonlySet<string>;
  /** Pointer's name, as the owner set it. */
  lead: string;
  /** The repo task provider's models for the model picker; Claude's when absent. */
  models?: ModelChoices;
  onClose: () => void;
  /** Saves the agent (added or replaced by id); throws the server's error. */
  onSave: (spec: AgentSpec, isNew: boolean) => Promise<void>;
  onDelete: (agent: AgentSpec) => Promise<void>;
}

/** The agent editor: DrawerForm (header, scrolling fields, pinned Cancel and Save). */
export function AgentDrawer({ isOpen, target, takenIds, lead, models, onClose, onSave, onDelete }: AgentDrawerProps) {
  const title = targetTitle(target);
  return (
    <Drawer
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      label={title}
      purpose="form"
      width={600}
      // A form this long needs the whole width of a phone.
      experimental={{ isFullWidthOnMobile: true }}>
      {target && (
        <AgentForm
          key={target.kind === "new" ? "new" : `${target.kind}:${target.agent.id}`}
          target={target}
          takenIds={takenIds}
          lead={lead}
          models={models}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />
      )}
    </Drawer>
  );
}

function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        {description && <Text type="supporting">{description}</Text>}
      </VStack>
      {children}
    </VStack>
  );
}

/**
 * The library's skills this agent has. Skills given to every agent are shown,
 * not picked: they are changed on the Skills page.
 */
function SkillsField({ value, onChange, lead }: { value: string[]; onChange: (skills: string[]) => void; lead: string }) {
  const library = useSkillLibrary();
  const skills = library.data?.skills ?? [];
  const forEveryone = skills.filter((s) => s.assignedTo === "all").map((s) => s.name);
  const pickable = skills.filter((s) => s.assignedTo !== "all");
  const installed = new Set(pickable.map((s) => s.name));
  const manage = (
    <Link href={href("skills")} isStandalone>
      Skills page
    </Link>
  );

  if (library.error) return <Text color="secondary">Couldn't load the skills library: {library.error}</Text>;
  if (library.data && skills.length === 0) {
    return (
      <Text type="supporting">
        No skills are installed yet. Add or find some on the {manage}; {lead} and the agents use them once they are installed.
      </Text>
    );
  }
  return (
    <VStack gap={2}>
      {(!library.data || pickable.length > 0) && (
        <MultiSelector
          label="Skills"
          isLabelHidden
          placeholder="Pick skills"
          options={pickable.map((s) => ({ value: s.name, label: s.name }))}
          value={value.filter((name) => installed.has(name))}
          onChange={onChange}
          triggerDisplay="badges"
          hasSearch={pickable.length > 12}
          isLoading={!library.data}
          isDisabled={!library.data}
          width="100%"
        />
      )}
      <Text type="supporting">
        {forEveryone.length ? `Every agent also has ${forEveryone.join(", ")}. ` : ""}
        Install skills and choose who uses them on the {manage}.
      </Text>
    </VStack>
  );
}

/** Claude, or a connected coding agent CLI. A CLI that is not connected is offered only when the agent is already set to it. */
function EngineField({ value, onChange }: { value: AgentEngine; onChange: (engine: AgentEngine) => void }) {
  const { config } = useConfig();
  const cli = (id: EngineId, what: string) => {
    const connected = config.engines[id].connected;
    return {
      value: id,
      label: ENGINE_NAME[id],
      description: connected ? what : value === id ? "Not connected: works as Claude until it is" : "Not connected: connect it on Integrations",
      disabled: !connected && value !== id,
    };
  };
  const options = [
    { value: "claude", label: ENGINE_NAME.claude, description: ENGINE_DESCRIPTION.claude },
    cli("codex", ENGINE_DESCRIPTION.codex),
    cli("gemini", ENGINE_DESCRIPTION.gemini),
  ];
  const missing = (["codex", "gemini"] as const).filter((id) => !config.engines[id].connected).map((id) => ENGINE_NAME[id]);
  return (
    <VStack gap={2}>
      <Selector label="Engine" isLabelHidden options={options} value={value} onChange={(v) => isAgentEngine(v) && onChange(v)} width="100%" />
      {missing.length > 0 && (
        <Text type="supporting">
          Connect {missing.join(" or ")} on the{" "}
          <Link href={href("integrations")} isStandalone>
            Integrations page
          </Link>
          .
        </Text>
      )}
    </VStack>
  );
}

/** The connected apps (Integrations, Apps) this agent may use. Apps that are off are listed but marked. */
function AppsField({ value, onChange, lead }: { value: string[]; onChange: (apps: string[]) => void; lead: string }) {
  const { config } = useConfig();
  const apps = config.apps;
  const connected = new Set(apps.map((a) => a.id));
  const manage = (
    <Link href={href("integrations", "apps")} isStandalone>
      Integrations page
    </Link>
  );
  if (apps.length === 0) {
    return <Text type="supporting">No apps are connected yet. Connect Linear, Notion, Sentry and others on the {manage}; {lead} uses them, and the agents you choose.</Text>;
  }
  return (
    <VStack gap={2}>
      <MultiSelector
        label="Apps"
        isLabelHidden
        placeholder="Pick apps"
        options={apps.map((a) => ({ value: a.id, label: a.enabled ? a.name : `${a.name} (off)` }))}
        value={value.filter((id) => connected.has(id))}
        onChange={onChange}
        triggerDisplay="badges"
        hasSearch={apps.length > 12}
        width="100%"
      />
      <Text type="supporting">
        An agent that only looks gets an app's read-only tools. Choose each app's tools and what it may do on the {manage}.
      </Text>
    </VStack>
  );
}

function AgentForm({ target, takenIds, lead, models = CLAUDE_CHOICES, onClose, onSave, onDelete }: Omit<AgentDrawerProps, "isOpen" | "target"> & { target: AgentTarget }) {
  const existing = target.kind === "edit" ? target.agent : undefined;
  const builtin = target.kind === "builtin" ? target.agent : undefined;
  const [draft, setDraft] = useState<AgentDraft>(() => ({ ...(existing ?? builtin ?? NEW_AGENT) }));
  const [triedSave, setTriedSave] = useState(false);
  const budget = useAgentBudget(existing?.id);
  const { run, pending } = useAction();
  const del = useAction();

  const set = <K extends keyof AgentDraft>(key: K) => (value: AgentDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const errors = useMemo(() => agentErrors(draft), [draft]);
  const others = useMemo(() => new Set([...takenIds].filter((id) => id !== existing?.id)), [takenIds, existing]);
  // A built-in agent keeps its own id: the page offers it only while no agent has that id.
  const id = targetAgentId(target, draft.name, others);
  const status = (key: keyof AgentDraft) => fieldStatus(errors[key], triedSave);

  const idNote = existing
    ? `Its id, ${existing.id}, stays the same when you rename it.`
    : builtin
      ? `Its id will be ${builtin.id}, the built-in agent's, whatever you name it.`
      : draft.name.trim()
      ? `Its id will be ${id}, made from the name and fixed once saved.`
      : "The id is made from the name and never changes.";

  const save = async () => {
    setTriedSave(true);
    if (hasErrors(errors)) return;
    // The agent first: a new one must be on the team before it can have a cap.
    const ok = await run(() => onSave(toSpec(id, draft), !existing).then(() => budget.save(id)), { success: existing ? `${draft.name.trim()} saved.` : `${draft.name.trim()} added.` });
    if (ok) onClose();
  };

  return (
    <Layout
      header={
        <DrawerHeader
          title={targetTitle(target)}
          subtitle={
            existing
              ? `${existing.role} · ${ACCESS_INFO[existing.access].label}`
              : builtin
                ? "A built-in agent, as a fresh deployment has it. Change anything before you add it."
                : `${lead} hands work to it when its “When to use” line fits.`
          }
          onOpenChange={(open) => !open && onClose()}
        />
      }
      content={
        <LayoutContent>
          <VStack gap={6}>
            <FormSection title="Identity">
              <Grid columns={{ minWidth: 200, max: 2 }} gap={4} align="end">
                <TextInput
                  label="Name"
                  value={draft.name}
                  onChange={set("name")}
                  placeholder="Sara"
                  description={idNote}
                  status={status("name")}
                  isRequired
                  hasAutoFocus={!existing}
                />
                <TextInput label="Role" value={draft.role} onChange={set("role")} placeholder="Designer" description="Shown with the name in Slack." status={status("role")} isRequired />
              </Grid>
              <HStack gap={3} vAlign="end">
                <AgentEmoji emoji={draft.emoji} name={draft.name} />
                <TextInput
                  label="Emoji"
                  value={draft.emoji}
                  onChange={set("emoji")}
                  placeholder=":art:"
                  description="A Slack emoji code, shown next to the agent's progress lines in Slack."
                  status={status("emoji")}
                  width="100%"
                />
              </HStack>
            </FormSection>

            <Divider />
            <FormSection title={`When should ${lead} use this agent?`} description={`${lead} reads this to decide when to hand work to this agent.`}>
              <TextArea
                label={`When should ${lead} use this agent?`}
                isLabelHidden
                value={draft.description}
                onChange={set("description")}
                placeholder="Reviews UI changes for layout, accessibility and visual consistency."
                rows={4}
                maxLength={500}
                status={status("description")}
                isRequired
              />
            </FormSection>

            <Divider />
            <FormSection title="Instructions" description="The agent's own prompt. Platform ground rules (no pushing, no secrets, confirm the problem first, prove new tests fail without the change, report real output) are added automatically.">
              <TextArea
                label="Instructions"
                isLabelHidden
                value={draft.instructions}
                onChange={set("instructions")}
                placeholder="You are the Designer. …"
                rows={10}
                maxLength={8000}
                status={status("instructions")}
                isRequired
              />
            </FormSection>

            <Divider />
            <FormSection title="Access" description="The tools it gets in repo tasks. In Slack conversations every agent can only search the web and read GitHub.">
              <RadioList label="Access" isLabelHidden value={draft.access} onChange={(v) => isAccess(v) && set("access")(v)}>
                {ACCESS_OPTIONS.map((access) => (
                  <RadioListItem
                    key={access}
                    value={access}
                    label={ACCESS_INFO[access].label}
                    description={accessDescription(access)}
                    align="first-line"
                    endContent={<Icon icon={ACCESS_ICON[access]} size="sm" color="secondary" />}
                  />
                ))}
              </RadioList>
            </FormSection>

            <Divider />
            <FormSection title="Engine" description="Who does its work in repo tasks. With Codex or Gemini CLI, the agent hands its assignment to that coding agent, which works in the checkout, and checks what it did. In chat it works like any other agent.">
              {/* Another engine has other models: its model starts over at the engine's own. Its own engine is never its fallback. */}
              <EngineField
                value={draft.engine}
                onChange={(engine) =>
                  setDraft((d) => ({
                    ...d,
                    engine,
                    engineModel: engine === d.engine ? d.engineModel : "",
                    fallback: (d.fallback ?? []).filter((f) => f.engine !== engine),
                  }))
                }
              />
              {draft.engine !== "claude" && <EngineModelField engine={draft.engine} value={draft.engineModel} onChange={set("engineModel")} />}
            </FormSection>

            <Divider />
            <FormSection title={`If ${ENGINE_NAME[draft.engine]} can't do the work`} description={fallbackHint(draft.engine)}>
              <AgentFallbackField engine={draft.engine} value={draft.fallback ?? []} onChange={set("fallback")} />
            </FormSection>

            <Divider />
            <FormSection title="Model and effort">
              <Grid columns={{ minWidth: 200, max: 2 }} gap={4} align="start">
                <ModelPicker
                  label={draft.engine === "claude" ? "Model" : "Claude model"}
                  source={models.source}
                  value={draft.model}
                  onChange={set("model")}
                  specials={agentModelSpecials(lead)}
                  extra={models.extra}
                  modelNotes={models.notes}
                  describeUnknown={models.describe}
                  maxLength={100}
                  description={
                    draft.engine !== "claude"
                      ? `The model of the agent that hands the work to ${ENGINE_NAME[draft.engine]} and checks it.`
                      : models.isClaude
                        ? "Sonnet 5.5 costs half as much as Opus 5.5; Haiku 5.5 is far cheaper for simple lookups."
                        : `Repo tasks run on ${models.name}; a Claude model runs on ${models.name}'s model of the same size.`
                  }
                />
                <Selector
                  label="Effort"
                  options={AGENT_EFFORT_SELECT_OPTIONS}
                  value={draft.effort}
                  onChange={(v) => set("effort")(isEffort(v) ? v : "")}
                  description="How hard it thinks. Higher is slower and uses more credit."
                />
              </Grid>
            </FormSection>

            <Divider />
            <FormSection title="Budget" description="How much it may spend: per month, and in a single repo task. Settings → Spending has every agent's and provider's caps.">
              <AgentBudgetField budget={budget} />
            </FormSection>

            <Divider />
            <FormSection title="Skills" description="Skills from the team's library this agent has loaded when it starts work.">
              <SkillsField value={draft.skills} onChange={set("skills")} lead={lead} />
            </FormSection>

            <Divider />
            <FormSection title="Apps" description="Connected apps this agent may use through their MCP servers: in repo tasks, and to look things up in Slack conversations.">
              <AppsField value={draft.apps} onChange={set("apps")} lead={lead} />
            </FormSection>

            <Divider />
            <Switch
              label="Enabled"
              description={`${lead} can hand work to this agent. Turn it off to keep the agent without using it.`}
              value={draft.enabled}
              onChange={set("enabled")}
              labelPosition="start"
              labelSpacing="spread"
            />
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} hAlign={existing ? "between" : "end"} vAlign="center">
            {existing && (
              <ConfirmButton
                label="Delete"
                confirmLabel="Confirm delete"
                isDisabled={pending}
                onConfirm={async () => {
                  const ok = await del.run(() => onDelete(existing), { success: `${existing.name} deleted.` });
                  if (ok) onClose();
                }}
              />
            )}
            <HStack gap={2}>
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label={existing ? "Save agent" : "Add agent"} variant="primary" isLoading={pending} clickAction={save} />
            </HStack>
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
