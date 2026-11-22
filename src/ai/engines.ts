/**
 * Coding agent CLIs the team can hand work to in repo tasks (config.engines):
 * OpenAI's Codex and Google's Gemini CLI, run headless in the task's checkout.
 * An agent whose engine is "codex" or "gemini" is a light Claude subagent
 * whose one job is to hand its assignment to that CLI and report back.
 *
 * The CLIs run from an in-process MCP server ("engines"), one tool per engine
 * and mode: `<engine>_run` for agents that change things, `<engine>_run_read_only`
 * for agents that only look. An agent with a model of its own for the CLI
 * (AgentSpec.engineModel) gets a tool of its own, `<engine>_run_as_<agent>` or
 * `<engine>_read_as_<agent>`, which runs the CLI with that --model; the others
 * share the engine's tools and its model. An engine runs only inside its own sandbox (Codex,
 * where the container allows it) or when the owner allowed it to run without
 * one (EngineConnection.allowUnsandboxed; Gemini CLI has none here). Unsandboxed,
 * its commands run as the worker's user, outside the shell guard: they can read
 * the worker's environment through /proc. Each run:
 * - spawns the CLI in the checkout with a minimal environment: PATH, LANG,
 *   CI=1, a fresh private home and temp folder for this run, and that
 *   engine's key only (never the worker's environment, never another secret);
 * - has a hard timeout that kills the CLI's whole process group, enforced
 *   again by coreutils `timeout` so it holds even if the worker dies; the
 *   groups are also killed when the worker exits or gets SIGTERM, SIGINT or SIGHUP;
 * - streams short, redacted progress lines to the task's timeline (each
 *   output line capped, and what is kept from the run capped as it arrives);
 * - ends with the CLI's final message and what changed in the checkout
 *   (`git status --porcelain`, `git diff --stat`, through the worker's
 *   hardened git), capped and redacted;
 * - reports its tokens to the worker's spending caps (EngineDeps.spend), and
 *   is stopped like a timed-out run (its process group killed) once its
 *   agent's budget for the task is reached.
 * Neither CLI reports a dollar cost: token counts are reported when the CLI gives them (the worker estimates dollars, prices.ts).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { type AgentDefinition, type McpServerConfig, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Config, ENGINE_IDS, type EngineId } from "../core/config.js";
import { type AgentSpec, type Team, enabledAgents } from "../team/team.js";
import { gitRunner, makeRedactor } from "../tasks/worker.js";
import { GEMINI_SYSTEM_SETTINGS, GEMINI_SYSTEM_SETTINGS_PATH } from "./gemini-settings.js";

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
  /** Gemini CLI's system settings file (tests: a file of their own, not root's). Default: GEMINI_SYSTEM_SETTINGS_PATH, checked to be root's. */
  geminiSettings?: GeminiSettingsFile;
  /** coreutils `timeout`, which enforces a run's deadline even if the worker dies (tests: a stand-in, or null for none). Default: found on PATH. */
  timeoutCommand?: string | null;
  /** The spending caps (the worker's): each run's tokens are reported, and a run past its agent's per-task cap is stopped. */
  spend?: EngineSpend;
}

/** What the worker tracks of engine runs (attribution.ts, budget.ts). */
export interface EngineSpend {
  /** A run of `engine` is starting for this tool call (`tool` and its `task`, matched to the agent that made it); undefined: not tracked. */
  begin(o: { engine: EngineId; tool: string; task: string; model: string }): EngineRunSpend | undefined;
}

/** One tracked run. */
export interface EngineRunSpend {
  /**
   * The run's tokens so far: the CLI's own report once it gives one, else an
   * estimate from what it streamed. True = its agent's budget for this task
   * is reached, and the run is stopped.
   */
  update(usage: TokenUsage, model: string): boolean;
  /** The run ended (its tokens, as reported or estimated). */
  end(usage: TokenUsage | undefined, model: string): void;
}

/** Characters per token, for the estimate from a run's output before the CLI reports its tokens (a lower bound: each step reads more than it writes). */
const CHARS_PER_TOKEN = 4;

