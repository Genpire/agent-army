import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepoTaskApps } from "../../src/integrations/apps/apps.js";
import { ConfigRepo, isChatReady, publicView } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { MEMORY_MAX_CHARS, MEMORY_MAX_FACTS, MemoryRepo } from "../../src/chat/memory.js";
import { FsStore } from "../../src/core/store.js";
import {
  CHAT_RULES,
  DEFAULT_EFFORT,
  REPO_RULES,
  TeamSchema,
  agentLabel,
  buildChatAgents,
  buildRepoAgents,
  defaultTeam,
  hasWriteAgent,
  repoAllowedTools,
  repoToolsFor,
  rosterText,
} from "../../src/team/team.js";

const tmpStore = async () => new FsStore(await mkdtemp(join(tmpdir(), "army-team-")));

describe("team model", () => {
  it("seeds Pointer and seven agents on a fresh config", async () => {
    const repo = new ConfigRepo(await tmpStore(), deriveKey("k"), 0);
    const c = await repo.load();
    expect(c.team.pointer).toEqual({
      name: "Pointer",
      instructions: "",
      budgetUsd: 1,
      maxTurns: 40,
      model: "",
      effort: "medium",
      taskEffort: "medium",
      routing: {
        enabled: false,
        small: { model: "claude-sonnet-5-5", effort: "low" },
        medium: { model: "claude-sonnet-5-5", effort: "medium" },
        large: { model: "", effort: "high" },
      },
    });
    expect(c.team.agents.map((a) => a.id)).toEqual(["coder", "reviewer", "qa", "researcher", "writer", "hr", "scout"]);
    expect(c.slack.pointerChannels).toEqual([]);
    expect(publicView(c).team.agents).toHaveLength(7);
  });

  it("keeps an edited team across reloads, without re-seeding", async () => {
    const repo = new ConfigRepo(await tmpStore(), deriveKey("k"), 0);
    await repo.update((c) => {
      c.team.pointer.name = "Pointer";
      c.team.agents = c.team.agents.filter((a) => a.id !== "qa");
      c.team.agents[0]!.name = "Sara";
    });
    const c = await repo.load(true);
    expect(c.team.agents.map((a) => a.id)).toEqual(["coder", "reviewer", "researcher", "writer", "hr", "scout"]);
    expect(c.team.agents[0]!.name).toBe("Sara");
  });

  it("validates ids: format, reserved, duplicates", () => {
    const base = defaultTeam();
    const withAgent = (patch: object) => ({ ...base, agents: [...base.agents, { ...base.agents[0]!, ...patch }] });
    expect(TeamSchema.safeParse(withAgent({ id: "Bad Id" })).success).toBe(false);
    expect(TeamSchema.safeParse(withAgent({ id: "pointer" })).success).toBe(false);
    expect(TeamSchema.safeParse(withAgent({ id: "general-purpose" })).success).toBe(false);
    expect(TeamSchema.safeParse(withAgent({ id: "coder" })).success).toBe(false); // duplicate
    expect(TeamSchema.safeParse(withAgent({ id: "designer" })).success).toBe(true);
    expect(TeamSchema.safeParse(withAgent({ id: "designer", emoji: "not-an-emoji" })).success).toBe(false);
  });

  it("maps access levels to tools", () => {
    expect(repoToolsFor("read")).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(repoToolsFor("run")).toContain("Bash");
    expect(repoToolsFor("run")).not.toContain("Edit");
    expect(repoToolsFor("write")).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
  });

  it("builds repo agents from enabled agents only, with platform rules", () => {
    const team = defaultTeam();
    team.agents.find((a) => a.id === "writer")!.enabled = false;
    team.agents.find((a) => a.id === "researcher")!.model = "claude-sonnet-5-5";
    const agents = buildRepoAgents(team);
    expect(Object.keys(agents)).toEqual(["coder", "reviewer", "qa", "researcher", "hr", "scout"]);
    expect(agents.coder!.tools).toContain("Edit");
    expect(agents.reviewer!.tools).not.toContain("Edit");
    expect(agents.coder!.prompt.endsWith(REPO_RULES)).toBe(true);
    expect(agents.researcher!.model).toBe("claude-sonnet-5-5");
    expect(agents.coder!.model).toBeUndefined();
    expect(repoAllowedTools(team)).toEqual(
      expect.arrayContaining(["Read", "Bash", "Agent", "Task", "Edit", "Write", "WebSearch", "WebFetch"]),
    );
  });

  it("builds chat agents with the given safe tools and chat rules", () => {
    const tools = ["WebSearch", "WebFetch", "mcp__pointer__github_list_repos"];
    const agents = buildChatAgents(defaultTeam(), tools);
    expect(agents.coder!.tools).toEqual(tools);
    expect(agents.coder!.prompt.endsWith(CHAT_RULES)).toBe(true);
  });

  it("knows when no agent can change code", () => {
    const team = defaultTeam();
    expect(hasWriteAgent(team)).toBe(true);
    team.agents.forEach((a) => (a.access === "write" ? (a.enabled = false) : null));
    expect(hasWriteAgent(team)).toBe(false);
  });

  it("renders the roster and labels", () => {
    const team = defaultTeam();
    team.agents[0]!.name = "Sara";
    expect(rosterText(team)).toContain("- coder: Sara, Coder (can change code).");
    expect(agentLabel(team.agents[0]!)).toBe(":hammer_and_wrench: Sara (Coder)");
    expect(agentLabel(team.agents[1]!)).toBe(":mag: Reviewer");
    expect(rosterText({ ...team, agents: [] })).toBe("(no agents enabled)");
  });

  it("is chat-ready with Claude and Slack only", async () => {
    const repo = new ConfigRepo(await tmpStore(), deriveKey("k"), 0);
    const c = await repo.update((x) => {
      x.anthropic.apiKey = "sk-ant-x";
      x.slack.botToken = "xoxb-x";
      x.slack.signingSecret = "s".repeat(20);
    });
    expect(isChatReady(c)).toBe(true);
  });
});

