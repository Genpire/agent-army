import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { BitbucketWebhook } from "./bitbucket/BitbucketWebhook";
import { bitbucketAllowListError, parseBitbucketAllowList } from "./bitbucket/allowList";
import { type IntegrationSummary, allowedText } from "./catalog";
import { FormActions, FormError, PaneHeader, PaneSection, Strong, useSave } from "./parts";

interface ScopeRow extends Record<string, unknown> {
  permission: string;
  access: string;
  scopes: string[];
  use: string;
}

/**
 * What the token needs. `permission` and `access` are the names on an access
 * token's form; `scopes` are an API token's. src/integrations/bitbucket/bitbucket.ts uses them.
 */
const SCOPES: ScopeRow[] = [
  {
    permission: "Repositories",
    access: "Write",
    scopes: ["read:repository:bitbucket", "write:repository:bitbucket"],
    use: "Clone repositories, push branches, read files and commit statuses",
  },
  {
    permission: "Pull requests",
    access: "Write",
    scopes: ["read:pullrequest:bitbucket", "write:pullrequest:bitbucket"],
    use: "Open and update pull requests, read reviews and comments",
  },
  { permission: "Pipelines", access: "Read", scopes: ["read:pipeline:bitbucket"], use: "Wait for Pipelines steps and read failing logs (CI loop)" },
  { permission: "Account", access: "Read", scopes: ["read:user:bitbucket"], use: "API tokens: who the token belongs to, and the commits' author" },
  { permission: "Workspace", access: "Read", scopes: ["read:workspace:bitbucket"], use: "API tokens: list workspaces and search code" },
  {
    permission: "Webhooks",
    access: "Read and write (optional)",
    scopes: ["read:webhook:bitbucket", "write:webhook:bitbucket"],
    use: "Add the review webhook to the allowed repositories from this page",
  },
];

export function BitbucketPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const { bitbucket } = config;
  const name = config.team.pointer.name;
  const apiToken = bitbucket.tokenKind === "api-token";

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={ArchiveBoxIcon}
        title="Bitbucket"
        tone={summary.tone}
        status={summary.status}
        description={`The agents clone repositories, push branches and open pull requests on Bitbucket Cloud with this token, and wait for Pipelines. Repositories are named bitbucket:workspace/repo. Without a code host, ${name} still chats, but repo tasks cannot run.`}
        onBack={onBack}
      />

      <MetadataList>
        <MetadataListItem label="Token">
          <Text>{bitbucket.connected ? `Connected${bitbucket.username ? ` as ${bitbucket.username}` : ""}` : "Not connected"}</Text>
        </MetadataListItem>
        {bitbucket.connected && (
          <MetadataListItem label="Kind">
            <Text>{apiToken ? "Atlassian API token" : "Workspace, project or repository access token"}</Text>
          </MetadataListItem>
        )}
        {bitbucket.connected && (
          <MetadataListItem label="It can use">
            <Text>{allowedText(bitbucket.allowed)}</Text>
          </MetadataListItem>
        )}
        <MetadataListItem label="Review webhook">
          <Text>{bitbucket.webhook.configured ? "Configured" : "Not set up"}</Text>
        </MetadataListItem>
      </MetadataList>

      <BitbucketToken />

      <PaneSection
        title="Token permissions"
        description={
          <>
            Use either kind of token. An <Strong>Atlassian API token with scopes</Strong>, ideally on a dedicated bot account, works with every repository that account
            can reach; enter its email above. A <Strong>workspace, project or repository access token</Strong> belongs to what it was made in; leave the email empty and
            name that workspace or repository in the allow list. Then protect your main branch so only people can merge.
          </>
        }>
        <Table<ScopeRow>
          data={SCOPES}
          idKey="permission"
          density="compact"
          verticalAlign="top"
          columns={[
            {
              key: "permission",
              header: "Permission",
              width: proportional(1, { minWidth: 110 }),
              renderCell: (r) => (
                <VStack gap={0.5}>
                  <Text weight="semibold">{r.permission}</Text>
                  <Text type="supporting">{r.access}</Text>
                </VStack>
              ),
            },
            {
              key: "scopes",
              header: "API token scopes",
              width: proportional(1.4, { minWidth: 150 }),
              renderCell: (r) => (
                <VStack gap={0.5}>
                  {r.scopes.map((s) => (
                    <Code key={s}>{s}</Code>
                  ))}
                </VStack>
              ),
            },
            { key: "use", header: "Needed to", width: proportional(2, { minWidth: 150 }) },
          ]}
        />
        <Text color="secondary">
          The review webhook only follows people with write access. Reading who has it needs admin on the repository (the <Code size="inherit">admin:repository:bitbucket</Code>{" "}
          scope, or Repositories: Admin on an access token); without it, every member of the repository's workspace counts as a writer.{" "}
          <Link href="https://id.atlassian.com/manage-profile/security/api-tokens" isExternalLink>
            Create an API token
          </Link>
        </Text>
      </PaneSection>

      <BitbucketWebhook />
    </VStack>
  );
}

