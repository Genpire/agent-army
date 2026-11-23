/**
 * Coding agent CLIs the team can hand work to in repo tasks (config.engines):
 * OpenAI's Codex and Google's Gemini CLI, run headless in the task's checkout.
 * An agent whose engine is "codex" or "gemini" is a light Claude subagent
 * whose one job is to hand its assignment to that CLI and report back.
 *
 * The CLIs run from an in-process MCP server ("engines"), one tool per engine
 * and mode: `<engine>_run` for agents that change things, `<engine>_run_read_only`
 * for agents that only look. An agent with a model of its own for the CLI
 * (AgentSpec.engineModel) or a fallback (AgentSpec.fallback) gets a tool of
 * its own, `<engine>_run_as_<agent>` or `<engine>_read_as_<agent>`, which runs
 * the CLI with that --model; the others share the engine's tools and its model.
 *
 * Each agent has a line (engine-fallback.ts): its engine, then its fallback,
 * which may end with Claude. The task starts it on the first CLI of the line
 * that can run here (no CLI at all: it works as Claude in this task, as
 * before fallbacks); when a run fails for the engine's own reasons (a rate
 * limit, quota or credit used up, a rejected key, the service down, a missing
 * model), the same tool call hands the assignment to the next CLI, from the
 * checkout as it is, and the engine stays down for the rest of the task. When
 * no CLI is left, an agent whose line names Claude is told to do the work
 * itself: its own Claude tools are in its definition, held back by a
 * PreToolUse hook (RepoTaskEngines.hooks) until then. Any other agent has
 * only its run tool and read-only checks, as before fallbacks: the tool says
 * why its CLIs failed and the agent reports back, so the work can go to
 * another agent.
 *
 * An engine runs only inside its own sandbox (Codex,
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
import { type AgentDefinition, type HookCallback, type HookCallbackMatcher, type McpServerConfig, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Config, ENGINE_IDS, type EngineId } from "../core/config.js";
import { type AgentSpec, type Team, enabledAgents } from "../team/team.js";
import { gitRunner, makeRedactor } from "../tasks/worker.js";
import { type EngineFailure, FAILURE_SAID, type LineStep, agentLine, engineFailure, engineFailureOf, failureScope } from "./engine-fallback.js";
import { GEMINI_SYSTEM_SETTINGS, GEMINI_SYSTEM_SETTINGS_PATH } from "./gemini-settings.js";

/** What a repo task gets for its engine agents. */
export interface RepoTaskEngines {
  /** In-process MCP servers (Options.mcpServers, top level), by key. */
  servers: Record<string, McpServerConfig>;
  /**
   * The subagent for an agent whose engine is not "claude"; undefined when no
   * CLI of its line (its engine, then its fallback) is connected and can run
   * in this task, or when its line names Claude and none works any more (the
   * agent then works as Claude).
   */
  agentDefinition(agent: AgentSpec, base: AgentDefinition): AgentDefinition | undefined;
  /** Every tool name engine agents may call, for allowedTools. */
  allToolNames: string[];
  /** Lines for the orchestrator's instructions: which agents work through which CLI, and who takes over. */
  promptRule: string;
  /**
   * For Options.hooks.PreToolUse, next to the worker's own; absent when no
   * line names Claude. An engine agent whose line names Claude has its own
   * Claude tools (to do the work itself once no CLI can), but may use only
   * its run tool and its read-only checks (Read, Glob, Grep, and Bash when its
   * access has it) while a CLI of its line still works: the rest are denied
   * until every CLI of its line is unavailable in this task. Without these
   * hooks nothing but the prompt holds such an agent to that. Other engine
   * agents have no tools beyond those in their definition.
   */
  hooks?: HookCallbackMatcher[];
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
  /**
   * A run of `engine` is starting for this tool call (`tool` and its `task`,
   * matched to the agent that made it); undefined: not tracked. `agent`: the
   * agent whose own tool it is, known without matching (a second run in one
   * call, when the next CLI of its line takes over, has no call of its own to match).
   */
  begin(o: { engine: EngineId; tool: string; task: string; model: string; agent?: string }): EngineRunSpend | undefined;
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
/** An agent with a model of its own for its CLI, or a fallback, has a tool of its own: its line is not the engine's alone. */
export const hasOwnTool = (agent: Pick<AgentSpec, "engineModel"> & { fallback?: AgentSpec["fallback"] }) => Boolean(agent.engineModel) || Boolean(agent.fallback?.length);
/** The tool an engine agent calls (`id`: the first CLI of its line that runs in this task): its own, else the engine's for its mode. */
export const engineToolFor = (id: EngineId, agent: Pick<AgentSpec, "id" | "access" | "engineModel"> & { fallback?: AgentSpec["fallback"] }) =>
  hasOwnTool(agent) ? agentEngineToolName(id, engineMode(agent), agent.id) : engineToolName(id, engineMode(agent));

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
    fallback: [],
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
  /** The error class it named with it (Gemini CLI's error.type: TerminalQuotaError…). */
  failureType?: string;
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
    if (str(event.status) === "error") {
      const error = (event.error ?? {}) as { message?: unknown; type?: unknown };
      state.failure = keep(str(error.message) || "the run failed", ERROR_KEEP_CHARS);
      if (str(error.type)) state.failureType = keep(str(error.type), 100);
    }
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

/** The assignment as the CLI gets it: the platform's ground rules, what an engine before it left (when it takes over), then the agent's words. */
export function cliPrompt(task: string, mode: EngineMode, takeover?: string): string {
  const rules =
    mode === "read"
      ? "Work read-only in this repository checkout: read and search the code, do not change any file."
      : "Work only in this repository checkout. Do not commit, push, or change git settings or remotes: the platform commits and publishes your changes.";
  return `${rules} Never write secrets, tokens or keys into files or output. When you are done, end with a short summary: what you changed or found, the files involved, and the checks you ran with their results.\n\n${takeover ? `${takeover}\n\n` : ""}${task}`;
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

/** What one run gives back: the summary for the agent, and why it failed when that was the engine's own doing (engine-fallback.ts). */
export interface EngineRunResult {
  ok: boolean;
  text: string;
  /** The engine could not do the work for its own reasons (not the work's): the next step of the agent's line may take over. */
  failure?: EngineFailure;
}

/**
 * Runs one assignment through an engine and returns the summary for the
 * agent (capped and redacted). Never throws. `takeover`: what an engine
 * before it left, for the CLI (when it takes over within one call).
 */
export async function runEngine(
  runner: EngineRunner,
  o: { task: string; mode: EngineMode; timeoutMin: number; deps: EngineDeps; root: string; signal?: AbortSignal; gitHome: string; spend?: EngineRunSpend; takeover?: string },
): Promise<EngineRunResult> {
  const { info } = runner;
  const ownKey = makeRedactor([runner.key]);
  const redact = (text: string) => ownKey(o.deps.redact(text));
  // Redacted before it is cut, so a cut never leaves part of a secret.
  const finish = (ok: boolean, text: string, failure?: EngineFailure): EngineRunResult => ({ ok, text: cap(redact(text), SUMMARY_MAX_CHARS), ...(failure ? { failure } : {}) });

  // Checked again before each run: the checkout may have changed since the task started.
  const refusal = await runner.refuse(o.mode);
  if (refusal) {
    const why = `${info.label} was not started: ${refusal}.`;
    o.deps.note(redact(why).slice(0, NOTE_MAX_CHARS * 2));
    o.spend?.end(undefined, runner.model);
    return finish(
      false,
      `${why} ${o.mode === "read" ? "Do the assignment with your own tools instead." : "Say so in your report, so the work can go to another agent."}`,
      engineFailureOf("cannot_run", oneLine(redact(refusal), 200)),
    );
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
      input: cliPrompt(o.task, o.mode, o.takeover),
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
    // Why it failed, when that was the engine's own doing: a CLI that could not start, or one whose own words say so.
    // Never a timeout, a stop (its agent's budget, the task) or a failure the CLI did not explain.
    const failure =
      ok || run.timedOut || run.aborted
        ? undefined
        : run.spawnError
          ? engineFailureOf("cannot_run", oneLine(redact(`it could not start (${run.spawnError})`), 200))
          : engineFailure({ engine: info.id, code: run.code, failure: state.failure, failureType: state.failureType, lastError: state.lastError, stderr: redact(run.stderrTail) });

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
    return finish(ok, parts.filter(Boolean).join("\n\n"), failure);
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

const names = (agents: Pick<AgentSpec, "name">[]) => agents.map((a) => a.name).join(", ");
const verb = (many: unknown[], one: string, more: string) => (many.length === 1 ? one : more);
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The read-only checks an engine agent makes while a CLI works for it: Bash only when its access has it. */
const checkTools = (agent: Pick<AgentSpec, "access">) => ["Read", "Glob", "Grep", ...(agent.access !== "read" ? ["Bash"] : [])];

/** What an engine agent's definition says of its line in this task. */
export interface EngineLineInfo {
  /** The CLI it works through now. */
  id: EngineId;
  /** Its run tool's full name. */
  toolName: string;
  /** The CLIs that take over after it, in order ("Codex (gpt-6.2-sol)"). */
  then?: string[];
  /**
   * Its line names Claude: once no CLI can work, the agent does the work
   * itself, so its definition has its own tools (held back by the hooks
   * until then) and the team's model, not the cheapest tier.
   */
  claude?: boolean;
}

/**
 * The subagent of an agent that works through an engine: it hands the work
 * over and checks it. When its line names Claude, it has its own Claude
 * tools too (never more than its base definition's), for when no CLI of its
 * line can work; the hooks (RepoTaskEngines.hooks) hold them back until
 * then. Otherwise it has only its run tool and the read-only checks, and
 * reports back when no CLI can do the work, as before fallbacks.
 */
export function engineAgentDefinition(agent: AgentSpec, base: AgentDefinition, line: EngineLineInfo): AgentDefinition {
  const info = ENGINES[line.id];
  const mode = engineMode(agent);
  const bash = agent.access !== "read";
  const then = line.then?.length ? `, the same call hands the assignment to ${line.then.join(", then ")}, and its result says which did the work. When none can` : "";
  const noneLeft = line.claude
    ? `the tool says so: from then on, do the assignment yourself with your own tools, which stay closed to you until then. Start from the checkout as it is, and say in your report that you did the work yourself and why.`
    : `the tool says so and why: do not do the assignment yourself. Report back that it was not done, with why, so the work can go to another agent.`;
  const prompt = `You are ${agent.name}, the team's ${agent.role}. You work through ${info.label}, ${info.vendor}'s coding agent, which runs in the task's checkout${mode === "read" ? " read-only" : " and can read, edit files and run commands there"}. ${info.label} does the work; you hand it the assignment and check what it did.

How you work:
1. Send the whole assignment to ${line.toolName} in one call: everything you were given (the goal, files, constraints, how to check the result), with the parts of your own instructions below that apply. Do not do the work yourself first, and do not split it into many small calls.
2. When it returns, verify the result yourself, read-only: Read and Grep the files it changed${bash ? ", and look at `git status` and `git diff`" : ""}. Never edit files yourself${bash ? " or run commands that change anything" : ""}${line.claude ? " while a coding agent CLI works for you" : ""}.
3. If it failed or missed part of the assignment, call it once more with exactly what is missing. If it still cannot do it, say so plainly.
4. Report back: what changed (each file and a sentence), what you verified, and anything left undone or failing.

When ${info.label} itself cannot work (a rate limit, its quota or credit used up, a rejected key, the service down)${then}, ${noneLeft} A failure of the work itself (a wrong change, failing tests) is not that: follow step 3.

Your own instructions:
${base.prompt}`;
  if (!line.claude) {
    return {
      description: base.description,
      tools: [line.toolName, ...checkTools(agent)],
      prompt,
      // The engine does the heavy lifting: the task provider's cheapest tier hands work over and checks it.
      model: base.model ?? "haiku",
      ...(base.effort !== undefined ? { effort: base.effort } : {}),
      background: false,
      // No mcpServers: the engines server is the query's own (top level), and its tools reach subagents through `tools`, as in chat.
    };
  }
  return {
    description: base.description,
    // Its own tools after the run tool and the checks; an agent whose base definition lists none (all tools) gets the checks only.
    tools: [...new Set([line.toolName, ...checkTools(agent), ...(base.tools ?? [])])],
    prompt,
    // The team's model, as Claude would have: it may end up doing the work itself.
    ...(base.model ? { model: base.model } : {}),
    ...(base.effort !== undefined ? { effort: base.effort } : {}),
    background: false,
    // Its own servers (browser, apps), for its own tools. The engines server is the query's (top level): its tools reach subagents through `tools`, as in chat.
    ...(base.mcpServers ? { mcpServers: base.mcpServers } : {}),
    ...(base.skills ? { skills: base.skills } : {}),
  };
}

/** A CLI of an agent's line as people read it: "Codex", "Codex (gpt-6.2-sol)". */
const stepText = (id: EngineId, model: string) => `${ENGINES[id].label}${model ? ` (${model})` : ""}`;

/** The orchestrator's rule: which agents work through which CLI, who takes over, and whether Claude does at the end. */
function enginePromptRule(entries: { agent: AgentSpec; steps: LineStep[]; claude: boolean }[]): string {
  const lines = entries.map(({ agent: a, steps, claude }) => {
    const [first, ...rest] = steps as [LineStep, ...LineStep[]];
    const label = ENGINES[first.engine].label;
    const line = `- ${a.id} (${a.name}, ${a.role}) works through ${label}${first.model ? ` on ${first.model}` : ""} and ${engineMode(a) === "read" ? "looks only" : "changes files"}`;
    const after = [...rest.map((s) => stepText(s.engine, s.model)), ...(claude ? [`${a.name} itself as Claude`] : [])];
    return after.length ? `${line}; if ${label} is unavailable, the work moves to ${after.join(", then ")}.` : `${line}.`;
  });
  return [
    "Coding agent CLIs: these agents hand their assignment to a coding agent CLI that works in the checkout like any coding agent (it reads code, edits files and runs commands), then check the result and report back.",
    ...lines,
    "Give each one a complete, self-contained assignment (the goal, files, constraints, how to check it), as you would any coding agent; review what they changed like any other agent's work. Do not call the mcp__engines__* tools yourself: hand the work to these agents.",
    "When a CLI fails for its own reasons (a rate limit, its quota or credit used up, a rejected key, an outage), the agent's tool hands the assignment to the next CLI of its line in the same call. When none is left, an agent whose line ends with Claude does the work itself; any other reports back that it could not, so give that work to another agent. Its report says who did the work. A failure of the work itself never moves it.",
  ].join("\n");
}

/** A CLI some agent's line names: whether it can run in this task, and in which modes. */
interface EngineSetup {
  /** No run can start: no key, or no CLI in the image. */
  missing?: "not connected" | "not installed";
  makeRunner?: (model: string) => EngineRunner;
  /** The engine's own model (config.engines). */
  model: string;
  /** Why a run in a mode would be refused (no sandbox and not allowed, the image, the checkout's own settings). */
  refusal: Partial<Record<EngineMode, string>>;
  sandboxed: boolean;
}

/** One CLI of a run tool's line, with the runner for its model. */
interface ToolStep {
  id: EngineId;
  runner: EngineRunner;
}

/** A run tool and the line it works through, with what the task has learned about it. */
interface ToolLine {
  /** Its full name. */
  tool: string;
  mode: EngineMode;
  steps: ToolStep[];
  /** The agents that call it (one, for an agent's own tool). */
  agents: AgentSpec[];
  /** The agent whose own tool it is. */
  own?: string;
  /** Its agent's line names Claude: when no CLI is left, the agent does the work itself (else it reports back). An agent's own tool only. */
  claude: boolean;
  /** Steps that could not run here (refused, or could not start), for the rest of the task. */
  skipped: Map<number, EngineFailure>;
  /** Steps already said to be down in the timeline. */
  noted: Set<number>;
}

/** What a run tool's line depends on: an agent changed in any of it has no tool in this task. */
const lineKey = (a: AgentSpec) => JSON.stringify([a.engine, a.engineModel, a.fallback ?? [], a.access]);

/** Undefined when no enabled agent has a CLI of its line that can run in this task. */
export async function repoTaskEngines(config: Config, deps: EngineDeps): Promise<RepoTaskEngines | undefined> {
  const engineAgents = enabledAgents(config.team).filter((a) => a.engine !== "claude");
  const lines = new Map(engineAgents.map((a) => [a.id, agentLine(a)]));
  const stepsOf = (a: AgentSpec) => lines.get(a.id)?.steps ?? [];
  let root: string | undefined;
  const privateRoot = async () => {
    root ??= await mkdtemp(join(deps.workRoot, "engines-"));
    return root;
  };

  // Every CLI a line names, whoever's: whether it can run here, and in which modes.
  const setups = new Map<EngineId, EngineSetup>();
  for (const id of ENGINE_IDS) {
    const users = engineAgents.filter((a) => stepsOf(a).some((s) => s.engine === id));
    if (!users.length) continue;
    const info = ENGINES[id];
    const conn = config.engines[id];
    if (!conn.apiKey) {
      setups.set(id, { missing: "not connected", model: conn.model, refusal: {}, sandboxed: false });
      continue;
    }
    const command = await findCommand(deps.commands?.[id] ?? info.command);
    if (!command) {
      setups.set(id, { missing: "not installed", model: conn.model, refusal: {}, sandboxed: false });
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
    // What would refuse a run (no sandbox and not allowed, the image, the checkout's own settings): no line starts on it in that mode.
    const refusal: Partial<Record<EngineMode, string>> = {};
    const runner = makeRunner(conn.model);
    for (const mode of new Set(users.map(engineMode))) {
      const reason = await runner.refuse(mode);
      if (reason) refusal[mode] = reason;
    }
    setups.set(id, { makeRunner, model: conn.model, refusal, sandboxed });
  }
  const runsHere = (id: EngineId, mode: EngineMode) => {
    const setup = setups.get(id);
    return Boolean(setup?.makeRunner) && !setup?.refusal[mode];
  };
  // Each agent's line in this task: the CLIs of it that can run here, in order; Claude after them.
  const live = new Map(engineAgents.map((a) => [a.id, stepsOf(a).filter((s) => runsHere(s.engine, engineMode(a)))]));

  /** Where the agents go that `id` cannot take in this task: their own engine's agents to the next CLI of their line or to Claude; the others only lose it from their fallback. */
  const whereTheyGo = (id: EngineId, agents: AgentSpec[]) => {
    const own = agents.filter((a) => a.engine === id);
    const parts: string[] = [];
    const toClaude = own.filter((a) => !live.get(a.id)?.length);
    if (toClaude.length) parts.push(`${names(toClaude)} ${verb(toClaude, "works", "work")} as Claude in this task`);
    const moved = new Map<string, AgentSpec[]>();
    for (const a of own) {
      const start = live.get(a.id)?.[0];
      if (start) moved.set(stepText(start.engine, start.model), [...(moved.get(stepText(start.engine, start.model)) ?? []), a]);
    }
    for (const [to, list] of moved) parts.push(`${names(list)} ${verb(list, "starts", "start")} on ${to} in this task`);
    const fallbackOnly = agents.filter((a) => a.engine !== id);
    if (fallbackOnly.length) parts.push(`it is left out of ${fallbackOnly.length === 1 ? `${fallbackOnly[0]!.name}'s fallback` : `the fallback of ${names(fallbackOnly)}`}`);
    return parts.join("; ");
  };

  // Engine by engine: who a CLI that cannot run here leaves where, then how it runs when some line has it.
  for (const id of ENGINE_IDS) {
    const setup = setups.get(id);
    if (!setup) continue;
    const info = ENGINES[id];
    const byReason = new Map<string, AgentSpec[]>();
    for (const a of engineAgents) {
      if (!stepsOf(a).some((s) => s.engine === id) || runsHere(id, engineMode(a))) continue;
      const reason = setup.missing ?? setup.refusal[engineMode(a)] ?? "";
      byReason.set(reason, [...(byReason.get(reason) ?? []), a]);
    }
    for (const [reason, agents] of byReason) {
      const where = whereTheyGo(id, agents);
      if (setup.missing === "not connected") deps.note(`${info.label} is not connected: ${where}.`);
      else if (setup.missing === "not installed") deps.note(`${info.label} left out: its CLI (${info.command}) is not installed in this image, so ${where}.`);
      else deps.note(`${info.label} left out: ${reason}. ${capitalized(where)}.`);
    }
    if (!engineAgents.some((a) => live.get(a.id)?.some((s) => s.engine === id))) continue;
    if (id === "codex") deps.note(setup.sandboxed ? "Codex runs in its own sandbox." : "Codex runs without its sandbox, as the owner allows: the task container is the only boundary.");
    else deps.note("Gemini CLI runs with no sandbox, as the owner allows: the task container is the only boundary.");
  }

  const active = engineAgents.filter((a) => live.get(a.id)?.length);
  if (!active.length) return undefined;

  const engineRoot = await privateRoot();
  const gitHome = join(engineRoot, "git-home");
  await mkdir(gitHome, { recursive: true, mode: 0o700 });

  // The run tools, engine by engine (the one each line starts on): the engine's shared tools for the agents on its own model with no
  // fallback (one per mode), then a tool of its own for each other agent, which runs its whole line.
  const runnerFor = (s: LineStep) => {
    const setup = setups.get(s.engine)!;
    return setup.makeRunner!(s.model || setup.model);
  };
  const newLine = (tool: string, mode: EngineMode, steps: ToolStep[], agents: AgentSpec[], own?: string): ToolLine => ({
    tool,
    mode,
    steps,
    agents,
    ...(own ? { own } : {}),
    // A shared tool's agents have no fallback, so no Claude in their line.
    claude: own ? (lines.get(own)?.claude ?? false) : false,
    skipped: new Map(),
    noted: new Set(),
  });
  const toolLines: ToolLine[] = [];
  for (const id of ENGINE_IDS) {
    const starting = active.filter((a) => live.get(a.id)![0]!.engine === id);
    const shared = starting.filter((a) => !hasOwnTool(a));
    for (const mode of [...new Set(shared.map(engineMode))]) {
      toolLines.push(newLine(engineToolName(id, mode), mode, [{ id, runner: runnerFor({ engine: id, model: "" }) }], shared.filter((a) => engineMode(a) === mode)));
    }
    for (const a of starting.filter((x) => hasOwnTool(x))) {
      const mode = engineMode(a);
      const steps = live.get(a.id)!.map((s) => ({ id: s.engine, runner: runnerFor(s) }));
      toolLines.push(newLine(engineToolFor(id, a), mode, steps, [a], a.id));
    }
  }
  /** Each engine agent of this task: its tool's line, what it was set up from, and what it may use while a CLI works. */
  const byAgent = new Map<string, { line: ToolLine; key: string; allowed: Set<string> }>();
  for (const line of toolLines) for (const a of line.agents) byAgent.set(a.id, { line, key: lineKey(a), allowed: new Set([line.tool, ...checkTools(a)]) });

  // What the task has learned: engines (a refused key, no credit) and models (a rate limit, a quota, an outage, a missing model) that are down.
  const down = new Map<string, EngineFailure>();
  const modelKey = (s: ToolStep) => `${s.id} ${s.runner.model}`;
  const downOf = (line: ToolLine, i: number): EngineFailure | undefined => {
    const step = line.steps[i]!;
    return line.skipped.get(i) ?? down.get(step.id) ?? down.get(modelKey(step));
  };
  /** The step of a line that works now; undefined = none: the agent works as Claude when its line names Claude, else reports back. */
  const current = (line: ToolLine): number | undefined => {
    for (let i = 0; i < line.steps.length; i++) if (!downOf(line, i)) return i;
    return undefined;
  };
  const markDown = (line: ToolLine, i: number, failure: EngineFailure) => {
    const step = line.steps[i]!;
    const scope = failureScope(failure.kind);
    if (scope === "line") line.skipped.set(i, failure);
    else down.set(scope === "engine" ? step.id : modelKey(step), failure);
  };

  const label = (s: ToolStep) => ENGINES[s.id].label;
  const said = (s: ToolStep, f: EngineFailure) => `${FAILURE_SAID[f.kind]}${f.kind === "model" && s.runner.model ? ` ${s.runner.model}` : ""}`;
  /** What becomes of a line's agents once no CLI of it is left. */
  const noneLeft = (line: ToolLine) =>
    line.claude
      ? `${names(line.agents)} ${verb(line.agents, "works", "work")} as Claude from now on`
      : `no coding agent CLI is left for ${names(line.agents)} in this task, so ${verb(line.agents, "it reports", "they report")} back without doing the work`;
  const note = (text: string) => deps.note(deps.redact(text).slice(0, NOTE_MAX_CHARS * 2));
  const unavailable = (s: ToolStep, f: EngineFailure) => `${label(s)} is unavailable for the rest of this task (${f.reason}${f.detail ? `: ${f.detail}` : ""}).`;

  /** One call of a run tool: the line's CLIs in turn, from the one that works now, until one does the work or fails at it; none left = the agent's turn. */
  const runLine = async (line: ToolLine, args: { task: string; timeoutMin?: number }, signal?: AbortSignal) => {
    const reply = (ok: boolean, text: string) => ({ content: [{ type: "text" as const, text: cap(text, SUMMARY_MAX_CHARS + 2_000) }], ...(ok ? {} : { isError: true }) });
    const moves: { step: ToolStep; failure: EngineFailure; ran: boolean }[] = [];
    let i = current(line);
    // CLIs down before this call (an earlier call, or another agent's run on the same engine): straight past them, said once.
    for (let j = 0; j < (i ?? line.steps.length); j++) {
      const step = line.steps[j]!;
      const failure = downOf(line, j)!;
      moves.push({ step, failure, ran: false });
      if (line.noted.has(j)) continue;
      line.noted.add(j);
      const next = i === undefined ? undefined : line.steps[i];
      note(`${label(step)} is unavailable in this task (${failure.reason}); ${next ? `${label(next)} takes over for ${names(line.agents)}` : noneLeft(line)}.`);
    }
    while (i !== undefined) {
      const step = line.steps[i]!;
      const ran = moves.filter((m) => m.ran);
      // Matched to its agent by the tool's full name and the task (an agent's own tool says whose it is); priced at the model this run uses.
      const spend = deps.spend?.begin({ engine: step.id, tool: line.tool, task: args.task, model: step.runner.model, ...(line.own ? { agent: line.own } : {}) });
      const result = await runEngine(step.runner, {
        task: args.task,
        mode: line.mode,
        timeoutMin: args.timeoutMin ?? DEFAULT_TIMEOUT_MIN,
        deps,
        root: engineRoot,
        gitHome,
        signal,
        spend,
        ...(ran.length
          ? {
              takeover: `Another coding agent started on this assignment and could not finish it (${ran.map((m) => `${label(m.step)}: ${m.failure.reason}`).join("; ")}).${line.mode === "write" ? " The checkout may already hold some of its changes (see git status and git diff): keep what is right and do the rest." : ""}`,
            }
          : {}),
      });
      if (!result.failure || signal?.aborted) {
        const before = moves.length ? `${moves.map((m) => unavailable(m.step, m.failure)).join(" ")} ${label(step)} took the assignment over, from the checkout as it was; its run follows.\n\n` : "";
        return reply(result.ok, `${before}${result.text}`);
      }
      // The engine's own failure: it is down for the rest of the task, and the next CLI of the line takes the same assignment.
      markDown(line, i, result.failure);
      line.noted.add(i);
      moves.push({ step, failure: result.failure, ran: true });
      const next = current(line);
      note(`${label(step)} ${said(step, result.failure)} for ${names(line.agents)}; ${next === undefined ? noneLeft(line) : `${label(line.steps[next]!)} takes over`}.`);
      i = next;
    }
    const first = moves[0]!.step;
    const why = moves.map((m) => unavailable(m.step, m.failure)).join(" ");
    if (!line.claude) {
      // None left and no Claude in its line: the failure, with why, for the agent to report (as before fallbacks).
      return reply(
        false,
        `${why} No coding agent CLI can work for you for the rest of this task.

Do not do the assignment yourself. Report back that it was not done because ${label(first)} was unavailable, with the reason above, so the work can go to another agent. Do not call ${line.tool} again in this task.`,
      );
    }
    // None left: the agent does the work itself, its own tools open from now on (the hooks).
    return reply(
      true,
      `${why} No coding agent CLI can work for you for the rest of this task.

Do the assignment yourself now, with your own tools: they are open to you from now on. Start from the checkout as it is${line.mode === "write" ? " (`git status` and `git diff` show anything a CLI changed before it stopped)" : ""}, do the whole assignment as your own instructions say, and say in your report that you did the work yourself because ${label(first)} was unavailable. Do not call ${line.tool} again in this task.`,
    );
  };

  const input = {
    task: z.string().trim().min(1).max(TASK_MAX_CHARS).describe("The whole assignment, self-contained: the goal, files, constraints and how to check the result"),
    timeoutMin: z.number().int().min(1).max(MAX_TIMEOUT_MIN).optional().describe(`Minutes before the run is stopped (default ${DEFAULT_TIMEOUT_MIN})`),
  };
  /** One run tool: the engine's shared one for a mode (the engine's model), or an agent's own (its line, each CLI on its model). */
  const runTool = (line: ToolLine) => {
    const first = line.steps[0]!;
    const info = ENGINES[first.id];
    const on = first.runner.model ? ` It runs ${first.runner.model}.` : "";
    const after = line.steps.slice(1).map((s) => stepText(s.id, s.runner.model));
    const then = after.length ? ` Should ${info.label} be unavailable (a rate limit, quota or credit used up, a rejected key, an outage), ${after.join(", then ")} takes the assignment over in the same call.` : "";
    return tool(
      line.tool.slice(`mcp__${ENGINES_SERVER}__`.length),
      line.mode === "read"
        ? `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), read-only: it reads and searches the task's checkout and answers, without changing files.${on}${then} Send the whole assignment in one call. Returns its final message and the state of the checkout.`
        : `Hand an assignment to ${info.label} (${info.vendor}'s coding agent), which works in the task's checkout: reads code, edits files, runs commands.${on}${then} Send the whole assignment in one call. Returns what it did: the files changed (git status, diff stat), its final message, and any failure.`,
      input,
      async (args, extra) => runLine(line, args, (extra as { signal?: AbortSignal } | undefined)?.signal),
      { annotations: { readOnlyHint: line.mode === "read", destructiveHint: line.mode === "write", openWorldHint: true }, alwaysLoad: true },
    );
  };

  /** The engine agents whose line names Claude and whose engine definition the latest run of the team got, by id: the hooks hold only them. */
  const gated = new Map<string, { line: ToolLine; allowed: Set<string> }>();
  const gate: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !input.agent_type) return {};
    const entry = gated.get(input.agent_type);
    if (!entry || entry.allowed.has(input.tool_name)) return {};
    const i = current(entry.line);
    // Every CLI of its line is down: the agent does the work itself.
    if (i === undefined) return {};
    const checks = [...entry.allowed].filter((t) => t !== entry.line.tool).join(", ");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${label(entry.line.steps[i]!)} does your work in this task: hand it the assignment with ${entry.line.tool}, and check what it did with ${checks}. Your other tools open only if no coding agent CLI can work for you; the tool says so when that happens.`,
      },
    };
  };

  // A call may run each CLI of its line in turn, each up to its timeout.
  const longest = Math.max(...toolLines.map((l) => l.steps.length));
  return {
    servers: {
      [ENGINES_SERVER]: createSdkMcpServer({ name: ENGINES_SERVER, version: "1.0.0", tools: toolLines.map(runTool), alwaysLoad: true, timeout: (MAX_TIMEOUT_MIN * longest + 5) * 60_000 }),
    },
    agentDefinition: (agent, base) => {
      const entry = byAgent.get(agent.id);
      const i = entry ? current(entry.line) : undefined;
      // Only as the task set it up (a changed line or access has no tool here). Once no CLI of its line works, an agent
      // whose line names Claude works as Claude; any other keeps its definition, and its tool says why it cannot work.
      if (!entry || entry.key !== lineKey(agent) || (i === undefined && entry.line.claude)) {
        gated.delete(agent.id);
        return undefined;
      }
      if (entry.line.claude) gated.set(agent.id, entry);
      else gated.delete(agent.id);
      const steps = entry.line.steps;
      const at = i ?? 0;
      return engineAgentDefinition(agent, base, {
        id: steps[at]!.id,
        toolName: entry.line.tool,
        then: i === undefined ? [] : steps.slice(at + 1).map((s) => stepText(s.id, s.runner.model)),
        claude: entry.line.claude,
      });
    },
    allToolNames: toolLines.map((l) => l.tool),
    promptRule: enginePromptRule(toolLines.flatMap((l) => l.agents.map((agent) => ({ agent, steps: live.get(agent.id)!, claude: l.claude })))),
    ...(toolLines.some((l) => l.claude) ? { hooks: [{ hooks: [gate] }] } : {}),
  };
}

/** For the console: the agents of a team that work through `id`. */
export const engineAgents = (team: Team, id: EngineId): AgentSpec[] => team.agents.filter((a) => a.engine === id);
