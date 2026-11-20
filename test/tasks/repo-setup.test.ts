import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, RESERVED_ENV_KEYS, type RepoSetup, RepoSetupSchema } from "../../src/core/config.js";
import {
  cleanOutput,
  findRepoSetup,
  outputTail,
  repoSetupContext,
  runSetupCommand,
  setupEnv,
} from "../../src/tasks/repo-setup.js";
import { makeRedactor } from "../../src/tasks/worker.js";
import { parseEnvLines } from "../../web/src/pages/projects/validation.js";

const setupOf = (over: Partial<RepoSetup> = {}): RepoSetup => ({ setupCommand: "", startCommand: "", appUrl: "", env: {}, ...over });

/** A shell environment without the developer's own profile (bash -l reads it from HOME). */
async function shellEnv(extra: Record<string, string> = {}) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: await mkdtemp(join(tmpdir(), "army-setup-home-")), ...extra };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return check();
};

describe("findRepoSetup", () => {
  const config = ConfigSchema.parse({
    repoSetup: { "Acme/Web": { setupCommand: "npm ci" }, "acme/api": { startCommand: "npm start" } },
  });

  it("finds the repository's setup, ignoring case", () => {
    expect(findRepoSetup(config, "Acme/Web")?.setupCommand).toBe("npm ci");
    expect(findRepoSetup(config, "acme/web")?.setupCommand).toBe("npm ci");
    expect(findRepoSetup(config, "ACME/API")?.startCommand).toBe("npm start");
  });

  it("returns nothing for a repository without one", () => {
    expect(findRepoSetup(config, "acme/other")).toBeUndefined();
    expect(findRepoSetup(ConfigSchema.parse({}), "acme/web")).toBeUndefined();
  });
});

describe("setupEnv", () => {
  it("gives the owner's variables and never the platform's own names", () => {
    // Built by hand: the schema already refuses reserved names, this is the second line of defence.
    const setup = setupOf({ env: { DATABASE_URL: "postgres://x", PATH: "/evil", ANTHROPIC_API_KEY: "k", MASTER_KEY: "m", FOO: "1" } });
    expect(setupEnv(setup)).toEqual({ DATABASE_URL: "postgres://x", FOO: "1" });
    expect(setupEnv(undefined)).toEqual({});
  });

  it("leaves out names that would redirect Claude Code and the platform's key", () => {
    const setup = setupOf({
      env: {
        ANTHROPIC_BASE_URL: "https://collector.example",
        ANTHROPIC_CUSTOM_HEADERS: "x: y",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        HTTPS_PROXY: "http://proxy.example:8080",
        https_proxy: "http://proxy.example:8080",
        NODE_EXTRA_CA_CERTS: "/repo/ca.pem",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        DATABASE_URL: "postgres://x",
      },
    });
    expect(setupEnv(setup)).toEqual({ DATABASE_URL: "postgres://x" });
  });
});

