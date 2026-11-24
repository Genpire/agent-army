/**
 * What reminders need, said where it matters: Slack (reminders are DMs from
 * Pointer to the owner's own account) and the Google Calendar and Gmail apps
 * (the brief's events, meeting reminders, Gmail threads), from the
 * configuration the console already has.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/VStack";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { StatusLine } from "../integrations/parts";
import { type AppReadiness, slackReadiness } from "./model";

/** A warning above the page when Pointer cannot DM the owner yet; nothing when it can. */
export function SlackDmNote() {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  const state = slackReadiness(config);
  if (state === "ready") return null;
  return (
    <Banner
      status="warning"
      title={state === "no-slack" ? `Reminders are sent as DMs from ${pointer}: connect Slack` : `Reminders are sent as DMs from ${pointer}: connect your Slack account`}
      description={
        state === "no-slack"
          ? `Connect Slack, then your own Slack account, so ${pointer} can DM you the morning brief and reminders. Until then, your follow-ups are only on this page.`
          : `${pointer} DMs your own account, so it needs to know which one is yours. Until then, your follow-ups are only on this page.`
      }
      collapsible={false}
      endContent={<Button label={state === "no-slack" ? "Connect Slack" : "Connect your account"} size="sm" href={href("integrations", "slack")} />}
    />
  );
}

/** Whether a Google app (Calendar, Gmail) can be read, and the way to fix it when it cannot. */
export function AppNote({ readiness, name, without }: { readiness: AppReadiness; name: string; /** What is missing until it is connected. */ without: string }) {
  if (readiness.state === "ready") return <StatusLine tone="success" text={`Using your ${name}`} />;
  const { text, link, to } =
    readiness.state === "missing"
      ? { text: `${name} is not connected: ${without}`, link: `Add ${name} on the Integrations page`, to: href("integrations") }
      : readiness.state === "signed-out"
        ? { text: `${name} is added but not signed in: ${without}`, link: `Sign in to ${name}`, to: href("integrations", "apps", readiness.appId) }
        : { text: `${name} is turned off: ${without}`, link: `Turn ${name} on`, to: href("integrations", "apps", readiness.appId) };
  return (
    <VStack gap={1}>
      <StatusLine tone="neutral" text={text} />
      <Link href={to} type="supporting" weight="semibold" isStandalone>
        {link}
      </Link>
    </VStack>
  );
}
