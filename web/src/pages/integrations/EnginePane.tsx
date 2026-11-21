/**
 * The Codex and Gemini CLI panes: connect the engine's API key and pick its
 * model (from the vendor's live list, GET /api/engines/:id/models), the
 * agents that work through it with the model each runs, adding another on a
 * model of its own, whether it may run without a sandbox, and what it costs
 * and may do. One pane, filled in from each engine's ENGINE_INFO.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ModelPicker } from "../../components/ModelPicker";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { ENGINE_NAME, type EngineId } from "../../lib/engines";
import { forgetModelLists } from "../../lib/models";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { AgentSpec } from "../../lib/types";
import { MAX_AGENTS, engineModelSpecials } from "../team/team";
import type { IntegrationSummary } from "./catalog";
import { FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";

type Props = { summary: IntegrationSummary; onBack?: () => void };

interface EngineInfo {
  id: EngineId;
  /** Whose CLI it is and who bills its use. */
  vendor: string;
  description: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyDescription: string;
  steps: ReactNode[];
  modelDescription: string;
  /** The team member POST /api/engines/:id/agent adds. */
  memberName: string;
  /** Where its commands run, and when it needs "Run without a sandbox". */
  sandbox: string;
  /** What the switch being off means for it. */
  offMeans: string;
}

const ENGINE_INFO: Record<EngineId, EngineInfo> = {
  codex: {
    id: "codex",
    vendor: "OpenAI",
    description:
      "OpenAI's coding agent as a team member: agents set to Codex hand their repo-task work to the Codex CLI, which runs headless in the task's checkout, and report back.",
    keyLabel: "OpenAI API key",
    keyPlaceholder: "sk-…",
    keyDescription: "From the OpenAI Platform, under API keys.",
    steps: [
      <>
        Open{" "}
        <Link href="https://platform.openai.com/api-keys" isExternalLink>
          API keys
        </Link>{" "}
        on the OpenAI Platform and choose <Strong>Create new secret key</Strong>. A project of its own with a monthly budget keeps Codex's spend apart.
      </>,
      <>Use an API key: signing in with ChatGPT is not allowed for a hosted service like this one.</>,
      <>Paste it below. It is checked with OpenAI, stored encrypted and never shown again.</>,
    ],
    modelDescription: "The OpenAI model Codex runs for agents without a model of their own. Empty: Codex's default.",
    memberName: "Codex",
    sandbox:
      "Codex runs its commands in its own sandbox when the task container allows it (each task checks). Where its sandbox does not work, it runs only if you allow it below.",
    offMeans: "Off: where its sandbox does not work, agents set to Codex work as Claude in that task.",
  },
  gemini: {
    id: "gemini",
    vendor: "Google",
    description:
      "Google's coding agent as a team member: agents set to Gemini CLI hand their repo-task work to it, running headless in the task's checkout, and report back.",
    keyLabel: "Gemini API key",
    keyPlaceholder: "AIza…",
    keyDescription: "From Google AI Studio, under Get API key.",
    steps: [
      <>
        Open{" "}
        <Link href="https://aistudio.google.com/apikey" isExternalLink>
          API keys
        </Link>{" "}
        in Google AI Studio and create a key in a Google Cloud project with billing turned on.
      </>,
      <>Use a paid key: Google moved its free consumer users to Antigravity CLI, and Gemini CLI stays available with paid Gemini API keys.</>,
      <>Paste it below. It is checked with Google, stored encrypted and never shown again.</>,
    ],
    modelDescription: "The Gemini model the CLI runs for agents without a model of their own. Empty: the CLI's default, which picks a model for each request.",
    memberName: "Gemini",
    sandbox: "Gemini CLI has no sandbox here, so it runs only if you allow it below.",
    offMeans: "Off: Gemini CLI never runs, and agents set to it work as Claude.",
  },
};

export function CodexPane(props: Props) {
  return <EnginePane info={ENGINE_INFO.codex} {...props} />;
}

export function GeminiPane(props: Props) {
  return <EnginePane info={ENGINE_INFO.gemini} {...props} />;
}

