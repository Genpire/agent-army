import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type ISOTimeString, TimeInput } from "@astryxdesign/core/TimeInput";
import { Tokenizer } from "@astryxdesign/core/Tokenizer";
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { TimezoneSelector } from "../../components/TimezoneSelector";
import { WeekdayPicker } from "../../components/WeekdayPicker";
import { api, errorMessage } from "../../lib/api";
import { href } from "../../lib/router";
import { useAction } from "../../lib/useAction";
import { type RoutineBody, type RoutineView, type SchedulePreview, ROUTINE_TIMEOUT_DEFAULT_MIN, ROUTINE_TIMEOUT_MAX_MIN, ROUTINES_PATH, routinePath, runTime } from "./model";
import { RunHistory } from "./RunHistory";
import { DEFAULT_FORM, PRESET_OPTIONS, type PresetKind, type ScheduleForm, cronFor, formFor } from "./schedule";

export type DrawerTab = "routine" | "runs";

export interface RoutineDrawerProps {
  isOpen: boolean;
  /** The routine to edit; undefined = a new one. */
  routine: RoutineView | undefined;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  /** The organisation's timezone (new routines' default), and whether email can be sent. */
  timezone: string;
  emailReady: boolean;
  onClose: () => void;
  /** After a save, delete or Run now: reload the list. */
  onChanged: (routine?: RoutineView) => void | Promise<void>;
}

interface FormState {
  name: string;
  instruction: string;
  schedule: ScheduleForm;
  timezone: string;
  emails: SearchableItem[];
  slack: string;
  console: boolean;
  budgetUsd: number;
  timeoutMin: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLACK_RE = /^[CGDUW][A-Z0-9]{2,30}$/;
const noSuggestions: SearchSource<SearchableItem> = { search: () => [], bootstrap: () => [] };
const asItems = (emails: string[]): SearchableItem[] => emails.map((e) => ({ id: e.toLowerCase(), label: e }));

function initialForm(routine: RoutineView | undefined, timezone: string): FormState {
  if (routine) {
    return {
      name: routine.name,
      instruction: routine.instruction,
      schedule: formFor(routine.schedule.cron),
      timezone: routine.schedule.timezone,
      emails: asItems(routine.deliver.email),
      slack: routine.deliver.slack,
      console: routine.deliver.console,
      budgetUsd: routine.budgetUsd,
      timeoutMin: routine.timeoutMin ?? ROUTINE_TIMEOUT_DEFAULT_MIN,
    };
  }
  return {
    name: "",
    instruction: "",
    schedule: { ...DEFAULT_FORM },
    timezone,
    emails: [],
    slack: "",
    console: true,
    budgetUsd: 1,
    timeoutMin: ROUTINE_TIMEOUT_DEFAULT_MIN,
  };
}

const bodyOf = (f: FormState): RoutineBody => ({
  name: f.name.trim(),
  instruction: f.instruction.trim(),
  schedule: { cron: cronFor(f.schedule), timezone: f.timezone },
  deliver: { email: f.emails.map((e) => e.label), slack: f.slack.trim(), console: f.console },
  budgetUsd: f.budgetUsd,
  timeoutMin: f.timeoutMin,
});

/** The schedule in words and its next runs, asked from the server as the schedule changes. */
function useSchedulePreview(cron: string, timezone: string, isOpen: boolean): { preview?: SchedulePreview; loading: boolean } {
  const [preview, setPreview] = useState<SchedulePreview>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    if (!cron.trim()) {
      setPreview({ ok: false, error: "Write a cron schedule, e.g. 0 8 * * 1-5." });
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .post<SchedulePreview>(`${ROUTINES_PATH}/preview`, { cron, timezone })
        .then((p) => live && setPreview(p))
        .catch((err: unknown) => live && setPreview({ ok: false, error: errorMessage(err) }))
        .finally(() => live && setLoading(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cron, timezone, isOpen]);
  return { preview, loading };
}

function ScheduleFields({ form, onChange }: { form: ScheduleForm; onChange: (form: ScheduleForm) => void }) {
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch });
  const pick = (kind: PresetKind) => set(kind === "custom" ? { kind, cron: cronFor(form) } : { kind });
  return (
    <VStack gap={4}>
      <Selector label="Repeats" options={PRESET_OPTIONS} value={form.kind} onChange={(v) => pick(v as PresetKind)} width="100%" />
      {form.kind === "custom" ? (
        <TextInput
          label="Cron"
          value={form.cron}
          onChange={(cron) => set({ cron })}
          placeholder="0 8 * * 1-5"
          description="Five fields: minute hour day-of-month month day-of-week. For example 0 8 * * 1-5 is 08:00 on weekdays, 30 9 1 * * is 09:30 on the 1st."
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
        />
      ) : (
        <HStack gap={4} wrap="wrap" vAlign="end">
          <TimeInput label="At" value={form.time as ISOTimeString} onChange={(time) => time && set({ time })} hourFormat="24h" presentation="text-input" />
          {form.kind === "monthly" && (
            <NumberInput
              label="Day of the month"
              value={form.dayOfMonth}
              onChange={(dayOfMonth) => set({ dayOfMonth })}
              min={1}
              max={28}
              isIntegerOnly
              hasNumberSteppers
              description="1 to 28, so every month has it."
            />
          )}
        </HStack>
      )}
      {form.kind === "weekly" && <WeekdayPicker label="On" groupLabel="Days of the week" value={form.weekdays} onChange={(weekdays) => set({ weekdays })} />}
    </VStack>
  );
}

