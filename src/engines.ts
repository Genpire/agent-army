/**
 * Coding agent CLIs the team can hand work to in repo tasks (config.engines):
 * OpenAI's Codex and Google's Gemini CLI, run headless in the task's checkout.
 * An agent whose engine is "codex" or "gemini" is a light Claude subagent
 * whose one job is to hand its assignment to that CLI and report back.
 *
 * The CLIs run from an in-process MCP server ("engines"), one tool per engine
 * and mode: `<engine>_run` for agents that change things, `<engine>_run_read_only`
 * for agents that only look. Each run:
 * - spawns the CLI in the checkout with a minimal environment: PATH, LANG,
 *   CI=1, a fresh private home and temp folder for this run, and that
 *   engine's key only (never the worker's environment, never another secret);
 * - has a hard timeout that kills the CLI's whole process group;
 * - streams short, redacted progress lines to the task's timeline;
 * - ends with the CLI's final message and what changed in the checkout
 *   (`git status --porcelain`, `git diff --stat`, through the worker's
 *   hardened git), capped and redacted.
 * Neither CLI reports a dollar cost: token counts are reported when the CLI gives them.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { delimiter, isAbsolute, join } from "node:path";
import { type AgentDefinition, type McpServerConfig, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Config, ENGINE_IDS, type EngineId } from "./config.js";
import { type AgentSpec, type Team, enabledAgents } from "./team.js";
import { gitRunner, makeRedactor } from "./worker.js";

/** What a repo task gets for its engine agents. */
export interface RepoTaskEngines {
  /** In-process MCP servers (Options.mcpServers, top level), by key. */
  servers: Record<string, McpServerConfig>;
  /** The subagent for an agent whose engine is not "claude"; undefined when its engine is not connected or cannot run in this task (the agent then works as Claude). */
  agentDefinition(agent: AgentSpec, base: AgentDefinition): AgentDefinition | undefined;
  /** Every tool name engine agents may call, for allowedTools. */
  allToolNames: string[];
  /** Lines for the orchestrator's instructions: which agents work through which CLI. */
  promptRule: string;
}

export interface EngineDeps {
  repoDir: string;
  /** A private folder next to the checkout for the CLIs' homes. */
  workRoot: string;
  redact: (text: string) => string;
  /** Adds a line to the task's timeline (the console's Activity). */
  note: (text: string) => void;
  /** The command each CLI runs as (tests: a fake script). Default: the CLI's command found on PATH. */
  commands?: Partial<Record<EngineId, string>>;
  /** Milliseconds in a minute of a run's timeout (tests shorten it). */
  minuteMs?: number;
  /** Least time between two progress lines of one run (default 15 s). */
  progressEveryMs?: number;
}

/** Each CLI, for people and for the platform. */
export interface EngineInfo {
  id: EngineId;
  /** "Codex", "Gemini CLI". */
  label: string;
  vendor: "OpenAI" | "Google";
  /** The CLI's command, on PATH in the image (see the Dockerfile). */
  command: string;
  /** The npm package that installs it. */
  pkg: string;
  /** The only secret its environment holds. */
  keyEnv: string;
}

export const ENGINES: Readonly<Record<EngineId, EngineInfo>> = {
  codex: { id: "codex", label: "Codex", vendor: "OpenAI", command: "codex", pkg: "@openai/codex", keyEnv: "CODEX_API_KEY" },
  gemini: { id: "gemini", label: "Gemini CLI", vendor: "Google", command: "gemini", pkg: "@google/gemini-cli", keyEnv: "GEMINI_API_KEY" },
};

/** The connected engines, by id. */
export const connectedEngines = (config: Config): EngineId[] => ENGINE_IDS.filter((id) => Boolean(config.engines[id].apiKey));

