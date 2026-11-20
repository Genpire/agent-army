import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, AttachmentRepo, classify, expandZip, sniffImageType, toContentBlocks } from "../src/attachments.js";
import { deriveKey } from "../src/core/crypto.js";
import { FsStore } from "../src/core/store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("attachments", () => {
  it("classifies files", () => {
    expect(classify("Acme Chat Section.html", "text/html")).toBe("text");
    expect(classify("image.png", "image/png")).toBe("image");
    expect(classify("Mobile-html.zip", "application/zip")).toBe("zip");
    expect(classify("spec.pdf", "application/pdf")).toBe("pdf");
    expect(classify("hero.tsx", "")).toBe("text");
    expect(classify("video.mov", "video/quicktime")).toBe("other");
  });

  it("stores per thread, encrypted, deduped by source id", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-att-")));
    const repo = new AttachmentRepo(store, deriveKey("k"));
    const thread = { channel: "C1", threadTs: "100.1" };
    const a = await repo.add(thread, { name: "design.html", mime: "text/html", bytes: strToU8("<h1>Hi</h1>"), source: "slack", sourceId: "F1" });
    expect(a.ok).toBe(true);
    const again = await repo.add(thread, { name: "design.html", mime: "text/html", bytes: strToU8("<h1>Hi</h1>"), source: "slack", sourceId: "F1" });
    expect(again.ok && a.ok && again.info.id).toBe(a.ok && a.info.id);
    expect(await repo.list(thread)).toHaveLength(1);
    expect(await repo.list({ channel: "C1", threadTs: "200.1" })).toEqual([]);
    const id = a.ok ? a.info.id : "";
    expect((await repo.get(thread, id))!.toString("utf8")).toBe("<h1>Hi</h1>");
    expect(await repo.get(thread, "../x")).toBeNull();
    const raw = (await store.list("attachments/C1-100_1/")).join(",");
    expect(raw).toContain("index.enc");
    expect((await store.get(`attachments/C1-100_1/${id}.enc`))!.toString("utf8")).not.toContain("Hi");
    const big = await repo.add(thread, { name: "big.bin", mime: "", bytes: new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1), source: "slack" });
    expect(big.ok).toBe(false);
  });

  it("expands zips and skips metadata", () => {
    const zip = zipSync({ "mobile/index.html": strToU8("<p>m</p>"), "__MACOSX/._x": strToU8("junk"), "mobile/": new Uint8Array() });
    expect(expandZip(zip).map((f) => f.name)).toEqual(["mobile/index.html"]);
  });

  it("builds content blocks: text, image, zip contents, and a skipped list", () => {
    const zip = zipSync({ "m.html": strToU8("<p>mobile</p>"), "shot.png": PNG });
    const blocks = toContentBlocks([
      { name: "Chat Section.html", mime: "text/html", bytes: strToU8("<section>chat</section>") },
      { name: "image.png", mime: "image/png", bytes: PNG },
      { name: "Mobile-html.zip", mime: "application/zip", bytes: zip },
      { name: "clip.mov", mime: "video/quicktime", bytes: new Uint8Array(10) },
    ]);
    const types = blocks.map((b) => b.type);
    expect(types.filter((t) => t === "image")).toHaveLength(2);
    const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    expect(text).toContain("File: Chat Section.html");
    expect(text).toContain("<section>chat</section>");
    expect(text).toContain("Mobile-html.zip › m.html");
    expect(text).toContain("Not included:");
    expect(text).toContain("clip.mov");
  });

  it("caps total image and PDF bytes per prompt", () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(PNG.slice(0, 8));
    const files = Array.from({ length: 6 }, (_, i) => ({ name: `shot${i}.png`, mime: "image/png", bytes: big }));
    const blocks = toContentBlocks(files);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(4);
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(text).toContain("shot5.png");
  });

  it("trusts an image's bytes, not its name", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBeNull();
    const jpegNamedPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const blocks = toContentBlocks([
      { name: "shot.png", mime: "image/png", bytes: jpegNamedPng },
      { name: "fake.png", mime: "image/png", bytes: strToU8("not an image") },
    ]);
    const image = blocks.find((b) => b.type === "image") as { source: { media_type: string } };
    expect(image.source.media_type).toBe("image/jpeg");
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(text).toContain("fake.png (named like an image");
  });
});
