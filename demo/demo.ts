/**
 * `npm run demo`: the real admin console with sample data, no accounts needed.
 *
 * Starts the server on a fresh temporary data folder seeded with a fictional
 * company (Acme): a connected-looking setup, the default team, repo tasks in
 * every state with their timelines and screenshots, conversations, memory,
 * project notes and repo setup. Pointer is replaced by a demo brain that
 * streams canned answers, and repo tasks by a simulated worker, so nothing
 * calls Claude, Slack, GitHub or monday.com. Every credential is fake.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigRepo, resolveMasterKey } from "../src/core/config.js";
import { type Conversation, ConversationRepo } from "../src/chat/conversations.js";
import { hashPassword } from "../src/core/crypto.js";
import { MemoryRepo } from "../src/chat/memory.js";
import { NotesRepo } from "../src/chat/notes.js";
import type { PlanItem, ProgressSnapshot } from "../src/tasks/progress.js";
import type { PointerBrain } from "../src/chat/pointer-types.js";
import type { Runner } from "../src/tasks/runner.js";
import { ScreenshotRepo } from "../src/tasks/screenshots.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/core/store.js";
import { TimelineRecorder } from "../src/tasks/task-events.js";
import { type Task, TaskRepo, WEB_CHANNEL, newTaskId } from "../src/tasks/tasks.js";
import { type Team, agentLabel, defaultTeam } from "../src/team/team.js";
import type { Routine } from "../src/core/config.js";
import { nextRuns, parseCron } from "../src/routines/cron.js";
import { type RoutineRun, RoutineRunRepo, scheduledRunId } from "../src/routines/runs.js";

export const DEMO_PASSWORD = "agent-army-demo";

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

const dataDir = process.env.DEMO_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "agent-army-demo-")));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  STORAGE: "fs",
  DATA_DIR: dataDir,
  MASTER_KEY: process.env.MASTER_KEY ?? randomBytes(32).toString("base64"),
  // The demo's credentials are fake: saving forms must not try to verify them.
  SKIP_VALIDATION: "1",
  RUNNER: "local",
};

const store = new FsStore(dataDir);
const key = await resolveMasterKey(store, env);
const configRepo = new ConfigRepo(store, key, 0);
const tasks = new TaskRepo(store);
const conversations = new ConversationRepo(store);
const shots = new ScreenshotRepo(store, key);
const asset = (name: string) => readFile(new URL(`./assets/${name}`, import.meta.url));

/** The demo team: the default agents, with the names a small company would give them (the Office shows them at their desks). */
const DEMO_NAMES: Record<string, string> = { coder: "Sara", reviewer: "Omar", qa: "Lina", researcher: "Kenji", writer: "Maya", hr: "Noor", scout: "Diego" };
const TEAM: Team = defaultTeam();
for (const a of TEAM.agents) a.name = DEMO_NAMES[a.id] ?? a.name;
/** Apps the demo agents have (seedConfig connects them): Sara and Lina read Sentry and Vercel, Kenji reads Linear and Notion. */
const DEMO_AGENT_APPS: Record<string, string[]> = { coder: ["app-sentry", "app-vercel"], qa: ["app-sentry", "app-vercel"], researcher: ["app-linear", "app-notion"] };
for (const a of TEAM.agents) a.apps = DEMO_AGENT_APPS[a.id] ?? [];
/** How the worker labels an agent's work, e.g. ":hammer_and_wrench: Sara (Coder)". */
const label = (id: string) => agentLabel(TEAM.agents.find((a) => a.id === id)!);
const CODER = label("coder");
const REVIEWER = label("reviewer");
const QA = label("qa");
const RESEARCHER = label("researcher");

/** Writes a task with its own timestamps (TaskRepo.save would stamp "now"). */
async function putTask(task: Task): Promise<void> {
  await store.put(`tasks/${task.id}.json`, JSON.stringify(task));
}

function snapshot(startedAt: number, now: number, text: string, plan: PlanItem[], files: string[], agents: ProgressSnapshot["agents"]): ProgressSnapshot {
  return { updatedAt: iso(now), startedAt: iso(startedAt), now: text, plan, agents, recent: [], files, filesCount: files.length };
}