function EnginePane({ info, summary, onBack }: Props & { info: EngineInfo }) {
  const { config } = useConfig();
  const engine = config.engines[info.id];
  const agents = config.team.agents.filter((a) => a.engine === info.id);

  return (
    <VStack gap={6}>
      <PaneHeader icon={CommandLineIcon} title={summary.name} tone={summary.tone} status={summary.status} description={info.description} onBack={onBack} />

      {engine.connected && (
        <MetadataList>
          <MetadataListItem label="API key">
            <Text>{engine.key ?? "Saved"}</Text>
          </MetadataListItem>
          <MetadataListItem label="Model">
            <Text>{engine.model || "The CLI's default"}</Text>
          </MetadataListItem>
          {engine.checkedAt && (
            <MetadataListItem label="Checked">
              <Timestamp value={engine.checkedAt} format="relative" />
            </MetadataListItem>
          )}
          <MetadataListItem label="Agents">
            <Text>{agents.length ? agents.map((a) => a.name).join(", ") : "No agent yet"}</Text>
          </MetadataListItem>
          <MetadataListItem label="Without a sandbox">
            <Text>{engine.allowUnsandboxed ? "Allowed" : "Not allowed"}</Text>
          </MetadataListItem>
        </MetadataList>
      )}

      <EngineKey info={info} />
      <EngineMembers info={info} agents={agents} />

      <PaneSection title="Cost">
        <List listStyle="disc" density="compact">
          <ListItem label={<Text>{info.vendor} bills its use on this key. It is not counted in the Claude spend caps or the per-task budget.</Text>} />
          <ListItem label={<Text>Each run's token counts show in the task's timeline. Set a spending limit on the key with {info.vendor}.</Text>} />
        </List>
      </PaneSection>

      <EngineSandbox info={info} />
    </VStack>
  );
}

