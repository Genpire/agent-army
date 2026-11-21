/** Shared fakes for the routines tests: a store, config, brain, console, Slack and email that record what they get. */
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PointerBrain, PointerReply, PointerRequest } from "../../src/chat/pointer-types.js";
import { type Config, ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore, type Store } from "../../src/core/store.js";
import type { EmailMessage } from "../../src/integrations/email/email.js";
import type { ConsoleThreads, EmailSender, SlackPoster } from "../../src/routines/runner.js";
import { RoutineService } from "../../src/routines/service.js";

export const SECRETS = { apiKey: "sk-ant-routine-secret-123456", ghToken: "ghp_routine_secret_abcdef", botToken: "xoxb-routine-secret-999999" };

export class Clock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  set(iso: string) {
    this.ms = Date.parse(iso);
  }
}

export function fakeBrain(reply: (req: PointerRequest) => PointerReply | Promise<PointerReply> = () => ({ text: "The report.", costUsd: 0.1, isError: false })) {
  const requests: PointerRequest[] = [];
  const brain: PointerBrain = {
    async reply(req) {
      requests.push(req);
      return reply(req);
    },
  };
  return { brain, requests };
}

export function fakeThreads() {
  const started: { id: string; title: string; markdown: string; isError?: boolean }[] = [];
  const posted: { id: string; markdown: string; isError?: boolean }[] = [];
  let n = 0;
  const threads: ConsoleThreads = {
    async post(id, markdown, isError) {
      if (!started.some((s) => s.id === id)) return false;
      posted.push({ id, markdown, ...(isError ? { isError } : {}) });
      return true;
    },
    async start(title, markdown, isError) {
      const id = `c-conversation-${++n}`;
      started.push({ id, title, markdown, ...(isError ? { isError } : {}) });
      return id;
    },
  };
  return { threads, started, posted };
}

export function fakeSlack() {
  const messages: { token: string; channel: string; text: string }[] = [];
  const slack = (token: string): SlackPoster => ({
    chat: {
      postMessage: (async (args: { channel: string; text: string }) => {
        messages.push({ token, channel: args.channel, text: args.text });
        return { ok: true, ts: "1.0" };
      }) as unknown as SlackPoster["chat"]["postMessage"],
    },
  });
  return { slack, messages };
}

export function fakeEmail(ready = true) {
  const sent: EmailMessage[] = [];
  const email: EmailSender = {
    ready: () => ready,
    async send(_config, message) {
      sent.push(message);
      return { ok: true, id: `e-${sent.length}` };
    },
  };
  return { email, sent };
}

export async function tmpStore(prefix = "army-routines-") {
  return new FsStore(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * The same folder as another instance would see it. FsStore names its temp
 * files after the process id, so two stores in one test process writing the
 * same key at once would collide; real instances are separate processes.
 */
export class InstanceStore extends FsStore {
  constructor(
    private readonly folder: string,
    private readonly tag: string,
  ) {
    super(folder);
  }

  override async put(key: string, data: Buffer | string): Promise<void> {
    const path = join(this.folder, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${this.tag}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }
}

/** A store in memory, for tests that write many records. */
export class MemoryStore implements Store {
  readonly data = new Map<string, Buffer>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: Buffer | string) {
    this.data.set(key, Buffer.from(value));
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  describe() {
    return "memory";
  }
}

/** Two stores on one folder, as two instances would see it. */
export async function sharedStores(): Promise<[InstanceStore, InstanceStore]> {
  const folder = await mkdtemp(join(tmpdir(), "army-routines-shared-"));
  return [new InstanceStore(folder, "a"), new InstanceStore(folder, "b")];
}

export const KEY = deriveKey("routines-test-key");

/** A config with Claude, Slack and GitHub connected (fake credentials). */
export async function configured(store: FsStore, patch: (c: Config) => void = () => undefined): Promise<ConfigRepo> {
  const configRepo = new ConfigRepo(store, KEY, 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = SECRETS.apiKey;
    c.slack.botToken = SECRETS.botToken;
    c.slack.signingSecret = "signing";
    c.github.token = SECRETS.ghToken;
    c.github.allowedOwners = ["acme"];
    c.timezone = "UTC";
    patch(c);
  });
  return configRepo;
}

export interface EnvOptions {
  clock?: Clock;
  brain?: ReturnType<typeof fakeBrain>;
  emailReady?: boolean;
  spending?: ConstructorParameters<typeof RoutineService>[0]["spending"];
  patch?: (c: Config) => void;
  store?: FsStore;
  /** The store already holds a config (another instance's). */
  shared?: boolean;
  owner?: string;
  /** The store read-back delay (two instances racing need one). */
  settleMs?: number;
}

/** A RoutineService over a temporary store, with every outside party faked. */
export async function routineEnv(opts: EnvOptions = {}) {
  const store = opts.store ?? (await tmpStore());
  const clock = opts.clock ?? new Clock(Date.parse("2026-11-21T07:00:00Z"));
  const configRepo = opts.shared ? new ConfigRepo(store, KEY, 0) : await configured(store, opts.patch);
  const brain = opts.brain ?? fakeBrain();
  const threads = fakeThreads();
  const slack = fakeSlack();
  const email = fakeEmail(opts.emailReady ?? true);
  const service = new RoutineService({
    configRepo,
    store,
    masterKey: KEY,
    brain: brain.brain,
    threads: threads.threads,
    slack: slack.slack,
    email: email.email,
    now: clock.now,
    settleMs: opts.settleMs ?? 0,
    ...(opts.spending ? { spending: opts.spending } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
  });
  return { store, clock, configRepo, service, brain, threads, slack, email };
}

export const DIGEST = {
  name: "Daily GitHub digest",
  instruction: "Summarise what happened on GitHub in acme/web: pull requests merged and waiting for review.",
  cron: "0 8 * * *",
};