async function seedConfig(): Promise<void> {
  await configRepo.update((c) => {
    c.orgName = "Acme";
    c.team = structuredClone(TEAM);
    c.adminPasswordHash = hashPassword(DEMO_PASSWORD);
    c.anthropic = { apiKey: "sk-ant-demo-not-a-real-key-000000", model: "" };
    c.slack = {
      botToken: "xoxb-demo-not-a-real-token",
      signingSecret: "demo-signing-secret-000000",
      botUserId: "U0POINTER",
      teamName: "Acme",
      allowedUserIds: [],
      pointerChannels: ["C0POINTERS"],
    };
    c.github = {
      token: "github_pat_demo_not_a_real_token_0000000000",
      login: "acme-bot",
      allowedOwners: ["acme"],
      extra: [{ id: "gh-a1b2c3", token: "github_pat_demo_partner_not_real_000000", login: "partner-dev", allowed: ["partner-co/storefront"] }],
      webhookSecret: "demo-webhook-secret-0123456789abcdef",
    };
    c.monday = {
      token: "demo-monday-token-not-real",
      userName: "Pointer bot",
      accountName: "Acme",
      defaultBoardId: "4012345678",
      allowedBoardIds: ["4012345678", "4012345679"],
      automation: {
        enabled: true,
        webhookSecret: "demo-monday-webhook-secret-not-real",
        boards: {
          "4012345678": {
            repo: "acme/web",
            statusColumnId: "status",
            startLabel: "Ready for dev",
            workingLabel: "Working on it",
            reviewLabel: "In review",
            doneLabel: "Done",
            stuckLabel: "Stuck",
          },
        },
      },
    };
    c.gitlab = {
      token: "glpat-demo-not-a-real-token-000000",
      baseUrl: "https://gitlab.com",
      username: "acme-bot",
      userId: 4242,
      allowed: ["acme-group"],
      webhookSecret: "demo-gitlab-webhook-secret-0123456789",
    };
    c.jira = {
      siteUrl: "https://acme.atlassian.net",
      email: "pointer-bot@example.com",
      token: "demo-jira-token-not-real-0000000000",
      userName: "Pointer bot",
      accountId: "557058:demo",
      defaultProjectKey: "WEB",
      allowedProjectKeys: ["WEB", "API"],
      confluence: true,
      automation: {
        enabled: true,
        webhookSecret: "demo-jira-webhook-secret-0123456789",
        projects: {
          WEB: { repo: "acme/web", startStatus: "Ready for dev", workingStatus: "In Progress", reviewStatus: "In Review", doneStatus: "Done", stuckStatus: "" },
        },
      },
    };
    c.miro = {
      token: "demo-miro-token-not-real-000000",
      userName: "Pointer bot",
      teamName: "Acme",
      defaultBoardId: "uXjVDemo0001=",
      allowedBoardIds: [],
    };
    // Apps connected through their MCP servers (fake sign-ins; nothing is called in the demo).
    const tool = (name: string, description: string, readOnly = true) => ({ name, description, readOnly });
    const signedIn = { type: "oauth" as const, oauth: { tokens: { access_token: "demo-oauth-token-not-real", token_type: "Bearer" }, expiresAt: Date.now() + 30 * 24 * 3_600_000 } };
    const checkedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    c.apps = [
      {
        id: "app-linear",
        name: "Linear",
        presetId: "linear",
        url: "https://mcp.linear.app/mcp",
        transport: "http",
        auth: signedIn,
        access: "write",
        disabledTools: [],
        tools: [tool("list_issues", "List issues"), tool("get_issue", "Read an issue"), tool("create_issue", "Create an issue", false), tool("update_issue", "Update an issue", false)],
        checkedAt,
        agentIds: ["researcher"],
        enabled: true,
      },
      {
        id: "app-sentry",
        name: "Sentry",
        presetId: "sentry",
        url: "https://mcp.sentry.dev/mcp",
        transport: "http",
        auth: signedIn,
        access: "read",
        disabledTools: [],
        tools: [tool("search_issues", "Search issues"), tool("get_issue_details", "Read an issue and its events"), tool("update_issue", "Resolve or assign an issue", false)],
        checkedAt,
        agentIds: ["coder", "qa"],
        enabled: true,
      },
      {
        id: "app-vercel",
        name: "Vercel",
        presetId: "vercel",
        url: "https://mcp.vercel.com",
        transport: "http",
        auth: signedIn,
        access: "read",
        disabledTools: [],
        tools: [tool("list_deployments", "List deployments"), tool("get_deployment_build_logs", "Read a deployment's build logs")],
        checkedAt,
        agentIds: ["coder", "qa"],
        enabled: true,
      },
      {
        id: "app-notion",
        name: "Notion",
        presetId: "notion",
        url: "https://mcp.notion.com/mcp",
        transport: "http",
        auth: signedIn,
        access: "read",
        disabledTools: [],
        tools: [tool("search", "Search pages and databases"), tool("fetch", "Read a page")],
        checkedAt,
        agentIds: ["researcher"],
        enabled: true,
      },
      {
        id: "app-stripe",
        name: "Stripe",
        presetId: "stripe",
        url: "https://mcp.stripe.com",
        transport: "http",
        auth: { type: "bearer", token: "rk_test_demo_not_a_real_key_000000" },
        access: "read",
        disabledTools: [],
        tools: [tool("list_customers", "List customers"), tool("list_subscriptions", "List subscriptions"), tool("create_refund", "Refund a payment", false)],
        checkedAt,
        agentIds: [],
        enabled: true,
      },
      // Genpire, the built-in integration: an app connection from the "genpire" preset. Its tools here are made up;
      // a real one lists whatever Genpire's MCP server offers.
      {
        id: "app-genpire",
        name: "Genpire",
        presetId: "genpire",
        url: "https://mcp.genpire.com/mcp",
        transport: "http",
        auth: signedIn,
        access: "write",
        disabledTools: [],
        tools: [
          tool("list_products", "List the products in the account, newest first"),
          tool("get_tech_pack", "Read a product's tech pack: materials, measurements, construction"),
          tool("design_product", "Design a new product from a description, in a brand style", false),
          tool("prepare_quote_request", "Prepare a factory quote request for a product (Genpire sends it only when you do)", false),
        ],
        checkedAt,
        agentIds: [],
        enabled: true,
      },
    ];
    // Company data: one made-up API with a fake token (nothing is called in the demo).
    c.dataSources = [
      {
        id: "ds-acme-api",
        name: "Acme API",
        description:
          "Sign-ups, active users and subscriptions. /stats/signups?from=YYYY-MM-DD&to=YYYY-MM-DD gives daily sign-ups; /stats/subscriptions gives counts per plan; /users?created_after=YYYY-MM-DD lists new users (paged, 100 per page).",
        kind: "http",
        http: {
          baseUrl: "https://api.acme.example/v1",
          internal: false,
          auth: { type: "bearer", token: "demo-acme-api-token-not-real-0000" },
          allowedPaths: ["/stats", "/users"],
        },
        checkedAt,
        enabled: true,
      },
    ];
    c.bindings = { C0ACMEWEB1: "acme/web", C0ACMEAPI1: "acme/api" };
    c.repoSetup = {
      "acme/web": {
        setupCommand: "npm ci",
        testCommand: "npm test",
        startCommand: "npm run dev",
        appUrl: "http://localhost:3000",
        env: { DATABASE_URL: "postgres://demo:demo@localhost:5432/acme", STRIPE_SECRET_KEY: "sk_test_demo_not_real" },
      },
      "acme/api": { setupCommand: "pip install -r requirements.txt", testCommand: "", startCommand: "", appUrl: "", env: {} },
    };
  });
}

async function seedKnowledge(): Promise<void> {
  const memory = new MemoryRepo(store, key);
  for (const fact of [
    "Staging deploys go through acme/infra; production needs a second approval.",
    "The design system lives in acme/ui: use its Button and Dialog, not custom ones.",
    "Dana owns checkout; ask her before changing the payment flow.",
    "Releases ship on Thursdays at 10:00 UTC.",
  ]) {
    await memory.save(fact, "U0DANA");
  }
  const notes = new NotesRepo(store, key);
  await notes.put(
    "acme/web",
    [
      "Run: npm ci, then npm run dev (http://localhost:3000). Tests: npm test (Vitest); e2e: npm run e2e needs the API on :4000.",
      "Layout: pages in src/routes, components in src/components (one per file), API client in src/api.",
      "Conventions: Prettier and ESLint run in CI; keep components server-rendered unless they need state.",
      "Gotcha: the checkout form reads prices from the API, never from props.",
    ].join("\n"),
  );
  await notes.put("acme/api", "Python 3.12, FastAPI. Run: uvicorn app.main:app --reload. Tests: pytest -q. Migrations: alembic upgrade head.");
  const month = new Date().toISOString().slice(0, 7);
  await store.put(`usage/chat-${month}.json`, JSON.stringify({ usd: 3.42, count: 57 }));
}

