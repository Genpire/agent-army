/**
 * The Jira pane: connect a Jira Cloud site (address, account email, API
 * token), the default project and the projects Pointer may use, Confluence
 * on the same site, and issues that start repo tasks.
 */
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type SearchSource, Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { TicketIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { type IntegrationSummary, parseList } from "./catalog";
import { JiraAutomation } from "./jira/JiraAutomation";
import { type JiraProject, type ProjectItem, fetchProjects, projectDescription, projectItem, projectKeysError } from "./jira/projects";
import { FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";

const API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function JiraPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const j = config.jira;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={TicketIcon}
        title={summary.name}
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name} find, open, comment on and move Jira issues from Slack and Chat, for example "open a bug in ACME for the login redirect", read Confluence pages on the same site, and, when you turn it on, start the team on issues that are ready for development. It never deletes issues or changes Confluence.`}
        onBack={onBack}
      />

      {j.connected && (
        <MetadataList>
          <MetadataListItem label="User">
            <Text>{j.userName || "Unknown"}</Text>
          </MetadataListItem>
          {j.siteUrl && (
            <MetadataListItem label="Site">
              <Link href={j.siteUrl} isExternalLink>
                {j.siteUrl.replace(/^https:\/\//, "")}
              </Link>
            </MetadataListItem>
          )}
          {j.email && (
            <MetadataListItem label="Account email">
              <Text>{j.email}</Text>
            </MetadataListItem>
          )}
        </MetadataList>
      )}

      <JiraConnection />
      {j.connected && <JiraProjects />}
      {j.connected && <JiraAutomation />}
    </VStack>
  );
}

function JiraConnection() {
  const { config } = useConfig();
  const j = config.jira;
  const name = config.team.pointer.name;
  const [site, setSite] = useState(j.siteUrl ?? "");
  const [email, setEmail] = useState(j.email ?? "");
  const [token, setToken] = useState("");
  const { save, error, edit } = useSave();

  const submit = async () => {
    const t = token.trim();
    const s = site.trim();
    const e = email.trim();
    const changed = s !== (j.siteUrl ?? "") || e !== (j.email ?? "");
    const invalid = !s
      ? "Enter the site address, like your-site.atlassian.net."
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
        ? "Enter the email of the Atlassian account the API token belongs to."
        : !t
          ? j.connected && !changed
            ? "Nothing changed. Paste a new API token to replace the saved one."
            : "Paste an API token: it belongs to the account's email and works on that site."
          : t.length < 20 || /\s/.test(t)
            ? "That doesn't look like an Atlassian API token."
            : undefined;
    const ok = await save(() => api.post<{ userName?: string }>("/api/jira", { siteUrl: s, email: e, ...(t ? { token: t } : {}) }), {
      invalid,
      success: (r) => (r.userName ? `Jira connected as ${r.userName}.` : "Jira connected."),
    });
    if (ok) setToken("");
  };

  return (
    <PaneSection
      title={j.connected ? "Connection" : "Connect Jira"}
      description={`The token acts as the Atlassian account that created it, with everything that account can see and change in Jira and Confluence. Use a dedicated account, for example "${name} bot", added only to the projects and spaces ${name} should work on.`}>
      {!j.connected && (
        <Steps
          label="To get an API token"
          steps={[
            <>
              Signed in as that account, open{" "}
              <Link href={API_TOKENS_URL} isExternalLink>
                Atlassian account → Security → API tokens
              </Link>{" "}
              and choose <Strong>Create API token</Strong> (not the one with scopes).
            </>,
            <>Name it, pick how long it lasts, and copy it. When it expires, create a new one and paste it here.</>,
            <>Enter the site address and the account's email below and paste the token. It is checked with Jira, stored encrypted and never shown again.</>,
          ]}
        />
      )}
      <FormLayout>
        <TextInput
          label="Site address"
          value={site}
          onChange={edit(setSite)}
          placeholder="your-site.atlassian.net"
          description="Your Jira Cloud site; a link to any page on it works too."
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isRequired
        />
        <TextInput
          type="email"
          label="Account email"
          value={email}
          onChange={edit(setEmail)}
          placeholder="pointer-bot@your-company.com"
          description="The Atlassian account the API token belongs to."
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isRequired
        />
        <SecretField label="API token" value={token} onChange={edit(setToken)} saved={j.connected ? j.key : null} placeholder={j.connected ? undefined : "ATATT3x…"} isRequired />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={j.connected ? "Verify and save" : "Verify and connect"} variant="primary" clickAction={submit} />
        {j.connected && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Click again to disconnect"
            size="md"
            onConfirm={async () => {
              await save(() => api.post("/api/jira/disconnect", {}), { success: "Jira disconnected. The site, projects and automation settings are kept." });
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** The default project (picked from the projects Jira lists, searchable), the projects Pointer may use, and Confluence. */
function JiraProjects() {
  const { config } = useConfig();
  const j = config.jira;
  const name = config.team.pointer.name;
  const known = useRef(new Map<string, JiraProject>());
  const [projectsError, setProjectsError] = useState<string>();
  const [recentCount, setRecentCount] = useState<number>();
  const [project, setProject] = useState<ProjectItem | null>(j.defaultProjectKey ? { id: j.defaultProjectKey, label: j.defaultProjectKey } : null);
  const [allowed, setAllowed] = useState(j.allowedProjectKeys.join(", "));
  const [confluence, setConfluence] = useState(j.confluence);
  const { save, error, edit } = useSave();

  const load = useCallback(async (query: string): Promise<ProjectItem[]> => {
    try {
      const projects = await fetchProjects(query);
      projects.forEach((p) => known.current.set(p.key, p));
      setProjectsError(undefined);
      if (!query) setRecentCount(projects.length);
      return projects.map(projectItem);
    } catch (err) {
      setProjectsError(`Couldn't load projects: ${errorMessage(err)}`);
      return [];
    }
  }, []);

  const source = useMemo<SearchSource<ProjectItem>>(() => ({ search: (q) => load(q.trim()), bootstrap: () => load("") }), [load]);

  // Names the saved default project once the projects arrive (the configuration only holds its key).
  useEffect(() => {
    const key = j.defaultProjectKey;
    void load("").then((items) => {
      const found = key ? items.find((i) => i.id === key) : undefined;
      if (found) setProject((current) => (current?.id === key ? found : current));
    });
  }, [load, j.defaultProjectKey]);

  const keys = [...new Set(parseList(allowed).map((k) => k.toUpperCase()))];
  const keysError = projectKeysError(keys);
  const defaultKey = project?.id ?? "";
  const defaultOutside = defaultKey !== "" && keys.length > 0 && !keys.includes(defaultKey);

  const submit = async () => {
    const saved = await save(() => api.post("/api/jira", { defaultProjectKey: defaultKey, allowedProjectKeys: keys, confluence }), {
      invalid: keysError ?? (defaultOutside ? `Add the default project (${defaultKey}) to the projects ${name} may use, or empty that list.` : undefined),
      success: "Project settings saved.",
    });
    if (saved) setAllowed(keys.join(", "));
  };

  const pickerHelp =
    recentCount === undefined ? "Loading projects…" : `Lists ${plural(recentCount, "project")}, most recently active first; type to search by key or name. Empty: ${name} asks which project.`;

  return (
    <PaneSection title="Projects" description={`Where ${name} opens issues when a request names no project, which projects it may touch at all, and whether it reads Confluence.`}>
      <FormLayout>
        <Typeahead<ProjectItem>
          label="Default project for issues"
          searchSource={source}
          value={project}
          onChange={edit(setProject)}
          placeholder="Search projects"
          hasEntriesOnFocus
          minQueryLength={1}
          debounceMs={250}
          maxMenuItems={50}
          description={projectsError ? undefined : pickerHelp}
          status={projectsError ? { type: "error", message: projectsError } : undefined}
          statusVariant="detached"
          emptySearchText="No projects match. Check the spelling, or that the account can browse the project."
          renderItem={(item) => <TypeaheadItem item={item} description={projectDescription(item.auxiliaryData ?? known.current.get(item.id), item.id)} />}
          isOptional
        />
        <TextInput
          label={`Projects ${name} may use`}
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="Every project the account can see"
          description="Project keys, comma separated: the letters before the number in an issue key (ACME in ACME-123). Empty means every project the account can see; otherwise include the default project."
          status={keysError ? { type: "error", message: keysError } : defaultOutside ? { type: "warning", message: "The default project is not in this list." } : undefined}
          autoCapitalize="characters"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isOptional
        />
        <Switch
          label="Read Confluence"
          description={`${name} can search and read Confluence pages on the same site that the account can see. It never changes them.`}
          value={confluence}
          onChange={edit(setConfluence)}
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label="Save projects" variant="primary" isDisabled={Boolean(keysError)} clickAction={submit} />
      </FormActions>
    </PaneSection>
  );
}
