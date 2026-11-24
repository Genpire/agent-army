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

/** The stored items LISTED shows: the list form matches a line's words against these, never against Pointer's text. */
const ITEMS = new Map([
  [1, { title: "Reply to Omar about the Q3 invoice", from: "Omar" }],
  [2, { title: "Answer Rita on the contract", from: "Rita" }],
  [14, { title: "Send the deck" }],
  [3, { title: "Call the bank" }],
]);
const LIST = { pointerText: LISTED, items: ITEMS };

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
    expect(parseDoneCommand(list, LIST)).toEqual([1, 2]);
    expect(parseDoneCommand("1. Omar - done\n14. deck - done", LIST)).toEqual([1, 14]);
    expect(parseDoneCommand("1. Omar (Slack) - done", LIST)).toEqual([1]);
    expect(parseDoneCommand("1. done", LIST)).toEqual([1]);
    expect(parseDoneCommand("2) Rita: تم", LIST)).toEqual([2]);
    // Without such a message (or with a list numbered by position, no #n), it is not a command.
    expect(parseDoneCommand(list)).toBeUndefined();
    expect(parseDoneCommand(list, { ...LIST, pointerText: "1. Omar (DM): asked about the invoice\n2. Rita (DM): the contract" })).toBeUndefined();
    // A number Pointer did not show, or a name that is not the item's: ambiguous.
    expect(parseDoneCommand("1. Omar - done\n3. Rita - done", LIST)).toBeUndefined();
    expect(parseDoneCommand("1. Rita - done", LIST)).toBeUndefined();
    // A line that is not "done" makes the whole message Pointer's.
    expect(parseDoneCommand("1. Omar - done\n2. Rita - not yet", LIST)).toBeUndefined();
    // #1 is not #14.
    expect(parseDoneCommand("1. deck - done", LIST)).toBeUndefined();
  });

  it("matches a list line by whole words of the stored item's title and sender, never Pointer's text", async () => {
    // Pointer's line for #1 quotes other people's words ("approved"); the item's own title does not have them.
    const quoting = { pointerText: "• #1 Reply to Omar · Omar · Slack · approved by finance", items: new Map([[1, { title: "Reply to Omar", from: "Omar" }]]) };
    expect(parseDoneCommand("1. Omar - done", quoting)).toEqual([1]);
    expect(parseDoneCommand("1. approved - done", quoting)).toBeUndefined();
    expect(parseDoneCommand("1. finance - done", quoting)).toBeUndefined();
    // Whole words only: "Oma" or "invoices" are not "Omar" or "invoice".
    expect(parseDoneCommand("1. Omari - done", LIST)).toBeUndefined();
    expect(parseDoneCommand("1. invoices - done", LIST)).toBeUndefined();
    expect(parseDoneCommand("1. invoice - done", LIST)).toEqual([1]);
    // Every word must be the item's, not one of them.
    expect(parseDoneCommand("1. Omar Rita - done", LIST)).toBeUndefined();
    // A number Pointer showed that is no longer stored: not a command.
    expect(parseDoneCommand("14. deck - done", { ...LIST, items: new Map([[1, ITEMS.get(1)!]]) })).toBeUndefined();
  });

  it("never closes on a negation, a word that only ends in a close word, or a range", async () => {
    // #3 is shown and stored, so each of these would have closed it before (the list form read "un", "ما" as a short label).
    const shown = { pointerText: `${LISTED}\n• *#3* Call the bank · 1d\n• *#4* Pay rent · 2d\n• *#5* Book flights`, items: new Map([...ITEMS, [4, { title: "Pay rent" }], [5, { title: "Book flights" }]]) };
    const never = [
      "3 undone",
      "3 un-done",
      "3 not done",
      "3 is not done",
      "3 isn't done",
      "3 isn’t done",
      "3 no done",
      "3 never done",
      "3 not yet done",
      "done 3 not yet",
      "not done 3",
      "3 ما تم",
      "3 لم يتم",
      "3 لا تم",
      "3 مش خلص",
      "3 ما خلص",
      "3 مو خلص",
      "3 لسه ما خلص",
      "3 ليس منتهي",
      "3 غير منتهي",
      "4 مش منتهي",
      "3 ماتم",
      "3 مخلص",
      "3-5 done",
      "3 - 5 done",
      "3–5 done",
      "3 to 5 done",
      "3 through 5 done",
      "done 3 to 5",
      "done 3-5",
      "3 الى 5 تم",
      "3 إلى 5 تم",
      "3 لـ 5 تم",
      "3 ل5 تم",
      "3 حتى 5 تم",
      "1. Omar - done\n3 not done",
      "1. Omar - done\n3-5 done",
    ];
    for (const text of never) {
      expect(parseDoneCommand(text), text).toBeUndefined();
      expect(parseDoneCommand(text, shown), text).toBeUndefined();
    }
    const followups = new FollowupStore(new MemoryStore(), deriveKey("k"), { batchMs: 0 });
    for (const title of ["one", "two", "Call the bank", "Pay rent", "Book flights"]) await followups.add({ title, source: "owner" });
    for (const text of never) expect(await handleDoneCommand(followups, text, async () => shown.pointerText, "slack"), text).toBeUndefined();
    expect((await followups.list()).length).toBe(5);
    // The positive forms still close.
    expect(parseDoneCommand("3 done", shown)).toEqual([3]);
    expect(parseDoneCommand("3 تم", shown)).toEqual([3]);
    expect(parseDoneCommand("done 3 and 5", shown)).toEqual([3, 5]);
    expect(parseDoneCommand("4 منتهي", shown)).toEqual([4]);
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

  it("answers in the console without Pointer, marked as relayed from the inbox", async () => {
    const followups = new FollowupStore(new MemoryStore(), deriveKey("k"), { batchMs: 0 });
    await followups.add({ title: "Reply to Omar", source: "slack" });
    await followups.add({ title: "Answer Rita", source: "slack" });
    const quick = followupQuickReplies(followups);
    const before: ChatMessage[] = [{ id: "m-1", role: "pointer", text: LISTED, at: "2026-11-24T08:30:00Z", relayed: "inbox" }];
    expect(await quick.reply("1. Omar - done\n2. Rita - done", before)).toEqual({ text: "✅ Closed #1 Reply to Omar, #2 Answer Rita.", relayed: "inbox" });
    expect(await quick.reply("hello", before)).toBeUndefined();
    expect((await followups.list()).length).toBe(0);
  });
});
