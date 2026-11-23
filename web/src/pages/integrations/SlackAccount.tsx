/**
 * The Slack pane's "Your Slack account" section: the owner connects their own
 * Slack account with the app's User OAuth Token, so Pointer can send as them
 * and read what reaches them; then the two switches, Disconnect, and the
 * attention report (a routine that DMs them what needs their reply).
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api, errorMessage } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { FormActions, FormError, PaneSection, StatusLine, Steps, Strong, useSave } from "./parts";

/** POST /api/slack/user */
interface ConnectResponse {
  userName: string;
  /** User scopes the manifest asks for that Slack did not grant. */
  missingScopes: string[];
}

/** GET /api/slack/user/report */
interface ReportStatus {
  routine: { id: string; name: string } | null;
  /** Why it cannot be created now. */
  blocked: string | null;
}

/** The attention report's status, read again whenever `key` changes (the account, its switches, the routines). */
function useReport(key: string) {
  const [data, setData] = useState<ReportStatus>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setData(await api.get<ReportStatus>("/api/slack/user/report"));
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, key]);
  return { data, error, reload: load };
}

/** `requiredScopes`: the user scopes in this deployment's manifest, to name the ones Slack did not grant. */
export function SlackAccountSection({ requiredScopes }: { requiredScopes: string[] }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const user = config.slack.user;
  return (
    <PaneSection
      title="Your Slack account"
      endContent={<StatusLine tone={user.connected ? "success" : "neutral"} text={user.connected ? `Connected as @${user.userName || user.userId}` : "Not connected"} />}
      description={
        `Optional. Connect your own Slack account so ${name} can send messages as you when you ask, and read what reaches you (direct messages, group DMs, ` +
        `mentions and replies in your threads) to tell you what needs your reply. Only you can use it: in this console, in your routines and in your own DMs ` +
        `with ${name}. What people send you is never a request to ${name}: it only reads it.`
      }>
      {!config.slack.connected ? (
        <Text color="secondary">Connect Slack above first: your account must be in the same workspace as {name}.</Text>
      ) : user.connected ? (
        <ConnectedAccount requiredScopes={requiredScopes} />
      ) : (
        <ConnectAccount />
      )}
    </PaneSection>
  );
}

function ConnectAccount() {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const [token, setToken] = useState("");
  const { save, error, edit } = useSave();

  const submit = async () => {
    const t = token.trim();
    const invalid = !t ? "Paste the User OAuth Token." : !t.startsWith("xoxp-") ? "User tokens start with xoxp-. Copy the User OAuth Token from OAuth & Permissions." : undefined;
    const ok = await save(() => api.post<ConnectResponse>("/api/slack/user", { token: t }), {
      invalid,
      success: (r) =>
        r.missingScopes.length
          ? `Connected as @${r.userName}. Slack did not grant ${r.missingScopes.join(", ")}: update the app with the manifest below and reinstall it.`
          : `Connected as @${r.userName}.`,
    });
    if (ok) setToken("");
  };

  return (
    <VStack gap={4}>
      <Steps
        label="To connect your account"
        steps={[
          <>
            Update the app with the manifest under <Strong>Already have an app? Update it</Strong> below: it adds your account's scopes and the events for what reaches you.
          </>,
          <>
            Open <Strong>Install App</Strong>, choose <Strong>Reinstall to Workspace</Strong> and <Strong>Allow</Strong>. Slack asks for your own account's permissions too.
          </>,
          <>
            Open <Strong>OAuth &amp; Permissions</Strong> and copy the <Strong>User OAuth Token</Strong>, the one that starts with xoxp-.
          </>,
          <>Paste it below. It is checked with Slack, stored encrypted and never shown again.</>,
        ]}
      />
      <FormLayout>
        <SecretField
          label="User OAuth Token"
          value={token}
          onChange={edit(setToken)}
          placeholder="xoxp-…"
          description={`Your own token, not the bot's: ${name} uses it only for your requests.`}
          isRequired
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label="Verify and connect" variant="primary" clickAction={submit} />
      </FormActions>
    </VStack>
  );
}

