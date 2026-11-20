import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Records a voice message with MediaRecorder: WebM/Opus where the browser has
 * it (Chrome, Edge, Firefox), else MP4/AAC (Safari), else whatever it offers.
 * Stops on its own at `maxMs`. The microphone is released as soon as a
 * recording ends or is discarded, and when the page leaves.
 */

export interface Recording {
  blob: Blob;
  /** The recorder's type, e.g. "audio/webm;codecs=opus". */
  mime: string;
  /** File extension for the type: webm, m4a or ogg. */
  ext: string;
  durationMs: number;
}

export type RecorderStatus = "idle" | "starting" | "recording";

/** Preferred first; speech at 48 kbit/s keeps ten minutes under 4 MB. */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
const BITS_PER_SECOND = 48_000;

const extFor = (mime: string) => (mime.includes("mp4") || mime.includes("aac") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");

/** Why this browser cannot record, or null when it can. */
export function recordingUnsupported(): string | null {
  if (typeof window === "undefined") return "Recording is not available here.";
  if (!window.isSecureContext) return "Recording needs the console on https (or localhost).";
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return "This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.";
  return null;
}

/** The reason in words for a failed getUserMedia / MediaRecorder start. */
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow the microphone for this site in the browser's settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy or unavailable (another app may be using it).";
  return "Recording could not start in this browser.";
}

export interface VoiceRecorder {
  status: RecorderStatus;
  /** When the recording started (ms since epoch), while recording. */
  startedAt: number | null;
  /** Why recording is not possible here, or null. */
  unsupported: string | null;
  start: () => Promise<void>;
  /** Ends the recording and hands it to onRecorded. */
  stop: () => void;
  /** Ends the recording and throws it away. */
  discard: () => void;
}

export function useVoiceRecorder(opts: { maxMs: number; onRecorded: (r: Recording) => void; onError: (message: string) => void }): VoiceRecorder {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = useRef(true);
  const latest = useRef(opts);
  latest.current = opts;
  const unsupported = recordingUnsupported();

  const release = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    setStatus("idle");
    setStartedAt(null);
  }, []);

  const end = useCallback((save: boolean) => {
    const r = recorder.current;
    if (!r) return;
    keep.current = save;
    if (r.state !== "inactive") r.stop();
    else release();
  }, [release]);

  const start = useCallback(async () => {
    if (recorder.current || unsupported) {
      if (unsupported) latest.current.onError(unsupported);
      return;
    }
    setStatus("starting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setStatus("idle");
      latest.current.onError(micError(err));
      return;
    }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    let r: MediaRecorder;
    try {
      r = new MediaRecorder(media, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: BITS_PER_SECOND });
    } catch (err) {
      media.getTracks().forEach((t) => t.stop());
      setStatus("idle");
      latest.current.onError(micError(err));
      return;
    }
    const chunks: Blob[] = [];
    const began = Date.now();
    keep.current = true;
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    r.onstop = () => {
      const mime = r.mimeType || type || "audio/webm";
      const durationMs = Math.min(Date.now() - began, latest.current.maxMs);
      release();
      if (!keep.current) return;
      const blob = new Blob(chunks, { type: mime });
      if (blob.size === 0) {
        latest.current.onError("Nothing was recorded. Check the microphone and try again.");
        return;
      }
      latest.current.onRecorded({ blob, mime, ext: extFor(mime), durationMs });
    };
    r.onerror = () => {
      keep.current = false;
      latest.current.onError("Recording stopped because of a microphone error.");
      if (r.state !== "inactive") r.stop();
      else release();
    };
    recorder.current = r;
    stream.current = media;
    r.start(1000);
    setStartedAt(began);
    setStatus("recording");
    timer.current = setTimeout(() => end(true), latest.current.maxMs);
  }, [end, release, unsupported]);

  // Leaving the page (or the conversation) drops a recording in progress and frees the microphone.
  useEffect(
    () => () => {
      keep.current = false;
      const r = recorder.current;
      if (r && r.state !== "inactive") r.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { status, startedAt, unsupported, start, stop: () => end(true), discard: () => end(false) };
}
