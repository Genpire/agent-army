import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tokenizer } from "@astryxdesign/core/Tokenizer";
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowRightStartOnRectangleIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { Limits } from "../../lib/types";
import { useAction } from "../../lib/useAction";

/** One settings group: what it is on the start side, its fields on the end side (folds to one column when narrow). */
function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Grid columns={{ minWidth: 320 }} gap={10}>
      <VStack gap={1}>
        <Heading level={3} accessibilityLevel={2}>
          {title}
        </Heading>
        <Text type="supporting">{description}</Text>
      </VStack>
      <VStack gap={5}>{children}</VStack>
    </Grid>
  );
}

function SaveRow({ label, isDirty, isInvalid, pending, onSave }: { label: string; isDirty: boolean; isInvalid?: boolean; pending: boolean; onSave: () => void }) {
  return (
    <HStack gap={3} vAlign="center">
      <Button label={label} variant="primary" isLoading={pending} isDisabled={!isDirty || isInvalid} onClick={onSave} />
      {isDirty && <Text type="supporting">Unsaved changes</Text>}
    </HStack>
  );
}

// ---------- Company name ----------

function OrgNameSection({ saved }: { saved: string }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [orgName, setOrgName] = useState(saved);
  const tooLong = orgName.trim().length > 60;
  const save = () =>
    void run(
      async () => {
        await api.post("/api/settings", { orgName: orgName.trim() });
        await refresh();
      },
      { success: "Company name saved." },
    );
  return (
    <SettingsSection title="Company" description="The agents are told who they work for, so answers and pull requests use your company's name.">
      <TextInput
        label="Company or team name"
        value={orgName}
        onChange={setOrgName}
        placeholder="Acme Inc."
        isOptional
        status={tooLong ? { type: "error", message: "Use at most 60 characters." } : undefined}
        onEnter={save}
      />
      <SaveRow label="Save" isDirty={orgName.trim() !== saved} isInvalid={tooLong} pending={pending} onSave={save} />
    </SettingsSection>
  );
}

// ---------- Who may talk to Pointer ----------

const SLACK_USER_RE = /^[UW][A-Z0-9]+$/;
const noSuggestions: SearchSource<SearchableItem> = { search: () => [], bootstrap: () => [] };
const asItems = (ids: string[]): SearchableItem[] => ids.map((id) => ({ id, label: id }));

function AccessSection({ saved, pointer }: { saved: string[]; pointer: string }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [users, setUsers] = useState<SearchableItem[]>(() => asItems(saved));
  const [invalid, setInvalid] = useState<string>();
  const ids = users.map((u) => u.id);
  const isDirty = ids.join(",") !== saved.join(",");

  // Typed or pasted ids may hold several, separated by commas or spaces; each is checked like the server does.
  const onChange = (items: SearchableItem[]) => {
    const next: string[] = [];
    const bad: string[] = [];
    for (const item of items) {
      for (const part of item.label.split(/[\s,]+/)) {
        const id = part.trim().toUpperCase();
        if (!id) continue;
        if (!SLACK_USER_RE.test(id)) bad.push(part.trim());
        else if (!next.includes(id)) next.push(id);
      }
    }
    setUsers(asItems(next));
    setInvalid(bad.length ? `${bad.join(", ")} ${bad.length === 1 ? "is not a Slack user ID" : "are not Slack user IDs"}. They look like U012ABCDEF.` : undefined);
  };

  const save = async () => {
    const saved = await run(
      async () => {
        await api.post("/api/settings", { allowedUserIds: ids });
        await refresh();
      },
      { success: ids.length ? "Access list saved." : `Everyone in the workspace can now talk to ${pointer}.` },
    );
    if (saved) setInvalid(undefined);
  };

  return (
    <SettingsSection
      title={`Who can talk to ${pointer}`}
      description={`Leave empty to let everyone in your Slack workspace use ${pointer}. People from other organisations (Slack Connect) need to be listed.`}>
      <Tokenizer
        label="Slack user IDs"
        description="In Slack, open someone's profile, choose More, then Copy member ID. Press Enter after each one."
        searchSource={noSuggestions}
        value={users}
        onChange={onChange}
        hasCreate
        hasClear
        placeholder={users.length ? undefined : "Everyone in the workspace"}
        status={invalid ? { type: "error", message: invalid } : undefined}
      />
      <Text type="supporting">
        {ids.length ? `${ids.length === 1 ? "Only this person" : `Only these ${ids.length} people`} can give ${pointer} requests.` : `Everyone in the workspace can give ${pointer} requests.`}
      </Text>
      <SaveRow label="Save" isDirty={isDirty} pending={pending} onSave={() => void save()} />
    </SettingsSection>
  );
}

// ---------- Repo task limits ----------

interface LimitField {
  key: keyof Limits;
  label: string;
  description: string;
  min: number;
  max: number;
  step?: number;
  units?: string;
  isInteger?: boolean;
}