/** Where Gemini CLI's system settings are, and whether to check they are root's (Gemini CLI skips the file otherwise). */
export interface GeminiSettingsFile {
  path: string;
  checkOwner: boolean;
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
/** The tool of an agent with its own model: agent ids have no "_", so these never meet the shared names (at most 60 characters). */
const agentToolBase = (id: EngineId, mode: EngineMode, agentId: string) => `${id}_${mode === "write" ? "run" : "read"}_as_${agentId}`;
/** The tool an agent with its own engine model calls, e.g. mcp__engines__gemini_run_as_gemini-2. */
export const agentEngineToolName = (id: EngineId, mode: EngineMode, agentId: string) => `mcp__${ENGINES_SERVER}__${agentToolBase(id, mode, agentId)}`;
/** The tool an engine agent calls: its own when it has a model of its own, else the engine's for its mode. */
export const engineToolFor = (id: EngineId, agent: Pick<AgentSpec, "id" | "access" | "engineModel">) =>
  agent.engineModel ? agentEngineToolName(id, engineMode(agent), agent.id) : engineToolName(id, engineMode(agent));

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
/** An output line longer than this (characters) is dropped before it is parsed. */
export const LINE_MAX_CHARS = 64 * 1024;
/** While streaming: the CLI's messages kept (the last is its answer), the characters kept of each, and of an error it reports. */
const KEEP_MESSAGES = 2;
const MESSAGE_KEEP_CHARS = FINAL_MAX_CHARS + 2_000;
const ERROR_KEEP_CHARS = 2_000;
/** coreutils `timeout` stops a run this long after the worker's own deadline (so the worker normally stops it first and says why), and SIGKILLs it after BACKSTOP_KILL_AFTER. */
const BACKSTOP_MARGIN_S = 30;
const BACKSTOP_KILL_AFTER = "10s";

// ---------- The ready-made team members (POST /api/engines/:id/agent) ----------

/** The name a ready-made member starts from: "Codex", "Gemini". */
export const engineMemberName = (id: EngineId) => (id === "codex" ? "Codex" : "Gemini");

/** A new team member that works through `id`, with a unique agent id (the caller checks the team's limits), optionally named and on a model of its own. */
export function engineAgentTemplate(id: EngineId, agentId: string, o: { name?: string; engineModel?: string } = {}): AgentSpec {
  const info = ENGINES[id];
  const name = o.name ?? engineMemberName(id);
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
    engineModel: o.engineModel ?? "",
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

/**
 * Process groups still running, killed if the worker ends first (a detached
 * group outlives its parent): when it exits, and when it gets one of the
 * signals that end it ("exit" does not fire for those). A worker killed with
 * SIGKILL runs no code: coreutils `timeout` still stops each run at its deadline.
 */
const liveGroups = new Set<number>();
const ENDING_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
let hooksInstalled = false;
const killLiveGroups = () => {
  for (const group of liveGroups) killGroup(group, "SIGKILL");
};
function onEndingSignal(signal: NodeJS.Signals): void {
  killLiveGroups();
  // Another listener handles this signal (a graceful shutdown): it decides when the process ends.
  if (process.listenerCount(signal) > 1) return;
  // Ours was the only one, so without it the signal would have ended the process. With no listener left, Node restores the default action; the signal is raised again.
  for (const s of ENDING_SIGNALS) process.removeListener(s, onEndingSignal);
  process.kill(process.pid, signal);
}
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", killLiveGroups);
  for (const s of ENDING_SIGNALS) process.on(s, onEndingSignal);
}
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

let timeoutLookup: Promise<string | undefined> | undefined;
/** coreutils `timeout` on PATH (it takes --kill-after; the image's Debian base has it), or undefined. Looked up once. */
export function coreutilsTimeout(): Promise<string | undefined> {
  timeoutLookup ??= (async () => {
    const path = await findCommand("timeout");
    if (!path) return undefined;
    const version = await promisify(execFile)(path, ["--version"], { env: { PATH: process.env.PATH ?? "", LANG: "C" }, timeout: 5_000 }).then(
      (r) => r.stdout,
      () => "",
    );
    return /coreutils/i.test(version) ? path : undefined;
  })();
  return timeoutLookup;
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
 * Splits a stream into lines of at most `max` characters: a longer line is
 * dropped whole (`onDropped`), and no more than `max` of it is ever held.
 */
function readLines(input: NodeJS.ReadableStream, max: number, onLine: (line: string) => void, onDropped: () => void): void {
  let buffer = "";
  let dropping = false;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    let start = 0;
    for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, newline);
      start = newline + 1;
      if (dropping) dropping = false; // the end of a line already dropped
      else if (buffer.length + piece.length > max) onDropped();
      else onLine(buffer + piece);
      buffer = "";
    }
    if (dropping) return;
    const rest = chunk.slice(start);
    if (buffer.length + rest.length > max) {
      dropping = true;
      buffer = "";
      onDropped();
    } else buffer += rest;
  });
  input.on("end", () => {
    if (!dropping && buffer) onLine(buffer);
  });
}

