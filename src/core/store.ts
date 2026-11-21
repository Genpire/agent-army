import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Tiny blob store. Everything Agent Army persists (encrypted config, task
 * records) goes through this, so the same image runs on a laptop, a VM or
 * Cloud Run by switching one env var.
 */
export interface Store {
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer | string): Promise<void>;
  /**
   * Writes `data` only if `key` does not exist yet, atomically: of several
   * concurrent creates of one key (in this process or across instances),
   * exactly one returns true. Used to claim work once, e.g. a scheduled run.
   */
  create(key: string, data: Buffer | string): Promise<boolean>;
  /** Keys under a prefix (non-recursive is enough for our layout). */
  list(prefix: string): Promise<string[]>;
  describe(): string;
}

export class FsStore implements Store {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.root, key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  async create(key: string, data: Buffer | string): Promise<boolean> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    // A full file under a unique name, then a hard link to the key: link() fails
    // with EEXIST when the key exists, atomically, and readers never see a partial file.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const names = await readdir(join(this.root, prefix));
      return names.filter((n) => !n.endsWith(".tmp")).map((n) => `${prefix}${n}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  describe(): string {
    return `filesystem (${this.root})`;
  }
}

export class GcsStore implements Store {
  private bucketPromise: Promise<import("@google-cloud/storage").Bucket> | undefined;

  constructor(private readonly bucketName: string, private readonly prefix = "") {}

  private bucket() {
    this.bucketPromise ??= import("@google-cloud/storage").then(({ Storage }) =>
      new Storage().bucket(this.bucketName),
    );
    return this.bucketPromise;
  }

  async get(key: string): Promise<Buffer | null> {
    const file = (await this.bucket()).file(this.prefix + key);
    try {
      const [data] = await file.download();
      return data;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await (await this.bucket()).file(this.prefix + key).save(data, { resumable: false });
  }

  async create(key: string, data: Buffer | string): Promise<boolean> {
    try {
      // Generation 0 means "no live object": Cloud Storage refuses the write (412) when the key exists.
      await (await this.bucket()).file(this.prefix + key).save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 412) return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await (await this.bucket()).getFiles({ prefix: this.prefix + prefix });
    return files.map((f) => f.name.slice(this.prefix.length));
  }

  describe(): string {
    return `Cloud Storage (gs://${this.bucketName}/${this.prefix})`;
  }
}

export function createStore(env: NodeJS.ProcessEnv = process.env): Store {
  const kind = env.STORAGE ?? (env.GCS_BUCKET ? "gcs" : "fs");
  if (kind === "gcs") {
    if (!env.GCS_BUCKET) throw new Error("STORAGE=gcs requires GCS_BUCKET");
    return new GcsStore(env.GCS_BUCKET, env.GCS_PREFIX ?? "");
  }
  return new FsStore(env.DATA_DIR ?? "./data");
}
