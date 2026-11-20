import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { RepoSetupContext, SetupResult } from "../team/agents.js";
import { type Config, RESERVED_ENV_KEYS, type RepoSetup } from "../core/config.js";

/**
 * The owner's per-repository setup (Repo setup card on the admin page): a
 * command run once after the checkout, how to start the app for browser
 * checks, and environment variables for the agents' shell. The values of
 * those variables are secrets: they are redacted everywhere (configSecrets)
 * and only their names reach the team's prompt.
 */

export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const SETUP_TAIL_LINES = 60;
export const SETUP_TAIL_CHARS = 4000;
/** Output kept while the command runs; only the tail is ever reported. */
const OUTPUT_KEEP_CHARS = 256 * 1024;
/** After a timeout: how long the process group gets to stop before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** After the shell exits: how long to wait for output from processes it left running. */
const DRAIN_MS = 1_000;

/** The setup configured for `repo` ("owner/repo"), matched case-insensitively like GitHub does. */
export function findRepoSetup(config: Pick<Config, "repoSetup">, repo: string): RepoSetup | undefined {
  const exact = config.repoSetup[repo];
  if (exact) return exact;
  const wanted = repo.toLowerCase();
  const key = Object.keys(config.repoSetup).find((k) => k.toLowerCase() === wanted);
  return key ? config.repoSetup[key] : undefined;
}

/**
 * The variables the owner gave the agents' shell. Names the platform sets
 * itself are skipped even though the config schema already refuses them, so
 * an old or hand-edited config can never override PATH or the API key.
 */
export function setupEnv(setup: RepoSetup | undefined): Record<string, string> {
  if (!setup) return {};
  return Object.fromEntries(Object.entries(setup.env).filter(([key]) => !RESERVED_ENV_KEYS.has(key)));
}

// Colour codes and cursor movement from npm, pnpm, test runners and friends.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** `text` without terminal escape codes; a progress bar redrawn with \r keeps only its last state. */
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** The last `maxLines` lines of `text`, at most `maxChars` characters, cut at a line break when possible. */
export function outputTail(text: string, maxLines = SETUP_TAIL_LINES, maxChars = SETUP_TAIL_CHARS): string {
  let tail = text.replace(/\s+$/, "").split("\n").slice(-maxLines).join("\n");
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars);
    const firstBreak = tail.indexOf("\n");
    if (firstBreak >= 0 && firstBreak < tail.length - 1) tail = tail.slice(firstBreak + 1);
  }
  return tail;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * Runs the owner's setup command with `bash -c` in the checkout (not a login shell: on Debian that resets PATH from /etc/profile and hides tools an extended image adds) and reports
 * how it went: ok when it exits 0, the combined output's tail (redacted),
 * and how long it took. A command that outlives `timeoutMs` has its whole
 * process group stopped. Never throws: a broken setup must not fail the task,
 * the team is told about it instead.
 */
export function runSetupCommand(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; redact?: (text: string) => string },
): Promise<SetupResult> {
  const { cwd, env, timeoutMs = SETUP_TIMEOUT_MS, redact = (t: string) => t } = opts;
  const started = Date.now();

  return new Promise((resolvePromise) => {
    let output = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let startError: string | undefined;
    let done = false;
    const timers: NodeJS.Timeout[] = [];

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP_CHARS) output = output.slice(-OUTPUT_KEEP_CHARS);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // detached: the shell leads its own process group, so a timeout stops everything it started.
      child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({ command, ok: false, seconds: 0, outputTail: redact(`The setup command could not start: ${errorText(err)}`) });
      return;
    }

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      // Something the command started in the background may still hold the pipes open; never wait on it.
      for (const stream of [child.stdout, child.stderr]) unref(stream);
      child.unref();

      const notes: string[] = [];
      if (startError) notes.push(`(the setup command could not start: ${startError})`);
      else if (timedOut) notes.push(`(timed out after ${minutes(timeoutMs)}; the setup command was stopped)`);
      else if (exitCode !== null && exitCode !== 0) notes.push(`(exited with code ${exitCode})`);
      else if (exitCode === null && exitSignal) notes.push(`(stopped by ${exitSignal})`);
      const text = [outputTail(redact(cleanOutput(output))), ...notes].filter(Boolean).join("\n");
      resolvePromise({
        command,
        ok: !startError && !timedOut && exitCode === 0,
        seconds: Math.round((Date.now() - started) / 1000),
        outputTail: outputTail(text),
      });
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      startError = errorText(err);
      finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    child.on("close", finish);

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        // Not cleared when the shell exits: whatever ignored SIGTERM in its group is killed too.
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs),
    );
  });
}

function unref(stream: Readable | null): void {
  (stream as (Readable & { unref?: () => void }) | null)?.unref?.();
}

function errorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (err instanceof Error ? err.message : String(err));
}

/** What the team is told about the setup: commands and variable names, never values. */
export function repoSetupContext(setup: RepoSetup, result?: SetupResult): RepoSetupContext {
  return {
    startCommand: setup.startCommand.trim(),
    appUrl: setup.appUrl.trim(),
    envKeys: Object.keys(setupEnv(setup)).sort(),
    ...(result ? { setup: result } : {}),
  };
}