/** The in-process server's key in Options.mcpServers. */
export const ENGINES_SERVER = "engines";
/** A run either changes the checkout ("write", for agents with access run or write) or only reads it. */
export type EngineMode = "write" | "read";
export const engineMode = (agent: Pick<AgentSpec, "access">): EngineMode => (agent.access === "read" ? "read" : "write");
const toolBase = (id: EngineId, mode: EngineMode) => (mode === "write" ? `${id}_run` : `${id}_run_read_only`);
/** The tool an agent calls, e.g. mcp__engines__codex_run. */
export const engineToolName = (id: EngineId, mode: EngineMode) => `mcp__${ENGINES_SERVER}__${toolBase(id, mode)}`;

export const DEFAULT_TIMEOUT_MIN = 20;
export const MAX_TIMEOUT_MIN = 60;
/** The assignment, at most (characters). */
export const TASK_MAX_CHARS = 40_000;
/** What a run returns to the agent, at most (characters). */
export const SUMMARY_MAX_CHARS = 12_000;
const FINAL_MAX_CHARS = 6_000;
const LIST_MAX_CHARS = 3_000;
const STDERR_TAIL_CHARS = 1_500;
const NOTE_MAX_CHARS = 160;
const MAX_PROGRESS_NOTES = 30;
/** After SIGTERM, how long the process group has before SIGKILL. */
const KILL_GRACE_MS = 2_000;
const PROBE_TIMEOUT_MS = 30_000;

// ---------- The ready-made team members (POST /api/engines/:id/agent) ----------

/** A new team member that works through `id`, with a unique agent id (the caller checks the team's limits). */
export function engineAgentTemplate(id: EngineId, agentId: string): AgentSpec {
  const info = ENGINES[id];
  const name = id === "codex" ? "Codex" : "Gemini";
  return {
    id: agentId,
    name,
    role: `Coder (${info.label})`,
    emoji: id === "codex" ? ":robot_face:" : ":gem:",
    description: `Implements scoped code changes through ${info.vendor}'s ${info.label}: features, bug fixes, refactors and tests in the repository. Give it a complete, self-contained assignment.`,
    instructions: `You are ${name}, a coder on a software team, and your work is done by ${info.label}, ${info.vendor}'s coding agent.
- Pass on the whole assignment: the goal, the files and code involved, constraints, and how to check the result (the project's tests, linters and build).
- Ask for the smallest change that fully solves the task, in the style of the surrounding code, with tests for new behaviour where the project has tests.
- Ask it to run the relevant tests or checks and to say which ones it ran.
- Check what it changed before you report: read the diff, and say plainly what is left undone or did not pass.`,
    access: "write",
    model: "",
    effort: "",
    enabled: true,
    skills: [],
    avatar: "",
    apps: [],
    engine: id,
  };
}

// ---------- Finding and running a CLI ----------

/** An executable path for `command`: as given when it has a slash, else the first on PATH. */
export async function findCommand(command: string, path = process.env.PATH ?? ""): Promise<string | undefined> {
  const executable = async (p: string) => {
    try {
      await access(p, constants.X_OK);
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/")) return (await executable(command)) ? command : undefined;
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    const candidate = join(dir, command);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

/** Process groups still running, killed if the worker exits first (a detached group outlives its parent). */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const group of liveGroups) killGroup(group, "SIGKILL");
  });
}
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** The end of a text, from the start of a line: a cut line could hold part of a secret that redaction no longer recognises. */
function tailLines(text: string): string {
  if (text.length <= STDERR_TAIL_CHARS) return text;
  const end = text.slice(-STDERR_TAIL_CHARS);
  const newline = end.indexOf("\n");
  return newline >= 0 ? end.slice(newline + 1) : "";
}

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Stopped because the request was cancelled. */
  aborted: boolean;
  /** The last of what it wrote to stderr. */
  stderrTail: string;
  /** Why it could not start. */
  spawnError?: string;
}

/**
 * Runs a CLI in its own process group, the input on stdin and each stdout
 * line to `onLine`. At the timeout (or on `signal`) the whole group gets
 * SIGTERM, then SIGKILL; when the CLI exits, whatever it left running in its
 * group (a dev server, a watcher) is killed too.
 */
