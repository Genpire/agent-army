/**
 * The Company data pane: the company's own APIs, admin panels and Postgres
 * databases Pointer may read (read-only) for questions and reports, each
 * with its status and a test; adding or editing one opens a drawer.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { CircleStackIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { IntegrationSummary } from "./catalog";
import { DataSourceDrawer } from "./data-sources/DataSourceDrawer";
import { TestOutcome, useSourceTest } from "./data-sources/TestOutcome";
import { type DataSourceView, KIND_LABEL, choiceOf, sourceAddress, sourceScope, sourceStatus } from "./data-sources/sources";
import { Examples, PaneHeader, PaneSection, StatusLine } from "./parts";

interface SourceRow extends Record<string, unknown> {
  id: string;
  source: DataSourceView;
}

const MAX_SOURCES = 30;

export function DataSourcesPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const sources = config.dataSources;
  const [drawer, setDrawer] = useState<{ isOpen: boolean; sourceId?: string; session: number }>({ isOpen: false, session: 0 });
  const test = useSourceTest();
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const open = (sourceId?: string) => setDrawer((d) => ({ isOpen: true, sourceId, session: d.session + 1 }));
  const rows: SourceRow[] = sources.map((source) => ({ id: source.id, source }));
  const testButton = (d: DataSourceView) => (
    <Button label="Test" size="sm" variant="secondary" isDisabled={test.state.status === "running"} clickAction={() => test.run(d.id, d.name).then(() => undefined)} />
  );

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={CircleStackIcon}
        title={summary.name}
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name} read your company's own systems, your API, your admin panel or CMS, and your Postgres database, to answer questions and build routine reports from live data, for example "how many users signed up this week, and how many subscribed?".`}
        onBack={onBack}
      />

      <Banner
        status="info"
        title={`${name} only reads`}
        description={`APIs are called with GET only, under the paths you allow; databases are queried with one SELECT at a time, in a read-only transaction that is always rolled back, with a 15 s limit and at most 500 rows. Still give ${name} its own account that can only read: a read-only API key, a viewer account in the admin panel, a read-only database role.`}
        collapsible={false}
      />

      <PaneSection
        title="Sources"
        description={`What ${name} may read. Credentials are stored encrypted, added to each request on the server, and never shown to ${name} or in its answers.`}
        endContent={<Button label="Add a source" size="sm" isDisabled={sources.length >= MAX_SOURCES} clickAction={() => open()} />}>
        {rows.length > 0 ? (
          <Table<SourceRow>
            data={rows}
            idKey="id"
            verticalAlign="top"
            columns={[
              {
                key: "source",
                header: "Source",
                width: proportional(1, { minWidth: 180 }),
                renderCell: ({ source: d }) => (
                  <VStack gap={0.5} hAlign="start">
                    <Link weight="medium" onClick={() => open(d.id)} tooltip={`Edit ${d.name}`}>
                      {d.name}
                    </Link>
                    <Text type="supporting" color="secondary">
                      {choiceOf(d) === "login" ? "Admin sign-in" : KIND_LABEL[d.kind]} · <Code size="inherit">{sourceAddress(d)}</Code>
                    </Text>
                    <Text type="supporting" color="secondary">
                      {sourceScope(d)}
                    </Text>
                    {isNarrow && testButton(d)}
                  </VStack>
                ),
              },
              {
                key: "status",
                header: "Status",
                width: proportional(1, { minWidth: 150 }),
                renderCell: ({ source: d }) => {
                  const s = sourceStatus(d);
                  return <StatusLine tone={s.tone} text={s.text} />;
                },
              },
              ...(isNarrow
                ? []
                : [
                    {
                      key: "actions",
                      header: "",
                      width: pixel(96),
                      resizable: false,
                      align: "end" as const,
                      renderCell: ({ source: d }: SourceRow) => <HStack hAlign="end">{testButton(d)}</HStack>,
                    },
                  ]),
            ]}
          />
        ) : (
          <Text color="secondary">No source yet. Add your API, your admin panel's API or your database; {name} can use it as soon as the test passes.</Text>
        )}
        <TestOutcome state={test.state} lead={name} />
        {sources.length > 0 && (
          <Text type="supporting" color="secondary">
            {plural(sources.filter((d) => d.enabled).length, "source")} on, of {MAX_SOURCES} at most.
          </Text>
        )}
      </PaneSection>

      <Examples
        title="What to ask"
        description={`Mention ${name} in Slack or write in Chat. Say what each source holds in its description, so ${name} knows where to look. A routine can ask the same every week and email the report.`}
        examples={[
          "How many users signed up this week, and how many of them subscribed?",
          "Daily sign-ups for the last 30 days, as a table",
          "How many paying customers are on each plan?",
          "Revenue last month compared with the month before",
          "Which tables hold orders and payments?",
        ]}
      />

      <DataSourceDrawer isOpen={drawer.isOpen} sourceId={drawer.sourceId} session={drawer.session} onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, isOpen }))} />
    </VStack>
  );
}
