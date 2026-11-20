import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./core/crypto.js";
import type { Store } from "./core/store.js";

/**
 * Facts Pointer remembers across conversations ("my main repo is X").
 * Global by design: every conversation sees every fact. Stored encrypted with
 * the master key, like the config.
 */
export interface MemoryFact {
  id: string;
  text: string;
  createdAt: string;
  /** Slack user id of whoever asked Pointer to remember it. */
  by?: string;
}

export const MEMORY_MAX_FACTS = 100;
export const MEMORY_MAX_CHARS = 500;
const MEMORY_KEY = "memory.enc";

export type SaveResult = { ok: true; fact: MemoryFact } | { ok: false; error: string };

export class MemoryRepo {
  /** Serialises read-modify-write so a Slack save and an admin delete can't overwrite each other (single instance). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
  ) {}

  async list(): Promise<MemoryFact[]> {
    const blob = await this.store.get(MEMORY_KEY);
    if (!blob) return [];
    const parsed = JSON.parse(decrypt(this.key, blob)) as { facts?: MemoryFact[] };
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  }

  save(text: string, by?: string): Promise<SaveResult> {
    return this.exclusive(() => this.saveNow(text, by));
  }

  forget(id: string): Promise<boolean> {
    return this.exclusive(() => this.forgetNow(id));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async saveNow(text: string, by?: string): Promise<SaveResult> {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return { ok: false, error: "Nothing to remember." };
    if (clean.length > MEMORY_MAX_CHARS) {
      return { ok: false, error: `Too long: keep a fact under ${MEMORY_MAX_CHARS} characters.` };
    }
    const facts = await this.list();
    if (facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) {
      return { ok: true, fact: facts.find((f) => f.text.toLowerCase() === clean.toLowerCase())! };
    }
    if (facts.length >= MEMORY_MAX_FACTS) {
      return { ok: false, error: "Memory is full. Ask the owner to delete some facts on the admin page." };
    }
    const fact: MemoryFact = { id: `m-${randomBytes(4).toString("hex")}`, text: clean, createdAt: new Date().toISOString(), by };
    await this.write([...facts, fact]);
    return { ok: true, fact };
  }

  private async forgetNow(id: string): Promise<boolean> {
    const facts = await this.list();
    const next = facts.filter((f) => f.id !== id);
    if (next.length === facts.length) return false;
    await this.write(next);
    return true;
  }

  private async write(facts: MemoryFact[]): Promise<void> {
    await this.store.put(MEMORY_KEY, encrypt(this.key, JSON.stringify({ facts })));
  }
}
