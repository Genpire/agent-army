/**
 * What routines keep in the store:
 *
 * - routines/runs/<routineId>/<runId>.json: one record per run, written once
 *   when the run is claimed and again when it ends. A scheduled run's id comes
 *   from the time it was scheduled for, so two instances cannot both claim it.
 * - routines/runs/<routineId>/index.json: the last MAX_RUNS runs without their
 *   reports, newest first. Older runs' files are blanked (the store cannot
 *   delete).
 * - routines/state/<routineId>.json: the last scheduled time handled, the last
 *   successful run (the next report's window starts there), the console
 *   conversation the reports go to, and the time before which the schedule
 *   does not count (set when a routine is created, changed or resumed).
 * - routines/lease.json: which instance runs the scheduler, until when.
 * - routines/tick.enc: the secret of POST /routines/tick, encrypted.
 */
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, randomToken } from "../core/crypto.js";
import type { Store } from "../core/store.js";

export const MAX_RUNS = 50;

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";
/** schedule: on time; catch-up: late after the service was down; manual: Run now. */
export type RunTrigger = "schedule" | "catch-up" | "manual";

export type DeliveryOutcome = { ok: true; detail?: string } | { ok: false; error: string };

/** Where a run's report went; null = that recipient is not set on the routine. */
export interface Delivered {
  email: DeliveryOutcome | null;
  slack: DeliveryOutcome | null;
  console: DeliveryOutcome | null;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  trigger: RunTrigger;
  /** The scheduled time (a manual run: when it was asked for). */
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  costUsd?: number;
  /** The report, Markdown, redacted. */
  report?: string;
  delivered: Delivered;
  error?: string;
  /** Why it was skipped, or what else to know (missed runs, a lowered budget). */
  note?: string;
  /** The instance that claimed it. */
  owner?: string;
}

/** A run in a list: without its report. */
export type RunSummary = Omit<RoutineRun, "report" | "owner"> & { hasReport: boolean };

export interface RoutineState {
  /** Runs scheduled at or before this time do not count (creation, schedule change, resume). */
  since?: string;
  /** The last scheduled time handled (run, failed or skipped). */
  lastScheduledFor?: string;
  /** When the last successful run started: the next report covers what happened since. */
  lastSuccessAt?: string;
  /** The console conversation the reports go to. */
  conversationId?: string;
}

export interface Lease {
  owner: string;
  expiresAt: string;
}

export const RUN_ID_RE = /^(?:s-\d{12}|m-\d{14}-[0-9a-f]{4})$/;

const compact = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
/** A scheduled run's id: s-YYYYMMDDHHMM of the time it was scheduled for (UTC). */
export const scheduledRunId = (scheduledFor: Date) => `s-${compact(scheduledFor).slice(0, 12)}`;
export const manualRunId = (at: Date) => `m-${compact(at)}-${randomBytes(2).toString("hex")}`;

const runsDir = (routineId: string) => `routines/runs/${routineId}/`;
const runKey = (routineId: string, runId: string) => `${runsDir(routineId)}${runId}.json`;
const indexKey = (routineId: string) => `${runsDir(routineId)}index.json`;
const stateKey = (routineId: string) => `routines/state/${routineId}.json`;
const LEASE_KEY = "routines/lease.json";
const TICK_KEY = "routines/tick.enc";

const summaryOf = ({ report, owner: _owner, ...rest }: RoutineRun): RunSummary => ({ ...rest, hasReport: Boolean(report) });

