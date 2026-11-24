/**
 * "done 3 5" without the model: in the owner's own conversation with Pointer
 * (their DM with it, the console), a message that is only a command to close
 * follow-ups is handled by the server. A direct command from the owner is not
 * outside content, so it needs no confirmation, also right after a reminder
 * or a digest (which relay outside content).
 *
 * Understood, in English and Arabic, digits Western or Arabic-Indic:
 * - a close word and numbers: "done 12", "close 9", "done 3, 5 and 7",
 *   "mark 4 as done", "تم 3", "تم 3 و 5", "خلص 4";
 * - numbers and a close word: "12 done", "1 and 2 done", "3 and 5 are done", "3 تم";
 * - a list, one item per line, each ending with a close word, when it
 *   answers a message of Pointer's that showed those numbers as #n:
 *   "1. Omar (DM) - done\n2. Rita (DM) - done". Every word between a number
 *   and "done" (a name, a word of the title) must be a whole word of that
 *   item's own title or sender, as stored: a list numbered by position is
 *   never taken for numbers, and Pointer's text (which quotes other
 *   people's words) decides nothing.
 * Polite words around it are fine ("done 3 please", "thanks, close 9").
 * A close word counts only as a whole word ("undone" is not "done"). Any
 * line with a negation ("3 not done", "3 isn't done", "3 ما تم", "4 مش
 * منتهي") or a range between numbers ("3-5 done", "3 to 5 done", "3 الى 5")
 * makes the whole message Pointer's, as does anything else (a question,
 * words in between, a list whose numbers Pointer did not show).
 */
import type { QuickReplies } from "../chat/conversations.js";
import { type Target, shortLabel } from "./format.js";
import type { DoneResult, FollowupStore } from "./store.js";
import type { FollowupItem } from "./types.js";

/** Items closed by one message at most. */
const MAX_NUMBERS = 30;

const DONE_WORDS = "done|closed|close|complete|completed|finished|finish|تم|تمت|خلص|خلصت|خلصنا|انتهى|انتهي|انتهت|اغلق|اغلقت|سكر|سكرت|منتهي";
/** A close word, whole: nothing of a word before it ("undone", "ماتم") or letters after it ("doneish"). */
const DONE = `(?<![\\p{L}\\p{N}])(?:${DONE_WORDS})(?!\\p{L})`;
const FILLER = "please|pls|plz|thanks|thank you|thx|ok|okay|شكرا|لو سمحت|من فضلك";
const NUM = "#?\\d{1,6}";
/** Between numbers: a comma (Arabic too), &, +, /, "and", "و" (Arabic "and", also written on the number), or a space. */
const SEP = "(?:\\s*[,،&+/]\\s*(?:and\\s+|و\\s*)?|\\s+and\\s+|\\s*و\\s*|\\s+)";
const NUMLIST = `${NUM}(?:${SEP}${NUM}){0,${MAX_NUMBERS - 1}}`;

const WORD_FIRST = new RegExp(`^(?:mark\\s+)?(?:${DONE})\\s*[:\\-–—]?\\s*(${NUMLIST})$`, "u");
const NUMBERS_FIRST = new RegExp(`^(?:mark\\s+)?(${NUMLIST})\\s*[:\\-–—]?\\s*(?:(?:is|are|as|all)\\s+)*(?:${DONE})$`, "u");
/** One line of a list: "1. Omar (DM) - done", "- #3 Reply to Sam: done", "2) تم". */
const LIST_LINE = new RegExp(`^[-•]?\\s*#?(\\d{1,6})\\s*[.):\\-–—]?\\s*(.*?)\\s*[-–—:,(]?\\s*(?:(?:is|are)\\s+)?(?:${DONE})\\s*\\)?$`, "u");
const LEADING_FILLER = new RegExp(`^(?:${FILLER})(?:[\\s,،.!:-]+|$)`, "u");
const TRAILING_FILLER = new RegExp(`(?:^|[\\s,،.!:-]+)(?:${FILLER})$`, "u");

/**
 * A negation anywhere in a line: "not", "no", "never", "yet", "isn't",
 * "un-done", Arabic ما، لم، لا، مش، مو، لسه، ليس، غير. Such a line is never a
 * command ("3 is not done", "3 لم يتم"): the whole message goes to Pointer.
 */
const NEGATION = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?:not|no|nope|never|yet|un|ما|لم|لا|مش|مو|مب|لسه|لسة|لسا|لسى|ليس|غير)(?![\\p{L}\\p{N}])",
    "n['’]t(?!\\p{L})",
    `(?<![\\p{L}\\p{N}])un-?(?:${DONE_WORDS})`,
  ].join("|"),
  "u",
);
/** A range between two numbers: "3-5", "3 – 5", "3 to 5", "3 through 5", "3 الى 5", "3 لـ 5", "3 حتى 5". */
const RANGE = /\d\s*(?:[-–—~]|\.\.|(?:to|through|thru|till|until|ال[ىي]|حت[ىي]|ل)(?![\p{L}]))\s*#?\d/u;

/** Words too common to tell two items apart, and the source names Pointer's lines carry. */
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "about", "reply", "via", "you", "your", "dm", "in", "to", "re", "slack", "gmail", "email", "mail", "calendar"]);

const westernDigits = (text: string) =>
  text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/** Lower case, Western digits, no emoji, Slack emoji codes, formatting marks or Arabic diacritics; Arabic alef forms folded. */
