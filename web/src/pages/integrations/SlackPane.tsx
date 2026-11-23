import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { buildManifest } from "../../../../src/slack/slack.js";
import { CopyField } from "../../components/CopyField";
import { SecretField } from "../../components/SecretField";
import { api, errorMessage } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { IntegrationSummary } from "./catalog";
import { FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";
import { SlackAccountSection } from "./SlackAccount";

type SlackManifest = ReturnType<typeof buildManifest>;

/** GET /api/slack/manifest */
interface ManifestResponse {
  manifest: SlackManifest;
  /** Slack's "create from manifest" page with this deployment's manifest filled in. */
  createUrl: string;
}

/** What each bot scope in the manifest is for. A scope missing here is still listed, without a reason. */
const SCOPE_USES: Record<string, string> = {
  "app_mentions:read": "See @mentions",
  "chat:write": "Post replies and progress, and messages you ask it to send",
  "channels:history": "Read messages in public channels it is in",
  "groups:history": "Read messages in private channels it is in",
  "im:history": "Read direct messages",
  "users:read": "Look up who is asking, and find people to message",
  "channels:read": "Find a public channel by name to post in",
  "groups:read": "Find a private channel it is in by name",
  "reactions:write": "React to messages while it works",
  "files:read": "Read files people share",
  "files:write": "Post screenshots from browser checks",
};

/** What each user scope (your own account, see Your Slack account) is for. */
const USER_SCOPE_USES: Record<string, string> = {
  "chat:write": "Send messages as you, when you ask and allow it",
  "im:write": "Open a DM to send as you",
  "im:history": "Read your direct messages",
  "mpim:history": "Read your group DMs",
  "channels:history": "Read replies in your threads and mentions of you in public channels",
  "groups:history": "The same in private channels you are in",
  "im:read": "Tell your DMs apart from its own",
  "mpim:read": "Name your group DMs",
  "channels:read": "Name the public channels you are in",
  "groups:read": "Name the private channels you are in",
  "users:read": "Check whose token it is",
};

interface ScopeRow extends Record<string, unknown> {
  scope: string;
  use: string;
}

/** The manifest, loaded once per pane: the create button needs its URL and the update flow shows its JSON. */
function useManifest() {
  const [data, setData] = useState<ManifestResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api
      .get<ManifestResponse>("/api/slack/manifest")
      .then((d) => live && setData(d))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);
  return { data, error };
}