/** A finished web task with its whole timeline, screenshots and a conversation around it. */
async function seedFinishedWebTask(now: number): Promise<void> {
  const started = now - 2 * 60 * MIN;
  const taskId = newTaskId(started);
  const conversationId = `c-${newTaskId(started - 1000)}`;
  const plan: PlanItem[] = [
    { content: "Find where the delivery estimate is computed", status: "completed" },
    { content: "Show the date on the checkout summary", status: "completed" },
    { content: "Check checkout in both themes in the browser", status: "completed" },
  ];
  const task: Task = {
    id: taskId,
    createdAt: iso(started),
    updatedAt: iso(started + 26 * MIN),
    status: "done",
    repo: "acme/web",
    channel: WEB_CHANNEL,
    threadTs: conversationId,
    userId: "admin",
    instruction: "Show the delivery date on the checkout page, next to the delivery option.",
    trigger: "web",
    branch: "army/show-the-delivery-date-on-the-chec-4f2a91",
    prUrl: "https://github.com/acme/web/pull/44",
    prDraft: false,
    kind: "change",
    summary: "The checkout shows the estimated delivery date next to the delivery option, from the same API the order page uses.",
    report: {
      title: "Show the delivery date at checkout",
      summary: "The checkout shows the estimated delivery date next to the delivery option, from the same API the order page uses. Dates follow the shopper's locale.",
      verification: "Opened checkout in the browser in light and dark: the date shows and updates when the option changes. `npm test` passes (4 new tests). Reviewer approved after one round.",
      risks: "Shoppers outside the US see the date in their own format; copy was checked for en-US only.",
    },
    ci: { state: "passed", fixRounds: 1, names: [], total: 3 },
    costUsd: 2.14,
    turns: 64,
    screenshots: 2,
    stage: { phase: "checks", text: "Waiting for the pull request's checks", at: iso(started + 21 * MIN) },
    progress: snapshot(started + 2 * MIN, started + 25 * MIN, "Pointer is checking the results", plan, ["src/routes/checkout.tsx", "src/components/DeliveryDate.tsx", "src/components/DeliveryDate.test.tsx", "src/api/delivery.ts"], [
      { label: CODER, description: "Show the delivery date on the summary", state: "done", minutes: 9, toolUses: 31, outcome: "Added DeliveryDate and wired it to the delivery option." },
      { label: REVIEWER, description: "Review the diff", state: "done", minutes: 3, toolUses: 12, outcome: "Approved after one round." },
      { label: QA, description: "Check checkout in the browser", state: "done", minutes: 6, toolUses: 18, outcome: "Both themes look right." },
    ]),
  };
  await putTask(task);

  let clock = started;
  const at = (min: number) => (clock = started + min * MIN);
  const rec = new TimelineRecorder(store, taskId, { now: () => clock });
  at(0);
  rec.enter("clone", "Cloning acme/web");
  rec.add({ kind: "note", text: `New branch ${task.branch} off main` });
  at(1);
  rec.enter("setup", "Running the setup command: npm ci");
  rec.add({ kind: "note", text: "Setup command succeeded in 48s" });
  at(2);
  rec.enter("plan", "Pointer is reading acme/web and planning");
  at(4);
  rec.tracker({ kind: "agent-start", label: CODER, description: "Show the delivery date on the summary" });
  at(5);
  rec.tracker({ kind: "edit", by: CODER, path: "src/api/delivery.ts" });
  at(7);
  rec.tracker({ kind: "edit", by: CODER, path: "src/components/DeliveryDate.tsx" });
  at(9);
  rec.tracker({ kind: "edit", by: CODER, path: "src/routes/checkout.tsx" });
  at(10);
  rec.tracker({ kind: "command", by: CODER, command: "npm test -- DeliveryDate" });
  at(13);
  rec.tracker({ kind: "agent-done", label: CODER, ms: 9 * MIN, outcome: "Added DeliveryDate and wired it to the delivery option.", isError: false, toolUses: 31 });
  rec.tracker({ kind: "agent-start", label: REVIEWER, description: "Review the diff" });
  at(16);
  rec.tracker({ kind: "agent-done", label: REVIEWER, ms: 3 * MIN, outcome: "Approved after one round.", isError: false, toolUses: 12 });
  rec.tracker({ kind: "agent-start", label: QA, description: "Check checkout in the browser" });
  rec.tracker({ kind: "command", by: QA, command: "npm run dev" });
  at(17);
  rec.tracker({ kind: "browser", by: QA, action: "Opened", detail: "http://localhost:3000/checkout" });
  rec.tracker({ kind: "browser", by: QA, action: "Took a screenshot", detail: "checkout-light.png" });
  at(18);
  rec.tracker({ kind: "browser", by: QA, action: "Took a screenshot", detail: "checkout-dark.png" });
  at(19);
  rec.tracker({ kind: "agent-done", label: QA, ms: 6 * MIN, outcome: "Both themes look right.", isError: false, toolUses: 18 });
  at(20);
  rec.add({ kind: "screenshot", text: "2 screenshots saved: checkout-light.png, checkout-dark.png" });
  rec.enter("publish", "Publishing the branch and opening the pull request");
  rec.add({ kind: "push", text: `Pushed branch ${task.branch}` });
  rec.add({ kind: "pr", text: "Opened pull request #44: Show the delivery date at checkout", url: task.prUrl });
  at(21);
  rec.enter("checks", "Waiting for the pull request's checks");
  rec.checks([
    { name: "build", state: "passed", url: "https://github.com/acme/web/actions" },
    { name: "test", state: "passed", url: "https://github.com/acme/web/actions" },
    { name: "Vercel", state: "passed", url: "https://vercel.com" },
  ]);
  at(25);
  rec.add({ kind: "checks", text: "Checks: all 3 passed after 1 fix round", ok: true, ms: 4 * MIN });
  at(26);
  await rec.close(true, "Done: Show the delivery date at checkout");
  await shots.add(taskId, [
    { name: "checkout-light.png", bytes: await asset("checkout-light.png") },
    { name: "checkout-dark.png", bytes: await asset("checkout-dark.png") },
  ]);

  const conversation: Conversation = {
    id: conversationId,
    title: "Show the delivery date on the checkout page",
    createdAt: iso(started - 60_000),
    updatedAt: iso(started + 26 * MIN),
    pending: false,
    taskIds: [taskId],
    messages: [
      { id: "m-1", role: "user", text: task.instruction, at: iso(started - 60_000) },
      {
        id: "m-2",
        role: "pointer",
        at: iso(started - 20_000),
        costUsd: 0.06,
        text: "On it. The team is working on `acme/web`: Coder builds it, Reviewer and QA check it, and QA looks at checkout in the browser in both themes. Follow along in the card below.",
        tasks: [taskId],
        activity: [
          { id: "s1", label: "Reading acme/web: src/routes/checkout.tsx", kind: "github", startedAt: iso(started - 50_000), endedAt: iso(started - 45_000) },
          { id: "s2", label: "Starting a repo task on acme/web", kind: "task", startedAt: iso(started - 30_000), endedAt: iso(started - 25_000) },
        ],
      },
    ],
  };
  await conversations.save(conversation, new Date(started + 26 * MIN));
}

