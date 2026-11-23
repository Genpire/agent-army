/**
 * The owner's own Slack account (/api/slack/user/…, admin only): connect it
 * with a user token (checked with Slack: a person's token, in the bot's
 * workspace), its two switches (read what reaches them, send as them; turning
 * reading off empties their inbox), disconnect (which empties their inbox and
 * revokes the token, so Slack stops sending their conversations), and the
 * attention report: an owner-only routine that DMs them what needs their
 * reply. A token replaced by another is revoked too. Tokens are never
 * returned or logged.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import type { Config } from "../core/config.js";
import type { RoutineService } from "../routines/service.js";
import type { SlackInbox } from "../slack/inbox.js";
import { attentionReportBlocker, attentionReportDraft, findAttentionReport } from "../slack/inbox-tools.js";
import { slackErrorCode } from "../slack/slack.js";
import { SLACK_USER_SCOPES } from "../slack/user-account.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** The Slack calls these routes make: the check, with the user's token and with the bot's, and revoking a user token. */
export interface SlackAuthClient {
  auth: {
    test(): Promise<{ user_id?: string; user?: string; team_id?: string; bot_id?: string; response_metadata?: { scopes?: string[] } }>;
    revoke(): Promise<{ ok?: boolean; revoked?: boolean }>;
  };
  users: { info(args: { user: string }): Promise<{ user?: { is_bot?: boolean; deleted?: boolean; name?: string } }> };
}

/** Slack's answers that mean the token no longer works: nothing left to revoke. */
const DEAD_TOKEN = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive", "token_expired"]);

/**
 * Revokes a user token (auth.revoke with that token), so Slack stops sending
 * that person's conversations and the token stops working. True when it is
 * revoked or already dead; false when Slack did not confirm it, logged
 * without the token. Never throws.
 */
export async function revokeSlackToken(client: SlackAuthClient): Promise<boolean> {
  try {
    if ((await client.auth.revoke()).revoked !== false) return true;
    console.warn("[slack] the owner's Slack token was not revoked: Slack answered revoked false");
    return false;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code && DEAD_TOKEN.has(code)) return true;
    console.warn(`[slack] could not revoke the owner's Slack token: ${code ? code.slice(0, 60) : "no answer from Slack"}`);
    return false;
  }
}

export interface SlackUserCheck {
  userId: string;
  userName: string;
  scopes: string[];
}

/** Why Slack refused a token, in words; never the token. */
function refusal(err: unknown): string {
  const code = slackErrorCode(err);
  if (code && DEAD_TOKEN.has(code)) return "Slack rejected this token. Copy the User OAuth Token again from OAuth & Permissions.";
  return code ? `Slack refused the token (${code.slice(0, 60)}).` : "Couldn't reach Slack to check the token.";
}

/**
 * Checks a user token with Slack: auth.test says whose it is and which scopes
 * it has; it must be a person's (not a bot's), in the workspace of the bot.
 * Throws a message for the page, never the token.
 */
export async function checkSlackUser(user: SlackAuthClient, bot: SlackAuthClient): Promise<SlackUserCheck> {
  let auth: Awaited<ReturnType<SlackAuthClient["auth"]["test"]>>;
  try {
    auth = await user.auth.test();
  } catch (err) {
    throw new Error(refusal(err));
  }
  if (auth.bot_id || !auth.user_id) throw new Error("That is a bot token. Paste the User OAuth Token (xoxp-…), not the Bot User OAuth Token.");
  let botTeam: string | undefined;
  try {
    botTeam = (await bot.auth.test()).team_id;
  } catch {
    throw new Error("Couldn't check the bot's workspace with Slack. Check the Slack connection above and try again.");
  }
  if (!botTeam || auth.team_id !== botTeam) throw new Error("This token is for another Slack workspace than the bot's. Copy it from the same app, installed to the same workspace.");
  let person: Awaited<ReturnType<SlackAuthClient["users"]["info"]>>["user"];
  try {
    person = (await user.users.info({ user: auth.user_id })).user;
  } catch {
    person = undefined;
  }
  if (person?.is_bot || person?.deleted) throw new Error("This token does not belong to an active person in the workspace.");
  return {
    userId: auth.user_id,
    userName: (person?.name || auth.user || "").slice(0, 80),
    scopes: (auth.response_metadata?.scopes ?? []).filter((s) => /^[a-z:._-]{1,60}$/i.test(s)).slice(0, 60),
  };
}

const TOKEN = z
  .string("Paste the User OAuth Token.")
  .trim()
  .min(1, "Paste the User OAuth Token.")
  .max(400, "That is too long to be a Slack token.")
  .refine((t) => t.startsWith("xoxp-"), "User tokens start with xoxp-. Copy the User OAuth Token from OAuth & Permissions.")
  .refine((t) => !/\s/.test(t), "A Slack token has no spaces.");
const CONNECT = z.object({ token: TOKEN });
const SETTINGS = z
  .object({ listen: z.boolean().optional(), sendAsMe: z.boolean().optional() })
  .refine((s) => s.listen !== undefined || s.sendAsMe !== undefined, "Send listen or sendAsMe.");

const NOT_CONNECTED = "Your Slack account is not connected.";

