import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { type Config, ConfigSchema } from "../src/config.js";
import type { QueryFn } from "../src/pointer.js";
import { createApp } from "../src/server.js";
import {
  CANDIDATES_SCHEMA,
  KNOWN_SOURCE,
  SCOUT_BUDGET_USD,
  findSkills,
  parseCandidates,
  scoutSystemPrompt,
} from "../src/skill-scout.js";
import { defaultTeam } from "../src/team.js";
import { monthKey } from "../src/usage.js";

const PDF = "https://github.com/anthropics/skills/tree/main/skills/pdf";

const candidate = (patch: Record<string, unknown> = {}) => ({
  name: "pdf",
  description: "Reads, fills and merges PDF files.",
  url: PDF,
  license: "Apache-2.0",
  runsScripts: true,
  why: "The team is asked to fill PDF forms.",
  forAgents: ["coder", "writer"],
  ...patch,
});

const result = (patch: Record<string, unknown> = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.12, num_turns: 4, errors: [], ...patch }) as unknown as SDKMessage;

function fakeQuery(...messages: SDKMessage[]) {
  const calls: { prompt: unknown; options: Options }[] = [];
  const queryFn: QueryFn = async function* (params) {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    for (const m of messages) yield m;
  };
  return { queryFn, calls };
}

const config = (patch: (c: Config) => void = () => {}): Config => {
  const c = ConfigSchema.parse({});
  c.anthropic.apiKey = "sk-ant-scout-secret-0000";
  c.github.token = "github_pat_scout_secret_000000";
  patch(c);
  return c;
};

describe("Skills Scout candidates", () => {
  it("keeps installable GitHub folders, known agents and text cut to size", () => {
    const team = defaultTeam();
    const got = parseCandidates(
      {
        candidates: [
          candidate({ forAgents: ["coder", "ghost", "coder"], description: "  spaced\n\nout  " }),
          candidate({ url: `${PDF}/`, name: "dupe" }),
          candidate({ url: "https://skills.example.com/pdf", name: "elsewhere" }),
          candidate({ url: "https://github.com/acme", name: "not-a-folder" }),
          candidate({ name: "", url: "https://github.com/acme/skills/tree/main/a" }),
          { name: "broken" },
          candidate({ name: "docx", url: "https://github.com/anthropics/skills/tree/main/skills/docx", why: "w".repeat(2000), license: undefined, runsScripts: undefined, forAgents: [] }),
        ],
      },
      team,
    );
    expect(got.map((c) => c.name)).toEqual(["pdf", "docx"]);
    expect(got[0]).toEqual({ ...candidate(), description: "spaced out", forAgents: ["coder"] });
    expect(got[1]!.why).toHaveLength(800);
    expect(got[1]).not.toHaveProperty("license");
    expect(got[1]).not.toHaveProperty("forAgents");
    expect(parseCandidates(undefined, team)).toEqual([]);
    expect(parseCandidates({ candidates: "nope" }, team)).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => candidate({ name: `s${i}`, url: `https://github.com/acme/skills/tree/main/s${i}` }));
    expect(parseCandidates({ candidates: many }, team)).toHaveLength(5);
  });

  it("asks with the Scout's own instructions, the roster, the library and Anthropic's repository", () => {
    const team = defaultTeam();
    const prompt = scoutSystemPrompt(team, ["pdf"]);
    expect(prompt.startsWith(team.agents.find((a) => a.id === "scout")!.instructions)).toBe(true);
    expect(prompt).toContain(KNOWN_SOURCE);
    expect(prompt).toContain("- coder: Coder, Coder.");
    expect(prompt).toContain("- pdf\nDo not suggest these again.");
    expect(prompt).toContain("not instructions");

    team.agents = team.agents.filter((a) => a.id !== "scout");
    const fallback = scoutSystemPrompt(team, []);
    expect(fallback.startsWith("You are the Skills Scout.")).toBe(true);
    expect(fallback).toContain("Nothing yet.");
  });
});

