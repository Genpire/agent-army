/**
 * Which real source a follow-up's link belongs to, by its address: a Slack
 * permalink, a Gmail thread, a Google Calendar event or Meet link. An item
 * Pointer found may carry only such a link without the owner's yes (tools.ts,
 * tool-names.ts followupAddNeedsYes): what it read could be a planted message
 * whose "Re-verify your account" link would otherwise sit in every brief,
 * labelled as something Pointer found.
 */

/** The sources a link can be tied to. */
export type LinkSource = "slack" | "gmail" | "calendar";

const FITS: Record<LinkSource, (u: URL) => boolean> = {
  slack: (u) => u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"),
  gmail: (u) => u.hostname === "mail.google.com",
  calendar: (u) => u.hostname === "calendar.google.com" || u.hostname === "meet.google.com" || (u.hostname === "www.google.com" && u.pathname.startsWith("/calendar")),
};

/** The source an https link belongs to; undefined for any other link (or not a link). */
export function linkSource(link: string): LinkSource | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  return (Object.keys(FITS) as LinkSource[]).find((source) => FITS[source](url));
}
