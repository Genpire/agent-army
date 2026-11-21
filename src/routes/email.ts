/**
 * Email admin routes (/api/email/…): save the provider (SMTP, Resend or
 * SendGrid) and the From address, checked before saving unless
 * SKIP_VALIDATION=1; send a test email; disconnect. Secrets are never sent
 * back: an empty password or key keeps the saved one, except that an SMTP
 * password is only kept for the server and user it was saved with, and a
 * SendGrid key only while SendGrid stays the provider, in the same region.
 */
import { Router } from "express";
import { z } from "zod";
import { type EmailConfig, publicView } from "../core/config.js";
import { emailReady, emailRedactor, parseFrom, sendEmail, testEmail, verifyEmailConfig } from "../integrations/email/email.js";
import { looksLikeResendKey } from "../integrations/email/resend.js";
import { looksLikeSendgridKey } from "../integrations/email/sendgrid.js";
import type { IntegrationRouteDeps } from "./types.js";

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const SAVE = z.object({
  provider: z.enum(["smtp", "resend", "sendgrid"], { error: "Choose SMTP, Resend or SendGrid." }),
  from: z.string({ error: "Enter the From address." }).trim().max(200, "The From address is at most 200 characters."),
  smtp: z
    .object({
      host: z.string().trim().max(200, "The host is at most 200 characters."),
      port: z.number().int().min(1).max(65535, "The port is a number from 1 to 65535.").optional(),
      secure: z.boolean().optional(),
      user: z.string().trim().max(200, "The user name is at most 200 characters.").optional(),
      /** Empty keeps the saved password (same host and user only). */
      pass: z.string().max(500, "The password is at most 500 characters.").optional(),
    })
    .optional(),
  resend: z.object({ apiKey: z.string().max(500).optional() }).optional(),
  sendgrid: z
    .object({
      apiKey: z.string().max(500).optional(),
      /** "eu" for an EU regional subuser (api.eu.sendgrid.com); defaults to the saved region. */
      region: z.enum(["global", "eu"], { error: 'The SendGrid region is "global" or "eu".' }).optional(),
    })
    .optional(),
});

/** The recipients are checked by sendEmail (addresses, at most 20); this only bounds the input. */
const TEST = z.object({ to: z.union([z.string().max(6000), z.array(z.string().max(254)).max(100)], { error: "Enter the addresses to send the test to (at most 20)." }) });

const FROM_HINT = "Enter the From address, like Pointer <pointer@example.com> or reports@example.com.";

/** Gmail shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it. */
const appPassword = (host: string, pass: string) => (/(^|\.)gmail\.com$/i.test(host) && /^[a-z]{4}( [a-z]{4}){3}$/i.test(pass) ? pass.replace(/ /g, "") : pass);

