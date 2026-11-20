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
import type { MondayStatusColumn } from "../../../../src/integrations/monday/monday.js";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api, errorMessage } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { MondayBoardSummary, PublicConfig } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { REPO_ERROR, REPO_PLACEHOLDER, REPO_RE, allowListRepos } from "../projects/validation";
import { type BoardAutomation, type BoardItem, type ColumnsResponse, boardDescription, boardSource } from "./mondayBoards";

/** The Selector value for "leave the status alone" (an empty label on the server). */
const KEEP = "__keep__";

type Step = "workingLabel" | "reviewLabel" | "doneLabel" | "stuckLabel";
type Labels = Record<"startLabel" | Step, string>;

/** The statuses the team sets, in the order a ticket goes through them, with the default label. */
const STEPS: { key: Step; label: string; description: string; fallback: string }[] = [
  { key: "workingLabel", label: "When the team starts", description: "Set as soon as the task starts.", fallback: "Working on it" },
  { key: "reviewLabel", label: "When the pull request opens", description: "Set with the pull request's link, for a person to review.", fallback: "In review" },
  { key: "doneLabel", label: "When the pull request is merged", description: "Needs the code host's webhook (on GitHub, with Pull requests ticked).", fallback: "Done" },
  { key: "stuckLabel", label: "When the team stops or is blocked", description: "Set with the reason, and the draft pull request if there is one.", fallback: "Stuck" },
];

const EMPTY_LABELS: Labels = { startLabel: "", workingLabel: "Working on it", reviewLabel: "In review", doneLabel: "Done", stuckLabel: "Stuck" };

type RepoItem = SearchableItem<undefined>;
const repoItem = (repo: string): RepoItem => ({ id: repo, label: repo });

/** Repositories the console already knows: channel bindings, repo setups, exact repos in the code hosts' allow lists, other automated boards. */
function knownRepos(config: PublicConfig): string[] {
  const repos = [
    ...Object.values(config.bindings),
    ...Object.keys(config.repoSetup),
    ...allowListRepos(config),
    ...Object.values(config.monday.automation.boards).map((b) => b.repo),
  ];
  return [...new Map(repos.map((r) => [r.toLowerCase(), r])).values()].sort((a, b) => a.localeCompare(b));
}

interface ColumnsState {
  loading: boolean;
  error?: string;
  columns?: MondayStatusColumn[];
}

export interface MondayBoardDrawerProps {
  isOpen: boolean;
  /** The automated board to edit; undefined adds one. */
  boardId: string | undefined;
  /** Board names known so far (from the board list). */
  known: Map<string, MondayBoardSummary>;
  onOpenChange: (isOpen: boolean) => void;
}

interface FieldErrors {
  board?: string;
  repo?: string;
  column?: string;
  start?: string;
}

