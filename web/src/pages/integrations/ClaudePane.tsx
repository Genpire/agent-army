/**
 * The AI model pane (hub row "claude"): which provider chat and repo tasks
 * run on, each provider's connection (its fields, models and what it can
 * do), and the connected ones with their status. The presets and the saved
 * connections come from GET /api/ai/providers (src/routes/ai.ts); secrets are
 * never sent back, only masked. Each tier's model picker lists the
 * provider's models live where it can (GET /api/ai/providers/:id/models).
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { Selector, type SelectorOptionData, type SelectorOptionType } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { CheckCircleIcon, CloudIcon, CpuChipIcon, ServerStackIcon, SparklesIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { BrandLogo } from "../../components/BrandLogo";
import { ConfirmButton } from "../../components/ConfirmButton";
import { ModelPicker } from "../../components/ModelPicker";
import { SecretField } from "../../components/SecretField";
import { capabilityLines, presetModelLabel, providerById, providerStatus, TIER_INFO, tierModels, useAiProviders } from "../../lib/aiProviders";
import { api } from "../../lib/api";
import { timeAgo, usd } from "../../lib/format";
import { forgetModelLists } from "../../lib/models";
import { useConfig } from "../../lib/state";
import { type AiProviderId, type AiProviderView, type AiProvidersView, MODEL_TIER_OPTIONS, type ModelTier, type PresetField } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import type { IntegrationSummary } from "./catalog";
import { FormActions, FormError, type HeroIcon, PaneHeader, PaneSection, StatusLine, useSave } from "./parts";

/** Logo keys Simple Icons has a mark for (lib/logos.ts); the others get an icon. */
const BRAND_LOGOS = new Set(["anthropic", "googlecloud", "deepseek", "qwen", "kimi"]);
const FALLBACK_ICONS: Record<string, HeroIcon> = { bedrock: CloudIcon, foundry: CloudIcon, zai: SparklesIcon, custom: ServerStackIcon };

/** The provider's logo, or an icon for the ones Simple Icons does not carry. */
function ProviderLogo({ provider }: { provider: Pick<AiProviderView, "logo" | "name"> }) {
  if (BRAND_LOGOS.has(provider.logo)) return <BrandLogo id={provider.logo} name={provider.name} size="sm" />;
  return <NavIcon icon={<Icon icon={FALLBACK_ICONS[provider.logo] ?? CpuChipIcon} size="sm" label={provider.name} />} />;
}

export function ClaudePane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const { view, error, reload } = useAiProviders();
  const [selectedId, setSelectedId] = useState<AiProviderId>(config.ai.chatProvider);
  const name = config.team.pointer.name;
  const selected = providerById(view, selectedId);

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={CpuChipIcon}
        title="AI model"
        tone={summary.tone}
        status={summary.status}
        description={`${name} and every agent on the team think with the models of the provider you choose: Claude from Anthropic or a cloud, or another provider's models. Without one nothing runs.`}
        onBack={onBack}
      />
      {error && <Banner status="error" title={error} collapsible={false} />}
      {!view ? (
        !error && <Spinner label="Loading the AI providers" />
      ) : (
        <>
          <InUse view={view} />
          <ConnectedProviders view={view} onEdit={setSelectedId} reload={reload} />
          <PaneSection
            title="Set up a provider"
            description="Pick a provider, fill in what it needs and test it. Every save checks the connection with the provider first; keys are stored encrypted and never shown again.">
            <ProviderPicker view={view} value={selectedId} onChange={setSelectedId} />
            {selected && <ProviderSetup key={selected.id} provider={selected} view={view} reload={reload} />}
          </PaneSection>
          <PaneSection title="Tips">
            <List listStyle="disc" density="compact">
              <ListItem label={<Text>Create a key just for {name}, so its spend shows on its own and you can revoke it without breaking anything else.</Text>} />
              <ListItem label={<Text>Each repo task also stops at its own budget, now {usd(config.limits.maxBudgetUsd)} per task. On other providers the budget uses the prices shown with their models.</Text>} />
              <ListItem label={<Text>Chat and repo tasks can run on different providers: a cheaper one for chat, Claude for code, or the other way round.</Text>} />
            </List>
          </PaneSection>
        </>
      )}
    </VStack>
  );
}

/** What chat and repo tasks run on now. */
function InUse({ view }: { view: AiProvidersView }) {
  const line = (id: AiProviderId) => {
    const p = providerById(view, id);
    if (!p) return <Text>{id}</Text>;
    const ready = p.configured;
    return <StatusLine tone={ready ? "success" : "warning"} text={ready ? p.name : `${p.name}: ${p.problem ?? "not set up"}`} />;
  };
  return (
    <MetadataList>
      <MetadataListItem label="Chat">{line(view.chatProvider)}</MetadataListItem>
      <MetadataListItem label="Repo tasks">{line(view.taskProvider)}</MetadataListItem>
    </MetadataList>
  );
}