/** A task a monday.com ticket started (board 4012345678 is automated for acme/web): its pull request is in review. */
async function seedMondayTask(now: number): Promise<void> {
  const started = now - 50 * MIN;
  const taskId = newTaskId(started);
  const conversationId = `c-${newTaskId(started - 1000)}`;
  const ticket = { boardId: "4012345678", itemId: "8123456701", name: "Checkout button overlaps the cart total on small phones", url: "https://acme.monday.com/boards/4012345678/pulses/8123456701" };
  const instruction = [
    `Work on this monday.com ticket: ${ticket.name}`,
    `(board "Web bugs", group "This sprint", item ${ticket.itemId})`,
    `Link: ${ticket.url}`,
    "",
    "Description and first updates (oldest first):",
    "",
    "Dana, 2026-11-18:\nOn screens narrower than 360 px the Pay button covers the cart total. Seen on iPhone SE and small Android phones.",
    "",
    "Columns:\n- Status: Ready for dev\n- Priority: High\n- Owner: Dana",
  ].join("\n");
  const task: Task = {
    id: taskId,
    createdAt: iso(started),
    updatedAt: iso(started + 19 * MIN),
    status: "done",
    repo: "acme/web",
    channel: WEB_CHANNEL,
    threadTs: conversationId,
    userId: "admin",
    instruction,
    trigger: "monday",
    ticket,
    branch: "army/work-on-this-monday-com-ticket-chec-7c1d20",
    prUrl: "https://github.com/acme/web/pull/46",
    prDraft: false,
    kind: "change",
    summary: "The checkout footer stacks the total above the Pay button below 380 px, so neither covers the other.",
    report: {
      title: "Keep the cart total visible above the Pay button on small phones",
      summary: "The checkout footer stacks the total above the Pay button below 380 px, so neither covers the other.",
      verification: "QA checked checkout at 320, 360 and 414 px in the browser; `npm test` passes.",
      risks: "",
    },
    ci: { state: "passed", fixRounds: 0, names: [], total: 3 },
    costUsd: 1.36,
    turns: 38,
  };
  await putTask(task);

  let clock = started;
  const at = (min: number) => (clock = started + min * MIN);
  const rec = new TimelineRecorder(store, taskId, { now: () => clock });
  at(0);
  rec.enter("clone", "Cloning acme/web");
  rec.add({ kind: "ticket", text: `Ticket "${ticket.name}": status set to "Working on it"; update posted`, ok: true, url: ticket.url });
  rec.add({ kind: "note", text: `New branch ${task.branch} off main` });
  at(2);
  rec.enter("plan", "Pointer is reading acme/web and planning");
  at(4);
  rec.tracker({ kind: "agent-start", label: CODER, description: "Stack the checkout footer on small screens" });
  rec.tracker({ kind: "edit", by: CODER, path: "src/components/CheckoutFooter.tsx" });
  at(9);
  rec.tracker({ kind: "agent-done", label: CODER, ms: 5 * MIN, outcome: "The footer stacks below 380 px.", isError: false, toolUses: 22 });
  rec.tracker({ kind: "agent-start", label: QA, description: "Check checkout on small screens" });
  rec.tracker({ kind: "browser", by: QA, action: "Opened", detail: "http://localhost:3000/checkout" });
  at(13);
  rec.tracker({ kind: "agent-done", label: QA, ms: 4 * MIN, outcome: "Total and button are both visible at 320 px.", isError: false, toolUses: 10 });
  at(14);
  rec.enter("publish", "Publishing the branch and opening the pull request");
  rec.add({ kind: "push", text: `Pushed branch ${task.branch}` });
  rec.add({ kind: "pr", text: `Opened pull request #46: ${task.report!.title}`, url: task.prUrl });
  rec.add({ kind: "ticket", text: `Ticket "${ticket.name}": status set to "In review"; update posted`, ok: true, url: ticket.url });
  at(15);
  rec.enter("checks", "Waiting for the pull request's checks");
  rec.checks([
    { name: "build", state: "passed" },
    { name: "test", state: "passed" },
    { name: "Vercel", state: "passed" },
  ]);
  at(19);
  rec.add({ kind: "checks", text: "Checks: all 3 passed", ok: true, ms: 4 * MIN });
  await rec.close(true, `Done: ${task.report!.title}`);

  await conversations.save(
    {
      id: conversationId,
      title: ticket.name,
      createdAt: iso(started - 1000),
      updatedAt: iso(started + 19 * MIN),
      pending: false,
      taskIds: [taskId],
      messages: [
        { id: "m-1", role: "user", text: instruction, at: iso(started - 1000) },
        {
          id: "m-2",
          role: "pointer",
          at: iso(started - 500),
          text: `The ticket **${ticket.name}** moved to *Ready for dev* on monday.com. Putting the team on \`acme/web\`…`,
          tasks: [taskId],
        },
      ],
    },
    new Date(started + 19 * MIN),
  );
}

/** A question and its answer: no repo task. */
async function seedQuestion(now: number): Promise<void> {
  const at = now - 30 * MIN;
  await conversations.save(
    {
      id: `c-${newTaskId(at)}`,
      title: "What changed on acme/web this week?",
      createdAt: iso(at),
      updatedAt: iso(at + 40_000),
      pending: false,
      taskIds: [],
      messages: [
        { id: "m-1", role: "user", text: "What changed on acme/web this week?", at: iso(at) },
        {
          id: "m-2",
          role: "pointer",
          at: iso(at + 40_000),
          costUsd: 0.07,
          text: [
            "Three things landed on `main` this week:",
            "",
            "1. **Checkout redesign** ([#41](https://github.com/acme/web/pull/41)): a single-page flow and a new address form.",
            "2. **Faster search**: queries use the new index; p95 dropped from 900 ms to 220 ms.",
            "3. **Dependencies**: React 19.3 and Vite 8.",
            "",
            "Two pull requests are open: #43 (dark mode) and #44 (delivery date at checkout). Want a summary of either?",
          ].join("\n"),
          activity: [
            { id: "s1", label: "Reading recent commits on acme/web", kind: "github", startedAt: iso(at + 2000), endedAt: iso(at + 5000) },
            { id: "s2", label: "Listing pull requests on acme/web", kind: "github", startedAt: iso(at + 6000), endedAt: iso(at + 8000) },
            { id: "s3", label: "Reading acme/web: src/search/index.ts", kind: "github", startedAt: iso(at + 9000), endedAt: iso(at + 11000) },
          ],
        },
      ],
    },
    new Date(at + 40_000),
  );
}

