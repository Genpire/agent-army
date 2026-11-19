import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type SearchSource, type SearchableItem, Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { RectangleStackIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { MondayBoardSummary } from "../../lib/types";
import { type IntegrationSummary, boardIdsError, parseList } from "./catalog";
import { FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";

type BoardItem = SearchableItem<MondayBoardSummary>;

const boardItem = (b: MondayBoardSummary): BoardItem => ({ id: b.id, label: b.name, auxiliaryData: b });
const boardDescription = (b: MondayBoardSummary | undefined, id: string) => [b?.workspace, `Board ${id}`].filter(Boolean).join(" · ");

export function MondayPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const m = config.monday;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={RectangleStackIcon}
        title="monday.com"
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name} find, open, update and comment on monday.com items from Slack, for example "open a ticket for the login bug on the Bugs board". It never deletes or archives anything.`}
        onBack={onBack}
      />

      {m.connected && (
        <MetadataList>
          <MetadataListItem label="User">
            <Text>{m.userName || "Unknown"}</Text>
          </MetadataListItem>
          {m.accountName && (
            <MetadataListItem label="Account">
              <Text>{m.accountName}</Text>
            </MetadataListItem>
          )}
        </MetadataList>
      )}

      <MondayToken />
      {m.connected && <MondayBoards />}
    </VStack>
  );
}

function MondayToken() {
  const { config } = useConfig();
  const m = config.monday;
  const name = config.team.pointer.name;
  const [token, setToken] = useState("");
  const { save, error, edit } = useSave();

  const submit = async () => {
    const t = token.trim();
    const invalid = !t ? "Paste a monday.com API token." : t.length < 20 ? "That doesn't look like a monday.com API token." : undefined;
    const ok = await save(() => api.post<{ userName?: string }>("/api/monday", { token: t }), {
      invalid,
      success: (r) => {
        const user = r.userName;
        return user ? `monday.com connected as ${user}.` : "monday.com connected.";
      },
    });
    if (ok) setToken("");
  };

  return (
    <PaneSection
      title={m.connected ? "API token" : "Connect monday.com"}
      description={`The token acts as the monday.com user who created it, with everything that user can see and change. Use a dedicated user, for example "${name} bot", added only to the boards ${name} should work on.`}>
      {!m.connected && (
        <Steps
          label="To get a token"
          steps={[
            <>
              In monday.com, click your avatar (top right) and choose <Strong>Developers</Strong>.
            </>,
            <>
              Open <Strong>My access tokens</Strong>, choose <Strong>Show</Strong> and copy the token.
            </>,
            <>Paste it below. It is checked with monday.com, stored encrypted and never shown again.</>,
          ]}
        />
      )}
      <FormLayout>
        <SecretField label="monday.com API token" value={token} onChange={edit(setToken)} saved={m.connected ? "••••" : null} placeholder={m.connected ? undefined : "eyJ…"} isRequired />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label={m.connected ? "Verify and replace" : "Verify and save"} variant="primary" clickAction={submit} />
        {m.connected && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Click again to disconnect"
            size="md"
            onConfirm={async () => {
              await save(() => api.post("/api/monday/disconnect", {}), { success: "monday.com disconnected. The board settings are kept." });
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** The default board (picked from the boards monday.com lists, searchable) and the boards Pointer may use. */
function MondayBoards() {
  const { config } = useConfig();
  const m = config.monday;
  const name = config.team.pointer.name;
  const known = useRef(new Map<string, MondayBoardSummary>());
  const [boardsError, setBoardsError] = useState<string>();
  const [recentCount, setRecentCount] = useState<number>();
  const [board, setBoard] = useState<BoardItem | null>(m.defaultBoardId ? { id: m.defaultBoardId, label: `Board ${m.defaultBoardId}` } : null);
  const [allowed, setAllowed] = useState(m.allowedBoardIds.join(", "));
  const { save, error, edit } = useSave();

  const load = useCallback(async (query: string): Promise<BoardItem[]> => {
    try {
      const { boards } = await api.get<{ boards: MondayBoardSummary[] }>(`/api/monday/boards${query ? `?search=${encodeURIComponent(query)}` : ""}`);
      boards.forEach((b) => known.current.set(b.id, b));
      setBoardsError(undefined);
      if (!query) setRecentCount(boards.length);
      return boards.map(boardItem);
    } catch (err) {
      setBoardsError(`Couldn't load boards: ${errorMessage(err)}`);
      return [];
    }
  }, []);

  const source = useMemo<SearchSource<BoardItem>>(() => ({ search: (q) => load(q.trim()), bootstrap: () => load("") }), [load]);

  // Names the saved default board once the recent boards arrive (the configuration only holds its id).
  useEffect(() => {
    const id = m.defaultBoardId;
    void load("").then((items) => {
      const found = id ? items.find((i) => i.id === id) : undefined;
      if (found) setBoard((current) => (current?.id === id ? found : current));
    });
  }, [load, m.defaultBoardId]);

  const ids = parseList(allowed);
  const idsError = boardIdsError(ids);
  const defaultId = board?.id ?? "";
  const defaultOutside = defaultId !== "" && ids.length > 0 && !ids.includes(defaultId);

  const submit = async () => {
    await save(() => api.post("/api/monday", { defaultBoardId: defaultId, allowedBoardIds: ids }), {
      invalid: idsError ?? (defaultOutside ? `Add the default board (${defaultId}) to the boards ${name} may use, or empty that list.` : undefined),
      success: "Board settings saved.",
    });
  };

  const pickerHelp =
    recentCount === undefined
      ? "Loading boards…"
      : `Lists the ${plural(recentCount, "most recently used board")}; type to search all boards. Empty: ${name} asks which board.`;

  return (
    <PaneSection title="Boards" description={`Where ${name} opens tickets when a request names no board, and which boards it may touch at all.`}>
      <FormLayout>
        <Typeahead<BoardItem>
          label="Default board for tickets"
          searchSource={source}
          value={board}
          onChange={edit(setBoard)}
          placeholder="Search boards"
          hasEntriesOnFocus
          minQueryLength={1}
          debounceMs={250}
          maxMenuItems={50}
          description={boardsError ? undefined : pickerHelp}
          status={boardsError ? { type: "error", message: boardsError } : undefined}
          statusVariant="detached"
          emptySearchText="No boards match. Check the spelling, or that the token's user is a member of the board."
          renderItem={(item) => <TypeaheadItem item={item} description={boardDescription(item.auxiliaryData ?? known.current.get(item.id), item.id)} />}
          isOptional
        />
        <TextInput
          label={`Boards ${name} may use`}
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="Every board the user can see"
          description={`Board ids, comma separated: the number in a board's URL (…/boards/1234567890). Empty means every board the user can see; otherwise include the default board.`}
          status={idsError ? { type: "error", message: idsError } : defaultOutside ? { type: "warning", message: "The default board is not in this list." } : undefined}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label="Save boards" variant="primary" isDisabled={Boolean(idsError)} clickAction={submit} />
      </FormActions>
    </PaneSection>
  );
}
