import { Button } from "@astryxdesign/core/Button";
import { type ISODateTimeString, DateTimeInput } from "@astryxdesign/core/DateTimeInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { useEffect, useState } from "react";
import { type FollowupItem, fromLocalInput, snoozeChoices, toLocalInput } from "./model";

export interface SnoozeDialogProps {
  /** The item to snooze; undefined = closed. */
  item: FollowupItem | undefined;
  /** The organisation's timezone: the time is picked in it. */
  timezone: string;
  onClose: () => void;
  /** Snoozes it until the ISO time; the dialog closes when it succeeded. */
  onSnooze: (item: FollowupItem, until: string) => Promise<boolean>;
}

/** Snooze until a time the owner picks (the Snooze menu's "Pick a time…"). */
export function SnoozeDialog({ item, timezone, onClose, onSnooze }: SnoozeDialogProps) {
  const [until, setUntil] = useState<string>();
  // The dialog keeps the last item while it animates out.
  const [shown, setShown] = useState<FollowupItem>();

  useEffect(() => {
    if (!item) return;
    setShown(item);
    // Starts on tomorrow morning, the most common pick.
    const morning = snoozeChoices(timezone).find((c) => c.key === "morning");
    setUntil(morning ? toLocalInput(new Date(morning.until), timezone) : undefined);
  }, [item, timezone]);

  const date = until ? fromLocalInput(until, timezone) : undefined;
  const error = date && date.getTime() <= Date.now() ? "Pick a time in the future." : undefined;
  const onOpenChange = (open: boolean) => !open && onClose();
  const current = item ?? shown;

  return (
    <Dialog isOpen={item !== undefined} onOpenChange={onOpenChange} purpose="form" width={440}>
      <Layout
        header={
          <DialogHeader
            title={current ? `Snooze #${current.n}` : "Snooze"}
            subtitle={current ? `“${current.title}” stays open and is left out of reminders until then.` : undefined}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <DateTimeInput
              label="Until"
              description={`In ${timezone.replace(/_/g, " ")}.`}
              value={until as ISODateTimeString | undefined}
              onChange={(v) => setUntil(v ?? undefined)}
              min={toLocalInput(new Date(), timezone) as ISODateTimeString}
              hourFormat="24h"
              timeOptionInterval={15}
              isRequired
              width="100%"
              status={error ? { type: "error", message: error } : undefined}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Snooze"
                variant="primary"
                isDisabled={!date || Boolean(error)}
                clickAction={async () => {
                  if (!item || !date || error) return;
                  if (await onSnooze(item, date.toISOString())) onClose();
                }}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
