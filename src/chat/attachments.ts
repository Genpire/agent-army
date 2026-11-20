import { randomBytes } from "node:crypto";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { unzipSync } from "fflate";
import { decrypt, encrypt } from "../core/crypto.js";
import type { Store } from "../core/store.js";

/**
 * Files people share with Pointer (Slack uploads, console uploads and voice
 * messages, monday.com and Jira item files). Stored per conversation thread,
 * encrypted with the master key, so Pointer can read them in chat and the
 * team gets them in repo tasks started from that thread. Never written into
 * a repository checkout. Audio reaches Pointer as its transcript
 * (transcribe.ts), never as sound.
 */
export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: "slack" | "monday" | "jira" | "web";
  /** Slack file id, monday asset id or Jira issue/attachment id, used to avoid storing the same file twice. */
  sourceId?: string;
  addedAt: string;
  /** Audio only: what was said, once transcribed ("" when no speech was heard). Kept in the encrypted index, never logged. */
  transcript?: string;
  /** Audio only: the service that wrote the transcript. */
  transcribedBy?: "openai" | "gemini";
  /** Audio only: its length as the recorder reported it, for display. */
  durationMs?: number;
}

export interface ThreadRef {
  channel: string;
  threadTs: string;
}

export interface NewAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  source: AttachmentInfo["source"];
  sourceId?: string;
  durationMs?: number;
}

export const ATTACHMENT_LIMITS = {
  /** Largest single file accepted. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Files kept per thread; older ones stay but new ones are refused past this. */
  maxFilesPerThread: 40,
  /** Zip safety: entries and total uncompressed size read from one archive. */
  maxZipEntries: 300,
  maxZipBytes: 60 * 1024 * 1024,
  /** What goes into one prompt. */
  maxTextCharsPerFile: 60_000,
  maxTextCharsTotal: 250_000,
  maxImages: 12,
  maxImageBytes: 5 * 1024 * 1024,
  maxPdfBytes: 15 * 1024 * 1024,
  /** Images + PDFs per prompt (raw bytes; base64 adds a third), keeping requests well under the API's 32 MB limit. */
  maxBinaryBytesTotal: 16 * 1024 * 1024,
  /** Longest transcript kept for one voice message. */
  maxTranscriptChars: 20_000,
} as const;

const ATTACHMENT_ID_RE = /^a-[0-9a-f]{8}$/;
export const isAttachmentId = (id: string): boolean => ATTACHMENT_ID_RE.test(id);

const prefixFor = (t: ThreadRef) => `attachments/${t.channel}-${t.threadTs.replace(".", "_")}/`;
/** Letters and digits of any script stay (Arabic names remain readable); controls, bidi overrides, slashes and the like become "_". */
const safeName = (name: string) => name.replace(/[^\p{L}\p{M}\p{N}_.\- ()]+/gu, "_").slice(0, 150) || "file";

type AddResult = { ok: true; info: AttachmentInfo } | { ok: false; error: string };

export class AttachmentRepo {
  /** Serialises index updates within this process. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
  ) {}

  async list(thread: ThreadRef): Promise<AttachmentInfo[]> {
    const blob = await this.store.get(`${prefixFor(thread)}index.enc`);
    if (!blob || blob.length === 0) return [];
    const parsed = JSON.parse(decrypt(this.key, blob)) as { files?: AttachmentInfo[] };
    return Array.isArray(parsed.files) ? parsed.files : [];
  }

  async get(thread: ThreadRef, id: string): Promise<Buffer | null> {
    if (!isAttachmentId(id)) return null;
    const blob = await this.store.get(`${prefixFor(thread)}${id}.enc`);
    if (!blob || blob.length === 0) return null;
    return Buffer.from(decrypt(this.key, blob), "base64");
  }

  /** Store a file for a thread. Returns the existing entry when the same source file was already stored. */
  add(thread: ThreadRef, file: NewAttachment): Promise<AddResult> {
    return this.serial(() => this.addNow(thread, file));
  }

