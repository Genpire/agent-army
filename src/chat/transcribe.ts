import type { Config } from "../core/config.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import { type AttachmentInfo, type AttachmentRepo, type AudioMediaType, type ThreadRef, classify, sniffAudioType } from "./attachments.js";

/**
 * Voice messages to text, with whichever speech-to-text service is connected:
 * OpenAI (the Codex engine's key, config.engines.codex.apiKey), else Gemini
 * (the Gemini CLI engine's key, config.engines.gemini.apiKey). Both detect the
 * language themselves, Arabic and English included. Each call is billed by
 * that provider on that key, outside Pointer's Claude spend caps. Neither the
 * audio nor the transcript is ever logged, and error messages carry neither.
 */

export type TranscriptionProvider = NonNullable<AttachmentInfo["transcribedBy"]>;

export const TRANSCRIPTION = {
  openaiUrl: "https://api.openai.com/v1/audio/transcriptions",
  /** The recommended model first; the next is tried when an account cannot use it. */
  openaiModels: ["gpt-transcribe", "gpt-4o-mini-transcribe"],
  /** OpenAI's upload limit. */
  openaiMaxBytes: 25 * 1024 * 1024,
  /** Formats OpenAI reads (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm): not raw AAC. */
  openaiTypes: ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg", "audio/flac"] as AudioMediaType[],
  geminiBase: "https://generativelanguage.googleapis.com/v1beta/models",
  /** The cheapest stable audio model first; the next is tried when it is not available. */
  geminiModels: ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"],
  /** A request is at most 20 MB with the audio inline, and base64 adds a third. */
  geminiMaxBytes: 14 * 1024 * 1024,
  timeoutMs: 120_000,
} as const;

/** The MIME types Gemini's docs list for audio. */
const GEMINI_TYPE: Record<AudioMediaType, string> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/m4a",
  "audio/wav": "audio/wav",
  "audio/mpeg": "audio/mp3",
  "audio/flac": "audio/flac",
  "audio/aac": "audio/aac",
};

const FILE_EXT: Record<AudioMediaType, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/aac": "aac",
};

const GEMINI_PROMPT =
  "Transcribe this voice message word for word, in the language it is spoken in (it may be Arabic, English, or both mixed). " +
  "Keep each language in its own script. Write only the transcript: no title, labels, timestamps, translation or commentary. " +
  "If there is no speech, write nothing.";

export const NO_TRANSCRIPTION =
  "No transcription is set up. Connect OpenAI (Integrations → Codex) or Gemini (Integrations → Gemini CLI) to turn voice messages into text.";

export type TranscribeResult =
  | { ok: true; text: string; provider: TranscriptionProvider }
  | { ok: false; reason: "unavailable" | "unsupported" | "too-large" | "failed"; error: string };

/** The services that can transcribe, in the order they are tried. */
export function transcriptionProviders(config: Pick<Config, "engines">): TranscriptionProvider[] {
  return [...(config.engines.codex.apiKey ? ["openai" as const] : []), ...(config.engines.gemini.apiKey ? ["gemini" as const] : [])];
}

/** The service that transcribes first, or null when none is connected. */
export const transcriptionProvider = (config: Pick<Config, "engines">): TranscriptionProvider | null => transcriptionProviders(config)[0] ?? null;

const PROVIDER_NAME: Record<TranscriptionProvider, string> = { openai: "OpenAI", gemini: "Gemini" };

class ProviderError extends Error {
  constructor(
    message: string,
    /** The model is not available to this key: the next model may be. */
    readonly tryNextModel = false,
  ) {
    super(message);
  }
}

/** The provider's own error message (never the audio or transcript), one short line. */
async function failure(res: Response, provider: TranscriptionProvider): Promise<ProviderError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown; code?: unknown; status?: unknown } };
  const message = typeof body.error?.message === "string" ? body.error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const code = typeof body.error?.code === "string" ? body.error.code : "";
  const modelProblem = res.status === 404 || code === "model_not_found" || (res.status === 403 && /model/i.test(message));
  return new ProviderError(`${PROVIDER_NAME[provider]} answered ${res.status}${message ? `: ${message}` : ""}`, modelProblem);
}

