/**
 * The drawer's schedule presets and the cron they stand for. A saved cron
 * opens on the preset that wrote it, or as a custom cron.
 */

export type PresetKind = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface ScheduleForm {
  kind: PresetKind;
  /** "HH:MM", 24-hour. */
  time: string;
  /** Weekly: day numbers, 0 = Sunday (components/WeekdayPicker). */
  weekdays: number[];
  /** Monthly: 1-28, so every month has it. */
  dayOfMonth: number;
  /** Custom: the cron as typed. */
  cron: string;
}

export const PRESET_OPTIONS: { value: PresetKind; label: string; description: string }[] = [
  { value: "daily", label: "Every day at…", description: "Once a day" },
  { value: "weekdays", label: "Weekdays at…", description: "Monday to Friday" },
  { value: "weekly", label: "Weekly on…", description: "On the days you pick" },
  { value: "monthly", label: "Monthly on…", description: "On one day of the month" },
  { value: "custom", label: "Custom cron", description: "minute hour day month weekday" },
];

export const DEFAULT_FORM: ScheduleForm = { kind: "daily", time: "08:00", weekdays: [1], dayOfMonth: 1, cron: "0 8 * * *" };

const pad = (n: number) => String(n).padStart(2, "0");

function timeParts(time: string): { h: number; m: number } {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  const h = match ? Math.min(23, Number(match[1])) : 8;
  const m = match ? Math.min(59, Number(match[2])) : 0;
  return { h, m };
}

/** The cron a preset stands for. */
export function cronFor(form: ScheduleForm): string {
  if (form.kind === "custom") return form.cron.trim();
  const { h, m } = timeParts(form.time);
  switch (form.kind) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${[...new Set(form.weekdays)].sort((a, b) => a - b).join(",") || "1"}`;
    case "monthly":
      return `${m} ${h} ${Math.min(28, Math.max(1, Math.round(form.dayOfMonth)))} * *`;
  }
}

/** The preset that wrote `cron`, or a custom cron. */
export function formFor(cron: string): ScheduleForm {
  const c = cron.trim().replace(/\s+/g, " ");
  const base = { ...DEFAULT_FORM, cron: c };
  const m = c.match(/^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/);
  if (!m) return { ...base, kind: "custom" };
  const [, min, hour, dom, dow] = m as unknown as [string, string, string, string, string];
  if (Number(min) > 59 || Number(hour) > 23) return { ...base, kind: "custom" };
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === "*" && dow === "*") return { ...base, kind: "daily", time };
  if (dom === "*" && dow === "1-5") return { ...base, kind: "weekdays", time };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) return { ...base, kind: "weekly", time, weekdays: dow.split(",").map(Number) };
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 28) return { ...base, kind: "monthly", time, dayOfMonth: Number(dom) };
  return { ...base, kind: "custom" };
}