export function SlackPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config, state } = useConfig();
  const { slack } = config;
  const name = config.team.pointer.name;
  const manifest = useManifest();
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  // The guide's progress before Slack is connected; once connected every step shows as done.
  const [step, setStep] = useState(0);
  const { save, error, edit } = useSave();

  const submit = async () => {
    const token = botToken.trim();
    const secret = signingSecret.trim();
    const invalid =
      !token || !secret
        ? "Paste both the Bot User OAuth Token and the Signing Secret."
        : !token.startsWith("xoxb-")
          ? "Bot tokens start with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions."
          : secret.length < 16
            ? "That is too short to be a Signing Secret. Copy it from Basic Information → App Credentials."
            : undefined;
    const ok = await save(() => api.post<{ teamName?: string }>("/api/slack", { botToken: token, signingSecret: secret }), {
      invalid,
      success: (r) => {
        const team = r.teamName;
        return team ? `Slack connected to ${team}.` : "Slack connected.";
      },
    });
    if (ok) {
      setBotToken("");
      setSigningSecret("");
    }
  };

  const scopes: ScopeRow[] = (manifest.data?.manifest.oauth_config.scopes.bot ?? Object.keys(SCOPE_USES)).map((scope) => ({ scope, use: SCOPE_USES[scope] ?? "" }));
  const userScopeNames = manifest.data?.manifest.oauth_config.scopes.user ?? Object.keys(USER_SCOPE_USES);
  const userScopes: ScopeRow[] = userScopeNames.map((scope) => ({ scope, use: USER_SCOPE_USES[scope] ?? "" }));
  const scopeColumns = [
    { key: "scope", header: "Scope", width: proportional(1, { minWidth: 130 }), renderCell: (r: ScopeRow) => <Code size="inherit">{r.scope}</Code> },
    { key: "use", header: "What it is for", width: proportional(2, { minWidth: 150 }) },
  ];
  const eventsUrl = state.eventsUrl ?? manifest.data?.manifest.settings.event_subscriptions.request_url ?? "";

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={ChatBubbleLeftRightIcon}
        title="Slack"
        tone={summary.tone}
        status={summary.status}
        description={`Where your team talks to ${name}: @mentions, direct messages and ${name} channels. Replies, progress and screenshots are posted in the thread.`}
        onBack={onBack}
      />

      {slack.connected && (
        <MetadataList>
          <MetadataListItem label="Workspace">
            <Text>{slack.teamName || "Unknown"}</Text>
          </MetadataListItem>
          <MetadataListItem label="Bot user">
            <Code size="inherit">{slack.botUserId ?? "Unknown"}</Code>
          </MetadataListItem>
        </MetadataList>
      )}

      {eventsUrl && (
        <CopyField
          label="Events Request URL"
          value={eventsUrl}
          description="Slack sends messages here. The manifest sets it for you; if replies never arrive, check it under Event Subscriptions."
        />
      )}

      <PaneSection
        title={slack.connected ? "Setup" : "Connect Slack"}
        description={slack.connected ? "Done. To move to another app or workspace, go through the steps again with the new app." : "Four steps. The app is created from a manifest, so nothing needs configuring by hand."}>
        {manifest.error && <Banner status="error" title="Couldn't load the Slack app manifest" description={manifest.error} collapsible={false} />}
        <Stepper activeStep={slack.connected ? 4 : step} orientation="vertical" onStepClick={setStep} label="Slack setup">
          <Step step={0} label="Create the Slack app" description={`Opens Slack with everything filled in: ${name}'s name, the scopes and the Request URL.`}>
            <FormActions>
              <Button
                label="Create Slack app"
                variant={slack.connected ? "secondary" : "primary"}
                href={manifest.data?.createUrl}
                target="_blank"
                isDisabled={!manifest.data}
                isLoading={!manifest.data && !manifest.error}
                endContent={<Icon icon="externalLink" />}
                onClick={() => setStep(1)}
              />
            </FormActions>
          </Step>
          <Step step={1} label="Install it to your workspace" description="On the app's page, open Install App and choose Install to Workspace, then Allow." />
          <Step step={2} label="Paste the credentials" description="Saving checks the token with Slack.">
            <VStack gap={4}>
              <FormLayout>
                <SecretField
                  label="Bot User OAuth Token"
                  value={botToken}
                  onChange={edit(setBotToken)}
                  saved={slack.connected ? "••••" : null}
                  placeholder="xoxb-…"
                  description="OAuth & Permissions → OAuth Tokens."
                  isRequired
                />
                <SecretField
                  label="Signing Secret"
                  value={signingSecret}
                  onChange={edit(setSigningSecret)}
                  saved={slack.connected ? "••••" : null}
                  placeholder="32 characters"
                  description="Basic Information → App Credentials."
                  isRequired
                />
              </FormLayout>
              <FormError message={error} />
              <FormActions>
                <Button label={slack.connected ? "Verify and replace" : "Verify and save"} variant="primary" clickAction={submit} />
              </FormActions>
            </VStack>
          </Step>
          <Step step={3} label={`Invite ${name} to a channel`} description={`In each channel where ${name} should work, send /invite @${name}. Direct messages work without an invite.`} />
        </Stepper>
      </PaneSection>

      <SlackAccountSection requiredScopes={manifest.data ? userScopeNames : []} />

      <PaneSection
        title="Already have an app? Update it"
        description={`Apps created with an earlier version miss some scopes: direct messages, reactions, shared files and screenshots, and your own account's scopes and events (Your Slack account). Update the app once, and again whenever you rename ${name}.`}>
        <Steps
          label="To update the app"
          steps={[
            <>
              Open{" "}
              <Link href="https://api.slack.com/apps" isExternalLink>
                api.slack.com/apps
              </Link>{" "}
              and choose your app.
            </>,
            <>
              Open <Strong>App Manifest</Strong>, replace the JSON with the manifest below and save.
            </>,
            <>
              Open <Strong>Install App</Strong> and choose <Strong>Reinstall</Strong>, so Slack grants the new scopes.
            </>,
          ]}
        />
        <Table<ScopeRow> data={scopes} idKey="scope" density="compact" columns={scopeColumns} />
        <Text color="secondary">Your own account's scopes, used only when you connect it under Your Slack account:</Text>
        <Table<ScopeRow> data={userScopes} idKey="scope" density="compact" columns={scopeColumns} />
        <Collapsible trigger={<Text weight="semibold">Manifest to paste</Text>} defaultIsOpen={false}>
          {manifest.data ? (
            <CodeBlock code={JSON.stringify(manifest.data.manifest, null, 2)} language="json" title="manifest.json" width="100%" maxHeight={360} size="sm" />
          ) : (
            <Text color="secondary">{manifest.error ? `Couldn't load the manifest: ${manifest.error}` : "Loading the manifest…"}</Text>
          )}
        </Collapsible>
      </PaneSection>
    </VStack>
  );
}
