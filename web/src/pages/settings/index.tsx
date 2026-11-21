import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector, type SelectorOptionData } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tokenizer } from "@astryxdesign/core/Tokenizer";
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowRightStartOnRectangleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { TimezoneSelector, browserTimeZone } from "../../components/TimezoneSelector";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { Limits } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { SaveRow, SettingsSection } from "./parts";
import { SpendingSection } from "./SpendingSection";

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

// ---------- Timezone ----------

function TimezoneSection({ saved, pointer }: { saved: string; pointer: string }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [timezone, setTimezone] = useState(saved);
  const browser = browserTimeZone();
  const save = () =>
    void run(
      async () => {
        await api.post("/api/settings", { timezone });
        await refresh();
      },
      { success: `Timezone saved: ${timezone}.` },
    );
  return (
    <SettingsSection
      title="Timezone"
      description={`Your organisation's timezone. New routines run on its clock unless they name another one: when you ask ${pointer} for "every morning at 8", it means 08:00 here.`}>
      <TimezoneSelector
        label="Timezone"
        value={timezone}
        onChange={setTimezone}
        description={browser !== timezone ? `This browser is on ${browser}.` : undefined}
      />
      <HStack gap={3} vAlign="center" wrap="wrap">
        <SaveRow label="Save" isDirty={timezone !== saved} pending={pending} onSave={save} />
        {browser !== timezone && timezone === saved && <Button label={`Use ${browser}`} variant="ghost" onClick={() => setTimezone(browser)} />}
      </HStack>
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

/** The limits that are numbers (previewCheck is a choice, set on its own). */
type NumericLimit = { [K in keyof Limits]: Limits[K] extends number ? K : never }[keyof Limits];

interface LimitField {
  key: NumericLimit;
  label: string;
  description: string;
  min: number;
  max: number;
  step?: number;
  units?: string;
  isInteger?: boolean;
}

/** Mirrors the limits in ConfigSchema (src/core/config.ts); the server checks them again. */
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

type PreviewCheck = Limits["previewCheck"];

/** Mirrors limits.previewCheck in ConfigSchema (src/core/config.ts). */
const PREVIEW_CHECK_OPTIONS: (SelectorOptionData & { value: PreviewCheck })[] = [
  { value: "off", label: "Off", description: "Never opens the preview" },
  { value: "visible", label: "When the change is visible", description: "Only for changes to what people see (recommended)" },
  { value: "always", label: "Always", description: "After every pull request with a preview" },
];
const isPreviewCheck = (value: string): value is PreviewCheck => PREVIEW_CHECK_OPTIONS.some((o) => o.value === value);

function LimitsSection({ saved, runner }: { saved: Limits; runner: string | undefined }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [limits, setLimits] = useState<Limits>(saved);
  const fields = limitFields(runner);
  const errors = fields.map((f) => limitError(f, limits[f.key]));
  const isDirty = fields.some((f) => limits[f.key] !== saved[f.key]) || limits.previewCheck !== saved.previewCheck;
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
      <Selector
        label="Preview check"
        options={PREVIEW_CHECK_OPTIONS}
        value={limits.previewCheck}
        onChange={(v) => isPreviewCheck(v) && setLimits((l) => ({ ...l, previewCheck: v }))}
        description="After the checks, the team opens the pull request's preview deployment (Vercel, Netlify…) in a browser and looks at the change. Each look is a short extra run, paid from the task's budget."
      />
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

// ---------- Admin password ----------

const MIN_PASSWORD = 10;

/** Change the admin password: the current one is asked again; other browsers are signed out. */
function PasswordSection() {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const shortError = tried && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : undefined;
  const confirmError = tried && confirm !== password ? "The passwords do not match." : undefined;
  const save = () => {
    setTried(true);
    if (!current || password.length < MIN_PASSWORD || confirm !== password) return;
    void run(
      async () => {
        await api.post("/api/password", { currentPassword: current, password });
        setCurrent("");
        setPassword("");
        setConfirm("");
        setTried(false);
        await refresh();
      },
      { success: "Password changed. Other browsers were signed out." },
    );
  };
  return (
    <SettingsSection
      title="Admin password"
      description="The password for this console. Changing it signs out every other browser. Forgot it? Use “Forgot your password?” on the sign-in page with the deployment's setup token.">
      <TextInput label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <TextInput
        label="New password"
        type="password"
        description={`At least ${MIN_PASSWORD} characters.`}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        status={shortError ? { type: "error", message: shortError } : undefined}
      />
      <TextInput
        label="Confirm new password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        status={confirmError ? { type: "error", message: confirmError } : undefined}
        onEnter={save}
      />
      <SaveRow label="Change password" isDirty={Boolean(current && password)} pending={pending} onSave={save} />
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
    <PageFrame title="Settings" description="Limits, spending, access, the timezone, the admin password and this deployment.">
      <VStack gap={8}>
        <LimitsSection saved={config.limits} runner={state.runner} />
        <Divider />
        <SpendingSection saved={config.budget} pointer={pointer} />
        <Divider />
        <AccessSection saved={config.slack.allowedUserIds} pointer={pointer} />
        <Divider />
        <OrgNameSection saved={config.orgName} />
        <Divider />
        <TimezoneSection saved={config.timezone} pointer={pointer} />
        <Divider />
        <DeploymentSection />
        <Divider />
        <PasswordSection />
        <Divider />
        <SessionSection pointer={pointer} />
      </VStack>
    </PageFrame>
  );
}
