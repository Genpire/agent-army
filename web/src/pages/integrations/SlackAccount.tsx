/**
 * The Slack pane's "Your Slack account" section: the owner connects their own
 * Slack account with the app's User OAuth Token, so Pointer can send as them
 * and read what reaches them; then the switches (read, send as me, tell me
 * of answers to what Pointer sends for me), the privacy note, Disconnect,
 * and the follow-ups digest (an owner-only routine that DMs them what needs
 * their reply). Its steps use the account's own manifest (the bot's plus user
 * scopes and events): the bot's manifest asks nothing of anyone's account.
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
import { ManifestCode, ScopeTable, useAccountManifest } from "./slackManifest";

/** POST /api/slack/user */
interface ConnectResponse {
  userName: string;
  /** User scopes the manifest asks for that Slack did not grant. */
  missingScopes: string[];
  /** Only when it replaced another token: whether Slack revoked that one. */
  previousRevoked?: boolean;
}

/** POST /api/slack/user/disconnect */
interface DisconnectResponse {
  /** Slack confirmed the token is revoked (or it no longer worked). */
  revoked: boolean;
}

/** GET /api/slack/user/report */
interface ReportStatus {
  routine: { id: string; name: string } | null;
  /** Why it cannot be created now. */
  blocked: string | null;
}

/** What each user scope (your own account) is for. */
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

/** The follow-ups digest's status, read again whenever `key` changes (the account, its switches, the routines). */
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

export function SlackAccountSection() {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const user = config.slack.user;
  const manifest = useAccountManifest();
  // Set when Slack did not confirm that a disconnected or replaced token was revoked; kept until the page reloads.
  const [unrevoked, setUnrevoked] = useState(false);
  const scopes = manifest.data?.manifest.oauth_config.scopes.user ?? Object.keys(USER_SCOPE_USES);
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
      ) : (
        <VStack gap={4}>
          {unrevoked && (
            <Banner
              status="warning"
              title="Slack did not confirm that your token was revoked"
              description={`Until it is, Slack may keep sending your conversations to ${name}. Remove the app's access to your account in Slack, or update the app with the manifest under Already have an app? Update it, which asks nothing of your account, and reinstall it.`}
              collapsible={false}
            />
          )}
          {user.connected ? (
            <ConnectedAccount requiredScopes={manifest.data ? scopes : []} onRevoked={(revoked) => setUnrevoked(!revoked)} />
          ) : (
            <ConnectAccount
              onRevoked={(revoked) => {
                if (!revoked) setUnrevoked(true);
              }}
            />
          )}
          <Text color="secondary">Your account's scopes, in the manifest below and used only for you:</Text>
          <ScopeTable scopes={scopes} uses={USER_SCOPE_USES} />
          <ManifestCode label="Manifest with your account" manifest={manifest.data?.manifest} error={manifest.error} />
        </VStack>
      )}
    </PaneSection>
  );
}

