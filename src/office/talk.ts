import { z } from "zod";
import type { QueryFn } from "../chat/pointer.js";
import type { Config, ConfigRepo } from "../core/config.js";
import type { Store } from "../core/store.js";
import { type CapStatus, type Spending, agentStatus, capsApply, monthlyStatus, providerStatus } from "../spending/budget.js";
import type { AgentCosts } from "../spending/attribution.js";
import type { UsageRepo } from "../spending/usage.js";
import type { TaskRepo } from "../tasks/tasks.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import { TALK_SYSTEM_PROMPT, TALK_TASKS_SCAN, type TalkPerson, parseTalk, recentWork, talkPeople, talkPrompt } from "./talk-prompt.js";
import { type TalkChoice, type TalkOutcome, chatTalk, chooseTalkProvider, geminiTalk, talkAvailability } from "./talk-providers.js";
import type { TalkAnswer, TalkKind, TalkRequest, TalkSettingsView } from "./talk-types.js";

/**
 * The office's AI talk (POST /api/office/talk, its types in talk-types.ts):
 * when people meet in the office (a coffee, a chat on the sofa, foosball,
 * ping pong, pinball, a video game), the page asks for their conversation,
 * and a model writes it about the team's real recent work (talk-prompt.ts,
 * talk-providers.ts). Each activity id gets one conversation: kept in the
 * store for a day or two, so everyone who opens the office sees the same
 * lines and a reload never pays twice. A kept or running conversation
 * answers only a request it fits (the same kind, every speaker one of the
 * people asked for); another request for its id is unavailable.
 *
 * What bounds the spend: the owner's daily maximum of new conversations (a
 * counter per UTC day in the store; every call that reaches a model counts),
 * at most TALK_RATE new ones a minute, one call at a time per activity id
 * (others asking for it wait for it), a failed id not tried again for a while,
 * and the spending caps (monthly, the provider's, each speaker's). Without a
 * conversation the answer says why ("off", "limit", "unavailable") and the
 * page uses its canned lines. Each conversation's cost counts with chat,
 * shared between the people talking.
 */

/** New conversations a minute. */
export const TALK_RATE = { max: 3, windowMs: 60_000 } as const;
/** An activity whose conversation failed is not tried again for this long. */
export const TALK_RETRY_MS = 10 * 60_000;
/** The store is read again after this long (another instance may have written). */
const MEMORY_TTL_MS = 10_000;

const StoredTalkSchema = z.object({
  /** The activity id. */
  id: z.string(),
  kind: z.string(),
  people: z.array(z.string()),
  lines: z.array(z.object({ speaker: z.string(), text: z.string() })),
  provider: z.enum(["gemini", "chat"]),
  model: z.string(),
  at: z.string(),
  costUsd: z.number().optional(),
});
type StoredTalk = z.infer<typeof StoredTalkSchema>;

/** One UTC day of the office's talk as stored: how many calls reached a model, and the conversations. */
const DayFileSchema = z.object({
  count: z.number().int().min(0).catch(0),
  talks: z.array(StoredTalkSchema).catch([]),
});
/** A day in memory: the conversations by activity id (a Map: any id is a key, "constructor" too). */
interface DayFile {
  count: number;
  talks: Map<string, StoredTalk>;
}

/** "2026-11-22", in UTC. */
export const talkDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const talkDayKey = (day: string) => `office-talk/${day}.json`;
const DAY_MS = 86_400_000;

const empty = (): DayFile => ({ count: 0, talks: new Map() });
/** What both copies of a day know: another instance may have written to the store. */
const merge = (a: DayFile, b: DayFile): DayFile => ({ count: Math.max(a.count, b.count), talks: new Map([...b.talks, ...a.talks]) });

const OFF: TalkAnswer = { lines: [], reason: "off" };
const LIMIT: TalkAnswer = { lines: [], reason: "limit" };
const UNAVAILABLE: TalkAnswer = { lines: [], reason: "unavailable" };

/** Whether a conversation of an activity id fits a request for that id: the same kind, and every speaker one of the people asked for. */
const fits = (req: TalkRequest, kind: string, speakers: string[]) => kind === req.kind && speakers.every((id) => req.people.includes(id));

/** A conversation being written, with the request it is for (its speakers will be among those people). */
interface Running {
  kind: TalkKind;
  people: string[];
  answer: Promise<TalkAnswer>;
}

