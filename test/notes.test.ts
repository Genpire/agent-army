import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveKey } from "../src/crypto.js";
import { NOTES_MAX_CHARS, NotesRepo } from "../src/notes.js";
import { FsStore } from "../src/store.js";

const setup = async () => {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-notes-")));
  return { store, notes: new NotesRepo(store, deriveKey("k")) };
};

describe("project notes", () => {
  it("stores notes per repo, encrypted, case-insensitive", async () => {
    const { store, notes } = await setup();
    expect(await notes.get("Acme/web")).toBeNull();
    expect(await notes.put("Acme/web", "  Tests: npm test (needs Node 22)  ")).toEqual({ ok: true });
    expect(await notes.get("acme/WEB")).toMatchObject({ repo: "Acme/web", text: "Tests: npm test (needs Node 22)" });
    const raw = (await store.get("notes/acme__web.enc"))!.toString("utf8");
    expect(raw).not.toContain("npm test");
  });

  it("appends bullets and lists repos newest first", async () => {
    const { notes } = await setup();
    await notes.append("acme/api", "uses pnpm");
    await notes.append("acme/api", "  migrations live in   db/  ");
    expect((await notes.get("acme/api"))!.text).toBe("- uses pnpm\n- migrations live in db/");
    await new Promise((r) => setTimeout(r, 5));
    await notes.put("acme/web", "Next.js app");
    const listed = await notes.list();
    expect(listed.map((n) => n.repo)).toEqual(["acme/web", "acme/api"]);
    expect(listed[1]!.chars).toBe("- uses pnpm\n- migrations live in db/".length);
  });

  it("does not lose concurrent appends", async () => {
    const { notes } = await setup();
    await Promise.all(Array.from({ length: 8 }, (_, i) => notes.append("acme/api", `note ${i}`)));
    expect((await notes.get("acme/api"))!.text.split("\n")).toHaveLength(8);
  });

  it("deletes with empty text and rejects bad input", async () => {
    const { notes } = await setup();
    await notes.put("acme/api", "something");
    expect(await notes.put("acme/api", "   ")).toEqual({ ok: true });
    expect(await notes.get("acme/api")).toBeNull();
    expect(await notes.list()).toEqual([]);
    expect((await notes.put("not a repo", "x")).ok).toBe(false);
    expect((await notes.put("acme/api", "x".repeat(NOTES_MAX_CHARS + 1))).ok).toBe(false);
    expect((await notes.append("acme/api", "  ")).ok).toBe(false);
    expect(await notes.get("not a repo")).toBeNull();
  });
});
