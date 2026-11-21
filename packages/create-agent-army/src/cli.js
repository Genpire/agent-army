// npm create agent-army: detect, ask once, generate the keys, deploy, wait for /healthz, hand over.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE, UsageError, isValidName, parseArguments } from "./args.js";
import { PROVIDER_IDS } from "./constants.js";
import { bestProvider, detectProviders } from "./detect.js";
import { CommandError, createRunner, spawnLaunch } from "./exec.js";
import { keysFileContent, keysFileName, nodeFs } from "./files.js";
import { healthUrl, waitForHealthy } from "./health.js";
import { createOutput } from "./output.js";
import { createPrompter } from "./prompt.js";
import { PROVIDERS, PROVIDER_HINTS } from "./providers/index.js";
import { Redactor, generateSecrets } from "./secrets.js";

/** @typedef {import("./types.js").Context} Context */
/** @typedef {import("./types.js").DeployResult} DeployResult */
/** @typedef {import("./types.js").Fs} Fs */
/** @typedef {import("./types.js").Launch} Launch */
/** @typedef {import("./types.js").Output} Output */
/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").Secrets} Secrets */
/** @typedef {import("./health.js").FetchLike} FetchLike */

/**
 * Everything main() touches outside itself, so tests can stub it.
 * @typedef {object} Deps
 * @property {Launch} [launch]
 * @property {{ write(text: string): unknown, isTTY?: boolean }} [stdout]
 * @property {{ write(text: string): unknown, isTTY?: boolean }} [stderr]
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [stdin]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {string} [platform]
 * @property {Fs} [fs]
 * @property {FetchLike} [fetch]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now] The clock of the /healthz wait.
 * @property {() => Secrets} [generateSecrets]
 * @property {() => string} [defaultName]
 * @property {boolean} [interactive] Overrides the terminal check.
 * @property {boolean} [color]
 * @property {boolean} [handleSignals] Ctrl-C prints what was created (the real CLI sets it).
 */

