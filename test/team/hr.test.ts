import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetSchema, type Config, ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import {
  EVIDENCE_MAX_CHARS,
  HR_AGENT_ID,
  HR_BUDGET_USD,
  HR_TASKS,
  type HrReview,
  HrReviewRepo,
  HrService,
  KEEP_REVIEWS,
  MAX_PROPOSALS,
  type ProposalContext,
  agentIdFor,
  buildEvidence,
  defaultHrAgent,
  evidenceText,
  headlineOf,
  listSkillsFromStore,
  parseHrAnswer,
  proposalTitle,
  scrubTokens,
  taskOutcome,
  validateProposals,
} from "../../src/team/hr.js";
import type { QueryFn } from "../../src/chat/pointer.js";
import { createApp } from "../../src/server.js";
import { FsStore } from "../../src/core/store.js";
import { type Task, TaskRepo, newTaskId } from "../../src/tasks.js";
import { type AgentSpec, type Team, defaultTeam } from "../../src/team/team.js";
import { UsageRepo } from "../../src/spending/usage.js";

const API_KEY = "sk-ant-api03-secret-key-0123456789abcdef";
const SLACK_TOKEN = "xoxb-1111-2222-secretslacktoken";
const NOW = new Date("2026-11-19T12:00:00Z");

/** A result message as the SDK sends it (only the fields the code reads matter). */
const result = (fields: Record<string, unknown>): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.31, num_turns: 1, ...fields }) as unknown as SDKMessage;

/** A fake `query` that records its calls and yields `messages` (or throws). Never Claude. */
function fakeQuery(messages: SDKMessage[] | Error) {
  const calls: { prompt: unknown; options?: Options }[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      if (messages instanceof Error) throw messages;
      yield* messages;
    })();
  };
  return { queryFn, calls };
}

let seq = 0;
function task(fields: Partial<Task> = {}): Task {
  const at = NOW.getTime() - 3_600_000 + seq++ * 1_000;
  return {
    id: newTaskId(at),
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at + 12 * 60_000).toISOString(),
    status: "done",
    repo: "acme/web",
    channel: "C1",
    threadTs: "1.1",
    userId: "U1",
    instruction: "Fix the login bug",
    kind: "change",
    costUsd: 1.234,
    ...fields,
  };
}

const progress = (labels: string[]): Task["progress"] => ({
  updatedAt: NOW.toISOString(),
  startedAt: NOW.toISOString(),
  now: "",
  plan: [],
  agents: labels.map((label) => ({ label, description: "work", state: "done", minutes: 3, toolUses: 4 })),
  recent: [],
  files: [],
  filesCount: 0,
});

const team = (): Team => defaultTeam();
const ctx = (t: Team = team(), skills?: string[]): ProposalContext => ({ team: t, skills, models: new Set() });

const HIRE = {
  kind: "hire",
  reason: "Three design requests were blocked: nobody owns UI design.",
  evidence: ["task a: blocked, no designer", "3 of 40 tasks were design work"],
  agent: {
    name: "Designer",
    role: "Designer",
    emoji: "art",
    description: "Designs screens and reviews UI changes for layout, contrast and consistency.",
    instructions: "You are the Designer. Review UI changes for layout, contrast and consistency with the design system.",
    access: "run",
    model: "",
    effort: "",
    skills: [],
  },
};

