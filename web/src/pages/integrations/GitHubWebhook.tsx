import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { CopyField } from "../../components/CopyField";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { randomSecret, webhookSecretError } from "./catalog";
import { FormActions, FormError, PaneSection, StatusLine, Steps, Strong, useSave } from "./parts";

/** The webhook that turns reviews on the team's pull requests into follow-up tasks (README: Pull request reviews). */
export function GitHubWebhook() {
  const { config, state } = useConfig();
  const name = config.team.pointer.name;
  const configured = config.github.webhook.configured;
  const url = state.githubWebhookUrl ?? "";
  const showToast = useToast();
  const [secret, setSecret] = useState("");
  const [touched, setTouched] = useState(false);
  const { save, error, edit } = useSave();
  const secretError = secret ? webhookSecretError(secret) : undefined;

  const submit = async () => {
    setTouched(true);
    const ok = await save(() => api.post("/api/github/webhook", { secret }), {
      invalid: !secret ? "Generate a secret or paste your own." : secretError,
      success: "Webhook secret saved. GitHub must send the same secret.",
    });
    if (ok) {
      setSecret("");
      setTouched(false);
    }
  };

  const copySecret = async (): Promise<void> => {
    if (!secret) {
      showToast({ body: "Generate or paste a secret first.", type: "error" });
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      showToast({ body: "Copied. Paste it into the webhook's Secret field in GitHub.", type: "info", uniqueID: "copy-webhook-secret" });
    } catch {
      showToast({ body: "Couldn't copy. Select the field and copy it yourself.", type: "error" });
    }
  };

  return (
    <PaneSection
      title="Pull request reviews (webhook)"
      endContent={<StatusLine tone={configured ? "success" : "neutral"} text={configured ? "Configured" : "Not set up"} />}
      description={
        <>
          Optional. When someone with write access requests changes, comments in a review, or writes a pull request comment that starts with <Code size="inherit">/pointer</Code>{" "}
          or mentions <Code size="inherit">@pointer</Code> on a pull request the team opened, {name} starts a follow-up task in the task's Slack thread. Approvals, bots and
          people without write access are ignored.
        </>
      }>
      <CopyField label="Payload URL" value={url} description="Paste it into the webhook's Payload URL field in GitHub. It is this deployment's address followed by /github/webhook." />
      <Steps
        label="Set it up in GitHub"
        steps={[
          <>
            Open the repository's or the organisation's <Strong>Settings → Webhooks → Add webhook</Strong>. The organisation's covers all its repos.
          </>,
          <>
            <Strong>Payload URL</Strong>: the URL above. <Strong>Content type</Strong>: <Code size="inherit">application/json</Code>.
          </>,
          <>
            <Strong>Secret</Strong>: generate one below, copy it into GitHub, then save it here.
          </>,
          <>
            <Strong>Which events</Strong>: choose <Strong>Let me select individual events</Strong>, tick <Strong>Pull request reviews</Strong>,{" "}
            <Strong>Issue comments</Strong> and <Strong>Pull requests</Strong> (so merges move monday.com tickets to done), and untick <Strong>Pushes</Strong>.
          </>,
          <>
            Keep <Strong>Active</Strong> ticked and choose <Strong>Add webhook</Strong>. Its <Strong>Recent Deliveries</Strong> tab shows each delivery.
          </>,
        ]}
      />
      <TextInput
        type="password"
        label="Webhook secret"
        value={secret}
        onChange={edit((v: string) => setSecret(v.trim()))}
        placeholder={configured ? "Saved. Generate a new one to replace it" : "Generate one or paste your own"}
        description="20 to 200 characters, no spaces. Copy it into GitHub before you save: it is stored encrypted and never shown again."
        status={touched && (secretError || !secret) ? { type: "error" } : undefined}
        autoComplete="off"
        hasSpellCheck={false}
        autoCapitalize="off"
      />
      <FormError message={error} />
      <FormActions>
        <Button label={configured ? "Replace secret" : "Save secret"} variant="primary" clickAction={submit} />
        <Button
          label="Generate"
          onClick={() => {
            setSecret(randomSecret());
            setTouched(false);
          }}
        />
        <IconButton label="Copy secret" tooltip="Copy secret" icon={<Icon icon={ClipboardDocumentIcon} />} isDisabled={!secret} clickAction={copySecret} />
        {configured && (
          <ConfirmButton
            label="Remove"
            confirmLabel="Click again to remove"
            size="md"
            onConfirm={async () => {
              await save(() => api.post("/api/github/webhook", { secret: "" }), { success: "Webhook secret removed. GitHub deliveries are now refused." });
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}
