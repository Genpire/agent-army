/**
 * The Miro pane: connect with an app's access token, the default board and
 * the boards Pointer may use, and what to ask.
 */
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type SearchSource, Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { PresentationChartLineIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api, errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { type IntegrationSummary, parseList } from "./catalog";
import { type MiroBoardItem, type MiroBoardSummary, boardDescription, boardIdOf, boardItem, boardRefsError, fetchBoards } from "./miro/boards";
import { Examples, FormActions, FormError, PaneHeader, PaneSection, Steps, Strong, useSave } from "./parts";

export function MiroPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const m = config.miro;
  const name = config.team.pointer.name;

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={PresentationChartLineIcon}
        title={summary.name}
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name} read Miro boards and add to them from Slack and Chat: sticky notes, cards, and diagrams laid out in a frame, for example "draw our deploy pipeline on the Architecture board". It never deletes, moves or edits what is already on a board.`}
        onBack={onBack}
      />

      {m.connected && (
        <MetadataList>
          <MetadataListItem label="User">
            <Text>{m.userName || "Unknown"}</Text>
          </MetadataListItem>
          {m.teamName && (
            <MetadataListItem label="Team">
              <Text>{m.teamName}</Text>
            </MetadataListItem>
          )}
        </MetadataList>
      )}

      <MiroToken />
      {m.connected && <MiroBoards />}
      {m.connected && (
        <Examples
          title="What to ask"
          description={`Mention ${name} in Slack or write in Chat. Name a board, paste its link, or let ${name} use the default board.`}
          examples={[
            "Summarise the retro board and list the action items",
            "Draw our deploy pipeline on the Architecture board",
            "Add these ideas as sticky notes in the Sprint 12 frame",
            "Add a card for the login bug to the Roadmap board, due Friday",
          ]}
        />
      )}
    </VStack>
  );
}

function MiroToken() {
  const { config } = useConfig();
  const m = config.miro;
  const name = config.team.pointer.name;
  const [token, setToken] = useState("");
  const { save, error, edit } = useSave();

  const submit = async () => {
    const t = token.trim();
    const invalid = !t ? "Paste a Miro access token." : t.length < 20 || /\s/.test(t) ? "That doesn't look like a Miro access token." : undefined;
    const ok = await save(() => api.post<{ userName?: string; teamName?: string }>("/api/miro", { token: t }), {
      invalid,
      success: (r) => (r.userName ? `Miro connected as ${r.userName}${r.teamName ? ` in ${r.teamName}` : ""}.` : "Miro connected."),
    });
    if (ok) setToken("");
  };

  return (
    <PaneSection
      title={m.connected ? "Access token" : "Connect Miro"}
      description={`The token acts as the Miro user who installed the app, in the team it was installed in, and opens the boards that user can open. Use a dedicated user, for example "${name} bot", invited only to the boards ${name} should work on.`}>
      {!m.connected && (
        <Steps
          label="To get a token"
          steps={[
            <>
              In Miro, open <Strong>Profile settings</Strong>, then <Strong>Your apps</Strong>, and choose <Strong>Create new app</Strong>. Miro may first ask you to create a free developer team.
            </>,
            <>
              Under <Strong>Permissions</Strong>, select <Strong>boards:read</Strong> and <Strong>boards:write</Strong>. Leave <Strong>Expire user authorization token</Strong> off: {name} cannot renew a token.
            </>,
            <>
              Choose <Strong>Install app and get OAuth token</Strong>, pick the team whose boards {name} should use, and copy the access token.
            </>,
            <>Paste it below. It is checked with Miro, stored encrypted and never shown again.</>,
          ]}
        />
      )}
      <FormLayout>
        <SecretField label="Miro access token" value={token} onChange={edit(setToken)} saved={m.connected ? m.key : null} placeholder={m.connected ? undefined : "eyJ…"} isRequired />
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
              await save(() => api.post("/api/miro/disconnect", {}), { success: "Miro disconnected. The board settings are kept." });
            }}
          />
        )}
      </FormActions>
    </PaneSection>
  );
}

/** The default board (picked from the boards Miro lists, searchable, or by pasting its link) and the boards Pointer may use. */
function MiroBoards() {
  const { config } = useConfig();
  const m = config.miro;
  const name = config.team.pointer.name;
  const known = useRef(new Map<string, MiroBoardSummary>());
  const [boardsError, setBoardsError] = useState<string>();
  const [recentCount, setRecentCount] = useState<number>();
  const [board, setBoard] = useState<MiroBoardItem | null>(m.defaultBoardId ? { id: m.defaultBoardId, label: `Board ${m.defaultBoardId}` } : null);
  const [allowed, setAllowed] = useState(m.allowedBoardIds.join(", "));
  const { save, error, edit } = useSave();

  const load = useCallback(async (query: string): Promise<MiroBoardItem[]> => {
    try {
      const boards = await fetchBoards(query);
      boards.forEach((b) => known.current.set(b.id, b));
      setBoardsError(undefined);
      if (!query) setRecentCount(boards.length);
      return boards.map(boardItem);
    } catch (err) {
      setBoardsError(`Couldn't load boards: ${errorMessage(err)}`);
      return [];
    }
  }, []);

  const source = useMemo<SearchSource<MiroBoardItem>>(() => ({ search: (q) => load(q.trim()), bootstrap: () => load("") }), [load]);

  // Names the saved default board once the recent boards arrive (the configuration only holds its id),
  // or, when it is not a recent one, by looking it up (the server reads a board id ending in "=" directly).
  useEffect(() => {
    const id = m.defaultBoardId;
    const show = (found: MiroBoardItem | undefined) => {
      if (found) setBoard((current) => (current?.id === id ? found : current));
    };
    void load("").then(async (items) => {
      if (!id) return;
      const recent = items.find((i) => i.id === id);
      if (recent || !id.endsWith("=")) return show(recent);
      const looked = await fetchBoards(id).catch((): MiroBoardSummary[] => []);
      show(looked.filter((b) => b.id === id).map(boardItem)[0]);
    });
  }, [load, m.defaultBoardId]);

  const entries = parseList(allowed);
  const refsError = boardRefsError(entries);
  const ids = refsError ? [] : [...new Set(entries.map((e) => boardIdOf(e)!))];
  const defaultId = board?.id ?? "";
  const defaultOutside = defaultId !== "" && ids.length > 0 && !ids.includes(defaultId);

  const submit = async () => {
    const saved = await save(() => api.post("/api/miro", { defaultBoardId: defaultId, allowedBoardIds: ids }), {
      invalid: refsError ?? (defaultOutside ? `Add the default board (${defaultId}) to the boards ${name} may use, or empty that list.` : undefined),
      success: "Board settings saved.",
    });
    // Shows the ids the server stored, so pasted links read as ids afterwards.
    if (saved) setAllowed(ids.join(", "));
  };

  const pickerHelp =
    recentCount === undefined
      ? "Loading boards…"
      : `Lists the ${plural(recentCount, "most recently opened board")}; type to search by name, or paste a board's link. Empty: ${name} asks which board.`;

  return (
    <PaneSection title="Boards" description={`Where ${name} reads and adds when a request names no board, and which boards it may touch at all.`}>
      <FormLayout>
        <Typeahead<MiroBoardItem>
          label="Default board"
          searchSource={source}
          value={board}
          onChange={edit(setBoard)}
          placeholder="Search boards or paste a link"
          hasEntriesOnFocus
          minQueryLength={1}
          debounceMs={250}
          maxMenuItems={50}
          description={boardsError ? undefined : pickerHelp}
          status={boardsError ? { type: "error", message: boardsError } : undefined}
          statusVariant="detached"
          emptySearchText="No boards match. Check the spelling, or that the token's user can open the board."
          renderItem={(item) => <TypeaheadItem item={item} description={boardDescription(item.auxiliaryData ?? known.current.get(item.id), item.id)} />}
          isOptional
        />
        <TextInput
          label={`Boards ${name} may use`}
          value={allowed}
          onChange={edit(setAllowed)}
          placeholder="Every board the user can open"
          description="Board links or ids, comma separated: copy a board's link from its address bar (…/app/board/uXjVOabc123=/). Empty means every board the user can open; otherwise include the default board."
          status={refsError ? { type: "error", message: refsError } : defaultOutside ? { type: "warning", message: "The default board is not in this list." } : undefined}
          isOptional
        />
      </FormLayout>
      <FormError message={error} />
      <FormActions>
        <Button label="Save boards" variant="primary" isDisabled={Boolean(refsError)} clickAction={submit} />
      </FormActions>
    </PaneSection>
  );
}