/**
 * The token, its email and the allow list in one form. With a token typed,
 * saving verifies and replaces it; without one, saving only changes the allow
 * list (both POST /api/bitbucket), so the token need not be pasted again.
 */
function BitbucketToken() {
  const { config } = useConfig();
  const { bitbucket } = config;
  const saved = bitbucket.allowed.join(", ");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [allowed, setAllowed] = useState(saved);
  const { save, error, edit } = useSave();

  const entries = parseBitbucketAllowList(allowed);
  const listError = bitbucketAllowListError(entries);
  const replacing = token.trim() !== "";
  const listChanged = entries.join(",") !== bitbucket.allowed.join(",");
  const accessTokenUnscoped = !email.trim() && entries.length === 0;

  const submit = async () => {
    const t = token.trim();
    const e = email.trim();
    if (replacing || !bitbucket.connected) {
      const invalid = !t
        ? "Paste a Bitbucket token."
        : t.length < 20
          ? "That is too short to be a Bitbucket token."
          : (listError ??
            (accessTokenUnscoped ? "Without an email this is an access token: name its workspace or repository in the allow list." : undefined));
      const ok = await save(() => api.post<{ username?: string | null }>("/api/bitbucket", { token: t, email: e, allowed: entries }), {
        invalid,
        success: (r) => (r.username ? `Bitbucket connected as ${r.username}.` : "Bitbucket connected."),
      });
      if (ok) {
        setToken("");
        setEmail("");
      }
      return;
    }
    const ok = await save(() => api.post("/api/bitbucket", { allowed: entries }), { invalid: listError, success: "Allow list saved." });
    if (ok) setAllowed(entries.join(", "));
  };

  const label = !bitbucket.connected ? "Verify and save" : replacing ? "Verify and replace token" : "Save allow list";

  return (
    <PaneSection
      title="Token"
      description={
        bitbucket.connected
          ? "Edit the allow list and save, or paste a new token (and its email, for an API token) to replace this one. A new token is checked with Bitbucket before it is saved."
          : "Paste an API token with its account's email, or an access token without one. It is checked with Bitbucket, stored encrypted and never shown again."
      }>
      <FormLayout>
        <SecretField
          label="Bitbucket token"
          value={token}
          onChange={edit(setToken)}
          saved={bitbucket.connected ? bitbucket.key : null}
          placeholder={bitbucket.connected ? "Leave empty to keep the saved one" : "ATATT… or ATCTT…"}
          isRequired
        />
        <TextInput
          label="Atlassian account email"
          value={email}
          onChange={edit(setEmail)}
          placeholder="bot@your-company.example"
          description="For an API token: the email of the Atlassian account it belongs to. Leave empty for a workspace, project or repository access token."
          isOptional
          autoComplete="off"
          hasSpellCheck={false}
          autoCapitalize="off"
        />
        <TextInput
          label="Allowed workspaces or repositories"
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="your-workspace, your-workspace/your-repo"
          description="Comma separated. A workspace covers all its repositories; workspace/repo is one exact repository. Empty means any repository an API token can reach; an access token must name what it was made for."
          status={listError ? { type: "error", message: listError } : undefined}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={label} variant="primary" isDisabled={Boolean(listError) || (bitbucket.connected && !replacing && !listChanged)} clickAction={submit} />
        {bitbucket.connected && listChanged && !replacing && <Button label="Undo" variant="ghost" onClick={() => setAllowed(saved)} />}
        {bitbucket.connected && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Click again to disconnect"
            size="md"
            onConfirm={async () => {
              const ok = await save(() => api.post("/api/bitbucket/disconnect"), { success: "Bitbucket disconnected. Its token and webhook secret are deleted." });
              if (ok) setToken("");
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}