describe("evidence", () => {
  it("covers at most the last HR_TASKS tasks, newest first, with outcomes the console uses", () => {
    const tasks = Array.from({ length: HR_TASKS + 15 }, () => task());
    const e = buildEvidence({ tasks, team: team(), chatModel: "", budget: BudgetSchema.parse({}), now: NOW });
    expect(e.tasks).toHaveLength(HR_TASKS);
    expect(e.tasks[0]!.id).toBe(tasks.at(-1)!.id);
    expect(e.outcomes.done).toBe(HR_TASKS);

    expect(taskOutcome({ status: "done", kind: "blocked" })).toBe("blocked");
    expect(taskOutcome({ status: "done", kind: "answer" })).toBe("answer");
    expect(taskOutcome({ status: "failed", prUrl: "https://github.com/a/b/pull/1" })).toBe("stopped");
    expect(taskOutcome({ status: "failed", error: "The team stopped early: the budget ran out." })).toBe("stopped");
    expect(taskOutcome({ status: "failed", error: "Clone failed" })).toBe("failed");
    expect(taskOutcome({ status: "running" })).toBe("running");
  });

  it("keeps the request's headline only, the reason, agents, duration, cost, CI and preview", () => {
    const t = task({
      instruction: "Fix the <https://acme.dev/login|login page> for <@U123> :fire:\nHere is the full ticket text\nwith private details",
      status: "done",
      kind: "blocked",
      report: { title: "Needs the design for the new login page", summary: "", verification: "", risks: "" },
      progress: progress([":hammer_and_wrench: Coder", ":mag: Reviewer", ":hammer_and_wrench: Coder", ":robot_face: general-purpose"]),
      ci: { state: "failed", fixRounds: 2, names: ["test"], total: 3 },
      preview: { state: "checked" },
      size: { size: "small", model: "", effort: "low" },
      trigger: "monday",
    });
    t.progress!.startedAt = t.createdAt;
    const e = buildEvidence({ tasks: [t], team: team(), chatModel: "", budget: BudgetSchema.parse({}), now: NOW });
    expect(e.tasks[0]).toMatchObject({
      request: "Fix the login page for @U123",
      outcome: "blocked",
      why: "Needs the design for the new login page",
      agents: ["coder", "reviewer", "general-purpose"],
      minutes: 12,
      costUsd: 1.23,
      ci: "failed after 2 fix rounds",
      preview: "checked",
      size: "small",
      trigger: "monday",
    });
    const coder = e.roster.find((a) => a.id === "coder")!;
    expect(coder).toMatchObject({ tasks: 1, troubled: 1 });
    expect(e.roster.find((a) => a.id === "writer")).toMatchObject({ tasks: 0 });
    const text = evidenceText(e);
    expect(text).not.toContain("full ticket text");
    expect(text).not.toContain("private details");
    expect(text).toContain("agents coder, reviewer, general-purpose");
  });

  it("never includes secrets: configured ones and well-known token formats are redacted", () => {
    const redact = (s: string) => s.split(API_KEY).join("[redacted]").split(SLACK_TOKEN).join("[redacted]");
    const leaky = team();
    leaky.agents[0]!.instructions += `\nUse ${API_KEY} for the API.`;
    const tasks = [
      task({ instruction: `Deploy with token ${SLACK_TOKEN} please` }),
      task({ status: "failed", error: `git push failed: ghp_${"a".repeat(36)} rejected`, instruction: "Push it" }),
      task({ instruction: `Use github_pat_${"b".repeat(30)} and Bearer ${"c".repeat(30)}` }),
    ];
    const text = evidenceText(buildEvidence({ tasks, team: leaky, chatModel: "", budget: BudgetSchema.parse({}), now: NOW, redact }));
    for (const secret of [API_KEY, SLACK_TOKEN, "ghp_a", "github_pat_b", "c".repeat(30)]) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
    expect(scrubTokens(`key sk-ant-abcdefghijkl and xoxp-123456789`)).toBe("key [redacted] and [redacted]");
  });

  it("stays within the size cap: the team first, then as many tasks as fit, saying how many were left out", () => {
    const big = team();
    big.agents = big.agents.map((a) => ({ ...a, instructions: "Rule. ".repeat(1300) }));
    big.agents.push(...Array.from({ length: 20 }, (_, i) => ({ ...big.agents[0]!, id: `extra-${i}` })));
    const tasks = Array.from({ length: HR_TASKS }, (_, i) =>
      task({ instruction: `Request number ${i} ${"word ".repeat(40)}`, status: "failed", error: "x".repeat(400) }),
    );
    const evidence = buildEvidence({ tasks, team: big, chatModel: "claude-sonnet-5-5", budget: BudgetSchema.parse({}), now: NOW });
    const text = evidenceText(evidence);
    expect(text.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS);
    expect(text).toContain("## The team (27 agents");
    expect(text).toContain("(cut; ");
    // A tighter cap leaves older tasks out and says so; the newest stay.
    const short = evidenceText(evidence, 12_000);
    expect(short.length).toBeLessThanOrEqual(12_000);
    expect(short).toMatch(/\(\d+ older tasks left out to keep this short\.\)/);
    expect(short).toContain(`task ${evidence.tasks[0]!.id}`);
    expect(short).not.toContain(`task ${evidence.tasks.at(-1)!.id}`);
    expect(headlineOf("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it("includes routing, this month's spend with the caps, and the skills library when there is one", () => {
    const t = team();
    t.pointer.routing.enabled = true;
    const usage = { month: "2026-11", totalUsd: 12.5, chat: { usd: 2.5, count: 30 }, tasks: { usd: 10, count: 8 }, repos: [{ repo: "acme/web", usd: 10, count: 8 }] };
    const budget = BudgetSchema.parse({ monthlyUsd: 50, perRepoUsd: { "acme/web": 20 } });
    const text = evidenceText(buildEvidence({ tasks: [], team: t, chatModel: "", budget, usage, skills: [{ name: "pdf-reports" }], now: NOW }));
    expect(text).toContain("Model routing by task size: on (small → Sonnet 5.5, low effort");
    expect(text).toContain("$12.50 in all: chat $2.50 over 30 replies, repo tasks $10.00 over 8 tasks. Monthly cap $50.00 (25% used).");
    expect(text).toContain("acme/web $10.00 of $20.00");
    expect(text).toContain("- pdf-reports");
    expect(evidenceText(buildEvidence({ tasks: [], team: t, chatModel: "", budget, now: NOW }))).toContain("There is no skills library yet");
  });

  it("reads the skills library's names from the store defensively", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-hr-skills-")));
    expect(await listSkillsFromStore(store)).toBeUndefined();
    await store.put("skills/pdf-reports/SKILL.md", "---\nname: pdf-reports\n---");
    await store.put("skills/brand-voice.json", "{}");
    await store.put("skills/index.json", "{}");
    await store.put("skills/Not A Skill.json", "{}");
    expect(await listSkillsFromStore(store)).toEqual([{ name: "brand-voice" }, { name: "pdf-reports" }]);
  });
});

describe("proposals", () => {
  it("reads the answer from the structured output, else from JSON in the text", () => {
    expect(parseHrAnswer({ summary: "Fine.", proposals: [] }, undefined)).toEqual({ summary: "Fine.", proposals: [] });
    expect(parseHrAnswer(undefined, 'Here: ```json\n{"summary":"Ok","proposals":[{"kind":"skill"}]}\n```')).toEqual({ summary: "Ok", proposals: [{ kind: "skill" }] });
    expect(parseHrAnswer(undefined, "no json")).toBeUndefined();
    expect(parseHrAnswer({ summary: 3 }, "{not json")).toBeUndefined();
  });

  it("accepts a valid hire with a unique id and a normalised emoji, and titles it", () => {
    const { proposals, dropped } = validateProposals([HIRE], ctx());
    expect(dropped).toEqual([]);
    expect(proposals[0]).toMatchObject({
      id: "p1",
      kind: "hire",
      title: "Hire a Designer",
      status: "open",
      agent: { id: "designer", name: "Designer", emoji: ":art:", access: "run", enabled: true, skills: [] },
    });
  });

  it("rejects a bad agent, an unknown agent, a change that changes nothing and an unknown model", () => {
    const { proposals, dropped } = validateProposals(
      [
        { ...HIRE, agent: { ...HIRE.agent, instructions: "Too short" } },
        { ...HIRE, agent: { ...HIRE.agent, access: "admin" } },
        { ...HIRE, agent: { ...HIRE.agent, model: "gpt-9" } },
        { kind: "hire", reason: "No agent" },
        { kind: "change", reason: "Sharpen", evidence: [], agentId: "nobody", changes: { description: "Something new and long enough" } },
        { kind: "change", reason: "Same", evidence: [], agentId: "coder", changes: { access: "write" } },
        { kind: "retire", reason: "Unused", evidence: [], agentId: "ghost" },
        { kind: "skill", reason: "Need", evidence: [] },
        { kind: "promote", reason: "?" },
        "nonsense",
      ],
      ctx(),
    );
    expect(proposals).toEqual([]);
    expect(dropped.map((d) => d.why)).toEqual([
      expect.stringContaining("the agent is not valid (instructions:"),
      expect.stringContaining("the agent is not valid (access:"),
      "an unknown model (gpt-9)",
      "a hire without the agent",
      "names no agent on the team",
      "changes nothing",
      "names no agent on the team",
      "a skill without the need",
      "not a proposal",
      "not a proposal",
    ]);
  });

  it("keeps only the fields a change really changes, with the values before, and titles it", () => {
    const t = team();
    const reviewer = t.agents.find((a) => a.id === "reviewer")!;
    const { proposals } = validateProposals(
      [
        {
          kind: "change",
          reason: "Pointer sends it UI work.",
          evidence: ["4 UI tasks went to Reviewer"],
          agentId: "reviewer",
          changes: { instructions: "You are the Reviewer. Review only the diff, then report findings with severity.", access: "run", id: "hacked", enabled: false },
        },
        { kind: "change", reason: "Cheaper.", evidence: [], agentId: "researcher", changes: { model: "claude-sonnet-5-5" } },
        { kind: "change", reason: "It must test.", evidence: [], agentId: "writer", changes: { access: "run" } },
      ],
      ctx(t),
    );
    expect(proposals[0]).toMatchObject({
      title: "Sharpen Reviewer's instructions",
      agentId: "reviewer",
      changes: { instructions: "You are the Reviewer. Review only the diff, then report findings with severity." },
      before: { instructions: reviewer.instructions },
    });
    expect(Object.keys(proposals[0]!.changes!)).toEqual(["instructions"]);
    expect(proposals[1]!.title).toBe("Move Researcher to Sonnet 5.5");
    expect(proposals[2]!.title).toBe("Change Writer's access to Runs commands");
    expect(proposalTitle({ kind: "retire", agentName: "Writer" })).toBe("Retire Writer");
    expect(proposalTitle({ kind: "skill", skillNeed: "PDF reports" })).toBe("Add a skill for PDF reports");
    expect(proposalTitle({ kind: "hire", agent: { ...HIRE.agent, role: "Analyst" } as AgentSpec })).toBe("Hire an Analyst");
  });

  it("sets skills only from the library, never retires a disabled agent, and keeps at most MAX_PROPOSALS", () => {
    const t = team();
    t.agents.find((a) => a.id === "writer")!.enabled = false;
    const withLibrary = validateProposals([{ ...HIRE, agent: { ...HIRE.agent, skills: ["pdf-reports", "made-up"] } }], ctx(t, ["pdf-reports"]));
    expect(withLibrary.proposals[0]!.agent!.skills).toEqual(["pdf-reports"]);
    const noLibrary = validateProposals([{ ...HIRE, agent: { ...HIRE.agent, skills: ["pdf-reports"] } }], ctx(t));
    expect(noLibrary.proposals[0]!.agent!.skills).toEqual([]);
    expect(validateProposals([{ kind: "retire", reason: "Unused", evidence: [], agentId: "writer" }], ctx(t)).dropped[0]!.why).toBe("Writer is already disabled");

    const many = Array.from({ length: 8 }, (_, i) => ({ kind: "skill", reason: "Needed", evidence: [], skillNeed: `need ${i}` }));
    const capped = validateProposals(many, ctx(t));
    expect(capped.proposals).toHaveLength(MAX_PROPOSALS);
    expect(capped.proposals.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(capped.dropped).toHaveLength(2);
  });

  it("makes agent ids from names like the Team page: unique, valid, never reserved", () => {
    expect(agentIdFor("Designer", new Set())).toBe("designer");
    expect(agentIdFor("Designer", new Set(["designer"]))).toBe("designer-2");
    expect(agentIdFor("Plan", new Set())).toBe("plan-2");
    expect(agentIdFor("3D Artist", new Set())).toBe("agent-3d-artist");
    expect(agentIdFor("Café Ops", new Set())).toBe("cafe-ops");
    expect(agentIdFor("!", new Set())).toBe("agent");
  });
});

// ---------- The service ----------

async function setup(opts: { messages?: SDKMessage[] | Error; mutate?: (c: Config) => void; capOk?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "army-hr-"));
  const store = new FsStore(dir);
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = API_KEY;
    c.slack.botToken = SLACK_TOKEN;
    opts.mutate?.(c);
  });
  const tasks = new TaskRepo(store);
  const usage = new UsageRepo(store, tasks);
  const q = fakeQuery(opts.messages ?? [result({ structured_output: { summary: "The team fits.", proposals: [HIRE] } })]);
  const checkChat = vi.fn(async () => (opts.capOk === false ? { ok: false as const, error: "This month's Claude budget is used up." } : { ok: true as const }));
  const notify = vi.fn(async () => undefined);
  const hr = new HrService({
    store,
    tasks,
    usage,
    spending: { checkChat, notify },
    config: () => configRepo.load(true),
    updateConfig: (m) => configRepo.update(m),
    queryFn: q.queryFn,
    now: () => NOW,
  });
  return { store, configRepo, tasks, usage, q, hr, checkChat, notify };
}

