/**
 * Miro admin routes (/api/miro/…): connect or update (token, default board,
 * allowed boards), disconnect, and the boards for the default-board picker.
 * Miro has no webhook here: Pointer only reads and adds when asked in chat.
 */
import { Router } from "express";
import { z } from "zod";
import { MIRO_BOARD_ID_RE } from "../core/config.js";
import { MiroClient, MiroError, checkMiro, parseBoardRef, type MiroBoardSummary } from "../integrations/miro/miro.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** A board id or a board link, as typed on the admin page; stored as the id. "" stays "" where `empty` allows it. */
const boardRef = (empty: boolean) =>
  z
    .string()
    .trim()
    .max(500)
    .transform((s, ctx) => {
      if (empty && s === "") return "";
      const id = parseBoardRef(s);
      if (!id) {
        ctx.addIssue({ code: "custom", message: `"${s.slice(0, 80)}" is not a Miro board id or link, like https://miro.com/app/board/uXjVOabc123=/.` });
        return z.NEVER;
      }
      return id;
    });

const SAVE = z.object({
  token: z.string().max(4000).optional(),
  /** "" clears the default board. */
  defaultBoardId: boardRef(true).optional(),
  allowedBoardIds: z.array(boardRef(false)).max(200, "Allow at most 200 boards.").optional(),
});

export function miroRoutes(deps: IntegrationRouteDeps): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  // Connects (a token: checked with Miro unless SKIP_VALIDATION=1) and/or saves the board settings.
  router.post("/api/miro", requireAdmin, async (req, res) => {
    const parsed = SAVE.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    const input = parsed.data;
    const token = input.token?.trim() ?? "";
    if (token && (token.length < 20 || /\s/.test(token))) {
      return void res.status(400).json({ error: "That doesn't look like a Miro access token." });
    }
    const config = await configRepo.load(true);
    const current = config.miro;
    if (!token && !current.token) return void res.status(400).json({ error: "Connect Miro with an access token first." });
    const allowed = input.allowedBoardIds ? [...new Set(input.allowedBoardIds)] : current.allowedBoardIds;
    const defaultBoardId = input.defaultBoardId === undefined ? current.defaultBoardId : input.defaultBoardId || undefined;
    if (defaultBoardId && allowed.length > 0 && !allowed.includes(defaultBoardId)) {
      return void res.status(400).json({ error: `The default board must be one of the boards ${config.team.pointer.name} may use.` });
    }

    let info: { userName: string; teamName: string } | undefined;
    if (token) {
      try {
        info = await checkMiro(token);
      } catch (err) {
        // checkMiro's messages never contain the token; redacted again in case.
        const redact = makeRedactor([...configSecrets(config), token]);
        return void res.status(400).json({ error: redact((err as Error).message) });
      }
    }
    await configRepo.update((c) => {
      if (info) c.miro = { ...c.miro, token, ...info };
      c.miro.allowedBoardIds = allowed;
      c.miro.defaultBoardId = defaultBoardId;
    });
    res.json({ ok: true, ...info });
  });

  // Forgets the token and who it belongs to; the board settings stay for a later reconnect.
  router.post("/api/miro/disconnect", requireAdmin, async (_req, res) => {
    await configRepo.update((c) => {
      c.miro = { ...c.miro, token: undefined, userName: undefined, teamName: undefined };
    });
    res.json({ ok: true });
  });

  // Boards for the "Default board" picker: most recently opened first, or matching ?query=
  // (name or description). A pasted board link or id is looked up directly.
  router.get("/api/miro/boards", requireAdmin, async (req, res) => {
    const config = await configRepo.load(true);
    const token = config.miro.token;
    if (!token) return void res.status(400).json({ error: "Miro is not connected." });
    const query = typeof req.query.query === "string" ? req.query.query.trim().slice(0, 500) : "";
    const client = new MiroClient(token);
    // Board ids end in "=" (uXjVOabc123=); a word is a search.
    const direct = /miro\.com\//i.test(query) || (MIRO_BOARD_ID_RE.test(query) && query.endsWith("=")) ? parseBoardRef(query) : undefined;
    try {
      let boards: MiroBoardSummary[];
      if (direct) boards = [await client.getBoard(direct)];
      else boards = (await client.listBoards({ ...(query ? { query: query.slice(0, 100) } : {}), limit: 50 })).boards;
      res.json({ boards });
    } catch (err) {
      // MiroClient redacts the token from its errors; anything else is reported generically.
      const redact = makeRedactor(configSecrets(config));
      res.status(400).json({ error: err instanceof MiroError ? redact(err.message) : "Miro request failed." });
    }
  });

  return router;
}