  /** Saves an audio file's transcript (clipped) on its entry; null when the thread has no such file. */
  setTranscript(
    thread: ThreadRef,
    id: string,
    transcript: { text: string; provider: NonNullable<AttachmentInfo["transcribedBy"]> },
  ): Promise<AttachmentInfo | null> {
    return this.serial(async () => {
      const files = await this.list(thread);
      const index = files.findIndex((f) => f.id === id);
      if (index === -1) return null;
      const updated: AttachmentInfo = {
        ...files[index]!,
        transcript: transcript.text.slice(0, ATTACHMENT_LIMITS.maxTranscriptChars),
        transcribedBy: transcript.provider,
      };
      files[index] = updated;
      await this.writeIndex(thread, files);
      return updated;
    });
  }

  /** Erases one file (its stored bytes become empty) and drops it from the thread. False when there is none. */
  remove(thread: ThreadRef, id: string): Promise<boolean> {
    return this.serial(async () => {
      if (!isAttachmentId(id)) return false;
      const files = await this.list(thread);
      if (!files.some((f) => f.id === id)) return false;
      await this.store.put(`${prefixFor(thread)}${id}.enc`, "");
      await this.writeIndex(thread, files.filter((f) => f.id !== id));
      return true;
    });
  }

  /** Erases every file of a thread (a deleted console conversation). Returns how many there were. */
  removeAll(thread: ThreadRef): Promise<number> {
    return this.serial(async () => {
      const files = await this.list(thread);
      for (const f of files) await this.store.put(`${prefixFor(thread)}${f.id}.enc`, "");
      if (files.length) await this.writeIndex(thread, []);
      return files.length;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private writeIndex(thread: ThreadRef, files: AttachmentInfo[]): Promise<void> {
    return this.store.put(`${prefixFor(thread)}index.enc`, encrypt(this.key, JSON.stringify({ files })));
  }

  private async addNow(thread: ThreadRef, file: NewAttachment): Promise<AddResult> {
    if (file.bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes) {
      return { ok: false, error: `${file.name} is larger than ${ATTACHMENT_LIMITS.maxFileBytes / 1024 / 1024} MB.` };
    }
    const files = await this.list(thread);
    const existing = file.sourceId && files.find((f) => f.source === file.source && f.sourceId === file.sourceId);
    if (existing) return { ok: true, info: existing };
    if (files.length >= ATTACHMENT_LIMITS.maxFilesPerThread) {
      return { ok: false, error: `This thread already has ${files.length} files; start a new thread for more.` };
    }
    const duration = file.durationMs;
    const info: AttachmentInfo = {
      id: `a-${randomBytes(4).toString("hex")}`,
      name: safeName(file.name),
      mime: file.mime || "application/octet-stream",
      size: file.bytes.byteLength,
      source: file.source,
      ...(file.sourceId ? { sourceId: file.sourceId } : {}),
      addedAt: new Date().toISOString(),
      ...(duration !== undefined && Number.isFinite(duration) && duration >= 0 ? { durationMs: Math.round(duration) } : {}),
    };
    await this.store.put(`${prefixFor(thread)}${info.id}.enc`, encrypt(this.key, Buffer.from(file.bytes).toString("base64")));
    await this.writeIndex(thread, [...files, info]);
    return { ok: true, info };
  }
}

export type FileKind = "image" | "pdf" | "text" | "zip" | "audio" | "other";

const TEXT_EXT =
  /\.(html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|json|jsonc|md|mdx|txt|csv|tsv|xml|svg|ya?ml|toml|ini|env\.example|sql|py|rb|go|rs|java|kt|swift|php|sh|graphql|gql|vue|svelte|astro|lock|log)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|opus|weba|aac|flac)$/i;

export function classify(name: string, mime: string): FileKind {
  const n = name.toLowerCase();
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime) || /\.(png|jpe?g|gif|webp)$/.test(n)) return "image";
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime === "application/zip" || mime === "application/x-zip-compressed" || n.endsWith(".zip")) return "zip";
  if (mime.startsWith("audio/") || (!mime.startsWith("video/") && AUDIO_EXT.test(n))) return "audio";
  if (mime.startsWith("text/") || /json|xml|javascript|svg/.test(mime) || TEXT_EXT.test(n)) return "text";
  return "other";
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The image type from the file's first bytes, or null when it is not a supported image. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export type AudioMediaType = "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/wav" | "audio/mpeg" | "audio/flac" | "audio/aac";