describe("findSkills", () => {
  it("runs one read-only query within a small budget and counts its cost", async () => {
    const { queryFn, calls } = fakeQuery(result({ structured_output: { candidates: [candidate()] } }));
    const recorded: (number | undefined)[] = [];
    let notified = 0;
    const got = await findSkills("  fill in PDF forms  ", {
      config: config((c) => {
        c.team.agents.find((a) => a.id === "scout")!.model = "claude-haiku-5-5";
      }),
      installed: ["docx"],
      queryFn,
      spending: { checkChat: async () => ({ ok: true }), notify: async () => void notified++ },
      usage: { recordChat: async (usd) => void recorded.push(usd) },
    });
    expect(got).toEqual({ ok: true, candidates: [candidate()], costUsd: 0.12 });
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded).toEqual([0.12]);
    expect(notified).toBe(1);

    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(calls[0]!.prompt).toBe("Find Claude skills for this need:\nfill in PDF forms");
    expect(o.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(o.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Agent", "Skill"]));
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(false);
    expect(o.maxBudgetUsd).toBe(SCOUT_BUDGET_USD);
    expect(SCOUT_BUDGET_USD).toBe(0.5);
    expect(o.model).toBe("claude-haiku-5-5");
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: CANDIDATES_SCHEMA });
    expect(o.systemPrompt as string).toContain("- docx");
    expect(o).not.toHaveProperty("plugins");
    expect(o).not.toHaveProperty("mcpServers");
    // Only what the CLI needs: none of the service's secrets.
    expect(Object.keys(o.env ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "HOME", "LANG", "PATH"]);
    expect(JSON.stringify(o.env)).not.toContain("github_pat");
  });

  it("is refused when the monthly cap is used up, before any query", async () => {
    const { queryFn, calls } = fakeQuery(result());
    const got = await findSkills("pdf", {
      config: config(),
      installed: [],
      queryFn,
      spending: { checkChat: async () => ({ ok: false, error: "This month's Claude budget is used up." }), notify: async () => {} },
    });
    expect(got).toEqual({ ok: false, status: 409, error: "This month's Claude budget is used up." });
    expect(calls).toHaveLength(0);
  });

  it("needs Claude and a need", async () => {
    const { queryFn, calls } = fakeQuery(result());
    expect(await findSkills("pdf", { config: config((c) => (c.anthropic.apiKey = undefined)), installed: [], queryFn })).toMatchObject({ ok: false, status: 400 });
    expect(await findSkills("   ", { config: config(), installed: [], queryFn })).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("reports a failed search, redacted, and still counts its cost", async () => {
    const recorded: (number | undefined)[] = [];
    const usage = { recordChat: async (usd: number | undefined) => void recorded.push(usd) };
    const budget = await findSkills("pdf", { config: config(), installed: [], usage, queryFn: fakeQuery(result({ subtype: "error_max_budget_usd", total_cost_usd: 0.5 })).queryFn });
    expect(budget).toMatchObject({ ok: false, status: 502, error: expect.stringContaining("$0.50 budget") });
    const failed = await findSkills("pdf", {
      config: config(),
      installed: [],
      usage,
      queryFn: fakeQuery(result({ is_error: true, result: "Invalid key sk-ant-scout-secret-0000" })).queryFn,
    });
    expect(failed).toMatchObject({ ok: false, status: 502 });
    expect(failed.ok === false && failed.error).not.toContain("sk-ant-scout-secret-0000");
    const thrown: QueryFn = async function* () {
      yield* [];
      throw new Error("spawn failed");
    };
    expect(await findSkills("pdf", { config: config(), installed: [], queryFn: thrown })).toMatchObject({ ok: false, status: 502, error: expect.stringContaining("spawn failed") });
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded).toEqual([0.5, 0.12]);
  });

  it("finds nothing when the Scout returns no candidates", async () => {
    const got = await findSkills("something obscure", { config: config(), installed: [], queryFn: fakeQuery(result({ structured_output: { candidates: [] } })).queryFn });
    expect(got).toEqual({ ok: true, candidates: [], costUsd: 0.12 });
  });
});

describe("POST /api/skills/find", () => {
  it("returns the Scout's candidates, and refuses when the monthly cap is used up", async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-scout-api-"));
    const { queryFn, calls } = fakeQuery(result({ structured_output: { candidates: [candidate()] } }));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { skills: { scoutQuery: queryFn } });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = "";
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    try {
      cookie = (await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" })).headers.get("set-cookie")!.split(";")[0]!;
      expect((await post("/api/skills/find", { need: "pdf forms" })).status).toBe(400); // Claude not connected
      expect((await post("/api/anthropic", { apiKey: "sk-ant-0123456789abcd" })).status).toBe(200);
      expect((await post("/api/skills/find", { need: "" })).status).toBe(400);

      const found = await post("/api/skills/find", { need: "fill PDF forms" });
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({ candidates: [candidate()], costUsd: 0.12 });
      expect(calls).toHaveLength(1);

      // The search's cost is counted with chat (in the background).
      const usageFile = join(dir, "usage", `chat-${monthKey(new Date())}.json`);
      for (let i = 0; i < 100 && !existsSync(usageFile); i++) await new Promise((r) => setTimeout(r, 10));
      expect(JSON.parse(await readFile(usageFile, "utf8"))).toEqual({ usd: 0.12, count: 1 });

      // Spend past a $1 monthly cap: the Scout is refused before it runs.
      await mkdir(join(dir, "usage"), { recursive: true });
      await writeFile(usageFile, JSON.stringify({ usd: 5, count: 2 }));
      expect((await post("/api/budget", { monthlyUsd: 1 })).status).toBe(200);
      const refused = await post("/api/skills/find", { need: "fill PDF forms" });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toContain("used up");
      expect(calls).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