/** Slack tasks in every outcome, for Overview and Activity. */
async function seedSlackTasks(now: number): Promise<void> {
  const base = { channel: "C0ACMEWEB1", userId: "U0DANA", trigger: "slack" as const };
  const list: Task[] = [
    {
      ...base,
      id: newTaskId(now - 26 * 60 * MIN),
      createdAt: iso(now - 26 * 60 * MIN),
      updatedAt: iso(now - 25.5 * 60 * MIN),
      threadTs: "1763380000.000100",
      status: "done",
      repo: "acme/web",
      instruction: "Fix the login redirect: after signing in, people land on / instead of the page they came from.",
      branch: "army/fix-the-login-redirect-after-sig-a1b2c3",
      prUrl: "https://github.com/acme/web/pull/42",
      kind: "change",
      summary: "Keeps the page people came from in a `next` parameter and sends them back after sign-in.",
      report: { title: "Return to the original page after sign-in", summary: "Keeps the page people came from in a `next` parameter and sends them back after sign-in.", verification: "Signed in from /settings and /orders/12: both returned to the page. `npm test` passes.", risks: "" },
      ci: { state: "passed", fixRounds: 0, names: [], total: 3 },
      costUsd: 1.87,
      turns: 48,
    },
    {
      ...base,
      id: newTaskId(now - 20 * 60 * MIN),
      createdAt: iso(now - 20 * 60 * MIN),
      updatedAt: iso(now - 19.6 * 60 * MIN),
      threadTs: "1763400000.000200",
      status: "done",
      trigger: "review",
      repo: "acme/web",
      instruction: "Address the feedback from dana on pull request #42 (GitHub).\n\n> Please also keep the query string.",
      branch: "army/fix-the-login-redirect-after-sig-a1b2c3",
      prUrl: "https://github.com/acme/web/pull/42",
      kind: "change",
      summary: "The `next` parameter now keeps the query string too.",
      ci: { state: "passed", fixRounds: 0, names: [], total: 3 },
      costUsd: 0.64,
      turns: 17,
    },
    {
      ...base,
      channel: "C0ACMEAPI1",
      id: newTaskId(now - 9 * 60 * MIN),
      createdAt: iso(now - 9 * 60 * MIN),
      updatedAt: iso(now - 8.1 * 60 * MIN),
      threadTs: "1763430000.000300",
      status: "failed",
      repo: "acme/api",
      instruction: "Move the orders API to cursor pagination and update every client.",
      branch: "army/move-the-orders-api-to-cursor-pagina-9c8d7e",
      prUrl: "https://github.com/acme/api/pull/17",
      prDraft: true,
      error: "The team stopped early: hit the $8 budget limit.",
      costUsd: 8.0,
      turns: 151,
    },
    {
      ...base,
      channel: "C0ACMEAPI1",
      id: newTaskId(now - 5 * 60 * MIN),
      createdAt: iso(now - 5 * 60 * MIN),
      updatedAt: iso(now - 4.9 * 60 * MIN),
      threadTs: "1763440000.000400",
      status: "done",
      repo: "acme/api",
      instruction: "Rotate the Stripe webhook secret.",
      kind: "blocked",
      summary: "Rotating the secret needs access to the Stripe dashboard and the production secret store. A human has to do it; the code already reads the secret from `STRIPE_WEBHOOK_SECRET`.",
      costUsd: 0.31,
      turns: 9,
    },
    {
      ...base,
      id: newTaskId(now - 3 * 60 * MIN),
      createdAt: iso(now - 3 * 60 * MIN),
      updatedAt: iso(now - 2.95 * 60 * MIN),
      threadTs: "1763450000.000500",
      status: "done",
      repo: "acme/web",
      instruction: "Where is sales tax calculated, and which states does it cover?",
      kind: "answer",
      summary: "Tax is calculated in `src/api/tax.ts` with rates from the `tax_rates` table; 12 states are covered.",
      costUsd: 0.42,
      turns: 14,
    },
  ];
  for (const t of list) await putTask(t);
}

/**
 * The simulated worker: moves a task through clone, plan, build, verify,
 * publish and checks over about two minutes, saving progress, the timeline
 * and a screenshot like the real worker does.
 */
function simulatedRunner(): Runner {
  return {
    kind: "local",
    async launch(taskId: string) {
      void simulate(taskId).catch((err: unknown) => console.error("[demo] simulated task failed:", err));
    },
  };
}