function parse<T>(blob: Buffer | null): T | null {
  if (!blob) return null;
  try {
    return JSON.parse(blob.toString("utf8")) as T;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RoutineRunRepoOptions {
  /**
   * How long a claim waits before reading it back. The store has no
   * compare-and-swap: two instances writing within this window both read
   * back one owner, and only that one runs.
   */
  settleMs?: number;
}

export class RoutineRunRepo {
  private readonly settleMs: number;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly masterKey: Buffer,
    opts: RoutineRunRepoOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? 300;
  }

  /** One change at a time per key (index and state files), in this process. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return run;
  }

  // ---------- Runs ----------

  async get(routineId: string, runId: string): Promise<RoutineRun | null> {
    if (!RUN_ID_RE.test(runId)) return null;
    const run = parse<RoutineRun & { pruned?: boolean }>(await this.store.get(runKey(routineId, runId)));
    return run && !run.pruned && run.id === runId ? run : null;
  }

  /** The last MAX_RUNS runs, newest first, without reports. */
  async list(routineId: string): Promise<RunSummary[]> {
    const index = parse<{ runs?: RunSummary[] }>(await this.store.get(indexKey(routineId)));
    return Array.isArray(index?.runs) ? index.runs : [];
  }

  /**
   * Writes a new run unless one with its id exists, then reads it back after
   * `settleMs`: true when this instance owns it. A scheduled run is claimed
   * once, whichever instance gets there first.
   */
  async claim(run: RoutineRun): Promise<boolean> {
    const key = runKey(run.routineId, run.id);
    if (await this.store.get(key)) return false;
    await this.store.put(key, JSON.stringify(run));
    if (this.settleMs > 0) await sleep(this.settleMs);
    const back = parse<RoutineRun>(await this.store.get(key));
    if (!back || back.owner !== run.owner || back.startedAt !== run.startedAt) return false;
    await this.index(run);
    return true;
  }

  /** Saves a run's new state (and its summary in the index). */
  async save(run: RoutineRun): Promise<void> {
    await this.store.put(runKey(run.routineId, run.id), JSON.stringify(run));
    await this.index(run);
  }

  private index(run: RoutineRun): Promise<void> {
    return this.serial(indexKey(run.routineId), async () => {
      const runs = [summaryOf(run), ...(await this.list(run.routineId)).filter((r) => r.id !== run.id)].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      );
      const kept = runs.slice(0, MAX_RUNS);
      await this.store.put(indexKey(run.routineId), JSON.stringify({ runs: kept }));
      for (const old of runs.slice(MAX_RUNS)) await this.store.put(runKey(run.routineId, old.id), JSON.stringify({ pruned: true }));
    });
  }

  /** Blanks every run of a deleted routine, and its state. */
  async forget(routineId: string): Promise<void> {
    await this.serial(indexKey(routineId), async () => {
      for (const r of await this.list(routineId)) await this.store.put(runKey(routineId, r.id), JSON.stringify({ pruned: true }));
      await this.store.put(indexKey(routineId), JSON.stringify({ runs: [] }));
    });
    await this.serial(stateKey(routineId), () => this.store.put(stateKey(routineId), JSON.stringify({})));
  }

  // ---------- State ----------

  async state(routineId: string): Promise<RoutineState | null> {
    const s = parse<RoutineState>(await this.store.get(stateKey(routineId)));
    return s && typeof s === "object" && Object.keys(s).length ? s : null;
  }

  /** Merges `patch` into the routine's state; undefined values remove a field. */
  updateState(routineId: string, patch: Partial<RoutineState>): Promise<RoutineState> {
    return this.serial(stateKey(routineId), async () => {
      const next: RoutineState = { ...((await this.state(routineId)) ?? {}) };
      for (const [k, v] of Object.entries(patch) as [keyof RoutineState, string | undefined][]) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      await this.store.put(stateKey(routineId), JSON.stringify(next));
      return next;
    });
  }

  // ---------- Lease ----------

  async lease(): Promise<Lease | null> {
    return parse<Lease>(await this.store.get(LEASE_KEY));
  }

  /**
   * Takes or renews the scheduler's lease for `ttlMs`. Refused while another
   * instance holds an unexpired one. A new holder reads it back after
   * `settleMs`, so of two instances starting together only one keeps it.
   */
  async acquireLease(owner: string, now: Date, ttlMs: number): Promise<boolean> {
    const current = await this.lease();
    if (current && current.owner !== owner && Date.parse(current.expiresAt) > now.getTime()) return false;
    await this.store.put(LEASE_KEY, JSON.stringify({ owner, expiresAt: new Date(now.getTime() + ttlMs).toISOString() } satisfies Lease));
    if (current?.owner === owner) return true;
    if (this.settleMs > 0) await sleep(this.settleMs);
    return (await this.lease())?.owner === owner;
  }

  /** Gives the lease up (shutdown), when this instance holds it. */
  async releaseLease(owner: string): Promise<void> {
    const current = await this.lease();
    if (current?.owner === owner) await this.store.put(LEASE_KEY, JSON.stringify({ owner, expiresAt: new Date(0).toISOString() } satisfies Lease));
  }

  // ---------- Tick secret ----------

  /** The secret external schedulers send to POST /routines/tick; made on first use. */
  tickSecret(): Promise<string> {
    return this.serial(TICK_KEY, async () => {
      const blob = await this.store.get(TICK_KEY);
      if (blob) {
        try {
          const secret = decrypt(this.masterKey, blob);
          if (secret.length >= 20) return secret;
        } catch {
          // unreadable (another master key): a new one is made below
        }
      }
      return this.writeTickSecret();
    });
  }

  /** A new secret; the old one stops working at once. */
  rotateTickSecret(): Promise<string> {
    return this.serial(TICK_KEY, () => this.writeTickSecret());
  }

  private async writeTickSecret(): Promise<string> {
    const secret = randomToken(32);
    await this.store.put(TICK_KEY, encrypt(this.masterKey, secret));
    return secret;
  }
}
