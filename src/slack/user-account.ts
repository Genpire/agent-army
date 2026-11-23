import type { Config, Routine } from "../core/config.js";
import type { PointerRequest } from "../chat/pointer-types.js";

/**
 * The owner's own Slack account (config.slack.user): a user token next to the
 * bot's. With it Pointer reads what reaches the owner (DMs, mentions, the
 * threads they are in: slack/inbox.ts) and, when they allow it, sends as them
 * (slack_send_message with as "me").
 *
 * Only the owner may use it: in the admin console (its only user is the
 * owner), in their DM with Pointer from the very account the token belongs
 * to, or in a routine the owner made that reports to them alone (read-only).
 * Not in a channel thread or a group DM, even the owner's: other people's
 * messages are in the prompt there. Anyone else talking to Pointer never gets
 * these tools or hears of the account.
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

/** What decides whether a request is the owner's: where it comes from and who sent it. */
type Requester = Pick<PointerRequest, "userId"> & Partial<Pick<PointerRequest, "surface" | "channelType" | "ownerRoutine">>;

/**
 * The owner's own conversation with Pointer: the console, or their DM with
 * Pointer from the account the token belongs to. Routines made or changed
 * there are the owner's (ownerOnly); anywhere else they are not.
 */
export function ownerConversation(config: Config, req: Requester): boolean {
  const surface = req.surface ?? "slack";
  if (surface === "web") return true;
  const ownerId = config.slack.user?.userId;
  return surface === "slack" && Boolean(ownerId) && req.userId === ownerId && req.channelType === "im";
}

/**
 * A routine whose runs may read the owner's account: marked ownerOnly (made
 * or last changed by the owner) and reporting to the owner alone: on Slack to
 * their own user id or nowhere, the console allowed, no email. The runner
 * checks it on every run, against the current config.
 */
export function ownerRoutine(config: Config, routine: Pick<Routine, "ownerOnly" | "deliver">): boolean {
  const ownerId = config.slack.user?.userId;
  if (routine.ownerOnly !== true || !ownerId) return false;
  if (routine.deliver.email.length > 0) return false;
  return routine.deliver.slack === "" || routine.deliver.slack === ownerId;
}

/**
 * The owner's Slack account for this request, or undefined: not connected, or
 * the request is not the owner's. The console is the owner's; a Slack request
 * only in their DM with Pointer, from the account the token belongs to; a
 * routine run only when the runner found the routine the owner's (ownerRoutine).
 */
export function ownSlackAccount(config: Config, req: Requester): SlackUserAccess | undefined {
  const user = config.slack.user;
  if (!user?.token || !user.userId) return undefined;
  const surface = req.surface ?? "slack";
  if (surface === "routine" ? req.ownerRoutine !== true : !ownerConversation(config, req)) return undefined;
  return {
    token: user.token,
    userId: user.userId,
    userName: user.userName,
    listen: user.listen,
    sendAsMe: user.sendAsMe && surface !== "routine",
  };
}
