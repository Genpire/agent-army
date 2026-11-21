/**
 * The Email pane: how Pointer sends routines' reports, through an SMTP server
 * (with presets for Gmail, Microsoft 365, Amazon SES, Mailgun, SendGrid and
 * Zoho), Resend or SendGrid's API; a test email; and what each service needs
 * before it sends.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { IntegrationSummary } from "./catalog";
import { type SmtpPresetId, SMTP_PRESETS, addressOf, portForTls, presetById, presetForHost } from "./email/presets";
import { FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";

type Provider = "smtp" | "resend" | "sendgrid";
type SendgridRegion = "global" | "eu";

const MAX_RECIPIENTS = 20;
const splitAddresses = (s: string) => s.split(/[,;\s]+/).filter(Boolean);
const asProvider = (v: string): Provider => (v === "resend" || v === "sendgrid" ? v : "smtp");

const SENDGRID_REGIONS = [
  { value: "global", label: "Global" },
  { value: "eu", label: "EU (data residency)" },
];

export function EmailPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const e = config.email;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={EnvelopeIcon}
        title={summary.name}
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name}'s routines send their reports by email: through your own SMTP server (Gmail, Microsoft 365, Amazon SES, Mailgun, Zoho…), Resend or SendGrid. Reports are written in Markdown and arrive as a formatted email with a plain-text copy.`}
        onBack={onBack}
      />

      {e.configured && (
        <MetadataList>
          <MetadataListItem label="Sends with">
            <Text>
              {e.provider === "smtp"
                ? `SMTP: ${e.smtp.host}:${e.smtp.port} (${e.smtp.secure ? "TLS" : "STARTTLS"})`
                : e.provider === "sendgrid"
                  ? `SendGrid${e.sendgrid.region === "eu" ? " (EU)" : ""}`
                  : "Resend"}
            </Text>
          </MetadataListItem>
          <MetadataListItem label="From">
            <Text>{e.from}</Text>
          </MetadataListItem>
          {e.provider === "smtp" && e.smtp.user && (
            <MetadataListItem label="User">
              <Text>{e.smtp.user}</Text>
            </MetadataListItem>
          )}
          {e.checkedAt && (
            <MetadataListItem label="Checked">
              <Timestamp value={e.checkedAt} format="relative" />
            </MetadataListItem>
          )}
        </MetadataList>
      )}

      <EmailSettings />
      {e.configured && <EmailTest />}

      <PaneSection title="Good to know">
        <List listStyle="disc" density="compact">
          <ListItem
            label={
              <Text>
                The From address must be one the service lets you send as: the account's own address with Gmail, Microsoft 365 or Zoho, an address on a domain you
                verified with Resend, Amazon SES or Mailgun, or a verified sender or authenticated domain in SendGrid. Otherwise the email is refused or lands in spam.
              </Text>
            }
          />
          <ListItem label={<Text>Gmail needs an app password, not the account's password. Amazon SES needs its own SMTP credentials, not your AWS keys.</Text>} />
          <ListItem label={<Text>At most {MAX_RECIPIENTS} recipients per email and 30 emails a minute. Links in reports work only for http and https addresses, and images are not loaded.</Text>} />
          <ListItem label={<Text>The password and API key are checked, stored encrypted and never shown again. Leave the field empty to keep the saved one.</Text>} />
        </List>
      </PaneSection>
    </VStack>
  );
}

/** The provider and its settings, checked by the server before they are saved, and Disconnect. */
function EmailSettings() {
  const { config } = useConfig();
  const e = config.email;
  const name = config.team.pointer.name;
  const [provider, setProvider] = useState<Provider>(asProvider(e.provider));
  const [from, setFrom] = useState(e.from);
  const [preset, setPreset] = useState<SmtpPresetId | undefined>(presetForHost(e.smtp.host));
  const [host, setHost] = useState(e.smtp.host);
  const [port, setPort] = useState(e.smtp.port);
  const [secure, setSecure] = useState(e.smtp.secure);
  const [user, setUser] = useState(e.smtp.user);
  const [pass, setPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [sendgridKey, setSendgridKey] = useState("");
  const [region, setRegion] = useState<SendgridRegion>(e.sendgrid.region);
  const { save, error, edit } = useSave();

  const current = presetById(preset ?? "custom");
  // The saved password is only kept for the server and user it was saved with (the server asks again otherwise).
  const savedPass = e.smtp.pass && host.trim().toLowerCase() === e.smtp.host && user.trim() === e.smtp.user ? e.smtp.pass : null;
  const passAgain = Boolean(e.smtp.pass) && !savedPass && user.trim() !== "";
  // A saved SendGrid key is only kept while SendGrid stays the provider, in the region it was saved for.
  const savedSendgridKey = e.provider === "sendgrid" && region === e.sendgrid.region ? e.sendgrid.key : null;

  const choosePreset = (id: string) => {
    const p = SMTP_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(p.id);
    if (p.host) {
      setHost(p.host);
      setPort(p.port);
      setSecure(p.secure);
    }
    // SendGrid's fixed user name goes with its preset: another service starts with an empty one.
    if (p.user) setUser(p.user);
    else if (current.user && user === current.user) setUser("");
  };

  /** What is missing before the server is asked, if anything. */
  const missing = (): string | undefined => {
    if (!from.trim()) return "Enter the From address.";
    if (provider === "smtp") {
      if (!host.trim()) return "Enter the SMTP server's host.";
      return user.trim() && !pass.trim() && !savedPass ? `Enter the ${current.passLabel.toLowerCase()}.` : undefined;
    }
    if (provider === "sendgrid") return !sendgridKey.trim() && !savedSendgridKey ? "Paste a SendGrid API key." : undefined;
    return !apiKey.trim() && !e.resend.key ? "Paste a Resend API key." : undefined;
  };

  const submit = async () => {
    const f = from.trim();
    const body =
      provider === "smtp"
        ? { provider, from: f, smtp: { host: host.trim(), port, secure, user: user.trim(), ...(pass.trim() ? { pass } : {}) } }
        : provider === "sendgrid"
          ? { provider, from: f, sendgrid: { region, ...(sendgridKey.trim() ? { apiKey: sendgridKey.trim() } : {}) } }
          : { provider, from: f, resend: apiKey.trim() ? { apiKey: apiKey.trim() } : {} };
    const ok = await save(() => api.post<{ detail?: string }>("/api/email", body), {
      invalid: missing(),
      success: (r) => `Email settings saved.${r.detail ? ` ${r.detail}` : ""}`,
    });
    if (ok) {
      setPass("");
      setApiKey("");
      setSendgridKey("");
    }
  };

  const sendsAs = provider === "smtp" ? "this account may send as" : provider === "sendgrid" ? "verified in SendGrid, or on a domain authenticated there" : "on a domain verified in Resend";
  const fromField = (
    <TextInput
      label="From"
      value={from}
      onChange={edit(setFrom)}
      placeholder={`${name} <reports@example.com>`}
      description={`The sender people see, as an address or "Name <address>". It must be an address ${sendsAs}.`}
      isRequired
    />
  );

  return (
    <PaneSection
      title={e.configured ? "Settings" : "Connect email"}
      description="Saving checks the settings first: an SMTP server is signed in to, a Resend or SendGrid key is tried with its service.">
      <SegmentedControl label="Send with" value={provider} onChange={(v) => setProvider(asProvider(v))}>
        <SegmentedControlItem value="smtp" label="SMTP server" />
        <SegmentedControlItem value="resend" label="Resend" />
        <SegmentedControlItem value="sendgrid" label="SendGrid" />
      </SegmentedControl>

      {provider === "smtp" ? (
        <VStack gap={4}>
          <FormLayout>
            <Selector
              label="Email service"
              options={SMTP_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
              value={preset}
              onChange={edit(choosePreset)}
              placeholder="Choose your email service"
              description="Fills in the server's host, port and TLS. You can still change them."
            />
          </FormLayout>
          {preset && (
            <Banner
              status="info"
              title={current.name}
              description={current.tip}
              collapsible={false}
              endContent={
                current.link ? (
                  <Link href={current.link.href} isExternalLink>
                    {current.link.label}
                  </Link>
                ) : undefined
              }
            />
          )}
          <FormLayout>
            {fromField}
            <TextInput
              label="Host"
              value={host}
              onChange={edit((v: string) => {
                setHost(v);
                // A host typed by hand picks the service it belongs to, so the tip and field names follow it.
                const typed = presetForHost(v);
                if (typed) setPreset(typed);
              })}
              placeholder="smtp.example.com"
              isRequired
            />
            <NumberInput label="Port" value={port} onChange={edit(setPort)} min={1} max={65535} isIntegerOnly description="587 for STARTTLS, 465 for TLS from the start." />
            <Switch
              label="TLS from the start"
              description={secure ? "On: the connection is encrypted from the first byte (port 465)." : "Off: STARTTLS, required before the password is sent (port 587)."}
              value={secure}
              onChange={(on) => {
                edit(setSecure)(on);
                setPort((p) => portForTls(on, p));
              }}
            />
            <TextInput label={current.userLabel} value={user} onChange={edit(setUser)} placeholder={current.userPlaceholder} autoComplete="off" isOptional />
            <SecretField
              label={current.passLabel}
              value={pass}
              onChange={edit(setPass)}
              saved={savedPass}
              description={[current.passHint, passAgain ? "Enter it again: the saved one is only used with the server and user it was saved for." : undefined].filter(Boolean).join(" ") || undefined}
            />
          </FormLayout>
        </VStack>
      ) : provider === "sendgrid" ? (
        <VStack gap={4}>
          <Steps
            label="To send with SendGrid"
            steps={[
              <>
                In{" "}
                <Link href="https://app.sendgrid.com/settings/sender_auth" isExternalLink>
                  SendGrid
                </Link>
                , open <Strong>Settings → Sender Authentication</Strong> and authenticate the domain to send from (add the DNS records it lists), or verify the single
                address as a sender.
              </>,
              <>
                Under <Strong>Settings → API Keys</Strong>, create an API key with the <Strong>Mail Send</Strong> permission (Restricted Access is enough). With read
                access to Sender Authentication too, the From address is checked when you save.
              </>,
              <>
                Paste the key below with that From address. It is checked with SendGrid, stored encrypted and never shown again. An EU regional subuser uses the EU
                region, with a key made in that subuser.
              </>,
            ]}
          />
          <FormLayout>
            <SecretField
              label="SendGrid API key"
              value={sendgridKey}
              onChange={edit(setSendgridKey)}
              saved={savedSendgridKey}
              placeholder={savedSendgridKey ? undefined : "SG.…"}
              description={e.sendgrid.key && !savedSendgridKey ? "Paste it again: a saved key is only kept while SendGrid stays the provider, in the same region." : undefined}
              isRequired
            />
            {fromField}
            <Selector
              label="Region"
              options={SENDGRID_REGIONS}
              value={region}
              onChange={edit((v: string) => setRegion(v === "eu" ? "eu" : "global"))}
              description="EU sends through api.eu.sendgrid.com, for an EU regional subuser. Most accounts use Global."
            />
          </FormLayout>
        </VStack>
      ) : (
        <VStack gap={4}>
          <Steps
            label="To send with Resend"
            steps={[
              <>
                In{" "}
                <Link href="https://resend.com/domains" isExternalLink>
                  Resend
                </Link>
                , open <Strong>Domains</Strong>, add the domain to send from and add the DNS records it lists. Emails are sent once it reads <Strong>Verified</Strong>.
              </>,
              <>
                Under <Strong>API Keys</Strong>, create a key. <Strong>Sending access</Strong> is enough; with <Strong>Full access</Strong> the domain is checked when you save.
              </>,
              <>Paste the key below with a From address on that domain. It is checked with Resend, stored encrypted and never shown again.</>,
            ]}
          />
          <FormLayout>
            <SecretField label="Resend API key" value={apiKey} onChange={edit(setApiKey)} saved={e.resend.key} placeholder={e.resend.key ? undefined : "re_…"} isRequired />
            {fromField}
          </FormLayout>
        </VStack>
      )}

      <FormError message={error} />
      <FormActions>
        <Button label={e.configured ? "Verify and save" : "Verify and connect"} variant="primary" clickAction={submit} />
        {e.configured && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Click again to disconnect"
            size="md"
            onConfirm={async () => {
              const ok = await save(() => api.post("/api/email/disconnect", {}), { success: "Email disconnected. The password and API keys are forgotten." });
              if (ok) {
                setPass("");
                setApiKey("");
                setSendgridKey("");
              }
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** Sends the test message to one or more addresses (the From address to start with). */
function EmailTest() {
  const { config } = useConfig();
  const [to, setTo] = useState(() => addressOf(config.email.from));
  const { save, error, edit } = useSave();

  const send = async () => {
    const list = splitAddresses(to);
    await save(() => api.post<{ id?: string }>("/api/email/test", { to: list }), {
      invalid: list.length === 0 ? "Enter the address to send the test to." : list.length > MAX_RECIPIENTS ? `Send to at most ${MAX_RECIPIENTS} recipients.` : undefined,
      success: `Test email sent to ${list.join(", ")}. It can take a minute to arrive; check the spam folder too.`,
    });
  };

  return (
    <PaneSection title="Send a test email" description="A short email laid out like a report, sent with the saved settings.">
      <FormLayout>
        <TextInput label="Send to" value={to} onChange={edit(setTo)} placeholder="you@example.com" description="One address, or several separated by commas." isRequired />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label="Send test email" variant="primary" clickAction={send} />
      </FormActions>
    </PaneSection>
  );
}
