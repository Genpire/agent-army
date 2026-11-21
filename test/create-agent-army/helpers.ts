// A stubbed world for create-agent-army: provider CLIs, files, the network and the terminal.
import { Readable } from "node:stream";
import { main } from "../../packages/create-agent-army/src/cli.js";

export interface Call {
  cmd: string;
  args: string[];
  line: string;
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  capture: boolean;
}

export interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
  notFound?: boolean;
  /** Printed through onOutput as these chunks (for commands whose output is shown). */
  chunks?: string[];
}

/** Returns a reply for a call, or undefined for "exit 0, no output". */
export type Handler = (call: Call) => Reply | undefined;

export const SECRETS = {
  masterKey: "TWFzdGVyS2V5Rm9yVGVzdHNPbmx5MDEyMzQ1Njc4OTA=",
  setupToken: "5e7a9c0ffee0123456789abcdef012345678",
};

/** Every CLI installed and logged in, as on a well-prepared laptop. */
export const loggedIn: Handler = ({ line }) => {
  if (line === "fly auth whoami") return { stdout: "pilot@example.com\n" };
  if (line === "railway whoami --json") {
    return {
      stdout: JSON.stringify({ name: "Test User", email: "user@example.com", workspaces: [{ id: "ws-1", name: "Personal" }] }),
    };
  }
  if (line.startsWith("render ")) return { notFound: true };
  if (line.startsWith("gcloud auth list")) return { stdout: "user@example.com\n" };
  if (line === "gcloud config get-value project") return { stdout: "example-project\n" };
  if (line.startsWith("gcloud secrets describe")) return { code: 1, stderr: "NOT_FOUND" };
  if (line.startsWith("gcloud run services describe")) return { stdout: "https://my-army-abc123-uc.a.run.app\n" };
  if (line.startsWith("docker container inspect")) return { code: 1 };
  if (line.startsWith("railway domain")) return { stdout: JSON.stringify({ domain: "https://my-army-production.up.railway.app" }) };
  return undefined;
};

/** Nothing installed at all. */
export const nothingInstalled: Handler = () => ({ notFound: true });

/** `first` decides when it returns a reply, `then` otherwise. */
export const overlay =
  (first: Handler, then: Handler): Handler =>
  (call) =>
    first(call) ?? then(call);

export interface FakeFile {
  content: string;
  mode?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr */
  all: string;
  calls: Call[];
  files: Map<string, FakeFile>;
  /** The `$ ...` command lines, in order. */
  commands: string[];
  opened: string[];
}

export interface HarnessOptions {
  handler?: Handler;
  cwd?: string;
  /** Files that exist before the run. */
  files?: Record<string, string>;
  healthy?: boolean;
  interactive?: boolean;
  answers?: string[];
}

export async function run(argv: string[], options: HarnessOptions = {}): Promise<RunResult> {
  const handler = options.handler ?? loggedIn;
  const cwd = options.cwd ?? "/work";
  const calls: Call[] = [];
  const files = new Map<string, FakeFile>(Object.entries(options.files ?? {}).map(([p, content]) => [p, { content }]));
  let stdout = "";
  let stderr = "";

  const exitCode = await main(argv, {
    cwd,
    env: {},
    platform: "linux",
    color: false,
    interactive: options.interactive ?? false,
    stdin: Readable.from(options.answers?.map((a) => `${a}\n`) ?? []) as unknown as NodeJS.ReadableStream,
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
    generateSecrets: () => ({ ...SECRETS }),
    defaultName: () => "agent-army-test",
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 10_000);
    })(),
    fetch: async () => ({ ok: options.healthy ?? true, text: async () => ((options.healthy ?? true) ? "ok" : "") }),
    fs: {
      exists: (path) => files.has(path),
      readFile: (path) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return file.content;
      },
      writePrivateFile: (path, content, overwrite) => {
        if (!overwrite && files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
        files.set(path, { content, mode: 0o600 });
      },
      writeFile: (path, content) => void files.set(path, { content }),
      makeTempDir: (prefix) => `/tmp/${prefix}1`,
    },
    launch: async (cmd, args, launchOptions) => {
      const call: Call = {
        cmd,
        args,
        line: [cmd, ...args].join(" "),
        input: launchOptions.input,
        env: launchOptions.env,
        cwd: launchOptions.cwd,
        capture: launchOptions.capture,
      };
      calls.push(call);
      const reply = handler(call) ?? {};
      if (reply.notFound) return { code: 127, stdout: "", stderr: "", notFound: true };
      for (const chunk of reply.chunks ?? []) launchOptions.onOutput?.(chunk, "stdout");
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    },
  });

  const commands = stdout
    .split("\n")
    .filter((l) => l.startsWith("$ "))
    .map((l) => l.slice(2));
  return {
    code: exitCode,
    stdout,
    stderr,
    all: stdout + stderr,
    calls,
    files,
    commands,
    opened: calls.filter((c) => c.cmd === "xdg-open").map((c) => c.args[0] ?? ""),
  };
}

/** The read-only checks: the only commands a dry run may run. */
export const READ_ONLY =
  /^(fly|flyctl) (version|auth whoami)$|^railway (--version|whoami --json)$|^render (--version|whoami)|^gcloud (--version|auth list|config get-value|secrets describe)|^docker (--version|info|container inspect)|^ssh -V$/;

/** The calls that create or change something. */
export const mutating = (calls: Call[]) => calls.filter((c) => !READ_ONLY.test(c.line));

/** A folder that is a clone of the repo (for the Cloud Run path). */
export const CLONE_FILES = {
  "/repo/package.json": JSON.stringify({ name: "agent-army" }),
  "/repo/deploy/gcp.sh": "#!/usr/bin/env bash\n",
};
