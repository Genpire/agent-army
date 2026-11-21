import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useState } from "react";
import { ModelPicker } from "../../components/ModelPicker";
import type { PointerSpec } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import {
  CLAUDE_CHOICES,
  EFFORT_SELECT_OPTIONS,
  type ModelChoices,
  SIZE_INFO,
  TASK_SIZE_OPTIONS,
  type TaskSize,
  chatModelSpecials,
  fieldStatus,
  hasErrors,
  isEffort,
  pointerErrors,
} from "./team";

type PointerPatch = Partial<PointerSpec>;

export interface PointerSettingsProps {
  /** The saved settings. */
  pointer: PointerSpec;
  /** The model on the Claude connection, which an empty chat model falls back to. */
  claudeModel: string;
  /** The chat provider's models, for the chat model; Claude's when absent. */
  chatModels?: ModelChoices;
  /** The repo task provider's models, for the routing's sizes; Claude's when absent. */
  taskModels?: ModelChoices;
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
 * Pointer's settings as settings rows, each with its own Save: who it is
 * (name and extra instructions), how it runs (models, effort, limits), and
 * the model routing of repo tasks by size.
 */
export function PointerSettings(props: PointerSettingsProps) {
  const { routing } = props.pointer;
  return (
    <VStack gap={6}>
      <IdentityRow key={savedKey(props.pointer, IDENTITY_KEYS)} {...props} />
      <Divider />
      <RuntimeRow key={savedKey(props.pointer, RUNTIME_KEYS)} {...props} />
      <Divider />
      {/* Keyed on the routes only: turning routing on or off keeps unsaved route changes. */}
      <RoutingRow key={JSON.stringify(TASK_SIZE_OPTIONS.map((s) => routing[s]))} {...props} />
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

function RuntimeRow({ pointer, claudeModel, chatModels = CLAUDE_CHOICES, onSave }: PointerSettingsProps) {
  const row = usePointerRow(pointer, RUNTIME_KEYS, onSave);
  return (
    <SettingsRow
      title="Model, effort and limits"
      description="Higher effort thinks longer: better on hard work, slower, and more credit. The limits cap one reply in Slack; repo tasks use the limits under Projects.">
      <ModelPicker
        label="Chat model"
        source={chatModels.source}
        value={row.draft.model}
        onChange={row.set("model")}
        specials={chatModelSpecials(claudeModel, chatModels)}
        extra={chatModels.extra}
        modelNotes={chatModels.notes}
        describeUnknown={chatModels.describe}
        maxLength={100}
        description={
          chatModels.isClaude
            ? "For replies in Slack. Sonnet 5.5 costs half as much as Opus 5.5 and is plenty for most chat."
            : `For replies in Slack, on ${chatModels.name}: the chat provider under Integrations, AI model.`
        }
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

type Routes = Pick<PointerSpec["routing"], TaskSize>;
const routesOf = (routing: PointerSpec["routing"]): Routes => ({ small: routing.small, medium: routing.medium, large: routing.large });

/**
 * Model routing: on/off saves at once; each size's model and effort are a
 * draft with Save. Mirrors team.pointer.routing (RoutingSchema in src/team/team.ts).
 */
function RoutingRow({ pointer, claudeModel, taskModels = CLAUDE_CHOICES, onSave }: PointerSettingsProps) {
  const saved = pointer.routing;
  const [draft, setDraft] = useState<Routes>(() => routesOf(saved));
  const routes = useAction();
  const toggle = useAction();
  const setRoute = (size: TaskSize, patch: Partial<Routes[TaskSize]>) => setDraft((d) => ({ ...d, [size]: { ...d[size], ...patch } }));
  const row = {
    changed: TASK_SIZE_OPTIONS.some((s) => draft[s].model !== saved[s].model || draft[s].effort !== saved[s].effort),
    pending: routes.pending,
    save: async () => {
      await routes.run(() => onSave({ routing: { ...saved, ...draft } }), { success: "Routes saved. New repo tasks use them." });
    },
    discard: () => setDraft(routesOf(saved)),
  };
  return (
    <SettingsRow
      title="Model routing"
      description={`Most requests are small and do not need the strongest model. With routing on, each repo task starts with a quick size estimate and runs with that size's model and effort. Agents with their own model or effort keep it. Task cards show the size and a cost range from earlier tasks of the same size.`}>
      <Switch
        label="Route repo tasks by size"
        description={`Before each repo task, ${taskModels.isClaude ? "Haiku 5.5" : `${taskModels.name}'s small model`} reads the request and calls it small, medium or large (a fraction of a cent). Off: every task runs on the configured models with the repo task effort above.`}
        value={saved.enabled}
        isLoading={toggle.pending}
        changeAction={async (on) => {
          await toggle.run(() => onSave({ routing: { ...saved, enabled: on } }), {
            success: on ? "Routing is on. New repo tasks are sized first." : "Routing is off. New repo tasks use the repo task effort.",
          });
        }}
      />
      {TASK_SIZE_OPTIONS.map((size) => (
        <VStack key={size} gap={2}>
          <VStack gap={1}>
            <Text weight="medium">{SIZE_INFO[size].label}</Text>
            <Text type="supporting" color="secondary">
              {SIZE_INFO[size].description}
            </Text>
          </VStack>
          <Grid columns={{ minWidth: 200, max: 2 }} gap={4} align="start">
            <ModelPicker
              label={`${SIZE_INFO[size].label} task model`}
              source={taskModels.source}
              value={draft[size].model}
              onChange={(v) => setRoute(size, { model: v })}
              specials={chatModelSpecials(claudeModel, taskModels)}
              extra={taskModels.extra}
              modelNotes={taskModels.notes}
              describeUnknown={taskModels.describe}
              maxLength={100}
            />
            <Selector
              label={`${SIZE_INFO[size].label} task effort`}
              options={EFFORT_SELECT_OPTIONS}
              value={draft[size].effort}
              onChange={(v) => isEffort(v) && setRoute(size, { effort: v })}
            />
          </Grid>
        </VStack>
      ))}
      <SaveBar row={row} />
    </SettingsRow>
  );
}
