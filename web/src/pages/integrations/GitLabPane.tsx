import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { CodeBracketSquareIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { type IntegrationSummary, allowedText, parseList } from "./catalog";
import { GitLabWebhook } from "./gitlab/GitLabWebhook";
import { type GitlabConnectResponse, baseUrlError, gitlabAllowListError, normalizeBaseUrl, normalizeEntry, tokenPageUrl } from "./gitlab/gitlab";
import { FormActions, FormError, PaneHeader, PaneSection, useSave } from "./parts";

interface ScopeRow extends Record<string, unknown> {
  scope: string;
  kind: string;
  use: string;
}

/** What the token needs (README: GitLab). */
const SCOPES: ScopeRow[] = [
  { scope: "api", kind: "Scope", use: "Open and update merge requests, comment, read pipelines and job logs; also covers Git clone and push" },
  { scope: "write_repository", kind: "Scope", use: "Push branches over Git (api already includes it; tick it too so the token's purpose is plain)" },
  {
    scope: "Developer",
    kind: "Role on each project",
    use: "Push branches and open merge requests. Keep it at Developer and protect the default branch so only Maintainers merge: the token can then never merge. Adding the webhook for you needs Maintainer; otherwise add it by hand",
  },
];

export function GitLabPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const { gitlab } = config;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={CodeBracketSquareIcon}
        title="GitLab"
        tone={summary.tone}
        status={summary.status}
        description={`The agents read code, push branches and open merge requests on gitlab.com or your own GitLab with this token. Repositories there are named gitlab:group/project, and ${name} works on them like on GitHub.`}
        onBack={onBack}
      />

      <MetadataList>
        <MetadataListItem label="Token">
          <Text>{gitlab.connected ? `Connected${gitlab.username ? ` as ${gitlab.username}` : ""}` : "Not connected"}</Text>
        </MetadataListItem>
        <MetadataListItem label="Address">
          <Text>{gitlab.baseUrl}</Text>
        </MetadataListItem>
        {gitlab.connected && (
          <MetadataListItem label="It can use">
            <Text>{allowedText(gitlab.allowed)}</Text>
          </MetadataListItem>
        )}
        <MetadataListItem label="Review webhook">
          <Text>{gitlab.webhook.configured ? "Configured" : "Not set up"}</Text>
        </MetadataListItem>
      </MetadataList>

      <TokenForm />

      <PaneSection
        title="Token scopes"
        description="Create a personal access token, ideally on a dedicated account, or a group or project access token, limited to the projects the agents may work on. Then protect your main branch so only people can merge.">
        <Table<ScopeRow>
          data={SCOPES}
          idKey="scope"
          density="compact"
          verticalAlign="top"
          columns={[
            {
              key: "scope",
              header: "Scope or role",
              width: proportional(1, { minWidth: 120 }),
              renderCell: (r) => (
                <VStack gap={0.5}>
                  <Text weight="semibold">{r.scope}</Text>
                  <Text type="supporting">{r.kind}</Text>
                </VStack>
              ),
            },
            { key: "use", header: "Needed to", width: proportional(2, { minWidth: 150 }) },
          ]}
        />
        <Text color="secondary">
          Waiting for pipelines and reading failing job logs needs nothing more: <Code size="inherit">api</Code> covers them.{" "}
          <Link href={tokenPageUrl(gitlab.baseUrl)} isExternalLink>
            Create a token on GitLab
          </Link>
        </Text>
      </PaneSection>

      {gitlab.connected && <GitLabWebhook />}
      {gitlab.connected && <Disconnect />}
    </VStack>
  );
}

/**
 * The address, token and allow list in one form. A token typed is checked
 * with GitLab before it is saved; without one, saving changes only the allow
 * list. A new address needs the token again, so the saved one is never sent
 * to an address it was not checked with.
 */