function NextRuns({ preview, loading, timezone }: { preview?: SchedulePreview; loading: boolean; timezone: string }) {
  if (!preview) return loading ? <Spinner size="sm" label="Working out the next runs" /> : null;
  if (!preview.ok) return <Banner status="warning" title="This schedule cannot be used" description={preview.error} collapsible={false} />;
  return (
    <VStack gap={1}>
      <Text type="label">
        {preview.scheduleText} ({preview.timezone})
      </Text>
      <Text type="supporting">Next runs: {preview.nextRuns.map((iso) => runTime(iso, timezone)).join(" · ")}</Text>
    </VStack>
  );
}

/** Creates and edits a routine: what to do, when, where the report goes, its budget; and its runs. */
export function RoutineDrawer({ isOpen, routine, tab, onTabChange, timezone, emailReady, onClose, onChanged }: RoutineDrawerProps) {
  const save = useAction();
  const runNow = useAction();
  const [form, setForm] = useState<FormState>(() => initialForm(routine, timezone));
  const [emailError, setEmailError] = useState<string>();
  const [tried, setTried] = useState(false);
  const [version, setVersion] = useState(0);
  const isNew = routine === undefined;

  useEffect(() => {
    if (!isOpen) return;
    setForm(initialForm(routine, timezone));
    setEmailError(undefined);
    setTried(false);
    // Only when the drawer opens or switches routine: a reload of the same routine keeps the edits.
  }, [isOpen, routine?.id]);

  const cron = cronFor(form.schedule);
  const { preview, loading } = useSchedulePreview(cron, form.timezone, isOpen && tab === "routine");
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const onEmails = (items: SearchableItem[]) => {
    const next: SearchableItem[] = [];
    const bad: string[] = [];
    for (const item of items) {
      for (const part of item.label.split(/[\s,;]+/)) {
        const email = part.trim();
        if (!email) continue;
        if (!EMAIL_RE.test(email)) bad.push(email);
        else if (!next.some((e) => e.id === email.toLowerCase())) next.push({ id: email.toLowerCase(), label: email });
      }
    }
    set({ emails: next.slice(0, 20) });
    setEmailError(bad.length ? `${bad.join(", ")} ${bad.length === 1 ? "is not an email address" : "are not email addresses"}.` : undefined);
  };

  const slack = form.slack.trim();
  const errors = {
    name: !form.name.trim() ? "Give the routine a name." : form.name.trim().length > 80 ? "Use at most 80 characters." : undefined,
    instruction: form.instruction.trim().length < 10 ? "Say what Pointer should do on each run, in at least 10 characters." : undefined,
    slack: slack && !SLACK_RE.test(slack) ? "Slack ids look like C012ABCDEF (a channel) or U012ABCDEF (a person)." : undefined,
    deliver: !form.emails.length && !slack && !form.console ? "Choose at least one place for the reports." : undefined,
    budget: !(form.budgetUsd >= 0.05 && form.budgetUsd <= 20) ? "From $0.05 to $20." : undefined,
    timeout: !(Number.isInteger(form.timeoutMin) && form.timeoutMin >= 1 && form.timeoutMin <= ROUTINE_TIMEOUT_MAX_MIN) ? `From 1 to ${ROUTINE_TIMEOUT_MAX_MIN} minutes.` : undefined,
  };
  const invalid = Object.values(errors).some(Boolean) || Boolean(emailError) || preview?.ok === false;
  const shown = (message: string | undefined) => (tried && message ? { type: "error" as const, message } : undefined);

  const submit = async () => {
    setTried(true);
    if (invalid) return;
    let saved: RoutineView | undefined;
    const ok = await save.run(
      async () => {
        const res = await api.post<{ routine: RoutineView }>(isNew ? ROUTINES_PATH : routinePath(routine.id), bodyOf(form));
        saved = res.routine;
      },
      { success: isNew ? `Created “${form.name.trim()}”.` : "Saved." },
    );
    if (ok) await onChanged(saved);
  };

  const remove = async () => {
    if (!routine) return;
    const ok = await save.run(() => api.post(`${routinePath(routine.id)}/delete`), { success: `Deleted “${routine.name}”.` });
    if (ok) {
      onClose();
      await onChanged();
    }
  };

  const startRun = async () => {
    if (!routine) return;
    const ok = await runNow.run(() => api.post(`${routinePath(routine.id)}/run`), { success: "Running now. The report appears under Runs and goes to the routine's recipients." });
    if (ok) {
      onTabChange("runs");
      setVersion((v) => v + 1);
      await onChanged(routine);
    }
  };

  const title = isNew ? "New routine" : routine.name;
  const subtitle = isNew
    ? "Pointer does this on its own, on schedule, and reports back."
    : `${routine.scheduleText} (${routine.schedule.timezone})${routine.enabled ? (routine.nextRuns[0] ? ` · next ${runTime(routine.nextRuns[0], routine.schedule.timezone)}` : "") : " · paused"}`;

  return (
    <Drawer isOpen={isOpen} onOpenChange={(open) => !open && onClose()} label={title} purpose="form" width={680} experimental={{ isFullWidthOnMobile: true }}>
      <Layout
        header={
          <VStack gap={3}>
            <DrawerHeader title={title} subtitle={subtitle} onOpenChange={(open) => !open && onClose()} />
            {!isNew && (
              <TabList value={tab} onChange={(v) => onTabChange(v as DrawerTab)} hasDivider isFullBleed>
                <Tab value="routine" label="Routine" />
                <Tab value="runs" label="Runs" />
              </TabList>
            )}
          </VStack>
        }
        content={
          <LayoutContent>
            {!isNew && tab === "runs" ? (
              <RunHistory routine={routine} version={version} />
            ) : (
              <VStack gap={6}>
                <VStack gap={4}>
                  <TextInput label="Name" value={form.name} onChange={(name) => set({ name })} placeholder="Daily GitHub digest" isRequired status={shown(errors.name)} hasAutoFocus={isNew} />
                  <TextArea
                    label="What to do each time"
                    value={form.instruction}
                    onChange={(instruction) => set({ instruction })}
                    rows={7}
                    maxLength={8000}
                    isRequired
                    placeholder="Summarise what happened on GitHub in acme/web and acme/api: pull requests merged and waiting for review, issues opened and closed. Link each one."
                    description="Written for Pointer to follow alone. Each run is read-only: it looks things up and writes a report, and changes nothing. It covers what happened since the last successful run (the last 24 hours the first time)."
                    status={shown(errors.instruction)}
                  />
                </VStack>

                <Divider />
                <VStack gap={4}>
                  <Heading level={4}>When</Heading>
                  <ScheduleFields form={form.schedule} onChange={(schedule) => set({ schedule })} />
                  <TimezoneSelector label="Timezone" value={form.timezone} onChange={(tz) => set({ timezone: tz })} description={`The organisation's timezone is ${timezone}.`} />
                  <NextRuns preview={preview} loading={loading} timezone={form.timezone} />
                </VStack>

                <Divider />
                <VStack gap={4}>
                  <Heading level={4}>Where the report goes</Heading>
                  <Text type="supporting">Only to these recipients. Pointer never sends the report anywhere else.</Text>
                  <Tokenizer
                    label="Email"
                    description="Type an address and press Enter. Up to 20."
                    searchSource={noSuggestions}
                    value={form.emails}
                    onChange={onEmails}
                    hasCreate
                    hasClear
                    isOptional
                    placeholder={form.emails.length ? undefined : "name@example.com"}
                    status={emailError ? { type: "error", message: emailError } : undefined}
                  />
                  {form.emails.length > 0 && !emailReady && (
                    <Banner
                      status="warning"
                      title="Email is not set up yet"
                      description="Reports are emailed once Email is set up on the Integrations page; until then they go to the other recipients."
                      collapsible={false}
                      endContent={<Button label="Set up Email" size="sm" href={href("integrations", "email")} />}
                    />
                  )}
                  <TextInput
                    label="Slack channel or person"
                    value={form.slack}
                    onChange={(v) => set({ slack: v.trim().toUpperCase() })}
                    placeholder="C012ABCDEF or U012ABCDEF"
                    description="A channel id (invite Pointer to the channel first) or a person's member id. Long reports are split into several messages."
                    isOptional
                    autoCapitalize="characters"
                    hasAutoCorrect={false}
                    hasSpellCheck={false}
                    status={shown(errors.slack) ?? (slack && !SLACK_RE.test(slack) ? { type: "warning", message: errors.slack } : undefined)}
                  />
                  <Switch
                    label="Keep the reports in the console"
                    description="Each report is added to one conversation for this routine on the Chat page, so they read like a thread."
                    value={form.console}
                    onChange={(on) => set({ console: on })}
                  />
                  {tried && errors.deliver && <Text type="supporting">{errors.deliver}</Text>}
                </VStack>

                <Divider />
                <NumberInput
                  label="Budget per run"
                  units="USD"
                  value={form.budgetUsd}
                  onChange={(budgetUsd) => set({ budgetUsd })}
                  min={0.05}
                  max={20}
                  step={0.05}
                  hasNumberSteppers
                  description="A run stops when it has used this much. Runs count toward the monthly spending cap; a run is skipped when the cap is used up."
                  status={shown(errors.budget)}
                />
                <NumberInput
                  label="Time limit per run"
                  units="min"
                  value={form.timeoutMin}
                  onChange={(timeoutMin) => set({ timeoutMin })}
                  min={1}
                  max={ROUTINE_TIMEOUT_MAX_MIN}
                  step={1}
                  hasNumberSteppers
                  description={`A run that takes longer stops and is marked failed. Chat replies have 8 minutes; a routine can have up to ${ROUTINE_TIMEOUT_MAX_MIN}, since nobody waits on it.`}
                  status={shown(errors.timeout)}
                />
                {!isNew && routine.conversationId && (
                  <Text type="supporting">
                    Reports so far are in <Link href={href("chat", routine.conversationId)}>this routine's conversation</Link>.
                  </Text>
                )}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StackItem size="fill">{!isNew && tab === "routine" && <ConfirmButton label="Delete" confirmLabel="Click again to delete" size="md" onConfirm={remove} />}</StackItem>
              {!isNew && (
                <Button
                  label="Run now"
                  icon={<Icon icon={PlayIcon} />}
                  isLoading={runNow.pending}
                  isDisabled={routine.running}
                  clickAction={startRun}
                />
              )}
              {(isNew || tab === "routine") && (
                <>
                  <Button label="Cancel" variant="secondary" onClick={onClose} />
                  <Button label={isNew ? "Create routine" : "Save"} variant="primary" isLoading={save.pending} clickAction={submit} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}
