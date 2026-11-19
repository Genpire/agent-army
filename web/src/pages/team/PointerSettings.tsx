import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useState } from "react";
import type { PointerSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { EFFORT_SELECT_OPTIONS, chatModelOptions, fieldStatus, hasErrors, isEffort, pointerErrors } from "./team";

type PointerPatch = Partial<PointerSpec>;

export interface PointerSettingsProps {
  /** The saved settings. */
  pointer: PointerSpec;
  /** The model on the Claude connection, which an empty chat model falls back to. */
  claudeModel: string;
  /** Saves these of Pointer's settings over the saved ones; throws the server's error. */
  onSave: (patch: PointerPatch) => Promise<void>;
}

/** A settings row (the settings template): what it is on the start side, its fields on the end side. */
export function SettingsRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Grid columns={{ minWidth: 320 }} gap={10}>
      <VStack gap={1}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      </VStack>
      <VStack gap={4}>{children}</VStack>
    </Grid>
  );
}

/**
 * One row's draft of some of Pointer's fields: changed or not, its errors once
 * a save was tried, and save/discard. Reset by keying the row on its saved values.
 */
function usePointerRow<K extends keyof PointerSpec>(pointer: PointerSpec, keys: readonly K[], onSave: PointerSettingsProps["onSave"]) {
  const pick = (p: PointerSpec) => Object.fromEntries(keys.map((k) => [k, p[k]])) as Pick<PointerSpec, K>;
  const [draft, setDraft] = useState(() => pick(pointer));
  const [tried, setTried] = useState(false);
  const { run, pending } = useAction();
  const trimmed = Object.fromEntries(keys.map((k) => [k, typeof draft[k] === "string" ? (draft[k] as string).trim() : draft[k]])) as Pick<PointerSpec, K>;
  const allErrors = pointerErrors({ ...pointer, ...trimmed });
  const errors = Object.fromEntries(keys.flatMap((k) => (allErrors[k] ? [[k, allErrors[k]]] : []))) as Partial<Record<K, string>>;
  const changed = keys.some((k) => trimmed[k] !== pointer[k]);

  return {
    draft,
    changed,
    pending,
    set:
      <F extends K>(key: F) =>
      (value: PointerSpec[F]) =>
        setDraft((d) => ({ ...d, [key]: value })),
    status: (key: K) => fieldStatus(errors[key], tried),
    discard: () => {
      setDraft(pick(pointer));
      setTried(false);
    },
    save: async () => {
      setTried(true);
      if (hasErrors(errors)) return;
      await run(() => onSave(trimmed), { success: "Saved." });
    },
  };
}

const IDENTITY_KEYS = ["name", "instructions"] as const;
const RUNTIME_KEYS = ["model", "effort", "taskEffort", "budgetUsd", "maxTurns"] as const;

const savedKey = (pointer: PointerSpec, keys: readonly (keyof PointerSpec)[]) => JSON.stringify(keys.map((k) => pointer[k]));

/**
 * Pointer's settings as two settings rows, each with its own Save: who it is
 * (name and extra instructions), then how it runs (models, effort, limits).
 */
export function PointerSettings(props: PointerSettingsProps) {
  return (
    <VStack gap={6}>
      <IdentityRow key={savedKey(props.pointer, IDENTITY_KEYS)} {...props} />
      <Divider />
      <RuntimeRow key={savedKey(props.pointer, RUNTIME_KEYS)} {...props} />
    </VStack>
  );
}

function SaveBar({ row }: { row: { changed: boolean; pending: boolean; save: () => Promise<void>; discard: () => void } }) {
  return (
    <HStack gap={2}>
      <Button label="Save" variant="primary" isDisabled={!row.changed} isLoading={row.pending} clickAction={row.save} />
      {row.changed && <Button label="Discard" variant="ghost" onClick={row.discard} />}
    </HStack>
  );
}

function IdentityRow({ pointer, onSave }: PointerSettingsProps) {
  const row = usePointerRow(pointer, IDENTITY_KEYS, onSave);
  return (
    <SettingsRow
      title={pointer.name}
      description="The lead. It answers in Slack, plans repo tasks and hands the work to the agents. In Slack it can describe the team; only this page changes it.">
      <TextInput
        label="Name"
        value={row.draft.name}
        onChange={row.set("name")}
        description="Used in replies and as the Slack app name in the manifest. To rename the bot in Slack, update the app under Integrations."
        status={row.status("name")}
        isRequired
      />
      <TextArea
        label="Extra instructions"
        value={row.draft.instructions}
        onChange={row.set("instructions")}
        placeholder="Reply in English. Our main product is the web app in acme/web."
        description="Added to its built-in instructions, in Slack and in repo tasks."
        rows={4}
        maxLength={8000}
        status={row.status("instructions")}
        isOptional
      />
      <SaveBar row={row} />
    </SettingsRow>
  );
}

function RuntimeRow({ pointer, claudeModel, onSave }: PointerSettingsProps) {
  const row = usePointerRow(pointer, RUNTIME_KEYS, onSave);
  return (
    <SettingsRow
      title="Model, effort and limits"
      description="Higher effort thinks longer: better on hard work, slower, and more credit. The limits cap one reply in Slack; repo tasks use the limits under Projects.">
      <Selector
        label="Chat model"
        options={chatModelOptions(row.draft.model, claudeModel)}
        value={row.draft.model}
        onChange={row.set("model")}
        description="For replies in Slack. Sonnet 5.5 costs half as much as Opus 5.5 and is plenty for most chat."
      />
      <Grid columns={{ minWidth: 200, max: 2 }} gap={4} align="end">
        <Selector
          label="Chat effort"
          options={EFFORT_SELECT_OPTIONS}
          value={row.draft.effort}
          onChange={(v) => isEffort(v) && row.set("effort")(v)}
          description="Before replying in Slack."
        />
        <Selector
          label="Repo task effort"
          options={EFFORT_SELECT_OPTIONS}
          value={row.draft.taskEffort}
          onChange={(v) => isEffort(v) && row.set("taskEffort")(v)}
          description="On code and pull requests. Agents can override it."
        />
        <NumberInput
          label="Budget per message"
          value={row.draft.budgetUsd}
          onChange={row.set("budgetUsd")}
          min={0.1}
          max={20}
          step={0.05}
          units="USD"
          formatValue={(n) => n.toFixed(2)}
          description="$0.10 to $20 for one reply."
          status={row.status("budgetUsd")}
        />
        <NumberInput
          label="Turns per message"
          value={row.draft.maxTurns}
          onChange={row.set("maxTurns")}
          min={5}
          max={200}
          isIntegerOnly
          description="5 to 200 steps for one reply."
          status={row.status("maxTurns")}
        />
      </Grid>
      <SaveBar row={row} />
    </SettingsRow>
  );
}
