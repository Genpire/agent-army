import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AttachmentRepo } from "../../src/chat/attachments.js";
import { type Conversation, ConversationService, MAX_FILES_PER_MESSAGE } from "../../src/chat/conversations.js";
import { MemoryRepo } from "../../src/chat/memory.js";
import { type QueryFn, createPointerBrain } from "../../src/chat/pointer.js";
import type { PointerBrain, PointerContext, PointerReply, PointerRequest } from "../../src/chat/pointer-types.js";
import { ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { byteRange } from "../../src/routes/chat.js";
import { createApp } from "../../src/server.js";
import { TaskRepo } from "../../src/tasks/tasks.js";
import { materializeAttachments } from "../../src/tasks/worker.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3, 4, 5, 6, 7, 8]);
const ARABIC = "أضف زر الوضع الداكن إلى acme/web please";
const OPENAI_KEY = "sk-proj-openai-secret-0123456789";

const openAiAnswer = (text: string) =>
  vi.fn(async () => new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/** A conversation service on a real attachment store and Pointer's real brain, with a fake Agent SDK query. */
async function setup() {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-files-")));
  const key = deriveKey("k");
  const configRepo = new ConfigRepo(store, key, 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key-0123456789";
    c.github = { ...c.github, token: "ghp_secret_token_0123456789", allowedOwners: ["acme"] };
    c.engines.codex.apiKey = OPENAI_KEY;
  });
  const tasks = new TaskRepo(store);
  const attachments = new AttachmentRepo(store, key);
  const prompts: { content: { type: string; text?: string; source?: { media_type: string; data: string } }[]; options: Options }[] = [];
  let onPrompt: ((ctx: PointerContext) => Promise<void>) | undefined;
  const queryFn: QueryFn = async function* (params) {
    const content = [];
    if (typeof params.prompt === "string") content.push({ type: "text", text: params.prompt });
    else for await (const m of params.prompt as AsyncIterable<SDKUserMessage>) content.push(...(m.message.content as never[]));
    prompts.push({ content, options: params.options ?? {} });
    yield { type: "result", subtype: "success", is_error: false, result: "Got it.", total_cost_usd: 0.01, num_turns: 1, errors: [] } as unknown as SDKMessage;
  };
  const real = createPointerBrain({ configRepo, memory: new MemoryRepo(store, key), attachments }, { queryFn });
  const contexts: PointerContext[] = [];
  const requests: PointerRequest[] = [];
  const brain: PointerBrain = {
    reply: async (req, ctx) => {
      requests.push(req);
      contexts.push(ctx);
      await onPrompt?.(ctx);
      return real.reply(req, ctx);
    },
  };
  const launched: string[] = [];
  const runner = { kind: "local" as const, launch: async (id: string) => void launched.push(id) };
  const service = new ConversationService({ store, configRepo, tasks, runner, brain, attachments });
  return {
    store,
    tasks,
    attachments,
    service,
    prompts,
    requests,
    contexts,
    launched,
    whenAsked: (fn: (ctx: PointerContext) => Promise<void>) => {
      onPrompt = fn;
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function upload(t: Setup, id: string, name: string, type: string, bytes: Uint8Array, durationMs?: number) {
  const r = await t.service.upload(id, { name, type, bytes, ...(durationMs !== undefined ? { durationMs } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r;
}

const thread = (id: string) => ({ channel: "web", threadTs: id });

describe("console files and voice messages: the service", () => {
  it("starts a conversation with files: uploads to a draft, then Pointer reads them like Slack files", async () => {
    const t = await setup();
    const shot = await upload(t, "new", "shot.png", "image/png", PNG);
    const draft = shot.conversationId;
    expect(draft).toMatch(/^c-[0-9a-z]{9}-[0-9a-f]{6}$/);
    expect(shot.info).toMatchObject({ name: "shot.png", mime: "image/png", source: "web" });
    const voice = await upload(t, draft, "voice-message.webm", "audio/webm;codecs=opus", WEBM, 4200);
    expect(voice.conversationId).toBe(draft);
    expect(voice.info).toMatchObject({ mime: "audio/webm", durationMs: 4200 });
    expect(await t.service.transcribe(draft, voice.info.id, { fetch: openAiAnswer(ARABIC) })).toEqual({ ok: true, text: ARABIC, provider: "openai" });

    const r = await t.service.create(`${ARABIC} (edited)`, { attachmentIds: [shot.info.id, voice.info.id], draftId: draft });
    if (!r.ok) throw new Error(r.error);
    expect(r.conversation.id).toBe(draft);
    expect(r.conversation.messages[0]!.files).toEqual([
      { id: shot.info.id, name: "shot.png", mime: "image/png", size: PNG.byteLength },
      { id: voice.info.id, name: "voice-message.webm", mime: "audio/webm", size: WEBM.byteLength, durationMs: 4200 },
    ]);
    await t.service.idle();

    // The request carries the files as Slack's does; Pointer can attach more (Jira, monday.com) to this conversation.
    expect(t.requests[0]!.attachments!.map((f) => f.id)).toEqual([shot.info.id, voice.info.id]);
    expect(t.contexts[0]!.addAttachment).toBeTypeOf("function");
    // The brain's user turn: the message, then the image as an image and the voice message as its transcript.
    const { content, options } = t.prompts[0]!;
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`${ARABIC} (edited)`) });
    const image = content.find((b) => b.type === "image");
    expect(image!.source).toMatchObject({ media_type: "image/png", data: PNG.toString("base64") });
    const texts = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(texts).toContain(`Voice message (transcript): ${ARABIC}`);
    expect(JSON.stringify(content)).not.toContain(Buffer.from(WEBM).toString("base64"));
    expect(options.systemPrompt as string).toContain("- voice-message.webm (audio/webm, 1 KB)");
  });

  it("says a voice message could not be transcribed when no transcript was made", async () => {
    const t = await setup();
    const voice = await upload(t, "new", "voice-message.webm", "audio/webm", WEBM);
    const r = await t.service.create("", { attachmentIds: [voice.info.id], draftId: voice.conversationId });
    if (!r.ok) throw new Error(r.error);
    expect(r.conversation.title).toBe("Voice message");
    await t.service.idle();
    expect(t.requests[0]!.text).toBe("(sent a voice message without text: voice-message.webm (voice message))");
    const texts = t.prompts[0]!.content.map((b) => b.text ?? "").join("\n");
    expect(texts).toContain("A voice message was attached (voice-message.webm), but it could not be transcribed");
  });

  it("refuses files of another conversation, files already sent, and drafts it never handed out", async () => {
    const t = await setup();
    const a = await upload(t, "new", "a.txt", "text/plain", new TextEncoder().encode("A"));
    const first = await t.service.create("first", { attachmentIds: [a.info.id], draftId: a.conversationId });
    if (!first.ok) throw new Error(first.error);
    await t.service.idle();
    const other = await t.service.create("other conversation");
    if (!other.ok) throw new Error(other.error);
    await t.service.idle();

    expect(await t.service.send(other.conversation.id, "steal", { attachmentIds: [a.info.id] })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("no longer here") });
    expect(await t.service.send(first.conversation.id, "again", { attachmentIds: [a.info.id] })).toMatchObject({ ok: false, status: 400, error: "a.txt was already sent." });
    expect(await t.service.file(other.conversation.id, a.info.id)).toBeNull();
    expect(await t.service.transcribe(other.conversation.id, a.info.id)).toMatchObject({ ok: false, reason: "not-found" });
    expect(await t.service.create("hi", { attachmentIds: [a.info.id], draftId: "c-000000000-000000" })).toMatchObject({ ok: false, status: 400 });
    expect(await t.service.create("hi", { attachmentIds: [a.info.id] })).toMatchObject({ ok: false, status: 400 });
    expect(await t.service.upload("c-000000000-000000", { name: "x.txt", type: "text/plain", bytes: new TextEncoder().encode("x") })).toMatchObject({ ok: false, status: 404 });
    // A file sent stays with its message.
    expect(await t.service.removeUpload(first.conversation.id, a.info.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("caps the files waiting for one message, keeps unsent uploads from Pointer, and removes them on request", async () => {
    const t = await setup();
    const c = await t.service.create("hello");
    if (!c.ok) throw new Error(c.error);
    await t.service.idle();
    const id = c.conversation.id;
    const ids: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_MESSAGE; i++) ids.push((await upload(t, id, `n${i}.txt`, "text/plain", new TextEncoder().encode(`${i}`))).info.id);
    expect(await t.service.upload(id, { name: "one-more.txt", type: "text/plain", bytes: new TextEncoder().encode("x") })).toMatchObject({
      ok: false,
      status: 409,
      error: `A message can carry ${MAX_FILES_PER_MESSAGE} files. Send these first, or remove some.`,
    });
    expect(await t.service.removeUpload(id, ids[9]!)).toEqual({ ok: true });
    expect(await t.service.file(id, ids[9]!)).toBeNull();

    const sent = await t.service.send(id, "two of them", { attachmentIds: ids.slice(0, 2) });
    if (!sent.ok) throw new Error(sent.error);
    await t.service.idle();
    // Pointer reads what was sent, never what still waits in the composer.
    expect(t.requests.at(-1)!.attachments!.map((f) => f.id)).toEqual(ids.slice(0, 2));
    expect(t.requests.at(-1)!.history.at(-2)).toMatchObject({ text: "hello" });

    const next = await t.service.send(id, "and more", { attachmentIds: [ids[2]!] });
    if (!next.ok) throw new Error(next.error);
    await t.service.idle();
    expect(t.requests.at(-1)!.history.find((m) => m.text.startsWith("two of them"))!.text).toBe("two of them\n[Attached: n0.txt, n1.txt]");
  });

  it("refuses uploads whose bytes do not match, with the reason", async () => {
    const t = await setup();
    expect(await t.service.upload("new", { name: "photo.png", type: "image/png", bytes: new TextEncoder().encode("<svg onload=alert(1)>") })).toMatchObject({
      ok: false,
      status: 415,
      error: "photo.png is named like an image, but it is not a PNG, JPEG, GIF or WebP file.",
    });
    expect(await t.service.upload("new", { name: "voice.webm", type: "audio/webm", bytes: new TextEncoder().encode("hello") })).toMatchObject({ ok: false, status: 415 });
    expect(await t.service.upload("new", { name: "empty.txt", type: "text/plain", bytes: new Uint8Array() })).toMatchObject({ ok: false, status: 400 });
  });

  it("gives repo tasks started from the conversation its files, and erases them with the conversation", async () => {
    const t = await setup();
    const shot = await upload(t, "new", "design.png", "image/png", PNG);
    let started: { ok: boolean; taskId?: string } | undefined;
    t.whenAsked(async (ctx) => {
      started = await ctx.startRepoTask({ repo: "acme/web", instruction: "Build the page in design.png" });
    });
    const c = await t.service.create("build this", { attachmentIds: [shot.info.id], draftId: shot.conversationId });
    if (!c.ok) throw new Error(c.error);
    await t.service.idle();
    expect(started).toMatchObject({ ok: true });
    const task = (await t.tasks.get(started!.taskId!))!;
    expect(task).toMatchObject({ channel: "web", threadTs: c.conversation.id });
    const files = await materializeAttachments(t.attachments, { channel: task.channel, threadTs: task.threadTs }, await mkdtemp(join(tmpdir(), "army-task-")));
    expect(files.map((f) => f.name)).toEqual(["design.png"]);

    expect(await t.service.remove(c.conversation.id)).toBe(true);
    expect(await t.attachments.list(thread(c.conversation.id))).toEqual([]);
  });
});

/** End-to-end through the HTTP API with a fake brain. */
describe("console files and voice messages: the HTTP API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  let conversations: ConversationService;
  const calls: PointerRequest[] = [];
  const brain: PointerBrain = {
    reply: async (req): Promise<PointerReply> => {
      calls.push(req);
      return { text: "ok", isError: false };
    },
  };
  const realFetch = globalThis.fetch;

  const send = (method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) =>
    realFetch(base + path, {
      method,
      headers: { ...(body === undefined || body instanceof Uint8Array ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
  const put = (id: string, name: string, type: string, bytes: Uint8Array, extra = "") =>
    send("POST", `/api/conversations/${id}/attachments?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}${extra}`, bytes, {
      "content-type": "application/octet-stream",
    });

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-files-web-"));
    const runner = { kind: "local" as const, launch: async () => undefined };
    const made = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-files", RUNNER: "local" }, { brain, runner });
    conversations = made.conversations;
    const server = made.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const setup = await send("POST", "/api/setup", { setupToken: "setup-files", password: "longpassword1" });
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    expect((await send("POST", "/api/anthropic", { apiKey: "sk-ant-0123456789abcd" })).status).toBe(200);
  });
  afterAll(() => close());
  afterEach(() => void vi.unstubAllGlobals());

  it("requires a session on every files route", async () => {
    const saved = cookie;
    cookie = "";
    try {
      const routes: [string, string, unknown?][] = [
        ["GET", "/api/chat/options"],
        ["POST", "/api/conversations/new/attachments?name=a.txt", new Uint8Array([97])],
        ["GET", "/api/conversations/c-000000000-000000/attachments/a-00000000"],
        ["POST", "/api/conversations/c-000000000-000000/attachments/a-00000000/delete", {}],
        ["POST", "/api/conversations/c-000000000-000000/transcribe", { attachmentId: "a-00000000" }],
      ];
      for (const [method, path, body] of routes) expect((await send(method as "GET" | "POST", path, body)).status, `${method} ${path}`).toBe(401);
    } finally {
      cookie = saved;
    }
  });

  it("tells the console its limits and whether voice messages are transcribed", async () => {
    const res = await send("GET", "/api/chat/options");
    expect(await res.json()).toEqual({
      transcription: null,
      limits: { maxFileBytes: 20 * 1024 * 1024, maxFilesPerMessage: 10, maxFilesPerConversation: 40, maxRecordingMs: 600_000 },
    });
  });

  it("uploads to a new conversation, sends the files with the first message, and Pointer gets them", async () => {
    const up = await put("new", "screen shot.png", "image/png", PNG);
    expect(up.status).toBe(201);
    const { conversationId, attachments } = (await up.json()) as { conversationId: string; attachments: { id: string; name: string; mime: string }[] };
    expect(attachments).toMatchObject([{ name: "screen shot.png", mime: "image/png", size: PNG.byteLength, source: "web" }]);
    const created = await send("POST", "/api/conversations", { text: "", attachmentIds: [attachments[0]!.id], conversationId });
    expect(created.status).toBe(202);
    const { conversation } = (await created.json()) as { conversation: Conversation };
    expect(conversation).toMatchObject({ id: conversationId, title: "screen shot.png" });
    await conversations.idle();
    const req = calls.at(-1)!;
    expect(req.text).toBe("(shared a file without a message: screen shot.png)");
    expect(req.attachments).toMatchObject([{ id: attachments[0]!.id, name: "screen shot.png" }]);
  });

  it("validates uploads: size, type by the bytes, JSON bodies, names and counts", async () => {
    const big = await put("new", "big.bin", "", new Uint8Array(20 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "Files are limited to 20 MB." });
    const fake = await put("new", "photo.jpg", "image/jpeg", new TextEncoder().encode("<svg onload=alert(1)>"));
    expect(fake.status).toBe(415);
    expect(((await fake.json()) as { error: string }).error).toBe("photo.jpg is named like an image, but it is not a PNG, JPEG, GIF or WebP file.");
    const asJson = await send("POST", "/api/conversations/new/attachments?name=a.json", { a: 1 });
    expect(asJson.status).toBe(415);
    expect((await put("new", "", "text/plain", new TextEncoder().encode("x"))).status).toBe(400);
    expect((await put("nope", "a.txt", "text/plain", new TextEncoder().encode("x"))).status).toBe(404);
    expect((await put("c-000000000-000000", "a.txt", "text/plain", new TextEncoder().encode("x"))).status).toBe(404);
    expect((await send("POST", "/api/conversations", { text: "", attachmentIds: ["../../x"] })).status).toBe(400);
    expect((await send("POST", "/api/conversations", { text: "", attachmentIds: Array.from({ length: 11 }, (_, i) => `a-0000000${i % 10}`) })).status).toBe(400);
    expect((await send("POST", "/api/conversations", { text: "" })).status).toBe(400);
  });

  it("serves only the conversation's own files, with safe headers", async () => {
    const up = await put("new", "تصميم.png", "image/png", PNG);
    const { conversationId, attachments } = (await up.json()) as { conversationId: string; attachments: { id: string }[] };
    const page = await put(conversationId, "page.html", "text/html", new TextEncoder().encode("<script>alert(1)</script>"));
    const voice = await put(conversationId, "voice.webm", "audio/webm", WEBM, "&durationMs=3100");
    const pageId = ((await page.json()) as { attachments: { id: string }[] }).attachments[0]!.id;
    const voiceInfo = ((await voice.json()) as { attachments: { id: string; durationMs: number }[] }).attachments[0]!;
    expect(voiceInfo.durationMs).toBe(3100);

    const image = await send("GET", `/api/conversations/${conversationId}/attachments/${attachments[0]!.id}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe(`inline; filename="_.png"; filename*=UTF-8''${encodeURIComponent("تصميم.png")}`);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    const html = await send("GET", `/api/conversations/${conversationId}/attachments/${pageId}`);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toBe(`attachment; filename="page.html"; filename*=UTF-8''page.html`);
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const audio = await send("GET", `/api/conversations/${conversationId}/attachments/${voiceInfo.id}`);
    expect(audio.headers.get("content-type")).toBe("audio/webm");
    expect(audio.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(audio.headers.get("accept-ranges")).toBe("bytes");
    const part = await send("GET", `/api/conversations/${conversationId}/attachments/${voiceInfo.id}`, undefined, { range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${WEBM.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(WEBM.subarray(2, 6));

    // Another conversation cannot read it, and ids are checked before anything is read.
    const other = await send("POST", "/api/conversations", { text: "other" });
    const otherId = ((await other.json()) as { conversation: Conversation }).conversation.id;
    await conversations.idle();
    expect((await send("GET", `/api/conversations/${otherId}/attachments/${attachments[0]!.id}`)).status).toBe(404);
    expect((await send("GET", `/api/conversations/${conversationId}/attachments/..%2Findex`)).status).toBe(404);

    // Removing a file that waits in the composer.
    expect((await send("POST", `/api/conversations/${conversationId}/attachments/${pageId}/delete`)).status).toBe(200);
    expect((await send("GET", `/api/conversations/${conversationId}/attachments/${pageId}`)).status).toBe(404);
  });

  it("transcribes a voice message with the connected service, or says none is set up", async () => {
    const up = await put("new", "voice.webm", "audio/webm", WEBM);
    const { conversationId, attachments } = (await up.json()) as { conversationId: string; attachments: { id: string }[] };
    const path = `/api/conversations/${conversationId}/transcribe`;
    const none = await send("POST", path, { attachmentId: attachments[0]!.id });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ reason: "unavailable", error: expect.stringContaining("No transcription is set up") });
    expect((await send("POST", path, { attachmentId: "nope" })).status).toBe(400);

    expect((await send("POST", "/api/engines/codex", { apiKey: OPENAI_KEY })).status).toBe(200);
    expect(((await (await send("GET", "/api/chat/options")).json()) as { transcription: string }).transcription).toBe("openai");
    // OpenAI is faked; the test's own requests to the server go through.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://api.openai.com/")
        ? Promise.resolve(new Response(JSON.stringify({ text: ARABIC }), { status: 200, headers: { "content-type": "application/json" } }))
        : realFetch(input, init),
    );
    const done = await send("POST", path, { attachmentId: attachments[0]!.id });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ text: ARABIC, provider: "openai" });
  });
});

describe("byte ranges", () => {
  it("parses single ranges and refuses unsatisfiable ones", () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=4-100", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=10-", 10)).toBe("bad");
    expect(byteRange("bytes=5-2", 10)).toBe("bad");
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
  });
});
