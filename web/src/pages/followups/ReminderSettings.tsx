/**
 * The owner's reminder settings (config.followups): the morning brief (on,
 * time, days), a reminder before each meeting, and following Gmail. Each
 * control saves as it changes, like the Slack account's switches; the time
 * saves once it has stopped changing.
 */
import { Divider } from "@astryxdesign/core/Divider";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { type ISOTimeString, TimeInput } from "@astryxdesign/core/TimeInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useEffect, useRef, useState } from "react";
import { WeekdayPicker } from "../../components/WeekdayPicker";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { SettingsSection } from "../settings/parts";
import { type FollowupSettings, type FollowupSettingsSaved, SETTINGS_PATH, appReadiness, meetingOptions } from "./model";
import { AppNote } from "./ReadinessNotes";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** How long the brief's time waits after the last change before it is saved. */
const TIME_SAVE_DELAY_MS = 800;

/** The settings as the server last stored them, changed at once on screen and put back if the save fails. */
function useSettingsSave(saved: FollowupSettings) {
  const { refresh } = useConfig();
  const { run } = useAction();
  const [settings, setSettings] = useState(saved);
  const latest = useRef(settings);
  latest.current = settings;
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setSettings(saved);
    // Only when the stored settings change (a save here, or elsewhere: asking Pointer).
  }, [savedKey]);

  const save = useCallback(
    async (patch: Partial<FollowupSettings>, success: string) => {
      const before = latest.current;
      setSettings({ ...before, ...patch });
      let stored: FollowupSettings | undefined;
      const ok = await run(
        async () => {
          stored = (await api.post<FollowupSettingsSaved>(SETTINGS_PATH, patch)).settings;
        },
        { success },
      );
      if (ok && stored) {
        setSettings(stored);
        await refresh();
      } else if (!ok) {
        setSettings(before);
      }
    },
    [run, refresh],
  );
  return { settings, save };
}

export function ReminderSettings({ saved }: { saved: FollowupSettings }) {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  const { settings, save } = useSettingsSave(saved);
  const brief = settings.morningBrief;
  const calendar = appReadiness(config, "google-calendar");
  const gmail = appReadiness(config, "gmail");

  // The brief's time, as typed; saved once it is a whole time and has stopped changing.
  const [time, setTime] = useState(brief.time);
  useEffect(() => setTime(brief.time), [brief.time]);
  useEffect(() => {
    if (time === brief.time || !TIME_RE.test(time)) return;
    const timer = setTimeout(() => void save({ morningBrief: { ...brief, time } }, `The morning brief comes at ${time}.`), TIME_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [time, brief, save]);

  const tz = config.timezone.replace(/_/g, " ");

  return (
    <VStack gap={8}>
      <SettingsSection
        title="Morning brief"
        description={`A DM from ${pointer} with today's calendar and your open follow-ups, so the day starts with what is waiting. Times are in ${tz} (Settings).`}>
        <Switch
          label="Send me a morning brief"
          value={brief.enabled}
          changeAction={(enabled) => save({ morningBrief: { ...brief, enabled } }, enabled ? "The morning brief is on." : "The morning brief is off.")}
        />
        <TimeInput
          label="At"
          value={time as ISOTimeString}
          onChange={(v) => v && setTime(v.slice(0, 5))}
          hourFormat="24h"
          presentation="text-input"
          isDisabled={!brief.enabled}
        />
        <WeekdayPicker
          label="On"
          groupLabel="Days the morning brief is sent"
          value={brief.days}
          isDisabled={!brief.enabled}
          onChange={(days) => void save({ morningBrief: { ...brief, days } }, "Saved the brief's days.")}
        />
        <AppNote readiness={calendar} name="Google Calendar" without="the brief has your follow-ups only." />
      </SettingsSection>

      <Divider />
      <SettingsSection title="Before meetings" description={`A DM from ${pointer} shortly before each event on your calendar, with its link. Events you declined are left out.`}>
        <Selector
          label="Remind me"
          options={meetingOptions(settings.meetingReminderMin)}
          value={String(settings.meetingReminderMin)}
          onChange={(v) => {
            const min = Number(v);
            void save({ meetingReminderMin: min }, min ? `Reminders ${min} minutes before each meeting.` : "No reminders before meetings.");
          }}
          width="100%"
        />
        <AppNote readiness={calendar} name="Google Calendar" without="there are no meetings to remind you of." />
      </SettingsSection>

      <Divider />
      <SettingsSection
        title="Gmail"
        description={`${pointer} reads threads from people (not lists or automated mail) and adds the ones waiting on your reply here. It never sends, changes or deletes mail.`}>
        <Switch
          label="Follow my Gmail"
          description="Off: no new items from Gmail. The ones already here stay until you close them."
          value={settings.trackGmail}
          changeAction={(trackGmail) => save({ trackGmail }, trackGmail ? `${pointer} follows your Gmail.` : `${pointer} no longer follows your Gmail.`)}
        />
        <AppNote readiness={gmail} name="Gmail" without="nothing is followed." />
      </SettingsSection>
    </VStack>
  );
}
