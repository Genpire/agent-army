import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AcademicCapIcon, MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AddLessonResult, LessonsList, RepoLessonsView } from "../../../../src/routes/lessons.js";
import type { Lesson } from "../../../../src/team/lessons.js";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { AddRow } from "./components/AddRow";
import { SectionHeader } from "./components/SectionHeader";
import { allowListRepos, findRepo } from "./validation";

type LessonRow = Lesson & Record<string, unknown>;

/** Any repository id, GitLab's nested ones included, goes in the query. */
const lessonsPath = (repo: string) => `/api/lessons/repo?repo=${encodeURIComponent(repo)}`;
const ALL_AREAS = "";

/** A repository's lessons, or what went wrong loading them. */
export type LessonsAnswer = { view: RepoLessonsView } | { error: string };

/**
 * Loads one repository's lessons for the tab. The answer goes to `show` only
 * if that repository is still the one on screen: a slow answer that comes
 * back after a switch must not replace the current one.
 */
export async function loadRepoLessons(
  name: string,
  o: { get: (path: string) => Promise<RepoLessonsView>; onScreen: () => string | undefined; show: (answer: LessonsAnswer) => void },
): Promise<void> {
  let answer: LessonsAnswer;
  try {
    answer = { view: await o.get(lessonsPath(name)) };
  } catch (err) {
    answer = { error: errorMessage(err) };
  }
  if (o.onScreen() === name) o.show(answer);
}