export function emailRoutes(deps: IntegrationRouteDeps): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  router.post("/api/email", requireAdmin, async (req, res) => {
    const parsed = SAVE.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    const input = parsed.data;
    const fail = (error: string) => void res.status(400).json({ error });
    if (!parseFrom(input.from)) return fail(FROM_HINT);

    const config = await configRepo.load(true);
    const current = config.email;
    let next: EmailConfig;
    const typed: string[] = [];
    // Another provider forgets the SendGrid key: it is not reused after a switch, so it is not kept.
    const withoutKey = { region: current.sendgrid.region };

    if (input.provider === "smtp") {
      const s = input.smtp;
      if (!s?.host) return fail("Enter the SMTP server's host, like smtp.gmail.com.");
      const host = s.host.toLowerCase();
      if (/^[a-z]+:\/\//.test(host) || host.includes("/") || host.includes(":")) return fail("Enter the host name only, like smtp.gmail.com, and the port in its own field.");
      if (!HOST_RE.test(host)) return fail(`"${host.slice(0, 80)}" is not a host name.`);
      const secure = s.secure ?? s.port === 465;
      const port = s.port ?? (secure ? 465 : 587);
      const user = s.user ?? "";
      const typedPass = appPassword(host, (s.pass ?? "").trim());
      if (typedPass) typed.push(typedPass);
      // A saved password goes only to the server and user it was saved for: a new host must not receive it.
      const sameAccount = host === current.smtp.host && user === current.smtp.user;
      const pass = typedPass || (sameAccount ? current.smtp.pass : undefined);
      if (!user && typedPass) return fail("Enter the user name the password belongs to.");
      if (user && !pass) {
        return fail(current.smtp.pass && !sameAccount ? "Enter the password again: the saved one is only used with the server and user it was saved for." : "Enter the SMTP password (for Gmail, an app password).");
      }
      next = { ...current, provider: "smtp", from: input.from, smtp: { host, port, secure, user, ...(user && pass ? { pass } : {}) }, sendgrid: withoutKey };
    } else if (input.provider === "sendgrid") {
      const region = input.sendgrid?.region ?? current.sendgrid.region;
      const typedKey = input.sendgrid?.apiKey?.trim() ?? "";
      if (typedKey && !looksLikeSendgridKey(typedKey)) return fail("That doesn't look like a SendGrid API key: it starts with SG.");
      if (typedKey) typed.push(typedKey);
      // A saved key is only reused while SendGrid stays the provider, and only with the host (region) it was checked with.
      const keepSaved = current.provider === "sendgrid" && region === current.sendgrid.region;
      const apiKey = typedKey || (keepSaved ? current.sendgrid.apiKey : undefined);
      if (!apiKey) return fail(current.sendgrid.apiKey && !keepSaved ? "Paste the SendGrid API key again: the saved one is only used with the region it was saved for." : "Paste a SendGrid API key.");
      next = { ...current, provider: "sendgrid", from: input.from, sendgrid: { apiKey, region } };
    } else {
      const typedKey = input.resend?.apiKey?.trim() ?? "";
      if (typedKey && !looksLikeResendKey(typedKey)) return fail("That doesn't look like a Resend API key: it starts with re_.");
      if (typedKey) typed.push(typedKey);
      const apiKey = typedKey || current.resend.apiKey;
      if (!apiKey) return fail("Paste a Resend API key.");
      next = { ...current, provider: "resend", from: input.from, resend: { apiKey }, sendgrid: withoutKey };
    }

    let detail: string | undefined;
    const verify = process.env.SKIP_VALIDATION !== "1";
    if (verify) {
      const check = await verifyEmailConfig(next);
      if (!check.ok) return fail(emailRedactor({ ...config, email: next }, [...typed, current.smtp.pass, current.resend.apiKey, current.sendgrid.apiKey])(check.error));
      detail = check.detail;
    }
    const updated = await configRepo.update((c) => {
      c.email = { ...next, checkedAt: verify ? new Date().toISOString() : undefined };
    });
    res.json({ ok: true, email: publicView(updated).email, ...(detail ? { detail } : {}) });
  });

  // Sends the test message to the given address(es), through the rate limit like any other email.
  router.post("/api/email/test", requireAdmin, async (req, res) => {
    const parsed = TEST.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Enter the address to send the test to." });
    const config = await configRepo.load(true);
    if (!emailReady(config)) return void res.status(400).json({ error: "Set up email first." });
    const to = typeof parsed.data.to === "string" ? parsed.data.to.split(/[,;\s]+/).filter(Boolean) : parsed.data.to;
    const result = await sendEmail(config, testEmail(config, to));
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json({ ok: true, ...(result.id ? { id: result.id } : {}) });
  });

  // Forgets the password and the API keys; the providers' other settings stay for a later reconnect.
  router.post("/api/email/disconnect", requireAdmin, async (_req, res) => {
    await configRepo.update((c) => {
      const { pass: _pass, ...smtp } = c.email.smtp;
      c.email = { provider: "none", from: c.email.from, smtp, resend: {}, sendgrid: { region: c.email.sendgrid.region } };
    });
    res.json({ ok: true });
  });

  return router;
}
