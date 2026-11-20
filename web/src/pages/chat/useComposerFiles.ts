import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../../lib/api";
import { type AttachmentInfo, type ChatOptions, PROVIDER_NAME, removeUpload, sizeText, transcribe, uploadFile } from "./files";
import type { Recording } from "./useVoiceRecorder";

/**
 * The files waiting in the composer: each is uploaded as soon as it is added
 * (one at a time, so a new conversation's uploads all land in the same
 * draft), shown with its progress, and sent by id with the next message. A
 * voice message is transcribed after its upload and the transcript is handed
 * to the composer for the owner to review. Refused files stay as chips that
 * say why until they are removed.
 */

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** The browser's type until uploaded, then the server's (decided from the bytes). */
  mime: string;
  status: "uploading" | "transcribing" | "ready" | "error";
  /** Upload progress, 0 to 1. */
  progress: number;
  /** Why it was refused or failed. */
  error?: string;
  /** A local preview (images, voice messages) until the message is sent. */
  previewUrl?: string;
  info?: AttachmentInfo;
  /** A recorded voice message, with its length. */
  voice?: { durationMs: number };
}

export interface ComposerFiles {
  files: PendingFile[];
  /** Ids to send with the message (uploaded files only). */
  readyIds: string[];
  /** Uploads or a transcription still running. */
  busy: boolean;
  /** For a conversation that has not started: the id its uploads went to. */
  draftId: string | undefined;
  /** A note about the last voice message (no transcription set up, or why it failed). */
  notice: string | undefined;
  add: (files: File[]) => void;
  addVoice: (recording: Recording) => void;
  remove: (key: string) => void;
  /** After a message is sent: forget the chips (the files now belong to the message). */
  clear: () => void;
  dismissNotice: () => void;
}

let nextKey = 0;
const keyOf = () => `f${++nextKey}`;
const previewable = (type: string) => /^image\/(png|jpeg|gif|webp)$/.test(type) || type.startsWith("audio/");

