import { decrypt, encrypt } from "./core/crypto.js";
import { sniffImageType } from "./attachments.js";
import type { Store } from "./core/store.js";

/**
 * Screenshots from a repo task's browser checks, kept in the store and
 * encrypted with the master key like shared files (`screenshots/<taskId>/<name>`,
 * with an index), so the admin console can show them for Slack and web tasks
 * alike. The worker writes them (one writer per task); the web service reads.
 */

export interface ScreenshotInfo {
  name: string;
  size: number;
  addedAt: string;
}

/** Names the console asks for: a safe flat file name with an image extension. */
export const SCREENSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(png|jpe?g|webp)$/;
export const TASK_ID_RE = /^[a-z0-9]{1,20}-[0-9a-f]{1,20}$/;

const prefix = (taskId: string) => `screenshots/${taskId}/`;
const INDEX = "index.enc";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** A screenshot's file name made safe and unique: "pages/home page.png" → "pages-home-page.png". */
export function screenshotName(raw: string, taken: Set<string>): string {
  const ext = raw.match(IMAGE_EXT)?.[1]?.toLowerCase() ?? "png";
  const stem =
    raw
      .replace(IMAGE_EXT, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[-.]+$/, "")
      .slice(0, 80) || "screenshot";
  let name = `${stem}.${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${n}.${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

/** The image's content type from its bytes; null when it is not a PNG, JPEG or WebP. */
export function screenshotType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const type = sniffImageType(bytes);
  return type === "image/png" || type === "image/jpeg" || type === "image/webp" ? type : null;
}

export class ScreenshotRepo {
  /** Serialises index updates within this process. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
  ) {}

  async list(taskId: string): Promise<ScreenshotInfo[]> {
    if (!TASK_ID_RE.test(taskId)) return [];
    const blob = await this.store.get(prefix(taskId) + INDEX);
    if (!blob || blob.length === 0) return [];
    const parsed = JSON.parse(decrypt(this.key, blob)) as { shots?: ScreenshotInfo[] };
    return Array.isArray(parsed.shots) ? parsed.shots : [];
  }

  async get(taskId: string, name: string): Promise<Buffer | null> {
    if (!TASK_ID_RE.test(taskId) || !SCREENSHOT_NAME_RE.test(name) || name.includes("..")) return null;
    const blob = await this.store.get(prefix(taskId) + name);
    if (!blob || blob.length === 0) return null;
    return Buffer.from(decrypt(this.key, blob), "base64");
  }

  /** Stores screenshots under unique safe names (an existing name gets "-2"…); returns what was stored. */
  add(taskId: string, shots: { name: string; bytes: Buffer }[], now = new Date()): Promise<ScreenshotInfo[]> {
    const run = this.chain.then(() => this.addNow(taskId, shots, now));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async addNow(taskId: string, shots: { name: string; bytes: Buffer }[], now: Date): Promise<ScreenshotInfo[]> {
    if (!TASK_ID_RE.test(taskId)) throw new Error("invalid task id");
    const existing = await this.list(taskId);
    const taken = new Set(existing.map((s) => s.name.toLowerCase()));
    const added: ScreenshotInfo[] = [];
    for (const shot of shots) {
      if (!screenshotType(shot.bytes)) continue;
      const name = screenshotName(shot.name, taken);
      await this.store.put(prefix(taskId) + name, encrypt(this.key, shot.bytes.toString("base64")));
      added.push({ name, size: shot.bytes.byteLength, addedAt: now.toISOString() });
    }
    if (added.length) await this.store.put(prefix(taskId) + INDEX, encrypt(this.key, JSON.stringify({ shots: [...existing, ...added] })));
    return added;
  }
}
