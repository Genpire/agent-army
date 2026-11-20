import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/Code";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useState } from "react";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { CopyField } from "../../../components/CopyField";
import { api, errorMessage } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { useConfig } from "../../../lib/state";
import { FormActions, FormError, PaneSection, StatusLine, Steps, Strong, useSave } from "../parts";
import type { GitlabHookResult, GitlabWebhookInfo, GitlabWebhookResponse } from "./gitlab";

/** The webhook's address, from the server (PUBLIC_URL, else this page's host). */
function useWebhookUrl(configured: boolean): { url: string; error?: string } {
  const [info, setInfo] = useState<{ url: string; error?: string }>({ url: "" });
  useEffect(() => {
    let live = true;
    api
      .get<GitlabWebhookInfo>("/api/gitlab/webhook")
      .then((d) => live && setInfo({ url: d.url }))
      .catch((err) => live && setInfo({ url: "", error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [configured]);
  return info;
}

/**
 * The webhook that turns reviews and comments on the team's merge requests
 * into follow-up tasks. The server makes the secret token and returns it once;
 * it can also add the webhook to the allowed projects itself.
 */
export function GitLabWebhook() {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const { gitlab } = config;
  const configured = gitlab.webhook.configured;
  const { url, error: urlError } = useWebhookUrl(configured);
  const [installHooks, setInstallHooks] = useState(false);
  // The secret is shown once, until the pane closes; the server never sends it again.
  const [made, setMade] = useState<{ secret: string; hooks?: GitlabHookResult[] }>();
  const { save, error } = useSave();
  const projects = gitlab.allowed.filter((e) => e.includes("/")).length;

  const makeSecret = async () => {
    let response: GitlabWebhookResponse | undefined;
    const ok = await save(async () => (response = await api.post<GitlabWebhookResponse>("/api/gitlab/webhook", { installHooks })), {
      success: configured ? "New secret token made. Update it in GitLab where you added it by hand." : "Secret token made. Copy it into GitLab now.",
    });
    if (ok && response && "secret" in response) setMade({ secret: response.secret, hooks: response.hooks });
  };

  const remove = async () => {
    const ok = await save(() => api.post<GitlabWebhookResponse>("/api/gitlab/webhook", { remove: true }), {
      success: "Webhook secret removed. GitLab deliveries are now refused.",
    });
    if (ok) setMade(undefined);
  };

  return (
    <PaneSection
      title="Merge request reviews (webhook)"
      endContent={<StatusLine tone={configured ? "success" : "neutral"} text={configured ? "Configured" : "Not set up"} />}
      description={
        <>
          Optional. When someone with the Developer role or above requests changes, submits a review with comments, or writes a merge request comment that starts with{" "}
          <Code size="inherit">/pointer</Code> or mentions <Code size="inherit">@pointer</Code> on a merge request the team opened, {name} starts a follow-up task in the
          task's Slack thread. Approvals, bots and people without write access are ignored.
        </>
      }>
      <CopyField label="Webhook URL" value={url} description="Paste it into the webhook's URL field in GitLab. It is this deployment's address followed by /gitlab/webhook." />
      {urlError && <Banner status="error" title="Couldn't load the webhook URL" description={urlError} collapsible={false} />}
      <Steps
        label="Set it up in GitLab"
        steps={[
          <>
            Make a secret token below. To have {name} add the webhook for you, tick <Strong>Add it to the allowed projects</Strong> first: the token's user needs the
            Maintainer role on each project. A bot user with the Developer role (recommended, so it can never merge) adds it by hand instead.
          </>,
          <>
            Otherwise open the project's <Strong>Settings → Webhooks → Add new webhook</Strong>. A group's webhooks (GitLab Premium) cover all its projects.
          </>,
          <>
            <Strong>URL</Strong>: the URL above. <Strong>Secret token</Strong>: the token made below.
          </>,
          <>
            <Strong>Trigger</Strong>: tick <Strong>Comments</Strong> and <Strong>Merge request events</Strong> (so merges move monday.com tickets to done), and untick{" "}
            <Strong>Push events</Strong>.
          </>,
          <>
            Keep <Strong>Enable SSL verification</Strong> ticked and choose <Strong>Add webhook</Strong>. Its <Strong>Edit → Recent events</Strong> list shows each delivery.
          </>,
        ]}
      />
      <CheckboxInput
        label="Add it to the allowed projects"
        description={
          projects
            ? `Adds or updates the webhook on the ${plural(projects, "project")} in the allow list. Groups in the list are skipped.`
            : "The allow list names no projects (only groups, or nothing), so there is nothing to add it to: add it in GitLab."
        }
        value={installHooks}
        onChange={setInstallHooks}
        isDisabled={!projects}
      />
      <FormError message={error} />
      <FormActions>
        {configured ? (
          <ConfirmButton
            label="Make a new secret token"
            confirmLabel="Click again: webhooks with the old token stop working"
            size="md"
            onConfirm={makeSecret}
          />
        ) : (
          <Button label="Make a secret token" variant="primary" clickAction={makeSecret} />
        )}
        {configured && <ConfirmButton label="Remove" confirmLabel="Click again to remove" size="md" onConfirm={remove} />}
      </FormActions>
      {made && <MadeSecret secret={made.secret} hooks={made.hooks} />}
    </PaneSection>
  );
}

/** The secret token, shown this once, and what happened on each allowed project. */
function MadeSecret({ secret, hooks }: { secret: string; hooks?: GitlabHookResult[] }) {
  const failed = hooks?.filter((h) => !h.ok) ?? [];
  return (
    <VStack gap={4}>
      <Banner
        status="info"
        title="Copy the secret token now"
        description="It is stored encrypted and never shown again. Paste it into the webhook's Secret token field in GitLab."
        collapsible={false}>
        <CopyField label="Secret token" value={secret} />
      </Banner>
      {hooks && hooks.length > 0 && (
        <Banner
          status={failed.length ? "warning" : "success"}
          title={failed.length ? `The webhook could not be added on ${plural(failed.length, "project")}` : `Webhook added on ${plural(hooks.length, "project")}`}
          collapsible={false}>
          <List density="compact" hasDividers>
            {hooks.map((h) => (
              <ListItem
                key={h.path}
                label={<Text weight="semibold">{h.path}</Text>}
                description={<Text type="supporting">{h.ok ? (h.action === "updated" ? "Updated with the new token" : "Added") : h.error}</Text>}
              />
            ))}
          </List>
        </Banner>
      )}
      {hooks && hooks.length === 0 && (
        <Banner status="warning" title="No project to add the webhook to" description="Add it in GitLab with the steps above." collapsible={false} />
      )}
    </VStack>
  );
}