describe("memory", () => {
  it("saves, dedupes, forgets and stores encrypted", async () => {
    const store = await tmpStore();
    const memory = new MemoryRepo(store, deriveKey("k"));
    const a = await memory.save("  Main repo is   Acme/acme-platform ", "U1");
    expect(a).toMatchObject({ ok: true, fact: { text: "Main repo is Acme/acme-platform", by: "U1" } });
    const again = await memory.save("main repo is acme/acme-platform");
    expect(again.ok && again.fact.id).toBe(a.ok && a.fact.id);
    expect(await memory.list()).toHaveLength(1);
    expect((await store.get("memory.enc"))!.toString("utf8")).not.toContain("Acme");
    expect(await memory.forget(a.ok ? a.fact.id : "")).toBe(true);
    expect(await memory.forget("m-nope")).toBe(false);
    expect(await memory.list()).toEqual([]);
  });

  it("does not lose facts when saves and deletes race", async () => {
    const memory = new MemoryRepo(await tmpStore(), deriveKey("k"));
    const first = await memory.save("keep me");
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => memory.save(`fact ${i}`)),
      memory.forget(first.ok ? first.fact.id : ""),
    ]);
    const texts = (await memory.list()).map((f) => f.text);
    expect(texts).toHaveLength(10);
    expect(texts).not.toContain("keep me");
  });

  it("rejects empty, too long, and over-capacity facts", async () => {
    const memory = new MemoryRepo(await tmpStore(), deriveKey("k"));
    expect((await memory.save("   ")).ok).toBe(false);
    expect((await memory.save("x".repeat(MEMORY_MAX_CHARS + 1))).ok).toBe(false);
    for (let i = 0; i < MEMORY_MAX_FACTS; i++) expect((await memory.save(`fact ${i}`)).ok).toBe(true);
    const full = await memory.save("one more");
    expect(full.ok).toBe(false);
    expect(!full.ok && full.error).toContain("full");
  }, 30_000);
});