describe("HrService.review", () => {
  it("runs one locked-down call with HR's instructions, records the cost and stores the review", async () => {
    const s = await setup();
    await s.tasks.save(task({ instruction: `Ship it with ${API_KEY}` }));
    const r = await s.hr.review();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review).toMatchObject({ summary: "The team fits.", costUsd: 0.31, instructionsFrom: "team", tasksSeen: 1, dropped: [] });
    expect(r.review.proposals.map((p) => p.title)).toEqual(["Hire a Designer"]);

    expect(s.q.calls).toHaveLength(1);
    const options = s.q.calls[0]!.options!;
    expect(options).toMatchObject({
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      verbatimPrompts: true,
      maxBudgetUsd: HR_BUDGET_USD,
      outputFormat: { type: "json_schema" },
      effort: "medium",
    });
    expect(HR_BUDGET_USD).toBeLessThanOrEqual(0.5);
    expect(Object.keys(options.env ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "HOME", "LANG", "PATH"]);
    expect(options.systemPrompt).toContain(defaultHrAgent().instructions.split("\n")[0]);
    expect(options.systemPrompt).toContain("never deleted");
    // The evidence goes in the user turn, never a secret.
    expect(s.q.calls[0]!.prompt).toContain("<evidence>");
    expect(String(s.q.calls[0]!.prompt)).not.toContain(API_KEY);
    expect(String(s.q.calls[0]!.prompt)).not.toContain(SLACK_TOKEN);

    expect((await s.usage.month(NOW)).chat).toEqual({ usd: 0.31, count: 1 });
    expect(s.notify).toHaveBeenCalled();
    expect((await s.hr.list()).map((x) => x.id)).toEqual([r.review.id]);
  });

  it("uses the owner's HR instructions and model, or the built-in instructions without HR on the team", async () => {
    const own = await setup({
      mutate: (c) => {
        const hr = c.team.agents.find((a) => a.id === HR_AGENT_ID)!;
        hr.instructions = "You are our HR lead. Focus on cost first, then quality.";
        hr.model = "claude-sonnet-5-5";
      },
    });
    await own.hr.review();
    expect(own.q.calls[0]!.options!.systemPrompt).toContain("You are our HR lead. Focus on cost first");
    expect(own.q.calls[0]!.options!.model).toBe("claude-sonnet-5-5");

    const none = await setup({
      mutate: (c) => {
        c.team.agents = c.team.agents.filter((a) => a.id !== HR_AGENT_ID);
        c.team.pointer.model = "claude-opus-5-5";
      },
    });
    const r = await none.hr.review();
    expect(r.ok && r.review.instructionsFrom).toBe("default");
    expect(none.q.calls[0]!.options!.systemPrompt).toContain("You are HR for a team of AI agents.");
    expect(none.q.calls[0]!.options!.model).toBe("claude-opus-5-5");
  });

  it("is refused when the monthly cap is used up, without calling Claude", async () => {
    const s = await setup({ capOk: false });
    expect(await s.hr.review()).toEqual({ ok: false, status: 409, error: "This month's Claude budget is used up." });
    expect(s.q.calls).toHaveLength(0);
    expect(await s.hr.list()).toEqual([]);
  });

  it("needs the Claude key", async () => {
    const s = await setup({ mutate: (c) => void (c.anthropic.apiKey = undefined) });
    expect(await s.hr.review()).toMatchObject({ ok: false, status: 400 });
    expect(s.q.calls).toHaveLength(0);
  });

  it("reports a failed call with its cost (recorded), redacted, and stores nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await setup({ messages: [result({ subtype: "error_max_budget_usd", total_cost_usd: 0.5 })] });
    const r = await s.hr.review();
    expect(r).toEqual({
      ok: false,
      status: 502,
      error: "HR could not finish the review: it stopped at the $0.50 budget for a review. The attempt cost $0.50.",
      costUsd: 0.5,
    });
    expect((await s.usage.month(NOW)).chat.usd).toBe(0.5);

    const thrown = await setup({ messages: new Error(`spawn failed with ${API_KEY}`) });
    const t = await thrown.hr.review();
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).not.toContain(API_KEY);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(API_KEY);
    expect(await thrown.hr.list()).toEqual([]);
    errors.mockRestore();
  });

  it("runs one review at a time", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.hr.review(), s.hr.review()]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, status: 409 });
  });
});

