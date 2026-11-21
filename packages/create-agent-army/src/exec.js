// Running the provider CLIs: no shell, secrets on stdin or in the environment, output redacted,
// and in a dry run every command that changes something is printed instead of run.
import { spawn } from "node:child_process";

/** @typedef {import("./types.js").Launch} Launch */
/** @typedef {import("./types.js").LaunchResult} LaunchResult */
/** @typedef {import("./types.js").Runner} Runner */
/** @typedef {import("./types.js").Output} Output */
/** @typedef {import("./secrets.js").Redactor} Redactor */

/** A command that failed. `hint` says what to do about it. */
export class CommandError extends Error {
  /**
   * @param {string} message
   * @param {{ command?: string, code?: number, output?: string, hint?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "CommandError";
    this.command = details.command;
    this.code = details.code;
    this.output = details.output;
    this.hint = details.hint;
  }
}

/**
 * How a command is shown: shell-quoted where needed, so it can be copied and run.
 * @param {string} cmd
 * @param {string[]} args
 */
export function formatCommand(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(" ");
}

/** @param {string} word */
export function shellQuote(word) {
  if (word !== "" && /^[A-Za-z0-9_./:=@%+,-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The last lines of a command's output, for an error message. @param {string} text */
const tail = (text, lines = 15) => text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");

/**
 * The real launcher: node:child_process.spawn with an argument array and no shell.
 * @type {Launch}
 */
export const spawnLaunch = (cmd, args, options) =>
  new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: [options.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
        timeout: options.timeoutMs,
      });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "", notFound: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** @param {LaunchResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.setEncoding("utf8").on("data", (/** @type {string} */ text) => {
      stdout += text;
      if (!options.capture) options.onOutput?.(text, "stdout");
    });
    child.stderr?.setEncoding("utf8").on("data", (/** @type {string} */ text) => {
      stderr += text;
      if (!options.capture) options.onOutput?.(text, "stderr");
    });
    child.on("error", (err) => {
      const notFound = /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT";
      finish({ code: notFound ? 127 : 1, stdout, stderr: stderr || err.message, notFound });
    });
    child.on("close", (code, signal) => finish({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // the child may exit before reading it all
      child.stdin.end(options.input);
    }
  });

/**
 * @param {{ launch: Launch, out: Output, redactor: Redactor, dryRun: boolean }} options
 * @returns {Runner}
 */
export function createRunner({ launch, out, redactor, dryRun }) {
  return {
    dryRun,

    async run(cmd, args, options = {}) {
      const envShown = options.showEnv && options.env
        ? Object.entries(options.env).map(([key, value]) => `${key}=${shellQuote(value)} `).join("")
        : "";
      const shown = envShown + formatCommand(cmd, args) + (options.inputLabel ? `  ${out.dim(`# ${options.inputLabel}`)}` : "");
      out.command(redactor.redact(shown));
      if (options.showInput && options.input !== undefined) {
        for (const line of redactor.redact(options.input).trimEnd().split("\n")) out.line(out.dim(`    ${line}`));
      }
      if (dryRun) return { code: 0, stdout: options.dryRunStdout ?? "", stderr: "" };

      const capture = options.capture ?? false;
      const result = await launch(cmd, args, {
        capture,
        input: options.input,
        env: options.env,
        cwd: options.cwd,
        onOutput: (text, stream) => out.stream(text, stream),
      });
      out.flush();
      if (result.notFound && !options.allowFailure) {
        throw new CommandError(`${cmd} is not installed (or not on the PATH).`, { command: formatCommand(cmd, args) });
      }
      if (result.code !== 0 && !options.allowFailure) {
        throw new CommandError(`This command failed (exit code ${result.code}):\n  ${redactor.redact(formatCommand(cmd, args))}`, {
          command: formatCommand(cmd, args),
          code: result.code,
          // Captured output was not shown yet: keep its end for the error message.
          output: capture ? tail(`${result.stdout}\n${result.stderr}`) : undefined,
        });
      }
      return result;
    },

    async probe(cmd, args, options = {}) {
      try {
        return await launch(cmd, args, { capture: true, cwd: options.cwd, timeoutMs: options.timeoutMs ?? 20_000 });
      } catch {
        return { code: 1, stdout: "", stderr: "" };
      }
    },
  };
}
