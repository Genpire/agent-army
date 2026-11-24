import { Button } from "@astryxdesign/core/Button";
import { type ISODateTimeString, DateTimeInput } from "@astryxdesign/core/DateTimeInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAction } from "../../lib/useAction";
import { DETAIL_MAX, FOLLOWUPS_PATH, type FollowupDraft, type FollowupItem, type FollowupSaved, REPEAT_OPTIONS, TITLE_MAX, fromLocalInput, toLocalInput } from "./model";

export interface AddFollowupDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** The organisation's timezone: the reminder time is picked in it. */
  timezone: string;
  /** Called with the new item once the server stored it. */
  onAdded: (item: FollowupItem) => void | Promise<void>;
}

/** Adds one of the owner's own follow-ups: a title, optional details, and optionally its own reminder (once or repeating). */
export function AddFollowupDialog({ isOpen, onOpenChange, timezone, onAdded }: AddFollowupDialogProps) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [remindAt, setRemindAt] = useState<string>();
  const [repeat, setRepeat] = useState("0");
  const [tried, setTried] = useState(false);
  const { run, pending } = useAction();
  const showToast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    setTitle("");
    setDetail("");
    setRemindAt(undefined);
    setRepeat("0");
    setTried(false);
  }, [isOpen]);

  const remindDate = remindAt ? fromLocalInput(remindAt, timezone) : undefined;
  const errors = {
    title: !title.trim() ? "Say what to follow up on." : title.trim().length > TITLE_MAX ? `Use at most ${TITLE_MAX} characters.` : undefined,
    remindAt: remindDate && remindDate.getTime() <= Date.now() ? "Pick a time in the future." : undefined,
  };
  const shown = (message: string | undefined) => (tried && message ? { type: "error" as const, message } : undefined);

  const close = () => onOpenChange(false);
  const submit = async () => {
    setTried(true);
    if (errors.title || errors.remindAt) return;
    const body: FollowupDraft = { title: title.trim() };
    if (detail.trim()) body.detail = detail.trim();
    if (remindDate) {
      body.remindAt = remindDate.toISOString();
      if (Number(repeat) > 0) body.repeatMin = Number(repeat);
    }
    let added: FollowupItem | undefined;
    const ok = await run(async () => {
      added = (await api.post<FollowupSaved>(FOLLOWUPS_PATH, body)).item;
    });
    if (!ok || !added) return;
    showToast({ body: `Added #${added.n}. Close it from Slack with “done ${added.n}”.`, type: "info" });
    close();
    await onAdded(added);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title="Add a follow-up" subtitle="It stays open until you mark it done, here or from Slack." onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="What to follow up on"
                value={title}
                onChange={setTitle}
                placeholder="Call Sam about the Q3 invoice"
                isRequired
                hasAutoFocus
                status={shown(errors.title)}
              />
              <TextArea label="Details" value={detail} onChange={setDetail} rows={3} maxLength={DETAIL_MAX} isOptional width="100%" />
              <HStack gap={4} wrap="wrap" vAlign="start">
                <DateTimeInput
                  label="Remind me at"
                  description={`In ${timezone.replace(/_/g, " ")}. Without a time, it is in your digests and morning brief.`}
                  value={remindAt as ISODateTimeString | undefined}
                  onChange={(v) => setRemindAt(v ?? undefined)}
                  min={toLocalInput(new Date(), timezone) as ISODateTimeString}
                  hourFormat="24h"
                  timeOptionInterval={15}
                  hasClear
                  isOptional
                  status={shown(errors.remindAt)}
                />
                <Selector
                  label="Repeat"
                  options={REPEAT_OPTIONS}
                  value={repeat}
                  onChange={setRepeat}
                  isDisabled={!remindAt}
                  disabledMessage="Pick a reminder time first."
                  description="Until you mark it done."
                />
              </HStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={close} />
              <Button label="Add" variant="primary" isLoading={pending} clickAction={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