/** The audio container from the file's first bytes (what browsers record and phones send), or null. */
export function sniffAudioType(bytes: Uint8Array): AudioMediaType | null {
  const b = bytes;
  const ascii = (at: number, text: string) => b.length >= at + text.length && [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(4, "ftyp")) return "audio/mp4";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff) {
    // ADTS AAC: 12 sync bits and layer 00; MPEG audio (MP3): 11 sync bits and a non-zero layer.
    if ((b[1]! & 0xf6) === 0xf0) return "audio/aac";
    if ((b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return "audio/mpeg";
  }
  return null;
}

export function imageMediaType(name: string, mime: string): ImageMediaType {
  const n = name.toLowerCase();
  if (mime === "image/jpeg" || /\.jpe?g$/.test(n)) return "image/jpeg";
  if (mime === "image/gif" || n.endsWith(".gif")) return "image/gif";
  if (mime === "image/webp" || n.endsWith(".webp")) return "image/webp";
  return "image/png";
}

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const isUtf8Text = (b: Uint8Array): boolean => {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/** Longest file name accepted from the console, before it is made safe. */
export const UPLOAD_NAME_MAX = 200;

/**
 * Checks a file uploaded from the console and decides what it is stored as.
 * The browser's type is a hint only: images and audio are typed by their
 * bytes, and a file named or typed as an image, audio, a PDF, a zip or text
 * whose bytes say otherwise is refused. Anything else is kept as plain bytes
 * (application/octet-stream) for the team.
 */
export function checkUpload(rawName: string, declared: string, bytes: Uint8Array): { ok: true; name: string; mime: string } | { ok: false; error: string } {
  // The last path segment only, without control characters; the store makes it safe again.
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[\p{Cc}\p{Cf}]+/gu, "").trim();
  if (!name) return { ok: false, error: "The file has no name." };
  if (name.length > UPLOAD_NAME_MAX) return { ok: false, error: `File names are limited to ${UPLOAD_NAME_MAX} characters.` };
  const label = name.length > 60 ? `${name.slice(0, 59)}…` : name;
  if (bytes.byteLength === 0) return { ok: false, error: `${label} is empty.` };
  if (bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes) {
    return { ok: false, error: `${label} is ${sizeLabel(bytes.byteLength)}; files are limited to ${sizeLabel(ATTACHMENT_LIMITS.maxFileBytes)}.` };
  }
  const hint = declared.split(";")[0]!.trim().toLowerCase();
  const image = sniffImageType(bytes);
  if (image) return { ok: true, name, mime: image };
  const kind = classify(name, hint);
  const zipBytes = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
  // Office documents (docx, xlsx, pptx) are zips with an XML-ish type: plain bytes for the team, not text.
  if (zipBytes && kind !== "zip") return { ok: true, name, mime: "application/octet-stream" };
  switch (kind) {
    case "image":
      return { ok: false, error: `${label} is named like an image, but it is not a PNG, JPEG, GIF or WebP file.` };
    case "audio": {
      const audio = sniffAudioType(bytes);
      return audio
        ? { ok: true, name, mime: audio }
        : { ok: false, error: `${label} is not audio this console can read (WebM, Ogg, MP4/M4A, MP3, WAV, FLAC or AAC).` };
    }
    case "pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? { ok: true, name, mime: "application/pdf" } : { ok: false, error: `${label} is named like a PDF, but it is not one.` };
    case "zip":
      return zipBytes ? { ok: true, name, mime: "application/zip" } : { ok: false, error: `${label} is named like a zip, but it is not one.` };
    case "text":
      return isUtf8Text(bytes) ? { ok: true, name, mime: "text/plain" } : { ok: false, error: `${label} is named like a text file, but it is not UTF-8 text.` };
    case "other":
      return { ok: true, name, mime: "application/octet-stream" };
  }
}

/** The files inside a zip (directories skipped, macOS metadata dropped), within the zip-bomb limits. */
export function expandZip(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  let entries = 0;
  let total = 0;
  const out = unzipSync(bytes, {
    filter: (f) => {
      if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(f.name)) return false;
      entries += 1;
      total += f.originalSize;
      return entries <= ATTACHMENT_LIMITS.maxZipEntries && total <= ATTACHMENT_LIMITS.maxZipBytes;
    },
  });
  return Object.entries(out).map(([name, data]) => ({ name, bytes: data }));
}

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A file for toContentBlocks; audio carries its transcript (undefined = not transcribed, "" = no speech heard). */
export interface PromptFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
  transcript?: string;
}

/**
 * Turn files into Messages API content blocks Claude can read: text files as
 * text, images as images, PDFs as documents, zips expanded one level, audio
 * as its transcript (never the sound itself). Everything over the limits is
 * listed by name instead of included.
 */