function ConnectAccount({ onRevoked }: { onRevoked: (revoked: boolean) => void }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const [token, setToken] = useState("");
  const { save, error, edit } = useSave();

  const submit = async () => {
    const t = token.trim();
    const invalid = !t ? "Paste the User OAuth Token." : !t.startsWith("xoxp-") ? "User tokens start with xoxp-. Copy the User OAuth Token from OAuth & Permissions." : undefined;
    const connect = async () => {
      const r = await api.post<ConnectResponse>("/api/slack/user", { token: t });
      if (r.previousRevoked !== undefined) onRevoked(r.previousRevoked);
      return r;
    };
    const ok = await save(connect, {
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
            Open{" "}
            <Link href="https://api.slack.com/apps" isExternalLink>
              api.slack.com/apps
            </Link>
            , choose your app, open <Strong>App Manifest</Strong>, replace the JSON with the <Strong>Manifest with your account</Strong> below and save. It is the bot's
            manifest plus your account's scopes and the events for what reaches you.
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

function ConnectedAccount({ requiredScopes, onRevoked }: { requiredScopes: string[]; onRevoked: (revoked: boolean) => void }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const user = config.slack.user;
  const { save } = useSave();
  const report = useReport(user.connected ? `${user.userId}:${user.listen}:${config.routines.length}` : "");
  if (!user.connected) return null;
  const missing = requiredScopes.filter((s) => !(user.scopes ?? []).includes(s));

  const setSwitch = (key: "listen" | "sendAsMe" | "notifyAnswers", on: boolean, success: string) =>
    save(() => api.post("/api/slack/user/settings", { [key]: on }), { success }).then(() => undefined);

  const createReport = async () => {
    const ok = await save(() => api.post("/api/slack/user/report", {}), { success: `Created. ${name} will DM you on weekdays at 09:00, 13:00 and 17:00.` });
    if (ok) await report.reload();
  };

  const disconnect = async () => {
    const run = async () => {
      const r = await api.post<DisconnectResponse>("/api/slack/user/disconnect", {});
      onRevoked(r.revoked);
      return r;
    };
    await save(run, {
      success: (r) =>
        r.revoked
          ? "Your Slack account is disconnected, its token revoked and its inbox emptied."
          : "Your Slack account is disconnected and its inbox emptied, but Slack did not confirm that the token was revoked.",
    });
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
          description="Disconnect (which revokes this token), update the app with the manifest below, reinstall it, and connect with the new User OAuth Token."
          collapsible={false}
        />
      )}
      <Switch
        label="Read what reaches me"
        description={`${name} keeps your DMs, group DMs, mentions and replies in your threads for 14 days, encrypted, to tell you what needs your reply, with the answers to messages it sends for you. Off: nothing is kept, and what was kept is deleted.`}
        value={user.listen ?? false}
        changeAction={(on) =>
          setSwitch("listen", on, on ? `${name} reads what reaches you.` : `${name} no longer reads what reaches you, and what it kept is deleted.`)
        }
      />
      <Switch
        label="Send as me"
        description={`When you ask, ${name} can send a Slack message as you. Off: it only sends as itself. Routines never send as you.`}
        value={user.sendAsMe ?? false}
        changeAction={(on) => setSwitch("sendAsMe", on, on ? `${name} may send as you when you ask.` : `${name} only sends as itself.`)}
      />
      <Switch
        label={`Tell me right away when someone answers a message ${name} sent for me`}
        description={`When you ask ${name} to message someone and it sends as itself, their answer to it is kept in your inbox. On: ${name} also DMs you who answered and what, about a minute after they do.`}
        value={(user.listen ?? false) && (user.notifyAnswers ?? false)}
        isDisabled={!user.listen}
        disabledMessage="Turn on Read what reaches me first: answers are kept in your inbox."
        changeAction={(on) =>
          setSwitch("notifyAnswers", on, on ? `${name} will DM you when someone answers a message it sent for you.` : `Answers stay in your inbox; ${name} no longer DMs you about them.`)
        }
      />
      <Text color="secondary">
        Answers to messages {name} sends for you are passed on to you. People's own conversations with {name} stay private.
      </Text>

      <VStack gap={3}>
        <Heading level={4}>Follow-ups digest</Heading>
        <Text color="secondary">
          A routine that DMs you on weekdays at 09:00, 13:00 and 17:00 ({config.timezone}) what needs your reply or action on Slack, most urgent first, then a short FYI
          list, and keeps each report in the console. Change it on the Routines page like any routine. Any time, you can also ask {name}: “what needs my attention on
          Slack?”
        </Text>
        {report.error && <Banner status="error" title="Couldn't check the follow-ups digest" description={report.error} collapsible={false} />}
        <FormActions>
          {report.data?.routine ? (
            <Link href={href("routines", report.data.routine.id)} weight="semibold" isStandalone>
              Open “{report.data.routine.name}” on the Routines page
            </Link>
          ) : (
            <Button label="Create the follow-ups digest" variant="primary" isDisabled={!report.data || Boolean(report.data.blocked)} isLoading={!report.data && !report.error} clickAction={createReport} />
          )}
          {report.data?.blocked && !report.data.routine && (
            <Text type="supporting" color="secondary">
              {report.data.blocked}
            </Text>
          )}
        </FormActions>
      </VStack>

      <FormActions>
        <ConfirmButton label="Disconnect" confirmLabel="Click again to disconnect" size="md" onConfirm={disconnect} />
      </FormActions>
    </VStack>
  );
}