/** The lessons library: what earlier tasks on each repository got wrong, or nearly did, by area. */
export function LessonsTab() {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  const { run, pending } = useAction();
  const showToast = useToast();
  const [list, setList] = useState<LessonsList>();
  const [listError, setListError] = useState<string>();
  const [repo, setRepo] = useState<string>();
  const [view, setView] = useState<RepoLessonsView>();
  const [viewError, setViewError] = useState<string>();
  const [area, setArea] = useState(ALL_AREAS);
  const [query, setQuery] = useState("");
  const [newArea, setNewArea] = useState("");
  const [newLesson, setNewLesson] = useState("");
  const [addError, setAddError] = useState<string>();

  const reloadList = useCallback(async () => {
    try {
      setList(await api.get<LessonsList>("/api/lessons"));
      setListError(undefined);
    } catch (err) {
      setListError(errorMessage(err));
    }
  }, []);

  // The repository on screen (set by the effect below): answers for any other are dropped.
  const shown = useRef<string>(undefined);
  const loadRepo = useCallback(
    (name: string) =>
      loadRepoLessons(name, {
        get: (path) => api.get<RepoLessonsView>(path),
        onScreen: () => shown.current,
        show: (answer) => {
          if ("view" in answer) setView(answer.view);
          setViewError("error" in answer ? answer.error : undefined);
        },
      }),
    [],
  );

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // The repositories with lessons, then the ones the allow lists, repo setups and channels name.
  const counts = new Map((list?.repos ?? []).map((r) => [r.repo, r.count]));
  const repos: string[] = [];
  for (const r of [...counts.keys(), ...allowListRepos(config), ...Object.keys(config.repoSetup), ...Object.values(config.bindings)]) {
    if (!findRepo(repos, r)) repos.push(r);
  }
  // Chosen once the list is in, so the first repository with lessons is the one shown.
  const selected = repo ?? (list ? repos[0] : undefined);

  useEffect(() => {
    shown.current = selected;
    setView(undefined);
    setArea(ALL_AREAS);
    setQuery("");
    setAddError(undefined);
    if (selected) void loadRepo(selected);
  }, [selected, loadRepo]);

  const lessons: LessonRow[] = (view?.lessons ?? []).map((l) => ({ ...l }));
  const areaCounts = new Map<string, number>();
  for (const l of lessons) areaCounts.set(l.area, (areaCounts.get(l.area) ?? 0) + 1);
  const areaOptions = [
    { value: ALL_AREAS, label: "All areas" },
    ...[...areaCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a, n]) => ({ value: a, label: `${a} (${n})` })),
  ];
  const needle = query.trim().toLowerCase();
  const rows = lessons.filter((l) => (area === ALL_AREAS || l.area === area) && (!needle || `${l.area} ${l.lesson}`.toLowerCase().includes(needle)));
  const areaMax = list?.areaMaxChars ?? 60;
  const lessonMax = list?.lessonMaxChars ?? 600;

  const refresh = async () => {
    await Promise.all([reloadList(), selected ? loadRepo(selected) : undefined]);
  };

  const add = async () => {
    if (!selected) return;
    const text = newLesson.trim();
    const problem = !text
      ? "Write the lesson."
      : text.length > lessonMax
        ? `Lessons are at most ${lessonMax} characters.`
        : newArea.trim().length > areaMax
          ? `Areas are at most ${areaMax} characters.`
          : undefined;
    setAddError(problem);
    if (problem) return;
    let result: AddLessonResult | undefined;
    const ok = await run(async () => {
      result = await api.post<AddLessonResult>("/api/lessons", { repo: selected, area: newArea, lesson: text });
    });
    if (!ok || !result) return;
    const saved = result;
    setNewLesson("");
    // The filters could hide it: show every lesson again.
    setArea(ALL_AREAS);
    setQuery("");
    showToast({
      body: saved.repeated
        ? `Already in the library under ${saved.lesson.area}: now seen ${plural(saved.lesson.seen, "time")}.`
        : `Added the lesson for ${selected}.`,
      type: "info",
    });
    await refresh();
  };

  const remove = async (l: Lesson) => {
    if (!selected) return;
    if (await run(() => api.post("/api/lessons/delete", { repo: selected, id: l.id }), { success: "Deleted the lesson. Later tasks no longer see it." })) {
      await refresh();
    }
  };

  const columns: TableColumn<LessonRow>[] = [
    {
      key: "area",
      header: "Area",
      width: proportional(1, { minWidth: 100 }),
      renderCell: (r) => <Text weight="medium">{r.area}</Text>,
    },
    {
      key: "lesson",
      header: "Lesson",
      // A weight's floor grows with it: 3 keeps the row inside the page beside the fixed columns.
      width: proportional(3, { minWidth: 240 }),
      renderCell: (r) => <Text>{r.lesson}</Text>,
    },
    {
      key: "seen",
      header: "Seen",
      width: pixel(104),
      align: "end",
      renderCell: (r) => (
        <HStack gap={2} vAlign="center" hAlign="end">
          {r.seen > 1 && <StatusDot variant="warning" label="Repeated mistake" tooltip={`Reported ${plural(r.seen, "time")}: a mistake that happened again`} />}
          <Text hasTabularNumbers>{plural(r.seen, "time")}</Text>
        </HStack>
      ),
    },
    {
      key: "lastSeenAt",
      header: "Last seen",
      width: pixel(136),
      renderCell: (r) => <Timestamp value={r.lastSeenAt} format="auto" type="body" />,
    },
    {
      key: "source",
      header: "Source",
      width: pixel(96),
      renderCell: (r) => <Text color="secondary">{r.source === "owner" ? "You" : "A task"}</Text>,
    },
    {
      key: "actions",
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(144),
      align: "end",
      renderCell: (r) => <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(r)} />,
    },
  ];

  const description = `What earlier tasks on each repository got wrong, or nearly did, and how to avoid it, filed by area. Each task adds what it learned; one reported again counts as seen again, a mistake that happened twice. Before working on an area, ${pointer} and the team read its lessons. Never written into the checkout.`;

  if (listError) {
    return (
      <VStack gap={4}>
        <SectionHeader title="Lessons library" description={description} />
        <Banner status="error" title="Couldn't load the lessons" description={listError} collapsible={false} endContent={<Button label="Try again" size="sm" clickAction={reloadList} />} />
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <SectionHeader title="Lessons library" description={description} />
      {list && !selected ? (
        <EmptyState
          title="No lessons yet"
          description={`The team adds them at the end of each repo task. Once ${pointer} works on a repository, or it is in an allow list, a repo setup or a channel, you can add lessons for it here too.`}
          icon={<Icon icon={AcademicCapIcon} size="lg" />}
        />
      ) : (
        <>
          <HStack gap={3} vAlign="end" wrap="wrap">
            <Selector
              label="Repository"
              options={repos.map((r) => ({ value: r, label: r, description: counts.get(r) ? plural(counts.get(r) ?? 0, "lesson") : "No lessons yet" }))}
              value={selected}
              onChange={(v) => setRepo(v)}
              hasSearch
              searchPlaceholder="Find a repository"
              placeholder="Choose a repository"
              width={320}
              isDisabled={!list}
            />
            <Selector label="Area" options={areaOptions} value={area} onChange={(v) => setArea(v)} width={220} isDisabled={!lessons.length} />
            <TextInput
              type="search"
              label="Search"
              isLabelHidden
              placeholder="Search the lessons"
              startIcon={MagnifyingGlassIcon}
              value={query}
              onChange={setQuery}
              width={280}
              isDisabled={!lessons.length}
            />
          </HStack>
          {viewError ? (
            <Banner
              status="error"
              title="Couldn't load the lessons"
              description={viewError}
              collapsible={false}
              endContent={selected ? <Button label="Try again" size="sm" clickAction={() => loadRepo(selected)} /> : undefined}
            />
          ) : (
            <Table<LessonRow>
              data={rows}
              columns={columns}
              idKey="id"
              density="balanced"
              hasHover
              verticalAlign="top"
              emptyState={
                !view ? (
                  <EmptyState isCompact title="Loading lessons…" />
                ) : lessons.length ? (
                  <EmptyState isCompact title="No lesson matches" description="Choose another area or change the search." />
                ) : (
                  <EmptyState
                    title={`No lessons for ${view.repo} yet`}
                    description="The team adds them at the end of each repo task. You can add one below."
                    icon={<Icon icon={AcademicCapIcon} size="lg" />}
                  />
                )
              }
            />
          )}
          {selected && (
            <AddRow error={addError}>
              <TextInput
                label="Area"
                value={newArea}
                onChange={setNewArea}
                placeholder="billing"
                description="A folder, module or topic"
                width={200}
                autoCapitalize="off"
              />
              <TextInput
                label="Lesson"
                value={newLesson}
                onChange={(v) => {
                  setNewLesson(v);
                  setAddError(undefined);
                }}
                onEnter={add}
                placeholder="Refunds are in cents, not dollars."
                description="What went wrong or nearly did, and how to avoid it. Never secrets."
                width={320}
                status={addError ? { type: "error" } : undefined}
              />
              <Button label="Add lesson" variant="secondary" icon={<Icon icon={PlusIcon} />} clickAction={add} isDisabled={pending} />
            </AddRow>
          )}
        </>
      )}
    </VStack>
  );
}