async function simulate(taskId: string, pace = 1): Promise<void> {
  const task = await tasks.get(taskId);
  if (!task) return;
  const rec = new TimelineRecorder(store, taskId, { everyMs: 500 });
  const startedAt = Date.now();
  const branch = `army/demo-${taskId.slice(-6)}`;
  const plan: PlanItem[] = [
    { content: "Read the code the request touches", status: "in_progress" },
    { content: "Make the change", status: "pending" },
    { content: "Review the diff and run the tests", status: "pending" },
    { content: "Check it in the browser", status: "pending" },
  ];
  const files: string[] = [];
  const agents: ProgressSnapshot["agents"] = [];
  const save = async (phase: NonNullable<Task["stage"]>["phase"], text: string) => {
    task.status = "running";
    task.stage = { phase, text, at: new Date().toISOString() };
    task.progress = snapshot(startedAt, Date.now(), text, plan.map((p) => ({ ...p })), [...files], agents.map((a) => ({ ...a })));
    await tasks.save(task);
  };
  const step = async (ms: number) => sleep(ms * pace);

  rec.enter("clone", `Cloning ${task.repo}`);
  await save("clone", `Cloning ${task.repo}`);
  await step(4000);
  task.branch = branch;
  rec.add({ kind: "note", text: `New branch ${branch} off main` });
  rec.enter("setup", "Running the setup command: npm ci");
  await save("setup", "Running the repo's setup command");
  await step(5000);
  rec.add({ kind: "note", text: "Setup command succeeded in 41s" });
  rec.enter("plan", `Pointer is reading ${task.repo} and planning`);
  await save("plan", `Pointer is reading ${task.repo} and planning`);
  await step(8000);
  plan[0]!.status = "completed";
  plan[1]!.status = "in_progress";
  rec.tracker({ kind: "agent-start", label: CODER, description: "Make the change" });
  agents.push({ label: CODER, description: "Make the change", state: "working", minutes: 0, toolUses: 4 });
  await save("build", `${CODER} — Make the change`);
  for (const path of ["src/theme/store.ts", "src/components/ThemeToggle.tsx", "src/components/Header.tsx"]) {
    await step(6000);
    files.push(path);
    rec.tracker({ kind: "edit", by: CODER, path });
    agents[0]!.toolUses += 7;
    agents[0]!.minutes += 1;
    await save("build", `${CODER} — Make the change`);
  }
  rec.tracker({ kind: "command", by: CODER, command: "npm test" });
  await step(5000);
  rec.tracker({ kind: "agent-done", label: CODER, ms: 22_000, outcome: "Added the theme store and the toggle; tests pass.", isError: false, toolUses: agents[0]!.toolUses });
  agents[0] = { ...agents[0]!, state: "done", outcome: "Added the theme store and the toggle; tests pass." };
  plan[1]!.status = "completed";
  plan[2]!.status = "in_progress";
  rec.tracker({ kind: "agent-start", label: REVIEWER, description: "Review the diff" });
  agents.push({ label: REVIEWER, description: "Review the diff", state: "working", minutes: 0, toolUses: 3 });
  await save("verify", `${REVIEWER} — Review the diff`);
  await step(9000);
  rec.tracker({ kind: "agent-done", label: REVIEWER, ms: 9000, outcome: "Looks good: no issues found.", isError: false, toolUses: 11 });
  agents[1] = { ...agents[1]!, state: "done", minutes: 1, toolUses: 11, outcome: "Looks good: no issues found." };
  plan[2]!.status = "completed";
  plan[3]!.status = "in_progress";
  rec.tracker({ kind: "agent-start", label: QA, description: "Check it in the browser" });
  agents.push({ label: QA, description: "Check it in the browser", state: "working", minutes: 0, toolUses: 2 });
  await save("verify", `${QA} — Check it in the browser`);
  rec.tracker({ kind: "command", by: QA, command: "npm run dev" });
  await step(5000);
  rec.tracker({ kind: "browser", by: QA, action: "Opened", detail: "http://localhost:3000/checkout" });
  await step(4000);
  rec.tracker({ kind: "browser", by: QA, action: "Took a screenshot", detail: "checkout-dark.png" });
  const stored = await shots.add(taskId, [{ name: "checkout-dark.png", bytes: await asset("checkout-dark.png") }]);
  task.screenshots = stored.length;
  rec.add({ kind: "screenshot", text: "1 screenshot saved: checkout-dark.png" });
  rec.tracker({ kind: "agent-done", label: QA, ms: 9000, outcome: "Both themes look right.", isError: false, toolUses: 9 });
  agents[2] = { ...agents[2]!, state: "done", minutes: 1, toolUses: 9, outcome: "Both themes look right." };
  plan[3]!.status = "completed";
  task.report = {
    title: "Add a dark mode toggle to the header",
    summary: "Adds a theme store (system, light, dark) and a toggle in the header. The choice is remembered per browser.",
    verification: "QA checked checkout in both themes in the browser; `npm test` passes. Reviewer found no issues.",
    risks: "",
  };
  task.costUsd = 1.12;
  task.turns = 41;
  rec.enter("publish", "Publishing the branch and opening the pull request");
  await save("publish", "Publishing the branch and opening the pull request");
  await step(4000);
  task.prUrl = "https://github.com/acme/web/pull/45";
  rec.add({ kind: "push", text: `Pushed branch ${branch}` });
  rec.add({ kind: "pr", text: "Opened pull request #45: Add a dark mode toggle to the header", url: task.prUrl });
  rec.enter("checks", "Waiting for the pull request's checks");
  rec.checks([
    { name: "build", state: "running" },
    { name: "test", state: "queued" },
    { name: "Vercel", state: "running" },
  ]);
  await save("checks", "Waiting for the pull request's checks");
  await step(8000);
  rec.checks([
    { name: "build", state: "passed" },
    { name: "test", state: "passed" },
    { name: "Vercel", state: "passed" },
  ]);
  rec.add({ kind: "checks", text: "Checks: all 3 passed", ok: true, ms: 8000 });
  task.ci = { state: "passed", fixRounds: 0, names: [], total: 3 };
  task.kind = "change";
  task.summary = task.report.summary;
  task.status = "done";
  await rec.close(true, `Done: ${task.report.title}`);
  await tasks.save(task);
}

// ---------- Routines ----------

const DEMO_TZ = "America/New_York";

/** A canned digest, as a routine run would write it. */
function digestReport(day: string, merged: number): string {
  return [
    `**${merged} pull requests merged, 3 waiting for review, 2 issues closed** across acme/web and acme/api (${day}).`,
    "",
    "## acme/web",
    `- Merged [#${410 + merged}](https://github.com/acme/web/pull/${410 + merged}) *Dark mode toggle in the header* (Sara), [#${405 + merged}](https://github.com/acme/web/pull/${405 + merged}) *Fix the flaky checkout test* (Omar).`,
    "- Waiting for review: [#418](https://github.com/acme/web/pull/418) *Search suggestions* (2 days, no reviewer yet).",
    "- Closed issue [#97](https://github.com/acme/web/issues/97) *Prices flash before the currency loads*.",
    "",
    "## acme/api",
    "- Merged [#212](https://github.com/acme/api/pull/212) *Rate limiting on /api/login*.",
    "- Waiting for review: [#215](https://github.com/acme/api/pull/215) *Invoices export* and [#216](https://github.com/acme/api/pull/216) *Bump FastAPI*.",
    "",
    "## Needs attention today",
    "- #418 has waited two days for a reviewer.",
    "- The `e2e` check failed twice on main yesterday evening; the last run passed.",
  ].join("\n");
}

function metricsReport(week: string): string {
  return [
    `**Signups up 12%, paid subscriptions up 4%** in the week to ${week}.`,
    "",
    "| Metric | This week | Last week | Change |",
    "| --- | ---: | ---: | ---: |",
    "| New signups | 1,284 | 1,146 | +12% |",
    "| New paid subscriptions | 193 | 186 | +4% |",
    "| Cancellations | 41 | 47 | −13% |",
    "| Revenue | $48,920 | $46,310 | +6% |",
    "",
    "- Signups peaked on Wednesday after the newsletter went out.",
    "- Cancellations are the lowest in six weeks.",
    "- Annual plans are 31% of new subscriptions, up from 26%.",
  ].join("\n");
}

