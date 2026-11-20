/**
 * The Codex and Gemini CLI panes: connect the engine's API key and pick its
 * model, add a ready-made team member that works through it, and what it
 * costs and may do. One pane, filled in from each engine's ENGINE_INFO.
 */
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { ENGINE_NAME, type EngineId } from "../../lib/engines";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { AgentSpec } from "../../lib/types";
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
  sandbox: string;
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
    modelDescription: "An OpenAI model Codex supports. Leave it empty for Codex's default.",
    memberName: "Codex",
    sandbox:
      "Codex runs commands in its own sandbox when the task container allows it; where it cannot, the task container is the boundary. The platform, not Codex, commits and publishes.",
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
    modelDescription: "A Gemini model id. Leave it empty for the CLI's default, which picks a model for each request.",
    memberName: "Gemini",
    sandbox: "Gemini CLI has no sandbox here: the task container is the boundary.",
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

      <PaneSection title="Sandbox and safety">
        <List listStyle="disc" density="compact">
          <ListItem label={<Text>{info.sandbox}</Text>} />
          <ListItem
            label={
              <Text>
                It runs commands outside {config.team.pointer.name}'s shell guard, with its own key in its environment and none of the platform's other secrets.
              </Text>
            }
          />
          <ListItem label={<Text>An agent with “Looks only” access runs it read-only.</Text>} />
          <ListItem label={<Text>The worker's git safeguards still apply when it publishes the branch.</Text>} />
        </List>
      </PaneSection>
    </VStack>
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
    if (ok) setApiKey("");
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
        <TextInput label="Model" value={model} onChange={edit(setModel)} placeholder="The CLI's default" description={info.modelDescription} isOptional />
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

/** The agents that work through this engine, or a ready-made one to add. */
function EngineMembers({ info, agents }: { info: EngineInfo; agents: AgentSpec[] }) {
  const { config } = useConfig();
  const connected = config.engines[info.id].connected;
  const name = ENGINE_NAME[info.id];
  const { save, error } = useSave();

  const add = async () => {
    await save(() => api.post<{ ok: true; agent: AgentSpec }>(`/api/engines/${info.id}/agent`, {}), {
      success: (r) => `${r.agent.name} joined the team as ${r.agent.role}.`,
    });
  };

  return (
    <PaneSection
      title="On the team"
      description={`An agent set to ${name} hands its assignment to ${name} and checks what it did. Any agent can work through it: set its Engine on the Team page.`}>
      {agents.length > 0 ? (
        <List density="compact" edge="flush">
          {agents.map((a) => (
            <ListItem
              key={a.id}
              label={a.name}
              description={`${a.role}${a.enabled ? "" : " · off"}${connected ? "" : " · works as Claude until connected"}`}
              href={href("team", "agent", a.id)}
            />
          ))}
        </List>
      ) : (
        <>
          <Text color="secondary">
            {connected ? `Add ${info.memberName}, a coder that works through ${name}, or switch an agent you have.` : `Connect ${name} first.`}
          </Text>
          <FormActions>
            <Button label={`Add ${info.memberName} to the team`} variant="secondary" clickAction={add} isDisabled={!connected} />
            <Link href={href("team")} isStandalone>
              Team page
            </Link>
          </FormActions>
          <FormError message={error} />
        </>
      )}
    </PaneSection>
  );
}
