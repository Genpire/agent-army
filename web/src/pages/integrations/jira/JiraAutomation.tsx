import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { CopyField } from "../../../components/CopyField";
import { api } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { href } from "../../../lib/router";
import { useConfig } from "../../../lib/state";
import { FormActions, PaneSection, StatusLine, Steps, Strong, useSave } from "../parts";
import { JiraProjectDrawer } from "./JiraProjectDrawer";
import { type JiraProject, type ProjectAutomation, type WebhookResponse, fetchProjects } from "./projects";

interface ProjectRow extends Record<string, unknown> {
  key: string;
  name: string;
  project: ProjectAutomation;
}

/** "In Progress → In Review → Done", without the steps that leave the status alone. */
const flow = (p: ProjectAutomation) => [p.workingStatus, p.reviewStatus, p.doneStatus].filter(Boolean).join(" → ") || "Status left as it is";

/**
 * Issues that start repo tasks: on/off, the projects whose issues the team
 * works on with the statuses it moves them to, and the webhook Jira calls.
 */
export function JiraAutomation() {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const auto = config.jira.automation;
  const known = useRef(new Map<string, JiraProject>());
  const [names, setNames] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<{ isOpen: boolean; projectKey?: string }>({ isOpen: false });
  const [result, setResult] = useState<WebhookResponse>();
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const { save } = useSave();

  // Names for the automated projects (the configuration only holds their keys).
  useEffect(() => {
    let live = true;
    fetchProjects("")
      .then((projects) => {
        projects.forEach((p) => known.current.set(p.key, p));
        if (live) setNames(Object.fromEntries(projects.map((p) => [p.key, p.name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const projectName = (key: string) => names[key] ?? key;
  const rows: ProjectRow[] = Object.entries(auto.projects).map(([key, project]) => ({ key, name: projectName(key), project }));

  const toggle = async (enabled: boolean) => {
    await save(() => api.post("/api/jira/automation", { enabled }), {
      success: enabled ? "Issue automation is on." : "Issue automation is off: issues no longer start tasks, and Jira's deliveries are refused.",
    });
  };

  const connect = async (rotate: boolean) => {
    let out: WebhookResponse | undefined;
    const ok = await save(
      async () => {
        out = await api.post<WebhookResponse>("/api/jira/automation/webhook", rotate ? { rotate: true } : {});
        return out;
      },
      {
        success: (r) =>
          r.ok
            ? r.kept
              ? "The webhook is already registered in Jira."
              : `Webhook registered in Jira for ${plural(rows.length, "project")}.`
            : "The webhook could not be registered in Jira. See the steps to add it by hand.",
      },
    );
    if (ok) setResult(out);
  };

  const removeButton = (r: ProjectRow) => (
    <ConfirmButton
      label="Remove"
      confirmLabel="Click again to remove"
      onConfirm={async () => {
        await save(() => api.post("/api/jira/automation", { projects: { [r.key]: null } }), { success: `Issues in ${r.name} no longer start tasks.` });
      }}
    />
  );

  return (
    <PaneSection
      title="Issue automation"
      endContent={<StatusLine tone={auto.enabled ? "success" : "neutral"} text={auto.enabled ? `On · ${plural(rows.length, "project")}` : "Off"} />}
      description={`Optional. When an issue in a project below moves to its start status (for example "Ready for dev"), the team starts on it in a new Chat conversation named after the issue, and the issue shows the progress.`}>
      <Steps
        label="What happens to an issue"
        steps={[
          <>
            Someone moves the issue to the project's start status. {name} reads the issue again from Jira (the notification itself is not trusted) and starts the team on the
            project's repository, with the issue's summary, description and latest comments.
          </>,
          <>The issue moves to the "working" status, with a comment linking the task's conversation.</>,
          <>When the pull request opens, its link is posted and the issue moves to the "in review" status.</>,
          <>If the team stops, fails or is blocked, the issue moves to the "stuck" status with the reason (and the draft pull request, if any).</>,
          <>
            When the pull request is merged, the issue moves to the "done" status. This needs the code host's webhook (on{" "}
            <Link href={href("integrations", "github")}>GitHub</Link>, with <Strong>Pull requests</Strong> ticked).
          </>,
        ]}
      />
      <Switch
        label="Start tasks from issues"
        description="Off: no issue starts a task and Jira's deliveries are refused. Tasks already running keep updating their issues."
        value={auto.enabled}
        changeAction={toggle}
      />

      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={4}>Projects</Heading>
          <Button label="Automate a project" size="sm" onClick={() => setDrawer({ isOpen: true })} />
        </HStack>
        {rows.length > 0 ? (
          <Table<ProjectRow>
            data={rows}
            idKey="key"
            verticalAlign="top"
            columns={[
              {
                key: "project",
                header: "Project and repository",
                width: proportional(1, { minWidth: 160 }),
                renderCell: (r) => (
                  <VStack gap={0.5} hAlign="start">
                    <Link weight="medium" onClick={() => setDrawer({ isOpen: true, projectKey: r.key })} tooltip={`Edit the automation of ${r.name}`}>
                      {r.name}
                    </Link>
                    <Code size="inherit">{r.project.repo}</Code>
                    {names[r.key] && <Text type="supporting">Key {r.key}</Text>}
                    {isNarrow && removeButton(r)}
                  </VStack>
                ),
              },
              {
                key: "statuses",
                header: "Status",
                width: proportional(1, { minWidth: isNarrow ? 150 : 180 }),
                renderCell: (r) => (
                  <VStack gap={0.5}>
                    <Text>
                      {r.project.startStatus} → {flow(r.project)}
                    </Text>
                    <Text type="supporting">{r.project.stuckStatus ? `${r.project.stuckStatus} when the team stops` : "Status left as it is when the team stops"}</Text>
                  </VStack>
                ),
              },
              ...(isNarrow
                ? []
                : [
                    {
                      key: "actions",
                      header: "",
                      width: pixel(176),
                      resizable: false,
                      align: "end" as const,
                      renderCell: (r: ProjectRow) => <HStack hAlign="end">{removeButton(r)}</HStack>,
                    },
                  ]),
            ]}
          />
        ) : (
          <Text color="secondary">No project yet. Add one to choose its repository and the statuses the team moves its issues to.</Text>
        )}
      </VStack>

      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={4}>Webhook</Heading>
          <StatusLine tone={auto.webhookConfigured ? "success" : "neutral"} text={auto.webhookConfigured ? "Set up" : "Not set up"} />
        </HStack>
        <Text color="secondary">
          Jira tells {name} when an issue changes. Connecting registers a webhook in Jira for the projects above, pointing at this deployment and signed with its secret; it
          needs the account to be a Jira administrator, otherwise you get the steps to add it by hand. Connect again after adding a project.
        </Text>
        <FormActions>
          <Button label={auto.webhookConfigured ? "Connect again" : "Connect webhook"} variant="primary" isDisabled={rows.length === 0} clickAction={() => connect(false)} />
          {auto.webhookConfigured && rows.length > 0 && (
            <ConfirmButton label="New secret" confirmLabel="Click again: the old address stops working" size="md" onConfirm={() => connect(true)} />
          )}
          {rows.length === 0 && (
            <Text type="supporting" color="secondary">
              Add a project first.
            </Text>
          )}
        </FormActions>
        {result && <WebhookResult result={result} />}
      </VStack>

      <JiraProjectDrawer
        isOpen={drawer.isOpen}
        projectKey={drawer.projectKey}
        known={known.current}
        onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, isOpen }))}
      />
    </PaneSection>
  );
}

/** Registered in Jira, or why not and how to add it by hand; the address and secret either way. */
function WebhookResult({ result }: { result: WebhookResponse }) {
  const fields = (
    <VStack gap={3}>
      <CopyField label="Webhook URL" value={result.url} description="Secret: anyone with this address can send issue changes. Paste it only into Jira." />
      <CopyField label="Secret" value={result.secret} description="The same secret is at the end of the URL. Jira signs deliveries with it when it is set on the webhook." />
    </VStack>
  );
  if (result.ok) {
    return (
      <Banner
        status="success"
        title={result.kept ? "Registered in Jira" : "Webhook registered in Jira"}
        description={`For issues matching ${result.jql}, signed with the secret.`}
        collapsible={false}
      />
    );
  }
  return (
    <Banner status="warning" title="The webhook could not be registered in Jira" description={result.error} collapsible={false}>
      <VStack gap={4}>
        <Text>
          Registering a webhook needs the account to have the Administer Jira permission. A Jira administrator can add it by hand:
        </Text>
        {result.manualSteps && <Steps label="In Jira" steps={result.manualSteps} />}
        {fields}
      </VStack>
    </Banner>
  );
}
