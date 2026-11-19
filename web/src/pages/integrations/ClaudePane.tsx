import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { IntegrationSummary } from "./catalog";
import { FormActions, FormError, PaneHeader, PaneSection, useSave } from "./parts";

/** The models offered elsewhere on the console; a stored value outside the list is kept as its own option. */
const MODELS = [
  { value: "", label: "Default", description: "The Agent SDK's default model" },
  { value: "claude-opus-5-5", label: "Opus 5.5", description: "claude-opus-5-5 · the most capable" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "claude-sonnet-5-5 · half the cost of Opus" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", description: "claude-haiku-5-5 · the cheapest, for simple work" },
];

export function ClaudePane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const { anthropic, limits } = config;
  const name = config.team.pointer.name;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(anthropic.model);
  const { save, error, edit } = useSave();

  const options = MODELS.some((m) => m.value === anthropic.model) ? MODELS : [...MODELS, { value: anthropic.model, label: anthropic.model, description: "Saved model" }];
  const modelLabel = options.find((m) => m.value === anthropic.model)?.label ?? anthropic.model;

  const submit = async () => {
    const key = apiKey.trim();
    const invalid = !key
      ? anthropic.connected
        ? "Paste the API key again: every save checks the key with Anthropic, also when only the model changes."
        : "Paste an Anthropic API key."
      : key.length < 10
        ? "That is too short to be an Anthropic API key."
        : undefined;
    const ok = await save(() => api.post("/api/anthropic", { apiKey: key, model }), { invalid, success: "Key verified and saved." });
    if (ok) setApiKey("");
  };

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={SparklesIcon}
        title="Claude"
        tone={summary.tone}
        status={summary.status}
        description={`${name} and every agent on the team think with your Anthropic API key. Without it nothing runs.`}
        onBack={onBack}
      />

      {anthropic.connected && (
        <MetadataList>
          <MetadataListItem label="API key">
            <Text>{anthropic.key ?? "Saved"}</Text>
          </MetadataListItem>
          <MetadataListItem label="Model">
            <Text>{modelLabel}</Text>
          </MetadataListItem>
        </MetadataList>
      )}

      <PaneSection
        title={anthropic.connected ? "Replace the key or model" : "Connect Claude"}
        description="The key is checked with Anthropic before it is saved, stored encrypted and never shown again.">
        <FormLayout>
          <SecretField
            label="Anthropic API key"
            value={apiKey}
            onChange={edit(setApiKey)}
            saved={anthropic.key}
            placeholder={anthropic.connected ? "Paste the key to save changes" : "sk-ant-…"}
            description="From the Anthropic Console, under API keys."
            isRequired
          />
          <Selector
            label="Model"
            options={options}
            value={model}
            onChange={edit(setModel)}
            description={`For repo tasks, and for ${name}'s replies when the Team page sets no chat model.`}
            isOptional
          />
        </FormLayout>
        <FormError message={error} />
        <FormActions>
          <Button label={anthropic.connected ? "Verify and replace" : "Verify and save"} variant="primary" clickAction={submit} />
        </FormActions>
      </PaneSection>

      <PaneSection title="Tips">
        <List listStyle="disc" density="compact">
          <ListItem
            label={<Text>Create a key just for {name}, so its spend shows on its own and you can revoke it without breaking anything else.</Text>}
          />
          <ListItem
            label={
              <Text>
                Set a monthly spend limit on that key's workspace in the{" "}
                <Link href="https://console.anthropic.com/settings/keys" isExternalLink>
                  Anthropic Console
                </Link>
                .
              </Text>
            }
          />
          <ListItem label={<Text>Each repo task also stops at its own budget, now {usd(limits.maxBudgetUsd)} per task.</Text>} />
        </List>
      </PaneSection>
    </VStack>
  );
}
