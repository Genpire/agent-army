import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, AttachmentRepo, checkUpload, classify, expandZip, sniffAudioType, sniffImageType, toContentBlocks } from "../../src/chat/attachments.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";

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

// Recorder output starts: WebM (Chrome, Firefox), MP4 (Safari), Ogg, and raw AAC.
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1]);
const M4A = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const OGG = strToU8("OggS\0\x02rest");
const AAC = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]);
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0]);
const textOf = (blocks: ReturnType<typeof toContentBlocks>) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");

describe("attachments: audio and console uploads", () => {
  it("classifies audio by type or name, but not video", () => {
    expect(classify("voice.webm", "audio/webm")).toBe("audio");
    expect(classify("clip.m4a", "")).toBe("audio");
    expect(classify("note.ogg", "application/octet-stream")).toBe("audio");
    expect(classify("audio_message.mp4", "audio/mp4")).toBe("audio");
    expect(classify("screen.webm", "video/webm")).toBe("other");
    expect(classify("talk.mp3", "video/mpeg")).toBe("other");
  });

  it("sniffs audio containers from their bytes", () => {
    expect(sniffAudioType(WEBM)).toBe("audio/webm");
    expect(sniffAudioType(M4A)).toBe("audio/mp4");
    expect(sniffAudioType(OGG)).toBe("audio/ogg");
    expect(sniffAudioType(AAC)).toBe("audio/aac");
    expect(sniffAudioType(MP3)).toBe("audio/mpeg");
    expect(sniffAudioType(strToU8("ID3\x04rest"))).toBe("audio/mpeg");
    expect(sniffAudioType(strToU8("RIFF\0\0\0\0WAVEfmt "))).toBe("audio/wav");
    expect(sniffAudioType(PNG)).toBeNull();
    expect(sniffAudioType(strToU8("hello"))).toBeNull();
  });

  it("gives Pointer a voice message as its transcript, never as audio", () => {
    const blocks = toContentBlocks([
      { name: "voice.webm", mime: "audio/webm", bytes: WEBM, transcript: "مرحبا، please fix the login page" },
      { name: "silence.webm", mime: "audio/webm", bytes: WEBM, transcript: "" },
      { name: "clip.m4a", mime: "audio/mp4", bytes: M4A },
    ]);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    const text = textOf(blocks);
    expect(text).toContain("Voice message (transcript): مرحبا، please fix the login page\n(audio file: voice.webm)");
    expect(text).toContain("A voice message was attached (silence.webm); no speech could be heard in it.");
    expect(text).toContain("A voice message was attached (clip.m4a), but it could not be transcribed");
    expect(text).not.toContain(Buffer.from(WEBM).toString("base64"));
  });

  it("caps a long transcript within the prompt's text budget", () => {
    const long = "word ".repeat(20_000);
    const text = textOf(toContentBlocks([{ name: "long.webm", mime: "audio/webm", bytes: WEBM, transcript: long }]));
    expect(text.length).toBeLessThan(ATTACHMENT_LIMITS.maxTextCharsPerFile + 200);
    expect(text).toContain("…(truncated)");
  });

  it("checks console uploads by their bytes, not the browser's type", () => {
    expect(checkUpload("shot.png", "image/png", PNG)).toEqual({ ok: true, name: "shot.png", mime: "image/png" });
    // A PNG sent as anything is stored as a PNG.
    expect(checkUpload("pasted", "application/octet-stream", PNG)).toMatchObject({ ok: true, mime: "image/png" });
    expect(checkUpload("fake.png", "image/png", strToU8("<script>alert(1)</script>"))).toMatchObject({ ok: false, error: expect.stringContaining("not a PNG, JPEG, GIF or WebP") });
    expect(checkUpload("voice.webm", "audio/webm;codecs=opus", WEBM)).toEqual({ ok: true, name: "voice.webm", mime: "audio/webm" });
    expect(checkUpload("voice.mp4", "audio/mp4", M4A)).toMatchObject({ ok: true, mime: "audio/mp4" });
    expect(checkUpload("voice.webm", "audio/webm", strToU8("not audio"))).toMatchObject({ ok: false, error: expect.stringContaining("not audio") });
    expect(checkUpload("spec.pdf", "application/pdf", strToU8("%PDF-1.7\n"))).toMatchObject({ ok: true, mime: "application/pdf" });
    expect(checkUpload("spec.pdf", "application/pdf", strToU8("<html>"))).toMatchObject({ ok: false, error: "spec.pdf is named like a PDF, but it is not one." });
    expect(checkUpload("site.zip", "application/zip", strToU8("PK\x03\x04rest"))).toMatchObject({ ok: true, mime: "application/zip" });
    expect(checkUpload("site.zip", "application/zip", strToU8("nope"))).toMatchObject({ ok: false });
    // Text is stored as plain text, never as HTML or SVG a browser would run.
    expect(checkUpload("page.html", "text/html", strToU8("<h1>Hi</h1>"))).toMatchObject({ ok: true, mime: "text/plain" });
    expect(checkUpload("icon.svg", "image/svg+xml", strToU8("<svg/>"))).toMatchObject({ ok: true, mime: "text/plain" });
    expect(checkUpload("notes.txt", "text/plain", new Uint8Array([0x61, 0, 0x62]))).toMatchObject({ ok: false, error: expect.stringContaining("not UTF-8 text") });
    expect(checkUpload("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", strToU8("PK\x03\x04"))).toMatchObject({
      ok: true,
      mime: "application/octet-stream",
    });
  });

  it("checks upload names and sizes", () => {
    expect(checkUpload("../../etc/passwd.txt", "text/plain", strToU8("x"))).toMatchObject({ ok: true, name: "passwd.txt" });
    expect(checkUpload("C:\\Users\\me\\shot.png", "image/png", PNG)).toMatchObject({ ok: true, name: "shot.png" });
    expect(checkUpload("evil\u202Egnp.exe", "", strToU8("x"))).toMatchObject({ ok: true, name: "evilgnp.exe" });
    expect(checkUpload("   ", "text/plain", strToU8("x"))).toEqual({ ok: false, error: "The file has no name." });
    expect(checkUpload(`${"a".repeat(201)}.txt`, "text/plain", strToU8("x"))).toMatchObject({ ok: false, error: expect.stringContaining("200 characters") });
    expect(checkUpload("empty.txt", "text/plain", new Uint8Array())).toEqual({ ok: false, error: "empty.txt is empty." });
    expect(checkUpload("big.bin", "", new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1))).toMatchObject({ ok: false, error: expect.stringContaining("files are limited to 20.0 MB") });
  });

  it("keeps Arabic file names readable, saves transcripts, and erases files", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-att-")));
    const repo = new AttachmentRepo(store, deriveKey("k"));
    const thread = { channel: "web", threadTs: "c-000000001-abcdef" };
    const a = await repo.add(thread, { name: "تسجيل صوتي.webm", mime: "audio/webm", bytes: WEBM, source: "web", durationMs: 4200.4 });
    const b = await repo.add(thread, { name: "shot.png", mime: "image/png", bytes: PNG, source: "web" });
    if (!a.ok || !b.ok) throw new Error("not stored");
    expect(a.info).toMatchObject({ name: "تسجيل صوتي.webm", source: "web", durationMs: 4200 });

    const saved = await repo.setTranscript(thread, a.info.id, { text: "نعم", provider: "openai" });
    expect(saved).toMatchObject({ id: a.info.id, transcript: "نعم", transcribedBy: "openai" });
    expect((await repo.list(thread))[0]).toMatchObject({ transcript: "نعم" });
    expect(await repo.setTranscript(thread, "a-00000000", { text: "x", provider: "openai" })).toBeNull();
    // The transcript sits in the encrypted index only.
    expect((await store.get("attachments/web-c-000000001-abcdef/index.enc"))!.toString("utf8")).not.toContain("نعم");

    expect(await repo.remove(thread, a.info.id)).toBe(true);
    expect(await repo.remove(thread, a.info.id)).toBe(false);
    expect(await repo.get(thread, a.info.id)).toBeNull();
    expect((await repo.list(thread)).map((f) => f.id)).toEqual([b.info.id]);
    expect(await repo.removeAll(thread)).toBe(1);
    expect(await repo.list(thread)).toEqual([]);
    expect(await repo.get(thread, b.info.id)).toBeNull();
  });
});
