import type { Config } from "../core/config.js";
import type { PointerRequest } from "../chat/pointer-types.js";

/**
 * The owner's own Slack account (config.slack.user): a user token next to the
 * bot's. With it Pointer reads what reaches the owner (DMs, mentions, the
 * threads they are in: slack/inbox.ts) and, when they allow it, sends as them
 * (slack_send_message with as "me").
 *
 * Only the owner may use it: in the admin console (its only user is the
 * owner), in a routine (the owner made it; routines run read-only), or from
 * Slack by the very user the token belongs to. Anyone else talking to Pointer
 * never gets these tools or hears of the account.
 */

/** User scopes the app asks for (the manifest's oauth_config.scopes.user). */
export const SLACK_USER_SCOPES = [
  // Send as the owner: DMs and posts where they are a member.
  "chat:write",
  "im:write",
  // Read what reaches them.
  "im:history",
  "mpim:history",
  "channels:history",
  "groups:history",
  "im:read",
  "mpim:read",
  "channels:read",
  "groups:read",
  "users:read",
] as const;

/** Events Slack sends for the owner's own conversations (the manifest's event_subscriptions.user_events). */
export const SLACK_USER_EVENTS = ["message.im", "message.mpim", "message.channels", "message.groups"] as const;

/** The owner's account, as a request may use it. */
export interface SlackUserAccess {
  token: string;
  userId: string;
  userName: string;
  /** Reading what reaches them is on. */
  listen: boolean;
  /** Sending as them is on (never in a routine: routines are read-only). */
  sendAsMe: boolean;
}

/** The request's Slack user, when it came from Slack. */
type Requester = Pick<PointerRequest, "surface" | "userId">;

/**
 * The owner's Slack account for this request, or undefined: not connected, or
 * the request is not the owner's. The console and routines are the owner's;
 * a Slack request is the owner's only from the account the token belongs to.
 */
export function ownSlackAccount(config: Config, req: Requester): SlackUserAccess | undefined {
  const user = config.slack.user;
  if (!user?.token || !user.userId) return undefined;
  const surface = req.surface ?? "slack";
  if (surface === "slack" && req.userId !== user.userId) return undefined;
  return {
    token: user.token,
    userId: user.userId,
    userName: user.userName,
    listen: user.listen,
    sendAsMe: user.sendAsMe && surface !== "routine",
  };
}
