/**
 * Sending email (routines' reports): SMTP or an email API, from
 * config.email. Placeholder until the email work package replaces it.
 */
import type { Config } from "../../core/config.js";

export interface EmailMessage {
  to: string[];
  subject: string;
  /** Markdown; sent as HTML with a plain-text part. */
  markdown: string;
}

export type EmailResult = { ok: true; id?: string } | { ok: false; error: string };

/** Whether email can be sent with this configuration. */
export const emailReady = (config: Config): boolean =>
  config.email.provider === "smtp" ? Boolean(config.email.smtp.host && config.email.from) : config.email.provider === "resend" ? Boolean(config.email.resend.apiKey && config.email.from) : false;

export async function sendEmail(_config: Config, _message: EmailMessage): Promise<EmailResult> {
  return { ok: false, error: "Email is not set up yet." };
}