export function runCli(o: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}): Promise<CliRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, stderrTail: "", spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const pid = child.pid;
    if (pid) trackGroup(pid);
    let timedOut = false;
    let aborted = false;
    let stderr = "";
    let spawnError: string | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const stop = () => {
      if (!pid) return;
      killGroup(pid, "SIGTERM");
      hardKill ??= setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      spawnError = err.message;
      // It never started (no such file, not executable): there is no "close" to wait for.
      if (!pid) {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        resolve({ code: null, signal: null, timedOut, aborted, stderrTail: "", spawnError });
      }
    });
    child.stdin?.on("error", () => {}); // a CLI that exits without reading its input
    child.stdin?.end(o.input);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4 * STDERR_TAIL_CHARS);
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        try {
          o.onLine?.(line);
        } catch {
          // A line the parser cannot use is skipped.
        }
      });
    }
    // The CLI is done: nothing it started may outlive it (its output closes only once they are gone too).
    child.on("exit", () => {
      if (pid) killGroup(pid, "SIGKILL");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      o.signal?.removeEventListener("abort", onAbort);
      if (pid) liveGroups.delete(pid);
      resolve({ code, signal, timedOut, aborted, stderrTail: tailLines(stderr), ...(spawnError ? { spawnError } : {}) });
    });
  });
}

// ---------- What each CLI says (JSONL on stdout) ----------

export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
}

/** What a run made of the CLI's output. */
interface RunState {
  /** The CLI's messages, last one = its final answer. */
  messages: string[];
  usage?: TokenUsage;
  /** The CLI's own account of why the run failed. */
  failure?: string;
  /** The last error it reported along the way (retries, warnings). */
  lastError?: string;
  /** Gemini: a tool call ended the message being streamed; the next text starts a new one. */
  split?: boolean;
}

/** One stdout line: what it adds to the state, and a progress line for the timeline (if any). */
type LineParser = (event: Record<string, unknown>, state: RunState) => string | undefined;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneLine = (text: string, max = 100) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `codex exec --json`: thread.started, turn.*, item.* (agent_message, command_execution, file_change…), error. */
export const parseCodexEvent: LineParser = (event, state) => {
  const type = str(event.type);
  if (type === "turn.completed") {
    const u = (event.usage ?? {}) as Record<string, unknown>;
    state.usage = { input: num(u.input_tokens), output: num(u.output_tokens) + num(u.reasoning_output_tokens), cached: num(u.cached_input_tokens) };
    return undefined;
  }
  if (type === "turn.failed") {
    state.failure = str((event.error as { message?: unknown } | undefined)?.message) || "the turn failed";
    return undefined;
  }
  if (type === "error") {
    state.lastError = str(event.message);
    return undefined;
  }
  if (type !== "item.completed") return undefined;
  const item = (event.item ?? {}) as Record<string, unknown>;
  switch (str(item.type)) {
    case "agent_message":
      if (str(item.text).trim()) state.messages.push(str(item.text));
      return undefined;
    case "command_execution": {
      const exit = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
      return `ran \`${oneLine(str(item.command), 80)}\`${exit}`;
    }
    case "file_change": {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => str((c as { path?: unknown }).path)).filter(Boolean);
      return paths.length ? `changed ${oneLine(paths.join(", "), 100)}` : undefined;
    }
    case "error":
      state.lastError = str(item.message);
      return undefined;
    default:
      return undefined;
  }
};

/** Words for a Gemini CLI tool call: its name and the path, command or pattern it was given. */
function geminiToolText(name: string, params: Record<string, unknown>): string {
  const target = str(params.file_path) || str(params.absolute_path) || str(params.path) || str(params.dir_path) || str(params.command) || str(params.pattern);
  return target ? `${name} ${oneLine(target, 90)}` : name;
}

