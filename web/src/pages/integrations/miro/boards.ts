/**
 * Miro boards on the admin page: the boards from /api/miro/boards as
 * Typeahead items, and board ids or links as typed in the allow list (the
 * server checks them again).
 */
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { MiroBoardSummary } from "../../../../../src/miro.js";
import { api } from "../../../lib/api";

export type { MiroBoardSummary };
export type MiroBoardItem = SearchableItem<MiroBoardSummary>;

export const boardItem = (b: MiroBoardSummary): MiroBoardItem => ({ id: b.id, label: b.name, auxiliaryData: b });
export const boardDescription = (b: MiroBoardSummary | undefined, id: string) => [b?.team, b?.description, `Board ${id}`].filter(Boolean).join(" · ");

/** GET /api/miro/boards: most recently opened first, matching `query` (name or description), or the board a pasted link names. */
export async function fetchBoards(query: string): Promise<MiroBoardSummary[]> {
  const { boards } = await api.get<{ boards: MiroBoardSummary[] }>(`/api/miro/boards${query ? `?query=${encodeURIComponent(query)}` : ""}`);
  return boards;
}

// Mirrors MIRO_BOARD_ID_RE in src/config.ts and parseBoardRef in src/miro.ts.
const BOARD_ID_RE = /^[A-Za-z0-9_=-]{4,64}$/;
const BOARD_LINK_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*miro\.com\/app\/(?:board|live-embed|embed)\/([^/?#\s]+)/i;

/** The board id in a board id or a board link (https://miro.com/app/board/uXjVOabc123=/), else undefined. */
export function boardIdOf(entry: string): string | undefined {
  const s = entry.trim();
  if (BOARD_ID_RE.test(s)) return s;
  const encoded = s.match(BOARD_LINK_RE)?.[1];
  if (!encoded) return undefined;
  try {
    const id = decodeURIComponent(encoded);
    return BOARD_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The first problem with a list of board ids or links. */
export function boardRefsError(entries: string[]): string | undefined {
  const bad = entries.find((x) => !boardIdOf(x));
  if (bad !== undefined) return `"${bad}" is not a board id or link. Copy the board's link from its address bar, like https://miro.com/app/board/uXjVOabc123=/.`;
  if (entries.length > 200) return "Allow at most 200 boards.";
  return undefined;
}
