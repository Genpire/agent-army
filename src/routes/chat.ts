/**
 * The console chat's files and voice messages (the conversations themselves
 * are in server.ts):
 *
 * - GET  /api/chat/options: limits, and which service transcribes voice messages (null = none).
 * - POST /api/conversations/:id/attachments?name=…&type=…[&durationMs=…]: one file's bytes as
 *   application/octet-stream; `:id` is a conversation, a draft, or "new" to start a draft
 *   (uploads before the first message). Answers { conversationId, attachments: [info] }.
 * - POST /api/conversations/:id/attachments/:fileId/delete: removes an upload not sent yet.
 * - GET  /api/conversations/:id/attachments/:fileId: a file of that conversation only. Images
 *   inline with their sniffed type; everything else as a download, audio with its sniffed type
 *   (the console plays it) and the rest as application/octet-stream. Always nosniff and a
 *   sandboxing CSP. Byte ranges are served so voice messages can be scrubbed.
 * - POST /api/conversations/:id/transcribe { attachmentId }: { text, provider }; 409 when no
 *   service is connected.
 *
 * Files are stored with the attachment store Slack files use (attachments.ts), under the
 * conversation's thread; their contents and transcripts are never logged.
 */
import express, { type Request, type Response, Router } from "express";
import { z } from "zod";
import { ATTACHMENT_LIMITS, isAttachmentId, sniffAudioType, sniffImageType } from "../chat/attachments.js";
import { CONVERSATION_ID_RE, type ConversationService, MAX_FILES_PER_MESSAGE, MAX_RECORDING_MS } from "../chat/conversations.js";
import { transcriptionProvider } from "../chat/transcribe.js";
import type { IntegrationRouteDeps } from "./types.js";

export interface ChatRouteDeps extends Pick<IntegrationRouteDeps, "configRepo" | "requireAdmin"> {
  conversations: ConversationService;
  /** Tests pass a fake for OpenAI and Gemini. */
  fetch?: typeof fetch;
}

const NOT_FOUND = "Conversation not found.";
const FILE_NOT_FOUND = "File not found.";
const TYPE_MAX = 200;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** GET /api/chat/options */
export interface ChatOptions {
  transcription: "openai" | "gemini" | null;
  limits: { maxFileBytes: number; maxFilesPerMessage: number; maxFilesPerConversation: number; maxRecordingMs: number };
}

/** The raw body, up to the file limit. */
const rawFile = express.raw({ type: () => true, limit: ATTACHMENT_LIMITS.maxFileBytes });

