import { Button } from "@astryxdesign/core/Button";
import { useEffect, useState } from "react";

export interface ConfirmButtonProps {
  /** The action's label, e.g. "Remove". */
  label: string;
  /** Shown after the first click, e.g. "Click again to remove". */
  confirmLabel?: string;
  /** Runs on the second click within a few seconds. */
  onConfirm: () => void | Promise<void>;
  size?: "sm" | "md";
  isDisabled?: boolean;
}

/**
 * A destructive action that takes two clicks: the first arms it (the label
 * changes), the second runs it. It disarms itself after 4 seconds. Used
 * instead of a dialog for removing rows.
 */
export function ConfirmButton({ label, confirmLabel = `Click again to ${label.toLowerCase()}`, onConfirm, size = "sm", isDisabled }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <Button
      label={armed ? confirmLabel : label}
      variant={armed ? "destructive" : "ghost"}
      size={size}
      isDisabled={isDisabled}
      clickAction={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        await onConfirm();
      }}
    />
  );
}