/** Whether the CLI may run without a sandbox (off by default), what that gives up, and the rest of what keeps it in bounds. */
function EngineSandbox({ info }: { info: EngineInfo }) {
  const { config } = useConfig();
  const engine = config.engines[info.id];
  const name = ENGINE_NAME[info.id];
  const pointer = config.team.pointer.name;
  const { save, pending, error } = useSave();

  const set = async (on: boolean) => {
    await save(() => api.post(`/api/engines/${info.id}`, { allowUnsandboxed: on }), {
      success: on ? `${name} may run without a sandbox.` : `${name} no longer runs without a sandbox.`,
    });
  };

  return (
    <PaneSection title="Sandbox and safety" description={info.sandbox}>
      <Switch
        label="Run without a sandbox (the task container is the only boundary: it can read the worker's environment, including platform secrets)"
        description={info.offMeans}
        value={engine.allowUnsandboxed}
        isLoading={pending}
        isDisabled={!engine.connected}
        disabledMessage={`Connect ${name} first.`}
        changeAction={set}
      />
      <FormError message={error} />
      {info.id === "gemini" && engine.connected && !engine.allowUnsandboxed && (
        <Banner
          status="warning"
          title="Gemini CLI does not run yet"
          description="It has no sandbox here, so agents set to it work as Claude until you allow it to run without one."
          collapsible={false}
        />
      )}
      <Text>
        Without a sandbox, {name}'s commands run as the task worker's own user, outside {pointer}'s shell guard. A repository, or anything it reads, could steer them into
        reading and sending out:
      </Text>
      <List listStyle="disc" density="compact">
        <ListItem
          label={
            <Text>
              the environment of the worker and of the Claude agents: the master key when it is set as a variable, the AI provider key the team runs on, and the
              repository's setup variables;
            </Text>
          }
        />
        <ListItem label={<Text>the AI provider's credential files for the task;</Text>} />
        <ListItem label={<Text>the cloud metadata server, and with it the worker's service account.</Text>} />
      </List>
      <Text color="secondary">Allow it only for repositories and keys you trust, and give this deployment its own cloud project.</Text>
      <List listStyle="disc" density="compact">
        <ListItem label={<Text>{name}'s own environment holds only its key; the platform never passes it other secrets.</Text>} />
        <ListItem label={<Text>An agent with “Looks only” access runs it read-only.</Text>} />
        <ListItem label={<Text>The platform, not {name}, commits and publishes, and the worker's git safeguards still apply.</Text>} />
      </List>
    </PaneSection>
  );
}

/** The key and the model: a new key is checked with the vendor; with the key left empty, only the model is saved. */
function EngineKey({ info }: { info: EngineInfo }) {
  const { config } = useConfig();
  const engine = config.engines[info.id];
  const name = ENGINE_NAME[info.id];
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(engine.model);
  const { save, error, edit } = useSave();
  const key = apiKey.trim();
  const modelOnly = engine.connected && !key;

  const submit = async () => {
    const invalid = !key
      ? engine.connected
        ? model.trim() === engine.model
          ? `Nothing to save: paste a new key or change the model.`
          : undefined
        : `Paste your ${info.keyLabel}.`
      : key.length < 20 || /\s/.test(key)
        ? `That doesn't look like a valid ${info.keyLabel}.`
        : undefined;
    const ok = await save(() => api.post(`/api/engines/${info.id}`, { ...(key ? { apiKey: key } : {}), model: model.trim() }), {
      invalid,
      success: key ? `${name} connected: the key was verified with ${info.vendor}.` : "Model saved.",
    });
    if (ok) {
      setApiKey("");
      // A new key can see other models.
      if (key) forgetModelLists();
    }
  };

  return (
    <PaneSection
      title={engine.connected ? "Key and model" : `Connect ${name}`}
      description={`Agents set to ${name} use this key in repo tasks. Billing goes to the key's ${info.vendor} account.`}>
      {!engine.connected && <Steps label="To get a key" steps={info.steps} />}
      <FormLayout>
        <SecretField
          label={info.keyLabel}
          value={apiKey}
          onChange={edit(setApiKey)}
          saved={engine.key}
          placeholder={engine.connected ? undefined : info.keyPlaceholder}
          description={info.keyDescription}
          isRequired
        />
        <ModelPicker
          label="Model"
          source={{ kind: "engine", id: info.id }}
          value={model}
          onChange={edit(setModel)}
          specials={[{ value: "", label: "The CLI's default", description: `${name} picks its own model` }]}
          description={info.modelDescription}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={modelOnly ? "Save model" : engine.connected ? "Verify and replace" : "Verify and save"} variant="primary" clickAction={submit} />
        {engine.connected && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Click again to disconnect"
            size="md"
            onConfirm={async () => {
              await save(() => api.post(`/api/engines/${info.id}/disconnect`, {}), {
                success: `${name} disconnected. Agents set to it work as Claude agents until it is connected again.`,
              });
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** The agents that work through this engine, each with the model it runs, and another to add, on a model of its own if wanted. */
function EngineMembers({ info, agents }: { info: EngineInfo; agents: AgentSpec[] }) {
  const { config } = useConfig();
  const engine = config.engines[info.id];
  const connected = engine.connected;
  const name = ENGINE_NAME[info.id];
  const [engineModel, setEngineModel] = useState("");
  const { save, error, edit } = useSave();
  const full = config.team.agents.length >= MAX_AGENTS;
  const engineDefault = engine.model ? `${engine.model} (the engine's model)` : "the CLI's default model";

  const add = async () => {
    const ok = await save(() => api.post<{ ok: true; agent: AgentSpec }>(`/api/engines/${info.id}/agent`, engineModel ? { engineModel } : {}), {
      success: (r) => `${r.agent.name} joined the team as ${r.agent.role}${r.agent.engineModel ? `, on ${r.agent.engineModel}` : ""}.`,
    });
    if (ok) setEngineModel("");
  };

  return (
    <PaneSection
      title="On the team"
      description={`An agent set to ${name} hands its assignment to ${name} and checks what it did. Add as many as you like, each on a model of its own, or set any agent's Engine on the Team page.`}>
      {agents.length > 0 && (
        <List density="compact" edge="flush">
          {agents.map((a) => (
            <ListItem
              key={a.id}
              label={a.name}
              description={`${a.role} · ${a.engineModel || engineDefault}${a.enabled ? "" : " · off"}${connected ? "" : " · works as Claude until connected"}`}
              href={href("team", "agent", a.id)}
            />
          ))}
        </List>
      )}
      {!connected ? (
        <Text color="secondary">Connect {name} first.</Text>
      ) : (
        <FormLayout>
          <ModelPicker
            label={agents.length ? `Model for another ${info.memberName} agent` : `Model for ${info.memberName}`}
            source={{ kind: "engine", id: info.id }}
            value={engineModel}
            onChange={edit(setEngineModel)}
            specials={engineModelSpecials(name, engine.model)}
            description={`A coder that works through ${name}, named ${agents.length ? `“${info.memberName} ${agents.length + 1}” or the next free name` : `“${info.memberName}”`}. Rename it on the Team page.`}
            isOptional
          />
        </FormLayout>
      )}
      <FormActions>
        <Button
          label={agents.length ? `Add another ${info.memberName} agent` : `Add ${info.memberName} to the team`}
          variant="secondary"
          clickAction={add}
          isDisabled={!connected || full}
          tooltip={full ? `A team can have at most ${MAX_AGENTS} agents.` : undefined}
        />
        <Link href={href("team")} isStandalone>
          Team page
        </Link>
      </FormActions>
      <FormError message={error} />
    </PaneSection>
  );
}
