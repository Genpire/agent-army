import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// mkdtemp as a spy over the real one, so a test can make one call fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, mkdtemp: vi.fn(real.mkdtemp) };
});

const { STALE_CREDENTIALS_MS, buildRuntime, removeStaleCredentialFolders, testConnection } = await import("../../src/ai/ai-providers.js");

const realMkdtemp = vi.mocked(mkdtemp).getMockImplementation()!;
const SA_KEY = JSON.stringify({ type: "service_account", project_id: "acme-ai", private_key: "fake-vertex-private-part-for-tests" });
const VERTEX = { secrets: { credentialsJson: SA_KEY }, settings: { projectId: "acme-ai", region: "global" }, models: {} };

afterEach(() => {
  vi.mocked(mkdtemp).mockImplementation(realMkdtemp);
});

describe("the key file of a connection test", () => {
  it("is removed when the test fails after writing it", async () => {
    const written: string[] = [];
    vi.mocked(mkdtemp).mockImplementation((async (prefix: string) => {
      if (prefix.includes("ai-test-")) throw new Error("ENOSPC: no space left on device");
      const dir = await realMkdtemp(prefix);
      written.push(dir);
      return dir;
    }) as never);
    const queryFn = vi.fn();
    const result = await testConnection("vertex", VERTEX, { queryFn });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("no space left on device") });
    expect(queryFn).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    await expect(stat(written[0]!)).rejects.toThrow();
  });

  it("lives in a folder named after the process that wrote it", async () => {
    const session = await buildRuntime("vertex", VERTEX).session();
    const folder = dirname(session.env.GOOGLE_APPLICATION_CREDENTIALS!);
    expect(basename(folder)).toMatch(new RegExp(`^ai-credentials-${process.pid}-[A-Za-z0-9]{6}$`));
    await session.dispose();
  });
});

describe("credential folders left behind", () => {
  /** A pid no process has: a child that has already exited. */
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

  async function folder(dir: string, name: string, mtimeMs: number) {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(join(path, "google_application_credentials.json"), "{}");
    await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
  }

  it("removes old folders whose process has stopped, and keeps running, fresh and unrelated ones", async () => {
    const dir = await realMkdtemp(join(tmpdir(), "army-stale-"));
    // The cleanup runs ten minutes from now: this process's own folders are then old, and still its own.
    const now = Date.now() + 10 * 60_000;
    const old = now - STALE_CREDENTIALS_MS - 60_000;
    const startedAt = Date.now() - process.uptime() * 1000;
    const dead = deadPid();

    await folder(dir, `ai-credentials-${dead}-abc123`, old); // its process stopped: removed
    await folder(dir, "ai-credentials-Ab12Cd", old); // before folders were named after their process: removed
    await folder(dir, `ai-credentials-${process.pid}-earlie`, startedAt - 3_600_000); // an earlier process with this pid: removed
    await folder(dir, `ai-credentials-${dead}-fresh1`, now - 1000); // a query may have just written it: kept
    await folder(dir, `ai-credentials-${process.ppid}-runnin`, old); // a running process (a repo task): kept
    await folder(dir, `ai-credentials-${process.pid}-mine01`, Date.now()); // this process's own: kept
    await folder(dir, "ai-test-Zz9Yy8", old); // not a credentials folder: kept
    await writeFile(join(dir, `ai-credentials-${dead}-afile1`), "x"); // not a folder: kept
    const target = await folder(dir, "elsewhere", old);
    await symlink(target, join(dir, `ai-credentials-${dead}-linkto`)); // a link, not a folder of ours: kept, target untouched

    expect(await removeStaleCredentialFolders({ dir, now })).toBe(3);
    expect((await readdir(dir)).sort()).toEqual(
      [
        `ai-credentials-${dead}-afile1`,
        `ai-credentials-${dead}-fresh1`,
        `ai-credentials-${dead}-linkto`,
        `ai-credentials-${process.pid}-mine01`,
        `ai-credentials-${process.ppid}-runnin`,
        "ai-test-Zz9Yy8",
        "elsewhere",
      ].sort(),
    );
    expect(await readdir(target)).toEqual(["google_application_credentials.json"]);
  });

  it("never throws, even without the folder", async () => {
    expect(await removeStaleCredentialFolders({ dir: join(tmpdir(), "army-no-such-folder-0000") })).toBe(0);
  });
});