export function normalizeCommand(text: string): string {
  return westernDigits(text.normalize("NFKC"))
    .replace(/:[a-z0-9_+'-]+:/gi, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[`*_~]/g, " ")
    .replace(/[\p{M}ـ]/gu, "")
    .replace(/[أإآ]/g, "ا")
    .toLowerCase();
}

/** A line without polite words around it and the punctuation that ends it. */
function trimLine(line: string): string {
  let s = line.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "").replace(/[\s.!،,]+$/u, "").trim();
    if (s === before) break;
  }
  return s;
}

const numbersIn = (text: string): number[] => [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));

/** The numbers a message of Pointer's shows as #n. */
function shownNumbers(pointerText: string): Set<number> {
  return new Set([...normalizeCommand(pointerText).matchAll(/#(\d{1,6})(?!\d)/g)].map((m) => Number(m[1])));
}

const wordsOf = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The words of a list line's label that would tell it apart: letters, three or more, not common words. */
const labelWords = (label: string): string[] => wordsOf(label).filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

/** What the list form checks a line against. */
export interface DoneListContext {
  /** Pointer's message it answers: only numbers it showed as #n count. */
  pointerText: string;
  /** The stored items by number: a line's words must be whole words of its item's title or sender. */
  items: ReadonlyMap<number, Pick<FollowupItem, "title" | "from">>;
}

/**
 * The follow-up numbers a message closes, in order, without repeats; or
 * undefined when it is not only a command to close follow-ups (see the
 * file's comment). `list`: Pointer's message it answers and the stored
 * items, for the list form; without it a list is not a command.
 */
export function parseDoneCommand(text: string, list?: DoneListContext): number[] | undefined {
  const normalized = normalizeCommand(text);
  if (/[?؟]/.test(normalized)) return undefined;
  const lines = normalized
    .split(/\r?\n/)
    .map(trimLine)
    .filter(Boolean);
  if (!lines.length || lines.length > MAX_NUMBERS) return undefined;
  // "3 not done", "3-5 done": never a command, the whole message is Pointer's.
  if (lines.some((line) => NEGATION.test(line) || RANGE.test(line))) return undefined;
  let shown: Set<number> | undefined;
  const out: number[] = [];
  for (const line of lines) {
    const command = line.match(WORD_FIRST) ?? line.match(NUMBERS_FIRST);
    if (command) {
      out.push(...numbersIn(command[1]!));
      continue;
    }
    const item = line.match(LIST_LINE);
    if (!item || !list) return undefined;
    shown ??= shownNumbers(list.pointerText);
    const n = Number(item[1]);
    const stored = list.items.get(n);
    if (!shown.has(n) || !stored) return undefined;
    const known = new Set(wordsOf(normalizeCommand(`${stored.title} ${stored.from ?? ""}`)));
    if (!labelWords(item[2] ?? "").every((w) => known.has(w))) return undefined;
    out.push(n);
  }
  const numbers = [...new Set(out)].filter((n) => n >= 1);
  return numbers.length && numbers.length <= MAX_NUMBERS ? numbers : undefined;
}

/** Whether a message could be a list that needs Pointer's last message to be read: lines that start with a number and end with a close word. */
export function maybeDoneList(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized
    .split(/\r?\n/)
    .map(trimLine)
    .filter(Boolean)
    .some((line) => LIST_LINE.test(line));
}

const numberList = (ns: number[]) => {
  const tags = ns.map((n) => `#${n}`);
  return tags.length <= 1 ? (tags[0] ?? "") : `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`;
};

/** The reply: what was closed (number and title), what was closed already, and which numbers do not exist. */
export function doneReply(r: DoneResult, target: Target): string {
  const parts: string[] = [];
  if (r.closed.length) parts.push(`✅ Closed ${r.closed.map((i) => shortLabel(i, target)).join(", ")}.`);
  if (r.alreadyDone.length) {
    const ns = r.alreadyDone.map((i) => i.n);
    parts.push(`${numberList(ns)} ${ns.length === 1 ? "was" : "were"} already closed.`);
  }
  if (r.notFound.length) parts.push(`There is no follow-up ${numberList(r.notFound)}.`);
  return parts.join(" ");
}

/**
 * Closes what a message closes, when it is only that command, and returns
 * the reply; undefined when it is not one (it goes to Pointer). `previous`
 * reads Pointer's last message in the conversation, and the stored items
 * are read, only for the list form.
 */
export async function handleDoneCommand(
  store: Pick<FollowupStore, "done" | "list">,
  text: string,
  previous: () => Promise<string | undefined>,
  target: Target,
): Promise<{ text: string; result: DoneResult } | undefined> {
  let numbers = parseDoneCommand(text);
  if (!numbers && maybeDoneList(text)) {
    const pointerText = await previous().catch(() => undefined);
    if (pointerText) {
      const items = new Map((await store.list({ status: "all" })).map((i) => [i.n, i] as const));
      numbers = parseDoneCommand(text, { pointerText, items });
    }
  }
  if (!numbers) return undefined;
  const result = await store.done(numbers);
  return { text: doneReply(result, target), result };
}

/**
 * The console's quick replies (conversations.ts): "done 3 5" closes those
 * follow-ups; the list form reads Pointer's last message in the conversation.
 * The reply quotes the items' titles (maybe other people's words, copied
 * from the owner's inbox): relayed at level "inbox", like the reminders.
 */
export function followupQuickReplies(store: Pick<FollowupStore, "done" | "list">): QuickReplies {
  return {
    async reply(text, before) {
      const lastPointer = async () => [...before].reverse().find((m) => m.role === "pointer")?.text;
      const done = await handleDoneCommand(store, text, lastPointer, "markdown");
      if (!done) return undefined;
      console.info(`[followups] closed ${done.result.closed.length} by the owner's command in the console`);
      return { text: done.text, relayed: "inbox" };
    },
  };
}
