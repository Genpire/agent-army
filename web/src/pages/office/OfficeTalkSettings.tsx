import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { ModelPicker } from "../../components/ModelPicker";
import { api, errorMessage } from "../../lib/api";
import type { ModelSource } from "../../lib/models";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { DAILY_MAX_LIMIT, TALK_SETTINGS_PATH, type TalkProvider, type TalkSettings, type TalkSettingsView, picksModel, settingsDraft, withProvider } from "./talk";
import { resumeOfficeTalk } from "./useOfficeTalk";

const PROVIDER_CHOICES: { value: TalkProvider; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Gemini when it is connected, else the chat model, each on its default model." },
  { value: "gemini", label: "Gemini", description: "Google's Gemini, with the key on Integrations → Gemini CLI." },
  { value: "chat", label: "Chat model", description: "The model Pointer answers with (Integrations → AI model)." },
];

const isProvider = (v: string): v is TalkProvider => PROVIDER_CHOICES.some((c) => c.value === v);

/** Which provider answers: the one picked, or for Auto the first that can. */
function resolved(provider: TalkProvider, available: TalkSettingsView["available"]): "gemini" | "chat" {
  if (provider !== "auto") return provider;
  return available.gemini || !available.chat ? "gemini" : "chat";
}

/** Why the chosen provider cannot answer now, or undefined when it can. */
function unavailableText(provider: TalkProvider, available: TalkSettingsView["available"], chatName: string): string | undefined {
  if (provider === "gemini" && !available.gemini) return "Gemini is not connected: add a Gemini API key on Integrations → Gemini CLI. Until then the team says its usual short lines.";
  if (provider === "chat" && !available.chat) return `${chatName} is not connected for chat. Until then the team says its usual short lines.`;
  if (provider === "auto" && !available.gemini && !available.chat) return "Neither Gemini nor the chat model is connected. Until one is, the team says its usual short lines.";
  return undefined;
}

function TalkForm({ view, draft, onChange }: { view: TalkSettingsView; draft: TalkSettings; onChange: (next: TalkSettings) => void }) {
  const { config } = useConfig();
  const chatName = config.ai.chat.name;
  const answering = resolved(draft.provider, view.available);
  const source: ModelSource = answering === "gemini" ? { kind: "engine", id: "gemini" } : { kind: "provider", id: config.ai.chatProvider };
  const problem = unavailableText(draft.provider, view.available, chatName);
  const set = <K extends keyof TalkSettings>(key: K) => (value: TalkSettings[K]) => onChange({ ...draft, [key]: value });
  return (
    <VStack gap={5}>
      <Switch
        label="Talk with AI"
        description="When two or three people chat, share a coffee or play a game, an AI model writes what they say: in character, about their work and the game. Off: the short canned lines."
        value={draft.enabled}
        onChange={set("enabled")}
      />
      <RadioList
        label="Model provider"
        value={draft.provider}
        onChange={(v) => isProvider(v) && onChange(withProvider(draft, v))}
        isDisabled={!draft.enabled}
        disabledMessage="Turn on Talk with AI first.">
        {PROVIDER_CHOICES.map((c) => {
          const isReady = c.value === "auto" ? view.available.gemini || view.available.chat : view.available[c.value];
          return <RadioListItem key={c.value} value={c.value} label={c.label} description={isReady ? c.description : `${c.description} Not connected.`} align="first-line" />;
        })}
      </RadioList>
      {problem && draft.enabled && (
        <Banner
          status="warning"
          title="No model to talk with"
          description={problem}
          endContent={<Button label="Integrations" size="sm" href={href("integrations", answering === "gemini" ? "gemini" : "claude")} />}
        />
      )}
      {/* A model only for Gemini or the chat model: Auto always uses the default ones. */}
      {picksModel(draft.provider) ? (
        <ModelPicker
          key={`${source.kind}:${source.id}`}
          label="Model"
          source={source}
          value={draft.model}
          onChange={(v) => set("model")(v.trim())}
          specials={[{ value: "", label: answering === "gemini" ? "Default: a fast Gemini model" : `Default: ${chatName}'s chat model` }]}
          description={answering === "gemini" ? "From Google's live list. A small, fast model is plenty for a few lines." : `From ${chatName}'s list. A small, fast model is plenty for a few lines.`}
          maxLength={100}
          isOptional
          isDisabled={!draft.enabled}
          disabledMessage="Turn on Talk with AI first."
        />
      ) : (
        <Text type="supporting" color="secondary">
          {`Auto uses the default models: a fast Gemini model, or ${chatName}'s chat model. To choose a model, pick Gemini or Chat model.`}
        </Text>
      )}
      <NumberInput
        label="Conversations a day"
        description="One short model call each, shared by everyone who opens the office. Past the limit, the canned lines play until tomorrow."
        value={draft.dailyMax}
        onChange={(v) => set("dailyMax")(Math.max(0, Math.min(DAILY_MAX_LIMIT, Math.round(v ?? 0))))}
        min={0}
        max={DAILY_MAX_LIMIT}
        step={10}
        isDisabled={!draft.enabled}
      />
      <VStack gap={1}>
        <HStack gap={2} hAlign="between" vAlign="center">
          <Text weight="semibold">Used today</Text>
          <Text hasTabularNumbers>
            {view.usedToday} of {view.dailyMax}
          </Text>
        </HStack>
        <ProgressBar label="Conversations used today" isLabelHidden value={Math.min(view.usedToday, view.dailyMax)} max={Math.max(1, view.dailyMax)} variant={view.usedToday >= view.dailyMax ? "warning" : "accent"} />
      </VStack>
    </VStack>
  );
}

/** Office talk's settings: on or off, which provider and model, the daily limit and today's use (GET and POST /api/office/talk/settings). */
function OfficeTalkDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
  const [view, setView] = useState<TalkSettingsView>();
  const [draft, setDraft] = useState<TalkSettings>();
  const [error, setError] = useState<string>();
  const { run, pending } = useAction();

  useEffect(() => {
    if (!isOpen) return;
    let isCurrent = true;
    setError(undefined);
    api.get<TalkSettingsView>(TALK_SETTINGS_PATH).then(
      (v) => {
        if (!isCurrent) return;
        setView(v);
        setDraft(settingsDraft(v));
      },
      (err: unknown) => isCurrent && setError(errorMessage(err)),
    );
    return () => {
      isCurrent = false;
    };
  }, [isOpen]);

  const save = async () => {
    if (!draft) return;
    const ok = await run(
      async () => {
        const saved = await api.post<TalkSettingsView>(TALK_SETTINGS_PATH, draft);
        setView(saved);
        setDraft(settingsDraft(saved));
      },
      { success: "Office talk saved." },
    );
    if (!ok) return;
    resumeOfficeTalk();
    onOpenChange(false);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title="Office talk" subtitle="What the team says to each other between tasks, in the Office's speech bubbles." onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            {error ? (
              <Banner status="error" title="The settings could not be loaded" description={error} />
            ) : view && draft ? (
              <TalkForm view={view} draft={draft} onChange={setDraft} />
            ) : (
              <Center minHeight={200}>
                <Spinner label="Loading the settings" />
              </Center>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button label="Save" variant="primary" isDisabled={!draft} isLoading={pending} clickAction={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** The Office page's "Office talk" button, which opens its settings. */
export function OfficeTalkButton() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <Button
        label="Office talk"
        size="sm"
        variant="secondary"
        icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />}
        tooltip="How the team talks between tasks: with AI, or short canned lines"
        onClick={() => setIsOpen(true)}
      />
      <OfficeTalkDialog isOpen={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