/**
 * Runs a CLI in its own process group, the input on stdin and each stdout
 * line (at most LINE_MAX_CHARS) to `onLine`. At the timeout (or on `signal`)
 * the whole group gets SIGTERM, then SIGKILL; when the CLI exits, whatever it
 * left running in its group (a dev server, a watcher) is killed too. With a
 * `backstop`, it runs under coreutils `timeout`, which stops the group after
 * that many seconds even if this process is gone.
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
  /** An output line over LINE_MAX_CHARS was dropped. */
  onDroppedLine?: () => void;
  backstop?: { command: string; seconds: number };
}): Promise<CliRun> {
  return new Promise((resolve) => {
    // `timeout` leads the group: at its deadline it signals the whole group (the CLI and everything it started), then SIGKILLs it.
    const [file, args] = o.backstop ? [o.backstop.command, [`--kill-after=${BACKSTOP_KILL_AFTER}`, `${o.backstop.seconds}s`, o.command, ...o.args]] : [o.command, o.args];
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
      readLines(
        child.stdout,
        LINE_MAX_CHARS,
        (line) => {
          try {
            o.onLine?.(line.endsWith("\r") ? line.slice(0, -1) : line);
          } catch {
            // A line the parser cannot use is skipped.
          }
        },
        () => o.onDroppedLine?.(),
      );
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
      if (o.backstop) {
        // `timeout` could not start the CLI, or its own deadline came first (124). A run stopped here (its budget,
        // the task stopped) is not a timeout, whatever `timeout` exits with: the Rust coreutils exit 124 on SIGTERM too.
        const notStarted = timeoutStartFailure(code, stderr);
        if (notStarted) spawnError ??= notStarted;
        if (code === 124 && !aborted) timedOut = true;
      }
      resolve({ code, signal, timedOut, aborted, stderrTail: tailLines(stderr), ...(spawnError ? { spawnError } : {}) });
    });
  });
}

/**
 * Why `timeout` could not start the CLI (exit 126: not executable, 127: not
 * found), from its own line on stderr, or undefined. GNU coreutils says
 * "failed to run command …", the Rust coreutils some distributions ship say
 * "failed to execute process: … (os error 13)"; either way the line starts
 * with the path `timeout` was run as. Only that line counts: the CLI itself
 * may exit 126 or 127 for its own reasons.
 */
export function timeoutStartFailure(code: number | null, stderr: string): string | undefined {
  if (code !== 126 && code !== 127) return undefined;
  return stderr.match(/^\S*timeout: (failed to (?:run command|execute process).*)$/m)?.[1] ?? stderr.match(/^\S*timeout: (.+)$/m)?.[1];
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
  /** The model the CLI says it runs (Gemini CLI's init event). */
  model?: string;
}

/** One stdout line: what it adds to the state, and a progress line for the timeline (if any). */
type LineParser = (event: Record<string, unknown>, state: RunState) => string | undefined;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneLine = (text: string, max = 100) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const keep = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** A new message from the CLI, as it streams: only the last few are kept, each capped. */
function addMessage(state: RunState, text: string): void {
  state.messages.push(keep(text, MESSAGE_KEEP_CHARS));
  if (state.messages.length > KEEP_MESSAGES) state.messages.splice(0, state.messages.length - KEEP_MESSAGES);
}