/** RFC 6266 filename: an ASCII fallback plus the UTF-8 name. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "file";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** One `bytes=a-b` range within `size`, or null for the whole file; "bad" when it cannot be served. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  const m = header?.trim().match(RANGE_RE);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? "bad" : { start, end };
}

export function chatRoutes(deps: ChatRouteDeps): Router {
  const { conversations, configRepo, requireAdmin } = deps;
  const router = Router();

  const fileParams = (req: Request, res: Response): { id: string; fileId: string } | undefined => {
    const id = String(req.params.id ?? "");
    const fileId = String(req.params.fileId ?? "");
    if (!CONVERSATION_ID_RE.test(id)) return void res.status(404).json({ error: NOT_FOUND });
    if (!isAttachmentId(fileId)) return void res.status(404).json({ error: FILE_NOT_FOUND });
    return { id, fileId };
  };

  router.get("/api/chat/options", requireAdmin, async (_req, res) => {
    const options: ChatOptions = {
      transcription: transcriptionProvider(await configRepo.load()),
      limits: {
        maxFileBytes: ATTACHMENT_LIMITS.maxFileBytes,
        maxFilesPerMessage: MAX_FILES_PER_MESSAGE,
        maxFilesPerConversation: ATTACHMENT_LIMITS.maxFilesPerThread,
        maxRecordingMs: MAX_RECORDING_MS,
      },
    };
    res.json(options);
  });

  router.post(
    "/api/conversations/:id/attachments",
    requireAdmin,
    // Too large answers 413 in words, not the server's generic error.
    (req, res, next) =>
      rawFile(req, res, (err?: unknown) => {
        if (!err) return next();
        const tooLarge = (err as { type?: string }).type === "entity.too.large";
        res.status(tooLarge ? 413 : 400).json({
          error: tooLarge ? `Files are limited to ${ATTACHMENT_LIMITS.maxFileBytes / 1024 / 1024} MB.` : "The upload could not be read. Try again.",
        });
      }),
    async (req, res) => {
      const id = String(req.params.id ?? "");
      if (id !== "new" && !CONVERSATION_ID_RE.test(id)) return void res.status(404).json({ error: NOT_FOUND });
      // A JSON body was already parsed by the /api JSON parser: files must come as plain bytes.
      if (!Buffer.isBuffer(req.body)) return void res.status(415).json({ error: "Send the file's bytes as application/octet-stream." });
      const query = z
        .object({
          name: z.string().max(1000, "File names are limited to 200 characters.").default(""),
          type: z.string().max(TYPE_MAX).default(""),
          durationMs: z.coerce.number().int().min(0).max(MAX_RECORDING_MS * 2).optional(),
        })
        .safeParse(req.query);
      if (!query.success) return void res.status(400).json({ error: query.error.issues[0]?.message ?? "Invalid upload." });
      const result = await conversations.upload(id, {
        name: query.data.name,
        type: query.data.type,
        bytes: req.body,
        ...(query.data.durationMs !== undefined ? { durationMs: query.data.durationMs } : {}),
      });
      if (!result.ok) return void res.status(result.status).json({ error: result.error });
      res.status(201).json({ conversationId: result.conversationId, attachments: [result.info] });
    },
  );

  router.post("/api/conversations/:id/attachments/:fileId/delete", requireAdmin, async (req, res) => {
    const params = fileParams(req, res);
    if (!params) return;
    const result = await conversations.removeUpload(params.id, params.fileId);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  });

  router.get("/api/conversations/:id/attachments/:fileId", requireAdmin, async (req, res) => {
    const params = fileParams(req, res);
    if (!params) return;
    const found = await conversations.file(params.id, params.fileId);
    if (!found) return void res.status(404).json({ error: FILE_NOT_FOUND });
    const { info, bytes } = found;
    // The type comes from the bytes, never from the stored name or the uploader's word.
    const image = sniffImageType(bytes);
    const audio = image ? null : sniffAudioType(bytes);
    res.setHeader("Content-Type", image ?? audio ?? "application/octet-stream");
    res.setHeader("Content-Disposition", disposition(image ? "inline" : "attachment", info.name));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    const range = byteRange(req.get("range"), bytes.byteLength);
    if (range === "bad") {
      res.setHeader("Content-Range", `bytes */${bytes.byteLength}`);
      return void res.status(416).end();
    }
    if (range) {
      res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
      return void res.end(bytes.subarray(range.start, range.end + 1));
    }
    res.setHeader("Content-Length", String(bytes.byteLength));
    res.end(bytes);
  });

  router.post("/api/conversations/:id/transcribe", requireAdmin, async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!CONVERSATION_ID_RE.test(id)) return void res.status(404).json({ error: NOT_FOUND });
    const input = z
      .object({ attachmentId: z.string().max(20).refine(isAttachmentId, "Choose a voice message to transcribe.") })
      .safeParse(req.body);
    if (!input.success) return void res.status(400).json({ error: input.error.issues[0]?.message ?? "Invalid input." });
    const result = await conversations.transcribe(id, input.data.attachmentId, deps.fetch ? { fetch: deps.fetch } : {});
    if (result.ok) return void res.json({ text: result.text, provider: result.provider });
    const status = { "not-found": 404, unavailable: 409, unsupported: 415, "too-large": 413, failed: 502 }[result.reason];
    res.status(status).json({ error: result.error, reason: result.reason });
  });

  return router;
}