export interface OfficeTalkDeps {
  configRepo: Pick<ConfigRepo, "load">;
  store: Pick<Store, "get" | "put">;
  tasks: Pick<TaskRepo, "recent">;
  /** Each conversation's cost counts with chat; the caps are checked against this month's spend. */
  usage?: Pick<UsageRepo, "month" | "recordChat">;
  /** Alerts after a cost is counted. */
  spending?: Pick<Spending, "notify">;
  /** Tests pass fakes for Gemini and the Agent SDK. */
  fetch?: typeof fetch;
  queryFn?: QueryFn;
  timeoutMs?: number;
  now?: () => number;
}

export class OfficeTalk {
  private readonly days = new Map<string, { file: DayFile; readAt: number }>();
  private readonly running = new Map<string, Running>();
  private readonly failedUntil = new Map<string, number>();
  private starts: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OfficeTalkDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The conversation of an activity: the kept one, the one being written, or a new one within the limits. Never throws. */
  async talk(req: TalkRequest): Promise<TalkAnswer> {
    try {
      const config = await this.deps.configRepo.load();
      const settings = config.office.talk;
      if (!settings.enabled || settings.dailyMax === 0) return OFF;
      const now = this.now();
      await this.refresh(now);
      // No await from here until the id is marked running: two requests for it cannot both start one.
      // An id's conversation never answers a request it does not fit, and never makes a second one.
      const kept = this.find(req.activityId);
      if (kept) return fits(req, kept.kind, kept.lines.map((l) => l.speaker)) ? { lines: kept.lines, provider: kept.provider, model: kept.model } : UNAVAILABLE;
      const running = this.running.get(req.activityId);
      if (running) return fits(req, running.kind, running.people) ? await running.answer : UNAVAILABLE;
      const answer = this.generate(req, config, now).finally(() => this.running.delete(req.activityId));
      this.running.set(req.activityId, { kind: req.kind, people: req.people, answer });
      return await answer;
    } catch (err) {
      console.error(`[office] talk failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      return UNAVAILABLE;
    }
  }

  /** The settings, today's count and which providers are there (GET /api/office/talk/settings). */
  async settings(config?: Config): Promise<TalkSettingsView> {
    const c = config ?? (await this.deps.configRepo.load());
    const now = this.now();
    await this.refresh(now);
    return { ...c.office.talk, usedToday: this.days.get(talkDay(now))?.file.count ?? 0, available: talkAvailability(c) };
  }

  private async generate(req: TalkRequest, config: Config, now: number): Promise<TalkAnswer> {
    for (const [id, until] of this.failedUntil) if (until <= now) this.failedUntil.delete(id);
    if (this.failedUntil.has(req.activityId)) return UNAVAILABLE;
    const choice = chooseTalkProvider(config);
    if (!choice) return UNAVAILABLE;
    const team = talkPeople(config.team);
    const people = req.people.map((id) => team.get(id)).filter((p): p is TalkPerson => p !== undefined);
    if (!people.length) return UNAVAILABLE;
    if (!this.takeRateSlot(now)) return LIMIT;
    if (!(await this.capsAllow(config, choice, people, now))) return LIMIT;
    if (!(await this.reserve(talkDay(now), config.office.talk.dailyMax))) return LIMIT;

    const redact = makeRedactor(configSecrets(config));
    const tasks = await this.deps.tasks.recent(TALK_TASKS_SCAN).catch(() => []);
    const call = {
      system: TALK_SYSTEM_PROMPT,
      prompt: talkPrompt({ kind: req.kind, people, work: recentWork(tasks, people, redact) }, redact),
      speakers: people.map((p) => p.id),
      model: config.office.talk.model,
    };
    const opts = { fetch: this.deps.fetch, queryFn: this.deps.queryFn, timeoutMs: this.deps.timeoutMs };
    const outcome = choice.id === "gemini" ? await geminiTalk(choice.key, call, opts) : await chatTalk(choice.runtime, call, opts);
    this.recordSpend(outcome, choice, people);

    const lines = outcome.error === undefined ? parseTalk(outcome.raw, people, redact) : undefined;
    if (!lines) {
      this.failedUntil.set(req.activityId, now + TALK_RETRY_MS);
      console.error(`[office] no ${req.kind} talk from ${choice.id}: ${redact(outcome.error ?? "fewer than two usable lines").slice(0, 200)}`);
      return UNAVAILABLE;
    }
    const talk: StoredTalk = {
      id: req.activityId,
      kind: req.kind,
      people: people.map((p) => p.id),
      lines,
      provider: choice.id,
      model: outcome.model,
      at: new Date(this.now()).toISOString(),
      ...(outcome.costUsd > 0 ? { costUsd: outcome.costUsd } : {}),
    };
    await this.save(talkDay(this.now()), talk);
    return { lines, provider: choice.id, model: outcome.model };
  }

  /** At most TALK_RATE.max new conversations in any TALK_RATE.windowMs. Synchronous, so concurrent requests count right. */
  private takeRateSlot(now: number): boolean {
    this.starts = this.starts.filter((t) => now - t < TALK_RATE.windowMs);
    if (this.starts.length >= TALK_RATE.max) return false;
    this.starts.push(now);
    return true;
  }

  /** No cap that applies is used up: the monthly one, the provider's, or a speaker's own. A failed lookup never blocks (as Spending). */
  private async capsAllow(config: Config, choice: TalkChoice, people: TalkPerson[], now: number): Promise<boolean> {
    if (!this.deps.usage || !capsApply(config.budget)) return true;
    try {
      const usage = await this.deps.usage.month(new Date(now), { chatProvider: config.ai.chatProvider });
      const usedUp = (s: CapStatus | null) => s !== null && s.remainingUsd <= 0;
      const provider = choice.id === "gemini" ? "gemini" : choice.runtime.provider;
      return !(
        usedUp(monthlyStatus(config.budget, usage)) ||
        usedUp(providerStatus(config.budget, usage, provider)) ||
        people.some((p) => usedUp(agentStatus(config.budget, usage, p.id)))
      );
    } catch (err) {
      console.error(`[office] spend not checked: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      return true;
    }
  }

  /** What the call cost counts with chat, shared evenly between the people talking, on the provider it ran on. */
  private recordSpend(outcome: TalkOutcome, choice: TalkChoice, people: TalkPerson[]): void {
    if (!this.deps.usage || (outcome.costUsd <= 0 && outcome.tokens <= 0)) return;
    const share = { usd: outcome.costUsd / people.length, tokens: Math.round(outcome.tokens / people.length) };
    const agentCosts: AgentCosts = Object.fromEntries(people.map((p) => [p.id, { ...share }]));
    void this.deps.usage
      .recordChat({ costUsd: outcome.costUsd, provider: choice.id === "gemini" ? "gemini" : choice.runtime.provider, agentCosts })
      .then(() => this.deps.spending?.notify())
      .catch((err: unknown) => console.error(`[office] cost not recorded: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`));
  }

  // ---------- The store: one file per UTC day ----------

  /** Today's and yesterday's files in memory, read again when old; other days are dropped. */
  private async refresh(now: number): Promise<void> {
    const wanted = [talkDay(now), talkDay(now - DAY_MS)];
    for (const day of this.days.keys()) if (!wanted.includes(day)) this.days.delete(day);
    await Promise.all(
      wanted.map(async (day) => {
        const cached = this.days.get(day);
        if (cached && now - cached.readAt < MEMORY_TTL_MS) return;
        const stored = await this.read(day);
        // Merged, never replaced: a conversation saved while this read was on its way is kept.
        const current = this.days.get(day)?.file ?? empty();
        this.days.set(day, { file: merge(current, stored), readAt: now });
      }),
    );
  }

  /** A kept conversation, from memory (refresh first). */
  private find(activityId: string): StoredTalk | undefined {
    for (const { file } of this.days.values()) {
      const talk = file.talks.get(activityId);
      if (talk) return talk;
    }
    return undefined;
  }

  private async read(day: string): Promise<DayFile> {
    const blob = await this.deps.store.get(talkDayKey(day));
    if (!blob) return empty();
    try {
      const parsed = DayFileSchema.safeParse(JSON.parse(blob.toString("utf8")));
      return parsed.success ? { count: parsed.data.count, talks: new Map(parsed.data.talks.map((t) => [t.id, t])) } : empty();
    } catch {
      return empty();
    }
  }

  /** Reads a day's file, changes it and writes it back when `mutate` says it changed, one change at a time. */
  private change(day: string, mutate: (file: DayFile) => boolean): Promise<boolean> {
    const run = this.chain.then(async () => {
      const stored = await this.read(day);
      const file = merge(this.days.get(day)?.file ?? empty(), stored);
      if (!mutate(file)) return false;
      await this.deps.store.put(talkDayKey(day), JSON.stringify({ count: file.count, talks: [...file.talks.values()] }));
      this.days.set(day, { file, readAt: this.now() });
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Counts one more call today, unless the daily maximum is reached. */
  private reserve(day: string, dailyMax: number): Promise<boolean> {
    return this.change(day, (file) => {
      if (file.count >= dailyMax) return false;
      file.count += 1;
      return true;
    });
  }

  private async save(day: string, talk: StoredTalk): Promise<void> {
    await this.change(day, (file) => {
      file.talks.set(talk.id, talk);
      return true;
    });
  }
}