/** Every provider with a saved connection: its status, when it last answered, edit and remove. */
function ConnectedProviders({ view, onEdit, reload }: { view: AiProvidersView; onEdit: (id: AiProviderId) => void; reload: () => Promise<void> }) {
  const saved = view.providers.filter((p) => p.saved);
  const { save, error } = useSave();
  if (!saved.length) return null;
  return (
    <PaneSection title="Connected providers" description="A provider in use cannot be removed: move chat and repo tasks to another one first.">
      <List density="compact">
        {saved.map((p) => {
          const status = providerStatus(p);
          const checked = p.saved?.checkedAt ? ` · checked ${timeAgo(p.saved.checkedAt)}` : "";
          return (
            <ListItem
              key={p.id}
              startContent={<ProviderLogo provider={p} />}
              label={<Text weight="semibold">{p.name}</Text>}
              description={<StatusLine tone={status.tone} text={`${status.text}${checked}`} />}
              endContent={
                <HStack gap={1} vAlign="center">
                  <Button label="Edit" size="sm" variant="ghost" onClick={() => onEdit(p.id)} />
                  <ConfirmButton
                    label="Remove"
                    onConfirm={async () => {
                      const ok = await save(() => api.post(`/api/ai/providers/${p.id}/delete`, {}), { success: `Removed ${p.name}.` });
                      if (ok) {
                        forgetModelLists();
                        await reload();
                      }
                    }}
                  />
                </HStack>
              }
            />
          );
        })}
      </List>
      <FormError message={error} />
    </PaneSection>
  );
}

const GROUPS: { title: string; kinds: AiProviderView["kind"][] }[] = [
  { title: "Claude", kinds: ["anthropic", "cloud"] },
  { title: "Other models (best effort)", kinds: ["compatible"] },
  { title: "Your own endpoint", kinds: ["custom"] },
];

function ProviderPicker({ view, value, onChange }: { view: AiProvidersView; value: AiProviderId; onChange: (id: AiProviderId) => void }) {
  const option = (p: AiProviderView): SelectorOptionData => ({ value: p.id, label: p.name, description: providerStatus(p).text, icon: <ProviderLogo provider={p} /> });
  const options: SelectorOptionType[] = GROUPS.map((g) => ({
    type: "section" as const,
    title: g.title,
    options: view.providers.filter((p) => g.kinds.includes(p.kind)).map(option),
  }));
  const current = providerById(view, value);
  return (
    <Selector
      label="Provider"
      options={options}
      value={value}
      onChange={(v) => {
        const p = view.providers.find((x) => x.id === v);
        if (p) onChange(p.id);
      }}
      startIcon={current ? <ProviderLogo provider={current} /> : undefined}
      width="100%"
    />
  );
}