describe("review storage", () => {
  it("lists reviews newest first and keeps only the last KEEP_REVIEWS", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-hr-store-")));
    const repo = new HrReviewRepo(store);
    const ids: string[] = [];
    for (let i = 0; i < KEEP_REVIEWS + 3; i++) {
      const id = newTaskId(NOW.getTime() + i * 1000);
      ids.push(id);
      await repo.save({ id, createdAt: NOW.toISOString(), summary: `r${i}`, proposals: [], costUsd: 0.1, model: "", instructionsFrom: "team", tasksSeen: 0, dropped: [] });
      await repo.prune();
    }
    const listed = await repo.list();
    expect(listed).toHaveLength(KEEP_REVIEWS);
    expect(listed[0]!.id).toBe(ids.at(-1));
    expect(listed.at(-1)!.id).toBe(ids[3]);
    // Older ones keep only a marker.
    expect(await repo.get(ids[0]!)).toBeNull();
    expect(JSON.parse((await store.get(`hr/reviews/${ids[0]}.json`))!.toString("utf8"))).toEqual({ id: ids[0], deleted: true });
    expect(await repo.get("../../config")).toBeNull();
  });
});

describe("applying and dismissing proposals", () => {
  const answer = {
    summary: "Some changes.",
    proposals: [
      HIRE,
      { kind: "change", reason: "Picked wrongly.", evidence: ["x"], agentId: "reviewer", changes: { description: "Reviews the diff for bugs and security problems; never fixes them." } },
      { kind: "retire", reason: "Unused.", evidence: ["0 of 40 tasks"], agentId: "writer" },
      { kind: "skill", reason: "Reports.", evidence: ["5 PDF requests"], skillNeed: "PDF reports", agentId: "writer" },
    ],
  };
  let s: Awaited<ReturnType<typeof setup>>;
  let review: HrReview;
  beforeEach(async () => {
    s = await setup({ messages: [result({ structured_output: answer })] });
    const r = await s.hr.review();
    if (!r.ok) throw new Error(r.error);
    review = r.review;
  });

  it("hire adds the agent with a unique id", async () => {
    await s.configRepo.update((c) => {
      c.team.agents.push({ ...c.team.agents[0]!, id: "designer", name: "Old designer" });
    });
    const r = await s.hr.apply(review.id, "p1");
    expect(r).toMatchObject({ ok: true, agentId: "designer-2", proposal: { status: "applied", appliedAgentId: "designer-2", decidedAt: NOW.toISOString() } });
    const added = (await s.configRepo.load(true)).team.agents.find((a) => a.id === "designer-2");
    expect(added).toMatchObject({ name: "Designer", access: "run", enabled: true });
    expect((await s.hr.list())[0]!.proposals[0]!.status).toBe("applied");
    // Twice is refused.
    expect(await s.hr.apply(review.id, "p1")).toMatchObject({ ok: false, status: 409, error: "This proposal was already applied." });
  });

  it("change merges the fields into the agent", async () => {
    expect(await s.hr.apply(review.id, "p2")).toMatchObject({ ok: true, agentId: "reviewer" });
    const reviewer = (await s.configRepo.load(true)).team.agents.find((a) => a.id === "reviewer")!;
    expect(reviewer.description).toBe("Reviews the diff for bugs and security problems; never fixes them.");
    expect(reviewer.access).toBe("run");
    expect(reviewer.instructions).toContain("You are the Reviewer.");
  });

  it("retire disables the agent and never deletes it", async () => {
    expect(await s.hr.apply(review.id, "p3")).toMatchObject({ ok: true, agentId: "writer" });
    const agents = (await s.configRepo.load(true)).team.agents;
    expect(agents.find((a) => a.id === "writer")).toMatchObject({ enabled: false });
    expect(agents).toHaveLength(defaultTeam().agents.length);
  });

  it("skill marks it applied and returns the need for the Skills page, without changing the team", async () => {
    const before = (await s.configRepo.load(true)).team;
    expect(await s.hr.apply(review.id, "p4")).toMatchObject({ ok: true, skillNeed: "PDF reports", proposal: { status: "applied" } });
    expect((await s.configRepo.load(true)).team).toEqual(before);
  });

  it("dismiss marks it dismissed; it cannot be applied after", async () => {
    expect(await s.hr.dismiss(review.id, "p1")).toMatchObject({ ok: true, proposal: { status: "dismissed" } });
    expect(await s.hr.apply(review.id, "p1")).toMatchObject({ ok: false, status: 409, error: "This proposal was already dismissed." });
    expect((await s.configRepo.load(true)).team.agents.some((a) => a.name === "Designer")).toBe(false);
  });

  it("refuses unknown reviews and proposals, agents that left, and a full team", async () => {
    expect(await s.hr.apply(newTaskId(), "p1")).toMatchObject({ ok: false, status: 404, error: "Review not found." });
    expect(await s.hr.apply(review.id, "p9")).toMatchObject({ ok: false, status: 404, error: "Proposal not found." });
    await s.configRepo.update((c) => {
      c.team.agents = c.team.agents.filter((a) => a.id !== "reviewer");
    });
    expect(await s.hr.apply(review.id, "p2")).toMatchObject({ ok: false, status: 409, error: "Reviewer is no longer on the team." });
    await s.configRepo.update((c) => {
      while (c.team.agents.length < 30) c.team.agents.push({ ...defaultHrAgent(), id: `extra-${c.team.agents.length}` });
    });
    expect(await s.hr.apply(review.id, "p1")).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("at most 30 agents") });
    expect((await s.hr.list())[0]!.proposals[0]!.status).toBe("open");
  });

  it("adds the default HR agent once", async () => {
    await s.configRepo.update((c) => {
      c.team.agents = c.team.agents.filter((a) => a.id !== HR_AGENT_ID);
    });
    expect(await s.hr.addHr()).toMatchObject({ ok: true, agent: { id: HR_AGENT_ID, name: "HR" } });
    expect(await s.hr.addHr()).toMatchObject({ ok: false, status: 409 });
  });
});

