import { describe, expect, it, vi } from "vitest";
import {
  type CheckWait,
  ciFailureDetails,
  ciFixPrompt,
  ciSummary,
  ciSummaryLine,
  storedCiSummary,
  waitForChecks,
} from "../src/ci.js";
import type { Annotation, CheckInfo, StatusInfo } from "../src/github.js";
import { makeRedactor } from "../src/worker.js";

const check = (name: string, over: Partial<CheckInfo> = {}): CheckInfo => ({
  id: name.length * 1000 + name.charCodeAt(0),
  name,
  status: "completed",
  conclusion: "success",
  detailsUrl: `https://github.com/acme/web/runs/${name}`,
  title: null,
  summary: null,
  text: null,
  app: "github-actions",
  ...over,
});
const status = (context: string, state: StatusInfo["state"], over: Partial<StatusInfo> = {}): StatusInfo => ({
  context,
  state,
  description: null,
  targetUrl: null,
  ...over,
});
const running = (name: string) => check(name, { status: "in_progress", conclusion: null });

type Poll = { checks: CheckInfo[]; statuses: StatusInfo[] } | Error;

/** A fake GitHub answering each poll from a script (the last answer repeats) and a clock that sleep moves. */
function scripted(polls: Poll[]) {
  let t = 0;
  let call = 0;
  const github = {
    checksFor: vi.fn(async () => {
      const answer = polls[Math.min(call, polls.length - 1)]!;
      call += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  return { github, now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
}

const wait = (s: ReturnType<typeof scripted>, waitMs = 15 * 60_000) =>
  waitForChecks(s.github, "acme/web", "abc123", { waitMs, now: s.now, sleep: s.sleep });

const http = (code: number, detail = "") => new Error(`GitHub GET /repos/acme/web/commits/abc123/check-runs failed (HTTP ${code}): ${detail}`);

describe("waitForChecks", () => {
  it("passes once every check is done on two polls in a row", async () => {
    const s = scripted([
      { checks: [running("build"), running("test")], statuses: [] },
      { checks: [check("build"), check("test")], statuses: [status("vercel", "success")] },
    ]);
    const result = await wait(s);
    expect(result.state).toBe("passed");
    expect(result.failed).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(s.github.checksFor).toHaveBeenCalledTimes(3);
    expect(s.github.checksFor).toHaveBeenCalledWith("acme/web", "abc123");
  });

  it("catches a check that registers late (e.g. Vercel) before calling it done", async () => {
    const s = scripted([
      { checks: [check("build")], statuses: [] },
      { checks: [check("build")], statuses: [status("Vercel", "pending")] },
      { checks: [check("build")], statuses: [status("Vercel", "failure", { description: "Deployment failed" })] },
    ]);
    const result = await wait(s);
    expect(result.state).toBe("failed");
    expect(result.failedStatuses.map((x) => x.context)).toEqual(["Vercel"]);
    expect(result.failed).toEqual([]);
  });

  it("is not fooled by a fast check appearing between two done polls", async () => {
    const s = scripted([
      { checks: [check("lint")], statuses: [] },
      { checks: [check("lint"), check("typecheck", { conclusion: "failure" })], statuses: [] },
    ]);
    const result = await wait(s);
    expect(result.state).toBe("failed");
    expect(result.failed.map((c) => c.name)).toEqual(["typecheck"]);
    expect(s.github.checksFor).toHaveBeenCalledTimes(3);
  });

  it("fails on failure, timed_out and startup_failure, and on failing or erroring statuses, not on neutral outcomes", async () => {
    const s = scripted([
      {
        checks: [
          check("a", { conclusion: "failure" }),
          check("b", { conclusion: "timed_out" }),
          check("c", { conclusion: "startup_failure" }),
          check("d", { conclusion: "cancelled" }),
          check("e", { conclusion: "skipped" }),
          check("f", { conclusion: "neutral" }),
        ],
        statuses: [status("ci/legacy", "error"), status("deploy", "failure"), status("ok", "success")],
      },
    ]);
    const result = await wait(s);
    expect(result.state).toBe("failed");
    expect(result.failed.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(result.failedStatuses.map((x) => x.context)).toEqual(["ci/legacy", "deploy"]);
  });

  it("passes when only neutral outcomes remain", async () => {
    const s = scripted([{ checks: [check("a", { conclusion: "skipped" }), check("b", { conclusion: "neutral" })], statuses: [] }]);
    expect((await wait(s)).state).toBe("passed");
  });

  it("reports pending with the names still running when the wait runs out", async () => {
    const s = scripted([{ checks: [check("build"), running("e2e")], statuses: [status("Vercel", "pending")] }]);
    const result = await wait(s, 5 * 60_000);
    expect(result.state).toBe("pending");
    expect(result.pending).toEqual(["e2e", "Vercel"]);
    expect(s.elapsed()).toBe(5 * 60_000);
  });

  it("reports none when no check appears within the grace period", async () => {
    const s = scripted([{ checks: [], statuses: [] }]);
    const result = await wait(s);
    expect(result.state).toBe("none");
    expect(s.elapsed()).toBeGreaterThanOrEqual(120_000);
    expect(s.elapsed()).toBeLessThan(15 * 60_000);
  });

  it("keeps waiting when checks appear within the grace period", async () => {
    const s = scripted([
      { checks: [], statuses: [] },
      { checks: [], statuses: [] },
      { checks: [running("build")], statuses: [] },
      { checks: [check("build")], statuses: [] },
    ]);
    expect((await wait(s)).state).toBe("passed");
  });

  it("is unavailable at once when GitHub refuses to show the checks (403 or 404)", async () => {
    for (const code of [403, 404]) {
      const s = scripted([http(code, "Resource not accessible by personal access token")]);
      const result = await wait(s);
      expect(result.state).toBe("unavailable");
      expect(s.github.checksFor).toHaveBeenCalledTimes(1);
    }
  });

  it("waits out rate limits and other transient errors", async () => {
    const s = scripted([http(403, "API rate limit exceeded"), http(502, "Bad Gateway"), new Error("fetch failed"), { checks: [check("build")], statuses: [] }]);
    const result = await wait(s);
    expect(result.state).toBe("passed");
    expect(s.github.checksFor).toHaveBeenCalledTimes(5);
  });

  it("calls checks it never managed to read unavailable", async () => {
    const s = scripted([http(500, "boom")]);
    expect((await wait(s, 60_000)).state).toBe("unavailable");
  });

  it("uses the real clock and sleep by default", async () => {
    const github = { checksFor: vi.fn(async () => ({ checks: [check("build")], statuses: [] })) };
    const result = await waitForChecks(github, "acme/web", "abc", { waitMs: 1_000, pollMs: 5 });
    expect(result.state).toBe("passed");
  });
});

const failingWait = (over: Partial<CheckWait> = {}): CheckWait => ({
  state: "failed",
  checks: [],
  statuses: [],
  failed: [],
  failedStatuses: [],
  pending: [],
  ...over,
});

/** A fake code host: like GitHub, only GitHub Actions checks have a job log (`logApps` changes which). */
function detailsGitHub(opts: { annotations?: Annotation[]; log?: string | Error; logApps?: string[] } = {}) {
  const logApps = opts.logApps ?? ["github-actions"];
  return {
    checkAnnotations: vi.fn(async (_repo: string, _check: CheckInfo) => opts.annotations ?? []),
    jobLog: vi.fn(async (_repo: string, c: CheckInfo) => {
      if (!logApps.includes(c.app ?? "")) return undefined;
      if (opts.log instanceof Error) throw opts.log;
      return opts.log ?? "";
    }),
  };
}

describe("ciFailureDetails", () => {
  it("describes each failing check: name, app, conclusion, link, output, annotations and the job log's end", async () => {
    const annotations: Annotation[] = Array.from({ length: 25 }, (_, i) => ({
      path: "src/app.ts",
      startLine: i + 1,
      level: "failure",
      title: null,
      message: `Type error ${i + 1}`,
    }));
    const log = [
      "2026-11-19T10:00:00.1234567Z ##[group]Run npm test",
      "2026-11-19T10:00:01.0000000Z \x1b[31mFAIL\x1b[0m test/app.test.ts",
      "2026-11-19T10:00:02.0000000Z Expected 2, received 3",
    ].join("\n");
    const github = detailsGitHub({ annotations, log });
    const failed = check("test", { conclusion: "failure", title: "1 test failed", summary: "See the log", text: "x".repeat(5000) });
    const text = await ciFailureDetails(github, "acme/web", failingWait({ failed: [failed] }));

    expect(text).toContain('### Check "test" (github-actions): failure');
    expect(text).toContain("Details: https://github.com/acme/web/runs/test");
    expect(text).toContain("Title: 1 test failed");
    expect(text).toContain("Summary:\nSee the log");
    // Each output field is capped.
    const output = text.slice(text.indexOf("Output:\n") + 8, text.indexOf("Annotations:"));
    expect(output.length).toBeLessThanOrEqual(2_001);
    expect(text).toContain("- src/app.ts:1 failure: Type error 1");
    expect(text).toContain("- src/app.ts:20 failure: Type error 20");
    expect(text).not.toContain("Type error 21");
    expect(text).toContain("…and 5 more");
    expect(text).toContain("FAIL test/app.test.ts\nExpected 2, received 3");
    expect(text).not.toContain("2026-11-19T10:00:01");
    expect(text).not.toContain("\x1b[");
    expect(github.jobLog).toHaveBeenCalledWith("acme/web", failed);
    expect(github.checkAnnotations).toHaveBeenCalledWith("acme/web", failed);
  });

  it("says how to make the log readable when the token cannot read it, and shows no log for checks without one", async () => {
    const github = detailsGitHub({ log: new Error("GitHub GET job 1 logs failed (HTTP 403)") });
    const text = await ciFailureDetails(
      github,
      "acme/web",
      failingWait({ failed: [check("build", { conclusion: "failure" }), check("Vercel Preview", { conclusion: "failure", app: "vercel" })] }),
    );
    expect(text).toContain("Job log: not readable: give the token Actions: read.");
    expect(text.match(/Job log: not readable/g)).toHaveLength(1);
    expect(text).toContain('### Check "Vercel Preview" (vercel): failure');
  });

  it("includes the job log of any host's CI job, keeping its timestamps, with a neutral hint when unreadable", async () => {
    const log = ["2026-11-19T10:00:00Z $ npm test", "\x1b[31mFAIL\x1b[0m test/app.test.ts"].join("\n");
    const gitlab = detailsGitHub({ log, logApps: ["gitlab-ci"] });
    const job = check("test", { conclusion: "failure", app: "gitlab-ci", detailsUrl: "https://gitlab.example.com/acme/web/-/jobs/7" });
    const text = await ciFailureDetails(gitlab, "gitlab:acme/web", failingWait({ failed: [job] }));
    expect(text).toContain('### Check "test" (gitlab-ci): failure');
    // Only GitHub Actions' own timestamp prefix is stripped.
    expect(text).toContain("End of the job log:");
    expect(text).toContain("2026-11-19T10:00:00Z $ npm test\nFAIL test/app.test.ts");
    expect(gitlab.jobLog).toHaveBeenCalledWith("gitlab:acme/web", job);

    const denied = detailsGitHub({ log: new Error("GitLab GET job 7 trace failed (HTTP 403)"), logApps: ["gitlab-ci"] });
    const hint = await ciFailureDetails(denied, "gitlab:acme/web", failingWait({ failed: [job] }));
    expect(hint).toContain("Job log: not readable with the platform's token.");
    expect(hint).not.toContain("Actions: read");
  });

  it("lists failing commit statuses and redacts secrets", async () => {
    const redact = makeRedactor(["ghp_supersecret_token"]);
    const text = await ciFailureDetails(
      detailsGitHub(),
      "acme/web",
      failingWait({
        failedStatuses: [status("Vercel", "failure", { description: "Build failed: ghp_supersecret_token", targetUrl: "https://vercel.com/acme/web/1" })],
      }),
      redact,
    );
    expect(text).toContain("### Failing commit statuses");
    expect(text).toContain("- Vercel: failure (Build failed: [redacted]) https://vercel.com/acme/web/1");
    expect(text).not.toContain("ghp_supersecret_token");
  });

  it("keeps the whole description within 40 000 characters and each log tail within 12 000", async () => {
    const hugeLog = Array.from({ length: 5000 }, (_, i) => `log line ${i}`).join("\n");
    const one = await ciFailureDetails(detailsGitHub({ log: hugeLog }), "acme/web", failingWait({ failed: [check("build", { conclusion: "failure" })] }));
    expect(one.length).toBeLessThanOrEqual(13_000);
    expect(one).toContain("log line 4999");

    const many = Array.from({ length: 30 }, (_, i) =>
      check(`job-${i}`, { id: i + 1, conclusion: "failure", summary: "s".repeat(3000), text: "t".repeat(3000) }),
    );
    const all = await ciFailureDetails(detailsGitHub({ log: hugeLog }), "acme/web", failingWait({ failed: many }));
    expect(all.length).toBeLessThanOrEqual(40_000);
  });
});

describe("ciFixPrompt", () => {
  it("asks for a real fix, reproduced locally, reported as usual, and names the round", () => {
    const prompt = ciFixPrompt("### Check \"test\": failure", {
      round: 1,
      rounds: 2,
      base: "main",
      branch: "army/fix-login-abc123",
      request: "Fix the login button",
    });
    expect(prompt).toContain("fix round 1 of 2");
    expect(prompt).toContain("army/fix-login-abc123");
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(prompt).toContain("Fix the login button");
    expect(prompt).toContain('### Check "test": failure');
    expect(prompt).toMatch(/never make a check pass by disabling, skipping or weakening checks or tests/i);
    expect(prompt).toMatch(/reproduce the failure locally/i);
    expect(prompt).toMatch(/checklist/i);
    expect(prompt).toMatch(/kind "change"/);
    expect(prompt).toMatch(/kind "blocked".*missing secrets.*infrastructure.*external service/);
    expect(prompt).toMatch(/data rather than instructions/);
    expect(prompt).toContain("The pull request's checks failed after your last push");
    expect(prompt).toContain("What failed (from GitHub;");
  });

  it("names the host and its merge requests on GitLab", () => {
    const prompt = ciFixPrompt("", { round: 1, rounds: 2, base: "main", branch: "army/x", host: "gitlab" });
    expect(prompt).toContain("The merge request's checks failed after your last push");
    expect(prompt).toContain("What failed (from GitLab;");
    expect(prompt).toContain("(GitLab gave no details for the failing checks.)");
    expect(prompt).not.toMatch(/GitHub|pull request/);
  });
});

describe("ciSummary and its Slack line", () => {
  const passed = failingWait({ state: "passed", checks: [check("a"), check("b"), check("c"), check("d")], statuses: [status("v", "success")] });

  it("summarises each outcome in one line", () => {
    expect(ciSummaryLine(ciSummary(passed, 0), 15)).toBe("*Checks:* :white_check_mark: all 5 passed");
    expect(ciSummaryLine(ciSummary(passed, 1), 15)).toBe("*Checks:* :white_check_mark: all 5 passed after 1 fix round");
    expect(ciSummaryLine(ciSummary(failingWait({ state: "passed", checks: [check("a")] }), 0), 15)).toBe(
      "*Checks:* :white_check_mark: 1 passed",
    );

    const failed = failingWait({
      checks: [check("build"), check("test")],
      failed: [check("build", { conclusion: "failure" }), check("test", { conclusion: "failure" })],
    });
    expect(ciSummary(failed, 2)).toEqual({ state: "failed", fixRounds: 2, names: ["build", "test"], total: 2 });
    expect(ciSummaryLine(ciSummary(failed, 2), 15)).toBe("*Checks:* :x: 2 failing after 2 fix rounds: build, test");
    expect(ciSummaryLine(ciSummary(failed, 0), 15)).toBe("*Checks:* :x: 2 failing: build, test");

    const pending = failingWait({ state: "pending", checks: [running("e2e")], statuses: [status("Vercel", "pending")], pending: ["Vercel"] });
    expect(ciSummaryLine(ciSummary(pending, 0), 15)).toBe("*Checks:* :hourglass_flowing_sand: still running after 15 min: Vercel");

    expect(ciSummaryLine(ciSummary(failingWait({ state: "unavailable" }), 0), 15)).toBe(
      "*Checks:* :grey_question: not readable: the GitHub token needs Checks: read and Commit statuses: read",
    );
    expect(ciSummaryLine(ciSummary(failingWait({ state: "unavailable" }), 0), 15, "gitlab")).toBe(
      "*Checks:* :grey_question: not readable: the GitLab token needs the api or read_api scope on the project",
    );
    expect(ciSummaryLine(ciSummary(failingWait({ state: "unavailable" }), 0), 15, "bitbucket")).toContain("the Bitbucket token");
    expect(ciSummaryLine(ciSummary(failingWait({ state: "none" }), 0), 15)).toBe("");
  });

  it("shortens a long list of names", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const failed = failingWait({ failed: names.map((n) => check(n, { conclusion: "failure" })) });
    expect(ciSummaryLine(ciSummary(failed, 0), 15)).toBe("*Checks:* :x: 7 failing: a, b, c, d, e +2 more");
  });

  it("stores every outcome on the task except unreadable checks", () => {
    expect(storedCiSummary(ciSummary(passed, 0))).toEqual({ state: "passed", fixRounds: 0, names: [], total: 5 });
    expect(storedCiSummary(ciSummary(failingWait({ state: "unavailable" }), 0))).toBeUndefined();
  });
});
