import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { CopyField } from "../../components/CopyField";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import type { MondayBoardSummary } from "../../lib/types";
import { MondayBoardDrawer } from "./MondayBoardDrawer";
import { type BoardAutomation, type WebhookResponse, fetchBoards } from "./mondayBoards";
import { FormActions, PaneSection, StatusLine, Steps, Strong, useSave } from "./parts";

interface BoardRow extends Record<string, unknown> {
  id: string;
  name: string;
  board: BoardAutomation;
}

/** "Working on it → In review → Done", without the steps that leave the status alone. */
const flow = (b: BoardAutomation) => [b.workingLabel, b.reviewLabel, b.doneLabel].filter(Boolean).join(" → ") || "Status left as it is";

/**
 * Tickets that start repo tasks: on/off, the webhook monday.com calls, and the
 * boards whose tickets the team works on with the status labels it sets.
 */
export function MondayAutomation() {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const auto = config.monday.automation;
  const known = useRef(new Map<string, MondayBoardSummary>());
  const [names, setNames] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<{ isOpen: boolean; boardId?: string }>({ isOpen: false });
  const [result, setResult] = useState<WebhookResponse>();
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const { save } = useSave();

  // Names for the automated boards (the configuration only holds their ids).
  useEffect(() => {
    let live = true;
    fetchBoards("")
      .then((boards) => {
        boards.forEach((b) => known.current.set(b.id, b));
        if (live) setNames(Object.fromEntries(boards.map((b) => [b.id, b.name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const boardName = (id: string) => names[id] ?? `Board ${id}`;
  const rows: BoardRow[] = Object.entries(auto.boards).map(([id, board]) => ({ id, name: boardName(id), board }));
  const githubHook = config.github.webhook.configured;

  const toggle = async (enabled: boolean) => {
    await save(() => api.post("/api/monday/automation", { enabled }), {
      success: enabled ? "Ticket automation is on." : `Ticket automation is off: tickets no longer start tasks, and monday.com's deliveries are refused.`,
    });
  };

  const connect = async () => {
    let out: WebhookResponse | undefined;
    const ok = await save(
      async () => {
        out = await api.post<WebhookResponse>("/api/monday/automation/webhook");
        return out;
      },
      {
        success: (r) =>
          r.ok ? `Webhook connected on ${plural(r.created.length, "board")}.` : `The webhook could not be created on ${plural(r.failed.length, "board")}. See the steps to add it by hand.`,
      },
    );
    if (ok) setResult(out);
  };

  const removeButton = (r: BoardRow) => (
    <ConfirmButton
      label="Remove"
      confirmLabel="Click again to remove"
      onConfirm={async () => {
        await save(() => api.post("/api/monday/automation", { boards: { [r.id]: null } }), { success: `Tickets on ${r.name} no longer start tasks.` });
      }}
    />
  );

  return (
    <PaneSection
      title="Ticket automation"
      endContent={<StatusLine tone={auto.enabled ? "success" : "neutral"} text={auto.enabled ? `On · ${plural(rows.length, "board")}` : "Off"} />}
      description={`Optional. When a ticket on a board below moves to its start status (for example "Ready for dev"), the team starts on it in a new Chat conversation named after the ticket, and the ticket shows the progress.`}>
      <Steps
        label="What happens to a ticket"
        steps={[
          <>
            Someone sets the ticket's status to the board's start label. {name} reads the ticket again from monday.com (the notification itself is not trusted) and starts
            the team on the board's repository, with the ticket's name, description and columns.
          </>,
          <>The status moves to the "started" label, with an update linking the task's conversation.</>,
          <>When the pull request opens, its link is posted and the status moves to the "in review" label.</>,
          <>If the team stops, fails or is blocked, the status moves to the "stuck" label with the reason (and the draft pull request, if any).</>,
          <>
            When the pull request is merged, the status moves to the "done" label. This needs the{" "}
            <Link href={href("integrations", "github")}>GitHub webhook</Link> with <Strong>Pull requests</Strong> ticked
            {githubHook ? "." : " (not set up yet)."}
          </>,
        ]}
      />
      <Switch
        label="Start tasks from tickets"
        description="Off: no ticket starts a task and monday.com's deliveries are refused. Tasks already running keep updating their tickets."
        value={auto.enabled}
        changeAction={toggle}
      />

      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={4}>Boards</Heading>
          <Button label="Automate a board" size="sm" onClick={() => setDrawer({ isOpen: true })} />
        </HStack>
        {rows.length > 0 ? (
          <Table<BoardRow>
            data={rows}
            idKey="id"
            verticalAlign="top"
            columns={[
              {
                key: "board",
                header: "Board and repository",
                width: proportional(1, { minWidth: 160 }),
                renderCell: (r) => (
                  <VStack gap={0.5} hAlign="start">
                    <Link weight="medium" onClick={() => setDrawer({ isOpen: true, boardId: r.id })} tooltip={`Edit the automation of ${r.name}`}>
                      {r.name}
                    </Link>
                    <Code size="inherit">{r.board.repo}</Code>
                    <Text type="supporting">{names[r.id] ? `Board ${r.id} · column ${r.board.statusColumnId}` : `Column ${r.board.statusColumnId}`}</Text>
                    {isNarrow && removeButton(r)}
                  </VStack>
                ),
              },
              {
                key: "labels",
                header: "Status",
                width: proportional(1, { minWidth: isNarrow ? 150 : 180 }),
                renderCell: (r) => (
                  <VStack gap={0.5}>
                    <Text>
                      {r.board.startLabel} → {flow(r.board)}
                    </Text>
                    <Text type="supporting">{r.board.stuckLabel ? `${r.board.stuckLabel} when the team stops` : "Status left as it is when the team stops"}</Text>
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
                      renderCell: (r: BoardRow) => <HStack hAlign="end">{removeButton(r)}</HStack>,
                    },
                  ]),
            ]}
          />
        ) : (
          <Text color="secondary">No board yet. Add one to choose its repository and the status labels the team uses.</Text>
        )}
      </VStack>

      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={4}>Webhook</Heading>
          <StatusLine tone={auto.webhookConfigured ? "success" : "neutral"} text={auto.webhookConfigured ? "Set up" : "Not set up"} />
        </HStack>
        <Text color="secondary">
          monday.com tells {name} when a ticket's status changes. Connecting creates a webhook on each board above, pointing at this deployment; monday.com checks the
          address once, so turn the automation on first. Connect again after adding a board.
        </Text>
        <FormActions>
          <Button
            label={auto.webhookConfigured ? "Connect again" : "Connect webhook"}
            variant="primary"
            isDisabled={!auto.enabled || rows.length === 0}
            clickAction={connect}
          />
          {(!auto.enabled || rows.length === 0) && (
            <Text type="supporting" color="secondary">
              {!auto.enabled ? "Turn the automation on first." : "Add a board first."}
            </Text>
          )}
        </FormActions>
        {result && <WebhookResult result={result} boardName={boardName} />}
      </VStack>

      <MondayBoardDrawer isOpen={drawer.isOpen} boardId={drawer.boardId} known={known.current} onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, isOpen }))} />
    </PaneSection>
  );
}

/** The boards the webhook was created on, and for the others the error and how to add it by hand. */
function WebhookResult({ result, boardName }: { result: WebhookResponse; boardName: (id: string) => string }) {
  if (result.ok) {
    return (
      <Banner
        status="success"
        title={`Connected on ${plural(result.created.length, "board")}`}
        description={result.created.map(boardName).join(", ")}
        collapsible={false}
      />
    );
  }
  return (
    <Banner
      status="warning"
      title={`The webhook could not be created on ${plural(result.failed.length, "board")}`}
      description={result.created.length ? `Connected on ${result.created.map(boardName).join(", ")}.` : undefined}
      collapsible={false}>
      <VStack gap={4}>
        <List density="compact" hasDividers>
          {result.failed.map((f) => (
            <ListItem key={f.boardId} label={<Text weight="semibold">{boardName(f.boardId)}</Text>} description={<Text type="supporting">{f.error}</Text>} />
          ))}
        </List>
        <Text>
          The token's monday.com user may not be allowed to add webhooks (it needs the webhooks:write scope and to be able to edit the board), or monday.com could not reach
          this deployment. Add it by hand:
        </Text>
        {result.manualSteps && <Steps label="On each board in monday.com" steps={result.manualSteps} />}
        <CopyField label="Webhook URL" value={result.url} description="Secret: anyone with this address can send ticket changes. Paste it only into monday.com." />
      </VStack>
    </Banner>
  );
}
