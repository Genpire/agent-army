/**
 * Sending through an SMTP server (Gmail, Microsoft 365, Amazon SES, Mailgun,
 * Zoho…) with nodemailer: TLS from the start on 465, STARTTLS on 587
 * (required whenever there is a password, so it never travels in the clear),
 * TLS 1.2 or newer with the certificate checked, short timeouts, no logging,
 * and no file or URL access while building a message. Errors are short
 * sentences for the admin page; the caller redacts them again.
 */
import nodemailer, { type SMTPTransportOptions, type SendMailOptions, type Transporter } from "nodemailer";
import type { EmailConfig } from "../../core/config.js";

/** Builds a transporter; tests pass one that answers without a network (nodemailer's stream or JSON transport, or a stub). */
export type SmtpTransportFactory = (options: SMTPTransportOptions) => Pick<Transporter, "sendMail" | "verify" | "close">;

export const createSmtpTransport: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export const SMTP_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, dnsTimeout: 10_000 } as const;

/** The transport options for the saved server. */
export function smtpOptions(smtp: EmailConfig["smtp"]): SMTPTransportOptions {
  const user = smtp.user.trim();
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // STARTTLS when the server offers it; required before a password is sent.
    requireTLS: !smtp.secure && Boolean(user),
    ...(user ? { auth: { user, pass: smtp.pass ?? "" } } : {}),
    tls: { minVersion: "TLSv1.2" },
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

interface SmtpFailure {
  code?: unknown;
  response?: unknown;
  responseCode?: unknown;
  message?: unknown;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A sentence about what went wrong, with what the server said when it said something. */
export function smtpErrorMessage(err: unknown, smtp: EmailConfig["smtp"]): string {
  const e = (typeof err === "object" && err !== null ? err : { message: String(err) }) as SmtpFailure;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? oneLine(e.message, 200) : "";
  const said = typeof e.response === "string" && e.response.trim() ? ` The server said: "${oneLine(e.response, 200)}"` : "";
  const where = `${smtp.host}:${smtp.port}`;
  const gmail = /(^|\.)(gmail|googlemail|google)\.com$/i.test(smtp.host)
    ? " Gmail needs an app password (Google Account, Security, App passwords), not the account's password."
    : "";
  const tlsHint = ` Port 465 needs "TLS from the start" on; port 587 needs it off (STARTTLS).`;

  switch (code) {
    case "EAUTH":
      return `The SMTP server refused the user name or password.${gmail}${said}`;
    case "ENOAUTH":
      return "The SMTP server needs a user name and password.";
    case "EDNS":
      return `Couldn't find the SMTP server ${smtp.host}. Check the host name.`;
    case "ETIMEDOUT":
      return `${where} didn't answer in time. Check the host and port, and that this deployment may connect out on port ${smtp.port}.${smtp.secure || smtp.port !== 465 ? "" : tlsHint}`;
    case "ETLS":
      return `The secure connection to ${where} failed${message ? ` (${message})` : ""}.${smtp.secure ? tlsHint : " The server must offer STARTTLS before a password is sent."}`;
    case "EENVELOPE":
      return `The SMTP server refused the sender or a recipient.${said} The From address must be one the account may send as; with Amazon SES it must be verified (and, in the SES sandbox, every recipient too).`;
    case "ECONNECTION":
    case "ESOCKET": {
      if (/wrong version number|ssl|tls|certificate|handshake|EPROTO/i.test(message)) {
        return `The secure connection to ${where} failed (${message}).${tlsHint}`;
      }
      return `Couldn't connect to ${where}${message ? ` (${message})` : ""}. Check the host and port.`;
    }
    case "EMESSAGE":
    case "EPROTOCOL":
      return `The SMTP server refused the email.${said || (message ? ` ${message}` : "")}`;
    default:
      return `Sending through ${where} failed${said ? `.${said}` : message ? `: ${message}` : "."}`;
  }
}

/** Connects and signs in, as a save does before keeping the settings. */
export async function verifySmtp(smtp: EmailConfig["smtp"], make: SmtpTransportFactory = createSmtpTransport): Promise<{ ok: true } | { ok: false; error: string }> {
  const transporter = make(smtpOptions(smtp));
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: smtpErrorMessage(err, smtp) };
  } finally {
    transporter.close();
  }
}

export async function sendSmtp(
  smtp: EmailConfig["smtp"],
  mail: Pick<SendMailOptions, "from" | "to" | "subject" | "text" | "html" | "headers">,
  make: SmtpTransportFactory = createSmtpTransport,
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const transporter = make(smtpOptions(smtp));
  try {
    const info = (await transporter.sendMail({ ...mail, disableFileAccess: true, disableUrlAccess: true })) as { messageId?: unknown; accepted?: unknown[]; rejected?: unknown[] };
    const accepted = Array.isArray(info.accepted) ? info.accepted.length : undefined;
    if (accepted === 0 && Array.isArray(info.rejected) && info.rejected.length > 0) {
      return { ok: false, error: "The SMTP server refused every recipient." };
    }
    return typeof info.messageId === "string" && info.messageId ? { ok: true, id: info.messageId } : { ok: true };
  } catch (err) {
    return { ok: false, error: smtpErrorMessage(err, smtp) };
  } finally {
    transporter.close();
  }
}