/** `codex exec --json`: thread.started, turn.*, item.* (agent_message, command_execution, file_change…), error. */
export const parseCodexEvent: LineParser = (event, state) => {
  const type = str(event.type);
  if (type === "turn.completed") {
    const u = (event.usage ?? {}) as Record<string, unknown>;
    state.usage = { input: num(u.input_tokens), output: num(u.output_tokens) + num(u.reasoning_output_tokens), cached: num(u.cached_input_tokens) };
    return undefined;
  }
  if (type === "turn.failed") {
    state.failure = keep(str((event.error as { message?: unknown } | undefined)?.message) || "the turn failed", ERROR_KEEP_CHARS);
    return undefined;
  }
  if (type === "error") {
    state.lastError = keep(str(event.message), ERROR_KEEP_CHARS);
    return undefined;
  }
  if (type !== "item.completed") return undefined;
  const item = (event.item ?? {}) as Record<string, unknown>;
  switch (str(item.type)) {
    case "agent_message":
      if (str(item.text).trim()) addMessage(state, str(item.text));
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
      state.lastError = keep(str(item.message), ERROR_KEEP_CHARS);
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
  if (type === "init") {
    if (str(event.model)) state.model = keep(str(event.model), 100);
    return undefined;
  }
  if (type === "message" && event.role === "assistant") {
    // Deltas: the text between two tool calls is one message.
    if (!state.messages.length || state.split) {
      addMessage(state, "");
      state.split = false;
    }
    const last = state.messages.length - 1;
    if (state.messages[last]!.length < MESSAGE_KEEP_CHARS) state.messages[last] = keep(state.messages[last] + str(event.content), MESSAGE_KEEP_CHARS);
    return undefined;
  }
  if (type === "tool_use") {
    state.split = true;
    const name = str(event.tool_name) || "tool";
    const params = (event.parameters ?? {}) as Record<string, unknown>;
    return geminiToolText(name, params);
  }
  if (type === "error") {
    state.lastError = keep(str(event.message), ERROR_KEEP_CHARS);
    return undefined;
  }
  if (type === "result") {
    const stats = (event.stats ?? {}) as Record<string, unknown>;
    state.usage = { input: num(stats.input_tokens), output: num(stats.output_tokens), cached: num(stats.cached) };
    if (str(event.status) === "error") state.failure = keep(str((event.error as { message?: unknown } | undefined)?.message) || "the run failed", ERROR_KEEP_CHARS);
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
  /** Why a run in this mode cannot start, as a clause ("the checkout has …"), or undefined. Asked when the task starts (its agents then work as Claude) and again before each run. */
  refuse(mode: EngineMode): Promise<string | undefined>;
  /** The private home is ready (settings written); the arguments and environment for one run. */
  prepare(home: string, tmp: string, mode: EngineMode): Promise<{ args: string[]; env: Record<string, string> }>;
  /** A line for the summary: how the CLI ran (sandbox, approvals). */
  modeText(mode: EngineMode): string;
}

/** What both runners are made from. */
export interface RunnerOptions {
  command: string;
  key: string;
  model: string;
  repoDir: string;
  /** The owner lets it run without a sandbox (EngineConnection.allowUnsandboxed). */
  allowUnsandboxed: boolean;
}

const baseEnv = (home: string, tmp: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  LANG: process.env.LANG ?? "C.UTF-8",
  CI: "1",
  TMPDIR: tmp,
  NO_COLOR: "1",
});

/** Codex's sandbox modes: its own sandbox when the container allows it, else (when the owner allows it) none, and the container is the boundary. */
const codexSandbox = (mode: EngineMode, sandboxWorks: boolean) => (mode === "read" ? "read-only" : sandboxWorks ? "workspace-write" : "danger-full-access");

export function codexRunner(o: RunnerOptions & { sandboxWorks: boolean }): EngineRunner {
  return {
    info: ENGINES.codex,
    command: o.command,
    key: o.key,
    model: o.model,
    parse: parseCodexEvent,
    refuse: async (mode) => {
      if (o.sandboxWorks) return undefined;
      if (mode === "read") return "Codex cannot be kept read-only here: its sandbox does not work in this container";
      return o.allowUnsandboxed ? undefined : "Codex's sandbox does not work in this container, and running it without one is turned off (Integrations → Codex)";
    },
    prepare: async (home, tmp, mode) => {
      const sandbox = codexSandbox(mode, o.sandboxWorks);
      return {
        args: [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          // Nothing from the home folder's config.toml: only the settings below.
          "--ignore-user-config",
          // No execpolicy .rules files, the user's or the project's.
          "--ignore-rules",
          "--cd",
          o.repoDir,
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
          ...(o.model ? ["--model", o.model] : []),
          "-", // the assignment on stdin
        ],
        env: { ...baseEnv(home, tmp), CODEX_HOME: home, CODEX_API_KEY: o.key },
      };
    },
    modeText: (mode) => {
      const sandbox = codexSandbox(mode, o.sandboxWorks);
      return sandbox === "danger-full-access"
        ? "Codex ran without its sandbox, as the owner allows (the task container is the only boundary)."
        : `Codex ran in its ${sandbox} sandbox.`;
    },
  };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Whether `actual` holds every value of `expected`: objects may have more keys, everything else is equal. */
function includesSettings(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => includesSettings((actual as Record<string, unknown>)[k], v));
  }
  return isDeepStrictEqual(actual, expected);
}

