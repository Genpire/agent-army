import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { BellAlertIcon, CheckCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { PageFrame } from "../../components/PageFrame";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { type Polled, usePolled } from "../activity/usePolled";
import { AddFollowupDialog } from "./AddFollowupDialog";
import { FollowupList as ItemList } from "./FollowupList";
import { type FollowupItem, type FollowupList, type FollowupSaved, atText, isSnoozed, itemPath, listPath } from "./model";
import { SlackDmNote } from "./ReadinessNotes";
import { ReminderSettings } from "./ReminderSettings";
import { SnoozeDialog } from "./SnoozeDialog";
import { useOptimisticItems } from "./useOptimisticItems";

/** The page's sections, each its own route: `#/followups` (open), `#/followups/done`, `#/followups/reminders`. */
const TABS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "reminders", label: "Reminders" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

/** How often the lists are read again: items arrive as Pointer reads Slack and Gmail, and the owner closes them from Slack too. */
const EVERY_MS = 30_000;

function LoadError({ what, polled }: { what: string; polled: Polled<unknown> }) {
  return (
    <Banner
      status="error"
      title={`Couldn't load ${what}`}
      description={polled.error}
      collapsible={false}
      endContent={<Button label="Try again" size="sm" clickAction={polled.reload} />}
    />
  );
}

/** The owner's closed items, newest first, each with Reopen. */
function DoneTab({ timezone, pointer, onReopened }: { timezone: string; pointer: string; onReopened: () => Promise<void> }) {
  const done = usePolled<FollowupList>(listPath("done"), EVERY_MS);
  const optimistic = useOptimisticItems(done.data?.items);
  const action = useAction();
  const items = useMemo(() => [...optimistic.shown].sort((a, b) => Date.parse(b.doneAt ?? "") - Date.parse(a.doneAt ?? "")), [optimistic.shown]);

  const reopen = async (item: FollowupItem) => {
    optimistic.set(item.n, { kind: "hide" });
    const ok = await action.run(() => api.post(itemPath(item.n, "reopen")), { success: `Reopened #${item.n}: it is back under Open.` });
    if (!ok) optimistic.clear(item.n);
    await Promise.all([done.reload(), onReopened()]);
  };

  if (done.error && !done.data) return <LoadError what="the done follow-ups" polled={done} />;
  if (!done.data) return <Spinner label="Loading the done follow-ups" />;
  if (!items.length) {
    return (
      <EmptyState
        icon={<Icon icon={CheckCircleIcon} size="lg" />}
        title="Nothing done yet"
        description="Items you close, here or from Slack, are kept here. Reopen one when it needs more of you."
      />
    );
  }
  return (
    <VStack gap={3}>
      <ItemList status="done" items={items} timezone={timezone} pointer={pointer} onReopen={reopen} />
      <Text type="supporting">{plural(items.length, "closed item")}.</Text>
    </VStack>
  );
}

/**
 * Follow-ups: what is waiting on the owner, from Slack, Gmail, their calendar
 * and what they ask Pointer to track, kept until they close it; and the
 * reminders' settings. Routes: #/followups, #/followups/done, #/followups/reminders.
 */
export default function FollowupsPage() {
  const { config } = useConfig();
  const route = useRoute();
  const showToast = useToast();
  const tab: TabValue = TABS.find((t) => t.value === route.rest[0])?.value ?? "open";
  const pointer = config.team.pointer.name;
  const timezone = config.timezone;
  const open = usePolled<FollowupList>(listPath("open"), EVERY_MS);
  const optimistic = useOptimisticItems(open.data?.items);
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [snoozing, setSnoozing] = useState<FollowupItem>();
  // The settings come with the configuration; a server that does not send them there yet sends them with the list.
  const saved = config.followups ?? open.data?.settings;

  // Snoozed items last: they are not for now.
  const items = useMemo(() => {
    const now = Date.now();
    return [...optimistic.shown].sort((a, b) => Number(isSnoozed(a, now)) - Number(isSnoozed(b, now)));
  }, [optimistic.shown]);

  const reopen = async (item: FollowupItem) => {
    optimistic.clear(item.n);
    await action.run(() => api.post(itemPath(item.n, "reopen")), { success: `Reopened #${item.n}.` });
    await open.reload();
  };

  const markDone = async (item: FollowupItem) => {
    optimistic.set(item.n, { kind: "hide" });
    const ok = await action.run(() => api.post(itemPath(item.n, "done")));
    if (!ok) {
      optimistic.clear(item.n);
      return;
    }
    let dismiss = () => {};
    dismiss = showToast({
      body: `Done: #${item.n} ${item.title}`,
      uniqueID: `followup-done-${item.n}`,
      endContent: (
        <Button
          label={`Undo: reopen #${item.n}`}
          size="sm"
          variant="ghost"
          onClick={() => {
            dismiss();
            void reopen(item);
          }}>
          Undo
        </Button>
      ),
    });
    void open.reload();
  };

  const snooze = async (item: FollowupItem, until: string): Promise<boolean> => {
    optimistic.set(item.n, { kind: "patch", patch: { snoozedUntil: until } });
    let stored: FollowupItem | undefined;
    const ok = await action.run(
      async () => {
        stored = (await api.post<FollowupSaved>(itemPath(item.n, "snooze"), { until })).item;
      },
      { success: `Snoozed #${item.n} until ${atText(until, timezone).replace(/^at /, "")}.` },
    );
    if (!ok) optimistic.clear(item.n);
    else if (stored) optimistic.set(item.n, { kind: "patch", patch: { snoozedUntil: stored.snoozedUntil } });
    void open.reload();
    return ok;
  };

  const addButton = <Button label="Add a follow-up" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={() => setAdding(true)} />;

  return (
    <PageFrame
      title="Follow-ups"
      description={`What is waiting on you: from Slack, Gmail, your calendar and what you ask ${pointer} to track. Each stays until you close it, and ${pointer} reminds you until then.`}
      actions={addButton}
      nav={
        <TabList value={tab} onChange={(value) => navigate("followups", ...(value === "open" ? [] : [value]))} hasDivider isFullBleed>
          {TABS.map((t) => (
            <Tab
              key={t.value}
              value={t.value}
              label={t.label}
              href={t.value === "open" ? href("followups") : href("followups", t.value)}
              endContent={t.value === "open" && items.length > 0 ? <Badge label={items.length} /> : undefined}
            />
          ))}
        </TabList>
      }>
      <VStack gap={6}>
        {tab !== "done" && <SlackDmNote />}

        {tab === "open" &&
          (open.error && !open.data ? (
            <LoadError what="your follow-ups" polled={open} />
          ) : !open.data ? (
            <Spinner label="Loading your follow-ups" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Icon icon={BellAlertIcon} size="lg" />}
              title="Nothing to follow up"
              description={`Items come from you (ask ${pointer} “remind me to call Sam at 3” or “track this”) and from ${pointer}, when a Slack message or an email waits on your reply. Each stays here until you close it: with Done, or from Slack by replying “done 3 5” to ${pointer}.`}
              actions={<Button label="Add a follow-up" variant="secondary" icon={<Icon icon={PlusIcon} />} onClick={() => setAdding(true)} />}
            />
          ) : (
            <VStack gap={3}>
              <ItemList status="open" items={items} timezone={timezone} pointer={pointer} onDone={markDone} onSnooze={(item, until) => snooze(item, until).then(() => undefined)} onPickSnooze={setSnoozing} />
              <Text type="supporting">
                {plural(items.length, "open item")}. Close several at once from Slack: reply <Code size="inherit">done 3 5</Code> to {pointer}. Times are in {timezone.replace(/_/g, " ")}.
              </Text>
            </VStack>
          ))}

        {tab === "done" && <DoneTab timezone={timezone} pointer={pointer} onReopened={open.reload} />}

        {tab === "reminders" &&
          (saved ? (
            <ReminderSettings saved={saved} />
          ) : open.error ? (
            <LoadError what="the reminder settings" polled={open} />
          ) : (
            <Spinner label="Loading the reminder settings" />
          ))}
      </VStack>

      <AddFollowupDialog
        isOpen={adding}
        onOpenChange={setAdding}
        timezone={timezone}
        onAdded={async () => {
          if (tab !== "open") navigate("followups");
          await open.reload();
        }}
      />
      <SnoozeDialog item={snoozing} timezone={timezone} onClose={() => setSnoozing(undefined)} onSnooze={snooze} />
    </PageFrame>
  );
}