export const VERSION = /** @type {{ version: string }} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
).version;

const REGION_RE = /^[a-z0-9-]{2,40}$/;

/**
 * @param {string[]} argv The arguments after "node create-agent-army".
 * @param {Deps} [deps]
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? process.stdin;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const fs = deps.fs ?? nodeFs;
  const platform = deps.platform ?? process.platform;

  // Commands are shown with both keys hidden; everything else on the screen hides MASTER_KEY.
  const commandRedactor = new Redactor();
  const screenRedactor = new Redactor();
  const color = deps.color ?? (Boolean(stdout.isTTY) && !env.NO_COLOR);
  const out = createOutput({ stdout, stderr, redactor: screenRedactor, color });

  /** @type {import("./types.js").Options} */
  let options;
  try {
    options = parseArguments(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    out.error(err.message);
    out.line("Run with --help to see the options.");
    return 2;
  }
  if (options.help) {
    out.line(USAGE);
    return 0;
  }
  if (options.version) {
    out.line(VERSION);
    return 0;
  }

  const interactive = deps.interactive ?? (!options.yes && Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  const prompt = createPrompter({ input: stdin, output: /** @type {NodeJS.WritableStream} */ (stdout), interactive });
  const run = createRunner({ launch: deps.launch ?? spawnLaunch, out, redactor: commandRedactor, dryRun: options.dryRun });
  try {
    return await install({ options, deps, out, run, prompt, interactive, commandRedactor, screenRedactor, cwd, env, fs, platform });
  } finally {
    prompt.close();
  }
}

/**
 * Everything after the command line is parsed.
 * @param {{
 *   options: import("./types.js").Options, deps: Deps, out: Output, run: import("./types.js").Runner,
 *   prompt: import("./types.js").Prompter, interactive: boolean, commandRedactor: Redactor, screenRedactor: Redactor,
 *   cwd: string, env: Record<string, string | undefined>, fs: Fs, platform: string,
 * }} setup
 * @returns {Promise<number>}
 */
async function install(setup) {
  const { options, deps, out, run, prompt, interactive, commandRedactor, screenRedactor, cwd, env, fs, platform } = setup;
  out.line(`${out.bold("create-agent-army")} ${VERSION}: deploy Agent Army (Pointer and its team)`);
  if (options.dryRun) {
    out.line(out.dim("Dry run: the read-only checks run, every command that would create or change something is only printed."));
  }

  out.step("Looking for provider CLIs on this computer");
  const found = await detectProviders({ run, cwd, fs, env });
  for (const d of found) out.line(`  ${d.label.padEnd(24)} ${d.status}`);
  const best = bestProvider(found);

  let id = options.provider;
  if (!id) {
    if (interactive) {
      out.line();
      id = await prompt.choose(
        "Where should Agent Army run?",
        PROVIDER_IDS.map((p) => ({ value: p, label: PROVIDERS[p].label, hint: PROVIDER_HINTS[p] })),
        PROVIDER_IDS.indexOf(best),
      );
    } else {
      id = best;
      out.line(`Using ${PROVIDERS[best].label} (choose another with --provider).`);
    }
  }
  const provider = PROVIDERS[id];
  const detection = found.find((d) => d.id === id);
  if (!detection) throw new Error(`No detection for ${id}`);

  let name = options.name;
  if (!name) {
    const suggested = deps.defaultName?.() ?? `agent-army-${randomBytes(2).toString("hex")}`;
    name = interactive ? await askName(prompt, out, suggested) : suggested;
  }
  let region = options.region ?? "";
  if (!options.region && provider.defaultRegion) {
    region = interactive ? await askRegion(prompt, out, provider) : provider.defaultRegion;
  }

  const secrets = (deps.generateSecrets ?? generateSecrets)();
  commandRedactor.add(secrets.masterKey, "<MASTER_KEY>");
  commandRedactor.add(secrets.setupToken, "<SETUP_TOKEN>");
  screenRedactor.add(secrets.masterKey, "<MASTER_KEY hidden>");

  const keysFile = keysFileName(name);
  const keysPath = join(cwd, keysFile);
  /** @type {Record<string, string>} */
  const keysExtra = {};
  let keysSaved = false;

  /** @type {Context} */
  const ctx = {
    options: { ...options, name, region },
    run,
    out,
    prompt,
    secrets,
    detection,
    created: [],
    answers: {},
    cwd,
    env,
    platform,
    fs,
    saveKeys(extra = {}) {
      Object.assign(keysExtra, extra);
      if (run.dryRun) {
        if (!keysSaved) out.line(out.dim(`# write ./${keysFile} (mode 600) with MASTER_KEY and SETUP_TOKEN`));
        keysSaved = true;
        return keysPath;
      }
      const content = keysFileContent({ name, provider: provider.label, secrets, extra: keysExtra, date: new Date() });
      try {
        fs.writePrivateFile(keysPath, content, keysSaved);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") {
          throw new CommandError(`./${keysFile} already exists.`, {
            hint: "It may hold the MASTER_KEY of an earlier deployment. Choose another --name, or move that file somewhere safe first.",
          });
        }
        throw err;
      }
      if (!keysSaved) out.line(`Saved the keys to ./${keysFile} (mode 600). Keep it safe: MASTER_KEY decrypts your data.`);
      keysSaved = true;
      return keysPath;
    },
    async openUrl(url) {
      out.line(`  ${url}`);
      if (!options.open) return;
      const [cmd, args] =
        platform === "darwin"
          ? ["open", [url]]
          : platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
            : ["xdg-open", [url]];
      await run.run(cmd, args, { capture: true, allowFailure: true });
    },
    waitHealthy: (url, wait) =>
      waitForHealthy(url, {
        timeoutMs: wait.timeoutMs,
        intervalMs: wait.intervalMs,
        fetch: deps.fetch,
        sleep: deps.sleep,
        now: deps.now,
        onWaiting: (ms) => out.line(out.dim(`  still waiting (${Math.round(ms / 60_000)} min)...`)),
      }),
  };

  const onSigint = () => {
    out.flush();
    out.line();
    out.error("Interrupted.");
    printCreated(ctx, keysSaved ? keysFile : undefined);
    process.exit(130);
  };
  if (deps.handleSignals) process.once("SIGINT", onSigint);

  /** @type {DeployResult} */
  let result;
  try {
    await provider.prepare?.(ctx);
    checkCli(provider, ctx);
    out.step(`Plan: ${provider.label}`);
    out.line(provider.plan(ctx));
    if (interactive && !options.dryRun && !(await prompt.confirm("Deploy now?", true))) {
      out.line("Stopped: nothing was created.");
      return 0;
    }
    result = await provider.deploy(ctx);
  } catch (err) {
    out.flush();
    out.line();
    if (err instanceof CommandError) {
      out.error(err.message);
      if (err.output) out.line(err.output.replace(/^/gm, "  "));
      if (err.hint) out.line(err.hint);
    } else {
      out.error(err instanceof Error ? err.message : String(err));
    }
    printCreated(ctx, keysSaved && !options.dryRun ? keysFile : undefined);
    return 1;
  } finally {
    if (deps.handleSignals) process.removeListener("SIGINT", onSigint);
  }

  if (options.dryRun) {
    if (result.url && result.waitForHealth) out.line(out.dim(`# then wait until ${healthUrl(result.url)} answers "ok"`));
    out.step("Dry run finished: nothing was created");
    out.line("Run the same command without --dry-run to deploy.");
    return 0;
  }

  /** @type {boolean | undefined} */
  let healthy;
  if (result.url && result.waitForHealth) {
    out.step(`Waiting for ${healthUrl(result.url)} (up to ${options.timeout} minutes)`);
    healthy = await ctx.waitHealthy(result.url, { timeoutMs: options.timeout * 60_000 });
    if (!healthy) {
      out.warn(`${result.url} did not answer within ${options.timeout} minutes. It may still be starting.`);
      if (result.notHealthyHint) out.line(result.notHealthyHint);
    }
  }
  if (keysSaved && result.url && keysExtra.AGENT_ARMY_URL !== result.url) ctx.saveKeys({ AGENT_ARMY_URL: result.url });

  printSummary(ctx, result, healthy, keysSaved ? keysFile : undefined);
  return healthy === false ? 1 : 0;
}