// ---------- Admin API ----------

describe("HR routes", () => {
  let base = "";
  let cookie = "";
  let close: () => void;
  let dir = "";
  const q = fakeQuery([result({ structured_output: { summary: "Hire one.", proposals: [HIRE, { kind: "retire", reason: "Unused.", evidence: [], agentId: "writer" }] } })]);
  const post = (path: string, body: unknown = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).json();

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    dir = await mkdtemp(join(tmpdir(), "army-hr-api-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { hrQuery: q.queryFn });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => close());

  it("needs a session", async () => {
    expect((await fetch(`${base}/api/hr/reviews`)).status).toBe(401);
    expect((await fetch(`${base}/api/hr/review`, { method: "POST" })).status).toBe(401);
  });

  it("refuses a review before Claude is connected", async () => {
    const res = await post("/api/hr/review");
    expect(res.status).toBe(400);
    expect(q.calls).toHaveLength(0);
  });

  it("reviews, lists, applies and dismisses", async () => {
    expect((await post("/api/anthropic", { apiKey: "sk-ant-test-0000000000" })).status).toBe(200);
    const res = await post("/api/hr/review");
    expect(res.status).toBe(200);
    const { review } = (await res.json()) as { review: HrReview };
    expect(review.proposals.map((p) => p.kind)).toEqual(["hire", "retire"]);
    expect((await get("/api/hr/reviews")).reviews[0].id).toBe(review.id);

    const applied = await post(`/api/hr/reviews/${review.id}/proposals/p1/apply`);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ ok: true, agentId: "designer", proposal: { status: "applied" } });
    expect((await get("/api/state")).config.team.agents.some((a: AgentSpec) => a.id === "designer")).toBe(true);

    const dismissed = await post(`/api/hr/reviews/${review.id}/proposals/p2/dismiss`);
    expect(await dismissed.json()).toMatchObject({ ok: true, review: { proposals: [{ status: "applied" }, { status: "dismissed" }] } });
    expect((await post(`/api/hr/reviews/${review.id}/proposals/p2/apply`)).status).toBe(409);
    expect((await post(`/api/hr/reviews/not-an-id/proposals/p1/apply`)).status).toBe(404);
    expect((await post(`/api/hr/reviews/${review.id}/proposals/x/apply`)).status).toBe(404);
  });

  it("adds HR to the team", async () => {
    expect((await post("/api/hr/agent")).status).toBe(409);
    const config = (await get("/api/state")).config;
    const agents = config.team.agents.filter((a: AgentSpec) => a.id !== HR_AGENT_ID);
    expect((await post("/api/team", { pointer: config.team.pointer, agents })).status).toBe(200);
    expect((await post("/api/hr/agent")).status).toBe(200);
    expect((await get("/api/state")).config.team.agents.some((a: AgentSpec) => a.id === HR_AGENT_ID)).toBe(true);
  });
});