/** `gemini -o stream-json`: init, message (assistant deltas), tool_use, tool_result, error, result. */
export const parseGeminiEvent: LineParser = (event, state) => {
  const type = str(event.type);
  if (type === "message" && event.role === "assistant") {
    // Deltas: the text between two tool calls is one message.
    if (!state.messages.length || state.split) {
      state.messages.push("");
      state.split = false;
    }
    state.messages[state.messages.length - 1] += str(event.content);
    return undefined;
  }
  if (type === "tool_use") {
    state.split = true;
    const name = str(event.tool_name) || "tool";
    const params = (event.parameters ?? {}) as Record<string, unknown>;
    return geminiToolText(name, params);
  }
  if (type === "error") {
    state.lastError = str(event.message);
    return undefined;
  }
  if (type === "result") {
    const stats = (event.stats ?? {}) as Record<string, unknown>;
    state.usage = { input: num(stats.input_tokens), output: num(stats.output_tokens), cached: num(stats.cached) };
    if (str(event.status) === "error") state.failure = str((event.error as { message?: unknown } | undefined)?.message) || "the run failed";
    return undefined;
  }
  return undefined;
};

// ---------- One run ----------

/** The two CLIs differ in arguments, environment and output; everything else is shared. */
export interface EngineRunner {
  info: EngineInfo;
  command: string;
  key: string;
  model: string;
  parse: LineParser;
  /** Why this run cannot start (in its mode), or undefined. */
  refuse(mode: EngineMode): Promise<string | undefined>;
  /** The private home is ready (settings written); the arguments and environment for one run. */
  prepare(home: string, tmp: string, mode: EngineMode): Promise<{ args: string[]; env: Record<string, string> }>;
  /** A line for the summary: how the CLI ran (sandbox, approvals). */
  modeText(mode: EngineMode): string;
}

const baseEnv = (home: string, tmp: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  LANG: process.env.LANG ?? "C.UTF-8",
  CI: "1",
  TMPDIR: tmp,
  NO_COLOR: "1",
});

/** Codex's sandbox modes: its own sandbox when the container allows it, else the container is the boundary. */
const codexSandbox = (mode: EngineMode, sandboxWorks: boolean) => (mode === "read" ? "read-only" : sandboxWorks ? "workspace-write" : "danger-full-access");

