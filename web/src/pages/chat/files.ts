import { ApiError, api } from "../../lib/api";
import type { AttachmentInfo } from "../../../../src/chat/attachments.js";
import type { MessageFile } from "../../../../src/chat/conversations.js";
import type { ChatOptions } from "../../../../src/routes/chat.js";

/**
 * Files and voice messages in the console chat: uploads (one file per
 * request, as raw bytes, so a progress bar can follow it), removal before
 * sending, transcription, and the authenticated URL each file is served at.
 * The server decides what a file is from its bytes; the checks here only
 * spare a round trip.
 */

export type { AttachmentInfo, ChatOptions, MessageFile };

/** POST /api/conversations/:id/attachments (201). */
export interface UploadAnswer {
  conversationId: string;
  attachments: AttachmentInfo[];
}

/** POST /api/conversations/:id/transcribe */
export interface TranscribeAnswer {
  text: string;
  provider: "openai" | "gemini";
}

/** Used until GET /api/chat/options answers; the server enforces its own. */
export const DEFAULT_OPTIONS: ChatOptions = {
  transcription: null,
  limits: { maxFileBytes: 20 * 1024 * 1024, maxFilesPerMessage: 10, maxFilesPerConversation: 40, maxRecordingMs: 10 * 60_000 },
};

export const PROVIDER_NAME: Record<NonNullable<ChatOptions["transcription"]>, string> = { openai: "OpenAI", gemini: "Gemini" };

export const fileUrl = (conversationId: string, fileId: string) =>
  `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(fileId)}`;

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
export const isImage = (f: { mime: string }) => IMAGE_TYPES.test(f.mime);
export const isAudio = (f: { mime: string }) => f.mime.startsWith("audio/");

/** "820 KB", "3.4 MB" */
export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** "0:42", "10:00" */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The browser's word for a file's type, without parameters ("audio/webm;codecs=opus" → "audio/webm"). */
const baseType = (type: string) => type.split(";")[0]!.trim();

/**
 * Uploads one file to a conversation (or "new" for a conversation that has
 * not started), reporting progress from 0 to 1. Errors carry the server's
 * reason ("photo.png is named like an image, but…").
 */
export function uploadFile(
  conversationId: string | "new",
  file: Blob,
  name: string,
  opts: { durationMs?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadAnswer> {
  const query = new URLSearchParams({ name, type: baseType(file.type) });
  if (opts.durationMs !== undefined) query.set("durationMs", String(Math.round(opts.durationMs)));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { error?: unknown } & Partial<UploadAnswer>;
      if (xhr.status >= 200 && xhr.status < 300 && data.conversationId && data.attachments) {
        resolve({ conversationId: data.conversationId, attachments: data.attachments });
        return;
      }
      // A 401 means the session ended: a JSON call lets the app go back to the sign-in screen.
      if (xhr.status === 401) void api.get("/api/chat/options").catch(() => undefined);
      const message = typeof data.error === "string" && data.error ? data.error : `The server answered ${xhr.status}.`;
      reject(new ApiError(message, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Could not reach the server. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const removeUpload = (conversationId: string, fileId: string) =>
  api.post(`/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(fileId)}/delete`);

export const transcribe = (conversationId: string, attachmentId: string) =>
  api.post<TranscribeAnswer>(`/api/conversations/${encodeURIComponent(conversationId)}/transcribe`, { attachmentId });

export const loadChatOptions = () => api.get<ChatOptions>("/api/chat/options");

/**
 * The language for the browser's live dictation: Arabic when the browser
 * prefers it, else the page's language, else the browser's, else English.
 */
export function dictationLang(): string {
  const browser = typeof navigator === "undefined" ? "" : (navigator.languages?.[0] ?? navigator.language ?? "");
  if (/^ar\b/i.test(browser)) return browser;
  const page = typeof document === "undefined" ? "" : document.documentElement.lang;
  return page || browser || "en-US";
}