type SlackUser = NonNullable<Config["slack"]["user"]>;

export function slackAccountRoutes(
  deps: IntegrationRouteDeps & { routines: RoutineService; inbox: SlackInbox; slack: (token: string) => SlackAuthClient },
): Router {
  const { configRepo, requireAdmin, routines, inbox } = deps;
  const router = Router();
  // With SKIP_VALIDATION=1 (tests) a token was never checked with Slack, so nothing is sent to it.
  const revoke = (token: string) => (process.env.SKIP_VALIDATION === "1" ? Promise.resolve(true) : revokeSlackToken(deps.slack(token)));

  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };

  // Connects the owner's account; the switches are kept from a previous connection.
  router.post("/api/slack/user", requireAdmin, async (req, res) => {
    const input = body(CONNECT, req, res);
    if (!input) return;
    const config = await configRepo.load(true);
    if (!config.slack.botToken) return void res.status(400).json({ error: "Connect Slack's bot first: your account must be in the same workspace." });
    let info: SlackUserCheck;
    if (process.env.SKIP_VALIDATION === "1") info = { userId: "UTESTUSER", userName: "test", scopes: [...SLACK_USER_SCOPES] };
    else {
      try {
        info = await checkSlackUser(deps.slack(input.token), deps.slack(config.slack.botToken));
      } catch (err) {
        const redact = makeRedactor([...configSecrets(config), input.token]);
        return void res.status(400).json({ error: redact((err as Error).message) });
      }
    }
    const replaced: { user?: SlackUser } = {};
    await configRepo.update((c) => {
      const previous = c.slack.user;
      replaced.user = previous;
      c.slack.user = {
        token: input.token,
        ...info,
        connectedAt: new Date().toISOString(),
        listen: previous?.listen ?? true,
        sendAsMe: previous?.sendAsMe ?? true,
      };
    });
    const previous = replaced.user;
    // Another person's account starts with an empty inbox (what was still on its way to the old one is dropped).
    if (previous && previous.userId !== info.userId) await inbox.clear();
    // The token it replaces is revoked: it stops working, and Slack stops sending that account's conversations.
    const previousRevoked = previous && previous.token !== input.token ? await revoke(previous.token) : undefined;
    const missingScopes = SLACK_USER_SCOPES.filter((s) => !info.scopes.includes(s));
    res.json({ ok: true, userId: info.userId, userName: info.userName, missingScopes, ...(previousRevoked === undefined ? {} : { previousRevoked }) });
  });

  router.post("/api/slack/user/settings", requireAdmin, async (req, res) => {
    const input = body(SETTINGS, req, res);
    if (!input) return;
    let found = false;
    await configRepo.update((c) => {
      if (!c.slack.user) return;
      found = true;
      if (input.listen !== undefined) c.slack.user.listen = input.listen;
      if (input.sendAsMe !== undefined) c.slack.user.sendAsMe = input.sendAsMe;
    });
    if (!found) return void res.status(404).json({ error: NOT_CONNECTED });
    // Reading off: nothing new is kept, and what was kept is deleted.
    if (input.listen === false) await inbox.clear();
    res.json({ ok: true });
  });

  // Forgets the token, empties the inbox and revokes the token, so Slack stops sending the owner's conversations.
  // `revoked` false: Slack did not confirm it, and the page says to remove the app's access in Slack. The
  // disconnect stands either way. The attention report stays: it says the inbox is not there.
  router.post("/api/slack/user/disconnect", requireAdmin, async (_req, res) => {
    const removed: { token?: string } = {};
    await configRepo.update((c) => {
      removed.token = c.slack.user?.token;
      delete c.slack.user;
    });
    await inbox.clear();
    res.json({ ok: true, revoked: removed.token ? await revoke(removed.token) : true });
  });

  // The attention report: the routine when it exists, and why it cannot be created when it cannot.
  router.get("/api/slack/user/report", requireAdmin, async (_req, res) => {
    const config = await configRepo.load(true);
    const routine = findAttentionReport(config.routines);
    res.json({ routine: routine ? { id: routine.id, name: routine.name } : null, blocked: attentionReportBlocker(config) });
  });

  router.post("/api/slack/user/report", requireAdmin, async (_req, res) => {
    const config = await configRepo.load(true);
    const blocked = attentionReportBlocker(config);
    if (blocked) return void res.status(findAttentionReport(config.routines) ? 409 : 400).json({ error: blocked });
    const result = await routines.create(attentionReportDraft(config, config.slack.user!.userId), "Admin (console)");
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    // Owner-only: only such a routine may read the owner's inbox. The routines service's create takes no such
    // option yet, so the mark is set on the stored routine, as the service stores it. Unmarked, it goes.
    const id = result.routine.id;
    let marked = false;
    try {
      await configRepo.update((c) => {
        const stored = c.routines.find((r) => r.id === id);
        if (!stored) return;
        stored.ownerOnly = true;
        marked = true;
      });
    } finally {
      if (!marked) await routines.remove(id);
    }
    if (!marked) return void res.status(409).json({ error: "The routine changed while it was being created. Try again." });
    res.json({ ok: true, routine: { ...result.routine, ownerOnly: true } });
  });

  return router;
}