export function codexRunner(command: string, key: string, model: string, repoDir: string, sandboxWorks: boolean): EngineRunner {
  return {
    info: ENGINES.codex,
    command,
    key,
    model,
    parse: parseCodexEvent,
    refuse: async (mode) =>
      mode === "read" && !sandboxWorks ? "Codex cannot be kept read-only here: its sandbox does not work in this container. Do the assignment with your own tools instead." : undefined,
    prepare: async (home, tmp, mode) => {
      const sandbox = codexSandbox(mode, sandboxWorks);
      return {
        args: [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          // Nothing from the home folder's config.toml: only the settings below.
          "--ignore-user-config",
          "--cd",
          repoDir,
          "--sandbox",
          sandbox,
          "-c",
          'approval_policy="never"',
          "-c",
          "analytics.enabled=false",
          "-c",
          "check_for_update_on_startup=false",
          "-c",
          'history.persistence="none"',
          // Commands Codex runs get no variable named like *KEY*, *SECRET* or *TOKEN* (its own key included).
          "-c",
          "shell_environment_policy.ignore_default_excludes=false",
          ...(sandbox === "workspace-write" ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
          ...(model ? ["--model", model] : []),
          "-", // the assignment on stdin
        ],
        env: { ...baseEnv(home, tmp), CODEX_HOME: home, CODEX_API_KEY: key },
      };
    },
    modeText: (mode) => {
      const sandbox = codexSandbox(mode, sandboxWorks);
      return sandbox === "danger-full-access" ? "Codex ran without its sandbox (the task container is the boundary)." : `Codex ran in its ${sandbox} sandbox.`;
    },
  };
}

/** Gemini CLI's settings for a run: no auto-update, no usage statistics or telemetry, no project .env, its key hidden from the commands it runs. */
const GEMINI_SETTINGS = {
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  advanced: { ignoreLocalEnv: true },
  security: { environmentVariableRedaction: { enabled: true, blocked: ["GEMINI_API_KEY"] } },
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

export function geminiRunner(command: string, key: string, model: string, repoDir: string): EngineRunner {
  return {
    info: ENGINES.gemini,
    command,
    key,
    model,
    parse: parseGeminiEvent,
    refuse: async (mode) => {
      // Gemini CLI loads a trusted workspace's .gemini/.env into its own environment, where it could redirect the key.
      if (await exists(join(repoDir, ".gemini", ".env"))) return "Gemini CLI was not started: the checkout has a .gemini/.env file, which it would load into its own environment.";
      // In a trusted workspace the project's .gemini settings and policies apply, and they can allow edits.
      if (mode === "read" && (await exists(join(repoDir, ".gemini"))))
        return "Gemini CLI cannot be kept read-only here: the checkout has its own .gemini settings, which could allow edits. Do the assignment with your own tools instead.";
      return undefined;
    },
    prepare: async (home, tmp, mode) => {
      await mkdir(join(home, ".gemini"), { recursive: true, mode: 0o700 });
      await writeFile(join(home, ".gemini", "settings.json"), JSON.stringify(GEMINI_SETTINGS), { mode: 0o600 });
      return {
        args: [
          "--prompt",
          "Do the assignment above.", // appended to the assignment on stdin
          "--output-format",
          "stream-json",
          // Headless, "default" approves reading only: edits and commands are refused.
          "--approval-mode",
          mode === "read" ? "default" : "yolo",
          ...(model ? ["--model", model] : []),
        ],
        env: {
          ...baseEnv(home, tmp),
          GEMINI_CLI_HOME: home,
          GEMINI_API_KEY: key,
          // Headless runs need a trusted workspace; the checkout is the task's own.
          GEMINI_CLI_TRUST_WORKSPACE: "true",
          // Set (empty or off), so no .env file can set them: where requests and the key go.
          GOOGLE_GEMINI_BASE_URL: "",
          GOOGLE_VERTEX_BASE_URL: "",
          GOOGLE_GENAI_USE_VERTEXAI: "false",
          GOOGLE_GENAI_USE_GCA: "false",
        },
      };
    },
    modeText: (mode) => (mode === "read" ? "Gemini CLI ran read-only (it may read, not edit or run commands)." : "Gemini CLI ran with every action approved (no sandbox: the task container is the boundary)."),
  };
}

const minutesText = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
export const usageText = (u: TokenUsage) => `${thousands(u.input)} in${u.cached ? ` (${thousands(u.cached)} cached)` : ""}, ${thousands(u.output)} out`;

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 40).trimEnd()}\n… (cut at ${max} characters)` : text);

/** The assignment as the CLI gets it: the platform's ground rules, then the agent's words. */
export function cliPrompt(task: string, mode: EngineMode): string {
  const rules =
    mode === "read"
      ? "Work read-only in this repository checkout: read and search the code, do not change any file."
      : "Work only in this repository checkout. Do not commit, push, or change git settings or remotes: the platform commits and publishes your changes.";
  return `${rules} Never write secrets, tokens or keys into files or output. When you are done, end with a short summary: what you changed or found, the files involved, and the checks you ran with their results.\n\n${task}`;
}

/**
 * Runs one assignment through an engine and returns the summary for the
 * agent (capped and redacted). Never throws.
 */
export async function runEngine(
  runner: EngineRunner,
  o: { task: string; mode: EngineMode; timeoutMin: number; deps: EngineDeps; root: string; signal?: AbortSignal; gitHome: string },
): Promise<{ ok: boolean; text: string }> {
  const { info } = runner;
  const redact = (text: string) => makeRedactor([runner.key])(o.deps.redact(text));
  // Redacted before it is cut, so a cut never leaves part of a secret.
  const finish = (ok: boolean, text: string) => ({ ok, text: cap(redact(text), SUMMARY_MAX_CHARS) });

  const refusal = await runner.refuse(o.mode);
  if (refusal) {
    o.deps.note(redact(`${info.label}: ${refusal}`).slice(0, NOTE_MAX_CHARS * 2));
    return finish(false, refusal);
  }

  // A fresh home and temp folder for each run (0700, next to the checkout): nothing one run writes there reaches the next.
  const runDir = await mkdtemp(join(o.root, `${info.id}-`));
  const home = join(runDir, "home");
  const tmp = join(runDir, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  const started = Date.now();
  const state: RunState = { messages: [] };
  try {
    const { args, env } = await runner.prepare(home, tmp, o.mode);
    o.deps.note(`${info.label} started${o.mode === "read" ? " (read-only)" : ""}: ${oneLine(redact(o.task), 110)}`);

    let notes = 0;
    let lastNoteAt = 0;
    const every = o.deps.progressEveryMs ?? 15_000;
    const run = await runCli({
      command: runner.command,
      args,
      cwd: o.deps.repoDir,
      env,
      input: cliPrompt(o.task, o.mode),
      timeoutMs: o.timeoutMin * (o.deps.minuteMs ?? 60_000),
      signal: o.signal,
      onLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        // Redacted as it arrives: everything kept from the run (messages, commands, errors) is.
        const progress = runner.parse(JSON.parse(redact(trimmed)) as Record<string, unknown>, state);
        const now = Date.now();
        if (progress && notes < MAX_PROGRESS_NOTES && now - lastNoteAt >= every) {
          notes++;
          lastNoteAt = now;
          o.deps.note(`${info.label}: ${progress}`.slice(0, NOTE_MAX_CHARS));
        }
      },
    });

    const took = minutesText(Date.now() - started);
    const why = run.spawnError
      ? `it could not start (${run.spawnError})`
      : run.timedOut
        ? `it timed out after ${o.timeoutMin} min and was stopped`
        : run.aborted
          ? "the task was stopped"
          : run.code !== 0
            ? state.failure || state.lastError || `it exited with ${run.code === null ? `signal ${run.signal}` : `code ${run.code}`}`
            : state.failure;
    const ok = !why;

    // What changed in the checkout: the worker's hardened git, read-only and lock-free.
    const git = gitRunner({ host: { gitAuthArgs: () => [] }, cwd: o.deps.repoDir, home: o.gitHome, redact });
    const [status, diffStat] = (
      await Promise.all([
        git(["--no-optional-locks", "status", "--porcelain"]).catch((err: unknown) => `(git status failed: ${err instanceof Error ? err.message : String(err)})`),
        git(["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--stat"]).catch((err: unknown) => `(git diff failed: ${err instanceof Error ? err.message : String(err)})`),
      ])
    ).map(redact) as [string, string];
    const changed = status.split("\n").filter((l) => l.trim()).length;
    const final = state.messages.at(-1)?.trim() ?? "";
    // A run that failed before the model answered reports zero tokens: nothing to say.
    const usage = state.usage && state.usage.input + state.usage.output > 0 ? state.usage : undefined;
    // Its own log lines, without stack frames.
    const errorTail = redact(run.stderrTail)
      .split("\n")
      .filter((l) => l.trim() && !/^\s+at /.test(l))
      .join("\n")
      .trim();

    o.deps.note(
      redact(
        `${info.label} ${ok ? "finished" : "failed"} after ${took}${ok ? "" : `: ${oneLine(why ?? "", 90)}`} · ${changed} file${changed === 1 ? "" : "s"} changed in the checkout${usage ? ` · tokens ${usageText(usage)}` : ""}`,
      ),
    );

    const parts = [
      ok ? `${info.label} finished after ${took}.` : `${info.label} failed after ${took}: ${why}.`,
      runner.modeText(o.mode),
      usage ? `Tokens: ${usageText(usage)} (billed by ${info.vendor}).` : "",
      `Changed files in the checkout (git status --porcelain):\n${cap(status || "(none)", LIST_MAX_CHARS)}`,
      diffStat ? `git diff --stat:\n${cap(diffStat, LIST_MAX_CHARS)}` : "",
      final ? `${info.label}'s final message:\n${cap(final, FINAL_MAX_CHARS)}` : `${info.label} gave no final message.`,
      !ok && errorTail ? `The end of its error output:\n${errorTail}` : "",
    ];
    return finish(ok, parts.filter(Boolean).join("\n\n"));
  } catch (err) {
    const message = `${info.label} failed: ${err instanceof Error ? err.message : String(err)}`;
    o.deps.note(redact(message).slice(0, NOTE_MAX_CHARS));
    return finish(false, message);
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether Codex's own sandbox works here (`codex sandbox -- true`): it needs unprivileged user namespaces on Linux. */
export async function probeCodexSandbox(command: string, root: string): Promise<boolean> {
  const dir = await mkdtemp(join(root, "codex-probe-"));
  try {
    const run = await runCli({ command, args: ["sandbox", "--", "true"], cwd: dir, env: { ...baseEnv(dir, dir), CODEX_HOME: dir }, input: "", timeoutMs: PROBE_TIMEOUT_MS });
    return run.code === 0 && !run.timedOut && !run.spawnError;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- The repo task's engines ----------

const names = (agents: AgentSpec[]) => agents.map((a) => a.name).join(", ");

/** The subagent of an agent that works through an engine: it hands the work over and checks it. */
export function engineAgentDefinition(agent: AgentSpec, base: AgentDefinition, id: EngineId): AgentDefinition {
  const info = ENGINES[id];
  const mode = engineMode(agent);
  const toolName = engineToolName(id, mode);
  const bash = agent.access !== "read";
  const prompt = `You are ${agent.name}, the team's ${agent.role}. You work through ${info.label}, ${info.vendor}'s coding agent, which runs in the task's checkout${mode === "read" ? " read-only" : " and can read, edit files and run commands there"}. ${info.label} does the work; you hand it the assignment and check what it did.

How you work:
1. Send the whole assignment to ${toolName} in one call: everything you were given (the goal, files, constraints, how to check the result), with the parts of your own instructions below that apply. Do not do the work yourself first, and do not split it into many small calls.
2. When it returns, verify the result yourself, read-only: Read and Grep the files it changed${bash ? ", and look at `git status` and `git diff`" : ""}. Never edit files yourself${bash ? " or run commands that change anything" : ""}.
3. If it failed or missed part of the assignment, call it once more with exactly what is missing. If it still cannot do it, say so plainly.
4. Report back: what changed (each file and a sentence), what you verified, and anything left undone or failing.

Your own instructions:
${base.prompt}`;
  return {
    description: base.description,
    tools: [toolName, "Read", "Glob", "Grep", ...(bash ? ["Bash"] : [])],
    prompt,
    // The engine does the heavy lifting: the task provider's cheapest tier hands work over and checks it.
    model: base.model ?? "haiku",
    ...(base.effort !== undefined ? { effort: base.effort } : {}),
    background: false,
    // No mcpServers: the engines server is the query's own (top level), and its tools reach subagents through `tools`, as in chat.
  };
}

/** The orchestrator's rule: which agents work through which CLI. */
function enginePromptRule(groups: { id: EngineId; agents: AgentSpec[] }[]): string {
  const lines = groups.flatMap(({ id, agents }) =>
    agents.map((a) => `- ${a.id} (${a.name}, ${a.role}) works through ${ENGINES[id].label} and ${engineMode(a) === "read" ? "looks only" : "changes files"}.`),
  );
  return [
    "Coding agent CLIs: these agents hand their assignment to a coding agent CLI that works in the checkout like any coding agent (it reads code, edits files and runs commands), then check the result and report back.",
    ...lines,
    "Give each one a complete, self-contained assignment (the goal, files, constraints, how to check it), as you would any coding agent; review what they changed like any other agent's work. Do not call the mcp__engines__* tools yourself: hand the work to these agents.",
  ].join("\n");
}

/** Undefined when no enabled agent uses a connected engine. */
export async function repoTaskEngines(config: Config, deps: EngineDeps): Promise<RepoTaskEngines | undefined> {
  const usedBy = (id: EngineId) => enabledAgents(config.team).filter((a) => a.engine === id);
  const active: { id: EngineId; runner: EngineRunner; agents: AgentSpec[] }[] = [];
  let root: string | undefined;
  const privateRoot = async () => {
    root ??= await mkdtemp(join(deps.workRoot, "engines-"));
    return root;
  };

  for (const id of ENGINE_IDS) {
    const agents = usedBy(id);
    if (!agents.length) continue;
    const info = ENGINES[id];
    const conn = config.engines[id];
    if (!conn.apiKey) {
      deps.note(`${info.label} is not connected: ${names(agents)} work${agents.length === 1 ? "s" : ""} as Claude in this task.`);
      continue;
    }
    const command = await findCommand(deps.commands?.[id] ?? info.command);
    if (!command) {
      deps.note(`${info.label} left out: its CLI (${info.command}) is not installed in this image, so ${names(agents)} work${agents.length === 1 ? "s" : ""} as Claude in this task.`);
      continue;
    }
    let runner: EngineRunner;
    let usable = agents;
    if (id === "codex") {
      const sandboxWorks = await probeCodexSandbox(command, await privateRoot());
      deps.note(sandboxWorks ? "Codex runs in its own sandbox." : "Codex runs without its sandbox; the task container is the boundary.");
      runner = codexRunner(command, conn.apiKey, conn.model, deps.repoDir, sandboxWorks);
      if (!sandboxWorks) {
        // A read-only Codex needs its sandbox: those agents work as Claude instead.
        const lookers = agents.filter((a) => engineMode(a) === "read");
        if (lookers.length) deps.note(`Codex cannot run read-only without its sandbox: ${names(lookers)} work${lookers.length === 1 ? "s" : ""} as Claude in this task.`);
        usable = agents.filter((a) => engineMode(a) === "write");
      }
    } else {
      runner = geminiRunner(command, conn.apiKey, conn.model, deps.repoDir);
    }
    if (usable.length) active.push({ id, runner, agents: usable });
  }
  if (!active.length) return undefined;

  const engineRoot = await privateRoot();
  const gitHome = join(engineRoot, "git-home");
  await mkdir(gitHome, { recursive: true, mode: 0o700 });

  const input = {
    task: z.string().trim().min(1).max(TASK_MAX_CHARS).describe("The whole assignment, self-contained: the goal, files, constraints and how to check the result"),
    timeoutMin: z.number().int().min(1).max(MAX_TIMEOUT_MIN).optional().describe(`Minutes before the run is stopped (default ${DEFAULT_TIMEOUT_MIN})`),
  };
  const tools = active.flatMap(({ id, runner, agents }) => {
    const info = ENGINES[id];
    const modes = [...new Set(agents.map(engineMode))];
    return modes.map((mode) =>
      tool(
        toolBase(id, mode),
        mode === "read"
          ? `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), read-only: it reads and searches the task's checkout and answers, without changing files. Send the whole assignment in one call. Returns its final message and the state of the checkout.`
          : `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), which works in the task's checkout: reads code, edits files, runs commands. Send the whole assignment in one call. Returns what it did: the files changed (git status, diff stat), its final message, and any failure.`,
        input,
        async (args, extra) => {
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          const result = await runEngine(runner, { task: args.task, mode, timeoutMin: args.timeoutMin ?? DEFAULT_TIMEOUT_MIN, deps, root: engineRoot, gitHome, signal });
          return { content: [{ type: "text" as const, text: result.text }], ...(result.ok ? {} : { isError: true }) };
        },
        { annotations: { readOnlyHint: mode === "read", destructiveHint: mode === "write", openWorldHint: true }, alwaysLoad: true },
      ),
    );
  });

  const byAgent = new Map(active.flatMap(({ id, agents }) => agents.map((a) => [a.id, id] as const)));
  return {
    servers: {
      [ENGINES_SERVER]: createSdkMcpServer({ name: ENGINES_SERVER, version: "1.0.0", tools, alwaysLoad: true, timeout: (MAX_TIMEOUT_MIN + 5) * 60_000 }),
    },
    agentDefinition: (agent, base) => {
      const id = byAgent.get(agent.id);
      return id && agent.engine === id ? engineAgentDefinition(agent, base, id) : undefined;
    },
    allToolNames: active.flatMap(({ id, agents }) => [...new Set(agents.map(engineMode))].map((mode) => engineToolName(id, mode))),
    promptRule: enginePromptRule(active),
  };
}

/** For the console: the agents of a team that work through `id`. */
export const engineAgents = (team: Team, id: EngineId): AgentSpec[] => team.agents.filter((a) => a.engine === id);
