/**
 * SMTP services the Email pane can fill in: host, port and TLS, what to type
 * as the user and password, and what each one needs first.
 */

export type SmtpPresetId = "gmail" | "microsoft" | "ses" | "mailgun" | "zoho" | "custom";

export interface SmtpPreset {
  id: SmtpPresetId;
  name: string;
  /** Empty for Custom: the fields keep what is typed. */
  host: string;
  port: number;
  /** TLS from the start (465); false is STARTTLS (587). */
  secure: boolean;
  userLabel: string;
  userPlaceholder: string;
  passLabel: string;
  /** What the service needs, in a sentence or three. */
  tip: string;
  link?: { label: string; href: string };
}

export const SMTP_PRESETS: SmtpPreset[] = [
  {
    id: "gmail",
    name: "Gmail or Google Workspace",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    userLabel: "Gmail address",
    userPlaceholder: "you@example.com",
    passLabel: "App password",
    tip: "Gmail needs an app password, not the account's own password: turn on 2-Step Verification for the account, create an app password, and paste its 16 letters here. Send from the account's own address, or an alias added to it in Gmail. Google Workspace admins can turn app passwords off.",
    link: { label: "Create an app password", href: "https://myaccount.google.com/apppasswords" },
  },
  {
    id: "microsoft",
    name: "Outlook or Microsoft 365",
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    userLabel: "Mailbox address",
    userPlaceholder: "you@example.com",
    passLabel: "Password",
    tip: "Use the mailbox's address and password, and send from that address. The mailbox needs Authenticated SMTP turned on, and Microsoft is turning password sign-in for SMTP off by default: if the sign-in is refused, ask your Microsoft 365 admin, or use Amazon SES or Resend instead.",
    link: { label: "Authenticated SMTP in Microsoft 365", href: "https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission" },
  },
  {
    id: "ses",
    name: "Amazon SES",
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    secure: false,
    userLabel: "SMTP user name",
    userPlaceholder: "AKIA…",
    passLabel: "SMTP password",
    tip: "Use SMTP credentials made in the SES console (SMTP settings, Create SMTP credentials), not your AWS access keys, and change us-east-1 in the host to your SES region. The From address, or its domain, must be a verified identity in SES; while the account is in the SES sandbox, every recipient must be verified too.",
    link: { label: "SES SMTP credentials", href: "https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html" },
  },
  {
    id: "mailgun",
    name: "Mailgun",
    host: "smtp.mailgun.org",
    port: 587,
    secure: false,
    userLabel: "SMTP login",
    userPlaceholder: "postmaster@mg.example.com",
    passLabel: "SMTP password",
    tip: "Use the sending domain's SMTP login and password, from the domain's SMTP credentials in Mailgun, and send from that domain. For a domain in Mailgun's EU region, change the host to smtp.eu.mailgun.org.",
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    host: "smtp.zoho.com",
    port: 465,
    secure: true,
    userLabel: "Zoho Mail address",
    userPlaceholder: "you@example.com",
    passLabel: "Password",
    tip: "Use your Zoho Mail address and password, or an app-specific password when two-factor authentication is on, and send from that address. Accounts in the EU use smtp.zoho.eu, and in India smtp.zoho.in.",
  },
  {
    id: "custom",
    name: "Another SMTP server",
    host: "",
    port: 587,
    secure: false,
    userLabel: "User name",
    userPlaceholder: "Often the email address",
    passLabel: "Password",
    tip: 'Your provider\'s SMTP host and port: usually 587 with STARTTLS ("TLS from the start" off), or 465 with "TLS from the start" on. Leave the user empty only for a server that needs no sign-in.',
  },
];

export const presetById = (id: SmtpPresetId): SmtpPreset => SMTP_PRESETS.find((p) => p.id === id) ?? SMTP_PRESETS[SMTP_PRESETS.length - 1]!;

/** The preset a saved host belongs to (any SES region, Mailgun's EU host, Zoho's regions), Custom for others, none before setup. */
export function presetForHost(host: string): SmtpPresetId | undefined {
  const h = host.trim().toLowerCase();
  if (!h) return undefined;
  if (h === "smtp.gmail.com") return "gmail";
  if (h === "smtp.office365.com" || h === "smtp-mail.outlook.com") return "microsoft";
  if (/^email-smtp(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return "ses";
  if (h === "smtp.mailgun.org" || h === "smtp.eu.mailgun.org") return "mailgun";
  if (/^smtp(pro)?\.zoho\.(com|eu|in|com\.au|jp|com\.cn|sa|ca)$/.test(h)) return "zoho";
  return "custom";
}

/** The port that goes with TLS from the start or STARTTLS, when the current one is the other's usual port. */
export const portForTls = (secure: boolean, port: number): number => (secure && port === 587 ? 465 : !secure && port === 465 ? 587 : port);

/** The bare address in "Name <address>" or an address alone. */
export const addressOf = (from: string): string => (from.match(/<([^<>]+)>\s*$/)?.[1] ?? from).trim();
