import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRepo } from "../../src/chat/attachments.js";
import { NO_TRANSCRIPTION, TRANSCRIPTION, transcribeAttachment, transcribeAudio, transcriptionProvider } from "../../src/chat/transcribe.js";
import { type Config, ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";

const OPENAI_KEY = "sk-proj-openai-secret-0123456789";
const GEMINI_KEY = "AIzaSy-gemini-secret-0123456789";
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3]);
const M4A = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const AAC = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]);
const ARABIC = "مرحبا، أريد إصلاح صفحة تسجيل الدخول";

async function config(keys: { openai?: boolean; gemini?: boolean }): Promise<Config> {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-stt-")));
  const repo = new ConfigRepo(store, deriveKey("k"), 0);
  await repo.update((c) => {
    if (keys.openai) c.engines.codex.apiKey = OPENAI_KEY;
    if (keys.gemini) c.engines.gemini.apiKey = GEMINI_KEY;
  });
  return repo.load();
}

interface Seen {
  url: string;
  headers: Headers;
  body: unknown;
}

/** A fake fetch: each call answers with the next response; records what was sent (form fields or JSON). */
function fakeFetch(...answers: Array<(seen: Seen) => Response>) {
  const calls: Seen[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof FormData ? init.body : typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const seen = { url: String(input), headers: new Headers(init?.headers), body };
    calls.push(seen);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return answer ? answer(seen) : new Response("{}", { status: 500 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("transcribeAudio", () => {
  afterEach(() => void vi.restoreAllMocks());

  it("reports that no transcription is set up without any call", async () => {
    const fake = fakeFetch(json(200, { text: "x" }));
    const c = await config({});
    expect(transcriptionProvider(c)).toBeNull();
    expect(await transcribeAudio(c, WEBM, { fetch: fake.fetch })).toEqual({ ok: false, reason: "unavailable", error: NO_TRANSCRIPTION });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses bytes that are not audio, whatever they are called", async () => {
    const fake = fakeFetch(json(200, { text: "x" }));
    const r = await transcribeAudio(await config({ openai: true }), new TextEncoder().encode("<html>"), { fetch: fake.fetch });
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(fake.calls).toHaveLength(0);
  });

  it("transcribes with OpenAI first: the recommended model, the format named by the bytes, language detected", async () => {
    const fake = fakeFetch(json(200, { text: ` ${ARABIC} and the English part \n` }));
    const c = await config({ openai: true, gemini: true });
    expect(transcriptionProvider(c)).toBe("openai");
    const r = await transcribeAudio(c, WEBM, { fetch: fake.fetch });
    expect(r).toEqual({ ok: true, text: `${ARABIC} and the English part`, provider: "openai" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
    const form = call.body as FormData;
    expect(form.get("model")).toBe(TRANSCRIPTION.openaiModels[0]);
    // No language: the service detects Arabic, English or both.
    expect(form.get("language")).toBeNull();
    expect(form.get("languages[]")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-message.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WEBM);
  });

  it("names Safari's MP4 recording .m4a, and tries the next model when the first is not offered", async () => {
    const fake = fakeFetch(json(404, { error: { message: "The model `gpt-transcribe` does not exist", code: "model_not_found" } }), json(200, { text: "hello" }));
    const r = await transcribeAudio(await config({ openai: true }), M4A, { fetch: fake.fetch });
    expect(r).toEqual({ ok: true, text: "hello", provider: "openai" });
    expect(fake.calls.map((c) => (c.body as FormData).get("model"))).toEqual([...TRANSCRIPTION.openaiModels]);
    expect(((fake.calls[1]!.body as FormData).get("file") as File).name).toBe("voice-message.m4a");
  });

  it("transcribes with Gemini when only Gemini is connected: audio inline in generateContent", async () => {
    const fake = fakeFetch(json(200, { candidates: [{ content: { role: "model", parts: [{ text: `${ARABIC}\n` }] } }] }));
    const c = await config({ gemini: true });
    expect(transcriptionProvider(c)).toBe("gemini");
    const r = await transcribeAudio(c, WEBM, { fetch: fake.fetch });
    expect(r).toEqual({ ok: true, text: ARABIC, provider: "gemini" });
    const call = fake.calls[0]!;
    expect(call.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${TRANSCRIPTION.geminiModels[0]}:generateContent`);
    expect(call.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);
    expect(call.url).not.toContain(GEMINI_KEY);
    const parts = (call.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts[0]!.text).toMatch(/Arabic, English, or both/);
    expect(parts[1]).toEqual({ inlineData: { mimeType: "audio/webm", data: Buffer.from(WEBM).toString("base64") } });
  });

  it("falls back to Gemini when OpenAI fails, and to Gemini for raw AAC OpenAI cannot read", async () => {
    const failing = fakeFetch(json(429, { error: { message: "You exceeded your current quota" } }), json(200, { candidates: [{ content: { parts: [{ text: "from gemini" }] } }] }));
    const both = await config({ openai: true, gemini: true });
    expect(await transcribeAudio(both, WEBM, { fetch: failing.fetch })).toEqual({ ok: true, text: "from gemini", provider: "gemini" });
    expect(failing.calls.map((c) => new URL(c.url).hostname)).toEqual(["api.openai.com", "generativelanguage.googleapis.com"]);

    const aac = fakeFetch(json(200, { candidates: [{ content: { parts: [{ text: "aac" }] } }] }));
    expect(await transcribeAudio(both, AAC, { fetch: aac.fetch })).toMatchObject({ ok: true, provider: "gemini" });
    expect(aac.calls).toHaveLength(1);
    expect((aac.calls[0]!.body as { contents: { parts: { inlineData?: { mimeType: string } }[] }[] }).contents[0]!.parts[1]!.inlineData!.mimeType).toBe("audio/aac");
  });

  it("says why it failed, without the key, the audio or a transcript", async () => {
    const fake = fakeFetch(json(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}.` } }));
    const r = await transcribeAudio(await config({ openai: true }), WEBM, { fetch: fake.fetch });
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    if (r.ok) return;
    expect(r.error).toContain("OpenAI answered 401: Incorrect API key provided: [redacted].");
    expect(r.error).not.toContain(OPENAI_KEY);

    const down = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await transcribeAudio(await config({ gemini: true }), WEBM, { fetch: down.fetch })).toMatchObject({ ok: false, reason: "failed", error: expect.stringContaining("Gemini could not be reached.") });

    const blocked = fakeFetch(json(200, { promptFeedback: { blockReason: "OTHER" } }));
    expect(await transcribeAudio(await config({ gemini: true }), WEBM, { fetch: blocked.fetch })).toMatchObject({ ok: false, error: expect.stringContaining("Gemini declined the audio (OTHER)") });
  });

  it("refuses a recording too large for every connected service", async () => {
    const big = new Uint8Array(TRANSCRIPTION.geminiMaxBytes + 10);
    big.set(WEBM);
    const fake = fakeFetch(json(200, { text: "x" }));
    expect(await transcribeAudio(await config({ gemini: true }), big, { fetch: fake.fetch })).toMatchObject({ ok: false, reason: "too-large" });
    expect(fake.calls).toHaveLength(0);
  });

  it("never logs the audio or the transcript", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const fake = fakeFetch(json(500, { error: { message: "boom" } }), json(200, { candidates: [{ content: { parts: [{ text: ARABIC }] } }] }));
    await transcribeAudio(await config({ openai: true, gemini: true }), WEBM, { fetch: fake.fetch });
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});

describe("transcribeAttachment", () => {
  it("keeps the transcript on the stored file, and does not pay twice", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-stt-")));
    const repo = new AttachmentRepo(store, deriveKey("k"));
    const thread = { channel: "web", threadTs: "c-000000001-abcdef" };
    const added = await repo.add(thread, { name: "voice.webm", mime: "audio/webm", bytes: WEBM, source: "web" });
    if (!added.ok) throw new Error(added.error);
    const fake = fakeFetch(json(200, { text: ARABIC }));
    const c = await config({ openai: true });

    expect(await transcribeAttachment(repo, thread, added.info, c, { fetch: fake.fetch })).toEqual({ ok: true, text: ARABIC, provider: "openai" });
    const [info] = await repo.list(thread);
    expect(info).toMatchObject({ transcript: ARABIC, transcribedBy: "openai" });
    expect(await transcribeAttachment(repo, thread, info!, c, { fetch: fake.fetch })).toEqual({ ok: true, text: ARABIC, provider: "openai" });
    expect(fake.calls).toHaveLength(1);

    const png = await repo.add(thread, { name: "shot.png", mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), source: "web" });
    if (!png.ok) throw new Error(png.error);
    expect(await transcribeAttachment(repo, thread, png.info, c, { fetch: fake.fetch })).toMatchObject({ ok: false, reason: "unsupported" });
  });
});
