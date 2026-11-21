/**
 * Sending email (routines' reports): SMTP, Resend or SendGrid, from config.email.
 *
 * sendEmail checks the message (at most 20 recipients, a one-line subject of
 * at most 200 characters, at most 100 000 characters of Markdown), takes a
 * slot from the process's rate limit (30 sends a minute), renders the
 * Markdown as safe HTML with a plain-text part (render.ts) and sends it. It
 * never throws, and its errors never contain a secret.
 */
import { Buffer } from "node:buffer";
import { type Config, type EmailConfig, emailConfigured } from "../../core/config.js";
import { configSecrets, makeRedactor } from "../../tasks/worker.js";
import { renderEmail } from "./render.js";
import { sendResend, verifyResend } from "./resend.js";
import { sendSendgrid, verifySendgrid } from "./sendgrid.js";
import { type SmtpTransportFactory, sendSmtp, verifySmtp } from "./smtp.js";

export interface EmailMessage {
  to: string[];
  subject: string;
  /** Markdown; sent as HTML with a plain-text part. */
  markdown: string;
}

export type EmailResult = { ok: true; id?: string } | { ok: false; error: string };

export const EMAIL_LIMITS = { maxRecipients: 20, maxSubjectChars: 200, maxMarkdownChars: 100_000, sendsPerMinute: 30 } as const;

/** Whether email can be sent with this configuration. */
export const emailReady = (config: Config): boolean => emailConfigured(config.email);

// ---------- Addresses ----------

const ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** A bare address (no display name), like reports@example.com. */
export const isEmailAddress = (s: string): boolean => s.length <= 254 && ADDRESS_RE.test(s) && s.indexOf("@") <= 64 && !s.startsWith(".") && !s.includes("..");

export interface FromAddress {
  name?: string;
  address: string;
}