describe("effort", () => {
  it("defaults chat and repo tasks to medium, and agents to the work they are part of", () => {
    const team = defaultTeam();
    expect(DEFAULT_EFFORT).toBe("medium");
    expect(team.pointer).toMatchObject({ model: "", effort: "medium", taskEffort: "medium" });
    expect(team.agents.every((a) => a.effort === "")).toBe(true);
    // A team saved before effort existed parses with the defaults.
    const old = TeamSchema.parse({
      pointer: { name: "Pointer", instructions: "", budgetUsd: 1, maxTurns: 40 },
      agents: team.agents.map(({ effort: _e, ...a }) => a),
    });
    expect(old.pointer).toMatchObject({ model: "", effort: "medium", taskEffort: "medium" });
    expect(old.agents[0]!.effort).toBe("");
  });

  it("rejects unknown effort levels", () => {
    const team = defaultTeam();
    expect(TeamSchema.safeParse({ ...team, pointer: { ...team.pointer, effort: "ultra" } }).success).toBe(false);
    expect(TeamSchema.safeParse({ ...team, agents: [{ ...team.agents[0]!, effort: "huge" }] }).success).toBe(false);
  });

  it("gives repo agents the task effort and chat agents the chat effort unless an agent sets its own", () => {
    const team = defaultTeam();
    team.pointer.effort = "low";
    team.pointer.taskEffort = "xhigh";
    team.agents[1]!.effort = "max";
    const repo = buildRepoAgents(team);
    const chat = buildChatAgents(team, ["WebSearch"]);
    expect(repo[team.agents[0]!.id]!.effort).toBe("xhigh");
    expect(repo[team.agents[1]!.id]!.effort).toBe("max");
    expect(chat[team.agents[0]!.id]!.effort).toBe("low");
    expect(chat[team.agents[1]!.id]!.effort).toBe("max");
  });
});

describe("apps in repo tasks", () => {
  const server = (url: string) => ({ type: "http" as const, url, headers: { Authorization: "Bearer k" }, alwaysLoad: true });
  const browser = { type: "stdio" as const, command: "npx", args: ["@playwright/mcp"] };
  const apps: RepoTaskApps = {
    servers: { "app-linear": server("https://mcp.linear.app/mcp"), "app-sentry": server("https://mcp.sentry.dev/mcp") },
    toolsFor: (id) =>
      id === "coder" ? ["mcp__app-linear__create_issue", "mcp__app-sentry__get_issue"] : id === "researcher" ? ["mcp__app-sentry__get_issue"] : [],
    allToolNames: ["mcp__app-linear__create_issue", "mcp__app-sentry__get_issue"],
    promptRule: "Apps…",
  };

  it("starts each app's server only for the agents that have tools on it, next to the browser", () => {
    const agents = buildRepoAgents(defaultTeam(), { apps, browser });
    expect(agents.coder!.mcpServers).toEqual([{ browser }, { "app-linear": apps.servers["app-linear"] }, { "app-sentry": apps.servers["app-sentry"] }]);
    expect(agents.coder!.tools).toEqual(expect.arrayContaining(["Edit", "mcp__app-linear__create_issue", "mcp__app-sentry__get_issue"]));
    // A looks-only agent has no browser, only its app.
    expect(agents.researcher!.mcpServers).toEqual([{ "app-sentry": apps.servers["app-sentry"] }]);
    expect(agents.researcher!.tools).toContain("mcp__app-sentry__get_issue");
    expect(agents.qa!.mcpServers).toEqual([{ browser }]);
    expect(agents.writer!.mcpServers).toBeUndefined();
    expect(agents.writer!.tools!.some((t) => t.startsWith("mcp__app-"))).toBe(false);
    expect(repoAllowedTools(defaultTeam(), { apps })).toEqual(expect.arrayContaining(apps.allToolNames));
  });

  it("gives each agent its own route when the apps say which (read-only for an agent that only looks)", () => {
    const routed: RepoTaskApps = {
      ...apps,
      serversFor: (id) =>
        id === "coder"
          ? { "app-sentry": server("http://127.0.0.1:4000/app-sentry/all") }
          : id === "researcher"
            ? { "app-sentry": server("http://127.0.0.1:4000/app-sentry/read") }
            : {},
    };
    const agents = buildRepoAgents(defaultTeam(), { apps: routed });
    expect(agents.coder!.mcpServers).toEqual([{ "app-sentry": server("http://127.0.0.1:4000/app-sentry/all") }]);
    expect(agents.researcher!.mcpServers).toEqual([{ "app-sentry": server("http://127.0.0.1:4000/app-sentry/read") }]);
    expect(agents.qa!.mcpServers).toBeUndefined();
  });

  it("is unchanged without apps", () => {
    expect(buildRepoAgents(defaultTeam(), {})).toEqual(buildRepoAgents(defaultTeam()));
    expect(buildRepoAgents(defaultTeam()).coder!.mcpServers).toBeUndefined();
    expect(repoAllowedTools(defaultTeam()).some((t) => t.startsWith("mcp__app-"))).toBe(false);
  });
});
