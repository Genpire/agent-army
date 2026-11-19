import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { CopyField } from "../../../components/CopyField";
import { api } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { useConfig } from "../../../lib/state";
import { FormActions, FormError, PaneSection, StatusLine, Steps, Strong, useSave } from "../parts";
import { exactRepos } from "./allowList";

/** POST /api/bitbucket/webhook: the address, and a new secret (shown once) with each repository's webhook when asked. */
interface WebhookResult {
  url: string;
  secret?: string;
  hooks?: { repo: string; result: "created" | "updated" | "failed"; error?: string }[];
}

const HOOK_RESULT: Record<string, string> = { created: "Webhook added", updated: "Webhook updated with the new secret" };

/**
 * The webhook that turns change requests and comments on the team's Bitbucket
 * pull requests into follow-up tasks, and merges into done tickets. The page
 * makes the secret (shown once) and can add the webhook to the allowed
 * repositories itself.
 */
export function BitbucketWebhook() {
  const { config, state } = useConfig();
  const name = config.team.pointer.name;
  const { bitbucket } = config;
  const configured = bitbucket.webhook.configured;
  const repos = exactRepos(bitbucket.allowed);
  const [created, setCreated] = useState<WebhookResult>();
  const { save, error } = useSave();
  // The same deployment address the GitHub webhook uses, until the server answers with its own.
  const url =
    created?.url ?? state.githubWebhookUrl?.replace(/\/github\/webhook$/, "/bitbucket/webhook") ?? `${window.location.origin}/bitbucket/webhook`;

  const makeSecret = async (createHooks: boolean) => {
    let result: WebhookResult | undefined;
    const ok = await save(
      async () => {
        result = await api.post<WebhookResult>("/api/bitbucket/webhook", { createHooks });
        return result;
      },
      {
        success: (r) => {
          const failed = r.hooks?.filter((h) => h.result === "failed").length ?? 0;
          if (!createHooks) return "New webhook secret made. Copy it into Bitbucket now: it is not shown again.";
          return failed ? `Secret made; ${plural(failed, "repository", "repositories")} could not get the webhook. See below.` : "Secret made and the webhook added to the allowed repositories.";
        },
      },
    );
    if (ok && result) setCreated(result);
  };

  return (
    <PaneSection
      title="Pull request reviews (webhook)"
      endContent={<StatusLine tone={configured ? "success" : "neutral"} text={configured ? "Configured" : "Not set up"} />}
      description={
        <>
          Optional. When someone with write access requests changes, or writes a pull request comment that starts with <Code size="inherit">/pointer</Code> or mentions{" "}
          <Code size="inherit">@pointer</Code>, on a pull request the team opened, {name} starts a follow-up task in the task's thread. A merged or declined pull request
          moves its monday.com ticket. Bots and people without write access are ignored.
        </>
      }>
      <CopyField label="URL" value={url} description="Paste it into the webhook's URL field in Bitbucket. It is this deployment's address followed by /bitbucket/webhook." />
      <Steps
        label="Set it up in Bitbucket"
        steps={[
          <>
            Open the repository's <Strong>Repository settings → Webhooks → Add webhook</Strong>. A workspace admin can add one under the workspace's{" "}
            <Strong>Settings → Webhooks</Strong> to cover every repository.
          </>,
          <>
            <Strong>Title</Strong>: for example Agent Army. <Strong>URL</Strong>: the URL above. Keep <Strong>Active</Strong> ticked.
          </>,
          <>
            <Strong>Secret</Strong>: make one below and paste it there. It signs every delivery.
          </>,
          <>
            <Strong>Triggers</Strong>: choose <Strong>Choose from a full list of triggers</Strong>, and under <Strong>Pull Request</Strong> tick{" "}
            <Strong>Comment created</Strong>, <Strong>Changes request created</Strong>, <Strong>Merged</Strong> and <Strong>Declined</Strong>. Untick{" "}
            <Strong>Push</Strong>.
          </>,
          <>
            Choose <Strong>Save</Strong>. The webhook's <Strong>View requests</Strong> page shows each delivery once history is enabled.
          </>,
        ]}
      />
      <Text color="secondary">
        {configured
          ? "A new secret replaces the saved one at once: paste it into every Bitbucket webhook that points here, or let this page update the allowed repositories' webhooks."
          : repos.length > 0
            ? `This page can also add the webhook to the ${plural(repos.length, "repository", "repositories")} in the allow list, when the token may manage their webhooks.`
            : "The secret is stored encrypted and shown only once, right after it is made."}
      </Text>
      {created?.secret && (
        <CopyField label="Secret" value={created.secret} description="Shown once. Paste it into the webhook's Secret field in Bitbucket before you leave this page." />
      )}
      {created?.hooks && created.hooks.length > 0 && (
        <List density="compact" header={<Text type="label">Repository webhooks</Text>}>
          {created.hooks.map((h) => (
            <ListItem key={h.repo} label={h.repo} description={<Text color="secondary">{h.result === "failed" ? (h.error ?? "Failed") : HOOK_RESULT[h.result]}</Text>} />
          ))}
        </List>
      )}
      {created?.hooks && created.hooks.length === 0 && (
        <Banner status="info" title="No exact repositories in the allow list, so no webhook was added. Add it in Bitbucket with the steps above." collapsible={false} />
      )}
      <FormError message={error} />
      <FormActions>
        <Button label={configured ? "Replace secret" : "Make a secret"} variant="primary" clickAction={() => makeSecret(false)} />
        {bitbucket.connected && repos.length > 0 && (
          <Button label={`${configured ? "Replace" : "Make"} and add to ${plural(repos.length, "repository", "repositories")}`} clickAction={() => makeSecret(true)} />
        )}
        {configured && (
          <ConfirmButton
            label="Remove"
            confirmLabel="Click again to remove"
            size="md"
            onConfirm={async () => {
              const ok = await save(() => api.post("/api/bitbucket/webhook", { remove: true }), { success: "Webhook secret removed. Bitbucket deliveries are now refused." });
              if (ok) setCreated(undefined);
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}
