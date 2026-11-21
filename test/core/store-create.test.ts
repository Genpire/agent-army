import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../../src/core/store.js";

describe("Store.create (atomic create-if-absent)", () => {
  it("lets exactly one of many concurrent creates win, in one process", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-store-")));
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.create("claims/run-1.json", `owner-${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect((await store.get("claims/run-1.json"))?.toString()).toBe(`owner-${winner}`);
  });

  it("lets exactly one of two instances on the same folder win, and leaves no temp files", async () => {
    const folder = await mkdtemp(join(tmpdir(), "army-store-shared-"));
    const [a, b] = [new FsStore(folder), new FsStore(folder)];
    const results = await Promise.all([a.create("k.json", "a"), b.create("k.json", "b"), a.create("k.json", "a2"), b.create("k.json", "b2")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readdir(folder)).toEqual(["k.json"]);
    expect(["a", "b", "a2", "b2"]).toContain(await readFile(join(folder, "k.json"), "utf8"));
  });

  it("never overwrites an existing key, and put still replaces it", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-store-")));
    expect(await store.create("x.json", "first")).toBe(true);
    expect(await store.create("x.json", "second")).toBe(false);
    expect((await store.get("x.json"))?.toString()).toBe("first");
    await store.put("x.json", "third");
    expect((await store.get("x.json"))?.toString()).toBe("third");
  });
});
