import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { VStack } from "@astryxdesign/core/VStack";

/** The days of the week, Monday first; `value` is the cron and Date numbering, 0 = Sunday. */
export const WEEKDAYS = [
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
  { value: 0, short: "Sun", label: "Sunday" },
];

export interface WeekdayPickerProps {
  /** The visible label above the toggles. */
  label: string;
  /** The toggles' accessible name, when the visible label is too short on its own ("On" → "Days of the week"). */
  groupLabel?: string;
  /** Day numbers, 0 = Sunday … 6 = Saturday. */
  value: number[];
  /** Called with the picked days; never with none (the last day cannot be turned off). */
  onChange: (days: number[]) => void;
  isDisabled?: boolean;
}

/** Mon–Sun toggles for picking days of the week, at least one. */
export function WeekdayPicker({ label, groupLabel = label, value, onChange, isDisabled }: WeekdayPickerProps) {
  // Seven three-letter toggles do not fit a phone's width: two letters do.
  const isNarrow = useMediaQuery("(max-width: 480px)");
  return (
    <VStack gap={2}>
      <Text type="label">{label}</Text>
      <ToggleButtonGroup
        label={groupLabel}
        type="multiple"
        size="sm"
        isDisabled={isDisabled}
        value={value.map(String)}
        onChange={(v: string | string[] | null) => {
          const days = (Array.isArray(v) ? v : []).map(Number);
          if (days.length) onChange(days.sort((a, b) => a - b));
        }}>
        {WEEKDAYS.map((d) => (
          <ToggleButton key={d.value} value={String(d.value)} label={d.label} tooltip={d.label}>
            {isNarrow ? d.short.slice(0, 2) : d.short}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </VStack>
  );
}