/** A path and every folder above it, up to the root. */
function withAncestors(path: string): string[] {
  const chain = [path];
  for (let dir = dirname(path); dir !== chain.at(-1); dir = dirname(dir)) chain.push(dir);
  return chain;
}

/**
 * Why Gemini CLI would not apply the platform's system settings from `path`,
 * or undefined. Gemini CLI skips a system settings file unless it and every
 * folder above it (and above its real path) belong to root and are not
 * writable by group or others, and a symlink among them belongs to root; the
 * file must hold every setting of GEMINI_SYSTEM_SETTINGS (an image built from
 * an older version may not).
 */
export async function geminiSystemSettingsProblem(path: string, o: { checkOwner?: boolean } = {}): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `${path} is missing (rebuild the image)`;
  }
  if (o.checkOwner ?? true) {
    try {
      for (const p of new Set([...withAncestors(resolvePath(path)), ...withAncestors(await realpath(path))])) {
        const link = await lstat(p);
        if (link.isSymbolicLink() && link.uid !== 0) return `${p} is a symlink root does not own`;
        const s = await stat(p);
        if (s.uid !== 0) return `${p} is not owned by root`;
        if (s.mode & 0o022) return `${p} is writable by group or others`;
      }
    } catch (err) {
      return `${path} could not be checked (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return `${path} is not valid JSON`;
  }
  return includesSettings(settings, GEMINI_SYSTEM_SETTINGS) ? undefined : `${path} does not hold this version's settings (rebuild the image)`;
}

export function geminiRunner(o: RunnerOptions & { systemSettings: GeminiSettingsFile }): EngineRunner {
  return {
    info: ENGINES.gemini,
    command: o.command,
    key: o.key,
    model: o.model,
    parse: parseGeminiEvent,
    refuse: async (mode) => {
      if (!o.allowUnsandboxed) return "Gemini CLI has no sandbox here, and running it without one is turned off (Integrations → Gemini CLI)";
      // The platform's settings, merged after the checkout's own (gemini-settings.ts): without them nothing keeps a repository from changing how it runs.
      const settings = await geminiSystemSettingsProblem(o.systemSettings.path, { checkOwner: o.systemSettings.checkOwner });
      if (settings) return `its system settings are not in place: ${settings}`;
      // In a trusted workspace Gemini CLI loads the first .gemini/.env from the checkout up to / into its own environment, where it could set a proxy or turn off TLS checks
      // (the variables set here stay: a .env file never overrides one). A folder above the checkout is the platform's, but an earlier unsandboxed run could have written there.
      for (const dir of withAncestors(resolvePath(o.repoDir))) {
        if (!(await exists(join(dir, ".gemini", ".env")))) continue;
        return dir === resolvePath(o.repoDir)
          ? "the checkout has a .gemini/.env file, which Gemini CLI would load into its own environment"
          : `${join(dir, ".gemini", ".env")} is above the checkout, and Gemini CLI would load it into its own environment`;
      }
      // In a trusted workspace the project's .gemini settings and policies apply: in read mode they could allow edits.
      if (mode === "read") {
        if (await exists(join(o.repoDir, ".gemini"))) return "Gemini CLI cannot be kept read-only here: the checkout has its own .gemini settings, which could allow edits";
        return undefined;
      }
      // The system settings win only for the keys they set: the checkout's own could still add what they do not cover (policy paths, context folders), and its policies apply.
      for (const name of ["settings.json", "policies"]) {
        if (await exists(join(o.repoDir, ".gemini", name))) return `the checkout has its own .gemini/${name}, which Gemini CLI would apply to the run`;
      }
      return undefined;
    },
    prepare: async (home, tmp, mode) => {
      // The user scope gets the same settings: a second copy, should the system file ever be skipped (the checkout's would still merge after it).
      await mkdir(join(home, ".gemini"), { recursive: true, mode: 0o700 });
      await writeFile(join(home, ".gemini", "settings.json"), JSON.stringify(GEMINI_SYSTEM_SETTINGS), { mode: 0o600 });
      return {
        args: [
          "--prompt",
          "Do the assignment above.", // appended to the assignment on stdin
          "--output-format",
          "stream-json",
          // Headless, "default" approves reading only: edits and commands are refused.
          "--approval-mode",
          mode === "read" ? "default" : "yolo",
          // No MCP server starts: only one with this name may, and none has it (the flag wins over every settings file).
          "--allowed-mcp-server-names",
          `none-${randomBytes(12).toString("hex")}`,
          ...(o.model ? ["--model", o.model] : []),
        ],
        env: {
          ...baseEnv(home, tmp),
          GEMINI_CLI_HOME: home,
          GEMINI_API_KEY: o.key,
          // The platform's settings, merged last (a .env file cannot move them: the variable is set).
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: o.systemSettings.path,
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
    modeText: (mode) =>
      mode === "read"
        ? "Gemini CLI ran read-only (it may read, not edit or run commands)."
        : "Gemini CLI ran with every action approved and no sandbox, as the owner allows (the task container is the only boundary).",
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
 * Every string in a parsed value (an engine's event, the team's report),
 * redacted, in arrays and objects at any depth the parsers look. Decoded, so
 * a secret the JSON line escaped (quotes, backslashes, newlines) is caught
 * too, and whole, before any of it is cut. Anything nested deeper than the
 * parsers look is left out.
 */
export function redactStrings(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 16) return undefined;
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, redact, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v, redact, depth + 1)]));
}

/**
 * Runs one assignment through an engine and returns the summary for the
 * agent (capped and redacted). Never throws.
 */
export async function runEngine(
  runner: EngineRunner,
  o: { task: string; mode: EngineMode; timeoutMin: number; deps: EngineDeps; root: string; signal?: AbortSignal; gitHome: string; spend?: EngineRunSpend },
): Promise<{ ok: boolean; text: string }> {
  const { info } = runner;
  const ownKey = makeRedactor([runner.key]);
  const redact = (text: string) => ownKey(o.deps.redact(text));
  // Redacted before it is cut, so a cut never leaves part of a secret.
  const finish = (ok: boolean, text: string) => ({ ok, text: cap(redact(text), SUMMARY_MAX_CHARS) });

  // Checked again before each run: the checkout may have changed since the task started.
  const refusal = await runner.refuse(o.mode);
  if (refusal) {
    const why = `${info.label} was not started: ${refusal}.`;
    o.deps.note(redact(why).slice(0, NOTE_MAX_CHARS * 2));
    o.spend?.end(undefined, runner.model);
    return finish(false, `${why} ${o.mode === "read" ? "Do the assignment with your own tools instead." : "Say so in your report, so the work can go to another agent."}`);
  }
  // Its agent's budget for this task (the worker's caps): the run is stopped, its process group killed, once it is reached.
  const budgetStop = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, budgetStop.signal]) : budgetStop.signal;
  let streamed = 0;
  let overBudget = false;
  const tokensSoFar = (s: RunState): TokenUsage => s.usage ?? { input: Math.ceil(streamed / CHARS_PER_TOKEN), output: 0 };

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
    let dropped = 0;
    const every = o.deps.progressEveryMs ?? 15_000;
    const timeoutMs = o.timeoutMin * (o.deps.minuteMs ?? 60_000);
    const backstop = o.deps.timeoutCommand === undefined ? await coreutilsTimeout() : (o.deps.timeoutCommand ?? undefined);
    const run = await runCli({
      command: runner.command,
      args,
      cwd: o.deps.repoDir,
      env,
      input: cliPrompt(o.task, o.mode),
      timeoutMs,
      signal,
      backstop: backstop ? { command: backstop, seconds: Math.ceil(timeoutMs / 1000) + BACKSTOP_MARGIN_S } : undefined,
      onDroppedLine: () => {
        if (dropped++ === 0) o.deps.note(`${info.label}: an output line over ${LINE_MAX_CHARS / 1024} KB was left out`);
      },
      onLine: (line) => {
        streamed += line.length;
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        // Redacted as it arrives, once decoded: everything kept from the run (messages, commands, errors) is.
        const event = redactStrings(JSON.parse(trimmed), redact);
        if (event === null || typeof event !== "object" || Array.isArray(event)) return;
        const progress = runner.parse(event as Record<string, unknown>, state);
        if (o.spend && !overBudget && o.spend.update(tokensSoFar(state), state.model || runner.model)) {
          overBudget = true;
          o.deps.note(`${info.label} stopped: its agent's budget for this task is reached`);
          budgetStop.abort();
        }
        const now = Date.now();
        if (progress && notes < MAX_PROGRESS_NOTES && now - lastNoteAt >= every) {
          notes++;
          lastNoteAt = now;
          o.deps.note(redact(`${info.label}: ${progress}`).slice(0, NOTE_MAX_CHARS));
        }
      },
    });

    const took = minutesText(Date.now() - started);
    const why = run.spawnError
      ? `it could not start (${run.spawnError})`
      : run.timedOut
        ? `it timed out after ${o.timeoutMin} min and was stopped`
        : run.aborted
          ? overBudget
            ? "its agent's budget for this task was reached, so it was stopped; wrap up and report what is done"
            : "the task was stopped"
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
    o.spend?.end(usage ?? (streamed ? tokensSoFar(state) : undefined), state.model || runner.model);
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
      // Redacted whole before the cut (a secret split across streamed pieces is whole only here).
      final ? `${info.label}'s final message:\n${cap(redact(final), FINAL_MAX_CHARS)}` : `${info.label} gave no final message.`,
      dropped ? `${dropped} output line${dropped === 1 ? "" : "s"} over ${LINE_MAX_CHARS / 1024} KB ${dropped === 1 ? "was" : "were"} left out.` : "",
      !ok && errorTail ? `The end of its error output:\n${errorTail}` : "",
    ];
    return finish(ok, parts.filter(Boolean).join("\n\n"));
  } catch (err) {
    const message = `${info.label} failed: ${err instanceof Error ? err.message : String(err)}`;
    o.deps.note(redact(message).slice(0, NOTE_MAX_CHARS));
    o.spend?.end(streamed ? tokensSoFar(state) : undefined, state.model || runner.model);
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

/** The subagent of an agent that works through an engine: it hands the work over and checks it (through its own tool when it has a model of its own). */
export function engineAgentDefinition(agent: AgentSpec, base: AgentDefinition, id: EngineId): AgentDefinition {
  const info = ENGINES[id];
  const mode = engineMode(agent);
  const toolName = engineToolFor(id, agent);
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
    agents.map(
      (a) =>
        `- ${a.id} (${a.name}, ${a.role}) works through ${ENGINES[id].label}${a.engineModel ? ` on ${a.engineModel}` : ""} and ${engineMode(a) === "read" ? "looks only" : "changes files"}.`,
    ),
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
  const active: { id: EngineId; runner: EngineRunner; makeRunner: (model: string) => EngineRunner; agents: AgentSpec[] }[] = [];
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
    const options: RunnerOptions = { command, key: conn.apiKey, model: conn.model, repoDir: deps.repoDir, allowUnsandboxed: conn.allowUnsandboxed };
    let makeRunner: (model: string) => EngineRunner;
    let sandboxed = false;
    if (id === "codex") {
      sandboxed = await probeCodexSandbox(command, await privateRoot());
      makeRunner = (model) => codexRunner({ ...options, model, sandboxWorks: sandboxed });
    } else {
      const systemSettings = deps.geminiSettings ?? { path: GEMINI_SYSTEM_SETTINGS_PATH, checkOwner: true };
      makeRunner = (model) => geminiRunner({ ...options, model, systemSettings });
    }
    // The engine's own model; an agent with an engineModel gets a runner of its own with that one (below).
    const runner = makeRunner(conn.model);
    // What would refuse a run (no sandbox and not allowed, the image, the checkout's own settings): those agents work as Claude, as they could not hand their work over.
    const refused = new Map<string, AgentSpec[]>();
    const usable: AgentSpec[] = [];
    for (const mode of ["write", "read"] as const) {
      const inMode = agents.filter((a) => engineMode(a) === mode);
      if (!inMode.length) continue;
      const reason = await runner.refuse(mode);
      if (reason) refused.set(reason, [...(refused.get(reason) ?? []), ...inMode]);
      else usable.push(...inMode);
    }
    for (const [reason, left] of refused) {
      deps.note(`${info.label} left out: ${reason}. ${names(left)} work${left.length === 1 ? "s" : ""} as Claude in this task.`);
    }
    if (!usable.length) continue;
    if (id === "codex") deps.note(sandboxed ? "Codex runs in its own sandbox." : "Codex runs without its sandbox, as the owner allows: the task container is the only boundary.");
    else deps.note("Gemini CLI runs with no sandbox, as the owner allows: the task container is the only boundary.");
    active.push({ id, runner, makeRunner, agents: usable });
  }
  if (!active.length) return undefined;

  const engineRoot = await privateRoot();
  const gitHome = join(engineRoot, "git-home");
  await mkdir(gitHome, { recursive: true, mode: 0o700 });

  const input = {
    task: z.string().trim().min(1).max(TASK_MAX_CHARS).describe("The whole assignment, self-contained: the goal, files, constraints and how to check the result"),
    timeoutMin: z.number().int().min(1).max(MAX_TIMEOUT_MIN).optional().describe(`Minutes before the run is stopped (default ${DEFAULT_TIMEOUT_MIN})`),
  };
  /** One run tool: the engine's shared one for a mode (the engine's model), or an agent's own (its model). */
  const runTool = (id: EngineId, name: string, mode: EngineMode, runner: EngineRunner) => {
    const info = ENGINES[id];
    const on = runner.model ? ` It runs ${runner.model}.` : "";
    return tool(
      name,
      mode === "read"
        ? `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), read-only: it reads and searches the task's checkout and answers, without changing files.${on} Send the whole assignment in one call. Returns its final message and the state of the checkout.`
        : `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), which works in the task's checkout: reads code, edits files, runs commands.${on} Send the whole assignment in one call. Returns what it did: the files changed (git status, diff stat), its final message, and any failure.`,
      input,
      async (args, extra) => {
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        // Matched to its agent by this tool's full name and the task; priced at the model this run uses (the agent's own, else the engine's).
        const spend = deps.spend?.begin({ engine: id, tool: `mcp__${ENGINES_SERVER}__${name}`, task: args.task, model: runner.model });
        const result = await runEngine(runner, { task: args.task, mode, timeoutMin: args.timeoutMin ?? DEFAULT_TIMEOUT_MIN, deps, root: engineRoot, gitHome, signal, spend });
        return { content: [{ type: "text" as const, text: result.text }], ...(result.ok ? {} : { isError: true }) };
      },
      { annotations: { readOnlyHint: mode === "read", destructiveHint: mode === "write", openWorldHint: true }, alwaysLoad: true },
    );
  };

  const tools: ReturnType<typeof runTool>[] = [];
  const allToolNames: string[] = [];
  /** Each engine agent of this task: its engine and the tool it calls. */
  const byAgent = new Map<string, { id: EngineId; toolName: string }>();
  for (const { id, runner, makeRunner, agents } of active) {
    // The engine's shared tools, one per mode its agents on the engine's own model need.
    const shared = agents.filter((a) => !a.engineModel);
    for (const mode of [...new Set(shared.map(engineMode))]) {
      tools.push(runTool(id, toolBase(id, mode), mode, runner));
      allToolNames.push(engineToolName(id, mode));
    }
    // An agent on a model of its own gets its own tool and runner: two agents on one engine can each run another model.
    for (const a of agents.filter((x) => x.engineModel)) {
      const mode = engineMode(a);
      tools.push(runTool(id, agentToolBase(id, mode, a.id), mode, makeRunner(a.engineModel)));
      allToolNames.push(agentEngineToolName(id, mode, a.id));
    }
    for (const a of agents) byAgent.set(a.id, { id, toolName: engineToolFor(id, a) });
  }

  return {
    servers: {
      [ENGINES_SERVER]: createSdkMcpServer({ name: ENGINES_SERVER, version: "1.0.0", tools, alwaysLoad: true, timeout: (MAX_TIMEOUT_MIN + 5) * 60_000 }),
    },
    agentDefinition: (agent, base) => {
      const entry = byAgent.get(agent.id);
      // Only as the task set it up: the same engine, and the tool it has (a changed model would have none).
      return entry && agent.engine === entry.id && engineToolFor(entry.id, agent) === entry.toolName ? engineAgentDefinition(agent, base, entry.id) : undefined;
    },
    allToolNames,
    promptRule: enginePromptRule(active),
  };
}

/** For the console: the agents of a team that work through `id`. */
export const engineAgents = (team: Team, id: EngineId): AgentSpec[] => team.agents.filter((a) => a.engine === id);
