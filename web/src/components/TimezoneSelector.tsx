import { Selector, type SelectorOptionData } from "@astryxdesign/core/Selector";
import { useMemo } from "react";

/** Every IANA timezone the browser knows, UTC first; a saved zone the browser does not list is kept as an option. */
export function timeZoneOptions(current?: string): SelectorOptionData[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // very old browsers: only UTC and the saved zone
  }
  const all = ["UTC", ...zones.filter((z) => z !== "UTC")];
  if (current && !all.includes(current)) all.unshift(current);
  return all.map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
}

/** The browser's own timezone, a good first suggestion. */
export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export interface TimezoneSelectorProps {
  label: string;
  value: string;
  onChange: (timezone: string) => void;
  description?: string;
  status?: { type: "error" | "warning" | "success"; message?: string };
  isDisabled?: boolean;
}

/** A searchable list of IANA timezones (Europe/London, America/New_York…). */
export function TimezoneSelector({ label, value, onChange, description, status, isDisabled }: TimezoneSelectorProps) {
  const options = useMemo(() => timeZoneOptions(value), [value]);
  return (
    <Selector
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      hasSearch
      searchPlaceholder="Search, e.g. London or New York"
      description={description}
      status={status}
      isDisabled={isDisabled}
      width="100%"
    />
  );
}