function ConnectedAccount({ requiredScopes }: { requiredScopes: string[] }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const user = config.slack.user;
  const { save } = useSave();
  const report = useReport(user.connected ? `${user.userId}:${user.listen}:${config.routines.length}` : "");
  if (!user.connected) return null;
  const missing = requiredScopes.filter((s) => !(user.scopes ?? []).includes(s));

  const setSwitch = (key: "listen" | "sendAsMe", on: boolean, success: string) =>
    save(() => api.post("/api/slack/user/settings", { [key]: on }), { success }).then(() => undefined);

  const createReport = async () => {
    const ok = await save(() => api.post("/api/slack/user/report", {}), { success: `Created. ${name} will DM you on weekdays at 09:00, 13:00 and 17:00.` });
    if (ok) await report.reload();
  };

  return (
    <VStack gap={4}>
      <MetadataList>
        <MetadataListItem label="Account">
          <Text>@{user.userName || user.userId}</Text>
        </MetadataListItem>
        <MetadataListItem label="User id">
          <Code size="inherit">{user.userId}</Code>
        </MetadataListItem>
        <MetadataListItem label="Token">
          <Text>
            {user.key ?? "Saved"}, connected {timeAgo(user.connectedAt)}
          </Text>
        </MetadataListItem>
      </MetadataList>
      {missing.length > 0 && (
        <Banner
          status="warning"
          title={`Slack did not grant ${missing.join(", ")}`}
          description="Update the app with the manifest below, reinstall it, and connect again with the new User OAuth Token."
          collapsible={false}
        />
      )}
      <Switch
        label="Read what reaches me"
        description={`${name} keeps your DMs, group DMs, mentions and replies in your threads for 14 days, encrypted, to tell you what needs your reply. Off: nothing new is kept.`}
        value={user.listen ?? false}
        changeAction={(on) => setSwitch("listen", on, on ? `${name} reads what reaches you.` : `${name} no longer reads what reaches you.`)}
      />
      <Switch
        label="Send as me"
        description={`When you ask, ${name} can send a Slack message as you. Off: it only sends as itself. Routines never send as you.`}
        value={user.sendAsMe ?? false}
        changeAction={(on) => setSwitch("sendAsMe", on, on ? `${name} may send as you when you ask.` : `${name} only sends as itself.`)}
      />

      <VStack gap={3}>
        <Heading level={4}>Attention report</Heading>
        <Text color="secondary">
          A routine that DMs you on weekdays at 09:00, 13:00 and 17:00 ({config.timezone}) what needs your reply or action on Slack, most urgent first, then a short FYI
          list, and keeps each report in the console. Change it on the Routines page like any routine. Any time, you can also ask {name}: “what needs my attention on
          Slack?”
        </Text>
        {report.error && <Banner status="error" title="Couldn't check the attention report" description={report.error} collapsible={false} />}
        <FormActions>
          {report.data?.routine ? (
            <Link href={href("routines", report.data.routine.id)} weight="semibold" isStandalone>
              Open “{report.data.routine.name}” on the Routines page
            </Link>
          ) : (
            <Button label="Create the attention report" variant="primary" isDisabled={!report.data || Boolean(report.data.blocked)} isLoading={!report.data && !report.error} clickAction={createReport} />
          )}
          {report.data?.blocked && !report.data.routine && (
            <Text type="supporting" color="secondary">
              {report.data.blocked}
            </Text>
          )}
        </FormActions>
      </VStack>

      <FormActions>
        <ConfirmButton
          label="Disconnect"
          confirmLabel="Click again to disconnect"
          size="md"
          onConfirm={async () => {
            await save(() => api.post("/api/slack/user/disconnect", {}), { success: "Your Slack account is disconnected and its inbox emptied." });
          }}
        />
      </FormActions>
    </VStack>
  );
}
