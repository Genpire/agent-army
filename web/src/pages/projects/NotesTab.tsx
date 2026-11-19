import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { BookOpenIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import type { NotesList } from "../../lib/types";
import { useConfig } from "../../lib/state";
import { NoteDrawer } from "./NoteDrawer";
import { SectionHeader } from "./components/SectionHeader";

type NoteRow = NotesList["notes"][number] & Record<string, unknown>;

/** "1,234 characters" */
const characters = (n: number) => `${n.toLocaleString()} ${n === 1 ? "character" : "characters"}`;

/** Project notes: what the team learned about each repository. */
export function NotesTab() {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  const [data, setData] = useState<NotesList>();
  const [loadError, setLoadError] = useState<string>();
  const [drawer, setDrawer] = useState<{ isOpen: boolean; repo?: string }>({ isOpen: false });

  const reload = useCallback(async () => {
    try {
      setData(await api.get<NotesList>("/api/notes"));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows: NoteRow[] = data?.notes ?? [];
  const max = data?.max ?? 8000;
  const openNew = () => setDrawer({ isOpen: true, repo: undefined });
  const addButton = <Button label="Add notes" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={openNew} />;

  const columns: TableColumn<NoteRow>[] = [
    {
      key: "repo",
      header: "Repository",
      width: proportional(3, { minWidth: 160 }),
      renderCell: (r) => (
        <Link weight="medium" onClick={() => setDrawer({ isOpen: true, repo: r.repo })} tooltip={`Open the notes for ${r.repo}`}>
          {r.repo}
        </Link>
      ),
    },
    {
      key: "chars",
      header: "Size",
      width: pixel(168),
      align: "end",
      renderCell: (r) => (
        <HStack gap={2} vAlign="center" hAlign="end">
          {r.chars >= max * 0.9 && (
            <StatusDot variant="warning" label="Close to the limit" tooltip={`Close to the ${max.toLocaleString()} character limit`} />
          )}
          <Text hasTabularNumbers>{characters(r.chars)}</Text>
        </HStack>
      ),
    },
    {
      key: "updatedAt",
      header: "Last update",
      width: pixel(160),
      renderCell: (r) => <Timestamp value={r.updatedAt} format="auto" type="body" />,
    },
    {
      key: "actions",
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(104),
      align: "end",
      renderCell: (r) => <Button label="Open" variant="ghost" size="sm" onClick={() => setDrawer({ isOpen: true, repo: r.repo })} />,
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader
        title="Project notes"
        description="What the team has learned about each repository: how to build and test it, conventions, gotchas. Read at the start of every repo task and updated at the end. Never written into the checkout."
        actions={rows.length > 0 ? addButton : undefined}
      />
      {loadError ? (
        <Banner
          status="error"
          title="Couldn't load the project notes"
          description={loadError}
          collapsible={false}
          endContent={<Button label="Try again" size="sm" clickAction={reload} />}
        />
      ) : (
        <Table<NoteRow>
          data={rows}
          columns={columns}
          idKey="repo"
          density="balanced"
          hasHover
          textOverflow="truncate"
          emptyState={
            data ? (
              <EmptyState
                title="No notes yet"
                description={`The team writes them at the end of each repo task. You can also start them here, or tell ${pointer} in Slack: remember for owner/repo that …`}
                icon={<Icon icon={BookOpenIcon} size="lg" />}
                actions={addButton}
              />
            ) : (
              <EmptyState isCompact title="Loading notes…" />
            )
          }
        />
      )}
      <NoteDrawer
        isOpen={drawer.isOpen}
        repo={drawer.repo}
        notes={rows}
        max={max}
        onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, isOpen }))}
        onOpenRepo={(repo) => setDrawer({ isOpen: true, repo })}
        onSaved={reload}
      />
    </VStack>
  );
}