const DEMO_ROUTINES: Routine[] = [
  {
    id: "rt-daily-github-digest",
    name: "Daily GitHub digest",
    instruction:
      "Summarise what happened on GitHub in acme/web and acme/api in the window: pull requests merged and waiting for review, issues opened and closed, " +
      "and failing checks on main. Link every pull request and issue, and end with what needs attention today.",
    schedule: { cron: "0 8 * * *", timezone: DEMO_TZ },
    deliver: { email: ["dana@acme.example"], slack: "", console: true },
    budgetUsd: 1,
    timeoutMin: 20,
    enabled: true,
    createdBy: "Dana",
    createdAt: "",
  },
  {
    id: "rt-monday-metrics",
    name: "Monday metrics",
    instruction:
      "From the company data, report new signups, new paid subscriptions, cancellations and revenue for the window and the week before, " +
      "with the change in percent, in a small table, then three bullet points on what stands out.",
    schedule: { cron: "30 8 * * 1", timezone: DEMO_TZ },
    deliver: { email: [], slack: "C0ACMELEAD", console: true },
    budgetUsd: 1.5,
    timeoutMin: 20,
    enabled: true,
    createdBy: "Admin (console)",
    createdAt: "",
  },
];

/** The past `count` scheduled times of a cron, oldest first. */
function pastRuns(cron: string, count: number, now: number, lookbackDays: number): Date[] {
  const parsed = parseCron(cron);
  if (!parsed.ok) return [];
  return nextRuns(parsed.spec, DEMO_TZ, new Date(now - lookbackDays * 24 * 60 * MIN), 400)
    .filter((d) => d.getTime() <= now)
    .slice(-count);
}

/** Two routines with a few past runs, their reports in a console conversation each. */
async function seedRoutines(now: number): Promise<void> {
  await configRepo.update((c) => {
    c.timezone = DEMO_TZ;
    c.routines = DEMO_ROUTINES.map((r, i) => ({ ...structuredClone(r), createdAt: iso(now - (9 + i * 11) * 24 * 60 * MIN) }));
  });
  const repo = new RoutineRunRepo(store, key);
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: DEMO_TZ, weekday: "long", month: "short", day: "numeric" });

  const seed = async (routine: Routine, runs: { at: Date; status: RoutineRun["status"]; report?: string; note?: string; costUsd?: number; delivered: RoutineRun["delivered"] }[]) => {
    const messages: Conversation["messages"] = [];
    for (const r of runs) {
      const started = r.at.getTime() + 2_000;
      const run: RoutineRun = {
        id: scheduledRunId(r.at),
        routineId: routine.id,
        trigger: "schedule",
        scheduledFor: r.at.toISOString(),
        startedAt: iso(started),
        finishedAt: iso(started + 95_000),
        status: r.status,
        delivered: r.delivered,
        ...(r.report ? { report: r.report } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      };
      await repo.save(run);
      if (r.report) {
        messages.push({ id: `m-${randomBytes(5).toString("hex")}`, role: "pointer", text: `_Scheduled run · ${day(r.at)}, 08:00 (${DEMO_TZ})_\n\n${r.report}`, at: iso(started + 95_000), costUsd: r.costUsd });
      }
    }
    const last = runs[runs.length - 1]!;
    const conversation: Conversation = {
      id: `c-${newTaskId(now - 3 * 24 * 60 * MIN)}`,
      title: routine.name,
      createdAt: messages[0]?.at ?? iso(now),
      updatedAt: messages[messages.length - 1]?.at ?? iso(now),
      pending: false,
      messages,
      taskIds: [],
    };
    await conversations.save(conversation, new Date(conversation.updatedAt));
    const lastGood = [...runs].reverse().find((r) => r.status === "succeeded");
    await repo.updateState(routine.id, {
      since: routine.createdAt,
      lastScheduledFor: last.at.toISOString(),
      ...(lastGood ? { lastSuccessAt: iso(lastGood.at.getTime() + 2_000) } : {}),
      conversationId: conversation.id,
    });
  };

  const [digest, metrics] = (await configRepo.load(true)).routines;
  const daily = pastRuns(digest!.schedule.cron, 3, now, 4);
  await seed(
    digest!,
    daily.map((at, i) => ({
      at,
      status: "succeeded" as const,
      report: digestReport(day(at), 2 + i),
      costUsd: 0.18 + i * 0.03,
      delivered: { email: { ok: true, detail: "Sent to dana@acme.example" }, slack: null, console: { ok: true } },
    })),
  );
  const weekly = pastRuns(metrics!.schedule.cron, 2, now, 15);
  await seed(metrics!, [
    {
      at: weekly[0]!,
      status: "skipped",
      note: "Missed: the service was not running at the scheduled time (3 hours ago). Runs more than an hour late are skipped; the next one runs on schedule.",
      delivered: { email: null, slack: null, console: null },
    },
    {
      at: weekly[1]!,
      status: "succeeded",
      report: metricsReport(day(weekly[1]!)),
      costUsd: 0.41,
      delivered: { email: null, slack: { ok: true, detail: "Posted to C0ACMELEAD" }, console: { ok: true } },
    },
  ]);
}

