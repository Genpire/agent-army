import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicRuntime, buildRuntime } from "../../src/ai/ai-providers.js";
import type { ProviderRuntime } from "../../src/ai/ai-providers.js";
import type { FallbackNote } from "../../src/ai/routing.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { MIN_TASK_USD } from "../../src/spending/budget.js";
import { type RouteRun, onboardingError, runOnRoute, takeOverPrompt } from "../../src/tasks/worker.js";

const KIMI_KEY = "sk-kimi-route-secret-0042";
const kimi = buildRuntime("kimi", { secrets: { apiKey: KIMI_KEY }, settings: {}, models: {} });
const claude = anthropicRuntime("sk-ant-route-secret-0042");
const deepseek = buildRuntime("deepseek", { secrets: { apiKey: "sk-deepseek-route-secret-0042" }, settings: {}, models: {} });
const RATE_LIMITED = { kind: "rate_limit", reason: "rate limited" } as const;

describe("the team's first run on the task route (real git)", () => {
  const plainGit = promisify(execFile);
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function checkout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "army-route-")));
    roots.push(root);
    const repoDir = join(root, "repo");
    const home = join(root, "home");
    await mkdir(repoDir);
    await mkdir(home);
    const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const sh = async (...args: string[]) =>
      (await plainGit("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repoDir, env })).stdout.trim();
    await sh("init", "--quiet", "-b", "main");
    await writeFile(join(repoDir, "login.ts"), "broken\n");
    await sh("add", "-A");
    await sh("commit", "--quiet", "-m", "base");
    return { repoDir, sh };
  }

  type CapLeft = { usd: number; scope: "monthly" | "repo" | "provider" } | undefined;

  /** A route of runtimes whose runs answer by provider; `current` follows switchTo as the worker's does. */
  function route(runtimes: ProviderRuntime[], runs: Record<string, (prompt: string, budgetUsd: number) => Promise<RouteRun>>) {
    let current = runtimes[0]!;
    const seen: { provider: string; prompt: string; budgetUsd: number }[] = [];
    const switched: { to: string; note: FallbackNote }[] = [];
    const short: { note: FallbackNote; left: number }[] = [];
    const capped: { note: FallbackNote; left: number }[] = [];
    const switchFailed: { note: FallbackNote; error: string }[] = [];
    return {
      seen,
      switched,
      short,
      capped,
      switchFailed,
      options: (
        o: { prompt?: string; budgetUsd?: number; aborted?: () => boolean; capLeft?: (provider: string) => Promise<CapLeft>; sessionFails?: string } = {},
      ) => ({
        runtimes,
        prompt: o.prompt ?? "Fix the login bug.",
        budgetUsd: o.budgetUsd ?? 10,
        aborted: o.aborted ?? (() => false),
        run: async (prompt: string, budgetUsd: number) => {
          seen.push({ provider: current.provider, prompt, budgetUsd });
          return runs[current.provider]!(prompt, budgetUsd);
        },
        switchTo: async (next: ProviderRuntime, note: FallbackNote) => {
          // As the worker's: the next provider's session first, which can fail before anything changed.
          if (o.sessionFails === next.provider) throw new Error(`${next.label} could not start its session`);
          switched.push({ to: next.provider, note });
          current = next;
        },
        ...(o.capLeft ? { capLeft: o.capLeft } : {}),
        onShort: (note: FallbackNote, left: number) => short.push({ note, left }),
        onCapped: (note: FallbackNote, left: number) => capped.push({ note, left }),
        onSwitchFailed: (note: FallbackNote, err: unknown) => switchFailed.push({ note, error: err instanceof Error ? err.message : String(err) }),
      }),
    };
  }

  it("hands the work to the next provider, from the checkout as the failed run left it, with what is left of the budget", async () => {
    const { repoDir, sh } = await checkout();
    let sawHalfDone = "";
    const r = route([kimi, claude], {
      kimi: async () => {
        // The failed run got halfway: its change stays in the checkout, uncommitted.
        await writeFile(join(repoDir, "login.ts"), "half fixed\n");
        await writeFile(join(repoDir, "notes.md"), "plan\n");
        return { costUsd: 1.25, turns: 4, providerFailure: RATE_LIMITED };
      },
      anthropic: async () => {
        sawHalfDone = await readFile(join(repoDir, "login.ts"), "utf8");
        await writeFile(join(repoDir, "login.ts"), "fixed\n");
        return { costUsd: 2, turns: 6 };
      },
    });
    const out = await runOnRoute(r.options());

    expect(r.seen.map((s) => s.provider)).toEqual(["kimi", "anthropic"]);
    expect(r.switched).toEqual([{ to: "anthropic", note: { from: "kimi", to: "anthropic", reason: "rate limited" } }]);
    // Nothing was reset between the runs: the next one started from the failed one's work.
    expect(sawHalfDone).toBe("half fixed\n");
    expect((await sh("status", "--porcelain")).split("\n")).toEqual(["M login.ts", "?? notes.md"]);
    // Told what happened, then the task's own prompt.
    const told = r.seen[1]!.prompt;
    expect(told).toBe(takeOverPrompt("Fix the login bug.", { provider: "Kimi", reason: "rate limited" }));
    expect(told).toMatch(/^A previous attempt at this task, on Kimi, stopped before it finished \(rate limited\)\. Its changes are in the checkout/);
    expect(told).toContain("`git status`");
    expect(told.endsWith("\n\nFix the login bug.")).toBe(true);
    // The task's budget is kept: the next run spends what the failed one left.
    expect(r.seen[0]!.budgetUsd).toBe(10);
    expect(r.seen[1]!.budgetUsd).toBe(8.75);
    expect(out).toMatchObject({ costUsd: 3.25, turns: 10, fallback: [{ from: "kimi", to: "anthropic", reason: "rate limited" }] });
    expect(out.run.providerFailure).toBeUndefined();
  });

  it("goes down the whole route while providers fail, and ends with the last run", async () => {
    const r = route([kimi, deepseek, claude], {
      kimi: async () => ({ costUsd: 0.5, turns: 1, providerFailure: RATE_LIMITED }),
      deepseek: async () => ({ costUsd: 0.25, turns: 1, providerFailure: { kind: "billing_error", reason: "out of credit" } }),
      anthropic: async () => ({ costUsd: 1, turns: 3, providerFailure: { kind: "overloaded", reason: "overloaded" } }),
    });
    const out = await runOnRoute(r.options());
    expect(r.seen.map((s) => [s.provider, s.budgetUsd])).toEqual([
      ["kimi", 10],
      ["deepseek", 9.5],
      ["anthropic", 9.25],
    ]);
    expect(r.seen[2]!.prompt).toContain("on DeepSeek, stopped before it finished (out of credit)");
    expect(out.fallback.map((n) => n.to)).toEqual(["deepseek", "anthropic"]);
    // The last provider failed too: the task stops with that run, as before routes.
    expect(out.run.providerFailure?.reason).toBe("overloaded");
    expect(out.costUsd).toBe(1.75);
  });

  it("does not move on for the work's own failure, out of time, or with too little budget left", async () => {
    const own = route([kimi, claude], { kimi: async () => ({ costUsd: 3, turns: 30 }), anthropic: async () => ({ costUsd: 0, turns: 0 }) });
    await runOnRoute(own.options());
    expect(own.seen).toHaveLength(1);
    expect(own.switched).toEqual([]);

    let timeUp = false;
    const late = route([kimi, claude], {
      kimi: async () => {
        timeUp = true;
        return { costUsd: 1, turns: 1, providerFailure: RATE_LIMITED };
      },
      anthropic: async () => ({ costUsd: 0, turns: 0 }),
    });
    await runOnRoute(late.options({ aborted: () => timeUp }));
    expect(late.seen).toHaveLength(1);

    const spent = route([kimi, claude], {
      kimi: async () => ({ costUsd: 9.6, turns: 12, providerFailure: RATE_LIMITED }),
      anthropic: async () => ({ costUsd: 0, turns: 0 }),
    });
    const out = await runOnRoute(spent.options());
    expect(spent.seen).toHaveLength(1);
    expect(spent.switched).toEqual([]);
    expect(spent.short).toEqual([{ note: { from: "kimi", to: "anthropic", reason: "rate limited" }, left: 0.4 }]);
    expect(0.4).toBeLessThan(MIN_TASK_USD);
    expect(out.fallback).toEqual([]);

    const alone = route([kimi], { kimi: async () => ({ costUsd: 1, turns: 1, providerFailure: RATE_LIMITED }) });
    expect((await runOnRoute(alone.options())).run.providerFailure).toEqual(RATE_LIMITED);
    expect(alone.seen).toHaveLength(1);
  });

  it("bounds the next run by what is left of that provider's caps, and skips one whose own cap leaves too little", async () => {
    // Claude has $3.40 left of its own cap: the takeover may spend that much, not the $8.75 left of the task's budget.
    const asked: string[] = [];
    const bounded = route([kimi, claude], {
      kimi: async () => ({ costUsd: 1.25, turns: 4, providerFailure: RATE_LIMITED }),
      anthropic: async () => ({ costUsd: 2, turns: 6 }),
    });
    const out = await runOnRoute(
      bounded.options({
        capLeft: async (provider) => {
          asked.push(provider);
          return provider === "anthropic" ? { usd: 3.409, scope: "provider" } : undefined;
        },
      }),
    );
    expect(asked).toEqual(["anthropic"]);
    expect(bounded.seen.map((s) => [s.provider, s.budgetUsd])).toEqual([
      ["kimi", 10],
      ["anthropic", 3.4],
    ]);
    expect(out.costUsd).toBe(3.25);

    // DeepSeek's own cap is used up: skipped, Claude takes over from Kimi.
    const skipped = route([kimi, deepseek, claude], {
      kimi: async () => ({ costUsd: 1, turns: 1, providerFailure: RATE_LIMITED }),
      deepseek: async () => ({ costUsd: 0, turns: 0 }),
      anthropic: async () => ({ costUsd: 2, turns: 3 }),
    });
    const past = await runOnRoute(skipped.options({ capLeft: async (p) => (p === "deepseek" ? { usd: 0.2, scope: "provider" } : undefined) }));
    expect(skipped.seen.map((s) => s.provider)).toEqual(["kimi", "anthropic"]);
    expect(skipped.capped).toEqual([{ note: { from: "kimi", to: "deepseek", reason: "rate limited" }, left: 0.2 }]);
    expect(past.fallback).toEqual([{ from: "kimi", to: "anthropic", reason: "rate limited" }]);
    expect(skipped.seen[1]!.prompt).toContain("on Kimi, stopped before it finished (rate limited)");

    // The monthly cap leaves too little: no provider can take over, so the task stops with the failed run.
    const monthly = route([kimi, deepseek, claude], {
      kimi: async () => ({ costUsd: 1, turns: 1, providerFailure: RATE_LIMITED }),
      deepseek: async () => ({ costUsd: 0, turns: 0 }),
      anthropic: async () => ({ costUsd: 0, turns: 0 }),
    });
    const stopped = await runOnRoute(monthly.options({ capLeft: async () => ({ usd: 0.3, scope: "monthly" }) }));
    expect(monthly.seen).toHaveLength(1);
    expect(monthly.capped).toEqual([]);
    expect(monthly.short).toEqual([{ note: { from: "kimi", to: "deepseek", reason: "rate limited" }, left: 0.3 }]);
    expect(stopped.run.providerFailure).toEqual(RATE_LIMITED);
  });

  it("stops with the failed run, its cost kept, when the next provider cannot be set up", async () => {
    const r = route([kimi, claude], {
      kimi: async () => ({ costUsd: 1.5, turns: 5, providerFailure: RATE_LIMITED }),
      anthropic: async () => ({ costUsd: 9, turns: 9 }),
    });
    const out = await runOnRoute(r.options({ sessionFails: "anthropic" }));
    expect(r.seen.map((s) => s.provider)).toEqual(["kimi"]);
    expect(r.switched).toEqual([]);
    expect(r.switchFailed).toEqual([{ note: { from: "kimi", to: "anthropic", reason: "rate limited" }, error: "Claude could not start its session" }]);
    expect(out).toMatchObject({ costUsd: 1.5, turns: 5, fallback: [] });
    expect(out.run.providerFailure).toEqual(RATE_LIMITED);
  });

  it("does not run the task again after the team changed things in apps, and tells the next run what it did in the browser", async () => {
    const stripe = { tool: "mcp__app-stripe__create_issue", count: 2 };
    const held = route([kimi, claude], {
      kimi: async () => ({ costUsd: 1, turns: 3, providerFailure: RATE_LIMITED, outside: { app: [stripe], browser: [{ tool: "mcp__browser__browser_click", count: 1 }] } }),
      anthropic: async () => ({ costUsd: 2, turns: 2 }),
    });
    const out = await runOnRoute(held.options());
    expect(held.seen).toHaveLength(1);
    expect(held.switched).toEqual([]);
    expect(out.heldBack).toBe(
      "Kimi failed (rate limited) after the team had changed things in apps (mcp__app-stripe__create_issue (2 times)), so Claude did not take over: running the task again could do them twice.",
    );
    expect(out.costUsd).toBe(1);

    // Browser actions only: the next provider takes over, told which ones are done; they add up over the runs that failed.
    const browsed = route([kimi, deepseek, claude], {
      kimi: async () => ({
        costUsd: 1,
        turns: 1,
        providerFailure: RATE_LIMITED,
        outside: { app: [], browser: [{ tool: "mcp__browser__browser_click", count: 3 }, { tool: "mcp__browser__browser_fill_form", count: 1 }] },
      }),
      deepseek: async () => ({ costUsd: 1, turns: 1, providerFailure: RATE_LIMITED, outside: { app: [], browser: [{ tool: "mcp__browser__browser_click", count: 1 }] } }),
      anthropic: async () => ({ costUsd: 1, turns: 1 }),
    });
    const done = await runOnRoute(browsed.options());
    expect(done.heldBack).toBeUndefined();
    expect(browsed.seen.map((s) => s.provider)).toEqual(["kimi", "deepseek", "anthropic"]);
    expect(browsed.seen[1]!.prompt).toContain(
      "Before it stopped, the team also acted on web pages in the browser, which the checkout does not show: mcp__browser__browser_click (3 times), mcp__browser__browser_fill_form. Those actions happened: do not do them again",
    );
    expect(browsed.seen[2]!.prompt).toContain("mcp__browser__browser_click (4 times), mcp__browser__browser_fill_form");
    // Without any: the prompt says nothing of a browser.
    expect(takeOverPrompt("Fix it.", { provider: "Kimi", reason: "rate limited", browser: [] })).not.toContain("browser");
  });
});

describe("onboarding with a task route", () => {
  const config = (patch: (c: Config) => void): Config => {
    const c = ConfigSchema.parse({});
    c.slack.botToken = "xoxb-route-1";
    patch(c);
    return c;
  };

  it("needs one provider of the task route that can run", () => {
    const kimiOnly = config((c) => {
      c.ai.providers.kimi = { secrets: { apiKey: KIMI_KEY }, settings: {}, models: {} };
      c.ai.routes = { tasks: ["deepseek", "kimi"] };
    });
    expect(onboardingError({ channel: "C1" }, kimiOnly)).toBeUndefined();
    const none = config((c) => {
      c.ai.routes = { tasks: ["deepseek", "kimi"] };
    });
    expect(onboardingError({ channel: "C1" }, none)).toMatch(/^Onboarding is incomplete: No AI provider can run this\. DeepSeek: .* Kimi: /);
    // Claude alone, not connected: as before routes.
    expect(onboardingError({ channel: "web" }, config(() => undefined))).toBe("Onboarding is incomplete (Claude missing).");
  });
});
