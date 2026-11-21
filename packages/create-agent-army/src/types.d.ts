// Types shared by the JavaScript modules (checked with `tsc` and JSDoc; nothing here runs).

export type ProviderId = "fly" | "railway" | "render" | "gcloud" | "docker" | "vm";

/** The parsed command line. */
export interface Options {
  provider?: ProviderId;
  name?: string;
  region?: string;
  /** Fly.io organization or Railway workspace. */
  org?: string;
  /** Google Cloud project. */
  project?: string;
  /** VM: the ssh target, e.g. root@203.0.113.7. */
  host?: string;
  /** VM: the domain whose DNS A record points at the server. */
  domain?: string;
  image: string;
  /** Docker: the local port. */
  port: number;
  /** Minutes to wait for /healthz. */
  timeout: number;
  yes: boolean;
  dryRun: boolean;
  open: boolean;
  help: boolean;
  version: boolean;
}

/** What one low-level command run returned. `notFound` = the program is not installed. */
export interface LaunchResult {
  code: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

export interface LaunchOptions {
  /** Written to the child's stdin, which is then closed. Secret values go here, never in argv. */
  input?: string;
  /** Extra environment variables for the child (values may be secret). */
  env?: Record<string, string>;
  cwd?: string;
  /** true: collect stdout/stderr and return them; false: pass them on through `onOutput`. */
  capture: boolean;
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  /** Kill the child after this many milliseconds. */
  timeoutMs?: number;
}

/** Runs a program without a shell. The real one wraps node:child_process.spawn; tests stub it. */
export type Launch = (cmd: string, args: string[], options: LaunchOptions) => Promise<LaunchResult>;

export interface RunOptions {
  input?: string;
  /** Shown after the command in place of the stdin contents, e.g. "MASTER_KEY on stdin". */
  inputLabel?: string;
  /** Also show the stdin contents under the command, with both keys hidden (for a script). */
  showInput?: boolean;
  env?: Record<string, string>;
  /** Show `env` as KEY=value before the command (only for values that aren't secret). */
  showEnv?: boolean;
  cwd?: string;
  /** Collect the output instead of showing it (it is still shown, redacted, when the command fails). */
  capture?: boolean;
  /** Return a failed result instead of throwing. */
  allowFailure?: boolean;
  /** What a dry run returns as stdout, so later steps can parse it. */
  dryRunStdout?: string;
}

export interface Runner {
  readonly dryRun: boolean;
  /** A command that creates or changes something: printed instead of run in a dry run. */
  run(cmd: string, args: string[], options?: RunOptions): Promise<LaunchResult>;
  /** A read-only check: runs in a dry run too, output never shown, never throws. */
  probe(cmd: string, args: string[], options?: { timeoutMs?: number; cwd?: string }): Promise<LaunchResult>;
}

export interface Output {
  /** A line of text (MASTER_KEY is always hidden). */
  line(text?: string): void;
  step(text: string): void;
  command(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  /** Child process output, passed on as it arrives (redacted). */
  stream(text: string, stream: "stdout" | "stderr"): void;
  /** Flush buffered child output. */
  flush(): void;
  bold(text: string): string;
  dim(text: string): string;
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  readonly interactive: boolean;
  /** Free text; the default is returned when not interactive or the answer is empty. */
  ask(question: string, defaultValue?: string): Promise<string>;
  choose<T>(question: string, choices: Choice<T>[], defaultIndex: number): Promise<T>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  /** Stops reading piped answers (so the process can exit). */
  close(): void;
}

export interface Secrets {
  /** 32 random bytes, base64. Never printed. */
  masterKey: string;
  /** 18 random bytes, hex. Printed once at the end. */
  setupToken: string;
}

/** One provider CLI as found on this computer. */
export interface Detection {
  id: ProviderId;
  label: string;
  /** The program that was found (e.g. "fly" or "flyctl"), or the one to install. */
  cli: string;
  installed: boolean;
  /** Logged in (Docker: the daemon is running; VM: ssh is there). */
  ready: boolean;
  /** Who it is logged in as, when the CLI says. */
  account?: string;
  /** Short status for the list, e.g. "logged in, project my-project". */
  status: string;
  /** Extra facts other steps use (gcloud project, Railway workspaces, Render API key...). */
  details: Record<string, unknown>;
}

/** Something a deploy created, and how to remove it. */
export interface Created {
  what: string;
  remove?: string;
}

export interface Fs {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Writes a file only the owner can read (mode 600). */
  writePrivateFile(path: string, content: string, overwrite: boolean): void;
  writeFile(path: string, content: string): void;
  makeTempDir(prefix: string): string;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
}

export interface Context {
  options: Options & { name: string; region: string };
  run: Runner;
  out: Output;
  prompt: Prompter;
  secrets: Secrets;
  detection: Detection;
  /** Everything created so far, for the clean-up message after a failure. */
  created: Created[];
  /** Provider-specific answers from `prepare` (VM host, Railway workspace...). */
  answers: Record<string, string | undefined>;
  cwd: string;
  env: Record<string, string | undefined>;
  platform: string;
  fs: Fs;
  /** Writes agent-army-<name>.env (mode 600) with MASTER_KEY. Returns its path. */
  saveKeys(extra?: Record<string, string>): string;
  openUrl(url: string): Promise<void>;
  waitHealthy(url: string, options: WaitOptions): Promise<boolean>;
}

export interface DeployResult {
  /** The public address (for Docker, http://localhost:<port>). Missing when only the user knows it yet. */
  url?: string;
  /** Wait for <url>/healthz before printing the summary (false: the provider waited, or nothing to wait for). */
  waitForHealth: boolean;
  /** Where the setup token is, when it isn't ours (Render's Environment page...). */
  setupTokenHint?: string;
  /** Where MASTER_KEY is, when it isn't in the local file. */
  masterKeyHint?: string;
  /** Extra lines for the summary: how to update, see logs, remove. */
  notes: string[];
  /** Shown when /healthz doesn't answer in time. */
  notHealthyHint?: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Where the CLI comes from. */
  installUrl: string;
  /** The command that logs the CLI in. */
  loginCommand: string;
  /** Needs the CLI installed and logged in (false: this path runs in the browser). */
  requiresCli(ctx: Context): boolean;
  defaultRegion?: string;
  /** Ask for anything provider-specific (VM host and domain...). */
  prepare?(ctx: Context): Promise<void>;
  /** A one-line description of what will be created, for the confirmation. */
  plan(ctx: Context): string;
  deploy(ctx: Context): Promise<DeployResult>;
}