/** Pointer for the demo: streams a short answer, shows its steps, and starts a simulated task for change requests. */
const demoBrain: PointerBrain = {
  async reply(req, ctx) {
    // A routine run (Run now on the Routines page): a canned report, read-only like the real one.
    if (req.surface === "routine") {
      await sleep(4_000);
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      const text = /signups|metrics|subscriptions/i.test(req.text) ? metricsReport(today) : digestReport(today, 3);
      return { text: `${text}\n\n_This is the demo: the report is canned._`, costUsd: 0.21, isError: false };
    }
    const emit = ctx.onActivity ?? (() => undefined);
    const say = async (text: string) => {
      for (const part of text.match(/.{1,14}/gs) ?? []) {
        emit({ type: "text", delta: part });
        await sleep(45);
      }
    };
    const wantsChange = /\b(add|fix|change|build|implement|update|remove|make)\b/i.test(req.text);
    const repo = req.text.match(/\b([\w.-]+\/[\w.-]+)\b/)?.[1] ?? req.thread?.repo ?? "acme/web";
    emit({ type: "turn" });
    emit({ type: "step", id: "a1", label: `Reading ${repo}: src/routes/checkout.tsx`, kind: "github" });
    await sleep(1200);
    emit({ type: "step-done", id: "a1", isError: false });
    emit({ type: "step", id: "a2", label: "Asking Researcher: how does the app handle themes today?", kind: "agent" });
    emit({ type: "step", id: "a3", label: "Searching the web for “prefers-color-scheme toggle”", kind: "web", agent: "Researcher" });
    await sleep(1600);
    emit({ type: "step-done", id: "a3", isError: false });
    emit({ type: "step-done", id: "a2", isError: false });
    let text: string;
    if (wantsChange) {
      emit({ type: "step", id: "a4", label: `Starting a repo task on ${repo}`, kind: "task" });
      const started = await ctx.startRepoTask({ repo, instruction: req.text });
      emit({ type: "step-done", id: "a4", isError: !started.ok });
      text = started.ok
        ? `On it. The team is working on \`${repo}\`: Coder makes the change, Reviewer checks the diff, and QA tries it in the browser. Follow every step in the card below; the pull request link appears there when it opens.\n\n_This is the demo: the task is simulated and nothing is pushed._`
        : `I could not start the task: ${started.error}`;
    } else {
      text = [
        "Here is what I found:",
        "",
        "- The app already reads **prefers-color-scheme**, so system dark mode works.",
        "- There is no toggle yet: it would need a stored preference and a `data-theme` attribute on `<html>`.",
        "",
        "| Option | Effort |",
        "| --- | --- |",
        "| CSS variables only | small |",
        "| Theme provider + toggle | medium |",
        "",
        "Ask me to *add a dark mode toggle* and the team will build it as a pull request.",
        "",
        "_This is the demo: answers are canned. Connect a Claude key to talk to the real Pointer._",
      ].join("\n");
    }
    emit({ type: "turn" });
    await say(text);
    return { text, costUsd: 0.04, isError: false };
  },
};

/**
 * A research question for one agent: the Researcher works alone at their desk
 * for a few minutes (no meeting), then answers.
 */
async function simulateResearch(taskId: string): Promise<void> {
  const task = await tasks.get(taskId);
  if (!task) return;
  const rec = new TimelineRecorder(store, taskId, { everyMs: 500 });
  const startedAt = Date.now();
  const plan: PlanItem[] = [{ content: "Compare the options and their trade-offs", status: "in_progress" }];
  const agent: ProgressSnapshot["agents"][number] = { label: RESEARCHER, description: "Compare search providers for the store", state: "working", minutes: 0, toolUses: 3 };
  const save = async (text: string) => {
    task.status = "running";
    task.stage = { phase: "plan", text, at: new Date().toISOString() };
    task.progress = snapshot(startedAt, Date.now(), text, plan.map((p) => ({ ...p })), [], [{ ...agent }]);
    await tasks.save(task);
  };
  rec.enter("clone", `Cloning ${task.repo}`);
  rec.enter("plan", `Pointer is reading ${task.repo} and planning`);
  rec.tracker({ kind: "agent-start", label: RESEARCHER, description: agent.description });
  await save(`${RESEARCHER} — ${agent.description}`);
  for (let minute = 1; minute <= 4; minute++) {
    await sleep(45_000);
    agent.minutes = minute;
    agent.toolUses += 6;
    await save(`${RESEARCHER} — ${agent.description}`);
  }
  const outcome = "Algolia fits best: hosted, typo-tolerant, about $40 a month at our volume.";
  rec.tracker({ kind: "agent-done", label: RESEARCHER, ms: Date.now() - startedAt, outcome, isError: false, toolUses: agent.toolUses });
  plan[0]!.status = "completed";
  task.status = "done";
  task.kind = "answer";
  task.summary = outcome;
  task.report = { title: "Search providers for the store", summary: outcome, verification: "Compared pricing pages and docs of Algolia, Meilisearch Cloud and Typesense Cloud.", risks: "" };
  task.costUsd = 0.38;
  await rec.close(true, "Answered: Search providers for the store");
  await tasks.save(task);
}

/** Work the team is already doing when the demo opens, so the Office looks like a working day: a team task (a meeting) and a research question. */
async function seedWorkInProgress(now: number): Promise<{ team: string; research: string }> {
  const start = async (minutesAgo: number, title: string, instruction: string, reply: string) => {
    const at = now - minutesAgo * MIN;
    const taskId = newTaskId(at);
    const conversationId = `c-${newTaskId(at - 1000)}`;
    await putTask({
      id: taskId,
      createdAt: iso(at),
      updatedAt: iso(at),
      status: "queued",
      repo: "acme/web",
      channel: WEB_CHANNEL,
      threadTs: conversationId,
      userId: "admin",
      instruction,
      trigger: "web",
    });
    await conversations.save(
      {
        id: conversationId,
        title,
        createdAt: iso(at - 1000),
        updatedAt: iso(at),
        pending: false,
        taskIds: [taskId],
        messages: [
          { id: "m-1", role: "user", text: instruction, at: iso(at - 1000) },
          { id: "m-2", role: "pointer", text: reply, at: iso(at - 500), tasks: [taskId] },
        ],
      },
      new Date(at),
    );
    return taskId;
  };
  return {
    team: await start(
      1,
      "Add a dark mode toggle to the header",
      "Add a dark mode toggle to the header of acme/web, remembered per browser.",
      "On it. Sara builds the toggle, Omar reviews the diff and Lina checks it in the browser in both themes.",
    ),
    research: await start(
      2,
      "Which search provider should the store use?",
      "Which hosted search provider should the acme/web store use? Compare price, typo tolerance and setup.",
      "Kenji is comparing the providers; I will post his recommendation here.",
    ),
  };
}

await seedConfig();
const now = Date.now();
await seedKnowledge();
await seedSlackTasks(now);
await seedFinishedWebTask(now);
await seedMondayTask(now);
await seedQuestion(now);
await seedRoutines(now);
const inProgress = await seedWorkInProgress(now);
// The team task runs at a third of the usual pace (about five minutes), so the Office shows a meeting for a while.
void simulate(inProgress.team, 3).catch((err: unknown) => console.error("[demo] simulated task failed:", err));
void simulateResearch(inProgress.research).catch((err: unknown) => console.error("[demo] simulated research failed:", err));

const port = Number(process.env.PORT ?? 8080);
const { app, routines } = await createApp(env, { brain: demoBrain, runner: simulatedRunner() });
app.listen(port, () => {
  // The seeded routines run on schedule with the demo brain's canned reports.
  routines.scheduler.start();
  console.log(`
Agent Army demo is running: http://localhost:${port}
  Password: ${DEMO_PASSWORD}
  Data:     ${dataDir} (sample data; every credential is fake)

Try the Chat page: ask a question, or ask for a change ("add a dark mode toggle") and watch the simulated team work.
Stop with Ctrl+C.`);
});
