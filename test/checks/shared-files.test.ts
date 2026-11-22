import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentInfo } from "../../src/chat/attachments.js";
import { materializeAttachments } from "../../src/tasks/worker.js";

/**
 * Files shared in a thread are written for the team (materializeAttachments).
 * A zip entry whose path is absolute, carries a drive letter, or has a
 * segment made of dots is skipped, even when it would still land inside the
 * zip's folder; every other entry is written where its path says. A file's
 * name loses the characters a file system or a Markdown code span cannot take.
 */

const THREAD = { channel: "C0ACME", threadTs: "1700000000.000100" };

function repoWith(files: { name: string; bytes: Uint8Array; mime: string }[]) {
  const infos: AttachmentInfo[] = files.map((f, i) => ({ id: `a-0000000${i}`, name: f.name, mime: f.mime, size: f.bytes.byteLength, source: "slack", addedAt: "2026-11-18T00:00:00.000Z" }));
  return {
    list: vi.fn(async () => infos),
    get: vi.fn(async (_thread: unknown, id: string) => Buffer.from(files[infos.findIndex((i) => i.id === id)]!.bytes)),
  };
}

async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split(sep).join("/"))
    .sort();
}

describe("zip entries in shared files", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips entries with a drive letter or a dots segment, even ones that would stay inside the folder", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const zip = zipSync({
      "site/index.html": strToU8("<p>kept</p>"),
      "site/css/app.css": strToU8("p{}"),
      "notes.v2..final.txt": strToU8("dots inside a name are fine"),
      "site/../inside.txt": strToU8("dotdot"),
      "site/.../three.txt": strToU8("three dots"),
      "site/ .. /spaced.txt": strToU8("spaced dots"),
      "C:\\Users\\octo-dev\\drive.txt": strToU8("drive letter"),
      "d:/drive2.txt": strToU8("drive letter"),
      "/root.txt": strToU8("absolute"),
    });
    const dir = join(await mkdtemp(join(tmpdir(), "army-checks-zip-")), "attachments");
    const files = await materializeAttachments(repoWith([{ name: "design.zip", bytes: zip, mime: "application/zip" }]), THREAD, dir);

    expect(files.map((f) => f.name).sort()).toEqual(["notes.v2.final.txt", "site/css/app.css", "site/index.html"]);
    expect(await tree(dir)).toEqual(["design/notes.v2.final.txt", "design/site/css/app.css", "design/site/index.html"]);
    expect(await readFile(join(dir, "design", "site", "index.html"), "utf8")).toBe("<p>kept</p>");
  });
});

describe("shared file names", () => {
  it("replaces control and reserved characters, and keeps ordinary names as they are", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "army-checks-names-")), "attachments");
    const files = await materializeAttachments(
      repoWith([
        { name: 'a<b>:c"d|e?f*g`h\ni\u0007.txt', bytes: strToU8("x"), mime: "text/plain" },
        { name: "Chat Section (v2) — final.html", bytes: strToU8("y"), mime: "text/html" },
      ]),
      THREAD,
      dir,
    );
    expect(await tree(dir)).toEqual(["Chat Section (v2) — final.html", "a_b__c_d_e_f_g_h_i_.txt"]);
    expect(files.map((f) => f.name)).toEqual(['a<b>:c"d|e?f*g`h\ni\u0007.txt', "Chat Section (v2) — final.html"]);
  });
});
