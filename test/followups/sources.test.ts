import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { type Config, ConfigSchema, type Routine } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { FollowupStore } from "../../src/followups/store.js";
import { SlackInbox } from "../../src/slack/inbox.js";
import {
  ATTENTION_REPORT_INSTRUCTION,
  ATTENTION_REPORT_NAME,
  LEGACY_ATTENTION_REPORT_INSTRUCTION,
  LEGACY_ATTENTION_REPORT_NAME,
  findAttentionReport,
  inboxReport,
  migrateAttentionReports,
} from "../../src/slack/inbox-tools.js";
import { MemoryStore, configured, tmpStore } from "../routines/helpers.js";

const OWNER = "UOWN";
const NOW = new Date("2026-11-23T12:00:00Z");
const BASE = Math.floor(NOW.getTime() / 1000);
const ago = (sec: number) => `${BASE - sec}.000100`;

function config(): Config {
  return ConfigSchema.parse({
    slack: {
      botToken: "xoxb-bot-token-secret",
      signingSecret: "s".repeat(20),
      botUserId: "UBOT",
      user: { token: "xoxp-owner-token-secret", userId: OWNER, userName: "dana", connectedAt: "2026-11-01T00:00:00Z" },
    },
  });
}

async function inboxEnv() {
  const inbox = new SlackInbox(new FsStore(await mkdtemp(join(tmpdir(), "army-followups-inbox-"))), deriveKey("k"), { now: () => NOW, batchMs: 0 });
  const conversations: Record<string, Record<string, unknown>> = { D2: { is_im: true, user: "U2" }, C1: { is_member: true, name: "ops" } };
  const client = {
    conversations: { info: async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, ...conversations[channel] } }) },
    users: { info: async ({ user }: { user: string }) => ({ user: { profile: { display_name: user === "U2" ? "Sam Lee" : user } } }) },
  };
  const ctx = { config: config(), client: () => client as never, redact: (t: string) => t };
  const send = (e: Partial<SlackMessageEvent>) => inbox.capture({ type: "message", user: "U2", ...e } as SlackMessageEvent, ctx);
  const followups = new FollowupStore(new MemoryStore(), deriveKey("k"), { now: () => NOW, batchMs: 0 });
  const heard: [string[], string][] = [];
  inbox.onAnswered((refs, at) => {
    heard.push([refs, at]);
    void followups.answered(refs, at);
  });
  return { inbox, send, followups, heard };
}

describe("the owner's Slack answers and their follow-ups", () => {
  it("marks the follow-ups about what the owner answered as replied, and keeps them open", async () => {
    const t = await inboxEnv();
    const dmTs = ago(600);
    const mentionTs = ago(500);
    await t.send({ channel: "D2", channel_type: "im", ts: dmTs, text: "can you approve the budget?" });
    await t.send({ channel: "C1", channel_type: "channel", ts: mentionTs, text: `<@${OWNER}> please review` });
    await t.followups.add({ title: "Approve Sam's budget", source: "slack", ref: `slack:D2:${dmTs}` });
    await t.followups.add({ title: "Review in #ops", source: "slack", ref: `slack:C1:${mentionTs}` });

    // The owner answers the DM at its top level.
    await t.send({ channel: "D2", channel_type: "im", user: OWNER, ts: ago(300), text: "approved" });
    expect(t.heard).toEqual([[[`slack:D2:${dmTs}`], new Date((BASE - 300) * 1000).toISOString()]]);
    // A post of theirs elsewhere in the channel answers nothing there.
    await t.send({ channel: "C1", channel_type: "channel", user: OWNER, ts: ago(250), text: "unrelated" });
    expect(t.heard).toHaveLength(1);
    // Their reply in the mention's thread does.
    await t.send({ channel: "C1", channel_type: "channel", user: OWNER, ts: ago(200), thread_ts: mentionTs, text: "done" });
    expect(t.heard[1]![0]).toEqual([`slack:C1:${mentionTs}`]);

    await t.followups.flush();
    const items = await t.followups.list();
    expect(items.map((i) => [i.n, i.status, Boolean(i.answeredAt)])).toEqual([
      [1, "open", true],
      [2, "open", true],
    ]);
  });

  it("shows each message's follow-up ref in the inbox report", async () => {
    const t = await inboxEnv();
    const ts = ago(600);
    await t.send({ channel: "D2", channel_type: "im", ts, text: "can you approve the budget?" });
    const out = await inboxReport({ inbox: t.inbox, account: { userId: OWNER, userName: "dana" }, timeZone: "UTC", redact: (s) => s, now: () => NOW }, {});
    const text = out.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain(`Sam Lee: can you approve the budget?\n     Follow-up ref: slack:D2:${ts}`);
  });
});

describe("the follow-ups digest", () => {
  it("adds what needs the owner, then lists their open follow-ups by number", () => {
    const i = ATTENTION_REPORT_INSTRUCTION;
    expect(i.indexOf("gmail_my_inbox")).toBeLessThan(i.indexOf("slack_my_inbox"));
    expect(i).toContain("followups_add");
    expect(i).toContain('ref: the message\'s Follow-up ref ("slack:<channel>:<ts>") or "gmail:<threadId>", so nothing is added twice');
    expect(i).toContain("followups_list");
    expect(i).toContain("1. New: the follow-ups added in this run");
    expect(i).toContain("starting with its number as #n");
    expect(i).toContain("Reply `done <numbers>` to close items");
    expect(i.length).toBeLessThanOrEqual(8000);
  });

  it("is what the attention reports made before follow-ups become, when their instruction is still the original one", async () => {
    const legacy: Routine = {
      id: "rt-what-needs-my-attention-on-slack",
      name: LEGACY_ATTENTION_REPORT_NAME,
      instruction: LEGACY_ATTENTION_REPORT_INSTRUCTION,
      schedule: { cron: "0 9,13,17 * * 1-5", timezone: "Europe/London" },
      deliver: { email: [], slack: OWNER, console: true },
      budgetUsd: 1,
      enabled: true,
      createdBy: "Admin (console)",
      createdAt: "2026-11-01T00:00:00.000Z",
      ownerOnly: true,
    };
    const renamed: Routine = { ...legacy, id: "rt-my-slack", name: "My Slack" };
    const edited: Routine = { ...legacy, id: "rt-edited", instruction: "Read my Slack inbox with slack_my_inbox and tell me only about #ops." };
    const someoneElses: Routine = { ...legacy, id: "rt-theirs", ownerOnly: false };
    const configRepo = await configured(await tmpStore(), (c) => void (c.routines = [legacy, renamed, edited, someoneElses]));

    expect(await migrateAttentionReports(configRepo)).toBe(2);
    const after = (await configRepo.load(true)).routines;
    expect(after.find((r) => r.id === legacy.id)).toMatchObject({ name: ATTENTION_REPORT_NAME, instruction: ATTENTION_REPORT_INSTRUCTION, ownerOnly: true, schedule: legacy.schedule, deliver: legacy.deliver });
    expect(after.find((r) => r.id === renamed.id)).toMatchObject({ name: "My Slack", instruction: ATTENTION_REPORT_INSTRUCTION });
    expect(after.find((r) => r.id === edited.id)?.instruction).toBe(edited.instruction);
    expect(after.find((r) => r.id === someoneElses.id)?.instruction).toBe(LEGACY_ATTENTION_REPORT_INSTRUCTION);
    // Still the owner's report; nothing left to change on the next start.
    expect(findAttentionReport(after)?.id).toBe(legacy.id);
    expect(await migrateAttentionReports(configRepo)).toBe(0);
  });
});
