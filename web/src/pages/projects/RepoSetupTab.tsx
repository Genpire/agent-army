import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { PlusIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { RepoSetupView } from "../../lib/types";
import { RepoSetupDrawer } from "./RepoSetupDrawer";
import { SectionHeader } from "./components/SectionHeader";

interface SetupRow extends Record<string, unknown>, RepoSetupView {
  repo: string;
}

const none = <Text color="secondary">–</Text>;

/** Repo setup: how repo tasks prepare and run each repository. */
export function RepoSetupTab() {
  const { config } = useConfig();
  const setups = config.repoSetup;
  const [drawer, setDrawer] = useState<{ isOpen: boolean; repo?: string }>({ isOpen: false });

  const rows: SetupRow[] = Object.entries(setups)
    .map(([repo, s]) => ({ repo, ...s }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  const openNew = () => setDrawer({ isOpen: true, repo: undefined });
  const addButton = <Button label="Add repository" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={openNew} />;

  const columns: TableColumn<SetupRow>[] = [
    {
      key: "repo",
      header: "Repository",
      width: proportional(2, { minWidth: 160 }),
      renderCell: (r) => (
        <Link weight="medium" onClick={() => setDrawer({ isOpen: true, repo: r.repo })} tooltip={`Edit the setup of ${r.repo}`}>
          {r.repo}
        </Link>
      ),
    },
    {
      key: "setupCommand",
      header: "Setup command",
      width: proportional(2, { minWidth: 140 }),
      renderCell: (r) => (r.setupCommand ? <Code>{r.setupCommand}</Code> : none),
    },
    {
      key: "startCommand",
      header: "Start command and URL",
      width: proportional(2, { minWidth: 160 }),
      renderCell: (r) =>
        r.startCommand || r.appUrl ? (
          <VStack gap={0.5} hAlign="start">
            {r.startCommand ? <Code>{r.startCommand}</Code> : <Text color="secondary">Project's dev script</Text>}
            {r.appUrl && (
              <Text type="supporting" color="secondary" maxLines={1}>
                {r.appUrl}
              </Text>
            )}
          </VStack>
        ) : (
          none
        ),
    },
    {
      key: "envKeys",
      header: "Variables",
      width: pixel(120),
      renderCell: (r) => (r.envKeys.length ? <Text hasTabularNumbers>{plural(r.envKeys.length, "variable")}</Text> : <Text color="secondary">None</Text>),
    },
    {
      key: "actions",
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(104),
      align: "end",
      renderCell: (r) => <Button label="Edit" variant="ghost" size="sm" onClick={() => setDrawer({ isOpen: true, repo: r.repo })} />,
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader
        title="Repo setup"
        description="How repo tasks prepare and run each repository: a setup command after the checkout, how to start the app for browser checks, and variables for the agents' shell. All optional: without a setup, the team works it out from the project."
        actions={rows.length > 0 ? addButton : undefined}
      />
      <Table<SetupRow>
        data={rows}
        columns={columns}
        idKey="repo"
        density="balanced"
        hasHover
        textOverflow="truncate"
        emptyState={
          <EmptyState
            title="No repository is set up yet"
            description="Add one when the team needs a setup command, a way to start the app, or environment variables to work on it."
            icon={<Icon icon={WrenchScrewdriverIcon} size="lg" />}
            actions={addButton}
          />
        }
      />
      <RepoSetupDrawer
        isOpen={drawer.isOpen}
        repo={drawer.repo}
        setups={setups}
        onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, isOpen }))}
        onOpenRepo={(repo) => setDrawer({ isOpen: true, repo })}
      />
    </VStack>
  );
}
