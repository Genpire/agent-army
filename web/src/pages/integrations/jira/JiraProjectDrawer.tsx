import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type SearchSource, type SearchableItem, Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useMemo, useState } from "react";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { api, errorMessage } from "../../../lib/api";
import { useConfig } from "../../../lib/state";
import { useAction } from "../../../lib/useAction";
import { REPO_ERROR, REPO_PLACEHOLDER, REPO_RE } from "../../projects/validation";
import { type JiraProject, type JiraStatus, type ProjectAutomation, type ProjectItem, type StatusesResponse, knownRepos, projectDescription, projectSource } from "./projects";

/** The Selector value for "leave the status alone" (an empty status on the server). */
const KEEP = "__keep__";

type Step = "workingStatus" | "reviewStatus" | "doneStatus" | "stuckStatus";
type Statuses = Record<"startStatus" | Step, string>;

/** The statuses the team moves an issue to, in the order it goes through them, with the usual name. */
const STEPS: { key: Step; label: string; description: string; fallback: string }[] = [
  { key: "workingStatus", label: "When the team starts", description: "Set as soon as the task starts.", fallback: "In Progress" },
  { key: "reviewStatus", label: "When the pull request opens", description: "Set with the pull request's link, for a person to review.", fallback: "In Review" },
  { key: "doneStatus", label: "When the pull request is merged", description: "Needs the code host's webhook (on GitHub, with Pull requests ticked).", fallback: "Done" },
  { key: "stuckStatus", label: "When the team stops or is blocked", description: "Set with the reason, and the draft pull request if there is one.", fallback: "Blocked" },
];

const EMPTY: Statuses = { startStatus: "", workingStatus: "In Progress", reviewStatus: "In Review", doneStatus: "Done", stuckStatus: "" };

type RepoItem = SearchableItem<undefined>;
const repoItem = (repo: string): RepoItem => ({ id: repo, label: repo });

interface StatusesState {
  loading: boolean;
  error?: string;
  statuses?: JiraStatus[];
}

export interface JiraProjectDrawerProps {
  isOpen: boolean;
  /** The automated project to edit; undefined adds one. */
  projectKey: string | undefined;
  /** Project names known so far (from the project list). */
  known: Map<string, JiraProject>;
  onOpenChange: (isOpen: boolean) => void;
}

interface FieldErrors {
  project?: string;
  repo?: string;
  start?: string;
}