/** One provider's form: its fields, its models, what it can do, test and save, and whether chat or repo tasks use it. */
function ProviderSetup({ provider: p, view, reload }: { provider: AiProviderView; view: AiProvidersView; reload: () => Promise<void> }) {
  const { refresh } = useConfig();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Record<string, string>>(() => ({ ...(p.saved?.settings ?? {}) }));
  const [models, setModels] = useState<Partial<Record<ModelTier, string>>>(() => ({ ...(p.saved?.models ?? {}) }));
  const { save, error, edit } = useSave();
  const tiers: readonly ModelTier[] = p.kind === "anthropic" ? ["main"] : MODEL_TIER_OPTIONS;
  const savedSecrets = p.saved?.secrets ?? {};

  const changes = () => ({
    secrets: {
      ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim())),
      ...Object.fromEntries([...cleared].map((k) => [k, null])),
    },
    settings: Object.fromEntries(p.fields.filter((f) => !f.secret).map((f) => [f.key, settings[f.key] ?? ""])),
    models: Object.fromEntries(tiers.map((t) => [t, models[t] ?? ""])),
  });

  /** A required field with nothing typed and nothing saved: said before anything is sent. */
  const missing = () =>
    p.fields.find((f) => {
      if (!f.required) return false;
      if (f.secret) return !secrets[f.key]?.trim() && (!savedSecrets[f.key] || cleared.has(f.key));
      return !(settings[f.key]?.trim() || f.default);
    });

  const submit = async () => {
    const field = missing();
    const ok = await save(() => api.post(`/api/ai/providers/${p.id}`, changes()), {
      invalid: field ? `${field.label} is required.` : undefined,
      success: `${p.name} answered and is saved.`,
    });
    if (ok) {
      setSecrets({});
      setCleared(new Set());
      // A new key or address can see other models.
      forgetModelLists();
      await reload();
    }
  };

  const test = async () => {
    const field = missing();
    const ok = await save(() => api.post(`/api/ai/providers/${p.id}/test`, changes()), {
      invalid: field ? `${field.label} is required.` : undefined,
      success: `${p.name} answered: the connection works.${p.saved ? "" : " Save it to use it."}`,
    });
    if (ok) await reload();
  };

  const notes = p.notes;

  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Text>{p.keyHelp}</Text>
        <Link href={p.docsUrl} isExternalLink>
          {`${p.name} setup guide`}
        </Link>
      </VStack>

      {p.bestEffort && (
        <Banner
          status="warning"
          title="Best effort"
          description="Anthropic does not support non-Claude models behind Claude Code. Most things work, but some features may misbehave; check a few tasks before relying on it."
          collapsible={false}
        />
      )}

      <VStack gap={2}>
        <Heading level={4}>What it can do</Heading>
        <List density="compact">
          {capabilityLines(p).map((c) => (
            <ListItem key={c.text} startContent={<Icon icon={c.ok ? CheckCircleIcon : XCircleIcon} size="sm" color={c.ok ? "success" : "secondary"} />} label={<Text>{c.text}</Text>} />
          ))}
        </List>
        {notes.length > 0 && (
          <List listStyle="disc" density="compact">
            {notes.map((n) => (
              <ListItem key={n} label={<Text color="secondary">{n}</Text>} />
            ))}
          </List>
        )}
      </VStack>

      <FormLayout>
        {p.fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            saved={f.secret ? (savedSecrets[f.key] ?? null) : undefined}
            isCleared={cleared.has(f.key)}
            value={f.secret ? (secrets[f.key] ?? "") : (settings[f.key] ?? "")}
            onChange={edit((v: string) => (f.secret ? setSecrets((s) => ({ ...s, [f.key]: v })) : setSettings((s) => ({ ...s, [f.key]: v }))))}
            onClear={edit((on: boolean) =>
              setCleared((c) => {
                const next = new Set(c);
                if (on) next.add(f.key);
                else next.delete(f.key);
                return next;
              }),
            )}
          />
        ))}
      </FormLayout>

      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={4}>{p.kind === "anthropic" ? "Model" : "Models"}</Heading>
          <Text color="secondary">
            {p.kind === "anthropic"
              ? "For repo tasks, and for chat when the Team page sets no chat model."
              : p.kind === "custom"
                ? "Pick from the endpoint's models, or type the ids it expects. A tier left empty sends Claude's own model id."
                : `Claude Code's model tiers, mapped onto ${p.short}'s models. An agent set to a Claude model runs on the tier of the same size.`}
          </Text>
        </VStack>
        <FormLayout>
          {tiers.map((tier) => (
            <TierField key={tier} provider={p} tier={tier} value={models[tier] ?? ""} onChange={edit((v: string) => setModels((m) => ({ ...m, [tier]: v })))} />
          ))}
        </FormLayout>
      </VStack>

      <FormError message={error} />
      <FormActions>
        <Button label={p.saved ? "Test and save" : "Test and connect"} variant="primary" clickAction={submit} />
        <Button label="Test only" variant="secondary" clickAction={test} />
      </FormActions>

      <UseFor provider={p} view={view} reload={async () => Promise.all([reload(), refresh()]).then(() => undefined)} />
    </VStack>
  );
}

/** One field of a preset: a secret (masked when saved), a choice, several lines, or a line of text. */
function FieldInput({
  field: f,
  saved,
  isCleared,
  value,
  onChange,
  onClear,
}: {
  field: PresetField;
  saved: string | null | undefined;
  isCleared: boolean;
  value: string;
  onChange: (value: string) => void;
  onClear: (on: boolean) => void;
}) {
  if (f.type === "select") {
    return (
      <Selector
        label={f.label}
        options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        value={value || f.default || ""}
        onChange={onChange}
        description={f.help}
        isRequired={f.required}
      />
    );
  }
  // A saved optional secret can be removed (e.g. Bedrock's access key once an API key is used).
  const clear =
    f.secret && saved && !f.required ? (
      <HStack>
        <Button label={isCleared ? "Keep the saved value" : "Remove the saved value"} size="sm" variant="ghost" onClick={() => onClear(!isCleared)} />
      </HStack>
    ) : null;
  const savedNote = saved ? (isCleared ? "The saved value is removed when you save." : `Saved (${saved}). Paste a new one to replace it.`) : undefined;
  if (f.type === "textarea") {
    return (
      <VStack gap={1}>
        <TextArea
          label={f.label}
          value={value}
          onChange={(v) => onChange(v)}
          description={[f.help, savedNote].filter(Boolean).join(" ")}
          placeholder={saved && !isCleared ? "Leave empty to keep the saved one" : f.placeholder}
          rows={4}
          isRequired={f.required && !saved}
          isOptional={!f.required}
        />
        {clear}
      </VStack>
    );
  }
  if (f.secret) {
    return (
      <VStack gap={1}>
        <SecretField
          label={f.label}
          value={value}
          onChange={onChange}
          saved={isCleared ? null : saved}
          description={isCleared ? `${f.help} The saved value is removed when you save.` : f.help}
          placeholder={saved && !isCleared ? undefined : f.placeholder}
          isRequired={f.required}
        />
        {clear}
      </VStack>
    );
  }
  return (
    <TextInput
      label={f.label}
      value={value}
      onChange={(v) => onChange(v)}
      description={f.default ? `${f.help} Empty: ${f.default}.` : f.help}
      placeholder={f.placeholder}
      isRequired={f.required && !f.default}
      isOptional={!f.required}
    />
  );
}