/**
 * @param {import("./types.js").Prompter} prompt
 * @param {Output} out
 * @param {string} suggested
 */
async function askName(prompt, out, suggested) {
  for (;;) {
    const name = await prompt.ask("Name", suggested);
    if (isValidName(name)) return name;
    out.line("Use 3 to 40 lowercase letters, digits and single dashes, starting with a letter.");
  }
}

/**
 * @param {import("./types.js").Prompter} prompt
 * @param {Output} out
 * @param {Provider} provider
 */
async function askRegion(prompt, out, provider) {
  for (;;) {
    const region = await prompt.ask(`${provider.label} region`, provider.defaultRegion);
    if (REGION_RE.test(region)) return region;
    out.line("A region id looks like iad, fra or us-central1.");
  }
}

/**
 * The CLI must be installed and logged in, except for the browser paths. A dry run only warns.
 * @param {Provider} provider
 * @param {Context} ctx
 */
function checkCli(provider, ctx) {
  if (!provider.requiresCli(ctx)) return;
  const d = ctx.detection;
  /** @type {CommandError | undefined} */
  let problem;
  if (!d.installed) {
    problem = new CommandError(`${provider.label} needs the ${d.cli} command, which is not installed.`, {
      hint: `Install it: ${provider.installUrl}\nThen: ${provider.loginCommand}`,
    });
  } else if (!d.ready) {
    problem =
      provider.id === "docker"
        ? new CommandError("The Docker daemon is not running.", { hint: `${provider.loginCommand}, then run this again.` })
        : new CommandError(`${d.cli} is not logged in.`, { hint: `Log in, then run this again: ${provider.loginCommand}` });
  }
  if (!problem) return;
  if (ctx.run.dryRun) {
    ctx.out.warn(`${problem.message} ${problem.hint ?? ""}`.trim());
    return;
  }
  throw problem;
}

/**
 * After a failure: what exists now, and how to remove it.
 * @param {Context} ctx
 * @param {string | undefined} keysFile
 */
function printCreated(ctx, keysFile) {
  const { out } = ctx;
  if (ctx.run.dryRun) return;
  if (ctx.created.length === 0) {
    out.line("Nothing was created.");
  } else {
    out.line();
    out.line(out.bold("Created so far") + " (the last one may be incomplete). Fix the problem and finish by hand, or remove it:");
    for (const item of ctx.created) {
      out.line(`  - ${item.what}`);
      if (item.remove) out.line(`      ${item.remove}`);
    }
  }
  if (keysFile) out.line(`The keys are in ./${keysFile}: keep that file until whatever was created is removed.`);
}

/**
 * @param {Context} ctx
 * @param {DeployResult} result
 * @param {boolean | undefined} healthy
 * @param {string | undefined} keysFile
 */
function printSummary(ctx, result, healthy, keysFile) {
  const { out, secrets } = ctx;
  out.step(healthy === true ? "Agent Army is running" : healthy === false ? "Deployed, but not answering yet" : "Almost there");
  if (result.url) out.line(`  Open:         ${result.url}`);
  out.line(`  Setup token:  ${result.setupTokenHint ?? secrets.setupToken}`);
  if (keysFile) out.line(`  Keys:         ./${keysFile} (mode 600). Keep it safe: MASTER_KEY decrypts your data.`);
  else if (result.masterKeyHint) out.line(`  MASTER_KEY:   ${result.masterKeyHint}`);
  out.line();
  out.line(out.bold("Next steps"));
  out.line(`  1. Open ${result.url ?? "the address"} and paste the setup token to create the admin account.`);
  out.line("  2. On Integrations > Claude, connect Claude (paste an Anthropic API key).");
  out.line("  3. Connect Slack and GitHub on the same page, then ask Pointer for something in Chat.");
  if (result.notes.length > 0) {
    out.line();
    for (const note of result.notes) out.line(note);
  }
}