function TokenForm() {
  const { config } = useConfig();
  const { gitlab } = config;
  const saved = gitlab.allowed.join(", ");
  const [baseUrl, setBaseUrl] = useState(gitlab.baseUrl);
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState(saved);
  const { save, error, edit } = useSave();

  const url = normalizeBaseUrl(baseUrl);
  const entries = [...new Set(parseList(allowed).map(normalizeEntry).filter(Boolean))];
  const urlError = baseUrlError(url);
  const listError = gitlabAllowListError(entries);
  const replacing = token.trim() !== "";
  const urlChanged = url !== gitlab.baseUrl;
  const listChanged = entries.join(",") !== gitlab.allowed.join(",");

  const submit = async () => {
    const t = token.trim();
    const invalid =
      urlError ??
      (!t && !gitlab.connected ? "Paste a GitLab access token." : undefined) ??
      (t && t.length < 20 ? "That is too short to be a GitLab token." : undefined) ??
      (!t && urlChanged ? "Paste the token again to change the GitLab address: it is checked with the new address first." : undefined) ??
      listError;
    const ok = await save(() => api.post<GitlabConnectResponse>("/api/gitlab", { ...(t ? { token: t } : {}), baseUrl: url, allowed: entries }), {
      invalid,
      success: (r) => (t ? (r.username ? `GitLab connected as ${r.username}.` : "GitLab connected.") : "Allow list saved."),
    });
    if (ok) {
      setToken("");
      setBaseUrl(url);
      setAllowed(entries.join(", "));
    }
  };

  const label = !gitlab.connected ? "Verify and save" : replacing ? "Verify and replace token" : "Save allow list";
  const unchanged = gitlab.connected && !replacing && !listChanged && !urlChanged;

  return (
    <PaneSection
      title="Token"
      description={
        gitlab.connected
          ? "Edit the allow list and save, or paste a new token to replace this one. A new token is checked with GitLab before it is saved."
          : "Paste an access token with the scopes below. It is checked with GitLab, stored encrypted and never shown again."
      }>
      <FormLayout>
        <TextInput
          label="GitLab address"
          value={baseUrl}
          onChange={edit(setBaseUrl)}
          placeholder="https://gitlab.com"
          description="https://gitlab.com, or your own GitLab's address (self-managed or GitLab Dedicated)."
          status={urlError ? { type: "error", message: urlError } : undefined}
        />
        <SecretField
          label="Access token"
          value={token}
          onChange={edit(setToken)}
          saved={gitlab.key}
          placeholder={gitlab.connected ? "Leave empty to keep the saved one" : "glpat-…"}
          isRequired
        />
        <TextInput
          label="Allowed groups or projects"
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="acme, acme/platform/web"
          description="Comma separated. A group covers its projects and subgroups; group/project is one exact project. Empty means any project the token can reach."
          status={listError ? { type: "error", message: listError } : undefined}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={label} variant="primary" isDisabled={Boolean(listError) || Boolean(urlError) || unchanged} clickAction={submit} />
        {gitlab.connected && (listChanged || urlChanged) && !replacing && (
          <Button
            label="Undo"
            variant="ghost"
            onClick={() => {
              setAllowed(saved);
              setBaseUrl(gitlab.baseUrl);
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** Removes the token, its user and the webhook secret; the address and allow list stay for a reconnect. */
function Disconnect() {
  const { save, error } = useSave();
  return (
    <PaneSection
      title="Disconnect"
      description="Repo tasks on GitLab projects stop, and GitLab's webhook deliveries are refused. The address and allow list are kept. Remove the webhook in GitLab, and revoke the token there if it is no longer needed.">
      <FormError message={error} />
      <FormActions>
        <ConfirmButton
          label="Disconnect GitLab"
          confirmLabel="Click again to disconnect"
          size="md"
          onConfirm={async () => {
            await save(() => api.post("/api/gitlab/disconnect"), { success: "GitLab disconnected." });
          }}
        />
      </FormActions>
    </PaneSection>
  );
}