/** Adds or edits one board whose tickets start repo tasks: the board, the repository, the status column and its labels. */
export function MondayBoardDrawer({ isOpen, boardId, known, onOpenChange }: MondayBoardDrawerProps) {
  const { config, refresh } = useConfig();
  const name = config.team.pointer.name;
  const automated = config.monday.automation.boards;
  const { run } = useAction();
  const [board, setBoard] = useState<BoardItem | null>(null);
  const [boardsError, setBoardsError] = useState<string>();
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [columnId, setColumnId] = useState("");
  const [labels, setLabels] = useState<Labels>(EMPTY_LABELS);
  const [columns, setColumns] = useState<ColumnsState>({ loading: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const isNew = boardId === undefined;

  // Fill the form when the drawer opens (not when the config refreshes behind it).
  useEffect(() => {
    if (!isOpen) return;
    const saved: BoardAutomation | undefined = boardId ? automated[boardId] : undefined;
    setBoard(boardId ? { id: boardId, label: known.get(boardId)?.name ?? `Board ${boardId}` } : null);
    setRepo(saved ? repoItem(saved.repo) : null);
    setColumnId(saved?.statusColumnId ?? "");
    setLabels(
      saved
        ? { startLabel: saved.startLabel, workingLabel: saved.workingLabel, reviewLabel: saved.reviewLabel, doneLabel: saved.doneLabel, stuckLabel: saved.stuckLabel }
        : EMPTY_LABELS,
    );
    setColumns({ loading: false });
    setErrors({});
  }, [isOpen, boardId]);

  // The chosen board's status columns and labels, for the pickers.
  const selectedId = board?.id;
  useEffect(() => {
    if (!isOpen || !selectedId) return;
    let live = true;
    setColumns({ loading: true });
    api
      .get<ColumnsResponse>(`/api/monday/columns?boardId=${encodeURIComponent(selectedId)}`)
      .then((r) => {
        if (!live) return;
        setColumns({ loading: false, columns: r.columns });
        if (!isNew) return;
        // A new board: the "status" column (or the first), a "ready" label to start, the usual labels where the column has them.
        const column = r.columns.find((c) => c.id === "status") ?? r.columns[0];
        if (!column) return;
        setColumnId(column.id);
        const has = (l: string) => column.labels.find((x) => x.toLowerCase() === l.toLowerCase()) ?? "";
        setLabels({
          startLabel: column.labels.find((l) => /ready/i.test(l)) ?? "",
          workingLabel: has("Working on it"),
          reviewLabel: has("In review"),
          doneLabel: has("Done"),
          stuckLabel: has("Stuck"),
        });
      })
      .catch((err: unknown) => live && setColumns({ loading: false, error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [isOpen, selectedId, isNew]);

  const boards = useMemo(
    () => boardSource({ allowed: config.monday.allowedBoardIds, exclude: Object.keys(automated), known, onError: setBoardsError }),
    [config.monday.allowedBoardIds, automated, known],
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

  const column = columns.columns?.find((c) => c.id === columnId);
  const clear = (field: keyof FieldErrors) => setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  const setLabel = (key: keyof Labels, value: string) => {
    setLabels((l) => ({ ...l, [key]: value === KEEP ? "" : value }));
    if (key === "startLabel") clear("start");
  };
  /** A label picker's options: the column's labels, plus the saved one when the column no longer has it. */
  const options = (value: string, keep: boolean) => [
    ...(keep ? [{ value: KEEP, label: "Leave the status as it is" }] : []),
    ...[...new Set([...(column?.labels ?? []), ...(value ? [value] : [])])].map((l) => ({ value: l, label: l })),
  ];

  const save = async () => {
    const target = board?.id;
    const start = labels.startLabel.trim();
    const sameAsStart = STEPS.find((s) => labels[s.key].trim() && labels[s.key].trim().toLowerCase() === start.toLowerCase());
    const found: FieldErrors = {
      board: target ? undefined : "Choose the board.",
      repo: !repo ? "Choose the repository." : REPO_RE.test(repo.id) ? undefined : REPO_ERROR,
      column: columnId.trim() ? undefined : "Choose the status column to watch.",
      start: !start ? "Choose the status that starts a task." : sameAsStart ? `The team also sets "${start}" (${sameAsStart.label.toLowerCase()}): pick different labels, or tickets would start again.` : undefined,
    };
    setErrors(found);
    if (!target || Object.values(found).some(Boolean)) return;
    const ok = await run(
      async () => {
        await api.post("/api/monday/automation", { boards: { [target]: { repo: repo!.id, statusColumnId: columnId.trim(), ...labels, startLabel: start } } });
        await refresh();
      },
      { success: `Saved: tickets on ${board?.label ?? `board ${target}`} start tasks on ${repo!.id}.` },
    );
    if (ok) onOpenChange(false);
  };

  const remove = async () => {
    if (!boardId) return;
    const ok = await run(
      async () => {
        await api.post("/api/monday/automation", { boards: { [boardId]: null } });
        await refresh();
      },
      { success: `Tickets on ${board?.label ?? `board ${boardId}`} no longer start tasks.` },
    );
    if (ok) onOpenChange(false);
  };

  const columnsHelp = columns.loading ? "Loading the board's status columns…" : undefined;

  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={isNew ? "Automate a board" : `Automation of ${board?.label ?? boardId}`} purpose="form" width={560}>
      <Layout
        header={<DrawerHeader title={isNew ? "Automate a board" : (board?.label ?? `Board ${boardId}`)} subtitle="monday.com tickets" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <VStack gap={5}>
              {isNew ? (
                <Typeahead<BoardItem>
                  label="Board"
                  searchSource={boards}
                  value={board}
                  onChange={(item) => {
                    setBoard(item);
                    clear("board");
                  }}
                  placeholder="Search boards or type a board id"
                  hasEntriesOnFocus
                  minQueryLength={1}
                  debounceMs={250}
                  maxMenuItems={50}
                  description={
                    config.monday.allowedBoardIds.length
                      ? `One of the boards ${name} may use (Boards above).`
                      : "Any board the monday.com user can see. The board id is the number in its URL."
                  }
                  status={errors.board ? { type: "error", message: errors.board } : boardsError ? { type: "warning", message: `Couldn't load boards: ${boardsError}` } : undefined}
                  statusVariant="detached"
                  emptySearchText="No boards match. Type the board's id, or check that the token's user is a member of the board."
                  renderItem={(item) => <TypeaheadItem item={item} description={boardDescription(item.auxiliaryData ?? known.get(item.id), item.id)} />}
                  isRequired
                />
              ) : (
                known.has(boardId) && <Text color="secondary">{boardDescription(known.get(boardId), boardId)}</Text>
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
                description="Where the team works on this board's tickets. Its code host (GitHub, GitLab or Bitbucket) must be connected and allow it."
                status={errors.repo ? { type: "error", message: errors.repo } : undefined}
                statusVariant="detached"
                emptySearchText="Type the repository as owner/repo, gitlab:group/project or bitbucket:workspace/repo."
                isRequired
              />
              <Divider />
              <VStack gap={1}>
                <Heading level={3}>Status</Heading>
                <Text type="supporting" color="secondary">
                  The column the team watches and moves. Only its labels can be used; an empty choice leaves the status as it is.
                </Text>
              </VStack>
              {columns.error && (
                <Banner
                  status="warning"
                  title="Couldn't load the board's columns"
                  description={`${columns.error} Type the column id and the labels exactly as they are on the board; they are checked again when you save.`}
                  collapsible={false}
                />
              )}
              {columns.columns ? (
                <Selector
                  label="Status column"
                  options={columns.columns.map((c) => ({ value: c.id, label: c.title, description: `Column ${c.id}` }))}
                  value={columnId}
                  onChange={(v) => {
                    setColumnId(v);
                    clear("column");
                  }}
                  emptyText="This board has no status column."
                  status={errors.column ? { type: "error", message: errors.column } : undefined}
                  isRequired
                />
              ) : (
                <TextInput
                  label="Status column id"
                  value={columnId}
                  onChange={(v) => {
                    setColumnId(v);
                    clear("column");
                  }}
                  placeholder="status"
                  description={columnsHelp ?? "The column's id, usually status."}
                  isDisabled={columns.loading}
                  autoCapitalize="off"
                  hasAutoCorrect={false}
                  hasSpellCheck={false}
                  status={errors.column ? { type: "error", message: errors.column } : undefined}
                  isRequired
                />
              )}
              <LabelField
                label="Starts a task"
                description="When a ticket's status becomes this, the team starts on it."
                value={labels.startLabel}
                options={column ? options(labels.startLabel, false) : undefined}
                onChange={(v) => setLabel("startLabel", v)}
                error={errors.start}
                isRequired
              />
              {STEPS.map((s) => (
                <LabelField
                  key={s.key}
                  label={s.label}
                  description={s.description}
                  value={labels[s.key]}
                  options={column ? options(labels[s.key], true) : undefined}
                  onChange={(v) => setLabel(s.key, v)}
                  placeholder={`e.g. ${s.fallback}; empty leaves the status as it is`}
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

/** One status label: picked from the column's labels when they are loaded, typed otherwise. */
function LabelField(props: {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[] | undefined;
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
        placeholder="Choose a label"
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