export function toContentBlocks(files: PromptFile[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const skipped: string[] = [];
  let textBudget = ATTACHMENT_LIMITS.maxTextCharsTotal;
  let binaryBudget = ATTACHMENT_LIMITS.maxBinaryBytesTotal;
  let images = 0;

  const addFile = (name: string, mime: string, bytes: Uint8Array, inZip: string | null, transcript?: string) => {
    const label = inZip ? `${inZip} › ${name}` : name;
    const kind = classify(name, mime);
    if (kind === "image") {
      if (
        images >= ATTACHMENT_LIMITS.maxImages ||
        bytes.byteLength > ATTACHMENT_LIMITS.maxImageBytes ||
        bytes.byteLength > binaryBudget
      ) {
        skipped.push(`${label} (image, ${sizeLabel(bytes.byteLength)}: over the image limit)`);
        return;
      }
      // The API rejects an image whose declared type doesn't match its bytes, which would fail the whole reply.
      const mediaType = sniffImageType(bytes);
      if (!mediaType) {
        skipped.push(`${label} (named like an image, but not a PNG, JPEG, GIF or WebP)`);
        return;
      }
      images += 1;
      binaryBudget -= bytes.byteLength;
      blocks.push({ type: "text", text: `Image: ${label}` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
      });
      return;
    }
    if (kind === "pdf" && !inZip) {
      if (bytes.byteLength > ATTACHMENT_LIMITS.maxPdfBytes || bytes.byteLength > binaryBudget) {
        skipped.push(`${label} (PDF, ${sizeLabel(bytes.byteLength)}: too large)`);
        return;
      }
      binaryBudget -= bytes.byteLength;
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
        title: label,
      });
      return;
    }
    if (kind === "zip" && !inZip) {
      let inner: { name: string; bytes: Uint8Array }[];
      try {
        inner = expandZip(bytes);
      } catch {
        skipped.push(`${label} (zip that could not be opened)`);
        return;
      }
      blocks.push({ type: "text", text: `Zip archive ${label} contains ${inner.length} file(s): ${inner.map((f) => f.name).join(", ")}` });
      for (const f of inner) addFile(f.name, "", f.bytes, label);
      return;
    }
    if (kind === "audio") {
      if (inZip) {
        skipped.push(`${label} (audio inside a zip: not transcribed)`);
        return;
      }
      const said = transcript?.trim();
      if (transcript === undefined) {
        blocks.push({ type: "text", text: `A voice message was attached (${label}), but it could not be transcribed, so what it says is not included.` });
        return;
      }
      if (!said) {
        blocks.push({ type: "text", text: `A voice message was attached (${label}); no speech could be heard in it.` });
        return;
      }
      const limit = Math.max(0, Math.min(ATTACHMENT_LIMITS.maxTextCharsPerFile, textBudget));
      if (limit === 0) {
        skipped.push(`${label} (voice message transcript: prompt text limit reached)`);
        return;
      }
      const text = said.length > limit ? `${said.slice(0, limit)}…(truncated)` : said;
      textBudget -= Math.min(said.length, limit);
      blocks.push({ type: "text", text: `Voice message (transcript): ${text}\n(audio file: ${label})` });
      return;
    }
    if (kind === "text") {
      if (textBudget <= 0) {
        skipped.push(`${label} (text, ${sizeLabel(bytes.byteLength)}: prompt text limit reached)`);
        return;
      }
      const full = Buffer.from(bytes).toString("utf8");
      const limit = Math.min(ATTACHMENT_LIMITS.maxTextCharsPerFile, textBudget);
      const text = full.length > limit ? `${full.slice(0, limit)}\n…(truncated, ${full.length} characters in total)` : full;
      textBudget -= Math.min(full.length, limit);
      blocks.push({ type: "text", text: `File: ${label}\n<file>\n${text}\n</file>` });
      return;
    }
    skipped.push(`${label} (${mime || "unknown type"}, ${sizeLabel(bytes.byteLength)}: not readable here)`);
  };

  for (const f of files) addFile(f.name, f.mime, f.bytes, null, f.transcript);
  if (skipped.length) blocks.push({ type: "text", text: `Not included:\n${skipped.map((s) => `- ${s}`).join("\n")}` });
  return blocks;
}
