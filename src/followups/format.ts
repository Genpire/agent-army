/**
 * How a follow-up reads: one line per item, the same in Pointer's tool, the
 * morning brief, the reminders and the reply to "done 3". Each starts with the
 * item's number as #n, the number the owner closes it by.
 *
 * Titles, names and details may come from other people's messages (outside
 * content): on Slack they are plain text (they can neither mention nor link).
 */
import type { FollowupItem, FollowupSource } from "./types.js";
import { age, everyText, shortTime } from "./time.js";

/** Where the text goes: Slack mrkdwn, the console's Markdown, or plain text for Pointer. */
export type Target = "slack" | "markdown" | "text";

const SOURCE_LABEL: Record<FollowupSource, string> = { owner: "", slack: "Slack", gmail: "Gmail", calendar: "Calendar", pointer: "found by Pointer" };

/** Text from elsewhere, safe on the target: on Slack no mentions, links or entities of its own; nowhere a Markdown link. */
export function safe(text: string, target: Target): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/\]\(/g, "] (");
  return target === "slack" ? line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : line;
}

export const bold = (text: string, target: Target) => (target === "slack" ? `*${text}*` : target === "markdown" ? `**${text}**` : text);

/** A link to an http(s) address, or nothing. */
export function linkTo(url: string | undefined, label: string, target: Target): string {
  if (!url || !/^https?:\/\/\S+$/i.test(url)) return "";
  if (target === "slack") return `<${url.replace(/[<>|]/g, "")}|${label}>`;
  if (target === "markdown") return `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  return url;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** When an item is due, snoozed or repeating, in words; "" when none of these. */
export function dueText(item: FollowupItem, now: Date, timeZone: string): string {
  if (item.status === "done") return item.doneAt ? `closed ${shortTime(new Date(item.doneAt), timeZone)}` : "closed";
  const parts: string[] = [];
  const snoozed = item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime() ? new Date(item.snoozedUntil) : undefined;
  if (snoozed) parts.push(`snoozed until ${shortTime(snoozed, timeZone)}`);
  else if (item.remindAt && Number.isFinite(Date.parse(item.remindAt))) {
    const at = new Date(item.remindAt);
    parts.push(at.getTime() > now.getTime() ? `due ${shortTime(at, timeZone)}` : `overdue since ${shortTime(at, timeZone)}`);
  }
  if (item.repeatMin) parts.push(everyText(item.repeatMin));
  return parts.join(", ");
}

export interface LineOptions {
  timeZone: string;
  now: Date;
  target: Target;
  /** Characters of the title shown. */
  titleMax?: number;
}

/** "#12 Reply to Omar about the invoice · Omar · Slack · 3d · due Tue, Nov 24, 15:00 · you replied · link" */
export function itemLine(item: FollowupItem, o: LineOptions): string {
  const meta = [
    item.from ? safe(clip(item.from, 60), o.target) : "",
    SOURCE_LABEL[item.source] ?? "",
    age(new Date(item.createdAt), o.now),
    dueText(item, o.now, o.timeZone),
    item.answeredAt && item.status === "open" ? "you replied" : "",
    o.target === "text" ? "" : linkTo(item.link, "open", o.target),
  ].filter(Boolean);
  const head = `${bold(`#${item.n}`, o.target)} ${safe(clip(item.title, o.titleMax ?? 140), o.target)}`;
  const tail = o.target === "text" && item.link && /^https?:\/\//i.test(item.link) ? ` · ${item.link}` : "";
  return `${head}${meta.length ? ` · ${meta.join(" · ")}` : ""}${tail}`;
}

/** "#3 Reply to Omar…" for a short confirmation. */
export const shortLabel = (item: Pick<FollowupItem, "n" | "title">, target: Target): string => `#${item.n} ${safe(clip(item.title, 60), target)}`;

/** "`done 3 7`": how to close these items, with their own numbers. */
export function closeHint(numbers: number[], target: Target): string {
  const shown = numbers.slice(0, 2);
  const example = `done ${(shown.length ? shown : [3, 5]).join(" ")}`;
  const code = target === "text" ? `"${example}"` : `\`${example}\``;
  return `Reply ${code} to close ${numbers.length === 1 ? "it" : "items"} when ${numbers.length === 1 ? "it is" : "they are"} done.`;
}
