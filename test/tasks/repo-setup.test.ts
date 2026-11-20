import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type RepoSetup } from "../../src/core/config.js";
import {
  cleanOutput,
  findRepoSetup,
  outputTail,
  repoSetupContext,
  runSetupCommand,
  setupEnv,
} from "../../src/tasks/repo-setup.js";
import { makeRedactor } from "../../src/worker.js";

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