describe("reserved variable names", () => {
  it("reserve the platform's names, and every name that decides where Claude Code sends its requests and key", () => {
    for (const name of [
      "PATH",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "anthropic_base_url",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CONFIG_DIR",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUD_ML_REGION",
      "VERTEX_REGION_CLAUDE_5_5_OPUS",
    ]) {
      expect(RESERVED_ENV_KEYS.has(name), name).toBe(true);
    }
    for (const name of ["DATABASE_URL", "NODE_ENV", "NODE_OPTIONS", "OPENAI_API_KEY", "MY_AWS_BUCKET", "PROXY_URL", "STRIPE_KEY", "Path"]) {
      expect(RESERVED_ENV_KEYS.has(name), name).toBe(false);
    }
  });

  it("are refused when the owner saves a setup, saying why", () => {
    const refused = RepoSetupSchema.safeParse({ env: { DATABASE_URL: "postgres://x", ANTHROPIC_BASE_URL: "https://collector.example" } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe(
      "ANTHROPIC_BASE_URL is reserved by the platform: names starting with ANTHROPIC_, CLAUDE_CODE_ or AWS_, proxy, TLS and Google credential settings decide where Claude Code sends its requests and key. Remove it from this repository's variables.",
    );
    expect(RepoSetupSchema.safeParse({ env: { PATH: "/x" } }).error?.issues[0]?.message).toBe(
      "PATH is reserved by the platform: it sets it itself. Remove it from this repository's variables.",
    );
    expect(RepoSetupSchema.safeParse({ env: { DATABASE_URL: "postgres://x" } }).success).toBe(true);
  });

  it("are refused by the console's own check the same way", () => {
    const names = ["ANTHROPIC_BASE_URL", "claude_code_use_vertex", "AWS_PROFILE", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "PATH", "DATABASE_URL", "NODE_OPTIONS", "MY_AWS_BUCKET"];
    const parsed = parseEnvLines(names.map((n) => `${n}=value-1`).join("\n"));
    expect(Object.keys(parsed.env)).toEqual(names.filter((n) => !RESERVED_ENV_KEYS.has(n)));
    expect(parsed.errors[0]).toBe(
      "Line 1: ANTHROPIC_BASE_URL is reserved: ANTHROPIC_…, CLAUDE_CODE_…, AWS_…, proxy, TLS and Google credential settings would redirect Claude Code and its key.",
    );
  });

  it("still load from a config saved before they were reserved, and never reach the shell", () => {
    const config = ConfigSchema.parse({ repoSetup: { "acme/web": { env: { HTTPS_PROXY: "http://proxy.example:8080", AWS_PROFILE: "dev", FOO: "1" } } } });
    expect(Object.keys(config.repoSetup["acme/web"]!.env)).toEqual(["HTTPS_PROXY", "AWS_PROFILE", "FOO"]);
    expect(setupEnv(findRepoSetup(config, "acme/web"))).toEqual({ FOO: "1" });
    expect(repoSetupContext(findRepoSetup(config, "acme/web")!).envKeys).toEqual(["FOO"]);
  });
});

describe("output tail", () => {
  it("keeps the last lines, within the character limit, cut at a line break", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const tail = outputTail(text, 60, 4000);
    expect(tail.split("\n")).toHaveLength(60);
    expect(tail.startsWith("line 41\n")).toBe(true);
    expect(tail.endsWith("line 100")).toBe(true);

    const long = Array.from({ length: 20 }, (_, i) => `${i}:${"x".repeat(498)}`).join("\n");
    const cut = outputTail(long, 60, 4000);
    expect(cut.length).toBeLessThanOrEqual(4000);
    expect(cut.split("\n")[0]).toMatch(/^\d+:x+$/);
    expect(cut.endsWith(`19:${"x".repeat(498)}`)).toBe(true);
  });

  it("drops colour codes and keeps only the last state of a redrawn line", () => {
    expect(cleanOutput("\x1b[32mok\x1b[0m done")).toBe("ok done");
    expect(cleanOutput("10%\r50%\r100%\nnext\r\n")).toBe("100%\nnext\n");
  });
});

describe("runSetupCommand", () => {
  it("runs in the checkout with the given environment and reports both output streams", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "army-setup-")));
    const result = await runSetupCommand('pwd; echo "token is $MY_VAR"; echo oops >&2', {
      cwd,
      env: await shellEnv({ MY_VAR: "from-the-owner" }),
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('pwd; echo "token is $MY_VAR"; echo oops >&2');
    expect(result.outputTail).toContain(cwd);
    expect(result.outputTail).toContain("token is from-the-owner");
    expect(result.outputTail).toContain("oops");
    expect(result.seconds).toBeGreaterThanOrEqual(0);
  });

  it("reports a failing command with its exit code and the end of its output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "army-setup-"));
    const result = await runSetupCommand('for i in $(seq 1 100); do echo "line $i"; done; exit 3', { cwd, env: await shellEnv() });
    expect(result.ok).toBe(false);
    const lines = result.outputTail.split("\n");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines.at(-1)).toBe("(exited with code 3)");
    expect(result.outputTail).toContain("line 100");
    expect(result.outputTail).not.toContain("line 1\n");
  });

  it("redacts secrets from the output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "army-setup-"));
    const redact = makeRedactor(["sk-ant-very-secret-1"]);
    const result = await runSetupCommand("echo key=$KEY", { cwd, env: await shellEnv({ KEY: "sk-ant-very-secret-1" }), redact });
    expect(result.outputTail).toBe("key=[redacted]");
  });

  it("stops a command that runs too long, with everything it started", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "army-setup-"));
    const pidFile = join(cwd, "child.pid");
    const started = Date.now();
    const result = await runSetupCommand(`echo starting; sleep 30 & echo $! > ${pidFile}; wait`, {
      cwd,
      env: await shellEnv(),
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.ok).toBe(false);
    expect(result.outputTail).toContain("starting");
    expect(result.outputTail).toMatch(/timed out after \d+ min; the setup command was stopped/);
    const child = Number((await readFile(pidFile, "utf8")).trim());
    expect(await until(() => !alive(child))).toBe(true);
  });

  it("does not wait for a background process the command leaves running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "army-setup-"));
    const pidFile = join(cwd, "server.pid");
    const started = Date.now();
    const result = await runSetupCommand(`sleep 30 & echo $! > ${pidFile}; echo ready`, { cwd, env: await shellEnv() });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(true);
    expect(result.outputTail).toBe("ready");
    process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
  });

  it("never throws, even when the command cannot start", async () => {
    const result = await runSetupCommand("echo hi", { cwd: join(tmpdir(), "army-setup-does-not-exist"), env: await shellEnv() });
    expect(result.ok).toBe(false);
    expect(result.outputTail).toMatch(/could not start/);
  });
});

describe("repoSetupContext", () => {
  it("tells the team the commands and the variable names, never their values", () => {
    const setup = setupOf({
      startCommand: " npm run dev ",
      appUrl: "http://localhost:3000",
      env: { ZED: "secret-z", ALPHA: "secret-a" },
    });
    const context = repoSetupContext(setup);
    expect(context).toEqual({ startCommand: "npm run dev", appUrl: "http://localhost:3000", envKeys: ["ALPHA", "ZED"] });
    expect(JSON.stringify(context)).not.toContain("secret");

    const result = { command: "npm ci", ok: true, seconds: 12, outputTail: "added 300 packages" };
    expect(repoSetupContext(setup, result).setup).toEqual(result);
  });
});
