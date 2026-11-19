import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { CodeBracketIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { type IntegrationSummary, allowListError, allowedText, parseList } from "./catalog";
import { GitHubConnections } from "./GitHubConnections";
import { GitHubWebhook } from "./GitHubWebhook";
import { FormActions, FormError, PaneHeader, PaneSection, useSave } from "./parts";

interface PermissionRow extends Record<string, unknown> {
  permission: string;
  access: string;
  use: string;
}

/** The fine-grained token's repository permissions (README: Onboarding, CI checks). */
const PERMISSIONS: PermissionRow[] = [
  { permission: "Contents", access: "Read and write", use: "Clone repos, commit and push branches" },
  { permission: "Pull requests", access: "Read and write", use: "Open and update pull requests" },
  { permission: "Metadata", access: "Read", use: "Required by GitHub for every token" },
  { permission: "Checks", access: "Read", use: "Wait for a pull request's checks (CI loop)" },
  { permission: "Commit statuses", access: "Read", use: "Read status checks such as Vercel (CI loop)" },
  { permission: "Actions", access: "Read", use: "Read failing job logs to fix them (CI loop)" },
];

export function GitHubPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const { github } = config;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={CodeBracketIcon}
        title="GitHub"
        tone={summary.tone}
        status={summary.status}
        description={`The agents read code, push branches and open pull requests with these tokens. Without GitHub, ${name} still chats, but repo tasks cannot run.`}
        onBack={onBack}
      />

      <MetadataList>
        <MetadataListItem label="Primary token">
          <Text>{github.connected ? `Connected${github.login ? ` as ${github.login}` : ""}` : "Not connected"}</Text>
        </MetadataListItem>
        {github.connected && (
          <MetadataListItem label="It can use">
            <Text>{allowedText(github.allowedOwners)}</Text>
          </MetadataListItem>
        )}
        <MetadataListItem label="Other connections">
          <Text>{github.extra.length ? plural(github.extra.length, "connection") : "None"}</Text>
        </MetadataListItem>
        <MetadataListItem label="Review webhook">
          <Text>{github.webhook.configured ? "Configured" : "Not set up"}</Text>
        </MetadataListItem>
      </MetadataList>

      <PrimaryToken />

      <PaneSection
        title="Token permissions"
        description="Create a fine-grained personal access token, ideally on a dedicated bot account, limited to the repositories the agents may work on. Then protect your main branch so only people can merge.">
        <Table<PermissionRow>
          data={PERMISSIONS}
          idKey="permission"
          density="compact"
          verticalAlign="top"
          columns={[
            {
              key: "permission",
              header: "Repository permission",
              width: proportional(1, { minWidth: 110 }),
              renderCell: (r) => (
                <VStack gap={0.5}>
                  <Text weight="semibold">{r.permission}</Text>
                  <Text type="supporting">{r.access}</Text>
                </VStack>
              ),
            },
            { key: "use", header: "Needed to", width: proportional(2, { minWidth: 150 }) },
          ]}
        />
        <Text color="secondary">
          The last three are only needed when repo tasks wait for checks and fix the failing ones.{" "}
          <Link href="https://github.com/settings/personal-access-tokens/new" isExternalLink>
            Create a token on GitHub
          </Link>
        </Text>
      </PaneSection>

      <GitHubConnections />
      <GitHubWebhook />
    </VStack>
  );
}

/**
 * The primary token and its allow list in one form. With a token typed, saving
 * verifies and replaces it (POST /api/github); without one, saving only
 * changes the allow list (POST /api/settings), so the token need not be pasted again.
 */
function PrimaryToken() {
  const { config } = useConfig();
  const { github } = config;
  const saved = github.allowedOwners.join(", ");
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState(saved);
  const { save, error, edit } = useSave();

  const entries = parseList(allowed);
  const listError = allowListError(entries);
  const replacing = token.trim() !== "";
  const listChanged = entries.join(",") !== github.allowedOwners.join(",");

  const submit = async () => {
    const t = token.trim();
    if (replacing || !github.connected) {
      const invalid = !t ? "Paste a GitHub token." : t.length < 20 ? "That is too short to be a GitHub token." : listError;
      const ok = await save(() => api.post<{ login?: string }>("/api/github", { token: t, allowedOwners: entries }), {
        invalid,
        success: (r) => {
          const login = r.login;
          return login ? `GitHub connected as ${login}.` : "GitHub connected.";
        },
      });
      if (ok) setToken("");
      return;
    }
    const ok = await save(() => api.post("/api/settings", { allowedOwners: entries }), { invalid: listError, success: "Allow list saved." });
    if (ok) setAllowed(entries.join(", "));
  };

  const label = !github.connected ? "Verify and save" : replacing ? "Verify and replace token" : "Save allow list";

  return (
    <PaneSection
      title="Primary token"
      description={
        github.connected
          ? "Edit the allow list and save, or paste a new token to replace this one. A new token is checked with GitHub before it is saved."
          : "Paste a fine-grained token with the permissions below. It is checked with GitHub, stored encrypted and never shown again."
      }>
      <FormLayout>
        <SecretField
          label="GitHub token"
          value={token}
          onChange={edit(setToken)}
          saved={github.connected ? "••••" : null}
          placeholder={github.connected ? "Leave empty to keep the saved one" : "github_pat_…"}
          isRequired
        />
        <TextInput
          label="Allowed owners or repos"
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="your-org, someone/some-repo"
          description="Comma separated. An owner covers all its repos; owner/repo is one exact repo. Empty means any repository the token can reach."
          status={listError ? { type: "error", message: listError } : undefined}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={label} variant="primary" isDisabled={Boolean(listError) || (github.connected && !replacing && !listChanged)} clickAction={submit} />
        {github.connected && listChanged && !replacing && <Button label="Undo" variant="ghost" onClick={() => setAllowed(saved)} />}
      </FormActions>
    </PaneSection>
  );
}
