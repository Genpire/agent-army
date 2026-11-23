import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { type AgentSpec, AGENT_FALLBACK_MAX, type Team, TeamSaveSchema, TeamSchema, defaultTeam, fallbackProblem } from "../../src/team/team.js";

/** The default team with Dana, a developer on Gemini CLI, whose fallback is `fallback`. */
const teamWith = (fallback: unknown, o: Partial<AgentSpec> = {}) => {
  const t = defaultTeam();
  return { ...t, agents: [...t.agents, { ...t.agents[0]!, id: "dana", name: "Dana", role: "Developer", engine: "gemini", engineModel: "", fallback, ...o }] };
};
const danaOf = (team: Team) => team.agents.find((a) => a.id === "dana")!;

describe("an agent's fallback, as the owner saves it", () => {
  it("takes other engines in order, each once, a CLI not connected included, and Claude last", () => {
    const parsed = TeamSaveSchema.parse(teamWith([{ engine: "codex", model: "gpt-6.2-sol" }, { engine: "claude", model: "" }]));
    expect(danaOf(parsed).fallback).toEqual([
      { engine: "codex", model: "gpt-6.2-sol" },
      { engine: "claude", model: "" },
    ]);
    // A model left out is the engine's own; Claude's model is the team's.
    expect(danaOf(TeamSaveSchema.parse(teamWith([{ engine: "codex" }, { engine: "claude", model: "claude-ignored" }]))).fallback).toEqual([
      { engine: "codex", model: "" },
      { engine: "claude", model: "" },
    ]);
    // An agent on Claude has none: Claude is the last resort.
    expect(danaOf(TeamSaveSchema.parse(teamWith([{ engine: "codex", model: "" }], { engine: "claude" }))).fallback).toEqual([]);
  });

  it("refuses its own engine, an engine twice, anything after Claude, a bad model and too many steps", () => {
    const problem = (fallback: unknown, o: Partial<AgentSpec> = {}) => TeamSaveSchema.safeParse(teamWith(fallback, o)).error?.issues[0];
    expect(problem([{ engine: "gemini", model: "" }])).toMatchObject({ path: ["agents", 8, "fallback", 0, "engine"], message: "Gemini CLI is the agent's own engine, so it cannot be its fallback." });
    expect(problem([{ engine: "codex", model: "a" }, { engine: "codex", model: "b" }])?.message).toBe("Codex is in the fallback twice.");
    expect(problem([{ engine: "claude", model: "" }, { engine: "codex", model: "" }])?.message).toBe("Nothing can come after Claude in a fallback: Claude is the last resort.");
    expect(problem([{ engine: "codex", model: "bad model;" }])?.path).toEqual(["agents", 8, "fallback", 0, "model"]);
    expect(problem([{ engine: "cursor", model: "" }])?.path).toEqual(["agents", 8, "fallback", 0, "engine"]);
    expect(problem(Array.from({ length: AGENT_FALLBACK_MAX + 1 }, () => ({ engine: "codex", model: "" })))?.path).toEqual(["agents", 8, "fallback"]);
    expect(fallbackProblem({ engine: "codex", fallback: [{ engine: "gemini", model: "" }] })).toBeUndefined();
    // A stored team loads without these checks.
    expect(TeamSchema.safeParse(teamWith([{ engine: "gemini", model: "" }])).success).toBe(true);
  });
});

/** POST /api/team through the real HTTP API. */
describe("saving a team with fallbacks", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const savedTeam = async (): Promise<Team> => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()).config.team;

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-fallback-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-fallback", RUNNER: "local" }, { runner: { kind: "local", launch: async () => undefined } });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-fallback", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("saves a valid line and refuses an invalid one, naming the agent", async () => {
    const ok = await post("/api/team", teamWith([{ engine: "codex", model: "gpt-6.2-sol" }, { engine: "claude", model: "" }]));
    expect(ok.status).toBe(200);
    expect(danaOf(await savedTeam()).fallback).toEqual([
      { engine: "codex", model: "gpt-6.2-sol" },
      { engine: "claude", model: "" },
    ]);

    const own = await post("/api/team", teamWith([{ engine: "gemini", model: "" }]));
    expect(own.status).toBe(400);
    expect(await own.json()).toEqual({ error: 'Agent "dana": Gemini CLI is the agent\'s own engine, so it cannot be its fallback.' });
    const badModel = await post("/api/team", teamWith([{ engine: "codex", model: "bad model;" }]));
    expect(badModel.status).toBe(400);
    expect((await badModel.json()).error).toMatch(/^Agent "dana": /);
    // The saved team is still the valid one.
    expect(danaOf(await savedTeam()).fallback).toHaveLength(2);
  });
});
