import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRepo, toContentBlocks } from "../../src/chat/attachments.js";
import { MemoryRepo } from "../../src/chat/memory.js";
import type { PointerRequest, SlackDeps, SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { handleSlackEvent, resetDispatchStateForTests } from "../../src/slack/dispatch.js";
import { TaskRepo } from "../../src/tasks/tasks.js";

const BOT_TOKEN = "xoxb-secret-token";
const OPENAI_KEY = "sk-proj-openai-secret-0123456789";
const CLIP = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 1, 2, 3]);
const SAID = "Can you check why the checkout fails? شكرا";
const url = (id: string) => `https://files.slack.com/files-pri/T1-${id}/download/audio_message.m4a`;
/** A Slack voice clip as events deliver it. */
const clip = (id: string) => ({ id, name: "audio_message.m4a", title: "Audio clip", mimetype: "audio/mp4", filetype: "m4a", subtype: "slack_audio", url_private_download: url(id) });

async function setup(withOpenAi: boolean) {
  resetDispatchStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-voice-slack-")));
  const key = deriveKey("k");
  const configRepo = new ConfigRepo(store, key, 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = { botToken: BOT_TOKEN, signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    if (withOpenAi) c.engines.codex.apiKey = OPENAI_KEY;
  });
  const attachments = new AttachmentRepo(store, key);
  const requests: PointerRequest[] = [];
  const posts: string[] = [];
  const slack = {
    chat: { postMessage: async (m: { text: string }) => void posts.push(m.text) },
    reactions: { add: async () => undefined, remove: async () => undefined },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { profile: { display_name: "Sam" } } }) },
    files: { info: async () => ({ ok: true }) },
  };
  const deps: SlackDeps = {
    configRepo,
    tasks: new TaskRepo(store),
    memory: new MemoryRepo(store, key),
    attachments,
    runner: { kind: "local", launch: async () => undefined },
    brain: {
      reply: async (req) => {
        requests.push(req);
        return { text: "On it.", isError: false };
      },
    },
    slack: () => slack as never,
  };
  const transcriptions: { auth: string | null; file: File }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target.startsWith("https://files.slack.com/")) return new Response(CLIP, { status: 200, headers: { "content-type": "audio/mp4" } });
    if (target === "https://api.openai.com/v1/audio/transcriptions") {
      transcriptions.push({ auth: new Headers(init?.headers).get("authorization"), file: (init?.body as FormData).get("file") as File });
      return new Response(JSON.stringify({ text: SAID }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  const dm = (ts: string, extra: Partial<SlackMessageEvent>) =>
    handleSlackEvent({ type: "message", subtype: "file_share", user: "U1", channel: "D1", channel_type: "im", ts, text: "", ...extra } as SlackMessageEvent, deps);
  return { attachments, requests, posts, transcriptions, dm };
}

describe("Slack voice clips", () => {
  afterEach(() => void vi.unstubAllGlobals());

  it("transcribes a voice clip shared with Pointer, which reads what was said", async () => {
    const t = await setup(true);
    await t.dm("500.1", { files: [clip("F9")] as never });
    expect(t.transcriptions).toHaveLength(1);
    expect(t.transcriptions[0]!.auth).toBe(`Bearer ${OPENAI_KEY}`);
    expect(t.transcriptions[0]!.file.name).toBe("voice-message.m4a");

    const req = t.requests[0]!;
    expect(req.text).toBe("(shared a file without a message: audio_message.m4a)");
    expect(req.attachments).toMatchObject([{ name: "audio_message.m4a", mime: "audio/mp4", source: "slack", sourceId: "F9", transcript: SAID, transcribedBy: "openai" }]);
    // What the brain builds from it: the transcript as text, not the sound.
    const blocks = toContentBlocks(req.attachments!.map((f) => ({ name: f.name, mime: f.mime, bytes: new Uint8Array(), transcript: f.transcript })));
    expect(blocks).toEqual([{ type: "text", text: `Voice message (transcript): ${SAID}\n(audio file: audio_message.m4a)` }]);
    expect(t.posts).toEqual(["On it."]);
  });

  it("answers anyway without a transcription service, and tells Pointer why", async () => {
    const t = await setup(false);
    await t.dm("600.1", { text: "listen to this", files: [clip("F8")] as never });
    expect(t.transcriptions).toHaveLength(0);
    const req = t.requests[0]!;
    expect(req.text).toMatch(/^listen to this\n\n\[Pointer could not read these attachments: audio_message\.m4a \(voice message not transcribed: No transcription is set up/);
    expect(req.attachments![0]!.transcript).toBeUndefined();
  });
});
