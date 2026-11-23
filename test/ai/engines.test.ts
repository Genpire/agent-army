import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition, McpSdkServerConfigWithInstance, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetSchema, type Config, ConfigSchema } from "../../src/core/config.js";
import { agentsLeftOut, teamWithout } from "../../src/spending/budget.js";
import {
  ENGINES_SERVER,
  type EngineDeps,
  type RepoTaskEngines,
  agentEngineToolName,
  LINE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  codexRunner,
  coreutilsTimeout,
  engineAgentTemplate,
  engineToolName,
  findCommand,
  geminiRunner,
  geminiSystemSettingsProblem,
  parseCodexEvent,
  parseGeminiEvent,
  repoTaskEngines,
  runEngine,
  timeoutStartFailure,
} from "../../src/ai/engines.js";
import { GEMINI_NO_MCP_SERVER, GEMINI_SYSTEM_SETTINGS, GEMINI_SYSTEM_SETTINGS_PATH } from "../../src/ai/gemini-settings.js";
import { createApp } from "../../src/server.js";
import { type AgentSpec, buildRepoAgents, defaultTeam, repoAllowedTools, repoToolsFor } from "../../src/team/team.js";
import { makeRedactor } from "../../src/tasks/worker.js";

const CODEX_KEY = "sk-proj-engine-test-key-0123456789abcdef";
const GEMINI_KEY = "AIzaEngineTestKey0123456789abcdefghijk";
const CONFIG_SECRET = "config-secret-0123456789";
/** A secret the JSON line escapes: a quote, a backslash and a newline. */
const ESCAPED_SECRET = 'pa"ss\\word\nnext-line-0123456789';
const REPO_ROOT = resolve(import.meta.dirname, "../..");

const sh = promisify(execFile);

/** Calls the engines server's tools the way the CLI would, over an in-memory transport. */
async function mcpClient(server: McpSdkServerConfigWithInstance) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    listTools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean },
  };
}

/** A stand-in for both CLIs: what it was started with goes to record.json; behavior.json says what it does. */
function fakeCliSource(dir: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const DIR = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const gemini = args.includes("--output-format");
const all = JSON.parse(fs.readFileSync(DIR + "/behavior.json", "utf8"));
// One CLI's own behavior, when behavior.json has one for it.
const behavior = { ...all, ...(gemini ? all.gemini : all.codex) };
if (args[0] === "sandbox") process.exit(behavior.sandbox ? 0 : 1);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const home = process.env.GEMINI_CLI_HOME;
  const userSettings = home && fs.existsSync(home + "/.gemini/settings.json") ? JSON.parse(fs.readFileSync(home + "/.gemini/settings.json", "utf8")) : undefined;
  const record = JSON.stringify({ cwd: process.cwd(), env: process.env, args, input, userSettings });
  fs.writeFileSync(DIR + "/record.json", record);
  fs.writeFileSync(DIR + "/record-" + (gemini ? "gemini" : "codex") + ".json", record);
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (behavior.kind === "apiError") {
    // The CLI's own failure, as each reports it on stdout: Gemini CLI's error result, Codex's error and turn.failed.
    if (gemini) emit({ type: "result", status: "error", error: { type: behavior.errorType || "Error", message: behavior.message }, stats: {} });
    else {
      emit({ type: "error", message: behavior.message });
      emit({ type: "turn.failed", error: { message: behavior.message } });
    }
    process.exit(behavior.exitCode ?? 1);
  }
  if (behavior.kind === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(DIR + "/cli.pid", String(process.pid));
    fs.writeFileSync(DIR + "/grandchild.pid", String(child.pid));
    for (const o of behavior.before || []) emit(o);
    setInterval(() => {}, 1000);
    return;
  }
  if (behavior.kind === "fail") {
    process.stderr.write("fatal: the key " + (process.env.CODEX_API_KEY || process.env.GEMINI_API_KEY) + " was refused\\n");
    process.exit(3);
  }
  for (const o of behavior.before || []) emit(o);
  if (behavior.longLine) emit({ type: "item.completed", item: { id: "0", type: "agent_message", text: "L".repeat(behavior.longLine) } });
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
    emit({ type: "item.completed", item: { id: "1", type: "command_execution", command: behavior.command || "npm test", aggregated_output: "", exit_code: 0, status: "completed" } });
    emit({ type: "item.completed", item: { id: "2", type: "file_change", changes: [{ path: "feature.txt", kind: "add" }], status: "completed" } });
    emit({ type: "item.completed", item: { id: "3", type: "agent_message", text: final } });
    emit({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 0 } });
  }
});
`;
}

/** A stand-in for coreutils `timeout`: records its arguments, then runs the command (or fails as behavior.json says). */
function fakeTimeoutSource(dir: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const DIR = ${JSON.stringify(dir)};
const behavior = JSON.parse(fs.readFileSync(DIR + "/behavior.json", "utf8"));
const args = process.argv.slice(2);
fs.writeFileSync(DIR + "/timeout-record.json", JSON.stringify(args));
if (behavior.timeoutExit === 127) {
  process.stderr.write(process.argv[1] + ": failed to run command '" + args[2] + "': No such file or directory\\n");
  process.exit(127);
}
if (behavior.timeoutExit === 124) process.exit(124);
// The Rust coreutils' \`timeout\`: signalled itself, it exits 124 as if its own deadline had come.
if (behavior.timeoutOnTerm) process.on("SIGTERM", () => process.exit(behavior.timeoutOnTerm));
const child = spawn(args[2], args.slice(3), { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`;
}

/** A worker in a process of its own: runs a hanging CLI through runCli, then waits (to be signalled or killed). */
function workerSource(dir: string): string {
  return `import { runCli } from ${JSON.stringify(join(REPO_ROOT, "src/ai/engines.ts"))};
const [fake, mode, timeoutCommand] = process.argv.slice(2);
if (mode === "graceful") process.on("SIGTERM", () => setTimeout(() => process.exit(7), 300));
const run = runCli({
  command: fake,
  args: ["exec"],
  cwd: ${JSON.stringify(dir)},
  env: { PATH: process.env.PATH ?? "" },
  input: "",
  timeoutMs: 120_000,
  ...(mode === "backstop" ? { backstop: { command: timeoutCommand, seconds: 1 } } : {}),
});
await run;
`;
}

interface Record_ {
  cwd: string;
  env: Record<string, string>;
  args: string[];
  input: string;
  userSettings?: unknown;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
  return check();
};