async function openAiTranscribe(key: string, model: string, bytes: Uint8Array, type: AudioMediaType, fetchFn: typeof fetch, timeoutMs: number): Promise<string> {
  const form = new FormData();
  // OpenAI reads the format from the file name's extension.
  form.append("file", new Blob([Uint8Array.from(bytes)], { type }), `voice-message.${FILE_EXT[type]}`);
  form.append("model", model);
  const res = await fetchFn(TRANSCRIPTION.openaiUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await failure(res, "openai");
  const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (!data || typeof data.text !== "string") throw new ProviderError("OpenAI answered without a transcript.");
  return data.text;
}

async function geminiTranscribe(key: string, model: string, bytes: Uint8Array, type: AudioMediaType, fetchFn: typeof fetch, timeoutMs: number): Promise<string> {
  const res = await fetchFn(`${TRANSCRIPTION.geminiBase}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType: GEMINI_TYPE[type], data: Buffer.from(bytes).toString("base64") } }] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await failure(res, "gemini");
  const data = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[];
    promptFeedback?: { blockReason?: unknown };
  } | null;
  if (typeof data?.promptFeedback?.blockReason === "string") throw new ProviderError(`Gemini declined the audio (${data.promptFeedback.blockReason}).`);
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new ProviderError("Gemini answered without a transcript.");
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text as string)
    .join("");
}

export interface TranscribeOptions {
  /** Tests pass a fake for OpenAI and Gemini. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Transcribes audio with the first connected service that reads its format
 * and size; when one fails, the next connected one is tried. The audio's type
 * comes from its bytes, never from a name or a browser's word.
 */
export async function transcribeAudio(config: Config, bytes: Uint8Array, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const providers = transcriptionProviders(config);
  if (!providers.length) return { ok: false, reason: "unavailable", error: NO_TRANSCRIPTION };
  const type = sniffAudioType(bytes);
  if (!type) return { ok: false, reason: "unsupported", error: "This is not audio that can be transcribed (WebM, Ogg, MP4/M4A, MP3, WAV, FLAC or AAC)." };
  const fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? TRANSCRIPTION.timeoutMs;
  const redact = makeRedactor([...configSecrets(config), config.engines.codex.apiKey, config.engines.gemini.apiKey]);

  const errors: string[] = [];
  let tried = false;
  for (const provider of providers) {
    const fits =
      provider === "openai"
        ? TRANSCRIPTION.openaiTypes.includes(type) && bytes.byteLength <= TRANSCRIPTION.openaiMaxBytes
        : bytes.byteLength <= TRANSCRIPTION.geminiMaxBytes;
    if (!fits) continue;
    tried = true;
    const key = provider === "openai" ? config.engines.codex.apiKey! : config.engines.gemini.apiKey!;
    const models = provider === "openai" ? TRANSCRIPTION.openaiModels : TRANSCRIPTION.geminiModels;
    let error = `${PROVIDER_NAME[provider]} offers none of the transcription models (${models.join(", ")}) to this key.`;
    for (const model of models) {
      try {
        const text = provider === "openai" ? await openAiTranscribe(key, model, bytes, type, fetchFn, timeoutMs) : await geminiTranscribe(key, model, bytes, type, fetchFn, timeoutMs);
        return { ok: true, text: text.trim(), provider };
      } catch (err) {
        if (err instanceof ProviderError && err.tryNextModel) continue;
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        error = timedOut
          ? `${PROVIDER_NAME[provider]} took too long to answer.`
          : err instanceof ProviderError
            ? err.message
            : `${PROVIDER_NAME[provider]} could not be reached.`;
        break;
      }
    }
    errors.push(redact(error));
  }
  if (!tried) {
    return {
      ok: false,
      reason: "too-large",
      error: `This recording is too long to transcribe here (${Math.round(bytes.byteLength / 1024 / 1024)} MB). Record a shorter message.`,
    };
  }
  return { ok: false, reason: "failed", error: `Could not transcribe the voice message. ${errors.join(" ")}`.trim() };
}

/**
 * Transcribes a stored audio attachment and saves the transcript on it, so
 * Pointer reads it with the conversation. An attachment transcribed before is
 * not sent again (each call is billed). `bytes` saves a read when the caller
 * has them.
 */
export async function transcribeAttachment(
  repo: Pick<AttachmentRepo, "get" | "setTranscript">,
  thread: ThreadRef,
  info: AttachmentInfo,
  config: Config,
  opts: TranscribeOptions & { bytes?: Uint8Array } = {},
): Promise<TranscribeResult> {
  if (classify(info.name, info.mime) !== "audio") return { ok: false, reason: "unsupported", error: "Only audio files can be transcribed." };
  if (info.transcript !== undefined && info.transcribedBy) return { ok: true, text: info.transcript, provider: info.transcribedBy };
  const bytes = opts.bytes ?? (await repo.get(thread, info.id));
  if (!bytes) return { ok: false, reason: "failed", error: "The voice message is no longer stored." };
  const result = await transcribeAudio(config, bytes, opts);
  if (result.ok) await repo.setTranscript(thread, info.id, { text: result.text, provider: result.provider });
  return result;
}