/** "Pointer <pointer@example.com>" or "pointer@example.com"; undefined for anything else. */
export function parseFrom(from: string): FromAddress | undefined {
  const s = from.trim();
  if (!s || s.length > 200 || /[\r\n\u0000]/.test(s)) return undefined;
  const named = s.match(/^(.*?)\s*<([^<>]+)>$/);
  const address = (named ? named[2]! : s).trim();
  if (!isEmailAddress(address)) return undefined;
  const name = named ? named[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
  if (name.length > 100 || /[<>"\\]/.test(name)) return undefined;
  return name ? { name, address } : { address };
}

/** A From header value: the name quoted when it has characters an address header treats specially. */
export const formatFrom = (f: FromAddress): string => (!f.name ? f.address : /[()<>[\]:;@,."]/.test(f.name) ? `"${f.name}" <${f.address}>` : `${f.name} <${f.address}>`);

// ---------- Checks ----------

export type CheckedMessage = { ok: true; to: string[]; subject: string; markdown: string } | { ok: false; error: string };

const fmt = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

/** The recipients, subject and Markdown, cleaned, or what is wrong with them. */
export function checkMessage(message: EmailMessage): CheckedMessage {
  const raw: unknown = (message as { to?: unknown }).to;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const to: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const address = typeof entry === "string" ? entry.trim() : "";
    if (!isEmailAddress(address)) return { ok: false, error: `"${String(entry).slice(0, 100)}" is not an email address.` };
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    to.push(address);
  }
  if (to.length === 0) return { ok: false, error: "Add at least one recipient." };
  if (to.length > EMAIL_LIMITS.maxRecipients) return { ok: false, error: `Send to at most ${EMAIL_LIMITS.maxRecipients} recipients.` };

  const subject = String(message.subject ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!subject) return { ok: false, error: "The email needs a subject." };
  if (subject.length > EMAIL_LIMITS.maxSubjectChars) return { ok: false, error: `The subject is at most ${EMAIL_LIMITS.maxSubjectChars} characters.` };

  const markdown = typeof message.markdown === "string" ? message.markdown.replace(/\u0000/g, "") : "";
  if (!markdown.trim()) return { ok: false, error: "The email has no text." };
  if (markdown.length > EMAIL_LIMITS.maxMarkdownChars) return { ok: false, error: `The email is at most ${fmt(EMAIL_LIMITS.maxMarkdownChars)} characters of Markdown.` };
  return { ok: true, to, subject, markdown };
}

// ---------- Rate limit ----------

/** At most `max` sends in any `windowMs`. */
export class SendLimiter {
  private times: number[] = [];

  constructor(
    readonly max: number = EMAIL_LIMITS.sendsPerMinute,
    readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a slot, or says how long until one is free. */
  take(): { ok: true } | { ok: false; retryInMs: number } {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < this.windowMs);
    if (this.times.length >= this.max) return { ok: false, retryInMs: Math.max(0, this.windowMs - (t - this.times[0]!)) };
    this.times.push(t);
    return { ok: true };
  }
}

/** Every send in this process shares it: routines, test emails and anything else. */
const processLimiter = new SendLimiter();

// ---------- Sending ----------

export interface EmailDeps {
  fetch?: typeof fetch;
  smtpTransport?: SmtpTransportFactory;
  limiter?: SendLimiter;
}

/** Marks reports as automatic, so out-of-office replies are not sent back to them. */
const AUTOMATED_HEADERS = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };

/** Removes every saved secret, and the encodings SMTP sends the password in, from a message. */
export function emailRedactor(config: Config, extra: (string | undefined)[] = []): (text: string) => string {
  const { user, pass } = config.email.smtp;
  const passwords = [pass, ...extra].filter((s): s is string => Boolean(s));
  return makeRedactor([
    ...configSecrets(config),
    ...extra,
    ...passwords.flatMap((p) => [Buffer.from(p).toString("base64"), Buffer.from(`\u0000${user}\u0000${p}`).toString("base64"), encodeURIComponent(p)]),
  ]);
}

export async function sendEmail(config: Config, message: EmailMessage, deps: EmailDeps = {}): Promise<EmailResult> {
  const email = config.email;
  if (!emailReady(config)) return { ok: false, error: "Email is not set up. Connect SMTP, Resend or SendGrid on Integrations → Email." };
  const from = parseFrom(email.from);
  if (!from) return { ok: false, error: "The From address in the email settings is not valid. Fix it on Integrations → Email." };
  const checked = checkMessage(message);
  if (!checked.ok) return checked;
  const limiter = deps.limiter ?? processLimiter;
  const slot = limiter.take();
  if (!slot.ok) return { ok: false, error: `Too many emails: at most ${limiter.max} a minute. Try again in ${Math.ceil(slot.retryInMs / 1000)} seconds.` };

  const { html, text } = renderEmail({ subject: checked.subject, markdown: checked.markdown, orgName: config.orgName, senderName: config.team.pointer.name });
  const redact = emailRedactor(config);
  let result: EmailResult;
  try {
    const mail = { to: checked.to, subject: checked.subject, html, text, headers: AUTOMATED_HEADERS };
    result =
      email.provider === "smtp"
        ? await sendSmtp(email.smtp, { ...mail, from: from.name ? { name: from.name, address: from.address } : from.address }, deps.smtpTransport)
        : email.provider === "sendgrid"
          ? await sendSendgrid(email.sendgrid.apiKey!, email.sendgrid.region, { ...mail, from }, deps.fetch)
          : await sendResend(email.resend.apiKey!, { ...mail, from: formatFrom(from) }, deps.fetch);
  } catch (err) {
    result = { ok: false, error: `Sending failed: ${err instanceof Error ? err.message : "unknown error"}` };
  }
  return result.ok ? result : { ok: false, error: redact(result.error) };
}

/**
 * Checks settings before they are saved: SMTP connects and signs in, Resend
 * lists the account's domains (and checks the From domain when it may),
 * SendGrid reads the key's scopes (and checks the From address when it may).
 * The caller redacts the error.
 */
export async function verifyEmailConfig(email: EmailConfig, deps: Omit<EmailDeps, "limiter"> = {}): Promise<{ ok: true; detail?: string } | { ok: false; error: string }> {
  const from = parseFrom(email.from);
  if (!from) return { ok: false, error: "Enter the From address, like Pointer <pointer@example.com> or reports@example.com." };
  try {
    if (email.provider === "smtp") return await verifySmtp(email.smtp, deps.smtpTransport);
    if (email.provider === "resend") return await verifyResend(email.resend.apiKey ?? "", from.address, deps.fetch);
    if (email.provider === "sendgrid") return await verifySendgrid(email.sendgrid.apiKey ?? "", email.sendgrid.region, from.address, deps.fetch);
  } catch (err) {
    return { ok: false, error: `The check failed: ${err instanceof Error ? err.message : "unknown error"}` };
  }
  return { ok: false, error: "Choose SMTP, Resend or SendGrid." };
}

/** Escapes Markdown's special characters in a value written into a message. */
const literal = (s: string) => s.replace(/[\\`*_[\]<>|#~!]/g, (c) => `\\${c}`);

/** The message "Send a test email" sends: what it was sent with, formatted like a report. */
export function testEmail(config: Config, to: string[]): EmailMessage {
  const name = config.team.pointer.name.trim() || "Pointer";
  const e = config.email;
  const via =
    e.provider === "smtp" ? `SMTP (${e.smtp.host}:${e.smtp.port}, ${e.smtp.secure ? "TLS" : "STARTTLS"})` : e.provider === "sendgrid" ? `SendGrid${e.sendgrid.region === "eu" ? " (EU)" : ""}` : "Resend";
  return {
    to,
    subject: `Test email from ${name}`,
    markdown: [
      "## Email works",
      "",
      `This is a test from **${literal(name)}**. Routines' reports arrive looking like this one, with headings, lists, tables and links.`,
      "",
      "| Setting | Value |",
      "| --- | --- |",
      `| Sent with | ${literal(via)} |`,
      `| From | ${literal(e.from)} |`,
      "",
      "Change or turn off email on **Integrations → Email**.",
    ].join("\n"),
  };
}