/** USD per million tokens, from the provider's prices (a "[1m]" id costs as its model). */
function priceText(p: AiProviderView, id: string): string | undefined {
  const row = p.pricing[id.replace(/\[1m\]$/i, "")];
  return row ? `$${row.input} in, $${row.output} out per million tokens` : undefined;
}

/** The model of one tier: the provider's models (live where it can), its default, or an id typed by hand. */
function TierField({ provider: p, tier, value, onChange }: { provider: AiProviderView; tier: ModelTier; value: string; onChange: (value: string) => void }) {
  const fallback = p.defaults[tier];
  const info = p.kind === "anthropic" ? { label: "Model", description: "" } : TIER_INFO[tier];
  const defaultText = fallback ? presetModelLabel(p, fallback) : p.kind === "anthropic" ? "the Agent SDK's default model" : "Claude's own model id";
  const notes = Object.fromEntries(Object.keys(p.pricing).flatMap((id) => [id, `${id}[1m]`].map((key) => [key, priceText(p, id) ?? ""])));
  return (
    <ModelPicker
      label={info.label}
      source={{ kind: "provider", id: p.id }}
      value={value}
      onChange={(v) => onChange(v.trim())}
      specials={[{ value: "", label: `Default: ${defaultText}`, description: fallback ? [fallback, priceText(p, fallback)].filter(Boolean).join(" · ") : undefined }]}
      modelNotes={notes}
      description={info.description || undefined}
      placeholder={p.kind === "custom" ? "Search the endpoint's models, or type an id" : undefined}
      isOptional
    />
  );
}

/** "Use for chat" and "Use for repo tasks": only for a provider that is connected and complete. */
function UseFor({ provider: p, view, reload }: { provider: AiProviderView; view: AiProvidersView; reload: () => Promise<void> }) {
  const chat = useAction();
  const task = useAction();
  if (!p.saved) return null;
  const anthropic = providerById(view, "anthropic");
  const canFallBack = p.id !== "anthropic" && Boolean(anthropic?.configured);
  const set = async (scope: "chat" | "task", on: boolean) => {
    const action = scope === "chat" ? chat : task;
    const key = scope === "chat" ? "chatProvider" : "taskProvider";
    const to: AiProviderId = on ? p.id : "anthropic";
    const words = scope === "chat" ? "Chat" : "Repo tasks";
    const ok = await action.run(() => api.post("/api/ai/active", { [key]: to }), {
      success: `${words} now run${scope === "chat" ? "s" : ""} on ${on ? p.name : (anthropic?.name ?? "Anthropic")}.`,
    });
    if (ok) await reload();
  };
  const offMessage = canFallBack ? undefined : "Turn on another provider for this to move it there.";
  return (
    <VStack gap={3}>
      <Heading level={4}>Use it</Heading>
      {!p.configured && <Text color="secondary">Finish the connection above to use it.</Text>}
      <Switch
        label="Use for chat"
        description={`${p.name} answers in Slack and the console.`}
        value={p.usedFor.chat}
        isLoading={chat.pending}
        isDisabled={!p.configured || (p.usedFor.chat && !canFallBack)}
        disabledMessage={!p.configured ? "Connect it first." : offMessage}
        changeAction={(on) => set("chat", on)}
      />
      <Switch
        label="Use for repo tasks"
        description={`${p.name} leads the team and runs the agents in repo tasks.`}
        value={p.usedFor.task}
        isLoading={task.pending}
        isDisabled={!p.configured || (p.usedFor.task && !canFallBack)}
        disabledMessage={!p.configured ? "Connect it first." : offMessage}
        changeAction={(on) => set("task", on)}
      />
    </VStack>
  );
}
