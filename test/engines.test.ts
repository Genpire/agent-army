import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, ConfigSchema } from "../src/config.js";
import {
  ENGINES_SERVER,
  type EngineDeps,
  SUMMARY_MAX_CHARS,
  codexRunner,
  engineAgentTemplate,
  engineToolName,
  findCommand,
  geminiRunner,
  repoTaskEngines,
  runEngine,
} from "../src/engines.js";
import { createApp } from "../src/server.js";
import { type AgentSpec, buildRepoAgents, defaultTeam, repoAllowedTools } from "../src/team.js";
import { makeRedactor } from "../src/worker.js";

const CODEX_KEY = "sk-proj-engine-test-key-0123456789abcdef";
const GEMINI_KEY = "AIzaEngineTestKey0123456789abcdefghijk";
const CONFIG_SECRET = "config-secret-0123456789";

const sh = promisify(execFile);

/** A stand-in for both CLIs: what it was started with goes to record.json; behavior.json says what it does. */
function fakeCliSource(dir: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const DIR = ${JSON.stringify(dir)};
const behavior = JSON.parse(fs.readFileSync(DIR + "/behavior.json", "utf8"));
const args = process.argv.slice(2);
if (args[0] === "sandbox") process.exit(behavior.sandbox ? 0 : 1);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(DIR + "/record.json", JSON.stringify({ cwd: process.cwd(), env: process.env, args, input }));
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const gemini = args.includes("--output-format");
  if (behavior.kind === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(DIR + "/grandchild.pid", String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (behavior.kind === "fail") {
    process.stderr.write("fatal: the key " + (process.env.CODEX_API_KEY || process.env.GEMINI_API_KEY) + " was refused\\n");
    process.exit(3);
  }
  fs.writeFileSync("feature.txt", "made by the engine\\n");
  const final = behavior.final || "Added feature.txt.";
  if (gemini) {
    emit({ type: "init", session_id: "s1", model: "auto" });
    emit({ type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: "feature.txt", content: "x" } });
    emit({ type: "tool_result", tool_id: "t1", status: "success" });
    emit({ type: "message", role: "assistant", content: final.slice(0, 5), delta: true });
    emit({ type: "message", role: "assistant", content: final.slice(5), delta: true });
    emit({ type: "result", status: "success", stats: { input_tokens: 1200, output_tokens: 300, cached: 100, total_tokens: 1500 } });
  } else {
    emit({ type: "thread.started", thread_id: "t1" });
    emit({ type: "item.completed", item: { id: "1", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: 0, status: "completed" } });
    emit({ type: "item.completed", item: { id: "2", type: "file_change", changes: [{ path: "feature.txt", kind: "add" }], status: "completed" } });
    emit({ type: "item.completed", item: { id: "3", type: "agent_message", text: final } });
    emit({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 0 } });
  }
});
`;
}

interface Record_ {
  cwd: string;
  env: Record<string, string>;
  args: string[];
  input: string;
}

describe("coding agent CLIs in a repo task", () => {
  let root = "";
  let repoDir = "";
  let workRoot = "";
  let engineRoot = "";
  let gitHome = "";
  let fake = "";
  let notes: string[] = [];
  const saved = { MASTER_KEY: process.env.MASTER_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  const behave = (b: { kind?: "ok" | "hang" | "fail"; sandbox?: boolean; final?: string }) => writeFile(join(root, "behavior.json"), JSON.stringify({ kind: "ok", sandbox: true, ...b }));
  const record = async (): Promise<Record_> => JSON.parse(await readFile(join(root, "record.json"), "utf8"));
  const deps = (extra: Partial<EngineDeps> = {}): EngineDeps => ({
    repoDir,
    workRoot,
    redact: makeRedactor([CONFIG_SECRET]),
    note: (text) => notes.push(text),
    commands: { codex: fake, gemini: fake },
    progressEveryMs: 0,
    ...extra,
  });
  const run = (runner: ReturnType<typeof codexRunner>, mode: "read" | "write", extra: Partial<Parameters<typeof runEngine>[1]> = {}) =>
    runEngine(runner, { task: "Add feature.txt with a line of text.", mode, timeoutMin: 1, deps: deps(), root: engineRoot, gitHome, ...extra });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "army-engines-")));
    workRoot = join(root, "work");
    repoDir = join(workRoot, "repo");
    engineRoot = join(workRoot, "engines");
    gitHome = join(root, "git-home");
    for (const d of [repoDir, engineRoot, gitHome]) await mkdir(d, { recursive: true });
    const env = { PATH: process.env.PATH ?? "", HOME: gitHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => sh("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repoDir, env });
    await git("init", "--quiet");
    await writeFile(join(repoDir, "README.md"), "# demo\n");
    await git("add", "-A");
    await git("commit", "--quiet", "-m", "init");
    fake = join(root, "fake-cli.cjs");
    await writeFile(fake, fakeCliSource(root));
    await chmod(fake, 0o755);
    await behave({});
    notes = [];
    // The worker's own secrets: never in a CLI's environment.
    process.env.MASTER_KEY = "worker-master-key-should-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-worker-key-should-not-leak";
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("finds a CLI on PATH, or not", async () => {
    expect(await findCommand("fake-cli.cjs", root)).toBe(fake);
    expect(await findCommand(fake)).toBe(fake);
    expect(await findCommand("codex-not-installed-here", root)).toBeUndefined();
    expect(await findCommand(join(root, "missing"))).toBeUndefined();
  });

  it("says so when the CLI cannot start", async () => {
    const notExecutable = join(root, "behavior.json");
    const result = await run(codexRunner(notExecutable, CODEX_KEY, "", repoDir, true), "write");
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Codex failed after .*: it could not start \(/);
  });

  it("runs Codex in the checkout with a minimal environment and reports what changed", async () => {
    const result = await run(codexRunner(fake, CODEX_KEY, "gpt-test", repoDir, true), "write");
    const r = await record();
    expect(r.cwd).toBe(repoDir);
    const keys = Object.keys(r.env)
      .filter((k) => !k.startsWith("__CF")) // macOS adds its own
      .sort();
    expect(keys).toEqual(["CI", "CODEX_API_KEY", "CODEX_HOME", "HOME", "LANG", "NO_COLOR", "PATH", "TMPDIR"]);
    expect(r.env.CODEX_API_KEY).toBe(CODEX_KEY);
    expect(r.env.CI).toBe("1");
    expect(r.env.HOME).toBe(r.env.CODEX_HOME);
    expect(r.env.HOME.startsWith(engineRoot)).toBe(true);
    expect(JSON.stringify(r.env)).not.toContain("should-not-leak");
    expect(r.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(r.args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--cd", repoDir, "--model", "gpt-test", "shell_environment_policy.ignore_default_excludes=false"]));
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(r.args.at(-1)).toBe("-");
    expect(r.input).toContain("Add feature.txt with a line of text.");
    expect(r.input).toContain("Do not commit, push");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Codex finished");
    expect(result.text).toContain("?? feature.txt");
    expect(result.text).toContain("Added feature.txt.");
    expect(result.text).toContain("Tokens: 1200 in (100 cached), 300 out");
    expect(notes[0]).toMatch(/^Codex started: Add feature\.txt/);
    expect(notes).toContain("Codex: ran `npm test` (exit 0)");
    expect(notes).toContain("Codex: changed feature.txt");
    expect(notes.at(-1)).toMatch(/^Codex finished after .* · 1 file changed in the checkout · tokens 1200 in/);
  });

  it("runs Codex without its sandbox when the container has none, and read-only only with it", async () => {
    await run(codexRunner(fake, CODEX_KEY, "", repoDir, false), "write");
    let r = await record();
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    expect(r.args).not.toContain("--model");

    await run(codexRunner(fake, CODEX_KEY, "", repoDir, true), "read");
    r = await record();
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(r.input).toContain("Work read-only");

    await rm(join(root, "record.json"));
    const refused = await run(codexRunner(fake, CODEX_KEY, "", repoDir, false), "read");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("cannot be kept read-only");
    await expect(readFile(join(root, "record.json"))).rejects.toThrow();
  });

  it("runs Gemini CLI headless with its own home, trusted workspace and yolo or read-only approvals", async () => {
    const result = await run(geminiRunner(fake, GEMINI_KEY, "gemini-test", repoDir), "write");
    const r = await record();
    expect(r.cwd).toBe(repoDir);
    expect(r.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--model", "gemini-test"]));
    expect(r.args[r.args.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(r.env).toMatchObject({ GEMINI_API_KEY: GEMINI_KEY, GEMINI_CLI_TRUST_WORKSPACE: "true", GOOGLE_GEMINI_BASE_URL: "", GOOGLE_GENAI_USE_VERTEXAI: "false" });
    expect(r.env.GEMINI_CLI_HOME).toBe(r.env.HOME);
    expect(JSON.stringify(r.env)).not.toContain("should-not-leak");
    expect(r.env.CODEX_API_KEY).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Added feature.txt.");
    expect(result.text).toContain("Tokens: 1200 in (100 cached), 300 out");
    expect(notes).toContain("Gemini CLI: write_file feature.txt");

    await run(geminiRunner(fake, GEMINI_KEY, "", repoDir), "read");
    expect((await record()).args[(await record()).args.indexOf("--approval-mode") + 1]).toBe("default");
  });

  it("does not start Gemini CLI where the checkout's own .gemini could change it", async () => {
    await mkdir(join(repoDir, ".gemini"));
    const readOnly = await run(geminiRunner(fake, GEMINI_KEY, "", repoDir), "read");
    expect(readOnly.ok).toBe(false);
    expect(readOnly.text).toContain("cannot be kept read-only");
    await writeFile(join(repoDir, ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=https://example.invalid\n");
    const write = await run(geminiRunner(fake, GEMINI_KEY, "", repoDir), "write");
    expect(write.ok).toBe(false);
    expect(write.text).toContain(".gemini/.env");
    await expect(readFile(join(root, "record.json"))).rejects.toThrow();
  });

  it("kills the CLI and everything it started at the timeout", { timeout: 20_000 }, async () => {
    await behave({ kind: "hang" });
    const result = await runEngine(codexRunner(fake, CODEX_KEY, "", repoDir, true), {
      task: "Never finish.",
      mode: "write",
      timeoutMin: 1,
      deps: deps({ minuteMs: 2_000 }),
      root: engineRoot,
      gitHome,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("timed out after 1 min");
    const pid = Number(await readFile(join(root, "grandchild.pid"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it("caps and redacts what it returns and writes to the timeline", async () => {
    await behave({ final: `Done. The key is ${CODEX_KEY} and the config has ${CONFIG_SECRET}. ${"x".repeat(50_000)}` });
    const result = await run(codexRunner(fake, CODEX_KEY, "", repoDir, true), "write", { task: `Use ${CONFIG_SECRET} nowhere.` });
    expect(result.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(result.text).not.toContain(CODEX_KEY);
    expect(result.text).not.toContain(CONFIG_SECRET);
    expect(result.text).toContain("[redacted]");
    expect(result.text).toContain("cut at");
    expect(notes.join("\n")).not.toContain(CONFIG_SECRET);
    expect(notes.every((n) => n.length <= 240)).toBe(true);

    // A key right where the final message is cut (6 000 characters) is redacted first, never left in part.
    await behave({ final: `${"x".repeat(5_950)}${CODEX_KEY}${"y".repeat(200)}` });
    const atCut = await run(codexRunner(fake, CODEX_KEY, "", repoDir, true), "write");
    expect(atCut.text).not.toContain(CODEX_KEY.slice(0, 10));
    expect(atCut.text).toContain("x[redacted]");

    await behave({ kind: "fail" });
    const failed = await run(codexRunner(fake, CODEX_KEY, "", repoDir, true), "write");
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("exited with code 3");
    expect(failed.text).toContain("fatal: the key [redacted] was refused");
    expect(failed.text).not.toContain(CODEX_KEY);
  });

  describe("repoTaskEngines", () => {
    const agent = (id: string, engine: AgentSpec["engine"], access: AgentSpec["access"]): AgentSpec => ({
      ...engineAgentTemplate(engine === "claude" ? "codex" : engine, id),
      name: id[0]!.toUpperCase() + id.slice(1),
      access,
      engine,
    });
    const configWith = (agents: AgentSpec[], keys: { codex?: string; gemini?: string } = {}): Config => {
      const team = defaultTeam();
      return ConfigSchema.parse({
        team: { ...team, agents: [...team.agents, ...agents] },
        engines: { codex: { apiKey: keys.codex, model: "" }, gemini: { apiKey: keys.gemini, model: "" } },
      });
    };

    it("is undefined when no enabled agent uses an engine", async () => {
      expect(await repoTaskEngines(configWith([], { codex: CODEX_KEY }), deps())).toBeUndefined();
      expect(notes).toEqual([]);
    });

    it("leaves out engines that are not connected or not installed, with a note", async () => {
      const agents = [agent("codex", "codex", "write"), agent("gemini", "gemini", "write")];
      expect(await repoTaskEngines(configWith(agents), deps())).toBeUndefined();
      expect(notes).toEqual(["Codex is not connected: Codex works as Claude in this task.", "Gemini CLI is not connected: Gemini works as Claude in this task."]);
      notes = [];
      const missing = join(root, "not-installed");
      expect(await repoTaskEngines(configWith(agents, { codex: CODEX_KEY, gemini: GEMINI_KEY }), deps({ commands: { codex: missing, gemini: missing } }))).toBeUndefined();
      expect(notes[0]).toContain("Codex left out: its CLI (codex) is not installed in this image");
      expect(notes[1]).toContain("Gemini CLI left out: its CLI (gemini) is not installed");
    });

    it("gives engine agents a light subagent with the run tool and the server at the top level", async () => {
      const coder = agent("codex", "codex", "write");
      const looker = agent("gemini", "gemini", "read");
      const config = configWith([coder, looker], { codex: CODEX_KEY, gemini: GEMINI_KEY });
      const engines = (await repoTaskEngines(config, deps()))!;
      expect(notes).toEqual(["Codex runs in its own sandbox."]);
      expect(Object.keys(engines.servers)).toEqual([ENGINES_SERVER]);
      expect(engines.allToolNames).toEqual([engineToolName("codex", "write"), engineToolName("gemini", "read")]);
      expect(engines.allToolNames).toEqual(["mcp__engines__codex_run", "mcp__engines__gemini_run_read_only"]);
      expect(engines.promptRule).toContain("- codex (Codex, Coder (Codex)) works through Codex and changes files.");
      expect(engines.promptRule).toContain("- gemini (Gemini, Coder (Gemini CLI)) works through Gemini CLI and looks only.");

      const base: AgentDefinition = { description: "Codex (Coder): writes code", tools: ["Read", "Edit"], prompt: "My own instructions.", effort: "medium" };
      const def = engines.agentDefinition(coder, base)!;
      expect(def.tools).toEqual(["mcp__engines__codex_run", "Read", "Glob", "Grep", "Bash"]);
      expect(def.model).toBe("haiku");
      expect(def.description).toBe(base.description);
      expect(def.mcpServers).toBeUndefined();
      expect(def.prompt).toContain("You are Codex, the team's Coder (Codex). You work through Codex, OpenAI's coding agent");
      expect(def.prompt).toContain("Send the whole assignment to mcp__engines__codex_run in one call");
      expect(def.prompt).toContain("My own instructions.");
      expect(engines.agentDefinition(coder, { ...base, model: "claude-haiku-5-5" })!.model).toBe("claude-haiku-5-5");

      const readDef = engines.agentDefinition(looker, base)!;
      expect(readDef.tools).toEqual(["mcp__engines__gemini_run_read_only", "Read", "Glob", "Grep"]);
      // An agent on Claude, or on an engine this task does not have, keeps its own definition.
      expect(engines.agentDefinition({ ...coder, id: "other", engine: "gemini" }, base)).toBeUndefined();

      // Through the team builder: engine agents get theirs, everyone else stays as they were.
      const agents = buildRepoAgents(config.team, { engines });
      expect(agents.codex!.tools![0]).toBe("mcp__engines__codex_run");
      expect(agents.coder!.tools).toContain("Edit");
      expect(repoAllowedTools(config.team, { engines })).toEqual(expect.arrayContaining(engines.allToolNames));
    });

    it("works without Codex's sandbox, leaving read-only Codex agents on Claude", async () => {
      await behave({ sandbox: false });
      const coder = agent("codex", "codex", "write");
      const reviewer = agent("checker", "codex", "read");
      const engines = (await repoTaskEngines(configWith([coder, reviewer], { codex: CODEX_KEY }), deps()))!;
      expect(notes).toEqual(["Codex runs without its sandbox; the task container is the boundary.", "Codex cannot run read-only without its sandbox: Checker works as Claude in this task."]);
      expect(engines.allToolNames).toEqual(["mcp__engines__codex_run"]);
      expect(engines.agentDefinition(reviewer, { description: "d", prompt: "p" })).toBeUndefined();
    });
  });
});

/** The admin routes through the real HTTP API (OpenAI and Google faked). */
describe("Engines admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as { config: { engines: Record<string, unknown>; team: { agents: AgentSpec[] } } };
  const reply = async (res: Response) => ({ status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; agent?: AgentSpec } });

  /** Answers OpenAI's and Google's model lists; everything else (this test's own requests) goes through. */
  function stubVendors(status: { openai: number; google: number }) {
    const realFetch = globalThis.fetch;
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.openai.com" && url.hostname !== "generativelanguage.googleapis.com") return realFetch(input, init);
      calls.push({ url: url.toString(), headers: new Headers(init?.headers) });
      return new Response("{}", { status: url.hostname === "api.openai.com" ? status.openai : status.google });
    });
    return calls;
  }

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-engines-api-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.SKIP_VALIDATION = "1";
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only and knows only its engines", async () => {
    expect((await post("/api/engines/codex", { apiKey: CODEX_KEY }, false)).status).toBe(401);
    expect((await post("/api/engines/codex/disconnect", {}, false)).status).toBe(401);
    expect((await post("/api/engines/codex/agent", {}, false)).status).toBe(401);
    expect(await reply(await post("/api/engines/cursor", { apiKey: CODEX_KEY }))).toEqual({ status: 404, body: { error: "Unknown engine." } });
  });

  it("checks the key with the vendor, keeps it out of every response and saves the model alone", async () => {
    delete process.env.SKIP_VALIDATION;
    let calls = stubVendors({ openai: 401, google: 400 });
    expect(await reply(await post("/api/engines/codex", { apiKey: CODEX_KEY }))).toEqual({ status: 400, body: { error: "OpenAI rejected this API key." } });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${CODEX_KEY}`);
    expect(await reply(await post("/api/engines/gemini", { apiKey: GEMINI_KEY }))).toEqual({ status: 400, body: { error: "Google rejected this Gemini API key." } });
    // The Gemini key goes in a header, never in the URL.
    expect(calls[1]!.url).not.toContain(GEMINI_KEY);
    expect(calls[1]!.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);

    vi.unstubAllGlobals();
    calls = stubVendors({ openai: 200, google: 200 });
    expect(await reply(await post("/api/engines/codex", { apiKey: "short" }))).toEqual({ status: 400, body: { error: "That doesn't look like an OpenAI API key." } });
    expect(await reply(await post("/api/engines/codex", { model: "gpt-x" }))).toEqual({ status: 400, body: { error: "Paste an OpenAI API key to connect Codex." } });
    expect((await reply(await post("/api/engines/codex", { apiKey: CODEX_KEY, model: "bad model;" }))).status).toBe(400);
    const saved = await post("/api/engines/codex", { apiKey: ` ${CODEX_KEY} `, model: "gpt-x" });
    expect(await reply(saved)).toEqual({ status: 200, body: { ok: true } });

    // A model change alone keeps the key and does not call OpenAI again.
    const before = calls.length;
    expect((await post("/api/engines/codex", { model: "" })).status).toBe(200);
    expect(calls.length).toBe(before);
    const s = await state();
    expect(s.config.engines.codex).toEqual({ connected: true, key: `••••${CODEX_KEY.slice(-4)}`, model: "", checkedAt: expect.any(String) });
    expect(JSON.stringify(s)).not.toContain(CODEX_KEY);
  });

  it("adds a ready-made team member once, and only when connected", async () => {
    expect(await reply(await post("/api/engines/gemini/agent", {}))).toEqual({ status: 400, body: { error: "Connect Gemini CLI first." } });
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY })).status).toBe(200);
    const added = await reply(await post("/api/engines/gemini/agent", {}));
    expect(added.status).toBe(200);
    expect(added.body.agent).toMatchObject({ id: "gemini", name: "Gemini", role: "Coder (Gemini CLI)", access: "write", engine: "gemini", enabled: true });
    expect((await state()).config.team.agents.filter((a) => a.engine === "gemini").map((a) => a.id)).toEqual(["gemini"]);
    expect(await reply(await post("/api/engines/gemini/agent", {}))).toEqual({ status: 409, body: { error: "Gemini already works through Gemini CLI." } });
  });

  it("disconnects, keeping the model and the agents", async () => {
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY, model: "gemini-test" })).status).toBe(200);
    expect(await reply(await post("/api/engines/gemini/disconnect", {}))).toEqual({ status: 200, body: { ok: true } });
    const s = await state();
    expect(s.config.engines.gemini).toEqual({ connected: false, key: null, model: "gemini-test", checkedAt: null });
  });
});
