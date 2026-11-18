import { randomBytes } from "node:crypto";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { unzipSync } from "fflate";
import { decrypt, encrypt } from "./crypto.js";
import type { Store } from "./store.js";

/**
 * Files people share with Pointer (Slack uploads, monday.com item files).
 * Stored per conversation thread, encrypted with the master key, so Pointer
 * can read them in chat and the team gets them in repo tasks started from
 * that thread. Never written into a repository checkout.
 */
export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: "slack" | "monday";
  /** Slack file id or monday asset id, used to avoid storing the same file twice. */
  sourceId?: string;
  addedAt: string;
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
} as const;

const prefixFor = (t: ThreadRef) => `attachments/${t.channel}-${t.threadTs.replace(".", "_")}/`;
const safeName = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").slice(0, 150) || "file";

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
    if (!/^a-[0-9a-f]{8}$/.test(id)) return null;
    const blob = await this.store.get(`${prefixFor(thread)}${id}.enc`);
    if (!blob || blob.length === 0) return null;
    return Buffer.from(decrypt(this.key, blob), "base64");
  }

  /** Store a file for a thread. Returns the existing entry when the same source file was already stored. */
  add(thread: ThreadRef, file: NewAttachment): Promise<{ ok: true; info: AttachmentInfo } | { ok: false; error: string }> {
    const run = this.chain.then(() => this.addNow(thread, file));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async addNow(
    thread: ThreadRef,
    file: NewAttachment,
  ): Promise<{ ok: true; info: AttachmentInfo } | { ok: false; error: string }> {
    if (file.bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes) {
      return { ok: false, error: `${file.name} is larger than ${ATTACHMENT_LIMITS.maxFileBytes / 1024 / 1024} MB.` };
    }
    const files = await this.list(thread);
    const existing = file.sourceId && files.find((f) => f.source === file.source && f.sourceId === file.sourceId);
    if (existing) return { ok: true, info: existing };
    if (files.length >= ATTACHMENT_LIMITS.maxFilesPerThread) {
      return { ok: false, error: `This thread already has ${files.length} files; start a new thread for more.` };
    }
    const info: AttachmentInfo = {
      id: `a-${randomBytes(4).toString("hex")}`,
      name: safeName(file.name),
      mime: file.mime || "application/octet-stream",
      size: file.bytes.byteLength,
      source: file.source,
      ...(file.sourceId ? { sourceId: file.sourceId } : {}),
      addedAt: new Date().toISOString(),
    };
    const prefix = prefixFor(thread);
    await this.store.put(`${prefix}${info.id}.enc`, encrypt(this.key, Buffer.from(file.bytes).toString("base64")));
    await this.store.put(`${prefix}index.enc`, encrypt(this.key, JSON.stringify({ files: [...files, info] })));
    return { ok: true, info };
  }
}

export type FileKind = "image" | "pdf" | "text" | "zip" | "other";

const TEXT_EXT =
  /\.(html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|json|jsonc|md|mdx|txt|csv|tsv|xml|svg|ya?ml|toml|ini|env\.example|sql|py|rb|go|rs|java|kt|swift|php|sh|graphql|gql|vue|svelte|astro|lock|log)$/i;

export function classify(name: string, mime: string): FileKind {
  const n = name.toLowerCase();
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime) || /\.(png|jpe?g|gif|webp)$/.test(n)) return "image";
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime === "application/zip" || mime === "application/x-zip-compressed" || n.endsWith(".zip")) return "zip";
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

export function imageMediaType(name: string, mime: string): ImageMediaType {
  const n = name.toLowerCase();
  if (mime === "image/jpeg" || /\.jpe?g$/.test(n)) return "image/jpeg";
  if (mime === "image/gif" || n.endsWith(".gif")) return "image/gif";
  if (mime === "image/webp" || n.endsWith(".webp")) return "image/webp";
  return "image/png";
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

/**
 * Turn files into Messages API content blocks Claude can read: text files as
 * text, images as images, PDFs as documents, zips expanded one level.
 * Everything over the limits is listed by name instead of included.
 */
export function toContentBlocks(files: { name: string; mime: string; bytes: Uint8Array }[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const skipped: string[] = [];
  let textBudget = ATTACHMENT_LIMITS.maxTextCharsTotal;
  let binaryBudget = ATTACHMENT_LIMITS.maxBinaryBytesTotal;
  let images = 0;

  const addFile = (name: string, mime: string, bytes: Uint8Array, inZip: string | null) => {
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

  for (const f of files) addFile(f.name, f.mime, f.bytes, null);
  if (skipped.length) blocks.push({ type: "text", text: `Not included:\n${skipped.map((s) => `- ${s}`).join("\n")}` });
  return blocks;
}