export function useComposerFiles(opts: {
  /** The conversation, or undefined for a new one (uploads start a draft). */
  conversationId: string | undefined;
  options: ChatOptions;
  /** A voice message's transcript, for the composer's text. */
  onTranscript: (text: string) => void;
}): ComposerFiles {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [draftId, setDraftId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const draft = useRef<string | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(opts);
  latest.current = opts;
  const current = useRef(files);
  current.current = files;
  /** Keys removed by the owner: their uploads are skipped or undone (state may not have re-rendered yet). */
  const removed = useRef(new Set<string>());

  const patch = useCallback((key: string, change: Partial<PendingFile>) => {
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));
  }, []);

  /** Where uploads go: the conversation, else the draft the first upload started, else "new". */
  const target = () => latest.current.conversationId ?? draft.current ?? "new";

  const upload = useCallback(
    (item: PendingFile, blob: Blob, durationMs?: number): Promise<AttachmentInfo | undefined> => {
      const run = queue.current.then(async () => {
        // Removed while it waited its turn.
        if (removed.current.has(item.key)) return undefined;
        try {
          const answer = await uploadFile(target(), blob, item.name, { durationMs, onProgress: (p) => patch(item.key, { progress: p }) });
          if (!latest.current.conversationId && !draft.current) {
            draft.current = answer.conversationId;
            setDraftId(answer.conversationId);
          }
          const info = answer.attachments[0]!;
          // Removed while it uploaded: erase it again so it is never sent.
          if (removed.current.has(item.key)) {
            void removeUpload(answer.conversationId, info.id).catch(() => undefined);
            return undefined;
          }
          patch(item.key, { status: "ready", progress: 1, info, name: info.name, mime: info.mime, size: info.size });
          return info;
        } catch (err) {
          const reason = errorMessage(err);
          if (err instanceof ApiError && err.status === 404 && draft.current) {
            // The draft was forgotten (the server restarted): the next upload starts a new one.
            draft.current = undefined;
            setDraftId(undefined);
          }
          patch(item.key, { status: "error", error: reason });
          return undefined;
        }
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [patch],
  );

  const add = useCallback(
    (picked: File[]) => {
      const { limits } = latest.current.options;
      const waiting = current.current.filter((f) => f.status !== "error").length;
      const items: { item: PendingFile; file: File }[] = [];
      picked.forEach((file, i) => {
        const name = file.name || (file.type.startsWith("image/") ? `pasted-image-${i + 1}.${file.type.split("/")[1] ?? "png"}` : "file");
        const base: PendingFile = { key: keyOf(), name, size: file.size, mime: file.type, status: "uploading", progress: 0 };
        let error: string | undefined;
        if (waiting + items.filter((x) => x.item.status !== "error").length >= limits.maxFilesPerMessage) {
          error = `${name} was not attached: a message can carry ${limits.maxFilesPerMessage} files.`;
        } else if (file.size === 0) error = `${name} is empty.`;
        else if (file.size > limits.maxFileBytes) error = `${name} is ${sizeText(file.size)}; files are limited to ${sizeText(limits.maxFileBytes)}.`;
        const item: PendingFile = error
          ? { ...base, status: "error", error }
          : { ...base, ...(previewable(file.type) ? { previewUrl: URL.createObjectURL(file) } : {}) };
        items.push({ item, file });
      });
      if (!items.length) return;
      setFiles((list) => [...list, ...items.map((x) => x.item)]);
      for (const { item, file } of items) if (item.status !== "error") void upload(item, file);
    },
    [upload],
  );

  const addVoice = useCallback(
    (rec: Recording) => {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
      const item: PendingFile = {
        key: keyOf(),
        name: `Voice message ${stamp}.${rec.ext}`,
        size: rec.blob.size,
        mime: rec.mime,
        status: "uploading",
        progress: 0,
        previewUrl: URL.createObjectURL(rec.blob),
        voice: { durationMs: rec.durationMs },
      };
      if (rec.blob.size > latest.current.options.limits.maxFileBytes) {
        setFiles((list) => [...list, { ...item, status: "error", error: `The recording is ${sizeText(rec.blob.size)}; files are limited to ${sizeText(latest.current.options.limits.maxFileBytes)}.` }]);
        return;
      }
      setFiles((list) => [...list, item]);
      setNotice(undefined);
      void upload(item, rec.blob, rec.durationMs).then(async (info) => {
        if (!info) return;
        const provider = latest.current.options.transcription;
        if (!provider) {
          setNotice("Voice message attached without a transcript: no transcription service is connected (Integrations → Codex or Gemini CLI). Pointer is told a voice message came with it.");
          return;
        }
        const conversationId = latest.current.conversationId ?? draft.current;
        if (!conversationId) return;
        patch(item.key, { status: "transcribing" });
        try {
          const heard = await transcribe(conversationId, info.id);
          patch(item.key, { status: "ready" });
          if (heard.text.trim()) latest.current.onTranscript(heard.text.trim());
          else setNotice("No speech was heard in the voice message. It stays attached; record again if you meant to say something.");
        } catch (err) {
          patch(item.key, { status: "ready" });
          setNotice(`The voice message is attached, but ${PROVIDER_NAME[provider]} could not transcribe it: ${errorMessage(err)}`);
        }
      });
    },
    [patch, upload],
  );

  const remove = useCallback((key: string) => {
    const item = current.current.find((f) => f.key === key);
    if (!item) return;
    removed.current.add(key);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setFiles((list) => list.filter((f) => f.key !== key));
    const conversationId = latest.current.conversationId ?? draft.current;
    // Uploaded but not sent: erase it on the server too (best effort; a stray upload is never sent).
    if (item.info && conversationId) void removeUpload(conversationId, item.info.id).catch(() => undefined);
  }, []);

  const clear = useCallback(() => {
    for (const f of current.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles([]);
    setNotice(undefined);
  }, []);

  // Previews are released when the composer goes away.
  useEffect(() => () => current.current.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)), []);

  return {
    files,
    readyIds: files.flatMap((f) => (f.status !== "error" && f.status !== "uploading" && f.info ? [f.info.id] : [])),
    busy: files.some((f) => f.status === "uploading" || f.status === "transcribing"),
    draftId,
    notice,
    add,
    addVoice,
    remove,
    clear,
    dismissNotice: () => setNotice(undefined),
  };
}