describe("coding agent CLIs in a repo task", () => {
  let root = "";
  let repoDir = "";
  let workRoot = "";
  let engineRoot = "";
  let gitHome = "";
  let fake = "";
  let fakeTimeout = "";
  let settingsFile = "";
  let notes: string[] = [];
  const saved = { MASTER_KEY: process.env.MASTER_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  interface Behavior {
    kind?: "ok" | "hang" | "fail" | "apiError";
    sandbox?: boolean;
    final?: string;
    command?: string;
    before?: unknown[];
    longLine?: number;
    timeoutExit?: number;
    /** The fake `timeout` exits with this code when it gets SIGTERM. */
    timeoutOnTerm?: number;
    /** apiError: the CLI's own words, its error class (Gemini CLI) and exit code. */
    message?: string;
    errorType?: string;
    exitCode?: number;
  }
  /** What the fake CLIs do; `codex` and `gemini` override it for that CLI alone. */
  const behave = (b: Behavior & { codex?: Behavior; gemini?: Behavior }) => writeFile(join(root, "behavior.json"), JSON.stringify({ kind: "ok", sandbox: true, ...b }));
  const record = async (): Promise<Record_> => JSON.parse(await readFile(join(root, "record.json"), "utf8"));
  const deps = (extra: Partial<EngineDeps> = {}): EngineDeps => ({
    repoDir,
    workRoot,
    redact: makeRedactor([CONFIG_SECRET, ESCAPED_SECRET]),
    note: (text) => notes.push(text),
    commands: { codex: fake, gemini: fake },
    progressEveryMs: 0,
    geminiSettings: { path: settingsFile, checkOwner: false },
    ...extra,
  });
  const codex = (o: Partial<Parameters<typeof codexRunner>[0]> = {}) =>
    codexRunner({ command: fake, key: CODEX_KEY, model: "", repoDir, allowUnsandboxed: false, sandboxWorks: true, ...o });
  const gemini = (o: Partial<Parameters<typeof geminiRunner>[0]> = {}) =>
    geminiRunner({ command: fake, key: GEMINI_KEY, model: "", repoDir, allowUnsandboxed: true, systemSettings: { path: settingsFile, checkOwner: false }, ...o });
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
    // Named like the real one: its messages start with the path it runs as.
    fakeTimeout = join(root, "timeout");
    await writeFile(fakeTimeout, fakeTimeoutSource(root));
    await chmod(fakeTimeout, 0o755);
    settingsFile = join(root, "gemini-system-settings.json");
    await writeFile(settingsFile, JSON.stringify(GEMINI_SYSTEM_SETTINGS));
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

  it("reads why timeout could not start the CLI, in GNU and Rust coreutils wording, and only from timeout's own line", () => {
    expect(timeoutStartFailure(126, "/usr/bin/timeout: failed to run command '/x/codex': Permission denied\n")).toBe("failed to run command '/x/codex': Permission denied");
    expect(timeoutStartFailure(126, "timeout: failed to execute process: Permission denied (os error 13)\n")).toBe("failed to execute process: Permission denied (os error 13)");
    expect(timeoutStartFailure(127, "/usr/bin/timeout: failed to run command 'codex': No such file or directory")).toMatch(/No such file/);
    expect(timeoutStartFailure(126, "codex: refusing to run here\n")).toBeUndefined();
    expect(timeoutStartFailure(1, "timeout: failed to execute process: Permission denied")).toBeUndefined();
  });

  it("says so when the CLI cannot start", async () => {
    const notExecutable = join(root, "behavior.json");
    const result = await run(codex({ command: notExecutable }), "write");
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Codex failed after .*: it could not start \(/);
  });

  it("runs Codex in the checkout with a minimal environment and reports what changed", async () => {
    const result = await run(codex({ model: "gpt-test" }), "write");
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
    expect(r.args).toEqual(
      expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--cd", repoDir, "--model", "gpt-test", "shell_environment_policy.ignore_default_excludes=false"]),
    );
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(r.args.at(-1)).toBe("-");
    expect(r.input).toContain("Add feature.txt with a line of text.");
    expect(r.input).toContain("Do not commit, push");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Codex finished");
    expect(result.text).toContain("Codex ran in its workspace-write sandbox.");
    expect(result.text).toContain("?? feature.txt");
    expect(result.text).toContain("Added feature.txt.");
    expect(result.text).toContain("Tokens: 1200 in (100 cached), 300 out");
    expect(notes[0]).toMatch(/^Codex started: Add feature\.txt/);
    expect(notes).toContain("Codex: ran `npm test` (exit 0)");
    expect(notes).toContain("Codex: changed feature.txt");
    expect(notes.at(-1)).toMatch(/^Codex finished after .* · 1 file changed in the checkout · tokens 1200 in/);
  });

  it("runs Codex without its sandbox only when the owner allows it, and read-only only with it", async () => {
    const refused = await run(codex({ sandboxWorks: false }), "write");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("Codex was not started: Codex's sandbox does not work in this container, and running it without one is turned off");
    expect(refused.text).toContain("Say so in your report");
    expect(notes.at(-1)).toMatch(/^Codex was not started: /);
    await expect(readFile(join(root, "record.json"))).rejects.toThrow();

    const allowed = await run(codex({ sandboxWorks: false, allowUnsandboxed: true }), "write");
    let r = await record();
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    expect(r.args).not.toContain("--model");
    expect(allowed.text).toContain("Codex ran without its sandbox, as the owner allows (the task container is the only boundary).");

    await run(codex(), "read");
    r = await record();
    expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(r.input).toContain("Work read-only");

    await rm(join(root, "record.json"));
    for (const allowUnsandboxed of [false, true]) {
      const readOnly = await run(codex({ sandboxWorks: false, allowUnsandboxed }), "read");
      expect(readOnly.ok).toBe(false);
      expect(readOnly.text).toContain("cannot be kept read-only");
      expect(readOnly.text).toContain("Do the assignment with your own tools instead.");
    }
    await expect(readFile(join(root, "record.json"))).rejects.toThrow();
  });

  it("runs Gemini CLI headless with its own home, the platform's system settings, no MCP servers and yolo or read-only approvals", async () => {
    const result = await run(gemini({ model: "gemini-test" }), "write");
    const r = await record();
    expect(r.cwd).toBe(repoDir);
    expect(r.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--model", "gemini-test"]));
    expect(r.args[r.args.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(r.env).toMatchObject({
      GEMINI_API_KEY: GEMINI_KEY,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      GOOGLE_GEMINI_BASE_URL: "",
      GOOGLE_GENAI_USE_VERTEXAI: "false",
    });
    expect(r.env.GEMINI_CLI_HOME).toBe(r.env.HOME);
    expect(JSON.stringify(r.env)).not.toContain("should-not-leak");
    expect(r.env.CODEX_API_KEY).toBeUndefined();
    // The user scope gets the same settings.
    expect(r.userSettings).toEqual(GEMINI_SYSTEM_SETTINGS);
    // Only an MCP server with a random name may start: none has it.
    const mcpName = r.args[r.args.indexOf("--allowed-mcp-server-names") + 1]!;
    expect(mcpName).toMatch(/^none-[0-9a-f]{24}$/);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Added feature.txt.");
    expect(result.text).toContain("Tokens: 1200 in (100 cached), 300 out");
    expect(result.text).toContain("Gemini CLI ran with every action approved and no sandbox, as the owner allows");
    expect(notes).toContain("Gemini CLI: write_file feature.txt");

    await run(gemini(), "read");
    const again = await record();
    expect(again.args[again.args.indexOf("--approval-mode") + 1]).toBe("default");
    expect(again.args[again.args.indexOf("--allowed-mcp-server-names") + 1]).not.toBe(mcpName);
  });

  it("does not start Gemini CLI without the owner's leave, without its system settings, or where the checkout's own .gemini could change it", async () => {
    const refusal = async (runner: ReturnType<typeof geminiRunner>, mode: "read" | "write") => {
      const result = await run(runner, mode);
      expect(result.ok).toBe(false);
      return result.text;
    };
    expect(await refusal(gemini({ allowUnsandboxed: false }), "write")).toContain("Gemini CLI has no sandbox here, and running it without one is turned off");
    expect(await refusal(gemini({ allowUnsandboxed: false }), "read")).toContain("Gemini CLI has no sandbox here");
    expect(await refusal(gemini({ systemSettings: { path: join(root, "missing.json"), checkOwner: false } }), "write")).toContain("its system settings are not in place");
    await writeFile(settingsFile, JSON.stringify({ ...GEMINI_SYSTEM_SETTINGS, hooksConfig: { enabled: true } }));
    expect(await refusal(gemini(), "write")).toContain("does not hold this version's settings");
    await writeFile(settingsFile, JSON.stringify(GEMINI_SYSTEM_SETTINGS));

    // A .gemini folder with neither settings nor policies: a write run starts, a read-only one does not.
    await mkdir(join(repoDir, ".gemini", "commands"), { recursive: true });
    expect((await run(gemini(), "write")).ok).toBe(true);
    await rm(join(root, "record.json"));
    expect(await refusal(gemini(), "read")).toContain("cannot be kept read-only");

    await writeFile(join(repoDir, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
    expect(await refusal(gemini(), "write")).toContain("the checkout has its own .gemini/settings.json, which Gemini CLI would apply to the run");
    await rm(join(repoDir, ".gemini", "settings.json"));
    await mkdir(join(repoDir, ".gemini", "policies"));
    expect(await refusal(gemini(), "write")).toContain("the checkout has its own .gemini/policies");

    await writeFile(join(repoDir, ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=https://example.invalid\n");
    expect(await refusal(gemini(), "write")).toContain("the checkout has a .gemini/.env file");
    // One in a folder above the checkout is loaded too (the first found, walking up).
    await rm(join(repoDir, ".gemini"), { recursive: true });
    await mkdir(join(workRoot, ".gemini"));
    await writeFile(join(workRoot, ".gemini", ".env"), "HTTPS_PROXY=http://127.0.0.1:9\n");
    expect(await refusal(gemini(), "write")).toContain(`${join(workRoot, ".gemini", ".env")} is above the checkout`);
    await expect(readFile(join(root, "record.json"))).rejects.toThrow();
  });

  it("runs under coreutils `timeout`, which holds the deadline past the worker's own", async () => {
    await run(codex(), "write", { deps: deps({ timeoutCommand: fakeTimeout }) });
    const args = JSON.parse(await readFile(join(root, "timeout-record.json"), "utf8")) as string[];
    // 1 min plus the margin, then the CLI and its own arguments.
    expect(args.slice(0, 4)).toEqual(["--kill-after=10s", "90s", fake, "exec"]);
    expect((await record()).args[0]).toBe("exec");

    await rm(join(root, "timeout-record.json"));
    expect((await run(codex(), "write", { deps: deps({ timeoutCommand: null }) })).ok).toBe(true);
    expect(existsSync(join(root, "timeout-record.json"))).toBe(false);

    await behave({ timeoutExit: 127 });
    expect((await run(codex(), "write", { deps: deps({ timeoutCommand: fakeTimeout }) })).text).toContain(`it could not start (failed to run command '${fake}': No such file or directory)`);
    await behave({ timeoutExit: 124 });
    expect((await run(codex(), "write", { deps: deps({ timeoutCommand: fakeTimeout }) })).text).toContain("it timed out after 1 min");

    // The image's: GNU coreutils, found on PATH (none on a Mac without coreutils).
    const found = await findCommand("timeout");
    const version = found ? (await sh(found, ["--version"]).catch(() => ({ stdout: "" }))).stdout : "";
    expect(await coreutilsTimeout()).toBe(found && /coreutils/i.test(version) ? found : undefined);
  });

  it("kills the CLI and everything it started at the timeout", { timeout: 20_000 }, async () => {
    await behave({ kind: "hang" });
    const result = await runEngine(codex(), {
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
    expect(await until(() => !alive(pid), 2_000)).toBe(true);
  });

  it("stops a run, and everything it started, once its agent's budget for the task is reached", { timeout: 20_000 }, async () => {
    // 8,000 characters streamed: about 2,000 tokens before the CLI reports any.
    await behave({ kind: "hang", before: [{ type: "item.completed", item: { id: "1", type: "agent_message", text: "x".repeat(8_000) } }] });
    const seen: { input: number; output: number }[] = [];
    let ended: { input: number; output: number } | undefined;
    const started = Date.now();
    const result = await runEngine(codex({ model: "gpt-5.1-codex" }), {
      task: "Work forever.",
      mode: "write",
      timeoutMin: 1,
      deps: deps(),
      root: engineRoot,
      gitHome,
      spend: {
        update: (usage, model) => {
          expect(model).toBe("gpt-5.1-codex");
          seen.push(usage);
          return usage.input >= 2_000;
        },
        end: (usage) => void (ended = usage),
      },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("its agent's budget for this task was reached, so it was stopped");
    expect(seen.at(-1)!.input).toBeGreaterThanOrEqual(2_000);
    expect(ended).toMatchObject({ output: 0 });
    expect(ended!.input).toBeGreaterThanOrEqual(2_000);
    expect(notes).toContain("Codex stopped: its agent's budget for this task is reached");
    const pid = Number(await readFile(join(root, "grandchild.pid"), "utf8"));
    expect(await until(() => !alive(pid), 2_000)).toBe(true);
  });

  it("says why it stopped a run under `timeout` itself, though `timeout` exits 124 when signalled (the Rust coreutils)", { timeout: 20_000 }, async () => {
    await behave({ kind: "hang", timeoutOnTerm: 124, before: [{ type: "item.completed", item: { id: "1", type: "agent_message", text: "x".repeat(8_000) } }] });
    const overBudget = await runEngine(codex(), {
      task: "Work forever.",
      mode: "write",
      timeoutMin: 1,
      deps: deps({ timeoutCommand: fakeTimeout }),
      root: engineRoot,
      gitHome,
      spend: { update: (usage) => usage.input >= 2_000, end: () => undefined },
    });
    expect(overBudget.text).toContain("its agent's budget for this task was reached, so it was stopped");
    expect(overBudget.text).not.toContain("timed out");

    await rm(join(root, "grandchild.pid"), { force: true });
    await behave({ kind: "hang", timeoutOnTerm: 124 });
    const stop = new AbortController();
    const stopped = runEngine(codex(), { task: "Work forever.", mode: "write", timeoutMin: 1, deps: deps({ timeoutCommand: fakeTimeout }), root: engineRoot, gitHome, signal: stop.signal });
    expect(await until(() => existsSync(join(root, "grandchild.pid")), 10_000)).toBe(true);
    stop.abort();
    const result = await stopped;
    expect(result.text).toContain("the task was stopped");
    expect(result.text).not.toContain("timed out");
    const pid = Number(await readFile(join(root, "grandchild.pid"), "utf8"));
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
  });

  it("reports the CLI's own token count when it gives one, and the model Gemini CLI says it runs", async () => {
    const updates: [number, string][] = [];
    let ended: { input: number; output: number; cached?: number } | undefined;
    await run(gemini(), "write", {
      spend: { update: (u, model) => void updates.push([u.input, model]) as unknown as boolean, end: (u) => void (ended = u) },
    });
    expect(ended).toEqual({ input: 1200, output: 300, cached: 100 });
    expect(updates.at(-1)).toEqual([1200, "auto"]);
  });

  describe("when the worker ends first", () => {
    /** Starts a worker that runs a hanging CLI; resolves once the CLI and its child are up. */
    async function startWorker(mode: "plain" | "graceful" | "backstop", timeoutCommand = "") {
      await behave({ kind: "hang" });
      const script = join(root, "worker.mts");
      await writeFile(script, workerSource(repoDir));
      const child = spawn(process.execPath, ["--import", "tsx", script, fake, mode, timeoutCommand], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
      expect(await until(() => existsSync(join(root, "grandchild.pid")), 15_000), stderr).toBe(true);
      const pids = { cli: Number(await readFile(join(root, "cli.pid"), "utf8")), grandchild: Number(await readFile(join(root, "grandchild.pid"), "utf8")) };
      return { child, exited, pids };
    }

    it("kills the CLIs on SIGTERM, then ends by that signal", { timeout: 30_000 }, async () => {
      const { child, exited, pids } = await startWorker("plain");
      child.kill("SIGTERM");
      expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
      expect(await until(() => !alive(pids.cli) && !alive(pids.grandchild), 2_000)).toBe(true);
    });

    it("leaves the exit to the worker's own SIGTERM handler, after killing the CLIs", { timeout: 30_000 }, async () => {
      const { child, exited, pids } = await startWorker("graceful");
      child.kill("SIGTERM");
      expect(await until(() => !alive(pids.cli) && !alive(pids.grandchild), 2_000)).toBe(true);
      expect(await exited).toEqual({ code: 7, signal: null });
    });

    it.skipIf(!existsSync("/usr/bin/timeout"))("is stopped by coreutils `timeout` at its deadline when the worker is SIGKILLed", { timeout: 30_000 }, async () => {
      const real = (await coreutilsTimeout())!;
      const { child, exited, pids } = await startWorker("backstop", real);
      child.kill("SIGKILL");
      await exited;
      // The worker ran no code: `timeout` stops the group after its 1 s.
      expect(await until(() => !alive(pids.cli) && !alive(pids.grandchild), 15_000)).toBe(true);
    });
  });

  it("caps and redacts what it returns and writes to the timeline", async () => {
    await behave({ final: `Done. The key is ${CODEX_KEY} and the config has ${CONFIG_SECRET}. ${"x".repeat(50_000)}` });
    const result = await run(codex(), "write", { task: `Use ${CONFIG_SECRET} nowhere.` });
    expect(result.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(result.text).not.toContain(CODEX_KEY);
    expect(result.text).not.toContain(CONFIG_SECRET);
    expect(result.text).toContain("[redacted]");
    expect(result.text).toContain("cut at");
    expect(notes.join("\n")).not.toContain(CONFIG_SECRET);
    expect(notes.every((n) => n.length <= 240)).toBe(true);

    // A key right where the final message is cut (6 000 characters) is redacted first, never left in part.
    await behave({ final: `${"x".repeat(5_950)}${CODEX_KEY}${"y".repeat(200)}` });
    const atCut = await run(codex(), "write");
    expect(atCut.text).not.toContain(CODEX_KEY.slice(0, 10));
    expect(atCut.text).toContain("x[redacted]");

    await behave({ kind: "fail" });
    const failed = await run(codex(), "write");
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("exited with code 3");
    expect(failed.text).toContain("fatal: the key [redacted] was refused");
    expect(failed.text).not.toContain(CODEX_KEY);
  });

  it("redacts a secret the JSON line escapes, and one where a progress line is cut", async () => {
    // Escaped in the raw line (\\" \\\\ \\n): only the decoded text holds it as it is.
    await behave({ command: `curl -d '${ESCAPED_SECRET}' https://example.invalid`, final: `Sent ${ESCAPED_SECRET}.` });
    const result = await run(codex(), "write");
    const all = [...notes, result.text].join("\n");
    expect(all).not.toContain(ESCAPED_SECRET);
    expect(all).not.toContain("next-line-0123456789");
    expect(notes).toContain("Codex: ran `curl -d '[redacted]' https://example.invalid` (exit 0)");
    expect(result.text).toContain("Sent [redacted].");

    // A command whose secret straddles the 80 characters a progress line keeps: redacted whole, then cut.
    notes = [];
    await behave({ command: `${"a".repeat(70)} ${CONFIG_SECRET}` });
    await run(codex(), "write");
    const ran = notes.find((n) => n.startsWith("Codex: ran"))!;
    expect(ran).toContain(" [redac");
    expect(ran).not.toContain(CONFIG_SECRET.slice(0, 6));
  });

  it("drops an output line over 64 KB, with a note, and keeps the rest", async () => {
    await behave({ longLine: LINE_MAX_CHARS + 10, before: [{ type: "item.completed", item: { type: "agent_message", text: "x".repeat(LINE_MAX_CHARS - 200) } }] });
    const result = await run(codex(), "write");
    expect(result.ok).toBe(true);
    expect(notes).toContain("Codex: an output line over 64 KB was left out");
    expect(result.text).toContain("1 output line over 64 KB was left out.");
    // The lines after it still count: the command, the change, the final message.
    expect(notes).toContain("Codex: ran `npm test` (exit 0)");
    expect(result.text).toContain("Added feature.txt.");
  });

  it("keeps only the last messages, each capped, while streaming", () => {
    const codexState = { messages: [] as string[] };
    for (let i = 0; i < 50; i++) parseCodexEvent({ type: "item.completed", item: { type: "agent_message", text: `message ${i} ${"m".repeat(20_000)}` } }, codexState);
    expect(codexState.messages).toHaveLength(2);
    expect(codexState.messages[1]).toMatch(/^message 49 /);
    expect(codexState.messages.every((m) => m.length <= 8_000)).toBe(true);
    parseCodexEvent({ type: "turn.failed", error: { message: "e".repeat(50_000) } }, codexState);
    expect((codexState as { failure?: string }).failure!.length).toBeLessThanOrEqual(2_000);

    const geminiState = { messages: [] as string[] };
    for (let i = 0; i < 500; i++) parseGeminiEvent({ type: "message", role: "assistant", content: "d".repeat(1_000), delta: true }, geminiState);
    expect(geminiState.messages).toEqual(["d".repeat(8_000)]);
    for (let i = 0; i < 10; i++) {
      parseGeminiEvent({ type: "tool_use", tool_name: "read_file", parameters: { file_path: `f${i}` } }, geminiState);
      parseGeminiEvent({ type: "message", role: "assistant", content: `after ${i}` }, geminiState);
    }
    expect(geminiState.messages).toEqual(["after 8", "after 9"]);
  });

  describe("Gemini CLI's system settings", () => {
    it("lock down what a repository's own settings could change", () => {
      const s = GEMINI_SYSTEM_SETTINGS;
      expect(GEMINI_SYSTEM_SETTINGS_PATH).toBe("/etc/gemini-cli/settings.json");
      expect(s.advanced.ignoreLocalEnv).toBe(true);
      expect(s.security.environmentVariableRedaction).toEqual({ enabled: true, allowed: [], blocked: ["GEMINI_API_KEY"] });
      expect(s.security.auth).toMatchObject({ selectedType: "gemini-api-key", enforcedType: "gemini-api-key" });
      // An empty allowlist means "no limit" in Gemini CLI 0.70.0: it names a server that does not exist.
      expect(s.mcp).toEqual({ allowed: [GEMINI_NO_MCP_SERVER], serverCommand: "" });
      expect(s.hooksConfig.enabled).toBe(false);
      expect(s.tools).toEqual({ sandbox: false, discoveryCommand: "", callCommand: "" });
      expect(s.telemetry.enabled).toBe(false);
      expect(s.privacy.usageStatisticsEnabled).toBe(false);
    });

    it("are written into the image, as root, from this module", async () => {
      const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
      const user = dockerfile.indexOf("\nUSER node");
      const write = dockerfile.indexOf(`> ${GEMINI_SYSTEM_SETTINGS_PATH}`);
      expect(write).toBeGreaterThan(0);
      expect(write).toBeLessThan(user);
      expect(dockerfile).toContain('import { GEMINI_SYSTEM_SETTINGS as s } from "/app/dist/ai/gemini-settings.js"');
    });

    it("must be in place, whole and root's before Gemini CLI runs", async () => {
      expect(await geminiSystemSettingsProblem(settingsFile, { checkOwner: false })).toBeUndefined();
      // More settings than the platform's are fine (an image may add its own).
      await writeFile(settingsFile, JSON.stringify({ ...GEMINI_SYSTEM_SETTINGS, ui: { hideBanner: true }, security: { ...GEMINI_SYSTEM_SETTINGS.security, disableYoloMode: false } }));
      expect(await geminiSystemSettingsProblem(settingsFile, { checkOwner: false })).toBeUndefined();
      await writeFile(settingsFile, JSON.stringify({ ...GEMINI_SYSTEM_SETTINGS, mcp: { allowed: [], serverCommand: "" } }));
      expect(await geminiSystemSettingsProblem(settingsFile, { checkOwner: false })).toContain("does not hold this version's settings");
      await writeFile(settingsFile, "{ not json");
      expect(await geminiSystemSettingsProblem(settingsFile, { checkOwner: false })).toContain("is not valid JSON");
      expect(await geminiSystemSettingsProblem(join(root, "missing.json"))).toContain("is missing");
      // Root's file, root's folders: the owner check passes, and the content is what fails.
      expect(await geminiSystemSettingsProblem("/etc/passwd")).toContain("is not valid JSON");
    });

    it.skipIf(process.getuid?.() === 0)("is refused when it is not root's (Gemini CLI would skip it)", async () => {
      await writeFile(settingsFile, JSON.stringify(GEMINI_SYSTEM_SETTINGS));
      expect(await geminiSystemSettingsProblem(settingsFile)).toMatch(/is not owned by root|writable by group or others/);
    });
  });

  describe("repoTaskEngines", () => {
    const agent = (id: string, engine: AgentSpec["engine"], access: AgentSpec["access"]): AgentSpec => ({
      ...engineAgentTemplate(engine === "claude" ? "codex" : engine, id),
      name: id[0]!.toUpperCase() + id.slice(1),
      access,
      engine,
    });
    const configWith = (agents: AgentSpec[], keys: { codex?: string; gemini?: string } = {}, allow: { codex?: boolean; gemini?: boolean } = {}): Config => {
      const team = defaultTeam();
      return ConfigSchema.parse({
        team: { ...team, agents: [...team.agents, ...agents] },
        engines: {
          codex: { apiKey: keys.codex, model: "", allowUnsandboxed: allow.codex ?? false },
          gemini: { apiKey: keys.gemini, model: "", allowUnsandboxed: allow.gemini ?? false },
        },
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
      const config = configWith([coder, looker], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true });
      const engines = (await repoTaskEngines(config, deps()))!;
      expect(notes).toEqual(["Codex runs in its own sandbox.", "Gemini CLI runs with no sandbox, as the owner allows: the task container is the only boundary."]);
      expect(Object.keys(engines.servers)).toEqual([ENGINES_SERVER]);
      expect(engines.allToolNames).toEqual([engineToolName("codex", "write"), engineToolName("gemini", "read")]);
      expect(engines.allToolNames).toEqual(["mcp__engines__codex_run", "mcp__engines__gemini_run_read_only"]);
      expect(engines.promptRule).toContain("- codex (Codex, Coder (Codex)) works through Codex and changes files.");
      expect(engines.promptRule).toContain("- gemini (Gemini, Coder (Gemini CLI)) works through Gemini CLI and looks only.");

      const base: AgentDefinition = { description: "Codex (Coder): writes code", tools: ["Read", "Edit"], prompt: "My own instructions.", effort: "medium" };
      const def = engines.agentDefinition(coder, base)!;
      // Its own tools too, after the run tool and the checks (the hooks hold them back while the CLI works).
      expect(def.tools).toEqual(["mcp__engines__codex_run", "Read", "Glob", "Grep", "Bash", "Edit"]);
      expect(def.model).toBe("haiku");
      expect(def.description).toBe(base.description);
      expect(def.mcpServers).toBeUndefined();
      expect(def.prompt).toContain("You are Codex, the team's Coder (Codex). You work through Codex, OpenAI's coding agent");
      expect(def.prompt).toContain("Send the whole assignment to mcp__engines__codex_run in one call");
      expect(def.prompt).toContain("My own instructions.");
      expect(engines.agentDefinition(coder, { ...base, model: "claude-haiku-5-5" })!.model).toBe("claude-haiku-5-5");

      const readDef = engines.agentDefinition(looker, { ...base, tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] })!;
      expect(readDef.tools).toEqual(["mcp__engines__gemini_run_read_only", "Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
      // A base definition with no list (every tool) adds nothing: the checks only.
      expect(engines.agentDefinition(looker, { description: "d", prompt: "p" })!.tools).toEqual(["mcp__engines__gemini_run_read_only", "Read", "Glob", "Grep"]);
      // An agent on Claude, or on an engine this task does not have, keeps its own definition.
      expect(engines.agentDefinition({ ...coder, id: "other", engine: "gemini" }, base)).toBeUndefined();

      // Through the team builder: engine agents get theirs, everyone else stays as they were.
      const agents = buildRepoAgents(config.team, { engines });
      expect(agents.codex!.tools![0]).toBe("mcp__engines__codex_run");
      expect(agents.coder!.tools).toContain("Edit");
      expect(repoAllowedTools(config.team, { engines })).toEqual(expect.arrayContaining(engines.allToolNames));
    });

    it("gives each agent with a model of its own its own tool, which runs the CLI with that --model over the engine's", async () => {
      const carbon = { ...agent("carbon", "gemini", "write"), engineModel: "gemini-4-carbon" };
      const neon = { ...agent("neon", "gemini", "write"), engineModel: "gemini-4-neon" };
      const argon = { ...agent("argon", "gemini", "read"), engineModel: "gemini-4-argon" };
      const plain = agent("gemini", "gemini", "write");
      const config = configWith([carbon, neon, argon, plain], { gemini: GEMINI_KEY }, { gemini: true });
      config.engines.gemini.model = "gemini-engine-default";
      const engines = (await repoTaskEngines(config, deps()))!;

      // The shared tool for the agent on the engine's model, one of its own for each of the others.
      expect(engines.allToolNames).toEqual([
        "mcp__engines__gemini_run",
        "mcp__engines__gemini_run_as_carbon",
        "mcp__engines__gemini_run_as_neon",
        "mcp__engines__gemini_read_as_argon",
      ]);
      expect(agentEngineToolName("gemini", "write", "carbon")).toBe("mcp__engines__gemini_run_as_carbon");
      // The longest agent id still makes a tool name of at most 64 characters.
      expect(agentEngineToolName("gemini", "read", `a${"b".repeat(30)}`).length).toBeLessThanOrEqual(64);
      const base: AgentDefinition = { description: "d", prompt: "My own instructions." };
      expect(engines.agentDefinition(carbon, base)!.tools![0]).toBe("mcp__engines__gemini_run_as_carbon");
      expect(engines.agentDefinition(neon, base)!.prompt).toContain("Send the whole assignment to mcp__engines__gemini_run_as_neon in one call");
      expect(engines.agentDefinition(argon, base)!.tools).toEqual(["mcp__engines__gemini_read_as_argon", "Read", "Glob", "Grep"]);
      expect(engines.agentDefinition(plain, base)!.tools![0]).toBe("mcp__engines__gemini_run");
      // An agent given a model of its own after the task started has no tool of its own in it: it keeps its own definition.
      expect(engines.agentDefinition({ ...plain, engineModel: "gemini-4-neon" }, base)).toBeUndefined();
      expect(engines.promptRule).toContain("- carbon (Carbon, Coder (Gemini CLI)) works through Gemini CLI on gemini-4-carbon and changes files.");
      expect(engines.promptRule).toContain("- argon (Argon, Coder (Gemini CLI)) works through Gemini CLI on gemini-4-argon and looks only.");
      expect(engines.promptRule).toContain("- gemini (Gemini, Coder (Gemini CLI)) works through Gemini CLI and changes files.");

      // Each tool runs the CLI with its own --model.
      const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
      expect(await client.listTools()).toEqual(["gemini_run", "gemini_run_as_carbon", "gemini_run_as_neon", "gemini_read_as_argon"]);
      const modelOf = async (name: string) => {
        const result = await client.call(name, { task: "Add feature.txt with a line of text." });
        expect(result.isError).toBeFalsy();
        const r = await record();
        return { model: r.args[r.args.indexOf("--model") + 1], approval: r.args[r.args.indexOf("--approval-mode") + 1] };
      };
      expect(await modelOf("gemini_run_as_carbon")).toEqual({ model: "gemini-4-carbon", approval: "yolo" });
      expect(await modelOf("gemini_run_as_neon")).toEqual({ model: "gemini-4-neon", approval: "yolo" });
      expect(await modelOf("gemini_read_as_argon")).toEqual({ model: "gemini-4-argon", approval: "default" });
      expect(await modelOf("gemini_run")).toEqual({ model: "gemini-engine-default", approval: "yolo" });
    });

    it("runs two Codex agents on different OpenAI models, each with its own --model", async () => {
      const astra = { ...agent("astra", "codex", "write"), engineModel: "gpt-6.2-astra" };
      const sol = { ...agent("sol", "codex", "write"), engineModel: "gpt-6.2-sol" };
      const engines = (await repoTaskEngines(configWith([astra, sol], { codex: CODEX_KEY }), deps()))!;
      expect(engines.allToolNames).toEqual(["mcp__engines__codex_run_as_astra", "mcp__engines__codex_run_as_sol"]);
      const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
      for (const [name, model] of [["codex_run_as_astra", "gpt-6.2-astra"], ["codex_run_as_sol", "gpt-6.2-sol"]] as const) {
        await client.call(name, { task: "Add feature.txt with a line of text." });
        const r = await record();
        expect(r.args[r.args.indexOf("--model") + 1]).toBe(model);
        expect(r.args[r.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
      }
    });

    it("leaves Codex agents on Claude where its sandbox does not work, unless the owner allows it to run without one", async () => {
      await behave({ sandbox: false });
      const coder = agent("codex", "codex", "write");
      const reviewer = agent("checker", "codex", "read");
      expect(await repoTaskEngines(configWith([coder, reviewer], { codex: CODEX_KEY }), deps())).toBeUndefined();
      expect(notes).toEqual([
        "Codex left out: Codex's sandbox does not work in this container, and running it without one is turned off (Integrations → Codex). Codex works as Claude in this task.",
        "Codex left out: Codex cannot be kept read-only here: its sandbox does not work in this container. Checker works as Claude in this task.",
      ]);

      notes = [];
      const engines = (await repoTaskEngines(configWith([coder, reviewer], { codex: CODEX_KEY }, { codex: true }), deps()))!;
      expect(notes).toEqual([
        "Codex left out: Codex cannot be kept read-only here: its sandbox does not work in this container. Checker works as Claude in this task.",
        "Codex runs without its sandbox, as the owner allows: the task container is the only boundary.",
      ]);
      expect(engines.allToolNames).toEqual(["mcp__engines__codex_run"]);
      expect(engines.agentDefinition(reviewer, { description: "d", prompt: "p" })).toBeUndefined();
    });

    it("leaves Gemini agents on Claude without the owner's leave, without the system settings, or with the checkout's own .gemini settings", async () => {
      const coder = agent("gemini", "gemini", "write");
      const looker = agent("reader", "gemini", "read");
      expect(await repoTaskEngines(configWith([coder, looker], { gemini: GEMINI_KEY }), deps())).toBeUndefined();
      expect(notes).toEqual([
        "Gemini CLI left out: Gemini CLI has no sandbox here, and running it without one is turned off (Integrations → Gemini CLI). Gemini, Reader work as Claude in this task.",
      ]);

      notes = [];
      const allowed = configWith([coder, looker], { gemini: GEMINI_KEY }, { gemini: true });
      expect(await repoTaskEngines(allowed, deps({ geminiSettings: { path: join(root, "missing.json"), checkOwner: false } }))).toBeUndefined();
      expect(notes).toEqual([`Gemini CLI left out: its system settings are not in place: ${join(root, "missing.json")} is missing (rebuild the image). Gemini, Reader work as Claude in this task.`]);
      // By default the image's file, root's: not on a test machine (or not yet written).
      notes = [];
      if (!existsSync(GEMINI_SYSTEM_SETTINGS_PATH)) {
        expect(await repoTaskEngines(allowed, deps({ geminiSettings: undefined }))).toBeUndefined();
        expect(notes[0]).toContain(`its system settings are not in place: ${GEMINI_SYSTEM_SETTINGS_PATH} is missing`);
      }

      notes = [];
      await mkdir(join(repoDir, ".gemini"));
      await writeFile(join(repoDir, ".gemini", "settings.json"), "{}");
      expect(await repoTaskEngines(allowed, deps())).toBeUndefined();
      expect(notes).toEqual([
        "Gemini CLI left out: the checkout has its own .gemini/settings.json, which Gemini CLI would apply to the run. Gemini works as Claude in this task.",
        "Gemini CLI left out: Gemini CLI cannot be kept read-only here: the checkout has its own .gemini settings, which could allow edits. Reader works as Claude in this task.",
      ]);
    });

    describe("an agent's fallback", () => {
      const TASK = "Add feature.txt with a line of text.";
      /** Dana: Gemini CLI first, then Codex on a model of its own (then Claude, always). */
      const dana = (fallback: AgentSpec["fallback"] = [{ engine: "codex", model: "gpt-6.2-sol" }]): AgentSpec => ({ ...agent("dana", "gemini", "write"), fallback });
      const base: AgentDefinition = { description: "d", tools: repoToolsFor("write"), prompt: "My own instructions.", mcpServers: ["browser"] };
      const readRecord = async (engine: "codex" | "gemini"): Promise<Record_> => JSON.parse(await readFile(join(root, `record-${engine}.json`), "utf8"));
      const textOf = (r: { content: { text?: string }[] }) => r.content[0]?.text ?? "";
      /** Runs the task's hooks as the SDK would before a tool call, from inside `agentType`'s subagent (none: the lead): why it is denied, or undefined. */
      const gateOf = (engines: RepoTaskEngines) => async (agentType: string | undefined, toolName: string) => {
        const input: PreToolUseHookInput = {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          transcript_path: "/t",
          cwd: repoDir,
          tool_name: toolName,
          tool_input: {},
          tool_use_id: "u1",
          ...(agentType ? { agent_id: "a1", agent_type: agentType } : {}),
        };
        let denied: string | undefined;
        for (const matcher of engines.hooks ?? []) {
          for (const hook of matcher.hooks) {
            const out = await hook(input, "u1", { signal: new AbortController().signal });
            const specific = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
            if (specific?.hookEventName === "PreToolUse" && specific.permissionDecision === "deny") denied = specific.permissionDecisionReason ?? "denied";
          }
        }
        return denied;
      };

      it("starts the agent on the first CLI of its line that can run here, and says where each one went", async () => {
        // Gemini CLI not connected: Codex, on the step's model.
        let engines = (await repoTaskEngines(configWith([dana()], { codex: CODEX_KEY }), deps()))!;
        expect(notes).toEqual(["Codex runs in its own sandbox.", "Gemini CLI is not connected: Dana starts on Codex (gpt-6.2-sol) in this task."]);
        expect(engines.allToolNames).toEqual(["mcp__engines__codex_run_as_dana"]);
        expect(engines.promptRule).toContain("- dana (Dana, Coder (Gemini CLI)) works through Codex on gpt-6.2-sol and changes files.");
        expect(engines.agentDefinition(dana(), base)!.prompt).toContain("You are Dana, the team's Coder (Gemini CLI). You work through Codex, OpenAI's coding agent");
        const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
        expect((await client.call("codex_run_as_dana", { task: TASK })).isError).toBeFalsy();
        const codexRun = await readRecord("codex");
        expect(codexRun.args[codexRun.args.indexOf("--model") + 1]).toBe("gpt-6.2-sol");

        // Connected, but not allowed to run without a sandbox: the same.
        notes = [];
        engines = (await repoTaskEngines(configWith([dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }), deps()))!;
        expect(notes[1]).toBe(
          "Gemini CLI left out: Gemini CLI has no sandbox here, and running it without one is turned off (Integrations → Gemini CLI). Dana starts on Codex (gpt-6.2-sol) in this task.",
        );
        expect(engines.allToolNames).toEqual(["mcp__engines__codex_run_as_dana"]);

        // Both can run: Gemini CLI first, Codex after it, in the tool, the rule and the agent's own prompt.
        notes = [];
        engines = (await repoTaskEngines(configWith([dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        expect(engines.allToolNames).toEqual(["mcp__engines__gemini_run_as_dana"]);
        expect(engines.promptRule).toContain("- dana (Dana, Coder (Gemini CLI)) works through Gemini CLI and changes files; if Gemini CLI is unavailable, the work moves to Codex (gpt-6.2-sol).");
        expect(engines.promptRule).toContain("when none is left the agent does the work itself as Claude");
        const def = engines.agentDefinition(dana(), base)!;
        expect(def.prompt).toContain("When Gemini CLI itself cannot work (a rate limit, its quota or credit used up, a rejected key, the service down), the same call hands the assignment to Codex (gpt-6.2-sol)");
        expect(def.prompt).toContain("do the assignment yourself with your own tools, which stay closed to you until then");
        // The cheap tier hands work over; a line that names Claude gets the team's model.
        expect(def.model).toBe("haiku");
        expect(engines.agentDefinition(dana([{ engine: "codex", model: "" }, { engine: "claude", model: "" }]), base)).toBeUndefined(); // another line: no tool in this task
        const withClaude = dana([{ engine: "codex", model: "gpt-6.2-sol" }, { engine: "claude", model: "" }]);
        const named = (await repoTaskEngines(configWith([withClaude], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        expect(named.agentDefinition(withClaude, base)!.model).toBeUndefined();
        expect(named.agentDefinition(withClaude, { ...base, model: "claude-sonnet-5-5" })!.model).toBe("claude-sonnet-5-5");

        // Gemini CLI's monthly cap used up (budget.ts): the worker's team has Dana on Codex already.
        const capped = configWith([dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true });
        const left = agentsLeftOut(BudgetSchema.parse({ perProviderUsd: { gemini: 1 } }), { providers: [{ provider: "gemini", usd: 1, estimated: false, tasks: 1, chats: 0, tokens: 0, unpricedTokens: 0 }] }, capped.team.agents);
        notes = [];
        engines = (await repoTaskEngines({ ...capped, team: teamWithout(capped.team, left) }, deps()))!;
        expect(left.map((l) => l.note)).toEqual(["Gemini CLI has used up its monthly cap ($1.00 of $1.00), so Dana works through Codex in this task."]);
        expect(engines.allToolNames).toEqual(["mcp__engines__codex_run_as_dana"]);
        expect(notes).toEqual(["Codex runs in its own sandbox."]);

        // A fallback CLI that cannot run is only left out of the line.
        notes = [];
        engines = (await repoTaskEngines(configWith([dana()], { gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        expect(notes).toEqual(["Codex is not connected: it is left out of Dana's fallback.", "Gemini CLI runs with no sandbox, as the owner allows: the task container is the only boundary."]);
        expect(engines.promptRule).toContain("- dana (Dana, Coder (Gemini CLI)) works through Gemini CLI and changes files.");

        // None can: Claude.
        notes = [];
        expect(await repoTaskEngines(configWith([dana()]), deps())).toBeUndefined();
        expect(notes).toEqual(["Codex is not connected: it is left out of Dana's fallback.", "Gemini CLI is not connected: Dana works as Claude in this task."]);
      });

      it("hands the same call to the next CLI when one fails for its own reasons, and goes straight there afterwards", async () => {
        await behave({ gemini: { kind: "apiError", message: "[API Error: Resource has been exhausted (e.g. check quota). (Status: RESOURCE_EXHAUSTED)]\nPlease wait and try again later." } });
        const begun: { engine: string; tool: string; agent?: string }[] = [];
        const engines = (await repoTaskEngines(
          configWith([dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true }),
          deps({ spend: { begin: ({ engine, tool, agent: who }) => void begun.push({ engine, tool, ...(who ? { agent: who } : {}) }) } }),
        ))!;
        engines.agentDefinition(dana(), base);
        const gate = gateOf(engines);
        const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);

        const result = await client.call("gemini_run_as_dana", { task: TASK });
        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        expect(text).toContain("Gemini CLI is unavailable for the rest of this task (rate limited: [API Error: Resource has been exhausted");
        expect(text).toContain("Codex took the assignment over, from the checkout as it was; its run follows.");
        expect(text).toContain("Codex finished");
        expect(text).toContain("?? feature.txt");
        // The same assignment, on the step's model, told what the run before it may have left.
        const codexRun = await readRecord("codex");
        expect(codexRun.args[codexRun.args.indexOf("--model") + 1]).toBe("gpt-6.2-sol");
        expect(codexRun.input).toContain(TASK);
        expect(codexRun.input).toContain("Another coding agent started on this assignment and could not finish it (Gemini CLI: rate limited).");
        expect(notes).toContain("Gemini CLI was rate limited for Dana; Codex takes over.");
        // Both runs counted for Dana, her own tool's.
        expect(begun).toEqual([
          { engine: "gemini", tool: "mcp__engines__gemini_run_as_dana", agent: "dana" },
          { engine: "codex", tool: "mcp__engines__gemini_run_as_dana", agent: "dana" },
        ]);
        // Codex still works for her: her own tools stay closed.
        expect(await gate("dana", "Edit")).toContain("Codex does your work in this task: hand it the assignment with mcp__engines__gemini_run_as_dana");

        // For the rest of the task: Gemini CLI is not run again, and Codex gets no word of a run before it.
        await rm(join(root, "record-gemini.json"));
        const again = await client.call("gemini_run_as_dana", { task: TASK });
        expect(existsSync(join(root, "record-gemini.json"))).toBe(false);
        expect(textOf(again)).toContain("Gemini CLI is unavailable for the rest of this task (rate limited");
        expect((await readRecord("codex")).input).not.toContain("Another coding agent");
        expect(notes.filter((n) => n.includes("Gemini CLI was rate limited"))).toHaveLength(1);
        // The team's next run gets her definition on Codex.
        expect(engines.agentDefinition(dana(), base)!.prompt).toContain("You work through Codex, OpenAI's coding agent");
      });

      it("tells the agent to do the work itself when no CLI is left, and opens its own tools only then", async () => {
        await behave({ gemini: { kind: "apiError", message: "[API Error: API key not valid. Please pass a valid API key. (Status: INVALID_ARGUMENT)]" } });
        const gem = agent("gemini", "gemini", "write");
        const carbon = { ...agent("carbon", "gemini", "write"), engineModel: "gemini-4-carbon" };
        const engines = (await repoTaskEngines(configWith([gem, carbon], { gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        // Its own tools and servers are in its definition, after the run tool and the checks.
        const def = engines.agentDefinition(gem, base)!;
        expect(def.tools).toEqual(["mcp__engines__gemini_run", "Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Edit", "Write"]);
        expect(def.mcpServers).toEqual(["browser"]);
        engines.agentDefinition(carbon, base);

        // While Gemini CLI works: the run tool and the checks only. Other agents and the lead are not held.
        const gate = gateOf(engines);
        expect(await gate("gemini", "Edit")).toBe(
          "Gemini CLI does your work in this task: hand it the assignment with mcp__engines__gemini_run, and check what it did with Read, Glob, Grep, Bash. Your other tools open only if no coding agent CLI can work for you; the tool says so when that happens.",
        );
        expect(await gate("gemini", "WebFetch")).toBeDefined();
        expect(await gate("gemini", "mcp__browser__browser_navigate")).toBeDefined();
        for (const allowed of ["mcp__engines__gemini_run", "Read", "Glob", "Grep", "Bash"]) expect(await gate("gemini", allowed)).toBeUndefined();
        expect(await gate("coder", "Edit")).toBeUndefined();
        expect(await gate(undefined, "Edit")).toBeUndefined();

        const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
        const result = await client.call("gemini_run", { task: TASK });
        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        expect(text).toContain("Gemini CLI is unavailable for the rest of this task (its key or account was refused: [API Error: API key not valid.");
        expect(text).toContain("No coding agent CLI can work for you for the rest of this task.");
        expect(text).toContain("Do the assignment yourself now, with your own tools: they are open to you from now on.");
        expect(text).toContain("say in your report that you did the work yourself because Gemini CLI was unavailable. Do not call mcp__engines__gemini_run again in this task.");
        expect(text).not.toContain(GEMINI_KEY);
        expect(notes).toContain("Gemini CLI had its key or account refused for Gemini; Gemini works as Claude from now on.");
        // Now its own tools are open.
        expect(await gate("gemini", "Edit")).toBeUndefined();

        // A refused key is the whole engine's: Carbon, on another model, goes straight to Claude without a run.
        await rm(join(root, "record.json"));
        const carbonResult = await client.call("gemini_run_as_carbon", { task: TASK });
        expect(existsSync(join(root, "record.json"))).toBe(false);
        expect(textOf(carbonResult)).toContain("No coding agent CLI can work for you");
        expect(notes).toContain("Gemini CLI is unavailable in this task (its key or account was refused); Carbon works as Claude from now on.");
        expect(await gate("carbon", "Edit")).toBeUndefined();
        // The team's next run: both work as Claude, held by nothing.
        expect(engines.agentDefinition(gem, base)).toBeUndefined();
        expect(engines.agentDefinition(carbon, base)).toBeUndefined();
      });

      it("keeps a rate limit to its model, and a CLI that cannot run here to that line", async () => {
        await behave({ gemini: { kind: "apiError", errorType: "RetryableQuotaError", message: "[API Error: You exceeded your current quota. (Status: RESOURCE_EXHAUSTED)]" } });
        const carbon = { ...agent("carbon", "gemini", "write"), engineModel: "gemini-4-carbon" };
        const neon = { ...agent("neon", "gemini", "write"), engineModel: "gemini-4-neon" };
        const engines = (await repoTaskEngines(configWith([carbon, neon, dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
        expect(textOf(await client.call("gemini_run_as_carbon", { task: TASK }))).toContain("No coding agent CLI can work for you");
        expect(notes).toContain("Gemini CLI was rate limited for Carbon; Carbon works as Claude from now on.");
        // Neon's model is not Carbon's: it still runs.
        await behave({});
        expect((await client.call("gemini_run_as_neon", { task: TASK })).isError).toBeFalsy();
        expect((await readRecord("gemini")).args).toContain("gemini-4-neon");

        // The checkout now has its own Gemini settings: Gemini CLI refuses to run for Dana, and Codex takes the call.
        await mkdir(join(repoDir, ".gemini"));
        await writeFile(join(repoDir, ".gemini", "settings.json"), "{}");
        const result = await client.call("gemini_run_as_dana", { task: TASK });
        expect(textOf(result)).toContain("Gemini CLI is unavailable for the rest of this task (it could not run here: the checkout has its own .gemini/settings.json");
        expect(textOf(result)).toContain("Codex finished");
        expect(notes).toContain("Gemini CLI could not run here for Dana; Codex takes over.");
      });

      it("does not move when the work itself failed, or the CLI did not say why", async () => {
        await behave({
          gemini: {
            kind: "apiError",
            message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          },
        });
        const engines = (await repoTaskEngines(configWith([dana()], { codex: CODEX_KEY, gemini: GEMINI_KEY }, { gemini: true }), deps()))!;
        engines.agentDefinition(dana(), base);
        const client = await mcpClient(engines.servers[ENGINES_SERVER] as McpSdkServerConfigWithInstance);
        const failed = await client.call("gemini_run_as_dana", { task: TASK });
        expect(failed.isError).toBe(true);
        expect(textOf(failed)).toContain("Gemini CLI failed after");
        expect(textOf(failed)).not.toContain("took the assignment over");
        expect(existsSync(join(root, "record-codex.json"))).toBe(false);

        // Exit 3 with only its own words on stderr: the work's, not the engine's.
        await behave({ kind: "fail" });
        expect((await client.call("gemini_run_as_dana", { task: TASK })).isError).toBe(true);
        expect(existsSync(join(root, "record-codex.json"))).toBe(false);
        expect(await gateOf(engines)("dana", "Edit")).toBeDefined();
        expect(notes.some((n) => n.includes("takes over"))).toBe(false);
      });
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
    expect(s.config.engines.codex).toEqual({ connected: true, key: `••••${CODEX_KEY.slice(-4)}`, model: "", checkedAt: expect.any(String), allowUnsandboxed: false });
    expect(JSON.stringify(s)).not.toContain(CODEX_KEY);
  });

  it("lets the owner allow running without a sandbox, off by default and again after a disconnect", async () => {
    expect(ConfigSchema.parse({}).engines.gemini.allowUnsandboxed).toBe(false);
    // A configuration saved before the setting existed.
    expect(ConfigSchema.parse({ engines: { codex: { apiKey: CODEX_KEY, model: "" } } }).engines.codex.allowUnsandboxed).toBe(false);

    expect(await reply(await post("/api/engines/gemini", { allowUnsandboxed: true }))).toEqual({ status: 400, body: { error: "Paste a Gemini API key to connect Gemini CLI." } });
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY, model: "gemini-test" })).status).toBe(200);
    expect((await state()).config.engines.gemini).toMatchObject({ connected: true, allowUnsandboxed: false });
    expect((await post("/api/engines/gemini", { allowUnsandboxed: "yes" })).status).toBe(400);
    expect(await reply(await post("/api/engines/gemini", { allowUnsandboxed: true }))).toEqual({ status: 200, body: { ok: true } });
    expect((await state()).config.engines.gemini).toMatchObject({ connected: true, model: "gemini-test", allowUnsandboxed: true });
    // Changing the model alone leaves it as it is.
    expect((await post("/api/engines/gemini", { model: "gemini-other" })).status).toBe(200);
    expect((await state()).config.engines.gemini).toMatchObject({ model: "gemini-other", allowUnsandboxed: true });
    expect((await post("/api/engines/gemini", { allowUnsandboxed: false })).status).toBe(200);
    expect((await state()).config.engines.gemini).toMatchObject({ allowUnsandboxed: false });

    expect((await post("/api/engines/gemini", { allowUnsandboxed: true })).status).toBe(200);
    expect((await post("/api/engines/gemini/disconnect", {})).status).toBe(200);
    expect((await state()).config.engines.gemini).toMatchObject({ connected: false, allowUnsandboxed: false });
  });

  it("adds ready-made team members only when connected, as many as the team has room for, each with its own name and model", async () => {
    expect(await reply(await post("/api/engines/gemini/agent", {}))).toEqual({ status: 400, body: { error: "Connect Gemini CLI first." } });
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY })).status).toBe(200);
    const added = await reply(await post("/api/engines/gemini/agent", {}));
    expect(added.status).toBe(200);
    expect(added.body.agent).toMatchObject({ id: "gemini", name: "Gemini", role: "Coder (Gemini CLI)", access: "write", engine: "gemini", engineModel: "", enabled: true });
    // Another on the same engine: the next free name and id, on a model of its own.
    const second = await reply(await post("/api/engines/gemini/agent", { engineModel: "gemini-4-neon" }));
    expect(second).toMatchObject({ status: 200, body: { agent: { id: "gemini-2", name: "Gemini 2", engine: "gemini", engineModel: "gemini-4-neon" } } });
    const third = await reply(await post("/api/engines/gemini/agent", { name: "Carbon", engineModel: "gemini-4-carbon" }));
    expect(third).toMatchObject({ status: 200, body: { agent: { id: "carbon", name: "Carbon", engineModel: "gemini-4-carbon" } } });
    // A name already taken gets a number.
    const fourth = await reply(await post("/api/engines/gemini/agent", { name: "carbon" }));
    expect(fourth.body.agent).toMatchObject({ id: "carbon-2", name: "carbon 2", engineModel: "" });
    const team = (await state()).config.team.agents.filter((a) => a.engine === "gemini");
    expect(team.map((a) => [a.id, a.engineModel])).toEqual([
      ["gemini", ""],
      ["gemini-2", "gemini-4-neon"],
      ["carbon", "gemini-4-carbon"],
      ["carbon-2", ""],
    ]);

    expect(await reply(await post("/api/engines/gemini/agent", { engineModel: "bad model;" }))).toMatchObject({ status: 400, body: { error: expect.stringContaining("letters, digits") } });
    expect((await post("/api/engines/gemini/agent", { name: "x".repeat(41) })).status).toBe(400);
    expect((await post("/api/engines/gemini/agent", { model: "gemini-4-neon" })).status).toBe(400);

    // A full team takes no more.
    const s = await state();
    const fillers = Array.from({ length: 30 - s.config.team.agents.length }, (_, i) => ({ ...team[0]!, id: `filler-${i}`, name: `Filler ${i}` }));
    const full = await fetch(`${base}/api/team`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...(s.config.team as object), agents: [...s.config.team.agents, ...fillers] }),
    });
    expect(full.status).toBe(200);
    expect(await reply(await post("/api/engines/gemini/agent", {}))).toEqual({ status: 400, body: { error: "A team can have at most 30 agents. Delete one first." } });
    // Back to the team before, for the tests after this one.
    await fetch(`${base}/api/team`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(s.config.team) });
  });

  it("lists the engine's models: admin only, the built-in list until connected, then live from the vendor, kept until a refresh", async () => {
    const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie ? { cookie } : {} });
    expect((await get("/api/engines/codex/models", false)).status).toBe(401);
    expect((await get("/api/engines/cursor/models")).status).toBe(404);
    expect((await post("/api/engines/codex/disconnect", {})).status).toBe(200);
    const builtIn = await (await get("/api/engines/codex/models")).json();
    expect(builtIn).toMatchObject({ live: false, source: "OpenAI", reason: expect.stringContaining("Connect Codex") });
    expect(builtIn.models.map((m: { id: string }) => m.id)).toContain("gpt-6.2-sol");

    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.openai.com") return realFetch(input, init);
      calls.push(`${url.pathname} ${new Headers(init?.headers).get("authorization")}`);
      const data = [
        { id: "gpt-6.2-sol", object: "model", created: 1_790_000_000, owned_by: "openai" },
        { id: "gpt-6.2-astra", object: "model", created: 1_790_000_100, owned_by: "openai" },
        { id: "text-embedding-3-large", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-realtime", object: "model", created: 1, owned_by: "openai" },
      ];
      return new Response(JSON.stringify({ object: "list", data }), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect((await post("/api/engines/codex", { apiKey: CODEX_KEY })).status).toBe(200);
    const live = await (await get("/api/engines/codex/models")).json();
    expect(live).toMatchObject({ live: true, source: "OpenAI" });
    expect(live.models.map((m: { id: string; label: string }) => [m.id, m.label])).toEqual([
      ["gpt-6.2-astra", "GPT-6.2 Astra"],
      ["gpt-6.2-sol", "GPT-6.2 Sol"],
    ]);
    expect(calls).toEqual([`/v1/models Bearer ${CODEX_KEY}`]);
    expect(JSON.stringify(live)).not.toContain(CODEX_KEY);
    // Kept: no second call, until a refresh.
    await get("/api/engines/codex/models");
    expect(calls).toHaveLength(1);
    await get("/api/engines/codex/models?refresh=1");
    expect(calls).toHaveLength(2);
  });

  it("disconnects, keeping the model and the agents", async () => {
    expect((await post("/api/engines/gemini", { apiKey: GEMINI_KEY, model: "gemini-test" })).status).toBe(200);
    expect(await reply(await post("/api/engines/gemini/disconnect", {}))).toEqual({ status: 200, body: { ok: true } });
    const s = await state();
    expect(s.config.engines.gemini).toEqual({ connected: false, key: null, model: "gemini-test", checkedAt: null, allowUnsandboxed: false });
  });
});