/** Adds or edits one project whose issues start repo tasks: the project, the repository and the workflow statuses. */
export function JiraProjectDrawer({ isOpen, projectKey, known, onOpenChange }: JiraProjectDrawerProps) {
  const { config, refresh } = useConfig();
  const name = config.team.pointer.name;
  const automated = config.jira.automation.projects;
  const { run } = useAction();
  const [project, setProject] = useState<ProjectItem | null>(null);
  const [projectsError, setProjectsError] = useState<string>();
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [statuses, setStatuses] = useState<Statuses>(EMPTY);
  const [loaded, setLoaded] = useState<StatusesState>({ loading: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const isNew = projectKey === undefined;

  // Fill the form when the drawer opens (not when the config refreshes behind it).
  useEffect(() => {
    if (!isOpen) return;
    const saved: ProjectAutomation | undefined = projectKey ? automated[projectKey] : undefined;
    setProject(projectKey ? { id: projectKey, label: known.get(projectKey)?.name ?? projectKey } : null);
    setRepo(saved ? repoItem(saved.repo) : null);
    setStatuses(
      saved
        ? { startStatus: saved.startStatus, workingStatus: saved.workingStatus, reviewStatus: saved.reviewStatus, doneStatus: saved.doneStatus, stuckStatus: saved.stuckStatus }
        : EMPTY,
    );
    setLoaded({ loading: false });
    setErrors({});
  }, [isOpen, projectKey]);

  // The chosen project's statuses, for the pickers.
  const selectedKey = project?.id;
  useEffect(() => {
    if (!isOpen || !selectedKey) return;
    let live = true;
    setLoaded({ loading: true });
    api
      .get<StatusesResponse>(`/api/jira/statuses?projectKey=${encodeURIComponent(selectedKey)}`)
      .then((r) => {
        if (!live) return;
        setLoaded({ loading: false, statuses: r.statuses });
        if (!isNew) return;
        // A new project: a "ready" status to start, the usual statuses where the workflows have them.
        const has = (s: string) => r.statuses.find((x) => x.name.toLowerCase() === s.toLowerCase())?.name ?? "";
        setStatuses({
          startStatus: r.statuses.find((s) => /ready/i.test(s.name))?.name ?? "",
          workingStatus: has("In Progress"),
          reviewStatus: has("In Review") || has("Code Review") || has("Review"),
          doneStatus: has("Done"),
          stuckStatus: has("Blocked"),
        });
      })
      .catch((err: unknown) => live && setLoaded({ loading: false, error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [isOpen, selectedKey, isNew]);

  const projects = useMemo(
    () => projectSource({ allowed: config.jira.allowedProjectKeys, exclude: Object.keys(automated), known, onError: setProjectsError }),
    [config.jira.allowedProjectKeys, automated, known],
  );
  const repos = useMemo<SearchSource<RepoItem>>(() => {
    const list = knownRepos(config);
    const find = async (query: string) => {
      const q = query.trim().toLowerCase();
      const matches = list.filter((r) => r.toLowerCase().includes(q)).map(repoItem);
      return REPO_RE.test(query.trim()) && !list.some((r) => r.toLowerCase() === q) ? [repoItem(query.trim()), ...matches] : matches;
    };
    return { search: find, bootstrap: () => find("") };
  }, [config]);

  const clear = (field: keyof FieldErrors) => setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  const setStatus = (key: keyof Statuses, value: string) => {
    setStatuses((s) => ({ ...s, [key]: value === KEEP ? "" : value }));
    if (key === "startStatus") clear("start");
  };
  /** A status picker's options: the project's statuses, plus the saved one when the workflows no longer have it. */
  const categories = new Map((loaded.statuses ?? []).map((s) => [s.name, s.category]));
  const options = (value: string, keep: boolean) => [
    ...(keep ? [{ value: KEEP, label: "Leave the status as it is" }] : []),
    ...[...new Set([...categories.keys(), ...(value ? [value] : [])])].map((s) => {
      const category = categories.get(s);
      return { value: s, label: s, ...(category ? { description: category } : {}) };
    }),
  ];

  const save = async () => {
    const target = project?.id;
    const start = statuses.startStatus.trim();
    const sameAsStart = STEPS.find((s) => statuses[s.key].trim() && statuses[s.key].trim().toLowerCase() === start.toLowerCase());
    const found: FieldErrors = {
      project: target ? undefined : "Choose the project.",
      repo: !repo ? "Choose the repository." : REPO_RE.test(repo.id) ? undefined : REPO_ERROR,
      start: !start
        ? "Choose the status that starts a task."
        : sameAsStart
          ? `The team also sets "${start}" (${sameAsStart.label.toLowerCase()}): pick different statuses, or issues would start again.`
          : undefined,
    };
    setErrors(found);
    if (!target || Object.values(found).some(Boolean)) return;
    const ok = await run(
      async () => {
        await api.post("/api/jira/automation", { projects: { [target]: { repo: repo!.id, ...statuses, startStatus: start } } });
        await refresh();
      },
      { success: `Saved: issues in ${project?.label ?? target} start tasks on ${repo!.id}.` },
    );
    if (ok) onOpenChange(false);
  };

  const remove = async () => {
    if (!projectKey) return;
    const ok = await run(
      async () => {
        await api.post("/api/jira/automation", { projects: { [projectKey]: null } });
        await refresh();
      },
      { success: `Issues in ${project?.label ?? projectKey} no longer start tasks.` },
    );
    if (ok) onOpenChange(false);
  };

  const statusesHelp = loaded.loading ? "Loading the project's statuses…" : undefined;

  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={isNew ? "Automate a project" : `Automation of ${project?.label ?? projectKey}`} purpose="form" width={560}>
      <Layout
        header={<DrawerHeader title={isNew ? "Automate a project" : (project?.label ?? projectKey ?? "")} subtitle="Jira issues" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <VStack gap={5}>
              {isNew ? (
                <Typeahead<ProjectItem>
                  label="Project"
                  searchSource={projects}
                  value={project}
                  onChange={(item) => {
                    setProject(item);
                    clear("project");
                  }}
                  placeholder="Search projects or type a key"
                  hasEntriesOnFocus
                  minQueryLength={1}
                  debounceMs={250}
                  maxMenuItems={50}
                  description={config.jira.allowedProjectKeys.length ? `One of the projects ${name} may use (Projects above).` : "Any project the account can see."}
                  status={
                    errors.project ? { type: "error", message: errors.project } : projectsError ? { type: "warning", message: `Couldn't load projects: ${projectsError}` } : undefined
                  }
                  statusVariant="detached"
                  emptySearchText="No projects match. Type the project's key, or check that the account can browse it."
                  renderItem={(item) => <TypeaheadItem item={item} description={projectDescription(item.auxiliaryData ?? known.get(item.id), item.id)} />}
                  isRequired
                />
              ) : (
                <Text color="secondary">{projectDescription(known.get(projectKey), projectKey)}</Text>
              )}
              <Typeahead<RepoItem>
                label="Repository"
                searchSource={repos}
                value={repo}
                onChange={(item) => {
                  setRepo(item);
                  clear("repo");
                }}
                placeholder={REPO_PLACEHOLDER}
                hasEntriesOnFocus
                minQueryLength={1}
                debounceMs={0}
                description="Where the team works on this project's issues. Its code host (GitHub, GitLab or Bitbucket) must be connected and allow it."
                status={errors.repo ? { type: "error", message: errors.repo } : undefined}
                statusVariant="detached"
                emptySearchText="Type the repository as owner/repo, gitlab:group/project or bitbucket:workspace/repo."
                isRequired
              />
              <Divider />
              <VStack gap={1}>
                <Heading level={3}>Statuses</Heading>
                <Text type="supporting" color="secondary">
                  The workflow statuses the team watches and moves issues to. An issue moves only where its workflow allows; an empty choice leaves the status as it is.
                </Text>
              </VStack>
              {loaded.error && (
                <Banner
                  status="warning"
                  title="Couldn't load the project's statuses"
                  description={`${loaded.error} Type the statuses exactly as they are in Jira; they are checked again when you save.`}
                  collapsible={false}
                />
              )}
              <StatusField
                label="Starts a task"
                description="When an issue moves to this status, the team starts on it."
                value={statuses.startStatus}
                options={loaded.statuses ? options(statuses.startStatus, false) : undefined}
                onChange={(v) => setStatus("startStatus", v)}
                error={errors.start}
                placeholder={statusesHelp}
                isRequired
              />
              {STEPS.map((s) => (
                <StatusField
                  key={s.key}
                  label={s.label}
                  description={s.description}
                  value={statuses[s.key]}
                  options={loaded.statuses ? options(statuses[s.key], true) : undefined}
                  onChange={(v) => setStatus(s.key, v)}
                  placeholder={statusesHelp ?? `e.g. ${s.fallback}; empty leaves the status as it is`}
                />
              ))}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StackItem size="fill">{!isNew && <ConfirmButton label="Stop automating" confirmLabel="Click again to stop" size="md" onConfirm={remove} />}</StackItem>
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button label="Save" variant="primary" clickAction={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}

/** One status: picked from the project's statuses when they are loaded, typed otherwise. */
function StatusField(props: {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string; description?: string }[] | undefined;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  isRequired?: boolean;
}) {
  const status = props.error ? { type: "error" as const, message: props.error } : undefined;
  if (props.options) {
    return (
      <Selector
        label={props.label}
        description={props.description}
        options={props.options}
        value={props.value || (props.isRequired ? "" : KEEP)}
        onChange={props.onChange}
        placeholder="Choose a status"
        status={status}
        {...(props.isRequired ? { isRequired: true } : { isOptional: true })}
      />
    );
  }
  return (
    <TextInput
      label={props.label}
      description={props.description}
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder ?? "e.g. Ready for dev"}
      status={status}
      {...(props.isRequired ? { isRequired: true } : { isOptional: true })}
    />
  );
}
