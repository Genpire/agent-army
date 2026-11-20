/**
 * monday.com board pickers: the board list from /api/monday/boards as
 * Typeahead items, and the search source of a picker limited to the boards
 * Pointer may use.
 */
import type { SearchSource, SearchableItem } from "@astryxdesign/core/Typeahead";
import type { MondayStatusColumn } from "../../../../src/integrations/monday/monday.js";
import type { WebhookConnectResult } from "../../../../src/integrations/monday/monday-automation.js";
import { api } from "../../lib/api";
import type { MondayBoardSummary, PublicConfig } from "../../lib/types";

export type BoardItem = SearchableItem<MondayBoardSummary>;
export type BoardAutomation = PublicConfig["monday"]["automation"]["boards"][string];

/** GET /api/monday/columns */
export interface ColumnsResponse {
  board: { id: string; name: string };
  columns: MondayStatusColumn[];
}

/** POST /api/monday/automation/webhook */
export interface WebhookResponse extends WebhookConnectResult {
  ok: boolean;
  url: string;
  /** How to add the webhook in monday.com by hand, when it could not be created. */
  manualSteps?: string[];
}

export const boardItem = (b: MondayBoardSummary): BoardItem => ({ id: b.id, label: b.name, auxiliaryData: b });
export const boardDescription = (b: MondayBoardSummary | undefined, id: string) => [b?.workspace, `Board ${id}`].filter(Boolean).join(" · ");

/** Boards by name (case-insensitive), most recently used first, from the server. */
export async function fetchBoards(query: string): Promise<MondayBoardSummary[]> {
  const { boards } = await api.get<{ boards: MondayBoardSummary[] }>(`/api/monday/boards${query ? `?search=${encodeURIComponent(query)}` : ""}`);
  return boards;
}

/**
 * Searches boards for a picker: only `allowed` ones when that list is set
 * (named when the board list knows them), and a typed board id is offered as
 * it is, so a board can be picked even when monday.com cannot list it.
 */
export function boardSource(opts: {
  allowed: string[];
  exclude: string[];
  known: Map<string, MondayBoardSummary>;
  onError: (message: string | undefined) => void;
}): SearchSource<BoardItem> {
  const { allowed, exclude, known, onError } = opts;
  const pick = (boards: MondayBoardSummary[]) => boards.filter((b) => (!allowed.length || allowed.includes(b.id)) && !exclude.includes(b.id));
  const load = async (query: string): Promise<BoardItem[]> => {
    let boards: MondayBoardSummary[] = [];
    try {
      boards = await fetchBoards(/^\d+$/.test(query) ? "" : query);
      boards.forEach((b) => known.set(b.id, b));
      onError(undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't load boards.");
    }
    const found = pick(boards);
    // Allowed boards the list did not return, and a typed id.
    const extra = [...(allowed.length && !query ? allowed : []), ...(/^\d{1,20}$/.test(query) ? [query] : [])].filter(
      (id) => !found.some((b) => b.id === id) && !exclude.includes(id) && (!allowed.length || allowed.includes(id)),
    );
    const named = [...new Set(extra)].map((id) => known.get(id) ?? { id, name: `Board ${id}` });
    return [...found, ...named].map(boardItem);
  };
  return { search: (q) => load(q.trim()), bootstrap: () => load("") };
}
