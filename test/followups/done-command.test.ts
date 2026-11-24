import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/chat/conversations.js";
import { deriveKey } from "../../src/core/crypto.js";
import { doneReply, followupQuickReplies, handleDoneCommand, parseDoneCommand } from "../../src/followups/done-command.js";
import { FollowupStore } from "../../src/followups/store.js";
import { MemoryStore } from "../routines/helpers.js";

/** Pointer's message listing follow-ups by their own numbers, as the brief and the digest write them. */
const LISTED = [
  "*Open follow-ups: 3*",
  "• *#1* Reply to Omar about the Q3 invoice · Omar · Slack · 2d",
  "• *#2* Answer Rita on the contract · Rita · Slack · 1d",
  "• *#14* Send the deck · 5h",
  "Reply `done 1 2` to close items when they are done.",
].join("\n");

describe("the done command", () => {
  it("understands a close word with numbers, and numbers with a close word", () => {
    const cases: [string, number[]][] = [
      ["done 12", [12]],
      ["Done #12", [12]],
      ["12 done", [12]],
      ["#12 done ✅", [12]],
      ["done 3, 5 and 7", [3, 5, 7]],
      ["done 3 5", [3, 5]],
      ["`done 3 5`", [3, 5]],
      ["1 and 2 done", [1, 2]],
      ["3 and 5 are done", [3, 5]],
      ["close 9", [9]],
      ["closed #4, #6", [4, 6]],
      ["mark 4 as done", [4]],
      ["done 3 please", [3]],
      ["thanks, close 9", [9]],
      ["done 3 3", [3]],
      ["done: 8 & 9", [8, 9]],
    ];
    for (const [text, numbers] of cases) expect(parseDoneCommand(text), text).toEqual(numbers);
  });

  it("understands Arabic, with Western or Arabic-Indic digits", () => {
    const cases: [string, number[]][] = [
      ["تم 3", [3]],
      ["تم 3 و 5", [3, 5]],
      ["تم 3 و5", [3, 5]],
      ["خلص 4", [4]],
      ["3 تم", [3]],
      ["تم ٣ و ٥", [3, 5]],
      ["أغلق 7", [7]],
      ["تم 3، 5", [3, 5]],
    ];
    for (const [text, numbers] of cases) expect(parseDoneCommand(text), text).toEqual(numbers);
  });

  it("leaves anything else to Pointer", () => {
    for (const text of [
      "done",
      "done?",
      "done 3?",
      "is 3 done?",
      "تم؟",
      "I am done with 3",
      "done 3-5",
      "done at 3",
      "done 3 and the deck",
      "2 done, 3 to go",
      "remind me at 3",
      "what's done 3 days ago",
      "close the Omar one",
      "done 0",
      "12",
    ]) {
      expect(parseDoneCommand(text), text).toBeUndefined();
    }
  });

  it("takes a numbered list only when it answers Pointer's message showing those numbers", () => {
    const list = "1. Omar (DM) - done\n2. Rita (DM) - done";
    // The owner's real message: under a list of follow-ups by their own numbers, it closes #1 and #2.
    expect(parseDoneCommand(list, LISTED)).toEqual([1, 2]);
    expect(parseDoneCommand("1. Omar - done\n14. deck - done", LISTED)).toEqual([1, 14]);
    expect(parseDoneCommand("1. done", LISTED)).toEqual([1]);
    expect(parseDoneCommand("2) Rita: تم", LISTED)).toEqual([2]);
    // Without such a message (or with a list numbered by position, no #n), it is not a command.
    expect(parseDoneCommand(list)).toBeUndefined();
    expect(parseDoneCommand(list, "1. Omar (DM): asked about the invoice\n2. Rita (DM): the contract")).toBeUndefined();
    // A number Pointer did not show, or a name that is not on that line: ambiguous.
    expect(parseDoneCommand("1. Omar - done\n3. Rita - done", LISTED)).toBeUndefined();
    expect(parseDoneCommand("1. Rita - done", LISTED)).toBeUndefined();
    // A line that is not "done" makes the whole message Pointer's.
    expect(parseDoneCommand("1. Omar - done\n2. Rita - not yet", LISTED)).toBeUndefined();
    // #1 is not #14.
    expect(parseDoneCommand("1. deck - done", LISTED)).toBeUndefined();
  });

  it("closes the items and says what was closed, already closed, or not found", async () => {
    const followups = new FollowupStore(new MemoryStore(), deriveKey("k"), { batchMs: 0 });
    await followups.add({ title: "Reply to Omar about the Q3 invoice", source: "slack" });
    await followups.add({ title: "Answer <!channel> Rita", source: "slack" });
    await followups.add({ title: "Send the deck", source: "owner" });
    await followups.done([3]);
    const reads: string[] = [];
    const previous = async () => {
      reads.push("read");
      return LISTED;
    };
    const r = await handleDoneCommand(followups, "done 1, 2, 3 and 9", previous, "slack");
    expect(r?.text).toBe("✅ Closed #1 Reply to Omar about the Q3 invoice, #2 Answer &lt;!channel&gt; Rita. #3 was already closed. There is no follow-up #9.");
    // A plain command never reads the conversation.
    expect(reads).toEqual([]);
    expect(await handleDoneCommand(followups, "what is open?", previous, "slack")).toBeUndefined();
    expect(reads).toEqual([]);
    await followups.reopen(1);
    await followups.reopen(2);
    const listed = await handleDoneCommand(followups, "1. Omar (DM) - done\n2. Rita (DM) - done", previous, "markdown");
    expect(listed?.text).toBe("✅ Closed #1 Reply to Omar about the Q3 invoice, #2 Answer <!channel> Rita.");
    expect(reads).toEqual(["read"]);
    expect(doneReply({ closed: [], alreadyDone: [], notFound: [4, 5] }, "text")).toBe("There is no follow-up #4 and #5.");
  });

  it("answers in the console without Pointer, marked as relayed", async () => {
    const followups = new FollowupStore(new MemoryStore(), deriveKey("k"), { batchMs: 0 });
    await followups.add({ title: "Reply to Omar", source: "slack" });
    await followups.add({ title: "Answer Rita", source: "slack" });
    const quick = followupQuickReplies(followups);
    const before: ChatMessage[] = [{ id: "m-1", role: "pointer", text: LISTED, at: "2026-11-24T08:30:00Z", relayed: "read" }];
    expect(await quick.reply("1. Omar - done\n2. Rita - done", before)).toEqual({ text: "✅ Closed #1 Reply to Omar, #2 Answer Rita.", relayed: "read" });
    expect(await quick.reply("hello", before)).toBeUndefined();
    expect((await followups.list()).length).toBe(0);
  });
});