/** Mirrors the limits in ConfigSchema (src/config.ts); the server checks them again. */
function limitFields(runner: string | undefined): LimitField[] {
  return [
    {
      key: "maxBudgetUsd",
      label: "Budget per task",
      units: "USD",
      min: 0.5,
      max: 500,
      step: 0.5,
      description: "A task stops when it has used this much Claude credit and keeps its work in a draft pull request. From 0.5 to 500.",
    },
    {
      key: "maxTurns",
      label: "Agent turns per task",
      min: 10,
      max: 1000,
      isInteger: true,
      description: "A turn is one step by Claude. A task stops after this many and keeps its work in a draft pull request. From 10 to 1000.",
    },
    {
      key: "maxParallel",
      label: "Tasks at the same time",
      min: 1,
      max: 50,
      isInteger: true,
      description:
        runner === "cloudrun"
          ? "Only for the local runner: on Cloud Run every task runs as its own job. From 1 to 50."
          : "More tasks wait in a queue until one finishes. From 1 to 50.",
    },
    {
      key: "progressEveryMin",
      label: "Progress update every",
      units: "min",
      min: 0,
      max: 60,
      isInteger: true,
      description: "Posts the plan, current step and files changed in the task's Slack thread. 0 keeps only the live progress message. Costs no credit. From 0 to 60.",
    },
    {
      key: "ciWaitMin",
      label: "Wait for checks",
      units: "min",
      min: 0,
      max: 60,
      isInteger: true,
      description: "After pushing, waits this long for the pull request's checks (GitHub Actions, Vercel…). 0 does not wait. From 0 to 60.",
    },
    {
      key: "ciFixRounds",
      label: "Fix rounds for failing checks",
      min: 0,
      max: 5,
      isInteger: true,
      description: "How many times the team tries to fix failing checks, within the task's budget. 0 only reports them. From 0 to 5.",
    },
  ];
}

function limitError(f: LimitField, value: number): string | undefined {
  if (!Number.isFinite(value) || value < f.min || value > f.max) return `Use a number from ${f.min} to ${f.max}.`;
  if (f.isInteger && !Number.isInteger(value)) return "Use a whole number.";
  return undefined;
}

function LimitsSection({ saved, runner }: { saved: Limits; runner: string | undefined }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [limits, setLimits] = useState<Limits>(saved);
  const fields = limitFields(runner);
  const errors = fields.map((f) => limitError(f, limits[f.key]));
  const isDirty = fields.some((f) => limits[f.key] !== saved[f.key]);
  const save = () =>
    void run(
      async () => {
        await api.post("/api/settings", { limits });
        await refresh();
      },
      { success: "Limits saved. New tasks use them." },
    );
  return (
    <SettingsSection
      title="Repo task limits"
      description="How far one repo task may go before it stops, and how it reports. Running tasks keep the limits they started with.">
      {fields.map((f, i) => (
        <NumberInput
          key={f.key}
          label={f.label}
          description={f.description}
          value={limits[f.key]}
          onChange={(v) => setLimits((l) => ({ ...l, [f.key]: v }))}
          min={f.min}
          max={f.max}
          step={f.step ?? 1}
          units={f.units}
          isIntegerOnly={f.isInteger}
          hasNumberSteppers
          status={errors[i] ? { type: "error", message: errors[i] } : undefined}
        />
      ))}
      <HStack gap={3} vAlign="center" wrap="wrap">
        <SaveRow label="Save limits" isDirty={isDirty} isInvalid={errors.some(Boolean)} pending={pending} onSave={save} />
        {isDirty && <Button label="Undo changes" variant="ghost" onClick={() => setLimits(saved)} />}
      </HStack>
    </SettingsSection>
  );
}

// ---------- Deployment and session ----------

const RUNNER_LABEL: Record<string, string> = {
  local: "Local: tasks run as processes next to the server",
  cloudrun: "Cloud Run: each task runs as its own job",
};

function DeploymentSection() {
  const { state } = useConfig();
  return (
    <SettingsSection title="Deployment" description="Where this console runs its tasks and keeps its data. Set with environment variables on the server.">
      <MetadataList label={{ position: "start", width: 96 }}>
        <MetadataListItem label="Runner">
          <Text>{state.runner ? (RUNNER_LABEL[state.runner] ?? state.runner) : "–"}</Text>
        </MetadataListItem>
        <MetadataListItem label="Storage">
          <Text>{state.storage ?? "–"}</Text>
        </MetadataListItem>
      </MetadataList>
      <Text type="supporting">
        Change them with <Code>RUNNER</Code>, <Code>STORAGE</Code>, <Code>DATA_DIR</Code> or <Code>GCS_BUCKET</Code> and restart the server.
      </Text>
    </SettingsSection>
  );
}

function SessionSection({ pointer }: { pointer: string }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  return (
    <SettingsSection title="Session" description={`Signs this browser out of the console. ${pointer} and running tasks are not affected.`}>
      <HStack>
        <Button
          label="Sign out"
          icon={<Icon icon={ArrowRightStartOnRectangleIcon} />}
          isLoading={pending}
          onClick={() =>
            void run(async () => {
              await api.post("/api/logout");
              await refresh();
            })
          }
        />
      </HStack>
    </SettingsSection>
  );
}

export default function SettingsPage() {
  const { config, state } = useConfig();
  const pointer = config.team.pointer.name;
  return (
    <PageFrame title="Settings" description="Limits, access and this deployment.">
      <VStack gap={8}>
        <LimitsSection saved={config.limits} runner={state.runner} />
        <Divider />
        <AccessSection saved={config.slack.allowedUserIds} pointer={pointer} />
        <Divider />
        <OrgNameSection saved={config.orgName} />
        <Divider />
        <DeploymentSection />
        <Divider />
        <SessionSection pointer={pointer} />
      </VStack>
    </PageFrame>
  );
}
